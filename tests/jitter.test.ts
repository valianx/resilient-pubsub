/**
 * Tests for PR-2: applyJitter — jitter algorithms.
 *
 * Covers:
 * - Each strategy's bounds (many iterations to assert statistical range)
 * - 'none' returns exact baseDelay
 * - maxDelay clamp across strategies
 * - 'decorrelated' min/max bounds hold across iterations
 * - Result is always >= 0 and <= maxDelay
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyJitter } from '../src/core/jitter.ts';

/** Number of iterations for probabilistic range checks. */
const ITERATIONS = 500;

// ============================================================================
// Full jitter
// ============================================================================

describe('applyJitter — full', () => {
  test('result is always in [0, baseDelay] across many iterations', () => {
    const baseDelay = 2000;
    for (let i = 0; i < ITERATIONS; i++) {
      const d = applyJitter(baseDelay, 'full');
      assert.ok(d >= 0, `full jitter must be >= 0, got ${d}`);
      assert.ok(d <= baseDelay, `full jitter must be <= ${baseDelay}, got ${d}`);
    }
  });

  test('produces values both near 0 and near baseDelay over many runs', () => {
    const baseDelay = 10000;
    const results: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      results.push(applyJitter(baseDelay, 'full'));
    }
    const min = Math.min(...results);
    const max = Math.max(...results);
    // With 500 iterations the range should be wide; allow generous bounds.
    assert.ok(min < baseDelay * 0.1, `min=${min} should be < 10% of baseDelay`);
    assert.ok(max > baseDelay * 0.9, `max=${max} should be > 90% of baseDelay`);
  });

  test('default strategy is full', () => {
    const baseDelay = 1000;
    for (let i = 0; i < 100; i++) {
      const d = applyJitter(baseDelay);
      assert.ok(d >= 0 && d <= baseDelay);
    }
  });
});

// ============================================================================
// Equal jitter
// ============================================================================

describe('applyJitter — equal', () => {
  test('result is always in [baseDelay/2, baseDelay] across many iterations', () => {
    const baseDelay = 2000;
    const half = baseDelay / 2;
    for (let i = 0; i < ITERATIONS; i++) {
      const d = applyJitter(baseDelay, 'equal');
      assert.ok(d >= half, `equal jitter must be >= ${half}, got ${d}`);
      assert.ok(d <= baseDelay, `equal jitter must be <= ${baseDelay}, got ${d}`);
    }
  });

  test('minimum is floor(baseDelay/2) + 0', () => {
    // floor(1001/2) = 500; min possible is 500 + 0 = 500
    const baseDelay = 1001;
    const expectedMin = Math.floor(baseDelay / 2);
    for (let i = 0; i < ITERATIONS; i++) {
      const d = applyJitter(baseDelay, 'equal');
      assert.ok(d >= expectedMin, `must be >= ${expectedMin}, got ${d}`);
    }
  });

  test('equal jitter on baseDelay=0 returns 0', () => {
    const d = applyJitter(0, 'equal');
    assert.equal(d, 0);
  });
});

// ============================================================================
// Decorrelated jitter
// ============================================================================

describe('applyJitter — decorrelated', () => {
  test('result is always in [initialDelay, min(previousDelay*3, maxDelay)]', () => {
    const initialDelay = 500;
    const previousDelay = 2000;
    const maxDelay = 30000;
    const expectedMax = Math.min(previousDelay * 3, maxDelay); // 6000

    for (let i = 0; i < ITERATIONS; i++) {
      const d = applyJitter(previousDelay, 'decorrelated', {
        previousDelay,
        initialDelay,
        maxDelay,
      });
      assert.ok(d >= initialDelay, `decorrelated must be >= initialDelay=${initialDelay}, got ${d}`);
      assert.ok(d <= expectedMax, `decorrelated must be <= ${expectedMax}, got ${d}`);
    }
  });

  test('caps at maxDelay when previousDelay*3 exceeds it', () => {
    const previousDelay = 20000;
    const maxDelay = 10000;
    for (let i = 0; i < ITERATIONS; i++) {
      const d = applyJitter(previousDelay, 'decorrelated', {
        previousDelay,
        initialDelay: 1000,
        maxDelay,
      });
      assert.ok(d <= maxDelay, `decorrelated must be <= maxDelay=${maxDelay}, got ${d}`);
    }
  });

  test('defaults previousDelay to baseDelay when omitted', () => {
    // When previousDelay is omitted it defaults to baseDelay.
    // Range is [initialDelay, min(baseDelay*3, maxDelay)].
    const baseDelay = 1000;
    const initialDelay = 200;
    const maxDelay = 30000;
    for (let i = 0; i < ITERATIONS; i++) {
      const d = applyJitter(baseDelay, 'decorrelated', { initialDelay, maxDelay });
      assert.ok(d >= initialDelay, `must be >= ${initialDelay}, got ${d}`);
      assert.ok(d <= Math.min(baseDelay * 3, maxDelay), `must be <= ${Math.min(baseDelay * 3, maxDelay)}, got ${d}`);
    }
  });
});

// ============================================================================
// None jitter
// ============================================================================

describe('applyJitter — none', () => {
  test('returns baseDelay unchanged', () => {
    assert.equal(applyJitter(1000, 'none'), 1000);
    assert.equal(applyJitter(0, 'none'), 0);
    assert.equal(applyJitter(7500, 'none'), 7500);
  });

  test('none is deterministic across iterations', () => {
    const baseDelay = 3333;
    for (let i = 0; i < 100; i++) {
      assert.equal(applyJitter(baseDelay, 'none'), baseDelay);
    }
  });
});

// ============================================================================
// maxDelay clamp (all strategies)
// ============================================================================

describe('applyJitter — maxDelay clamp', () => {
  test('full jitter respects a custom maxDelay cap', () => {
    const baseDelay = 10000;
    const maxDelay = 3000;
    for (let i = 0; i < ITERATIONS; i++) {
      const d = applyJitter(baseDelay, 'full', { maxDelay });
      assert.ok(d <= maxDelay, `must be <= ${maxDelay}, got ${d}`);
    }
  });

  test('equal jitter respects a custom maxDelay cap', () => {
    const baseDelay = 10000;
    const maxDelay = 4000;
    for (let i = 0; i < ITERATIONS; i++) {
      const d = applyJitter(baseDelay, 'equal', { maxDelay });
      assert.ok(d <= maxDelay, `must be <= ${maxDelay}, got ${d}`);
    }
  });

  test('none strategy result is clamped to maxDelay when baseDelay exceeds it', () => {
    const d = applyJitter(50000, 'none', { maxDelay: 5000 });
    assert.equal(d, 5000);
  });
});

// ============================================================================
// Guards: result >= 0
// ============================================================================

describe('applyJitter — guards', () => {
  test('never returns a negative value for any strategy', () => {
    const strategies = ['full', 'equal', 'decorrelated', 'none'] as const;
    for (const strategy of strategies) {
      for (let i = 0; i < 50; i++) {
        const d = applyJitter(0, strategy, { initialDelay: 0, previousDelay: 0, maxDelay: 1000 });
        assert.ok(d >= 0, `${strategy} must return >= 0, got ${d}`);
      }
    }
  });
});
