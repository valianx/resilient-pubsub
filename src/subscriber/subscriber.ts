/**
 * Resilient subscriber implementation for resilient-pubsub.
 *
 * Wraps a Pub/Sub subscription with correct ack/nack lifecycle management,
 * deserialization, allowlist-gated context propagation, poison-message
 * detection, and graceful drain-and-stop semantics. The subscribe contract is:
 *
 * - **Handler resolves** → `message.ack()` (+ `onAck` hook).
 * - **Handler throws / rejects** → `message.nack()` (+ `onError` + `onNack` hooks,
 *   wrapped as `ResilientPubSubError{ kind: 'process' }`). The subscriber never
 *   crashes on a handler throw.
 * - **Deserialization failure** → handler NOT invoked; `message.nack()` (+ `onPoison`
 *   hook). Native DLQ routing is PR-7; here we only classify, nack, and hook.
 * - **`stop()`** → graceful drain: stop accepting new messages, await all
 *   in-flight handler promises up to `stopTimeoutMs` (default 30 000 ms),
 *   nacking still-in-flight messages on timeout so they redeliver.
 *
 * **Zero-config default client:** when `pubSubClient` is omitted, `start()`
 * kicks off an async bootstrap that lazily resolves the default client via a
 * dynamic import of `@google-cloud/pubsub`. The bootstrap is fire-and-forget from
 * `start()` (which stays `void`). Bootstrap errors are surfaced through the
 * `onError` hook as `ResilientPubSubError{ kind: 'config' }` — callers must
 * register an `onError` hook to observe them. `stop()` is safe to call even if
 * the bootstrap has not yet completed.
 *
 * **Env-var configuration:** resilience knobs (`stopTimeoutMs`, `maxMessages`,
 * `maxBytes`) are read from `RESILIENT_PUBSUB_*` environment variables when not
 * supplied programmatically. Programmatic options always win.
 *
 * **Zero hard runtime imports from @google-cloud/pubsub.** Structural peer
 * interfaces (`PubSubLike` / `SubscriptionLike` / `AckableMessage`) live in
 * `src/types/pubsub.ts` and are referenced as structural types only.
 *
 * @module subscriber/subscriber
 */

import { Envelope } from '../envelope/envelope';
import type { Serializer } from '../envelope/serializer';
import { JsonSerializer } from '../envelope/serializer';
import { ResilientPubSubError } from '../errors/error';
import { extractContext } from '../propagation/propagation';
import type { PropagationOptions, Headers } from '../propagation/propagation';
import type { EnvelopeMeta } from '../types/index';
import type {
  AckableMessage,
  SubscriptionLike,
  SubscriberPubSubLike,
  SubscriberFlowControlLike,
} from '../types/pubsub';
import { resolveConfigFromEnv } from '../config/env';
import { getDefaultPubSubClient } from '../config/client';

// Re-export structural types so consumers can import them from this module.
export type { AckableMessage, SubscriptionLike, SubscriberPubSubLike } from '../types/pubsub';

// ============================================================================
// Public option types
// ============================================================================

/**
 * Flow-control options forwarded to the native Pub/Sub subscription.
 *
 * These values limit how many messages and bytes the client buffers locally
 * before applying backpressure. The ack-deadline lease is managed by the
 * native client.
 */
export interface SubscriberFlowControl extends SubscriberFlowControlLike {
  /**
   * Maximum number of messages the client holds in memory at once.
   *
   * @defaultValue `RESILIENT_PUBSUB_MAX_MESSAGES` env var, or the Pub/Sub
   *   client default (typically 100)
   */
  maxMessages?: number;

  /**
   * Maximum number of bytes the client holds in memory at once.
   *
   * @defaultValue `RESILIENT_PUBSUB_MAX_BYTES` env var, or the Pub/Sub
   *   client default
   */
  maxBytes?: number;
}

/**
 * Lifecycle hooks for subscriber observability.
 *
 * All hooks are fire-and-forget — errors thrown inside them are swallowed so
 * they never interrupt the message-processing path.
 */
export interface SubscriberHooks {
  /**
   * Called after a message is successfully acknowledged.
   *
   * @param info.messageId - The Pub/Sub message ID, if available.
   */
  onAck?: (info: { messageId?: string }) => void;

  /**
   * Called when the user handler throws or rejects, or when the async bootstrap
   * (lazy-client resolution) fails. Receives a typed error.
   *
   * @param error - A `ResilientPubSubError` wrapping the original error.
   *   `kind === 'process'` for handler failures; `kind === 'config'` for
   *   bootstrap failures (e.g., peer dependency not installed).
   */
  onError?: (error: ResilientPubSubError) => void;

  /**
   * Called after a message is negatively acknowledged due to a handler failure.
   *
   * @param info.messageId - The Pub/Sub message ID, if available.
   * @param info.error     - The original error thrown by the handler.
   */
  onNack?: (info: { messageId?: string; error: unknown }) => void;

  /**
   * Called when deserialization fails (poison message). The handler is NOT
   * invoked; the message is nacked automatically.
   *
   * @param info.messageId - The Pub/Sub message ID, if available.
   * @param info.error     - The `SerializationError` that triggered poison classification.
   */
  onPoison?: (info: { messageId?: string; error: unknown }) => void;
}

/**
 * Options accepted by {@link createResilientSubscriber}.
 *
 * @typeParam T - The type of the deserialized message body.
 *
 * @example Zero-config (no client, env-var credentials)
 * ```ts
 * // Set GOOGLE_CLOUD_PROJECT + ADC in environment, then:
 * const subscriber = createResilientSubscriber<OrderCreated>({
 *   subscription: 'orders-worker',
 *   hooks: { onError: (err) => logger.error('subscriber error', err.toJSON()) },
 * });
 * subscriber.on(async ({ body }) => processOrder(body));
 * subscriber.start();
 * process.on('SIGTERM', () => subscriber.stop());
 * ```
 *
 * @example Full configuration
 * ```ts
 * const subscriber = createResilientSubscriber<OrderCreated>({
 *   subscription: 'orders-sub',
 *   pubSubClient: new PubSub({ projectId: 'my-project' }),
 *   serializer: new JsonSerializer(),
 *   propagation: { allowlist: ['x-tenant-id'], baggage: false },
 *   flowControl: { maxMessages: 10 },
 *   stopTimeoutMs: 15_000,
 *   hooks: {
 *     onAck: ({ messageId }) => metrics.increment('subscriber.ack'),
 *     onError: (err) => logger.error('handler failed', err.toJSON()),
 *     onNack: ({ messageId }) => metrics.increment('subscriber.nack'),
 *     onPoison: ({ messageId }) => metrics.increment('subscriber.poison'),
 *   },
 * });
 * ```
 */
export interface SubscriberOptions<T> {
  /**
   * The Pub/Sub subscription name (short name or fully-qualified
   * projects/.../subscriptions/...).
   */
  subscription: string;

  /**
   * An existing Pub/Sub client to use. When omitted, `start()` triggers an
   * async bootstrap that lazily resolves a default client. Bootstrap errors
   * are surfaced via the `onError` hook.
   */
  pubSubClient?: SubscriberPubSubLike;

  /**
   * Pluggable body deserializer. Defaults to `JsonSerializer`.
   */
  serializer?: Serializer<T>;

  /**
   * Allowlist-gated context propagation configuration.
   *
   * W3C trace headers (`traceparent`, `tracestate`) are always extracted.
   * Everything else requires explicit inclusion via `allowlist`.
   */
  propagation?: PropagationOptions;

  /**
   * Flow-control configuration forwarded to the native subscription.
   *
   * Controls how many messages and bytes the client buffers before applying
   * backpressure. The ack-deadline lease is managed by the native client.
   * Fields also read from `RESILIENT_PUBSUB_MAX_MESSAGES` /
   * `RESILIENT_PUBSUB_MAX_BYTES` env vars when not set programmatically.
   */
  flowControl?: SubscriberFlowControl;

  /**
   * Maximum milliseconds to wait for in-flight handlers to complete when
   * `stop()` is called.
   *
   * After this timeout, any still-in-flight messages are nacked so that
   * Pub/Sub redelivers them to another subscriber.
   *
   * @defaultValue `RESILIENT_PUBSUB_STOP_TIMEOUT_MS` env var, or `30_000`
   */
  stopTimeoutMs?: number;

  /**
   * Observability hooks. Errors thrown inside hooks are swallowed.
   */
  hooks?: SubscriberHooks;

  /**
   * Injectable sleep function for deterministic tests.
   *
   * The subscriber uses this only for the graceful-stop timeout race.
   *
   * @internal
   * @defaultValue `(ms) => new Promise(resolve => setTimeout(resolve, ms))`
   */
  _sleep?: (ms: number) => Promise<void>;

  /**
   * Injectable client resolver for deterministic tests of the lazy-client path.
   * When provided, replaces the call to `getDefaultPubSubClient()`.
   *
   * @internal
   */
  _clientResolver?: () => Promise<SubscriberPubSubLike>;
}

// ============================================================================
// Handler / message types
// ============================================================================

/**
 * The typed message delivered to the registered handler.
 *
 * This is the **symmetric consume shape**: it mirrors the `{ body, headers }`
 * a publisher sends, extended with inbound-only `meta`.
 *
 * @typeParam T - The type of the deserialized message body.
 */
export interface SubscriberMessage<T> {
  /**
   * The deserialized message body, typed as `T`.
   */
  readonly body: T;

  /**
   * Reconstructed header map from Pub/Sub attributes via allowlist-gated
   * extraction. Always contains W3C trace headers when present in attributes.
   */
  readonly headers: Headers;

  /**
   * Runtime metadata populated by Pub/Sub (messageId, publishTime, etc.).
   */
  readonly meta: EnvelopeMeta;
}

/**
 * A typed message handler callback.
 *
 * Resolve to acknowledge, throw/reject to nack. The subscriber catches all
 * rejections — the handler must never call `ack()` or `nack()` directly.
 *
 * @typeParam T - The type of the deserialized message body.
 *
 * @example
 * ```ts
 * const handler: MessageHandler<OrderCreated> = async ({ body, headers, meta }) => {
 *   await processOrder(body.orderId);
 * };
 * ```
 */
export type MessageHandler<T> = (message: SubscriberMessage<T>) => void | Promise<void>;

// ============================================================================
// Public handle interface
// ============================================================================

/**
 * The handle returned by {@link createResilientSubscriber}.
 *
 * @typeParam T - The type of the deserialized message body.
 */
export interface ResilientSubscriber<T> {
  /**
   * Registers the single message handler.
   *
   * Must be called before `start()`. Calling `on()` more than once replaces
   * the previous handler; only the last handler registered takes effect.
   *
   * @param handler - The typed message handler callback.
   */
  on(handler: MessageHandler<T>): void;

  /**
   * Attaches to the native Pub/Sub subscription and begins consuming messages.
   *
   * When `pubSubClient` was provided at construction, the subscription is
   * attached synchronously. When omitted, an async bootstrap is triggered
   * internally — messages begin flowing once the default client resolves.
   * Bootstrap errors (e.g., peer not installed) are surfaced via `onError`.
   *
   * - Idempotent: calling `start()` more than once is a no-op.
   */
  start(): void;

  /**
   * Gracefully drains and stops the subscriber.
   *
   * 1. Stops accepting new messages (removes the `'message'` listener).
   * 2. Awaits all in-flight handler promises up to `stopTimeoutMs`.
   * 3. On timeout: nacks all still-in-flight messages so Pub/Sub redelivers.
   * 4. Resolves when drained or after the timeout.
   *
   * Safe to call from a `SIGTERM` handler. Idempotent — second call resolves
   * immediately. Safe to call before the async bootstrap completes.
   *
   * @returns A promise that resolves once the subscriber is fully stopped.
   */
  stop(): Promise<void>;

  /**
   * The underlying native Pub/Sub `Subscription` handle.
   *
   * Exposed so advanced consumers can reach the native API. `undefined` before
   * `start()` is called or while the async bootstrap is still pending.
   */
  readonly subscription: unknown;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_STOP_TIMEOUT_MS = 30_000;

/** Default sleep implementation — real timer, overridden in tests via `opts._sleep`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Fires a hook, swallowing any error it throws.
 *
 * Hooks are observability-only; a throwing hook must never disrupt the
 * message-processing path.
 *
 * @internal
 */
function safeHook(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    // intentionally swallowed — hooks must never disrupt the message path
  }
}

// ============================================================================
// In-flight message tracking
// ============================================================================

/**
 * Tracks a single in-flight message so `stop()` can drain or nack on timeout.
 *
 * @internal
 */
interface InFlightEntry {
  /** Promise that resolves when this message's handler settles. */
  readonly promise: Promise<void>;
  /** Nacks the underlying Pub/Sub message (called on drain timeout). */
  readonly nack: () => void;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a {@link ResilientSubscriber} that wraps a Pub/Sub subscription with
 * correct ack/nack lifecycle management, deserialization, allowlist-gated
 * context propagation, poison-message detection, and graceful stop.
 *
 * When `pubSubClient` is not supplied, `start()` triggers a non-blocking async
 * bootstrap. Messages begin flowing once the default client resolves. Bootstrap
 * failures surface through the `onError` hook.
 *
 * Resilience knobs (`stopTimeoutMs`, `maxMessages`, `maxBytes`) fall back to
 * `RESILIENT_PUBSUB_*` environment variables when not supplied programmatically.
 *
 * @typeParam T  - The type of the deserialized message body.
 * @param opts   - Subscriber configuration.
 * @returns A `ResilientSubscriber<T>` ready to use.
 *
 * @example Zero-config (env-var credentials)
 * ```ts
 * import { createResilientSubscriber } from 'resilient-pubsub/subscriber';
 *
 * const subscriber = createResilientSubscriber<OrderCreated>({
 *   subscription: 'orders-worker',
 *   hooks: { onError: (err) => logger.error(err.toJSON()) },
 * });
 *
 * subscriber.on(async ({ body }) => processOrder(body));
 * subscriber.start();
 * process.on('SIGTERM', () => subscriber.stop());
 * ```
 */
export function createResilientSubscriber<T>(opts: SubscriberOptions<T>): ResilientSubscriber<T> {
  const serializer: Serializer<T> = opts.serializer ?? (new JsonSerializer<T>() as Serializer<T>);
  const sleep = opts._sleep ?? defaultSleep;
  const clientResolver = opts._clientResolver ?? getDefaultPubSubClient;

  // Read env-var config once at construction time (lenient — all may be undefined).
  const envConfig = resolveConfigFromEnv();

  // Resolution precedence: programmatic > env > built-in default.
  const stopTimeoutMs = opts.stopTimeoutMs ?? envConfig.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  // Flow control: merge programmatic + env-var, programmatic wins per field.
  const resolvedFlowControl: SubscriberFlowControl = {
    maxMessages: opts.flowControl?.maxMessages ?? envConfig.maxMessages,
    maxBytes: opts.flowControl?.maxBytes ?? envConfig.maxBytes,
  };
  // Only forward flowControl when at least one field was set.
  const hasFlowControl =
    resolvedFlowControl.maxMessages !== undefined || resolvedFlowControl.maxBytes !== undefined;

  let handler: MessageHandler<T> | undefined;
  let nativeSubscription: SubscriptionLike | undefined;
  let started = false;
  let stopped = false;

  // Tracks in-flight messages so stop() can drain or nack on timeout.
  const inFlight = new Set<InFlightEntry>();

  // ── Message processing ─────────────────────────────────────────────────────

  /**
   * Called by the native Pub/Sub client for each inbound message.
   * Deserializes, dispatches to the handler, and manages ack/nack lifecycle.
   *
   * @internal
   */
  function processMessage(message: AckableMessage): void {
    const messageId: string | undefined = message.id || undefined;

    const handlerPromise = runHandler(message, messageId);

    const entry: InFlightEntry = {
      promise: handlerPromise,
      nack: () => message.nack(),
    };

    inFlight.add(entry);
    void handlerPromise.finally(() => {
      inFlight.delete(entry);
    });
  }

  /**
   * Runs the actual handler lifecycle: deserialize → dispatch → ack/nack.
   * Always resolves (never rejects) so the in-flight Set cleanup is guaranteed.
   *
   * @internal
   */
  async function runHandler(message: AckableMessage, messageId: string | undefined): Promise<void> {
    // 1. Deserialize — nack immediately and fire onPoison on failure.
    let body: T;
    try {
      body = serializer.deserialize(message.data);
    } catch (deserializeError) {
      message.nack();
      safeHook(() => opts.hooks?.onPoison?.({ messageId, error: deserializeError }));
      return;
    }

    // 2. Extract propagation headers and envelope meta.
    const headers = extractContext(message.attributes, opts.propagation);
    const meta = Envelope.extractMeta(message);

    // 3. Invoke the user handler — ack on resolve, nack on throw.
    try {
      await (handler as MessageHandler<T>)({ body, headers, meta });

      message.ack();
      safeHook(() => opts.hooks?.onAck?.({ messageId }));
    } catch (handlerError) {
      const processError = new ResilientPubSubError(
        `Message handler failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
        { kind: 'process', cause: handlerError, classification: 'unknown' }
      );

      message.nack();
      safeHook(() => opts.hooks?.onError?.(processError));
      safeHook(() => opts.hooks?.onNack?.({ messageId, error: handlerError }));
    }
  }

  /**
   * Attaches message and error listeners to an already-resolved subscription.
   *
   * @internal
   */
  function attachListeners(sub: SubscriptionLike): void {
    nativeSubscription = sub;

    sub.on('message', (msg: AckableMessage) => {
      processMessage(msg);
    });

    sub.on('error', (err: unknown) => {
      const subscribeError = new ResilientPubSubError(
        `Subscription error on '${opts.subscription}': ${err instanceof Error ? err.message : String(err)}`,
        { kind: 'subscribe', cause: err }
      );
      safeHook(() => opts.hooks?.onError?.(subscribeError));
    });
  }

  /**
   * Async bootstrap for the lazy-client path (no pubSubClient provided).
   * Runs fire-and-forget from start(). Errors are routed to onError.
   *
   * @internal
   */
  async function asyncBootstrap(): Promise<void> {
    // If stop() was called before the bootstrap completed, skip attachment.
    if (stopped) return;

    try {
      const client = await clientResolver();

      // Double-check stopped again — stop() may have been called while we awaited.
      if (stopped) return;

      const flowOptions = hasFlowControl ? { flowControl: resolvedFlowControl } : undefined;
      const sub = client.subscription(opts.subscription, flowOptions);
      attachListeners(sub);
    } catch (err) {
      const configError =
        err instanceof ResilientPubSubError
          ? err
          : new ResilientPubSubError(
              `Failed to initialize default Pub/Sub client for subscription ` +
                `'${opts.subscription}': ${err instanceof Error ? err.message : String(err)}`,
              { kind: 'config', cause: err, classification: 'permanent', retryable: false }
            );
      safeHook(() => opts.hooks?.onError?.(configError));
    }
  }

  // ── Graceful drain helpers ─────────────────────────────────────────────────

  /**
   * Resolves when all currently in-flight handlers have settled.
   * Snapshots the Set at call time so new messages arriving concurrently
   * do not extend the drain.
   *
   * @internal
   */
  function drainAll(): Promise<void> {
    const pending = [...inFlight].map((e) => e.promise);
    if (pending.length === 0) return Promise.resolve();
    return Promise.all(pending).then(() => undefined);
  }

  /**
   * Nacks all messages that are still in-flight after the drain timeout,
   * ensuring Pub/Sub redelivers them to another subscriber instance.
   *
   * @internal
   */
  function nackAllInFlight(): void {
    for (const entry of inFlight) {
      safeHook(() => entry.nack());
    }
  }

  // ── Public handle ──────────────────────────────────────────────────────────

  return {
    on(newHandler: MessageHandler<T>): void {
      handler = newHandler;
    },

    start(): void {
      if (started) return; // idempotent — do not double-subscribe
      started = true;

      if (opts.pubSubClient !== undefined) {
        // Synchronous path: client provided at construction time.
        const flowOptions = hasFlowControl ? { flowControl: resolvedFlowControl } : undefined;
        const sub = opts.pubSubClient.subscription(opts.subscription, flowOptions);
        attachListeners(sub);
      } else {
        // Async bootstrap path: resolve the default client, then attach.
        // Fire-and-forget; errors route to onError hook.
        void asyncBootstrap();
      }
    },

    async stop(): Promise<void> {
      if (stopped) return; // idempotent — second call resolves immediately
      stopped = true;

      // Stop accepting new messages.
      if (nativeSubscription !== undefined) {
        nativeSubscription.removeAllListeners('message');
      }

      // Race: drain all in-flight handlers vs. the stop timeout.
      const result = await Promise.race([
        drainAll().then(() => 'drained' as const),
        sleep(stopTimeoutMs).then(() => 'timeout' as const),
      ]);

      if (result === 'timeout') {
        nackAllInFlight();
      }

      // Close the native subscription's message flow if the handle supports it.
      if (nativeSubscription?.close !== undefined) {
        await nativeSubscription.close();
      }
    },

    get subscription(): unknown {
      return nativeSubscription;
    },
  };
}
