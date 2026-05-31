/**
 * Tests for PR-8 — resolveConfigFromEnv().
 *
 * All tests pass a fake `env` object to resolveConfigFromEnv() — real
 * `process.env` is never mutated. The fake env isolates each test completely.
 *
 * Covered acceptance criteria:
 * - AC-8.1: Each RESILIENT_PUBSUB_* variable is parsed correctly when set.
 * - AC-8.2: Unset variables produce `undefined` for the corresponding field.
 * - AC-8.3: Invalid values (non-numeric, unrecognized enum) are silently
 *            ignored (lenient policy) — the field is `undefined`.
 * - AC-8.4: Precedence is not tested here (that requires publisher/subscriber
 *            integration); this suite validates the parser in isolation.
 * - AC-8.5: Env constants are exported and match the expected strings.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveConfigFromEnv,
  ENV_MAX_ATTEMPTS,
  ENV_BACKOFF_STRATEGY,
  ENV_INITIAL_DELAY,
  ENV_MAX_DELAY,
  ENV_MULTIPLIER,
  ENV_JITTER,
  ENV_STOP_TIMEOUT_MS,
  ENV_MAX_MESSAGES,
  ENV_MAX_BYTES,
} from '../src/config/env.ts';

// ============================================================================
// AC-8.5: Exported constants match expected strings
// ============================================================================

describe('resolveConfigFromEnv — AC-8.5: env-var name constants', () => {
  test('ENV_MAX_ATTEMPTS is the correct variable name', () => {
    assert.equal(ENV_MAX_ATTEMPTS, 'RESILIENT_PUBSUB_MAX_ATTEMPTS');
  });

  test('ENV_BACKOFF_STRATEGY is the correct variable name', () => {
    assert.equal(ENV_BACKOFF_STRATEGY, 'RESILIENT_PUBSUB_BACKOFF_STRATEGY');
  });

  test('ENV_INITIAL_DELAY is the correct variable name', () => {
    assert.equal(ENV_INITIAL_DELAY, 'RESILIENT_PUBSUB_INITIAL_DELAY');
  });

  test('ENV_MAX_DELAY is the correct variable name', () => {
    assert.equal(ENV_MAX_DELAY, 'RESILIENT_PUBSUB_MAX_DELAY');
  });

  test('ENV_MULTIPLIER is the correct variable name', () => {
    assert.equal(ENV_MULTIPLIER, 'RESILIENT_PUBSUB_MULTIPLIER');
  });

  test('ENV_JITTER is the correct variable name', () => {
    assert.equal(ENV_JITTER, 'RESILIENT_PUBSUB_JITTER');
  });

  test('ENV_STOP_TIMEOUT_MS is the correct variable name', () => {
    assert.equal(ENV_STOP_TIMEOUT_MS, 'RESILIENT_PUBSUB_STOP_TIMEOUT_MS');
  });

  test('ENV_MAX_MESSAGES is the correct variable name', () => {
    assert.equal(ENV_MAX_MESSAGES, 'RESILIENT_PUBSUB_MAX_MESSAGES');
  });

  test('ENV_MAX_BYTES is the correct variable name', () => {
    assert.equal(ENV_MAX_BYTES, 'RESILIENT_PUBSUB_MAX_BYTES');
  });
});

// ============================================================================
// AC-8.2: Unset variables produce undefined
// ============================================================================

describe('resolveConfigFromEnv — AC-8.2: unset variables produce undefined', () => {
  test('empty env object produces all-undefined config', () => {
    const cfg = resolveConfigFromEnv({});

    assert.equal(cfg.maxAttempts, undefined);
    assert.equal(cfg.strategy, undefined);
    assert.equal(cfg.initialDelay, undefined);
    assert.equal(cfg.maxDelay, undefined);
    assert.equal(cfg.multiplier, undefined);
    assert.equal(cfg.jitter, undefined);
    assert.equal(cfg.stopTimeoutMs, undefined);
    assert.equal(cfg.maxMessages, undefined);
    assert.equal(cfg.maxBytes, undefined);
  });

  test('real process.env (no RESILIENT_PUBSUB_* set) does not throw', () => {
    // Calling without args uses process.env — should never throw.
    assert.doesNotThrow(() => resolveConfigFromEnv());
  });
});

// ============================================================================
// AC-8.1: Valid values are parsed correctly
// ============================================================================

describe('resolveConfigFromEnv — AC-8.1: valid values are parsed', () => {
  test('parses RESILIENT_PUBSUB_MAX_ATTEMPTS as a positive integer', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_ATTEMPTS: '5' });
    assert.equal(cfg.maxAttempts, 5);
  });

  test('parses RESILIENT_PUBSUB_BACKOFF_STRATEGY: exponential', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_BACKOFF_STRATEGY: 'exponential' });
    assert.equal(cfg.strategy, 'exponential');
  });

  test('parses RESILIENT_PUBSUB_BACKOFF_STRATEGY: linear', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_BACKOFF_STRATEGY: 'linear' });
    assert.equal(cfg.strategy, 'linear');
  });

  test('parses RESILIENT_PUBSUB_BACKOFF_STRATEGY: constant', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_BACKOFF_STRATEGY: 'constant' });
    assert.equal(cfg.strategy, 'constant');
  });

  test('parses RESILIENT_PUBSUB_INITIAL_DELAY as a positive integer', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_INITIAL_DELAY: '500' });
    assert.equal(cfg.initialDelay, 500);
  });

  test('parses RESILIENT_PUBSUB_MAX_DELAY as a positive integer', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_DELAY: '60000' });
    assert.equal(cfg.maxDelay, 60000);
  });

  test('parses RESILIENT_PUBSUB_MULTIPLIER as a positive float', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MULTIPLIER: '1.5' });
    assert.equal(cfg.multiplier, 1.5);
  });

  test('parses RESILIENT_PUBSUB_JITTER: full', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_JITTER: 'full' });
    assert.equal(cfg.jitter, 'full');
  });

  test('parses RESILIENT_PUBSUB_JITTER: equal', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_JITTER: 'equal' });
    assert.equal(cfg.jitter, 'equal');
  });

  test('parses RESILIENT_PUBSUB_JITTER: decorrelated', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_JITTER: 'decorrelated' });
    assert.equal(cfg.jitter, 'decorrelated');
  });

  test('parses RESILIENT_PUBSUB_JITTER: none', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_JITTER: 'none' });
    assert.equal(cfg.jitter, 'none');
  });

  test('parses RESILIENT_PUBSUB_STOP_TIMEOUT_MS as a positive integer', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_STOP_TIMEOUT_MS: '15000' });
    assert.equal(cfg.stopTimeoutMs, 15000);
  });

  test('parses RESILIENT_PUBSUB_MAX_MESSAGES as a positive integer', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_MESSAGES: '50' });
    assert.equal(cfg.maxMessages, 50);
  });

  test('parses RESILIENT_PUBSUB_MAX_BYTES as a positive integer', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_BYTES: '10485760' });
    assert.equal(cfg.maxBytes, 10485760);
  });

  test('parses multiple vars from one fake env object', () => {
    const cfg = resolveConfigFromEnv({
      RESILIENT_PUBSUB_MAX_ATTEMPTS: '10',
      RESILIENT_PUBSUB_BACKOFF_STRATEGY: 'linear',
      RESILIENT_PUBSUB_JITTER: 'none',
      RESILIENT_PUBSUB_STOP_TIMEOUT_MS: '5000',
    });

    assert.equal(cfg.maxAttempts, 10);
    assert.equal(cfg.strategy, 'linear');
    assert.equal(cfg.jitter, 'none');
    assert.equal(cfg.stopTimeoutMs, 5000);
    // Unset fields remain undefined
    assert.equal(cfg.initialDelay, undefined);
    assert.equal(cfg.maxDelay, undefined);
  });
});

// ============================================================================
// AC-8.3: Invalid values are silently ignored (lenient policy)
// ============================================================================

describe('resolveConfigFromEnv — AC-8.3: invalid values produce undefined (lenient)', () => {
  test('non-numeric MAX_ATTEMPTS produces undefined', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_ATTEMPTS: 'five' });
    assert.equal(cfg.maxAttempts, undefined);
  });

  test('zero MAX_ATTEMPTS produces undefined (must be positive)', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_ATTEMPTS: '0' });
    assert.equal(cfg.maxAttempts, undefined);
  });

  test('negative MAX_ATTEMPTS produces undefined', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_ATTEMPTS: '-1' });
    assert.equal(cfg.maxAttempts, undefined);
  });

  test('float MAX_ATTEMPTS produces undefined (must be integer)', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_ATTEMPTS: '3.5' });
    assert.equal(cfg.maxAttempts, undefined);
  });

  test('unrecognized BACKOFF_STRATEGY produces undefined', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_BACKOFF_STRATEGY: 'fibonacci' });
    assert.equal(cfg.strategy, undefined);
  });

  test('unrecognized JITTER produces undefined', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_JITTER: 'random-plus' });
    assert.equal(cfg.jitter, undefined);
  });

  test('non-numeric INITIAL_DELAY produces undefined', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_INITIAL_DELAY: 'fast' });
    assert.equal(cfg.initialDelay, undefined);
  });

  test('zero MULTIPLIER produces undefined (must be positive)', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MULTIPLIER: '0' });
    assert.equal(cfg.multiplier, undefined);
  });

  test('empty string for any variable produces undefined', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_ATTEMPTS: '' });
    assert.equal(cfg.maxAttempts, undefined);
  });

  test('whitespace-only string for any variable produces undefined', () => {
    const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_ATTEMPTS: '   ' });
    assert.equal(cfg.maxAttempts, undefined);
  });

  test('invalid value for one var does not affect valid values for others', () => {
    const cfg = resolveConfigFromEnv({
      RESILIENT_PUBSUB_MAX_ATTEMPTS: 'bad',
      RESILIENT_PUBSUB_INITIAL_DELAY: '1000',
    });

    assert.equal(cfg.maxAttempts, undefined, 'invalid value must produce undefined');
    assert.equal(cfg.initialDelay, 1000, 'valid value must still parse correctly');
  });
});
