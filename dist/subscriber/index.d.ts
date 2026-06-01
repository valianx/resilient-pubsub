import { S as Serializer } from '../serializer-DAvAnges.js';
import { R as ResilientPubSubError } from '../error-BUmovVYN.js';
import { Headers, PropagationOptions } from '../propagation/index.js';
import { E as EnvelopeMeta } from '../index-Da6vKBeR.js';
import { S as SubscriberFlowControlLike, a as SubscriberPubSubLike } from '../pubsub-h9anVIwg.js';
export { A as AckableMessage, b as SubscriptionLike } from '../pubsub-h9anVIwg.js';
import '../classify-mrmGdAaM.js';

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

/**
 * Flow-control options forwarded to the native Pub/Sub subscription.
 *
 * These values limit how many messages and bytes the client buffers locally
 * before applying backpressure. The ack-deadline lease is managed by the
 * native client.
 */
interface SubscriberFlowControl extends SubscriberFlowControlLike {
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
interface SubscriberHooks {
    /**
     * Called after a message is successfully acknowledged.
     *
     * @param info.messageId - The Pub/Sub message ID, if available.
     */
    onAck?: (info: {
        messageId?: string;
    }) => void;
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
    onNack?: (info: {
        messageId?: string;
        error: unknown;
    }) => void;
    /**
     * Called when deserialization fails (poison message). The handler is NOT
     * invoked; the message is nacked automatically.
     *
     * @param info.messageId - The Pub/Sub message ID, if available.
     * @param info.error     - The `SerializationError` that triggered poison classification.
     */
    onPoison?: (info: {
        messageId?: string;
        error: unknown;
    }) => void;
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
interface SubscriberOptions<T> {
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
/**
 * The typed message delivered to the registered handler.
 *
 * This is the **symmetric consume shape**: it mirrors the `{ body, headers }`
 * a publisher sends, extended with inbound-only `meta`.
 *
 * @typeParam T - The type of the deserialized message body.
 */
interface SubscriberMessage<T> {
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
type MessageHandler<T> = (message: SubscriberMessage<T>) => void | Promise<void>;
/**
 * The handle returned by {@link createResilientSubscriber}.
 *
 * @typeParam T - The type of the deserialized message body.
 */
interface ResilientSubscriber<T> {
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
declare function createResilientSubscriber<T>(opts: SubscriberOptions<T>): ResilientSubscriber<T>;

export { type MessageHandler, type ResilientSubscriber, type SubscriberFlowControl, type SubscriberHooks, type SubscriberMessage, type SubscriberOptions, SubscriberPubSubLike, createResilientSubscriber };
