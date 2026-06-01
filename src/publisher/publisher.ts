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

import { calculateBackoff } from '../core/backoff';
import { applyJitter } from '../core/jitter';
import { classify } from '../core/classify';
import type { BackoffStrategy, JitterStrategy } from '../core/index';
import { JsonSerializer } from '../envelope/serializer';
import type { Serializer } from '../envelope/serializer';
import { ResilientPubSubError } from '../errors/error';
import { injectContext } from '../propagation/propagation';
import type { PropagationOptions, Headers } from '../propagation/propagation';
import type { Attributes } from '../types/index';
import type { PubSubLike, TopicLike } from '../types/pubsub';
import { resolveConfigFromEnv } from '../config/env';
import { getDefaultPubSubClient } from '../config/client';

// Re-export structural types so consumers can import them from this module
// (preserves the existing public surface from publisher/index.ts).
export type { PubSubLike, TopicLike } from '../types/pubsub';

// ============================================================================
// Public option types
// ============================================================================

/**
 * Retry configuration for the resilient publisher.
 *
 * All fields are optional; defaults are production-safe out of the box.
 * Values not supplied here fall back to `RESILIENT_PUBSUB_*` environment
 * variables, then to built-in safe defaults.
 */
export interface PublisherRetryOptions {
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
export interface PublisherHooks {
  /**
   * Called each time a transient failure triggers a retry.
   *
   * @param info.attempt - The retry attempt number (1-based).
   * @param info.delay   - Milliseconds the publisher will wait before retrying.
   * @param info.error   - The raw error that caused the retry.
   */
  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;

  /**
   * Called once per successful publish with the server-assigned message ID.
   *
   * @param info.messageId - The Pub/Sub message ID returned by the server.
   */
  onPublish?: (info: { messageId: string }) => void;
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
export interface PublisherOptions<T> {
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

// ============================================================================
// Input / output types
// ============================================================================

/**
 * The input accepted by {@link ResilientPublisher.publish}.
 *
 * This is the **symmetric publish shape**: it mirrors the `{ body, headers }`
 * a consumer sees, so a developer learns one message format for both sides.
 *
 * @typeParam T - The type of the message body.
 */
export interface PublishInput<T> {
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
export interface PublishResult {
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
export interface ResilientPublisher<T> {
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

// ============================================================================
// Built-in defaults
// ============================================================================

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_STRATEGY: BackoffStrategy = 'exponential';
const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30000;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_JITTER: JitterStrategy = 'full';

/** Default sleep — real timer, overridden in tests via `opts._sleep`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Fires a hook, swallowing any error it throws.
 *
 * Hooks are observability-only; a throwing hook must never interrupt the
 * publish path.
 *
 * @internal
 */
function safeHook(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    // intentionally swallowed — hooks must never disrupt the publish path
  }
}

/**
 * Builds the final message attributes from propagation, envelope, and
 * caller-supplied attributes.
 *
 * Priority (highest wins): envelope attributes > caller attributes >
 * propagation attributes. This ensures `content-type` and `schema-version`
 * are always what the library says, not what the caller injects.
 *
 * @internal
 */
function buildAttributes(
  input: Pick<PublishInput<unknown>, 'headers' | 'attributes'>,
  contentType: string,
  schemaVersion: string | undefined,
  propagationOpts: PropagationOptions | undefined
): Record<string, string> {
  const propagated = injectContext(input.headers, propagationOpts);
  const callerAttrs = input.attributes ?? {};
  const envelopeAttrs: Record<string, string> = { 'content-type': contentType };
  if (schemaVersion !== undefined) {
    envelopeAttrs['schema-version'] = schemaVersion;
  }
  return { ...propagated, ...callerAttrs, ...envelopeAttrs };
}

// ============================================================================
// Factory
// ============================================================================

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
export function createResilientPublisher<T>(opts: PublisherOptions<T>): ResilientPublisher<T> {
  const serializer: Serializer<T> = opts.serializer ?? (new JsonSerializer<T>() as Serializer<T>);
  const sleep = opts._sleep ?? defaultSleep;
  const clientResolver = opts._clientResolver ?? getDefaultPubSubClient;

  // Read env-var config once at construction time (lenient — all may be undefined).
  const envConfig = resolveConfigFromEnv();
  const retryOpts = opts.retry ?? {};

  // Resolution precedence: programmatic > env > built-in default.
  const maxAttempts = retryOpts.maxAttempts ?? envConfig.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const strategy = retryOpts.strategy ?? envConfig.strategy ?? DEFAULT_STRATEGY;
  const initialDelay = retryOpts.initialDelay ?? envConfig.initialDelay ?? DEFAULT_INITIAL_DELAY;
  const maxDelay = retryOpts.maxDelay ?? envConfig.maxDelay ?? DEFAULT_MAX_DELAY;
  const multiplier = retryOpts.multiplier ?? envConfig.multiplier ?? DEFAULT_MULTIPLIER;
  const jitter = retryOpts.jitter ?? envConfig.jitter ?? DEFAULT_JITTER;

  // When a client is provided at construction, resolve the topic immediately.
  // When no client is provided, topic resolution is deferred to the first
  // publish() call so the factory itself never throws.
  let nativeTopic: TopicLike | undefined;

  if (opts.pubSubClient !== undefined) {
    const topicOpts: Record<string, unknown> = {};
    if (opts.ordering === true) {
      topicOpts['enableMessageOrdering'] = true;
    }
    nativeTopic = opts.pubSubClient.topic(opts.topic, topicOpts);
  }

  /**
   * Resolves the native topic handle, lazily creating the default client when
   * no explicit client was provided.
   *
   * @internal
   */
  async function resolveNativeTopic(): Promise<TopicLike> {
    if (nativeTopic !== undefined) return nativeTopic;

    // Lazy path: resolve + cache the default client, then obtain the topic.
    const client = await clientResolver();
    const topicOpts: Record<string, unknown> = {};
    if (opts.ordering === true) {
      topicOpts['enableMessageOrdering'] = true;
    }
    // Cache so that subsequent publishes do not re-resolve the client.
    nativeTopic = client.topic(opts.topic, topicOpts);
    return nativeTopic;
  }

  // ── Publish implementation ─────────────────────────────────────────────────

  async function publish(input: PublishInput<T>): Promise<PublishResult> {
    // Resolve topic on first publish (lazy client path OR already resolved).
    const topic = await resolveNativeTopic();

    const data = Buffer.from(serializer.serialize(input.body));
    const attributes = buildAttributes(
      input,
      serializer.contentType,
      opts.schemaVersion,
      opts.propagation
    );

    let lastError: unknown;
    let previousDelay = initialDelay;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const messageId = await topic.publishMessage({
          data,
          attributes,
          orderingKey: input.orderingKey,
        });

        safeHook(() => opts.hooks?.onPublish?.({ messageId }));
        return { messageId };
      } catch (err) {
        lastError = err;

        const classification = classify(err);

        // Permanent / poison / unknown → reject immediately, no wasted retries
        if (classification !== 'transient') {
          if (opts.ordering === true && input.orderingKey !== undefined) {
            topic.resumePublishing(input.orderingKey);
          }

          throw new ResilientPubSubError(
            `Publish failed (${classification}) on attempt ${attempt}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            { kind: 'publish', cause: err, classification }
          );
        }

        // Transient — check if we have retries left
        if (attempt === maxAttempts) break;

        // Resume ordering key after transient failure so it is not blocked
        if (opts.ordering === true && input.orderingKey !== undefined) {
          topic.resumePublishing(input.orderingKey);
        }

        // Compute jittered delay
        const base = calculateBackoff(attempt, { strategy, initialDelay, maxDelay, multiplier });
        const delay = applyJitter(base, jitter, { previousDelay, initialDelay, maxDelay });
        previousDelay = delay;

        safeHook(() => opts.hooks?.onRetry?.({ attempt, delay, error: err }));

        await sleep(delay);
      }
    }

    // Retry budget exhausted
    throw new ResilientPubSubError(
      `Publish failed after ${maxAttempts} attempts (topic: '${opts.topic}')`,
      { kind: 'publish', cause: lastError, classification: 'transient' }
    );
  }

  // ── Public handle ──────────────────────────────────────────────────────────

  return {
    publish,
    get topic(): unknown {
      return nativeTopic;
    },
  };
}
