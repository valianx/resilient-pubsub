/**
 * 03-message-envelope.ts
 *
 * Tools: Envelope<T>, JsonSerializer<T>, Serializer<T> — REAL implemented API.
 *
 * Contract:
 *   Envelope<T> wraps a typed message body with its Pub/Sub attributes and
 *   optional inbound metadata:
 *
 *   - Outbound (publish side): Envelope.outbound(body, attributes)
 *     → meta is always undefined; it is NOT serialized on publish.
 *   - Inbound (consume side):  Envelope.inbound(body, attributes, meta)
 *     → meta is frozen and read-only.
 *   - Envelope.extractMeta(pubSubMessage) converts the raw Pub/Sub message
 *     shape into the typed EnvelopeMeta interface.
 *
 *   Serializer<T> is the pluggable interface:
 *     - contentType: string  — MIME type stored in 'content-type' attribute.
 *     - serialize(body: T): Uint8Array
 *     - deserialize(data: Uint8Array): T  — throws SerializationError on failure.
 *
 *   JsonSerializer<T> is the default implementation (application/json, UTF-8).
 */

import { Envelope, JsonSerializer } from 'resilient-pubsub/envelope';
import type { Serializer } from 'resilient-pubsub/envelope';
import { SerializationError } from 'resilient-pubsub/errors';

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

interface OrderCreated {
  orderId: string;
  totalCents: number;
}

// ---------------------------------------------------------------------------
// Example A: outbound envelope (publish side).
// ---------------------------------------------------------------------------

/**
 * Creates an outbound envelope that a publisher would build before sending.
 * meta is undefined — Pub/Sub sets messageId / publishTime server-side.
 */
export function example3a(): void {
  const body: OrderCreated = { orderId: '42', totalCents: 9999 };
  const attributes = {
    'content-type': 'application/json',
    'schema-version': '1',
    'traceparent': '00-abc123-01',
    'x-tenant-id': 'acme',
  };

  const env = Envelope.outbound(body, attributes);

  console.log(env.body.orderId);    // '42'
  console.log(env.body.totalCents); // 9999
  console.log(env.attributes['content-type']); // 'application/json'
  console.log(env.meta);            // undefined — inbound-only field

  // attributes is frozen — mutations are silently ignored (strict mode: throws)
  // env.attributes['x-new'] = 'value'; // TypeError in strict mode
}

// ---------------------------------------------------------------------------
// Example B: inbound envelope (consume side).
// ---------------------------------------------------------------------------

/**
 * Creates an inbound envelope that the subscriber lifecycle would build after
 * receiving and deserializing a Pub/Sub message.
 */
export function example3b(): void {
  const body: OrderCreated = { orderId: '42', totalCents: 9999 };
  const attributes = { 'traceparent': '00-abc123-01', 'x-tenant-id': 'acme' };
  const meta = {
    messageId: 'msg-123',
    publishTime: '2025-01-15T10:30:00.000Z',
    orderingKey: 'acme',
    deliveryAttempt: 1,
  };

  const env = Envelope.inbound(body, attributes, meta);

  console.log(env.body.orderId);          // '42'
  console.log(env.meta?.messageId);       // 'msg-123'
  console.log(env.meta?.publishTime);     // '2025-01-15T10:30:00.000Z'
  console.log(env.meta?.deliveryAttempt); // 1
  console.log(env.meta?.orderingKey);     // 'acme'
}

// ---------------------------------------------------------------------------
// Example C: JsonSerializer round-trip.
// ---------------------------------------------------------------------------

/**
 * JsonSerializer is the default serializer for Pub/Sub message bodies.
 * Uses JSON.stringify / JSON.parse with UTF-8 encoding.
 */
export function example3c(): void {
  const serializer = new JsonSerializer<OrderCreated>();

  console.log(serializer.contentType); // 'application/json'

  const original: OrderCreated = { orderId: '99', totalCents: 4999 };

  // Serialize to bytes
  const bytes = serializer.serialize(original);
  console.log(bytes instanceof Uint8Array); // true

  // Deserialize back to typed body
  const restored = serializer.deserialize(bytes);
  console.log(restored.orderId);    // '99'
  console.log(restored.totalCents); // 4999

  // Deserialization failure → SerializationError (kind='serialization', classification='poison')
  try {
    serializer.deserialize(new Uint8Array([0xff, 0xfe])); // invalid UTF-8
  } catch (err) {
    if (err instanceof SerializationError) {
      console.log(err.kind);           // 'serialization'
      console.log(err.classification); // 'poison'
      console.log(err.retryable);      // false — a poison message must never retry
    }
  }
}

// ---------------------------------------------------------------------------
// Example D: custom Serializer (e.g., Protocol Buffers or MessagePack).
// ---------------------------------------------------------------------------

/**
 * Implement the Serializer<T> interface to plug in a custom encoding.
 * The contentType is stored in the 'content-type' Pub/Sub attribute so
 * consumers can select the right deserializer without out-of-band coordination.
 */

// Minimal stand-in for a protobuf-style encoder — replace with a real codec.
const protoEncoder = {
  encode: (body: OrderCreated): Buffer => Buffer.from(JSON.stringify(body)),
  decode: (data: Uint8Array): OrderCreated => JSON.parse(Buffer.from(data).toString('utf8')) as OrderCreated,
};

const protobufSerializer: Serializer<OrderCreated> = {
  contentType: 'application/x-protobuf',

  serialize(body: OrderCreated): Uint8Array {
    return protoEncoder.encode(body);
  },

  deserialize(data: Uint8Array): OrderCreated {
    try {
      return protoEncoder.decode(data);
    } catch (cause) {
      // Wrap in SerializationError so the subscriber lifecycle can classify
      // this as poison and route to the dead-letter topic rather than looping.
      throw new SerializationError(
        'Failed to decode message as OrderCreated protobuf: invalid wire format',
        cause
      );
    }
  },
};

export function example3d(): void {
  const bytes = protobufSerializer.serialize({ orderId: '55', totalCents: 2499 });
  const body = protobufSerializer.deserialize(bytes);
  console.log(body.orderId);    // '55'
  console.log(body.totalCents); // 2499
}
