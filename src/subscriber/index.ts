/**
 * resilient-pubsub/subscriber
 *
 * Resilient message consumption for Google Cloud Pub/Sub.
 *
 * Provides `createResilientSubscriber<T>` which wraps a Pub/Sub subscription
 * with correct ack/nack lifecycle management, allowlist-gated context
 * propagation, pluggable deserialization, poison-message classification, and
 * graceful drain-and-stop semantics.
 *
 * **Zero-config:** when no `pubSubClient` is supplied, `start()` triggers an
 * async bootstrap that lazily resolves a default client from the standard GCP
 * environment. Bootstrap errors surface through the `onError` hook.
 *
 * @module subscriber
 */

export { createResilientSubscriber } from './subscriber';

export type {
  // Structural peer types (re-exported from src/types/pubsub via subscriber.ts)
  AckableMessage,
  SubscriptionLike,
  // SubscriberPubSubLike is the subscriber-side client interface (subscription() only).
  // Use PubSubLike from resilient-pubsub/publisher for the full client interface.
  SubscriberPubSubLike,
  // Subscriber-specific types
  SubscriberFlowControl,
  SubscriberHooks,
  SubscriberOptions,
  SubscriberMessage,
  MessageHandler,
  ResilientSubscriber,
} from './subscriber';
