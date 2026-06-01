import { a as BackoffStrategy, b as JitterStrategy } from '../jitter-WIUHHRu7.cjs';
import { S as Serializer } from '../serializer-DAvAnges.cjs';
import { Headers, PropagationOptions } from '../propagation/index.cjs';
import { A as Attributes } from '../index-Da6vKBeR.cjs';
import { P as PubSubLike } from '../pubsub-h9anVIwg.cjs';
export { T as TopicLike } from '../pubsub-h9anVIwg.cjs';

/**
 * Resilient publisher implementation for resilient-pubsub.
 *
 * Wraps a Pub/Sub topic with retry (backoff + jitter), ordering-aware publish,
 * allowlist-gated context propagation, and pluggable serialization. The publish
 * contract is:
 *
 * - **Transient** errors → retry with backoff+jitter up to `maxAttempts`.
 * - **Permanent / poison / unknown** → reject immediately (no wasted retries).
 * - **Exhaustion** → reject with `ResilientPubSubError{ kind: 'publish' }` (cause = last error).
 * - **Never swallows** a failed publish — the caller must handle the rejection.
 *
 * **Zero-config default client:** when `pubSubClient` is omitted the publisher
 * resolves a shared default client via a dynamic import of `@google-cloud/pubsub`
 * on the first `publish()` call. GCP project and credentials are read from the
 * standard GCP environment (`GOOGLE_CLOUD_PROJECT` / ADC). If the peer is not
 * installed, the first `publish()` rejects with `ResilientPubSubError{ kind: 'config' }`.
 *
 * **Env-var configuration:** resilience knobs are read from `RESILIENT_PUBSUB_*`
 * environment variables when not supplied programmatically (see `src/config/env.ts`).
 * Programmatic options always win. Unset or invalid env vars fall back to built-in
 * safe defaults.
 *
 * **Zero hard runtime imports from @google-cloud/pubsub.** Structural peer
 * interfaces (`PubSubLike` / `TopicLike`) live in `src/types/pubsub.ts` and are
 * imported type-only here.
 *
 * @module publisher/publisher
 */

/**
 * Retry configuration for the resilient publisher.
 *
 * All fields are optional; defaults are production-safe out of the box.
 * Values not supplied here fall back to `RESILIENT_PUBSUB_*` environment
 * variables, then to built-in safe defaults.
 */
interface PublisherRetryOptions {
    /**
     * Maximum number of publish attempts (first attempt + retries).
     *
     * @defaultValue `RESILIENT_PUBSUB_MAX_ATTEMPTS` env var, or `3`
     */
    maxAttempts?: number;
    /**
     * Backoff strategy between retries.
     *
     * @defaultValue `RESILIENT_PUBSUB_BACKOFF_STRATEGY` env var, or `'exponential'`
     */
    strategy?: BackoffStrategy;
    /**
     * Base delay in milliseconds for the first retry.
     *
     * @defaultValue `RESILIENT_PUBSUB_INITIAL_DELAY` env var, or `1000`
     */
    initialDelay?: number;
    /**
     * Upper bound for the backoff delay in milliseconds.
     *
     * @defaultValue `RESILIENT_PUBSUB_MAX_DELAY` env var, or `30000`
     */
    maxDelay?: number;
    /**
     * Growth multiplier used by exponential and linear strategies.
     *
     * @defaultValue `RESILIENT_PUBSUB_MULTIPLIER` env var, or `2`
     */
    multiplier?: number;
    /**
     * Jitter algorithm applied to the computed backoff delay.
     *
     * @defaultValue `RESILIENT_PUBSUB_JITTER` env var, or `'full'`
     */
    jitter?: JitterStrategy;
}
/**
 * Lifecycle hooks for observability. All hooks are fire-and-forget; errors
 * thrown inside them are swallowed so they never interrupt the publish path.
 */
interface PublisherHooks {
    /**
     * Called each time a transient failure triggers a retry.
     *
     * @param info.attempt - The retry attempt number (1-based).
     * @param info.delay   - Milliseconds the publisher will wait before retrying.
     * @param info.error   - The raw error that caused the retry.
     */
    onRetry?: (info: {
        attempt: number;
        delay: number;
        error: unknown;
    }) => void;
    /**
     * Called once per successful publish with the server-assigned message ID.
     *
     * @param info.messageId - The Pub/Sub message ID returned by the server.
     */
    onPublish?: (info: {
        messageId: string;
    }) => void;
}
/**
 * Options accepted by {@link createResilientPublisher}.
 *
 * @typeParam T - The type of the message body this publisher produces.
 *
 * @example Zero-config (no client, env-var credentials)
 * ```ts
 * // Set GOOGLE_CLOUD_PROJECT + ADC in environment, then:
 * const publisher = createResilientPublisher<OrderCreated>({ topic: 'orders' });
 * await publisher.publish({ body: { orderId: '42' } });
 * ```
 *
 * @example Shared client with full configuration
 * ```ts
 * const publisher = createResilientPublisher<OrderCreated>({
 *   topic: 'orders',
 *   pubSubClient: new PubSub({ projectId: 'my-project' }),
 *   serializer: new JsonSerializer(),
 *   retry: { maxAttempts: 5, strategy: 'exponential', jitter: 'full' },
 *   ordering: true,
 *   propagation: { allowlist: ['x-tenant-id'], baggage: false },
 *   schemaVersion: '1.0.0',
 *   hooks: {
 *     onRetry: ({ attempt, delay }) => logger.warn('Retrying...', { attempt, delay }),
 *     onPublish: ({ messageId }) => metrics.increment('publish.success'),
 *   },
 * });
 * ```
 */
interface PublisherOptions<T> {
    /**
     * The Pub/Sub topic name (short name or fully-qualified projects/.../topics/...).
     */
    topic: string;
    /**
     * An existing Pub/Sub client to use. When omitted, the publisher lazily
     * resolves a shared default client from the standard GCP environment on the
     * first `publish()` call.
     */
    pubSubClient?: PubSubLike;
    /**
     * Pluggable body serializer. Defaults to `JsonSerializer`.
     */
    serializer?: Serializer<T>;
    /**
     * Retry and backoff configuration. All fields have safe defaults, further
     * overridable via `RESILIENT_PUBSUB_*` environment variables.
     */
    retry?: PublisherRetryOptions;
    /**
     * When `true`, the underlying topic is configured for ordered publishing.
     * The `orderingKey` from each `PublishInput` is passed through to Pub/Sub,
     * and `resumePublishing(orderingKey)` is called after a transient failure
     * so that the key is not blocked.
     *
     * @defaultValue `false`
     */
    ordering?: boolean;
    /**
     * Allowlist-gated context propagation configuration.
     *
     * W3C trace headers (`traceparent`, `tracestate`) are always propagated.
     * Everything else requires explicit inclusion via `allowlist`.
     */
    propagation?: PropagationOptions;
    /**
     * Schema version string stored in the `schema-version` message attribute.
     * When omitted, the attribute is not set.
     */
    schemaVersion?: string;
    /**
     * Observability hooks. Errors thrown inside hooks are swallowed.
     */
    hooks?: PublisherHooks;
    /**
     * Injectable sleep function for deterministic tests.
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
    _clientResolver?: () => Promise<PubSubLike>;
}
/**
 * The input accepted by {@link ResilientPublisher.publish}.
 *
 * This is the **symmetric publish shape**: it mirrors the `{ body, headers }`
 * a consumer sees, so a developer learns one message format for both sides.
 *
 * @typeParam T - The type of the message body.
 */
interface PublishInput<T> {
    /**
     * The typed message body. Serialized by the configured `Serializer<T>`.
     */
    body: T;
    /**
     * Caller headers to propagate as Pub/Sub attributes. The effective set is
     * governed by `opts.propagation`; W3C trace headers travel automatically.
     */
    headers?: Headers;
    /**
     * Per-message ordering key. Passed through to Pub/Sub when `opts.ordering`
     * is `true`. Has no effect when `ordering` is `false` (the default).
     */
    orderingKey?: string;
    /**
     * Additional message attributes merged with the propagation and envelope
     * attributes. Caller-provided attributes are overridden by envelope
     * attributes (`content-type`, `schema-version`) to enforce the contract.
     */
    attributes?: Attributes;
}
/**
 * The result returned by a successful {@link ResilientPublisher.publish} call.
 */
interface PublishResult {
    /**
     * The server-assigned Pub/Sub message ID.
     */
    messageId: string;
}
/**
 * The handle returned by {@link createResilientPublisher}.
 *
 * @typeParam T - The type of the message body this publisher produces.
 */
interface ResilientPublisher<T> {
    /**
     * Publishes a message with automatic retry on transient failures.
     *
     * Retries use the configured backoff + jitter strategy up to `maxAttempts`.
     * On exhaustion, rejects with `ResilientPubSubError{ kind: 'publish' }`.
     * Permanent / poison / unknown errors are rejected immediately.
     *
     * When no `pubSubClient` was provided at construction, the default client is
     * resolved lazily on the first call. If `@google-cloud/pubsub` is not
     * installed, rejects with `ResilientPubSubError{ kind: 'config' }`.
     *
     * @param input - The message to publish.
     * @returns A promise that resolves to the Pub/Sub message ID.
     * @throws {ResilientPubSubError} On permanent failure, retry exhaustion, or
     *   missing peer dependency.
     *
     * @example
     * ```ts
     * try {
     *   const { messageId } = await publisher.publish({
     *     body: { orderId: '42' },
     *     headers: { traceparent: '00-abc-01' },
     *   });
     * } catch (err) {
     *   // err is ResilientPubSubError — handle alert / persist / fail request
     * }
     * ```
     */
    publish(input: PublishInput<T>): Promise<PublishResult>;
    /**
     * The underlying native Pub/Sub `Topic` handle.
     *
     * Exposed so advanced consumers can reach the native API for cases the
     * wrapper does not cover, without losing the resilience layer on the happy
     * path.
     *
     * `undefined` before the first `publish()` call when no `pubSubClient` was
     * provided (the topic is resolved lazily).
     */
    readonly topic: unknown;
}
/**
 * Creates a {@link ResilientPublisher} that wraps a Pub/Sub topic with retry,
 * backoff, jitter, ordering-aware semantics, and context propagation.
 *
 * When `pubSubClient` is not supplied, the publisher lazily resolves a shared
 * default client on the first `publish()` call, reading GCP credentials from
 * the standard environment (`GOOGLE_CLOUD_PROJECT` / ADC).
 *
 * Resilience knobs (`maxAttempts`, `strategy`, etc.) fall back to
 * `RESILIENT_PUBSUB_*` environment variables when not supplied programmatically,
 * then to built-in safe defaults. Precedence: programmatic > env > default.
 *
 * @typeParam T - The type of the message body this publisher produces.
 * @param opts  - Publisher configuration.
 * @returns A `ResilientPublisher<T>` ready to use.
 *
 * @throws {ResilientPubSubError} `{ kind: 'config' }` from `publish()` when
 *   `pubSubClient` is omitted and `@google-cloud/pubsub` is not installed.
 *
 * @example Zero-config (env-var credentials + default resilience knobs)
 * ```ts
 * import { createResilientPublisher } from 'resilient-pubsub/publisher';
 *
 * // Set GOOGLE_CLOUD_PROJECT in env (ADC handles credentials on GCP).
 * const publisher = createResilientPublisher<OrderCreated>({ topic: 'orders' });
 *
 * try {
 *   await publisher.publish({ body: { orderId: '42' } });
 * } catch (err) {
 *   // ResilientPubSubError — permanent failure after retries
 * }
 * ```
 */
declare function createResilientPublisher<T>(opts: PublisherOptions<T>): ResilientPublisher<T>;

export { PubSubLike, type PublishInput, type PublishResult, type PublisherHooks, type PublisherOptions, type PublisherRetryOptions, type ResilientPublisher, createResilientPublisher };
