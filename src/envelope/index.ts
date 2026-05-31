/**
 * resilient-pubsub/envelope
 *
 * Structured message envelope codec for Pub/Sub payloads.
 *
 * Future exports:
 * - encode(payload, metadata): Buffer — serializes a typed envelope to bytes
 * - decode(buffer): Envelope<unknown> — deserializes bytes back to a typed envelope
 * - Envelope<T>: typed wrapper with id, version, timestamp, source, and data
 * - EnvelopeOptions: codec configuration (serialization format, schema version)
 *
 * @module envelope
 */

/**
 * Placeholder export — implementation lands in a future PR.
 *
 * @internal
 */
export const _envelopeVersion = '0.0.0' as const;
