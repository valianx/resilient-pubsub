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
 * @module subscriber
 */

export {
  createResilientSubscriber,
} from './subscriber';

export type {
  AckableMessage,
  SubscriptionLike,
  SubscriberPubSubLike,
  SubscriberFlowControl,
  SubscriberHooks,
  SubscriberOptions,
  SubscriberMessage,
  MessageHandler,
  ResilientSubscriber,
} from './subscriber';
