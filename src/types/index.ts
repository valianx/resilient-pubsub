/**
 * Core public type definitions for resilient-pubsub.
 *
 * Types defined here are cross-module and shared across envelope, publisher,
 * subscriber, and error modules. Module-specific types may live
 * in their own files and be re-exported from here for convenience.
 *
 * @module types
 */

// ============================================================================
// Attribute types
// ============================================================================

/**
 * Pub/Sub message attributes: a flat string-to-string map.
 *
 * The Google Cloud Pub/Sub API requires all attribute values to be strings.
 * Callers are responsible for encoding non-string values (e.g., numbers,
 * booleans) before placing them in attributes.
 */
export type Attributes = Record<string, string>;

// ============================================================================
// Envelope metadata (inbound / runtime-only)
// ============================================================================

/**
 * Runtime metadata populated by Pub/Sub on message delivery.
 *
 * This metadata is present only on the **inbound** (consume) side. It is NOT
 * serialized when publishing — the fields are populated by the Pub/Sub
 * service itself and are read-only from the consumer's perspective.
 *
 * All fields are optional because not all delivery modes populate all fields
 * (e.g., `deliveryAttempt` is only present when a dead-letter policy is
 * configured on the subscription).
 */
export interface EnvelopeMeta {
  /**
   * The message ID assigned by the Pub/Sub service.
   * Unique within the topic at the time of publication.
   */
  readonly messageId?: string;

  /**
   * The time at which the message was published, as an ISO-8601 string.
   * Set by the Pub/Sub service; not controlled by the publisher.
   */
  readonly publishTime?: string;

  /**
   * The ordering key used to guarantee ordered delivery within a key group.
   * Present only when the message was published with an ordering key and the
   * subscription has `enableMessageOrdering` enabled.
   */
  readonly orderingKey?: string;

  /**
   * The number of delivery attempts for this message.
   * Only populated when a dead-letter policy is configured on the subscription.
   * Corresponds to the `delivery_attempt` attribute set by Pub/Sub.
   */
  readonly deliveryAttempt?: number;
}
