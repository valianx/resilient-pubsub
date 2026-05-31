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

// ============================================================================
// Types
// ============================================================================

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
export type Classification = 'transient' | 'permanent' | 'poison' | 'unknown';

// ============================================================================
// gRPC status code maps
// ============================================================================

/**
 * gRPC numeric codes that indicate a transient condition.
 *
 * Sources:
 * - DEADLINE_EXCEEDED (4)   — request timed out at the gRPC layer.
 * - RESOURCE_EXHAUSTED (8)  — quota / rate limit exceeded; back off and retry.
 * - ABORTED (10)            — transactional conflict; retry is safe.
 * - INTERNAL (13)           — server-side bug; most impls treat as transient.
 * - UNAVAILABLE (14)        — server is overloaded or restarting; always retry.
 *
 * @internal
 */
const TRANSIENT_GRPC_CODES = new Set<number>([4, 8, 10, 13, 14]);

/**
 * Canonical gRPC string names for transient codes (defensive fallback when
 * `error.code` is a string instead of a number).
 *
 * @internal
 */
const TRANSIENT_GRPC_NAMES = new Set<string>([
  'DEADLINE_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'ABORTED',
  'INTERNAL',
  'UNAVAILABLE',
]);

/**
 * gRPC numeric codes that indicate a permanent failure.
 *
 * Sources:
 * - INVALID_ARGUMENT (3)    — bad request shape.
 * - NOT_FOUND (5)           — topic / subscription does not exist.
 * - ALREADY_EXISTS (6)      — resource conflict on create.
 * - PERMISSION_DENIED (7)   — IAM policy blocks the operation.
 * - FAILED_PRECONDITION (9) — operation not valid in current state.
 * - OUT_OF_RANGE (11)       — argument out of valid range.
 * - UNIMPLEMENTED (12)      — method not supported by this server version.
 * - UNAUTHENTICATED (16)    — missing or invalid credentials.
 *
 * @internal
 */
const PERMANENT_GRPC_CODES = new Set<number>([3, 5, 6, 7, 9, 11, 12, 16]);

/**
 * Canonical gRPC string names for permanent codes.
 *
 * @internal
 */
const PERMANENT_GRPC_NAMES = new Set<string>([
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'FAILED_PRECONDITION',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'UNAUTHENTICATED',
]);

/**
 * Node.js network error codes that indicate a transient condition.
 *
 * These appear as `error.code` on low-level socket / DNS errors.
 *
 * @internal
 */
const TRANSIENT_NODE_CODES = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
]);

// ============================================================================
// Internal helpers
// ============================================================================

/** Maximum depth for cause-chain traversal. @internal */
const MAX_CAUSE_DEPTH = 5;

/**
 * Attempts to extract a Classification from a single error object without
 * traversing its cause chain. Returns `null` if the error is unrecognized.
 *
 * @internal
 */
function classifySingle(err: unknown): Classification | null {
  if (err === null || typeof err !== 'object') return null;

  const obj = err as Record<string, unknown>;

  // --- Poison: SerializationError-shaped object (duck-typing to avoid
  //     importing from envelope — core must stay dependency-free per layering).
  //     Recognize by `kind === 'serialization'` OR `classification === 'poison'`.
  if (obj['kind'] === 'serialization' || obj['classification'] === 'poison') {
    return 'poison';
  }

  const code = obj['code'];

  // --- gRPC numeric code
  if (typeof code === 'number') {
    if (TRANSIENT_GRPC_CODES.has(code)) return 'transient';
    if (PERMANENT_GRPC_CODES.has(code)) return 'permanent';
    return null;
  }

  // --- gRPC string name or Node network code
  if (typeof code === 'string') {
    const upper = code.toUpperCase();
    if (TRANSIENT_GRPC_NAMES.has(upper) || TRANSIENT_NODE_CODES.has(upper)) {
      return 'transient';
    }
    if (PERMANENT_GRPC_NAMES.has(upper)) return 'permanent';
    return null;
  }

  // --- Node network errors can also embed the code in the message
  //     (e.g. "connect ECONNREFUSED 127.0.0.1:8080").
  const message = typeof obj['message'] === 'string' ? obj['message'] : '';
  for (const nodeCode of TRANSIENT_NODE_CODES) {
    if (message.includes(nodeCode)) return 'transient';
  }

  return null;
}

// ============================================================================
// Public API
// ============================================================================

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
export function classify(error: unknown): Classification {
  const visited = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || current === undefined) break;
    if (visited.has(current)) break; // cycle guard
    visited.add(current);

    const result = classifySingle(current);
    if (result !== null) return result;

    // Walk into the cause chain.
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)['cause'];
    } else {
      break;
    }
  }

  return 'unknown';
}

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
export function isRetryable(error: unknown): boolean {
  return classify(error) === 'transient';
}
