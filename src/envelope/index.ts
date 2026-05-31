/**
 * resilient-pubsub/envelope
 *
 * Typed message envelope and pluggable serializer for Pub/Sub payloads.
 *
 * Exports:
 * - {@link Envelope} — typed message wrapper (outbound + inbound factories)
 * - {@link Serializer} — pluggable serializer interface
 * - {@link JsonSerializer} — default JSON serializer (application/json)
 * - {@link SerializationError} — poison error for undecodable payloads
 * - {@link InboundPubSubMessage} — structural interface for received messages
 *
 * Type re-exports (from types module):
 * - {@link Attributes} — string-to-string attribute map
 * - {@link EnvelopeMeta} — inbound runtime metadata (messageId, publishTime, …)
 *
 * @module envelope
 */

export { Envelope } from './envelope';
export type { InboundPubSubMessage } from './envelope';
export { JsonSerializer, SerializationError } from './serializer';
export type { Serializer } from './serializer';

// Re-export shared types for convenience — consumers can import from
// 'resilient-pubsub/envelope' without reaching into the types sub-module.
export type { Attributes, EnvelopeMeta } from '../types/index';
