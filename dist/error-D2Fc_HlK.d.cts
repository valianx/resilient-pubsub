import { C as Classification } from './classify-mrmGdAaM.cjs';

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
type ErrorKind = 'publish' | 'subscribe' | 'process' | 'serialization' | 'ack' | 'config';

/**
 * Well-known Symbol used to brand `ResilientPubSubError` instances.
 *
 * Using `Symbol.for` ensures the check works across module/realm boundaries
 * (e.g., when the library appears multiple times in a dependency tree due to
 * hoisting or bundling quirks).
 *
 * @internal
 */
declare const BRAND: unique symbol;
/**
 * Options accepted by the `ResilientPubSubError` constructor.
 */
interface ResilientPubSubErrorOptions {
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
declare class ResilientPubSubError extends Error {
    /** Discriminant: which subsystem produced this error. */
    readonly kind: ErrorKind;
    /** Retry disposition derived from the cause or provided explicitly. */
    readonly classification: Classification;
    /** `true` only when `classification === 'transient'`. */
    readonly retryable: boolean;
    /**
     * The gRPC numeric status code extracted from the cause chain, or
     * `undefined` when no gRPC code is present.
     */
    readonly grpcCode: number | undefined;
    /** Brand property enabling cross-realm instanceof checks. @internal */
    readonly [BRAND] = true;
    constructor(message: string, options: ResilientPubSubErrorOptions);
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
    toJSON(): Record<string, unknown>;
}
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
declare function isResilientPubSubError(err: unknown): err is ResilientPubSubError;
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
declare class SerializationError extends ResilientPubSubError {
    /** Always `'serialization'`. Retained as a typed `const` for catch-handler discriminant use. */
    readonly kind: "serialization";
    /** Always `'poison'`. */
    readonly classification: "poison";
    /** Always `false`. */
    readonly retryable: false;
    /**
     * @param message - Human-readable description of the failure. MUST NOT
     *   include raw payload bytes (security / log safety).
     * @param cause   - The underlying parse error, if any.
     */
    constructor(message: string, cause?: unknown);
}

export { type ErrorKind as E, ResilientPubSubError as R, SerializationError as S, type ResilientPubSubErrorOptions as a, isResilientPubSubError as i };
