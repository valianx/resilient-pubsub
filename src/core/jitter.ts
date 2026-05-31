/**
 * Jitter algorithms for resilient-pubsub.
 *
 * Applies randomness to a base backoff delay to prevent the thundering-herd
 * problem when many clients retry concurrently. Four strategies are available,
 * mirroring the algorithms described in the AWS "Exponential Backoff and Jitter"
 * article (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).
 *
 * **Randomness source:** `Math.random()` is used intentionally. Retry jitter
 * does not require a cryptographically secure PRNG — statistical distribution
 * is sufficient, and `Math.random()` is faster and universally available in
 * every target environment (Node.js, Bun, browser). Using `crypto.getRandomValues`
 * would add complexity without meaningful benefit here.
 *
 * Zero runtime dependencies.
 *
 * @module core/jitter
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Available jitter strategies.
 *
 * - `'full'`         — random in `[0, baseDelay]`. Maximum spread; AWS-recommended default.
 * - `'equal'`        — `baseDelay/2 + random(0, baseDelay/2)`. Minimum guaranteed delay.
 * - `'decorrelated'` — `random(initialDelay, previousDelay * 3)`, capped at `maxDelay`.
 * - `'none'`         — returns `baseDelay` unchanged. Useful for deterministic testing.
 */
export type JitterStrategy = 'full' | 'equal' | 'decorrelated' | 'none';

/**
 * Optional configuration for {@link applyJitter}.
 */
export interface JitterOptions {
  /**
   * The delay produced by the previous retry attempt.
   * Used by `'decorrelated'` to compute the next delay window.
   *
   * Defaults to `baseDelay` when not provided.
   */
  previousDelay?: number;

  /**
   * The minimum possible delay in milliseconds.
   * Used by `'decorrelated'` as the lower bound.
   *
   * @defaultValue `1000`
   */
  initialDelay?: number;

  /**
   * Upper bound in milliseconds. Results are clamped to `maxDelay` when provided.
   *
   * @defaultValue `30000`
   */
  maxDelay?: number;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30000;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Returns a random integer in the inclusive range `[min, max]`.
 *
 * @internal
 */
function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Returns a random float in the half-open range `[min, max)`.
 *
 * @internal
 */
function randomFloatBetween(min: number, max: number): number {
  if (max <= min) return min;
  return Math.random() * (max - min) + min;
}

/**
 * Clamps `value` to `>= 0`. Returns 0 for NaN / negative values.
 *
 * @internal
 */
function clampPositive(value: number): number {
  return isFinite(value) && value > 0 ? value : 0;
}

// ============================================================================
// Strategy implementations (internal)
// ============================================================================

/**
 * Full jitter: random value in `[0, baseDelay]`.
 *
 * Provides maximum spread, reducing the probability that many clients
 * retry at the same instant.
 *
 * @internal
 */
function fullJitter(baseDelay: number): number {
  return randomBetween(0, Math.floor(baseDelay));
}

/**
 * Equal jitter: `floor(baseDelay / 2) + random(0, floor(baseDelay / 2))`.
 *
 * Guarantees at least half the base delay, while still introducing
 * enough randomness to spread retries.
 *
 * @internal
 */
function equalJitter(baseDelay: number): number {
  const half = Math.floor(baseDelay / 2);
  return half + randomBetween(0, half);
}

/**
 * Decorrelated jitter: `min(maxDelay, random(initialDelay, previousDelay * 3))`.
 *
 * Each delay is derived from the previous one, producing a smoother
 * and less correlated distribution across retrying clients.
 *
 * @internal
 */
function decorrelatedJitter(
  previousDelay: number,
  initialDelay: number,
  maxDelay: number
): number {
  const lower = initialDelay;
  const upper = previousDelay * 3;
  const raw = randomFloatBetween(lower, upper);
  return Math.min(Math.floor(raw), maxDelay);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Applies a jitter strategy to a base delay value.
 *
 * The result is always `>= 0`. When `opts.maxDelay` is provided the result
 * is also clamped to `<= maxDelay` (applies to all strategies, not only
 * `'decorrelated'`).
 *
 * @param baseDelay - The backoff delay (in ms) before jitter is applied.
 * @param strategy  - Which jitter algorithm to use. Defaults to `'full'`.
 * @param opts      - Additional configuration for `'decorrelated'` and capping.
 * @returns The jittered delay in milliseconds.
 *
 * @example Full jitter (default)
 * ```ts
 * const delay = applyJitter(1000); // random in [0, 1000]
 * ```
 *
 * @example Equal jitter
 * ```ts
 * const delay = applyJitter(1000, 'equal'); // in [500, 1000]
 * ```
 *
 * @example Decorrelated jitter
 * ```ts
 * const delay = applyJitter(2000, 'decorrelated', {
 *   previousDelay: 1000,
 *   initialDelay: 500,
 *   maxDelay: 30000,
 * });
 * // random in [500, 3000], capped at 30000
 * ```
 *
 * @example No jitter (deterministic)
 * ```ts
 * const delay = applyJitter(1000, 'none'); // exactly 1000
 * ```
 */
export function applyJitter(
  baseDelay: number,
  strategy: JitterStrategy = 'full',
  opts: JitterOptions = {}
): number {
  const {
    previousDelay = baseDelay,
    initialDelay = DEFAULT_INITIAL_DELAY,
    maxDelay = DEFAULT_MAX_DELAY,
  } = opts;

  let result: number;

  switch (strategy) {
    case 'full':
      result = fullJitter(baseDelay);
      break;
    case 'equal':
      result = equalJitter(baseDelay);
      break;
    case 'decorrelated':
      result = decorrelatedJitter(previousDelay, initialDelay, maxDelay);
      break;
    case 'none':
      result = baseDelay;
      break;
    default: {
      // Exhaustive fallback.
      const _exhaustive: never = strategy;
      void _exhaustive;
      result = fullJitter(baseDelay);
    }
  }

  // Apply global maxDelay clamp (for 'full', 'equal', 'none' strategies).
  // 'decorrelated' already applies its own cap; clamping again is a no-op there.
  const clamped = Math.min(clampPositive(result), maxDelay);
  return clamped;
}
