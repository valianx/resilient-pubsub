/**
 * Tests for PR-7: native dead-letter support (opt-in).
 *
 * Covered acceptance criteria:
 * - AC-7.1: buildDeadLetterPolicy with valid topic + in-range maxDeliveryAttempts
 *            returns the native-shaped policy object.
 * - AC-7.2: maxDeliveryAttempts defaults to 5 when omitted.
 * - AC-7.3: maxDeliveryAttempts < 5, > 100, or non-integer throws
 *            ResilientPubSubError{ kind: 'config' }.
 * - AC-7.4: empty or whitespace-only deadLetterTopic throws
 *            ResilientPubSubError{ kind: 'config' }.
 * - AC-7.5: getDeliveryAttempt(meta) returns meta.deliveryAttempt / undefined.
 * - AC-7.6: withDeadLetter merges deadLetterPolicy into a subscription-options object.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeadLetterPolicy,
  getDeliveryAttempt,
  withDeadLetter,
  DELIVERY_ATTEMPT_ATTRIBUTE,
  DEAD_LETTER_IAM_REQUIREMENTS,
} from '../src/dlq/dlq.ts';
import { ResilientPubSubError } from '../src/errors/error.ts';
import type { EnvelopeMeta } from '../src/types/index.ts';

// ============================================================================
// buildDeadLetterPolicy — happy paths
// ============================================================================

describe('buildDeadLetterPolicy — valid inputs', () => {
  test('returns native-shaped policy with explicit maxDeliveryAttempts', () => {
    const policy = buildDeadLetterPolicy({
      deadLetterTopic: 'projects/my-project/topics/orders-dlq',
      maxDeliveryAttempts: 10,
    });

    assert.deepEqual(policy, {
      deadLetterTopic: 'projects/my-project/topics/orders-dlq',
      maxDeliveryAttempts: 10,
    });
  });

  test('defaults maxDeliveryAttempts to 5 when omitted', () => {
    const policy = buildDeadLetterPolicy({
      deadLetterTopic: 'projects/my-project/topics/orders-dlq',
    });

    assert.equal(policy.maxDeliveryAttempts, 5);
    assert.equal(policy.deadLetterTopic, 'projects/my-project/topics/orders-dlq');
  });

  test('accepts maxDeliveryAttempts at lower boundary (5)', () => {
    const policy = buildDeadLetterPolicy({
      deadLetterTopic: 'projects/p/topics/t',
      maxDeliveryAttempts: 5,
    });

    assert.equal(policy.maxDeliveryAttempts, 5);
  });

  test('accepts maxDeliveryAttempts at upper boundary (100)', () => {
    const policy = buildDeadLetterPolicy({
      deadLetterTopic: 'projects/p/topics/t',
      maxDeliveryAttempts: 100,
    });

    assert.equal(policy.maxDeliveryAttempts, 100);
  });

  test('returned object has the exact two fields (no extra keys)', () => {
    const policy = buildDeadLetterPolicy({
      deadLetterTopic: 'projects/p/topics/t',
      maxDeliveryAttempts: 7,
    });

    assert.deepEqual(Object.keys(policy).sort(), ['deadLetterTopic', 'maxDeliveryAttempts']);
  });
});

// ============================================================================
// buildDeadLetterPolicy — maxDeliveryAttempts validation
// ============================================================================

describe('buildDeadLetterPolicy — maxDeliveryAttempts validation', () => {
  test('throws config error when maxDeliveryAttempts < 5', () => {
    assert.throws(
      () =>
        buildDeadLetterPolicy({
          deadLetterTopic: 'projects/p/topics/t',
          maxDeliveryAttempts: 4,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.kind, 'config');
        return true;
      }
    );
  });

  test('throws config error when maxDeliveryAttempts > 100', () => {
    assert.throws(
      () =>
        buildDeadLetterPolicy({
          deadLetterTopic: 'projects/p/topics/t',
          maxDeliveryAttempts: 101,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.kind, 'config');
        return true;
      }
    );
  });

  test('throws config error when maxDeliveryAttempts is 0', () => {
    assert.throws(
      () =>
        buildDeadLetterPolicy({
          deadLetterTopic: 'projects/p/topics/t',
          maxDeliveryAttempts: 0,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.kind, 'config');
        return true;
      }
    );
  });

  test('throws config error when maxDeliveryAttempts is a non-integer (float)', () => {
    assert.throws(
      () =>
        buildDeadLetterPolicy({
          deadLetterTopic: 'projects/p/topics/t',
          maxDeliveryAttempts: 5.5,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.kind, 'config');
        assert.ok(err.message.includes('integer'));
        return true;
      }
    );
  });

  test('throws config error when maxDeliveryAttempts is NaN', () => {
    assert.throws(
      () =>
        buildDeadLetterPolicy({
          deadLetterTopic: 'projects/p/topics/t',
          maxDeliveryAttempts: NaN,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.kind, 'config');
        return true;
      }
    );
  });

  test('config error has classification permanent and retryable false', () => {
    assert.throws(
      () =>
        buildDeadLetterPolicy({
          deadLetterTopic: 'projects/p/topics/t',
          maxDeliveryAttempts: 200,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.classification, 'permanent');
        assert.equal(err.retryable, false);
        return true;
      }
    );
  });
});

// ============================================================================
// buildDeadLetterPolicy — deadLetterTopic validation
// ============================================================================

describe('buildDeadLetterPolicy — deadLetterTopic validation', () => {
  test('throws config error when deadLetterTopic is an empty string', () => {
    assert.throws(
      () => buildDeadLetterPolicy({ deadLetterTopic: '' }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.kind, 'config');
        return true;
      }
    );
  });

  test('throws config error when deadLetterTopic is whitespace only', () => {
    assert.throws(
      () => buildDeadLetterPolicy({ deadLetterTopic: '   ' }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.kind, 'config');
        return true;
      }
    );
  });
});

// ============================================================================
// getDeliveryAttempt
// ============================================================================

describe('getDeliveryAttempt', () => {
  test('returns meta.deliveryAttempt when present', () => {
    const meta: EnvelopeMeta = { messageId: 'msg-1', deliveryAttempt: 3 };
    assert.equal(getDeliveryAttempt(meta), 3);
  });

  test('returns undefined when deliveryAttempt is not set (no DLQ policy)', () => {
    const meta: EnvelopeMeta = { messageId: 'msg-2' };
    assert.equal(getDeliveryAttempt(meta), undefined);
  });

  test('returns 1 for first delivery attempt', () => {
    const meta: EnvelopeMeta = { deliveryAttempt: 1 };
    assert.equal(getDeliveryAttempt(meta), 1);
  });
});

// ============================================================================
// withDeadLetter
// ============================================================================

describe('withDeadLetter', () => {
  test('merges deadLetterPolicy into an empty options object', () => {
    const result = withDeadLetter(
      {},
      { deadLetterTopic: 'projects/p/topics/t', maxDeliveryAttempts: 10 }
    );

    assert.deepEqual(result.deadLetterPolicy, {
      deadLetterTopic: 'projects/p/topics/t',
      maxDeliveryAttempts: 10,
    });
  });

  test('preserves existing options when merging', () => {
    const result = withDeadLetter(
      { flowControl: { maxMessages: 5 } },
      { deadLetterTopic: 'projects/p/topics/t' }
    );

    assert.deepEqual(result['flowControl'], { maxMessages: 5 });
    assert.deepEqual(result.deadLetterPolicy, {
      deadLetterTopic: 'projects/p/topics/t',
      maxDeliveryAttempts: 5,
    });
  });

  test('returns a new object (does not mutate the input)', () => {
    const original = { flowControl: { maxMessages: 5 } };
    const result = withDeadLetter(original, { deadLetterTopic: 'projects/p/topics/t' });

    assert.ok(result !== original);
    assert.equal((original as Record<string, unknown>)['deadLetterPolicy'], undefined);
  });

  test('propagates config validation errors from buildDeadLetterPolicy', () => {
    assert.throws(
      () => withDeadLetter({}, { deadLetterTopic: '', maxDeliveryAttempts: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.kind, 'config');
        return true;
      }
    );
  });
});

// ============================================================================
// Constants — sanity checks
// ============================================================================

describe('exported constants', () => {
  test('DELIVERY_ATTEMPT_ATTRIBUTE has the correct Pub/Sub attribute key', () => {
    assert.equal(DELIVERY_ATTEMPT_ATTRIBUTE, 'googclient_deliveryattempt');
  });

  test('DEAD_LETTER_IAM_REQUIREMENTS is a non-empty string', () => {
    assert.ok(typeof DEAD_LETTER_IAM_REQUIREMENTS === 'string');
    assert.ok(DEAD_LETTER_IAM_REQUIREMENTS.length > 0);
    assert.ok(DEAD_LETTER_IAM_REQUIREMENTS.includes('pubsub.publisher'));
    assert.ok(DEAD_LETTER_IAM_REQUIREMENTS.includes('pubsub.subscriber'));
  });
});
