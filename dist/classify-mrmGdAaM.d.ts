/**
 * Error classification for resilient-pubsub.
 *
 * Maps raw errors from @google-cloud/pubsub (which surface gRPC status codes)
 * and Node.js network errors to one of four classifications, allowing the
 * retry engine to decide whether to retry, discard, or escalate a message.
 *
 * **No runtime imports from @google-cloud/pubsub.** Classification works by
 * structural inspection of `error.code`, `error.message`, and the cause chain.
 * This keeps the module zero-dependency and testable in isolation.
 *
 * **Cause-chain traversal** is bounded (max depth 5) and uses a `Set`-based
 * cycle guard so that a self-referential `cause` cannot produce an infinite
 * loop. This mirrors the `resolveNetworkCode` pattern from resilient-http.
 *
 * @module core/classify
 */
/**
 * The four possible classifications for a Pub/Sub / gRPC error.
 *
 * - `'transient'`  — the operation may succeed on a subsequent attempt.
 *                    Caller should apply backoff and retry.
 * - `'permanent'`  — the operation will never succeed as-is (bad request,
 *                    missing resource, auth failure). Do not retry.
 * - `'poison'`     — the message itself is unprocessable (e.g. malformed
 *                    serialization). Nack and route to dead-letter queue.
 * - `'unknown'`    — classification could not be determined. Treat as
 *                    non-retryable unless the caller has additional context.
 */
type Classification = 'transient' | 'permanent' | 'poison' | 'unknown';
/**
 * Classifies an error into one of four categories for retry decision-making.
 *
 * The function walks the cause chain (up to depth 5, with a `Set`-based cycle
 * guard) because both undici and the gRPC-js transport can wrap the real error
 * one or two levels deep. Each level is inspected in order; the first
 * recognizable classification wins.
 *
 * **Poison detection** uses duck-typing: an error object with
 * `kind === 'serialization'` or `classification === 'poison'` is always
 * classified as `'poison'`, without importing from the envelope module.
 *
 * @param error - The error to classify. May be any value (including null,
 *   undefined, a string, or a non-Error object).
 * @returns The classification of the error.
 *
 * @example Transient gRPC error
 * ```ts
 * classify({ code: 14, message: 'UNAVAILABLE' }); // 'transient'
 * ```
 *
 * @example Permanent gRPC error
 * ```ts
 * classify({ code: 7 }); // 'permanent' (PERMISSION_DENIED)
 * ```
 *
 * @example Nested cause chain
 * ```ts
 * classify({ message: 'transport error', cause: { code: 14 } }); // 'transient'
 * ```
 *
 * @example Poison (SerializationError-shaped)
 * ```ts
 * classify({ kind: 'serialization', classification: 'poison' }); // 'poison'
 * ```
 *
 * @example Unknown error
 * ```ts
 * classify(new Error('something unexpected')); // 'unknown'
 * ```
 */
declare function classify(error: unknown): Classification;
/**
 * Returns `true` when the error is classified as `'transient'` — i.e., the
 * operation is safe to retry after a backoff delay.
 *
 * @param error - The error to inspect.
 * @returns `true` if retrying is appropriate, `false` otherwise.
 *
 * @example
 * ```ts
 * if (isRetryable(err)) {
 *   await sleep(calculateBackoff(attempt));
 *   return attemptPublish();
 * }
 * ```
 */
declare function isRetryable(error: unknown): boolean;

export { type Classification as C, classify as c, isRetryable as i };
