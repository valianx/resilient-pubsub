/**
 * Canonical error class for resilient-pubsub operations.
 *
 * `ResilientPubSubError` is the single structured error type surfaced by the
 * library. Every error that crosses a module boundary (publish, subscribe,
 * process, serialization, ack, config) is wrapped into this type so that
 * catch handlers can rely on a consistent shape: `kind`, `classification`,
 * `retryable`, and a safe `toJSON()` that excludes secrets and PII.
 *
 * **Layering:** this module depends on `core/classify` and `utils/redact`.
 * It MUST NOT import from `envelope/*` — the envelope module imports errors,
 * not the other way around.
 *
 * **`ErrorKind` and `idempotency-store`:** the `idempotency-store` kind is
 * intentionally absent in v0.1 because the deduplication store is not yet
 * part of the public API. It may be added in v0.2 when the idempotency module
 * is promoted to stable.
 *
 * @module errors/error
 */

import { classify } from '../core/classify';
import type { Classification } from '../core/classify';
import { capMessage, redactSecrets } from '../utils/redact';

// ============================================================================
// ErrorKind
// ============================================================================

/**
 * Discriminant union for `ResilientPubSubError`.
 *
 * | Kind              | Meaning |
 * |-------------------|---------|
 * | `'publish'`       | Error during message publishing (enqueue / flush). |
 * | `'subscribe'`     | Error during subscriber setup or stream management. |
 * | `'process'`       | Error thrown inside a user-provided message handler. |
 * | `'serialization'` | Message could not be serialized or deserialized. |
 * | `'ack'`           | Failure acknowledging or nacking a received message. |
 * | `'config'`        | Invalid library configuration detected at runtime. |
 *
 * @note `'idempotency-store'` is not included in v0.1. The deduplication
 * store abstraction is still internal; it will be added in v0.2 when the
 * idempotency module is promoted to stable.
 */
export type ErrorKind =
  | 'publish'
  | 'subscribe'
  | 'process'
  | 'serialization'
  | 'ack'
  | 'config';

// Re-export Classification so consumers can import both from errors/error.
export type { Classification };

// ============================================================================
// Brand symbol
// ============================================================================

/**
 * Well-known Symbol used to brand `ResilientPubSubError` instances.
 *
 * Using `Symbol.for` ensures the check works across module/realm boundaries
 * (e.g., when the library appears multiple times in a dependency tree due to
 * hoisting or bundling quirks).
 *
 * @internal
 */
const BRAND = Symbol.for('resilient-pubsub.error');

// ============================================================================
// ResilientPubSubError
// ============================================================================

/**
 * Options accepted by the `ResilientPubSubError` constructor.
 */
export interface ResilientPubSubErrorOptions {
  /** Discriminant indicating which subsystem produced the error. */
  readonly kind: ErrorKind;

  /**
   * The original error that triggered this one, if any.
   *
   * The cause is accessible as a property on the instance and is passed to
   * `Error` via the standard `{ cause }` option, but it is **excluded** from
   * `toJSON()` to prevent accidental serialization of raw error chains into
   * structured logs.
   */
  readonly cause?: unknown;

  /**
   * Classification override.
   *
   * When omitted, the classification is derived automatically by calling
   * `classify(cause)` from `core/classify`. Pass an explicit value only
   * when the caller has authoritative information the classifier cannot
   * determine from the cause alone (e.g., `'poison'` for a known-bad message
   * that triggers no gRPC code).
   */
  readonly classification?: Classification;

  /**
   * Retryability override.
   *
   * When omitted, retryability is derived from the classification:
   * `retryable = classification === 'transient'`.
   */
  readonly retryable?: boolean;
}

/**
 * The canonical structured error for all resilient-pubsub operations.
 *
 * **Fields:**
 * - `kind` — which subsystem produced the error (`ErrorKind`).
 * - `classification` — retry disposition (`'transient' | 'permanent' | 'poison' | 'unknown'`).
 * - `retryable` — shorthand boolean derived from the classification.
 * - `cause` — the underlying raw error (excluded from `toJSON()`).
 * - `grpcCode` — the gRPC status code extracted from the cause chain, when present.
 *
 * **`toJSON()` safety contract:**
 * The method returns a plain object that is safe to emit to structured logs.
 * It NEVER includes: the raw `cause`, any `body` or `meta` fields, raw
 * attributes / headers. The `message` is length-capped at 512 characters and
 * passed through `redactSecrets()` before inclusion.
 *
 * @example Publish error from a gRPC UNAVAILABLE response
 * ```ts
 * const err = new ResilientPubSubError('Publish failed: UNAVAILABLE', {
 *   kind: 'publish',
 *   cause: grpcError, // code: 14
 * });
 * // err.classification === 'transient'
 * // err.retryable === true
 * // err.grpcCode === 14
 * ```
 *
 * @example Explicit classification override
 * ```ts
 * const err = new ResilientPubSubError('Bad topic name', {
 *   kind: 'config',
 *   classification: 'permanent',
 *   retryable: false,
 * });
 * ```
 */
export class ResilientPubSubError extends Error {
  /** Discriminant: which subsystem produced this error. */
  public readonly kind: ErrorKind;

  /** Retry disposition derived from the cause or provided explicitly. */
  public readonly classification: Classification;

  /** `true` only when `classification === 'transient'`. */
  public readonly retryable: boolean;

  /**
   * The gRPC numeric status code extracted from the cause chain, or
   * `undefined` when no gRPC code is present.
   */
  public readonly grpcCode: number | undefined;

  /** Brand property enabling cross-realm instanceof checks. @internal */
  public readonly [BRAND] = true;

  constructor(message: string, options: ResilientPubSubErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);

    this.name = 'ResilientPubSubError';
    this.kind = options.kind;

    const derived = options.classification ?? classify(options.cause);
    this.classification = derived;
    this.retryable = options.retryable ?? derived === 'transient';
    this.grpcCode = extractGrpcCode(options.cause);
  }

  /**
   * Returns a plain, log-safe JSON representation of this error.
   *
   * **Included fields:** `name`, `kind`, `classification`, `retryable`,
   * `message` (length-capped + secrets redacted), `grpcCode` (when present).
   *
   * **Excluded fields:** `cause`, `body`, `meta`, raw attributes / headers,
   * stack trace. This exclusion is intentional — those fields may contain
   * secrets, PII, or raw payload bytes.
   *
   * @returns A plain object safe for `JSON.stringify`.
   *
   * @example
   * ```ts
   * JSON.stringify(err);
   * // {
   * //   "name": "ResilientPubSubError",
   * //   "kind": "publish",
   * //   "classification": "transient",
   * //   "retryable": true,
   * //   "message": "Publish failed: UNAVAILABLE",
   * //   "grpcCode": 14
   * // }
   * ```
   */
  public toJSON(): Record<string, unknown> {
    const safe = capMessage(redactSecrets(this.message));

    const base: Record<string, unknown> = {
      name: this.name,
      kind: this.kind,
      classification: this.classification,
      retryable: this.retryable,
      message: safe,
    };

    if (this.grpcCode !== undefined) {
      base['grpcCode'] = this.grpcCode;
    }

    return base;
  }
}

// ============================================================================
// isResilientPubSubError
// ============================================================================

/**
 * Type guard that returns `true` when `err` is a `ResilientPubSubError`.
 *
 * The check uses the `Symbol.for('resilient-pubsub.error')` brand property
 * rather than `instanceof`, so it works correctly across module/realm
 * boundaries (e.g., when the library is duplicated in a dependency tree).
 *
 * @param err - The value to inspect.
 * @returns `true` if `err` is a branded `ResilientPubSubError` instance.
 *
 * @example
 * ```ts
 * try {
 *   await publisher.publish(envelope);
 * } catch (err) {
 *   if (isResilientPubSubError(err)) {
 *     console.error(err.kind, err.classification);
 *   }
 * }
 * ```
 */
export function isResilientPubSubError(err: unknown): err is ResilientPubSubError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[BRAND] === true
  );
}

// ============================================================================
// SerializationError
// ============================================================================

/**
 * Error thrown when a Pub/Sub message payload cannot be deserialized.
 *
 * `SerializationError` is a concrete subclass of `ResilientPubSubError` with
 * fixed, non-overridable semantics:
 * - `kind === 'serialization'`
 * - `classification === 'poison'`
 * - `retryable === false`
 *
 * These values are pre-set in the superclass constructor and are immutable.
 * A poison-classified message must never be retried; it should be nacked and
 * routed to a dead-letter queue or discarded.
 *
 * **Reconciled from PR-1:** The provisional `SerializationError` in
 * `src/envelope/serializer.ts` has been replaced by this subclass. The
 * existing import path (`from 'resilient-pubsub/envelope'`) continues to
 * work because `serializer.ts` re-exports this class. The marker comment
 * `PROVISIONAL_SERIALIZATION_ERROR` is no longer needed.
 *
 * **`isResilientPubSubError` compatibility:**
 * `isResilientPubSubError(new SerializationError(...))` returns `true` because
 * `SerializationError` inherits the brand symbol from `ResilientPubSubError`.
 *
 * @example
 * ```ts
 * throw new SerializationError(
 *   'Failed to parse message payload as JSON: invalid JSON structure',
 *   parseError
 * );
 * ```
 */
export class SerializationError extends ResilientPubSubError {
  /** Always `'serialization'`. Retained as a typed `const` for catch-handler discriminant use. */
  public override readonly kind = 'serialization' as const;

  /** Always `'poison'`. */
  public override readonly classification = 'poison' as const;

  /** Always `false`. */
  public override readonly retryable = false as const;

  /**
   * @param message - Human-readable description of the failure. MUST NOT
   *   include raw payload bytes (security / log safety).
   * @param cause   - The underlying parse error, if any.
   */
  constructor(message: string, cause?: unknown) {
    super(message, {
      kind: 'serialization',
      cause,
      classification: 'poison',
      retryable: false,
    });
    this.name = 'SerializationError';
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Extracts the first numeric gRPC status code found by shallowly inspecting
 * `err.code` and then `err.cause.code` (one level only). This intentionally
 * avoids duplicating the full cause-chain walker from `core/classify` — the
 * `code` is a convenience field for observability, not a retry-decision input.
 *
 * @internal
 */
function extractGrpcCode(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;

  const obj = err as Record<string, unknown>;

  if (typeof obj['code'] === 'number') return obj['code'];

  const cause = obj['cause'];
  if (cause !== null && typeof cause === 'object') {
    const causeCode = (cause as Record<string, unknown>)['code'];
    if (typeof causeCode === 'number') return causeCode;
  }

  return undefined;
}
