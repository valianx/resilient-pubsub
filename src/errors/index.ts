/**
 * resilient-pubsub/errors
 *
 * Canonical error surface for all resilient-pubsub operations.
 *
 * **Exports:**
 * - {@link ResilientPubSubError} — structured base error class.
 * - {@link SerializationError} — poison subclass for undecodable payloads.
 * - {@link isResilientPubSubError} — cross-realm type guard.
 * - {@link ErrorKind} — discriminant union (`'publish' | 'subscribe' | ...`).
 * - Redaction utilities: {@link redactSecrets}, {@link redactHeaders}, {@link capMessage}.
 *
 * @module errors
 */

export {
  ResilientPubSubError,
  SerializationError,
  isResilientPubSubError,
} from './error';

export type { ErrorKind, Classification, ResilientPubSubErrorOptions } from './error';

// Redaction helpers are part of the public errors surface so that consumers
// can apply the same sanitization rules to their own log messages.
export { redactSecrets, redactHeaders, capMessage } from '../utils/redact';
