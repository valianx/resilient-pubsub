/**
 * resilient-pubsub/errors
 *
 * Error types and classification for resilient Pub/Sub operations.
 *
 * Future exports:
 * - ResilientPubSubError: canonical error class with kind, code, and retryability
 * - isResilientPubSubError(err): type guard
 * - ErrorKind: 'publish' | 'subscribe' | 'ack' | 'network' | 'setup'
 * - classifyError(err): ErrorKind — maps raw Pub/Sub errors to known kinds
 *
 * @module errors
 */

/**
 * Placeholder export — implementation lands in a future PR.
 *
 * @internal
 */
export const _errorsVersion = '0.0.0' as const;
