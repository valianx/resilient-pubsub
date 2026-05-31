/**
 * resilient-pubsub
 *
 * A transparent, framework-agnostic resilience layer around @google-cloud/pubsub.
 * Provides idempotency, structured envelopes, retries with backoff/jitter,
 * and native dead-letter support for Google Cloud Pub/Sub.
 *
 * Sub-module imports (tree-shakeable):
 * - `resilient-pubsub/publisher`    — resilient message publishing
 * - `resilient-pubsub/subscriber`   — resilient message consumption
 * - `resilient-pubsub/idempotency`  — idempotency store abstractions
 * - `resilient-pubsub/idempotency/redis` — Redis-backed idempotency store
 * - `resilient-pubsub/core`         — backoff/jitter primitives
 * - `resilient-pubsub/envelope`     — structured message envelope codec
 * - `resilient-pubsub/errors`       — error types and classification
 *
 * @packageDocumentation
 */

// ============================================================================
// Re-export public surface from sub-modules
// ============================================================================

export * from './publisher/index';
export * from './subscriber/index';
export * from './idempotency/index';
export * from './core/index';
export * from './envelope/index';
export * from './errors/index';
