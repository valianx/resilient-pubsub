/**
 * 05-jitter.ts
 *
 * Tool: applyJitter — REAL implemented API.
 *
 * Purpose: apply randomness to a computed backoff delay to prevent the
 * "thundering herd" problem — many clients retrying at exactly the same
 * instant after a shared failure.
 *
 * Strategies:
 *   'full'         : random in [0, baseDelay]. Maximum spread. AWS-recommended default.
 *   'equal'        : floor(baseDelay/2) + random(0, floor(baseDelay/2)).
 *                    Guarantees at least half the base delay.
 *   'decorrelated' : random(initialDelay, previousDelay × 3), capped at maxDelay.
 *                    Each delay depends on the previous; produces a smooth distribution.
 *   'none'         : returns baseDelay unchanged. For deterministic tests.
 *
 * Default strategy: 'full'.
 *
 * Production pattern (combine with calculateBackoff):
 *   const base    = calculateBackoff(attempt, backoffOpts);
 *   const delayed = applyJitter(base, 'full');
 *   await sleep(delayed);
 */

import { calculateBackoff, applyJitter } from 'resilient-pubsub/core';

// ---------------------------------------------------------------------------
// Example A: full jitter — maximum spread.
// ---------------------------------------------------------------------------

/**
 * Full jitter picks a uniformly random value in [0, baseDelay].
 * The result is always <= the raw backoff value.
 */
export function example5a(): void {
  const base = calculateBackoff(3); // 4000 ms (exponential, default options)

  const jittered = applyJitter(base, 'full');
  console.log(`full jitter: base=${base}, jittered=${jittered}`);

  // Bounds hold: 0 ≤ jittered ≤ base
  console.assert(jittered >= 0 && jittered <= base, 'full jitter out of bounds');
}

// ---------------------------------------------------------------------------
// Example B: equal jitter — guaranteed minimum delay.
// ---------------------------------------------------------------------------

/**
 * Equal jitter guarantees at least half the base delay.
 * Reduces the probability of very short delays that immediately retry
 * and hit the same failure.
 */
export function example5b(): void {
  const base = calculateBackoff(2); // 2000 ms

  const jittered = applyJitter(base, 'equal');
  const half = Math.floor(base / 2);
  console.log(`equal jitter: base=${base}, half=${half}, jittered=${jittered}`);

  // Bounds hold: base/2 ≤ jittered ≤ base
  console.assert(jittered >= half && jittered <= base, 'equal jitter out of bounds');
}

// ---------------------------------------------------------------------------
// Example C: decorrelated jitter — smooth, cause-dependent distribution.
// ---------------------------------------------------------------------------

/**
 * Decorrelated jitter picks from [initialDelay, previousDelay × 3], capped
 * at maxDelay. Each call produces a delay loosely correlated with the previous
 * one, rather than anchored to the raw backoff formula.
 *
 * This strategy is effective when many instances share the same retry cadence
 * — the decorrelated window breaks lockstep retries across instances.
 */
export function example5c(): void {
  const MAX_DELAY = 30_000;
  const INITIAL = 1_000;

  // Simulate a three-attempt sequence
  let previousDelay = INITIAL;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const base = calculateBackoff(attempt);
    const jittered = applyJitter(base, 'decorrelated', {
      previousDelay,
      initialDelay: INITIAL,
      maxDelay: MAX_DELAY,
    });

    console.log(`attempt ${attempt}: base=${base}, decorrelated=${jittered}`);

    // Bounds hold: 0 ≤ jittered ≤ MAX_DELAY
    console.assert(jittered >= 0 && jittered <= MAX_DELAY, 'decorrelated out of bounds');
    previousDelay = jittered;
  }
}

// ---------------------------------------------------------------------------
// Example D: no jitter — deterministic, for tests.
// ---------------------------------------------------------------------------

/**
 * 'none' returns baseDelay unchanged. Use this in tests to produce predictable
 * delays and assert exact retry timing without introducing randomness.
 */
export function example5d(): void {
  const base = calculateBackoff(2); // 2000 ms
  const delay = applyJitter(base, 'none');
  console.log(delay); // exactly 2000 — no randomness
  console.assert(delay === base, 'none strategy should return base unchanged');
}

// ---------------------------------------------------------------------------
// Example E: full retry loop — backoff + jitter combined.
// ---------------------------------------------------------------------------

/**
 * The canonical pattern: compute a base delay with calculateBackoff, apply
 * jitter with applyJitter, then sleep. The publisher and subscriber do this
 * internally; this example shows the primitive-level pattern for custom use.
 */
export async function example5e(): Promise<void> {
  const MAX_ATTEMPTS = 4;

  async function unstableOperation(attempt: number): Promise<string> {
    if (attempt < MAX_ATTEMPTS) throw new Error(`transient failure ${attempt}`);
    return 'success';
  }

  let previousDelay = 1_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await unstableOperation(attempt);
      console.log(result); // 'success'
      break;
    } catch {
      if (attempt === MAX_ATTEMPTS) throw new Error('exhausted retries');

      const base = calculateBackoff(attempt, { initialDelay: 500 });
      const delay = applyJitter(base, 'decorrelated', {
        previousDelay,
        initialDelay: 500,
        maxDelay: 10_000,
      });

      console.log(`Attempt ${attempt} failed, retrying in ${delay} ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      previousDelay = delay;
    }
  }
}
