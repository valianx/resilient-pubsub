/**
 * resilient-pubsub/publisher
 *
 * Resilient message publishing for Google Cloud Pub/Sub.
 *
 * Provides {@link createResilientPublisher} — a factory that wraps a Pub/Sub
 * topic with retry (backoff + jitter), ordering-aware semantics, pluggable
 * serialization, and allowlist-gated context propagation.
 *
 * **Zero-config:** when no `pubSubClient` is supplied, a default client is
 * resolved lazily on the first `publish()` call from the standard GCP
 * environment (`GOOGLE_CLOUD_PROJECT` / ADC).
 *
 * Sub-module import (tree-shakeable):
 * ```ts
 * import { createResilientPublisher } from 'resilient-pubsub/publisher';
 * ```
 *
 * @module publisher
 */

export { createResilientPublisher } from './publisher';

export type {
  PublisherOptions,
  PublisherRetryOptions,
  PublisherHooks,
  PublishInput,
  PublishResult,
  ResilientPublisher,
  // Structural peer types (re-exported from src/types/pubsub via publisher.ts)
  PubSubLike,
  TopicLike,
} from './publisher';
