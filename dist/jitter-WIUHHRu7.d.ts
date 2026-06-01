/**
 * Backoff strategy implementations for resilient-pubsub.
 *
 * Provides three backoff strategies (exponential, linear, constant) with a
 * unified `calculateBackoff` entry-point. All strategies enforce a `maxDelay`
 * cap and guarantee non-negative, finite results.
 *
 * Zero runtime dependencies — algorithms are self-contained.
 *
 * @module core/backoff
 */
/**
 * Available backoff strategies.
 *
 * - `'exponential'` — delay grows by a multiplier on each attempt (default).
 * - `'linear'`      — delay grows linearly with the attempt number.
 * - `'constant'`    — delay is always `initialDelay`, regardless of attempt.
 */
type BackoffStrategy = 'exponential' | 'linear' | 'constant';
/**
 * Options for {@link calculateBackoff}.
 *
 * All fields are optional; defaults mirror `resilient-http`'s defaults for
 * cross-library consistency.
 */
interface BackoffOptions {
    /**
     * The backoff strategy to apply.
     *
     * @defaultValue `'exponential'`
     */
    strategy?: BackoffStrategy;
    /**
     * Base delay in milliseconds (attempt 1 result for exponential/linear,
     * and the constant delay for `'constant'`).
     *
     * @defaultValue `1000`
     */
    initialDelay?: number;
    /**
     * Upper bound in milliseconds. The returned delay is always `<= maxDelay`.
     *
     * @defaultValue `30000`
     */
    maxDelay?: number;
    /**
     * Growth factor used by the exponential and linear strategies.
     *
     * - exponential: `initialDelay * multiplier^(attempt-1)`
     * - linear:      `initialDelay * attempt` (multiplier is not used in the
     *   linear formula in this implementation; see notes below)
     *
     * @defaultValue `2`
     */
    multiplier?: number;
}
/**
 * Calculates a retry delay in milliseconds for the given attempt number.
 *
 * The `attempt` parameter is **1-based** (the first retry is attempt 1).
 * Results are always clamped to `[0, maxDelay]` and are never NaN.
 *
 * @param attempt - The current retry attempt, starting at 1.
 * @param opts    - Backoff configuration. All fields default to sensible values.
 * @returns Delay in milliseconds.
 *
 * @example Exponential backoff (default)
 * ```ts
 * calculateBackoff(1); // 1000 ms
 * calculateBackoff(2); // 2000 ms
 * calculateBackoff(3); // 4000 ms
 * ```
 *
 * @example Linear backoff
 * ```ts
 * calculateBackoff(1, { strategy: 'linear', initialDelay: 500 }); // 500
 * calculateBackoff(2, { strategy: 'linear', initialDelay: 500 }); // 1000
 * calculateBackoff(3, { strategy: 'linear', initialDelay: 500 }); // 1500
 * ```
 *
 * @example Constant backoff with cap
 * ```ts
 * calculateBackoff(5, { strategy: 'constant', initialDelay: 200 }); // 200
 * ```
 *
 * @example maxDelay cap
 * ```ts
 * calculateBackoff(10, { strategy: 'exponential', maxDelay: 5000 }); // 5000
 * ```
 */
declare function calculateBackoff(attempt: number, opts?: BackoffOptions): number;

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
/**
 * Available jitter strategies.
 *
 * - `'full'`         — random in `[0, baseDelay]`. Maximum spread; AWS-recommended default.
 * - `'equal'`        — `baseDelay/2 + random(0, baseDelay/2)`. Minimum guaranteed delay.
 * - `'decorrelated'` — `random(initialDelay, previousDelay * 3)`, capped at `maxDelay`.
 * - `'none'`         — returns `baseDelay` unchanged. Useful for deterministic testing.
 */
type JitterStrategy = 'full' | 'equal' | 'decorrelated' | 'none';
/**
 * Optional configuration for {@link applyJitter}.
 */
interface JitterOptions {
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
declare function applyJitter(baseDelay: number, strategy?: JitterStrategy, opts?: JitterOptions): number;

export { type BackoffOptions as B, type JitterOptions as J, type BackoffStrategy as a, type JitterStrategy as b, applyJitter as c, calculateBackoff as d };
