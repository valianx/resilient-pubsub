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
 * **Shared-client model:** the factory accepts an optional `pubSubClient`. If
 * none is provided, it throws `ResilientPubSubError{ kind: 'config' }` on first
 * `publish()` — real default-client instantiation lands in PR-8.
 *
 * **Zero hard runtime imports from @google-cloud/pubsub.** A minimal structural
 * interface (`PubSubLike` / `TopicLike`) is all the code depends on; the peer
 * dependency type (`PubSub`) is imported type-only.
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

// ============================================================================
// Structural peer interfaces — no hard runtime import of @google-cloud/pubsub
// ============================================================================

/**
 * Minimal structural interface for a Pub/Sub topic as returned by the
 * `@google-cloud/pubsub` client. Defined locally so that the publisher has
 * zero runtime imports from the peer dependency.
 *
 * The actual `Topic` class from `@google-cloud/pubsub` satisfies this shape.
 */
export interface TopicLike {
  /**
   * Publishes a message and returns the server-assigned message ID.
   *
   * @param message - The message to publish.
   * @returns A promise that resolves to the message ID string.
   */
  publishMessage(message: {
    data: Buffer;
    attributes?: Record<string, string>;
    orderingKey?: string;
  }): Promise<string>;

  /**
   * Resumes ordered publishing for a given ordering key after a publish failure.
   * Required when `enableMessageOrdering` is configured on the topic.
   *
   * @param orderingKey - The key whose publishing should be resumed.
   */
  resumePublishing(orderingKey: string): void;
}

/**
 * Minimal structural interface for a Pub/Sub client as instantiated by the
 * `@google-cloud/pubsub` package. Defined locally to avoid a hard runtime
 * import of the peer dependency.
 *
 * The actual `PubSub` class from `@google-cloud/pubsub` satisfies this shape.
 */
export interface PubSubLike {
  /**
   * Returns a `Topic` handle for the given topic name.
   *
   * @param name - The fully-qualified or short topic name.
   * @param opts - Optional publisher options (passed through to the native client).
   * @returns A `TopicLike` handle for publishing.
   */
  topic(name: string, opts?: Record<string, unknown>): TopicLike;
}

// ============================================================================
// Public option types
// ============================================================================

/**
 * Retry configuration for the resilient publisher.
 *
 * All fields are optional; defaults are production-safe out of the box.
 */
export interface PublisherRetryOptions {
  /**
   * Maximum number of publish attempts (first attempt + retries).
   *
   * @defaultValue `3`
   */
  maxAttempts?: number;

  /**
   * Backoff strategy between retries.
   *
   * @defaultValue `'exponential'`
   */
  strategy?: BackoffStrategy;

  /**
   * Base delay in milliseconds for the first retry.
   *
   * @defaultValue `1000`
   */
  initialDelay?: number;

  /**
   * Upper bound for the backoff delay in milliseconds.
   *
   * @defaultValue `30000`
   */
  maxDelay?: number;

  /**
   * Growth multiplier used by exponential and linear strategies.
   *
   * @defaultValue `2`
   */
  multiplier?: number;

  /**
   * Jitter algorithm applied to the computed backoff delay.
   *
   * @defaultValue `'full'`
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
 * @example Basic publisher (zero-config resilience)
 * ```ts
 * const publisher = createResilientPublisher<OrderCreated>({
 *   topic: 'orders',
 *   pubSubClient: new PubSub(),
 * });
 * ```
 *
 * @example Full configuration
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
 *     onRetry: ({ attempt, delay, error }) => logger.warn('Retrying...', { attempt, delay }),
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
   * An existing Pub/Sub client to use. When omitted, the publisher throws
   * `ResilientPubSubError{ kind: 'config' }` on first publish — real
   * zero-config default-client instantiation lands in PR-8.
   */
  pubSubClient?: PubSubLike;

  /**
   * Pluggable body serializer. Defaults to `JsonSerializer`.
   */
  serializer?: Serializer<T>;

  /**
   * Retry and backoff configuration. All fields have safe defaults.
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
   * @param input - The message to publish.
   * @returns A promise that resolves to the Pub/Sub message ID.
   * @throws {ResilientPubSubError} On permanent failure or retry exhaustion.
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
   */
  readonly topic: unknown;
}

// ============================================================================
// Defaults
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
  // 1. Propagation — W3C trace + allowlisted business headers
  const propagated = injectContext(input.headers, propagationOpts);

  // 2. Caller-supplied attributes (may overlap with propagated; caller wins)
  const callerAttrs = input.attributes ?? {};

  // 3. Envelope attributes — content-type always set; schema-version when configured
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
 * @typeParam T - The type of the message body this publisher produces.
 * @param opts  - Publisher configuration.
 * @returns A `ResilientPublisher<T>` ready to use.
 *
 * @throws {ResilientPubSubError} `{ kind: 'config' }` on the first `publish()`
 *   call when `opts.pubSubClient` is not provided. (Default-client
 *   instantiation from environment variables lands in PR-8.)
 *
 * @example Zero-config resilience (shared client)
 * ```ts
 * import { PubSub } from '@google-cloud/pubsub';
 * import { createResilientPublisher } from 'resilient-pubsub/publisher';
 *
 * const publisher = createResilientPublisher<OrderCreated>({
 *   topic: 'orders',
 *   pubSubClient: new PubSub(),
 * });
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

  const retryOpts = opts.retry ?? {};
  const maxAttempts = retryOpts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const strategy = retryOpts.strategy ?? DEFAULT_STRATEGY;
  const initialDelay = retryOpts.initialDelay ?? DEFAULT_INITIAL_DELAY;
  const maxDelay = retryOpts.maxDelay ?? DEFAULT_MAX_DELAY;
  const multiplier = retryOpts.multiplier ?? DEFAULT_MULTIPLIER;
  const jitter = retryOpts.jitter ?? DEFAULT_JITTER;

  // Resolve the native topic handle once at construction time — if no client
  // was provided the error is deferred to the first publish() call so the
  // caller can construct the publisher before the client is ready.
  let nativeTopic: TopicLike | undefined;

  if (opts.pubSubClient !== undefined) {
    const topicOpts: Record<string, unknown> = {};
    if (opts.ordering === true) {
      topicOpts['enableMessageOrdering'] = true;
    }
    nativeTopic = opts.pubSubClient.topic(opts.topic, topicOpts);
  }

  // ── Publish implementation ─────────────────────────────────────────────────

  async function publish(input: PublishInput<T>): Promise<PublishResult> {
    if (nativeTopic === undefined) {
      throw new ResilientPubSubError(
        `No Pub/Sub client provided. Pass a 'pubSubClient' to createResilientPublisher ` +
          `(topic: '${opts.topic}'). Default-client instantiation from environment ` +
          `variables lands in a future release.`,
        { kind: 'config', classification: 'permanent', retryable: false }
      );
    }

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
        const messageId = await nativeTopic.publishMessage({
          data,
          attributes,
          orderingKey: input.orderingKey,
        });

        safeHook(() => opts.hooks?.onPublish?.({ messageId }));
        return { messageId };
      } catch (err) {
        lastError = err;

        const classification = classify(err);

        // Permanent / poison / unknown → reject immediately, no retries wasted
        if (classification !== 'transient') {
          // For ordering: resume so the key is not left blocked even on a
          // permanent failure (the caller may retry with a corrected message).
          if (opts.ordering === true && input.orderingKey !== undefined) {
            nativeTopic.resumePublishing(input.orderingKey);
          }

          throw new ResilientPubSubError(
            `Publish failed (${classification}) on attempt ${attempt}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            { kind: 'publish', cause: err, classification }
          );
        }

        // Transient — check if we have retries left
        if (attempt === maxAttempts) break;

        // Resume ordering key after a transient failure so it is not blocked
        if (opts.ordering === true && input.orderingKey !== undefined) {
          nativeTopic.resumePublishing(input.orderingKey);
        }

        // Compute jittered delay
        const base = calculateBackoff(attempt, { strategy, initialDelay, maxDelay, multiplier });
        const delay = applyJitter(base, jitter, { previousDelay, initialDelay, maxDelay });
        previousDelay = delay;

        safeHook(() => opts.hooks?.onRetry?.({ attempt, delay, error: err }));

        await sleep(delay);
      }
    }

    // Retry budget exhausted — surface a typed publish error
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
