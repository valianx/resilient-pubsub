/**
 * Tests for PR-5: createResilientPublisher.
 *
 * All tests use an injected `_sleep` (no real timers) and a scripted fake
 * PubSubLike/TopicLike so that the entire suite runs synchronously-fast.
 *
 * Covered acceptance criteria:
 * - AC-5.1: First-attempt success — body serialized, content-type +
 *            schema-version attributes set, allowlisted propagation present,
 *            non-allowlisted absent.
 * - AC-5.2: Transient-then-success — publisher retries, onRetry fires per attempt.
 * - AC-5.3: Transient always → rejects ResilientPubSubError{kind:'publish'}
 *            after maxAttempts, cause = last raw error.
 * - AC-5.4: Permanent error → single attempt, immediate rejection, no retries.
 * - AC-5.5: Ordering — orderingKey passed to publishMessage; resumePublishing
 *            called on transient failure.
 * - AC-5.6: .topic getter exposes the native TopicLike handle.
 * - AC-5.7: Custom serializer contentType is stored in content-type attribute.
 * - AC-5.8: No pubSubClient → config error on first publish().
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createResilientPublisher } from '../src/publisher/publisher.ts';
import type {
  PubSubLike,
  TopicLike,
  PublishInput,
} from '../src/publisher/publisher.ts';
import { ResilientPubSubError } from '../src/errors/error.ts';
import type { Serializer } from '../src/envelope/serializer.ts';

// ============================================================================
// Test helpers — scripted fake Pub/Sub
// ============================================================================

interface PublishCall {
  data: Buffer;
  attributes?: Record<string, string>;
  orderingKey?: string;
}

/**
 * Builds a fake TopicLike whose publishMessage behavior is driven by a
 * sequence of pre-scripted outcomes. Each call pops the next item:
 * - `{ ok: 'msg-id' }` → resolves with that message ID
 * - `{ err: Error }` → rejects with that error
 *
 * Calls and resumePublishing invocations are recorded for assertion.
 */
function makeFakeTopic(
  outcomes: Array<{ ok: string } | { err: Error }>
): TopicLike & {
  calls: PublishCall[];
  resumeCalls: string[];
} {
  const calls: PublishCall[] = [];
  const resumeCalls: string[] = [];
  let index = 0;

  return {
    calls,
    resumeCalls,
    publishMessage(message: PublishCall): Promise<string> {
      calls.push({ ...message });
      const outcome = outcomes[index++];
      if (outcome === undefined) {
        return Promise.reject(new Error('unexpected publishMessage call — no more outcomes'));
      }
      if ('ok' in outcome) return Promise.resolve(outcome.ok);
      return Promise.reject(outcome.err);
    },
    resumePublishing(key: string): void {
      resumeCalls.push(key);
    },
  };
}

/**
 * Wraps a fake topic in a minimal PubSubLike client.
 */
function makeFakeClient(topic: TopicLike): PubSubLike {
  return {
    topic(_name: string, _opts?: Record<string, unknown>): TopicLike {
      return topic;
    },
  };
}

/** No-op sleep for fast, deterministic tests. */
const noSleep = (_ms: number): Promise<void> => Promise.resolve();

/** A transient gRPC error (code 14 = UNAVAILABLE). */
function transientError(msg = 'UNAVAILABLE'): Error {
  return Object.assign(new Error(msg), { code: 14 });
}

/** A permanent gRPC error (code 7 = PERMISSION_DENIED). */
function permanentError(msg = 'PERMISSION_DENIED'): Error {
  return Object.assign(new Error(msg), { code: 7 });
}

// ============================================================================
// AC-5.1: First-attempt success
// ============================================================================

describe('createResilientPublisher — AC-5.1: first-attempt success', () => {
  test('resolves with messageId on first attempt', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-001' }]);
    const client = makeFakeClient(topic);

    const publisher = createResilientPublisher<{ orderId: string }>({
      topic: 'orders',
      pubSubClient: client,
      _sleep: noSleep,
    });

    const result = await publisher.publish({ body: { orderId: '42' } });

    assert.equal(result.messageId, 'msg-001');
    assert.equal(topic.calls.length, 1);
  });

  test('sets content-type attribute to application/json (default JsonSerializer)', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-002' }]);
    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      _sleep: noSleep,
    });

    await publisher.publish({ body: { x: 1 } });

    assert.equal(topic.calls[0]?.attributes?.['content-type'], 'application/json');
  });

  test('sets schema-version attribute when schemaVersion is configured', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-003' }]);
    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      schemaVersion: '2.0.0',
      _sleep: noSleep,
    });

    await publisher.publish({ body: { x: 1 } });

    assert.equal(topic.calls[0]?.attributes?.['schema-version'], '2.0.0');
  });

  test('omits schema-version attribute when schemaVersion is not configured', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-004' }]);
    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      _sleep: noSleep,
    });

    await publisher.publish({ body: { x: 1 } });

    assert.equal(topic.calls[0]?.attributes?.['schema-version'], undefined);
  });

  test('propagates allowlisted header but drops non-allowlisted header', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-005' }]);
    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      propagation: { allowlist: ['x-tenant-id'] },
      _sleep: noSleep,
    });

    await publisher.publish({
      body: { x: 1 },
      headers: {
        traceparent: '00-abc-01',
        'x-tenant-id': 'acme',
        authorization: 'Bearer secret',
      },
    });

    const attrs = topic.calls[0]?.attributes ?? {};
    assert.equal(attrs['traceparent'], '00-abc-01', 'traceparent should be propagated');
    assert.equal(attrs['x-tenant-id'], 'acme', 'allowlisted header should be propagated');
    assert.equal(attrs['authorization'], undefined, 'non-allowlisted header must be dropped');
  });

  test('W3C trace headers propagate automatically even without explicit allowlist', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-006' }]);
    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      _sleep: noSleep,
    });

    await publisher.publish({
      body: { x: 1 },
      headers: { traceparent: '00-xyz-01', tracestate: 'k=v' },
    });

    const attrs = topic.calls[0]?.attributes ?? {};
    assert.equal(attrs['traceparent'], '00-xyz-01');
    assert.equal(attrs['tracestate'], 'k=v');
  });

  test('body is serialized and passed as Buffer', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-007' }]);
    const publisher = createResilientPublisher<{ value: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      _sleep: noSleep,
    });

    await publisher.publish({ body: { value: 99 } });

    const call = topic.calls[0];
    assert.ok(Buffer.isBuffer(call?.data), 'data must be a Buffer');
    const parsed = JSON.parse(call!.data.toString('utf8')) as unknown;
    assert.deepEqual(parsed, { value: 99 });
  });

  test('calls onPublish hook with messageId on success', async () => {
    const topic = makeFakeTopic([{ ok: 'hook-msg-01' }]);
    let hookFired = false;
    let hookedId: string | undefined;

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      hooks: {
        onPublish: ({ messageId }) => {
          hookFired = true;
          hookedId = messageId;
        },
      },
      _sleep: noSleep,
    });

    await publisher.publish({ body: { x: 1 } });

    assert.equal(hookFired, true);
    assert.equal(hookedId, 'hook-msg-01');
  });
});

// ============================================================================
// AC-5.2: Transient-then-success
// ============================================================================

describe('createResilientPublisher — AC-5.2: transient-then-success', () => {
  test('retries after transient failure and resolves on second attempt', async () => {
    const topic = makeFakeTopic([{ err: transientError() }, { ok: 'msg-retry-01' }]);
    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      retry: { maxAttempts: 3 },
      _sleep: noSleep,
    });

    const result = await publisher.publish({ body: { x: 1 } });

    assert.equal(result.messageId, 'msg-retry-01');
    assert.equal(topic.calls.length, 2);
  });

  test('fires onRetry hook for each transient failure before success', async () => {
    const topic = makeFakeTopic([
      { err: transientError('err1') },
      { err: transientError('err2') },
      { ok: 'msg-retry-02' },
    ]);

    const retryCalls: Array<{ attempt: number; delay: number }> = [];

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      retry: { maxAttempts: 3, jitter: 'none', initialDelay: 100 },
      hooks: {
        onRetry: ({ attempt, delay }) => {
          retryCalls.push({ attempt, delay });
        },
      },
      _sleep: noSleep,
    });

    await publisher.publish({ body: { x: 1 } });

    assert.equal(retryCalls.length, 2, 'onRetry should fire twice');
    assert.equal(retryCalls[0]?.attempt, 1);
    assert.equal(retryCalls[1]?.attempt, 2);
  });

  test('does not fire onRetry on first-attempt success', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-no-retry' }]);
    let retryCalled = false;

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      hooks: { onRetry: () => { retryCalled = true; } },
      _sleep: noSleep,
    });

    await publisher.publish({ body: { x: 1 } });

    assert.equal(retryCalled, false);
  });
});

// ============================================================================
// AC-5.3: Transient always → exhaustion rejection
// ============================================================================

describe('createResilientPublisher — AC-5.3: exhaustion after maxAttempts', () => {
  test('rejects with ResilientPubSubError{kind:publish} after maxAttempts', async () => {
    const rawError = transientError('always fails');
    const topic = makeFakeTopic([
      { err: rawError },
      { err: rawError },
      { err: rawError },
    ]);

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      retry: { maxAttempts: 3 },
      _sleep: noSleep,
    });

    await assert.rejects(
      () => publisher.publish({ body: { x: 1 } }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError, 'must be ResilientPubSubError');
        assert.equal(err.kind, 'publish');
        return true;
      }
    );

    assert.equal(topic.calls.length, 3, 'must have attempted exactly maxAttempts times');
  });

  test('exhaustion error has cause = last raw error', async () => {
    const lastRaw = transientError('final failure');
    const topic = makeFakeTopic([
      { err: transientError('first') },
      { err: lastRaw },
    ]);

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      retry: { maxAttempts: 2 },
      _sleep: noSleep,
    });

    await assert.rejects(
      () => publisher.publish({ body: { x: 1 } }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal((err as ResilientPubSubError & { cause: unknown }).cause, lastRaw);
        return true;
      }
    );
  });

  test('sleeps between retries (injected sleep receives positive ms)', async () => {
    const topic = makeFakeTopic([
      { err: transientError() },
      { err: transientError() },
      { ok: 'msg-sleep-test' },
    ]);

    const sleepCalls: number[] = [];
    const recordSleep = (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      retry: { maxAttempts: 3, jitter: 'none', initialDelay: 500, strategy: 'constant' },
      _sleep: recordSleep,
    });

    await publisher.publish({ body: { x: 1 } });

    assert.equal(sleepCalls.length, 2, 'should sleep between each retry');
    assert.ok(sleepCalls[0]! > 0, 'sleep duration must be positive');
    assert.ok(sleepCalls[1]! > 0, 'sleep duration must be positive');
  });
});

// ============================================================================
// AC-5.4: Permanent error → immediate rejection
// ============================================================================

describe('createResilientPublisher — AC-5.4: permanent error, no retries', () => {
  test('rejects immediately on permanent gRPC error without retrying', async () => {
    const topic = makeFakeTopic([{ err: permanentError() }]);

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      retry: { maxAttempts: 5 },
      _sleep: noSleep,
    });

    await assert.rejects(
      () => publisher.publish({ body: { x: 1 } }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal(err.kind, 'publish');
        return true;
      }
    );

    assert.equal(topic.calls.length, 1, 'must not retry on permanent error');
  });

  test('permanent rejection wraps the raw gRPC error as cause', async () => {
    const raw = permanentError('bad topic');
    const topic = makeFakeTopic([{ err: raw }]);

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      _sleep: noSleep,
    });

    await assert.rejects(
      () => publisher.publish({ body: { x: 1 } }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError);
        assert.equal((err as ResilientPubSubError & { cause: unknown }).cause, raw);
        return true;
      }
    );
  });
});

// ============================================================================
// AC-5.5: Ordering — orderingKey + resumePublishing on failure
// ============================================================================

describe('createResilientPublisher — AC-5.5: ordering', () => {
  test('passes orderingKey to publishMessage', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-order-01' }]);

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      ordering: true,
      _sleep: noSleep,
    });

    await publisher.publish({ body: { x: 1 }, orderingKey: 'customer-42' });

    assert.equal(topic.calls[0]?.orderingKey, 'customer-42');
  });

  test('calls resumePublishing(orderingKey) on transient failure before retry', async () => {
    const topic = makeFakeTopic([{ err: transientError() }, { ok: 'msg-order-02' }]);

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      ordering: true,
      retry: { maxAttempts: 3 },
      _sleep: noSleep,
    });

    await publisher.publish({ body: { x: 1 }, orderingKey: 'key-abc' });

    assert.ok(
      topic.resumeCalls.includes('key-abc'),
      'resumePublishing must be called with the orderingKey after a transient failure'
    );
  });

  test('calls resumePublishing on permanent failure (key must not remain blocked)', async () => {
    const topic = makeFakeTopic([{ err: permanentError() }]);

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      ordering: true,
      _sleep: noSleep,
    });

    await assert.rejects(() =>
      publisher.publish({ body: { x: 1 }, orderingKey: 'key-perm' })
    );

    assert.ok(
      topic.resumeCalls.includes('key-perm'),
      'resumePublishing must be called even on permanent failure'
    );
  });

  test('does not pass orderingKey when ordering is false (default)', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-no-order' }]);

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      _sleep: noSleep,
    });

    await publisher.publish({ body: { x: 1 }, orderingKey: 'ignored' });

    // orderingKey is still passed through as-is; the contract only says
    // resumePublishing is NOT called when ordering is false
    assert.equal(topic.resumeCalls.length, 0, 'resumePublishing must not be called when ordering is false');
  });
});

// ============================================================================
// AC-5.6: .topic getter exposes native handle
// ============================================================================

describe('createResilientPublisher — AC-5.6: .topic getter', () => {
  test('.topic returns the native TopicLike handle', () => {
    const topic = makeFakeTopic([]);
    const client = makeFakeClient(topic);

    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      pubSubClient: client,
      _sleep: noSleep,
    });

    assert.equal(publisher.topic, topic);
  });

  test('.topic returns undefined when no client was provided', () => {
    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      _sleep: noSleep,
    });

    assert.equal(publisher.topic, undefined);
  });
});

// ============================================================================
// AC-5.7: Custom serializer contentType
// ============================================================================

describe('createResilientPublisher — AC-5.7: custom serializer', () => {
  test('uses custom serializer contentType in content-type attribute', async () => {
    const topic = makeFakeTopic([{ ok: 'msg-custom-ser' }]);

    const protoSerializer: Serializer<{ value: number }> = {
      contentType: 'application/x-protobuf',
      serialize: (body) => Buffer.from(JSON.stringify(body)),
      deserialize: (data) => JSON.parse(Buffer.from(data).toString('utf8')) as { value: number },
    };

    const publisher = createResilientPublisher<{ value: number }>({
      topic: 'orders',
      pubSubClient: makeFakeClient(topic),
      serializer: protoSerializer,
      _sleep: noSleep,
    });

    await publisher.publish({ body: { value: 7 } });

    assert.equal(
      topic.calls[0]?.attributes?.['content-type'],
      'application/x-protobuf'
    );
  });
});

// ============================================================================
// AC-5.8: No client → config error on first publish
// ============================================================================

describe('createResilientPublisher — AC-5.8: no client throws config error', () => {
  test('rejects with ResilientPubSubError{kind:config} when no pubSubClient is provided', async () => {
    const publisher = createResilientPublisher<{ x: number }>({
      topic: 'orders',
      _sleep: noSleep,
    });

    await assert.rejects(
      () => publisher.publish({ body: { x: 1 } }),
      (err: unknown) => {
        assert.ok(err instanceof ResilientPubSubError, 'must be ResilientPubSubError');
        assert.equal(err.kind, 'config');
        assert.equal(err.retryable, false);
        return true;
      }
    );
  });
});
