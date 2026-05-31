/**
 * Typed message envelope for resilient-pubsub.
 *
 * An Envelope wraps a typed message body with its Pub/Sub attributes and
 * optional runtime metadata. The design enforces a strict inbound/outbound
 * split:
 *
 * - **Outbound** (publish side): body + attributes only. `meta` is absent and
 *   is never included in the serialized wire format — Pub/Sub populates it
 *   server-side.
 * - **Inbound** (consume side): body + attributes + frozen `meta` populated
 *   from the received Pub/Sub message.
 *
 * @module envelope
 */

import type { Attributes, EnvelopeMeta } from '../types/index';

// ============================================================================
// Minimal inbound message shape (decoupled from @google-cloud/pubsub)
// ============================================================================

/**
 * Structural interface for an inbound Pub/Sub message as delivered by the
 * @google-cloud/pubsub client. Defined locally so that the envelope core has
 * zero runtime imports from the peer dependency.
 *
 * The actual `Message` class from @google-cloud/pubsub satisfies this shape.
 *
 * @internal
 */
export interface InboundPubSubMessage {
  /** The message payload as a Buffer. */
  readonly data: Buffer;
  /** Pub/Sub message attributes (string-to-string map). */
  readonly attributes: Record<string, string>;
  /** The message ID assigned by the service. */
  readonly id: string;
  /** Publication timestamp as an ISO-8601 string (may be undefined). */
  readonly publishTime?: { toISOString?(): string } | string;
  /** Ordering key (empty string when not set). */
  readonly orderingKey?: string;
  /** Delivery attempt count (present only with dead-letter policy). */
  readonly deliveryAttempt?: number;
}

// ============================================================================
// Envelope<T>
// ============================================================================

/**
 * A typed message envelope wrapping a Pub/Sub payload.
 *
 * @typeParam T - The type of the message body after deserialization.
 *
 * @example Outbound envelope (publish)
 * ```ts
 * const env = Envelope.outbound({ userId: '42' }, { 'idempotency-key': 'abc' });
 * // env.meta === undefined — not serialized on publish
 * ```
 *
 * @example Inbound envelope (consume)
 * ```ts
 * const env = Envelope.inbound(body, message.attributes, {
 *   messageId: message.id,
 *   publishTime: message.publishTime,
 *   orderingKey: message.orderingKey,
 *   deliveryAttempt: message.deliveryAttempt,
 * });
 * // env.meta is frozen and read-only
 * ```
 */
export class Envelope<T> {
  /** The deserialized message body. */
  public readonly body: T;

  /** Pub/Sub message attributes (string-to-string map). */
  public readonly attributes: Readonly<Attributes>;

  /**
   * Runtime metadata from Pub/Sub, populated only on the inbound (consume)
   * side. Always `undefined` on outbound envelopes — it is NOT serialized
   * when publishing.
   */
  public readonly meta: Readonly<EnvelopeMeta> | undefined;

  private constructor(body: T, attributes: Attributes, meta?: EnvelopeMeta) {
    this.body = body;
    this.attributes = Object.freeze({ ...attributes });
    this.meta = meta !== undefined ? Object.freeze({ ...meta }) : undefined;
  }

  /**
   * Creates an outbound envelope (publish side).
   *
   * The resulting envelope has no `meta` field. The serializer will encode
   * only `body` and `attributes` — Pub/Sub populates messageId / publishTime
   * server-side after delivery.
   *
   * @param body - The typed message payload.
   * @param attributes - Pub/Sub message attributes (string-to-string).
   * @returns A new outbound Envelope instance.
   */
  public static outbound<T>(body: T, attributes: Attributes = {}): Envelope<T> {
    return new Envelope(body, attributes, undefined);
  }

  /**
   * Creates an inbound envelope (consume side) from a deserialized body and
   * the metadata extracted from a received Pub/Sub message.
   *
   * The `meta` field is frozen at construction time to prevent accidental
   * mutation inside handlers.
   *
   * @param body - The deserialized message payload.
   * @param attributes - Pub/Sub message attributes from the received message.
   * @param meta - Runtime metadata extracted from the Pub/Sub message.
   * @returns A new inbound Envelope instance with frozen meta.
   */
  public static inbound<T>(
    body: T,
    attributes: Attributes,
    meta: EnvelopeMeta
  ): Envelope<T> {
    return new Envelope(body, attributes, meta);
  }

  /**
   * Extracts `EnvelopeMeta` from a received Pub/Sub message.
   *
   * This helper converts the raw Pub/Sub message shape into the typed
   * `EnvelopeMeta` interface so callers do not need to handle the conversion
   * themselves.
   *
   * @param message - An inbound Pub/Sub message satisfying InboundPubSubMessage.
   * @returns The extracted EnvelopeMeta.
   */
  public static extractMeta(message: InboundPubSubMessage): EnvelopeMeta {
    const publishTime = resolvePublishTime(message.publishTime);

    return {
      messageId: message.id,
      publishTime,
      orderingKey: message.orderingKey || undefined,
      deliveryAttempt: message.deliveryAttempt,
    };
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Normalizes the publishTime field from the Pub/Sub message to an ISO-8601
 * string. The field may be an object with a `toISOString()` method (Timestamp
 * from protobuf) or already a string.
 *
 * @internal
 */
function resolvePublishTime(
  raw: InboundPubSubMessage['publishTime']
): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw.toISOString === 'function') {
    return raw.toISOString();
  }
  return undefined;
}
