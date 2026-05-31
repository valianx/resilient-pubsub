/**
 * Pluggable serializer interface and default JSON implementation for
 * resilient-pubsub envelope payloads.
 *
 * The serializer is responsible for converting a typed message body to/from
 * bytes suitable for Pub/Sub transmission. The `contentType` field is stored
 * in message attributes (`content-type`) so consumers know how to decode the
 * payload without out-of-band coordination.
 *
 * @module envelope/serializer
 */

// ============================================================================
// SerializationError — re-exported from errors module
// ============================================================================

/**
 * Re-export `SerializationError` from `src/errors/error` so that existing
 * import paths (`from 'resilient-pubsub/envelope'` or
 * `from '../src/envelope/serializer.ts'`) continue to resolve without change.
 *
 * The class is now a proper `ResilientPubSubError` subclass (reconciled from
 * the provisional placeholder defined here in PR-1). The marker comment
 * PROVISIONAL_SERIALIZATION_ERROR is no longer applicable — this export is now
 * stable and canonical.
 *
 * Layering note: `envelope` importing from `errors` is permitted by the
 * dependency graph (`envelope → errors → core/classify + utils`). The inverse
 * direction (`errors → envelope`) is forbidden and does not occur here.
 */
export { SerializationError } from '../errors/error';

// ============================================================================
// Serializer<T> interface
// ============================================================================

/**
 * Pluggable serializer contract for Pub/Sub message bodies.
 *
 * Implement this interface to support custom serialization formats (e.g.,
 * Protocol Buffers, Avro, MessagePack). Inject the serializer into the
 * publisher and subscriber options.
 *
 * @typeParam T - The type of the message body this serializer handles.
 *
 * @example Custom serializer
 * ```ts
 * const protobufSerializer: Serializer<MyMessage> = {
 *   contentType: 'application/x-protobuf',
 *   serialize: (body) => MyMessage.encode(body).finish(),
 *   deserialize: (data) => MyMessage.decode(data),
 * };
 * ```
 */
export interface Serializer<T> {
  /**
   * MIME content type produced by this serializer.
   *
   * Stored in the `content-type` Pub/Sub attribute so that consumers can
   * select the correct deserializer without out-of-band coordination.
   *
   * @example 'application/json', 'application/x-protobuf'
   */
  readonly contentType: string;

  /**
   * Encodes a typed message body into bytes for Pub/Sub transmission.
   *
   * @param body - The typed message payload to encode.
   * @returns The encoded payload as a Uint8Array (or Buffer, which extends it).
   * @throws Any error if the body cannot be encoded.
   */
  serialize(body: T): Uint8Array;

  /**
   * Decodes bytes received from Pub/Sub back into a typed message body.
   *
   * @param data - The raw bytes from the Pub/Sub message.
   * @returns The decoded typed message payload.
   * @throws {SerializationError} When the bytes cannot be decoded or parsed.
   *   The thrown error MUST NOT contain the raw payload bytes.
   */
  deserialize(data: Uint8Array): T;
}

// ============================================================================
// JsonSerializer<T>
// ============================================================================

import { SerializationError } from '../errors/error';

/**
 * Default JSON serializer for Pub/Sub message bodies.
 *
 * Uses `JSON.stringify` / `JSON.parse` for encoding. The body is encoded as
 * UTF-8 JSON bytes. Round-trip fidelity is subject to standard JSON
 * limitations (no `undefined`, `BigInt`, `Date` as date objects, etc.).
 *
 * @typeParam T - The type of the message body. Must be JSON-serializable.
 *
 * @example
 * ```ts
 * const serializer = new JsonSerializer<{ userId: string }>();
 * const bytes = serializer.serialize({ userId: '42' });
 * const body = serializer.deserialize(bytes);
 * // body.userId === '42'
 * ```
 */
export class JsonSerializer<T> implements Serializer<T> {
  /** Always 'application/json'. */
  public readonly contentType = 'application/json' as const;

  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  /**
   * Serializes a typed body to UTF-8 JSON bytes.
   *
   * @param body - The message payload to encode.
   * @returns UTF-8 encoded JSON bytes as a Uint8Array.
   * @throws {TypeError} If `body` contains non-JSON-serializable values.
   */
  public serialize(body: T): Uint8Array {
    return this.encoder.encode(JSON.stringify(body));
  }

  /**
   * Deserializes UTF-8 JSON bytes back into a typed body.
   *
   * @param data - Raw bytes from the Pub/Sub message.
   * @returns The parsed message payload.
   * @throws {SerializationError} If the bytes are not valid UTF-8 JSON.
   *   The error message does not include the raw payload bytes.
   */
  public deserialize(data: Uint8Array): T {
    let text: string;
    try {
      text = this.decoder.decode(data);
    } catch (cause) {
      throw new SerializationError(
        'Failed to decode message payload as UTF-8: bytes are malformed',
        cause
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      // Intentionally omit `text` from the message to avoid leaking payload bytes in logs.
      throw new SerializationError(
        'Failed to parse message payload as JSON: invalid JSON structure',
        cause
      );
    }
  }
}
