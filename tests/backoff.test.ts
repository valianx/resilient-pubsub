/**
 * Tests for PR-2: calculateBackoff — backoff strategies.
 *
 * Covers:
 * - Each strategy's formula (exponential, linear, constant)
 * - Attempt-1 base case (1-based indexing)
 * - maxDelay cap enforcement
 * - No negative or NaN results
 * - Defaults applied when options are omitted
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculateBackoff } from '../src/core/backoff.ts';

// ============================================================================
// Exponential backoff
// ============================================================================

describe('calculateBackoff — exponential (default)', () => {
  test('attempt=1 returns initialDelay (multiplier^0 = 1)', () => {
    const delay = calculateBackoff(1, { strategy: 'exponential', initialDelay: 1000, multiplier: 2 });
    assert.equal(delay, 1000);
  });

  test('attempt=2 returns initialDelay * multiplier^1', () => {
    const delay = calculateBackoff(2, { strategy: 'exponential', initialDelay: 1000, multiplier: 2 });
    assert.equal(delay, 2000);
  });

  test('attempt=3 returns initialDelay * multiplier^2', () => {
    const delay = calculateBackoff(3, { strategy: 'exponential', initialDelay: 1000, multiplier: 2 });
    assert.equal(delay, 4000);
  });

  test('attempt=4 returns initialDelay * multiplier^3', () => {
    const delay = calculateBackoff(4, { strategy: 'exponential', initialDelay: 500, multiplier: 3 });
    // 500 * 3^3 = 500 * 27 = 13500
    assert.equal(delay, 13500);
  });

  test('caps at maxDelay when formula exceeds it', () => {
    const delay = calculateBackoff(20, {
      strategy: 'exponential',
      initialDelay: 1000,
      multiplier: 2,
      maxDelay: 5000,
    });
    assert.equal(delay, 5000);
  });

  test('default strategy is exponential', () => {
    // Without explicit strategy, should behave as exponential with defaults
    const explicit = calculateBackoff(2, { strategy: 'exponential', initialDelay: 1000, multiplier: 2 });
    const implicit = calculateBackoff(2, { initialDelay: 1000, multiplier: 2 });
    assert.equal(explicit, implicit);
  });

  test('default initialDelay is 1000ms', () => {
    const delay = calculateBackoff(1);
    assert.equal(delay, 1000);
  });

  test('default multiplier is 2 (attempt=2 → 2000)', () => {
    const delay = calculateBackoff(2);
    assert.equal(delay, 2000);
  });

  test('default maxDelay is 30000ms', () => {
    const delay = calculateBackoff(100);
    assert.equal(delay, 30000);
  });
});

// ============================================================================
// Linear backoff
// ============================================================================

describe('calculateBackoff — linear', () => {
  test('attempt=1 returns initialDelay * 1', () => {
    const delay = calculateBackoff(1, { strategy: 'linear', initialDelay: 500 });
    assert.equal(delay, 500);
  });

  test('attempt=2 returns initialDelay * 2', () => {
    const delay = calculateBackoff(2, { strategy: 'linear', initialDelay: 500 });
    assert.equal(delay, 1000);
  });

  test('attempt=5 returns initialDelay * 5', () => {
    const delay = calculateBackoff(5, { strategy: 'linear', initialDelay: 200 });
    assert.equal(delay, 1000);
  });

  test('caps at maxDelay when formula exceeds it', () => {
    const delay = calculateBackoff(100, {
      strategy: 'linear',
      initialDelay: 1000,
      maxDelay: 8000,
    });
    assert.equal(delay, 8000);
  });

  test('linear does not grow exponentially', () => {
    const d3 = calculateBackoff(3, { strategy: 'linear', initialDelay: 1000, maxDelay: 100000 });
    const d6 = calculateBackoff(6, { strategy: 'linear', initialDelay: 1000, maxDelay: 100000 });
    // linear: 3000 vs 6000 — double
    assert.equal(d3, 3000);
    assert.equal(d6, 6000);
  });
});

// ============================================================================
// Constant backoff
// ============================================================================

describe('calculateBackoff — constant', () => {
  test('attempt=1 returns initialDelay', () => {
    const delay = calculateBackoff(1, { strategy: 'constant', initialDelay: 2000 });
    assert.equal(delay, 2000);
  });

  test('all attempts return the same initialDelay', () => {
    const opts = { strategy: 'constant' as const, initialDelay: 750, maxDelay: 30000 };
    for (const attempt of [1, 2, 5, 10, 100]) {
      assert.equal(calculateBackoff(attempt, opts), 750, `attempt=${attempt} should be 750`);
    }
  });

  test('caps at maxDelay even for constant strategy', () => {
    const delay = calculateBackoff(1, {
      strategy: 'constant',
      initialDelay: 99999,
      maxDelay: 5000,
    });
    assert.equal(delay, 5000);
  });
});

// ============================================================================
// Guards: no NaN, no negative
// ============================================================================

describe('calculateBackoff — guards', () => {
  test('never returns NaN', () => {
    // NaN input for initialDelay
    const delay = calculateBackoff(1, { initialDelay: NaN });
    assert.ok(!isNaN(delay), 'result must not be NaN');
  });

  test('never returns a negative value', () => {
    const delay = calculateBackoff(1, { initialDelay: -500 });
    assert.ok(delay >= 0, 'result must be >= 0');
  });

  test('result is always a finite number', () => {
    for (const attempt of [1, 2, 3, 5, 10]) {
      const d = calculateBackoff(attempt);
      assert.ok(isFinite(d), `attempt=${attempt} must be finite`);
    }
  });
});
