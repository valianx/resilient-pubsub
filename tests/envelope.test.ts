/**
 * Tests for PR-1: Envelope<T>, Serializer<T>, and JsonSerializer.
 *
 * Covers acceptance criteria AC-1.1 through AC-1.4:
 * - AC-1.1: meta is read-only and NOT serialized on outbound envelopes.
 * - AC-1.2: JsonSerializer round-trip preserves the body; contentType === 'application/json'.
 * - AC-1.3: A custom serializer's contentType is respected.
 * - AC-1.4: Deserializing invalid data throws a serialization/poison-classified error
 *            that does NOT contain the raw payload bytes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Envelope } from '../src/envelope/envelope.ts';
import { JsonSerializer, SerializationError } from '../src/envelope/serializer.ts';
import type { Serializer } from '../src/envelope/serializer.ts';
import type { Attributes, EnvelopeMeta } from '../src/types/index.ts';

// ============================================================================
// AC-1.1: Envelope<T> — meta is read-only and not serialized on outbound
// ============================================================================

describe('Envelope.outbound', () => {
  test('outbound envelope has body and attributes but no meta', () => {
    const body = { orderId: '123', amount: 99 };
    const attrs: Attributes = { 'idempotency-key': 'abc' };

    const env = Envelope.outbound(body, attrs);

    assert.deepEqual(env.body, body);
    assert.deepEqual(env.attributes, attrs);
    assert.equal(env.meta, undefined);
  });

  test('outbound envelope with no attributes defaults to empty object', () => {
    const env = Envelope.outbound({ value: 1 });

    assert.deepEqual(env.attributes, {});
    assert.equal(env.meta, undefined);
  });

  test('outbound envelope attributes are frozen (read-only)', () => {
    const env = Envelope.outbound({ x: 1 }, { key: 'val' });

    assert.throws(() => {
      // Attempting to mutate the frozen attributes object must throw in strict mode.
      (env.attributes as Record<string, string>)['injected'] = 'evil';
    }, TypeError);
  });
});

describe('Envelope.inbound', () => {
  test('inbound envelope exposes body, attributes, and frozen meta', () => {
    const body = { userId: '42' };
    const attrs: Attributes = { 'content-type': 'application/json' };
    const meta: EnvelopeMeta = {
      messageId: 'msg-1',
      publishTime: '2026-05-31T00:00:00.000Z',
      orderingKey: 'user-42',
      deliveryAttempt: 1,
    };

    const env = Envelope.inbound(body, attrs, meta);

    assert.deepEqual(env.body, body);
    assert.deepEqual(env.attributes, attrs);
    assert.deepEqual(env.meta, meta);
  });

  test('inbound envelope meta is frozen (read-only)', () => {
    const meta: EnvelopeMeta = { messageId: 'msg-2' };
    const env = Envelope.inbound({ v: 1 }, {}, meta);

    assert.throws(() => {
      // Attempting to mutate the frozen meta must throw in strict mode.
      (env.meta as Record<string, unknown>)['messageId'] = 'tampered';
    }, TypeError);
  });

  test('inbound envelope meta fields match the source', () => {
    const meta: EnvelopeMeta = {
      messageId: 'abc123',
      publishTime: '2026-01-01T00:00:00.000Z',
      orderingKey: 'order-key',
      deliveryAttempt: 3,
    };

    const env = Envelope.inbound({ data: true }, {}, meta);

    assert.equal(env.meta?.messageId, 'abc123');
    assert.equal(env.meta?.publishTime, '2026-01-01T00:00:00.000Z');
    assert.equal(env.meta?.orderingKey, 'order-key');
    assert.equal(env.meta?.deliveryAttempt, 3);
  });
});

describe('Envelope.extractMeta', () => {
  test('extracts meta from a Pub/Sub message with toISOString publishTime', () => {
    const message = {
      data: Buffer.from('{}'),
      attributes: {},
      id: 'msg-xyz',
      publishTime: { toISOString: () => '2026-05-31T12:00:00.000Z' },
      orderingKey: 'key-1',
      deliveryAttempt: 2,
    };

    const meta = Envelope.extractMeta(message);

    assert.equal(meta.messageId, 'msg-xyz');
    assert.equal(meta.publishTime, '2026-05-31T12:00:00.000Z');
    assert.equal(meta.orderingKey, 'key-1');
    assert.equal(meta.deliveryAttempt, 2);
  });

  test('extracts meta from a message with string publishTime', () => {
    const message = {
      data: Buffer.from('{}'),
      attributes: {},
      id: 'msg-str',
      publishTime: '2026-05-31T00:00:00.000Z',
    };

    const meta = Envelope.extractMeta(message);

    assert.equal(meta.publishTime, '2026-05-31T00:00:00.000Z');
    assert.equal(meta.orderingKey, undefined);
    assert.equal(meta.deliveryAttempt, undefined);
  });

  test('extracts meta with undefined publishTime when field is absent', () => {
    const message = {
      data: Buffer.from('{}'),
      attributes: {},
      id: 'msg-no-ts',
    };

    const meta = Envelope.extractMeta(message);

    assert.equal(meta.publishTime, undefined);
  });
});

// ============================================================================
// AC-1.2: JsonSerializer round-trip preserves body; contentType = application/json
// ============================================================================

describe('JsonSerializer', () => {
  test('contentType is application/json', () => {
    const s = new JsonSerializer();
    assert.equal(s.contentType, 'application/json');
  });

  test('round-trip preserves a simple object body', () => {
    const s = new JsonSerializer<{ userId: string; count: number }>();
    const body = { userId: 'u-1', count: 42 };

    const bytes = s.serialize(body);
    const result = s.deserialize(bytes);

    assert.deepEqual(result, body);
  });

  test('round-trip preserves a nested object', () => {
    const s = new JsonSerializer<{ a: { b: { c: number } } }>();
    const body = { a: { b: { c: 99 } } };

    assert.deepEqual(s.deserialize(s.serialize(body)), body);
  });

  test('round-trip preserves an array body', () => {
    const s = new JsonSerializer<number[]>();
    const body = [1, 2, 3];

    assert.deepEqual(s.deserialize(s.serialize(body)), body);
  });

  test('serialize returns a Uint8Array', () => {
    const s = new JsonSerializer<string>();
    const bytes = s.serialize('hello');

    assert.ok(bytes instanceof Uint8Array);
  });

  // AC-1.1 enforcement: meta is NOT included when serializing an outbound envelope body
  test('serializing envelope body does not include meta fields', () => {
    const s = new JsonSerializer<{ value: number }>();
    const env = Envelope.outbound({ value: 7 }, {});

    // Serialize only the body (as the publisher would do)
    const bytes = s.serialize(env.body);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));

    // meta must not appear in the serialized body
    assert.equal(parsed.messageId, undefined);
    assert.equal(parsed.publishTime, undefined);
    assert.equal(parsed.meta, undefined);
  });
});

// ============================================================================
// AC-1.3: Custom serializer's contentType is respected
// ============================================================================

describe('Custom Serializer', () => {
  test('a custom serializer with a non-JSON contentType is used as-is', () => {
    const customSerializer: Serializer<string> = {
      contentType: 'application/x-custom',
      serialize: (body: string) => new TextEncoder().encode(`CUSTOM:${body}`),
      deserialize: (data: Uint8Array): string => {
        const text = new TextDecoder().decode(data);
        if (!text.startsWith('CUSTOM:')) {
          throw new SerializationError('Not a CUSTOM-encoded payload');
        }
        return text.slice('CUSTOM:'.length);
      },
    };

    assert.equal(customSerializer.contentType, 'application/x-custom');

    const bytes = customSerializer.serialize('hello');
    assert.equal(customSerializer.deserialize(bytes), 'hello');
  });

  test('contentType from a custom serializer is preserved independently of JsonSerializer', () => {
    const json = new JsonSerializer<unknown>();
    const custom: Serializer<unknown> = {
      contentType: 'application/x-msgpack',
      serialize: () => new Uint8Array([0x81]),
      deserialize: () => ({ ok: true }),
    };

    assert.notEqual(json.contentType, custom.contentType);
    assert.equal(custom.contentType, 'application/x-msgpack');
  });
});

// ============================================================================
// AC-1.4: Deserializing invalid data throws a serialization/poison error
//          that does NOT contain the raw payload bytes
// ============================================================================

describe('SerializationError on invalid input', () => {
  test('deserializing non-JSON bytes throws SerializationError', () => {
    const s = new JsonSerializer<unknown>();
    const invalidBytes = new TextEncoder().encode('this is { not json');

    assert.throws(
      () => s.deserialize(invalidBytes),
      (err: unknown) => {
        assert.ok(err instanceof SerializationError, 'expected SerializationError');
        return true;
      }
    );
  });

  test('thrown error has kind === serialization', () => {
    const s = new JsonSerializer<unknown>();

    try {
      s.deserialize(new TextEncoder().encode('<<<bad>>>'));
      assert.fail('expected SerializationError to be thrown');
    } catch (err) {
      assert.ok(err instanceof SerializationError);
      assert.equal(err.kind, 'serialization');
    }
  });

  test('thrown error has classification === poison', () => {
    const s = new JsonSerializer<unknown>();

    try {
      s.deserialize(new TextEncoder().encode('not-json'));
      assert.fail('expected SerializationError to be thrown');
    } catch (err) {
      assert.ok(err instanceof SerializationError);
      assert.equal(err.classification, 'poison');
    }
  });

  test('thrown error has retryable === false', () => {
    const s = new JsonSerializer<unknown>();

    try {
      s.deserialize(new TextEncoder().encode('bad'));
      assert.fail('expected SerializationError to be thrown');
    } catch (err) {
      assert.ok(err instanceof SerializationError);
      assert.equal(err.retryable, false);
    }
  });

  test('error message does NOT contain raw payload bytes', () => {
    const s = new JsonSerializer<unknown>();
    const rawPayload = '<<SENSITIVE_PAYLOAD_BYTES_12345>>';
    const invalidBytes = new TextEncoder().encode(rawPayload);

    try {
      s.deserialize(invalidBytes);
      assert.fail('expected SerializationError to be thrown');
    } catch (err) {
      assert.ok(err instanceof SerializationError);
      // The raw payload must not appear in the error message
      assert.ok(
        !err.message.includes(rawPayload),
        `Error message must not contain raw payload bytes. Got: "${err.message}"`
      );
    }
  });

  test('SerializationError is an instance of Error', () => {
    const err = new SerializationError('test error');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'SerializationError');
  });

  test('deserializing empty Uint8Array throws SerializationError', () => {
    const s = new JsonSerializer<unknown>();

    assert.throws(
      () => s.deserialize(new Uint8Array(0)),
      SerializationError
    );
  });
});
