/**
 * 04-backoff-strategies.ts
 *
 * Tool: calculateBackoff — REAL implemented API.
 *
 * Formulas (before jitter is applied):
 *   exponential : delay = min(initialDelay × multiplier^(attempt−1), maxDelay)
 *                 attempt is 1-based: attempt=1 returns initialDelay.
 *                 Defaults: initialDelay=1000, multiplier=2, maxDelay=30000.
 *
 *   linear      : delay = min(initialDelay × attempt, maxDelay)
 *                 attempt=1 → initialDelay; attempt=2 → 2×initialDelay; …
 *
 *   constant    : delay = initialDelay (always; multiplier is ignored).
 *
 * All results are clamped to [0, maxDelay] and are never NaN.
 * Note: apply jitter AFTER backoff in production — use applyJitter() from 05-jitter.ts.
 */

import { calculateBackoff } from 'resilient-pubsub/core';

// ---------------------------------------------------------------------------
// Example A: exponential backoff (default strategy).
// ---------------------------------------------------------------------------

/**
 * Exponential backoff doubles the delay on each attempt.
 * This is the AWS-recommended default for preventing thundering herd.
 *
 * Formula: initialDelay × multiplier^(attempt−1)
 */
export function example4a(): void {
  // Default options: strategy='exponential', initialDelay=1000, multiplier=2, maxDelay=30000
  console.log(calculateBackoff(1)); // 1000  — 1000 × 2^0
  console.log(calculateBackoff(2)); // 2000  — 1000 × 2^1
  console.log(calculateBackoff(3)); // 4000  — 1000 × 2^2
  console.log(calculateBackoff(4)); // 8000  — 1000 × 2^3
  console.log(calculateBackoff(5)); // 16000 — 1000 × 2^4
  console.log(calculateBackoff(6)); // 30000 — capped at maxDelay

  // Custom initial delay and multiplier
  const delay = calculateBackoff(3, { initialDelay: 500, multiplier: 3 });
  console.log(delay); // 500 × 3^2 = 4500 ms
}

// ---------------------------------------------------------------------------
// Example B: linear backoff.
// ---------------------------------------------------------------------------

/**
 * Linear backoff grows proportionally to the attempt number.
 * Suitable for operations where a moderate, predictable delay is preferred
 * over aggressive exponential growth.
 *
 * Formula: initialDelay × attempt
 */
export function example4b(): void {
  const opts = { strategy: 'linear' as const, initialDelay: 500, maxDelay: 10_000 };

  console.log(calculateBackoff(1, opts)); // 500  — 500 × 1
  console.log(calculateBackoff(2, opts)); // 1000 — 500 × 2
  console.log(calculateBackoff(3, opts)); // 1500 — 500 × 3
  console.log(calculateBackoff(4, opts)); // 2000 — 500 × 4
  console.log(calculateBackoff(20, opts)); // 10000 — capped at maxDelay
}

// ---------------------------------------------------------------------------
// Example C: constant backoff.
// ---------------------------------------------------------------------------

/**
 * Constant backoff returns the same delay regardless of the attempt number.
 * Useful for polling scenarios or when the retry interval should never change
 * (e.g., a fixed-rate queue drain).
 */
export function example4c(): void {
  const opts = { strategy: 'constant' as const, initialDelay: 250 };

  console.log(calculateBackoff(1, opts)); // 250
  console.log(calculateBackoff(5, opts)); // 250 — same every time
  console.log(calculateBackoff(10, opts)); // 250
}

// ---------------------------------------------------------------------------
// Example D: maxDelay cap across all strategies.
// ---------------------------------------------------------------------------

/**
 * Every strategy is capped at maxDelay. This prevents excessive delays in
 * long-running retry loops, even when the formula would produce a larger value.
 */
export function example4d(): void {
  const MAX = 5_000;

  // Exponential at attempt=10 would be 1000 × 2^9 = 512000 — capped at 5000.
  console.log(calculateBackoff(10, { maxDelay: MAX })); // 5000

  // Linear at attempt=20 would be 1000 × 20 = 20000 — capped at 5000.
  console.log(calculateBackoff(20, { strategy: 'linear', maxDelay: MAX })); // 5000
}

// ---------------------------------------------------------------------------
// Example E: building a retry loop with calculateBackoff.
// ---------------------------------------------------------------------------

/**
 * Shows how calculateBackoff fits into a manual retry loop.
 * In the full publisher/subscriber, the library runs this loop for you.
 * This example illustrates the pattern for custom use cases.
 */
export async function example4e(): Promise<void> {
  const MAX_ATTEMPTS = 4;

  async function attemptOperation(attempt: number): Promise<void> {
    // Simulate transient failure on attempts 1–3
    if (attempt < MAX_ATTEMPTS) {
      throw new Error(`Transient failure on attempt ${attempt}`);
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await attemptOperation(attempt);
      console.log(`Succeeded on attempt ${attempt}`);
      break;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;

      const delayMs = calculateBackoff(attempt, {
        strategy: 'exponential',
        initialDelay: 100,
        maxDelay: 2_000,
      });

      console.log(`Attempt ${attempt} failed; retrying in ${delayMs} ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
