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

// ============================================================================
// Types
// ============================================================================

/**
 * Available backoff strategies.
 *
 * - `'exponential'` — delay grows by a multiplier on each attempt (default).
 * - `'linear'`      — delay grows linearly with the attempt number.
 * - `'constant'`    — delay is always `initialDelay`, regardless of attempt.
 */
export type BackoffStrategy = 'exponential' | 'linear' | 'constant';

/**
 * Options for {@link calculateBackoff}.
 *
 * All fields are optional; defaults mirror `resilient-http`'s defaults for
 * cross-library consistency.
 */
export interface BackoffOptions {
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

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_STRATEGY: BackoffStrategy = 'exponential';
const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30000;
const DEFAULT_MULTIPLIER = 2;

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Clamps `value` to `[0, max]` and guards against NaN.
 *
 * @internal
 */
function clamp(value: number, max: number): number {
  if (!isFinite(value) || isNaN(value) || value < 0) return 0;
  return Math.min(value, max);
}

// ============================================================================
// Strategy implementations (internal)
// ============================================================================

/**
 * Exponential backoff: `initialDelay * multiplier^(attempt-1)`.
 *
 * attempt is 1-based: attempt=1 returns `initialDelay * multiplier^0 = initialDelay`.
 *
 * @internal
 */
function exponentialBackoff(attempt: number, opts: Required<BackoffOptions>): number {
  const raw = opts.initialDelay * Math.pow(opts.multiplier, attempt - 1);
  return clamp(raw, opts.maxDelay);
}

/**
 * Linear backoff: `initialDelay * attempt`.
 *
 * attempt is 1-based: attempt=1 returns `initialDelay * 1 = initialDelay`.
 *
 * @internal
 */
function linearBackoff(attempt: number, opts: Required<BackoffOptions>): number {
  const raw = opts.initialDelay * attempt;
  return clamp(raw, opts.maxDelay);
}

/**
 * Constant backoff: always returns `initialDelay`.
 *
 * @internal
 */
function constantBackoff(_attempt: number, opts: Required<BackoffOptions>): number {
  return clamp(opts.initialDelay, opts.maxDelay);
}

// ============================================================================
// Public API
// ============================================================================

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
export function calculateBackoff(attempt: number, opts: BackoffOptions = {}): number {
  const resolved: Required<BackoffOptions> = {
    strategy: opts.strategy ?? DEFAULT_STRATEGY,
    initialDelay: opts.initialDelay ?? DEFAULT_INITIAL_DELAY,
    maxDelay: opts.maxDelay ?? DEFAULT_MAX_DELAY,
    multiplier: opts.multiplier ?? DEFAULT_MULTIPLIER,
  };

  switch (resolved.strategy) {
    case 'exponential':
      return exponentialBackoff(attempt, resolved);
    case 'linear':
      return linearBackoff(attempt, resolved);
    case 'constant':
      return constantBackoff(attempt, resolved);
    default: {
      // Exhaustive fallback — TypeScript's never check keeps this safe if
      // BackoffStrategy is extended in the future without updating this switch.
      const _exhaustive: never = resolved.strategy;
      void _exhaustive;
      return exponentialBackoff(attempt, resolved);
    }
  }
}
