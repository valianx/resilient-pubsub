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
 * **Shared-client model:** the factory accepts an optional `pubSubClient`. If
 * none is provided, `start()` throws `ResilientPubSubError{ kind: 'config' }`.
 *
 * **Zero hard runtime imports from @google-cloud/pubsub.** A minimal structural
 * interface (`SubscriberPubSubLike` / `SubscriptionLike`) is all the code
 * depends on; the peer dependency is never imported at runtime.
 *
 * @module subscriber/subscriber
 */

import { Envelope } from '../envelope/envelope';
import type { InboundPubSubMessage } from '../envelope/envelope';
import type { Serializer } from '../envelope/serializer';
import { JsonSerializer } from '../envelope/serializer';
import { ResilientPubSubError } from '../errors/error';
import { extractContext } from '../propagation/propagation';
import type { PropagationOptions, Headers } from '../propagation/propagation';
import type { EnvelopeMeta } from '../types/index';

// ============================================================================
// Structural peer interfaces — no hard runtime import of @google-cloud/pubsub
// ============================================================================

/**
 * A received Pub/Sub message that can be acknowledged or negatively
 * acknowledged. Extends `InboundPubSubMessage` with the ack/nack methods
 * that the native `@google-cloud/pubsub` `Message` class exposes.
 *
 * The actual `Message` class from `@google-cloud/pubsub` satisfies this shape.
 */
export interface AckableMessage extends InboundPubSubMessage {
  /** Acknowledge the message — instructs Pub/Sub not to redeliver it. */
  ack(): void;
  /** Negatively acknowledge the message — instructs Pub/Sub to redeliver it. */
  nack(): void;
}

/**
 * Minimal structural interface for a Pub/Sub subscription handle as returned
 * by the `@google-cloud/pubsub` client. Defined locally to avoid a hard
 * runtime import of the peer dependency.
 *
 * The actual `Subscription` class from `@google-cloud/pubsub` satisfies this shape.
 */
export interface SubscriptionLike {
  /**
   * Registers a listener for the given event.
   *
   * @param event    - `'message'` for inbound messages, `'error'` for errors.
   * @param listener - The callback to invoke.
   */
  on(event: 'message', listener: (msg: AckableMessage) => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;

  /**
   * Removes all listeners, optionally scoped to a specific event.
   *
   * @param event - When provided, removes only listeners for that event.
   */
  removeAllListeners(event?: string): unknown;

  /**
   * Closes the subscription and stops message delivery.
   * Optional because not all subscription handles expose this method.
   */
  close?(): Promise<void>;
}

/**
 * Minimal structural interface for a Pub/Sub client as instantiated by the
 * `@google-cloud/pubsub` package. Defined locally to avoid a hard runtime
 * import of the peer dependency.
 *
 * The actual `PubSub` class from `@google-cloud/pubsub` satisfies this shape.
 */
export interface SubscriberPubSubLike {
  /**
   * Returns a `Subscription` handle for the given subscription name.
   *
   * @param name    - The fully-qualified or short subscription name.
   * @param options - Optional subscriber options passed through to the native client.
   * @returns A `SubscriptionLike` handle for consuming messages.
   */
  subscription(name: string, options?: { flowControl?: SubscriberFlowControl }): SubscriptionLike;
}

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
export interface SubscriberFlowControl {
  /**
   * Maximum number of messages the client holds in memory at once.
   *
   * @defaultValue Pub/Sub client default (typically 100)
   */
  maxMessages?: number;

  /**
   * Maximum number of bytes the client holds in memory at once.
   *
   * @defaultValue Pub/Sub client default
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
   * Called when the user handler throws or rejects. Receives a typed error.
   *
   * @param error - A `ResilientPubSubError{ kind: 'process' }` wrapping the
   *   original handler rejection.
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
 * @example Basic subscriber (zero-config resilience)
 * ```ts
 * const subscriber = createResilientSubscriber<OrderCreated>({
 *   subscription: 'projects/my-project/subscriptions/orders-sub',
 *   pubSubClient: new PubSub(),
 * });
 *
 * subscriber.on(async ({ body, headers, meta }) => {
 *   await processOrder(body);
 * });
 *
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
   * An existing Pub/Sub client to use. When omitted, `start()` throws
   * `ResilientPubSubError{ kind: 'config' }`.
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
   */
  flowControl?: SubscriberFlowControl;

  /**
   * Maximum milliseconds to wait for in-flight handlers to complete when
   * `stop()` is called.
   *
   * After this timeout, any still-in-flight messages are nacked so that
   * Pub/Sub redelivers them to another subscriber.
   *
   * @defaultValue `30_000`
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
   * - Throws `ResilientPubSubError{ kind: 'config' }` when no `pubSubClient`
   *   was provided.
   * - Idempotent: calling `start()` more than once on an already-started
   *   subscriber is a no-op (does not double-subscribe).
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
   * immediately.
   *
   * @returns A promise that resolves once the subscriber is fully stopped.
   */
  stop(): Promise<void>;

  /**
   * The underlying native Pub/Sub `Subscription` handle.
   *
   * Exposed so advanced consumers can reach the native API. `undefined` before
   * `start()` is called.
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
 * @typeParam T  - The type of the deserialized message body.
 * @param opts   - Subscriber configuration.
 * @returns A `ResilientSubscriber<T>` ready to use.
 *
 * @throws {ResilientPubSubError} `{ kind: 'config' }` from `start()` when
 *   `opts.pubSubClient` is not provided.
 *
 * @example Zero-config resilience (shared client)
 * ```ts
 * import { PubSub } from '@google-cloud/pubsub';
 * import { createResilientSubscriber } from 'resilient-pubsub/subscriber';
 *
 * const subscriber = createResilientSubscriber<OrderCreated>({
 *   subscription: 'orders-sub',
 *   pubSubClient: new PubSub(),
 * });
 *
 * subscriber.on(async ({ body }) => {
 *   await processOrder(body);
 * });
 *
 * subscriber.start();
 * process.on('SIGTERM', () => subscriber.stop());
 * ```
 */
export function createResilientSubscriber<T>(opts: SubscriberOptions<T>): ResilientSubscriber<T> {
  const serializer: Serializer<T> = opts.serializer ?? (new JsonSerializer<T>() as Serializer<T>);
  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const sleep = opts._sleep ?? defaultSleep;

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

    // Build the handler promise and track it in the in-flight Set.
    const handlerPromise = runHandler(message, messageId);

    const entry: InFlightEntry = {
      promise: handlerPromise,
      nack: () => message.nack(),
    };

    inFlight.add(entry);
    // Remove from the Set once the handler settles (acked, nacked, or poisoned).
    void handlerPromise.finally(() => {
      inFlight.delete(entry);
    });
  }

  /**
   * Runs the actual handler lifecycle: deserialize → dispatch → ack/nack.
   * Returns a promise that always resolves (never rejects) so the in-flight
   * Set cleanup in `processMessage` is guaranteed to run.
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

  // ── Graceful drain helpers ─────────────────────────────────────────────────

  /**
   * Resolves when all currently in-flight handlers have settled.
   * Snapshots the Set at call time so new messages arriving concurrently
   * (before the 'message' listener is removed) do not extend the drain.
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

      if (opts.pubSubClient === undefined) {
        throw new ResilientPubSubError(
          `No Pub/Sub client provided. Pass a 'pubSubClient' to createResilientSubscriber ` +
            `(subscription: '${opts.subscription}'). Default-client instantiation from ` +
            `environment variables lands in a future release.`,
          { kind: 'config', classification: 'permanent', retryable: false }
        );
      }

      nativeSubscription = opts.pubSubClient.subscription(opts.subscription, {
        flowControl: opts.flowControl,
      });

      nativeSubscription.on('message', (msg: AckableMessage) => {
        // Fire-and-forget: runHandler always resolves; errors are handled inside.
        processMessage(msg);
      });

      nativeSubscription.on('error', (err: unknown) => {
        // Surface subscription-level errors as typed errors via onError hook.
        const subscribeError = new ResilientPubSubError(
          `Subscription error on '${opts.subscription}': ${err instanceof Error ? err.message : String(err)}`,
          { kind: 'subscribe', cause: err }
        );
        safeHook(() => opts.hooks?.onError?.(subscribeError));
      });

      started = true;
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
        // Nack remaining in-flight messages so Pub/Sub redelivers them.
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
