/**
 * resilient-pubsub/publisher
 *
 * Resilient message publishing for Google Cloud Pub/Sub.
 *
 * Provides {@link createResilientPublisher} — a factory that wraps a Pub/Sub
 * topic with retry (backoff + jitter), ordering-aware semantics, pluggable
 * serialization, and allowlist-gated context propagation.
 *
 * Sub-module import (tree-shakeable):
 * ```ts
 * import { createResilientPublisher } from 'resilient-pubsub/publisher';
 * ```
 *
 * @module publisher
 */

export {
  createResilientPublisher,
} from './publisher';

export type {
  PublisherOptions,
  PublisherRetryOptions,
  PublisherHooks,
  PublishInput,
  PublishResult,
  ResilientPublisher,
  PubSubLike,
  TopicLike,
} from './publisher';
