/**
 * Shared structural peer interfaces for resilient-pubsub.
 *
 * These interfaces describe the minimal shape of the `@google-cloud/pubsub`
 * client, topic, subscription, and message objects that publisher and subscriber
 * depend on. Defining them in one place eliminates the drift that existed when
 * each module held its own local copy.
 *
 * **Zero dependencies:** this module imports from nothing. It is a pure type
 * module that defines shapes via structural interfaces only. Keeping it
 * dependency-free preserves the `types → zero deps` layering rule.
 *
 * The real `PubSub`, `Topic`, `Subscription`, and `Message` classes from
 * `@google-cloud/pubsub` satisfy these shapes structurally.
 *
 * @module types/pubsub
 */

// ============================================================================
// Message-level interface
// ============================================================================

/**
 * A received Pub/Sub message that can be acknowledged or negatively
 * acknowledged.
 *
 * The fields mirror those of `InboundPubSubMessage` (from `envelope/envelope`)
 * plus the `ack()` / `nack()` methods from the native `Message` class.
 * They are duplicated here (rather than via `extends`) so that `types/pubsub`
 * has zero imports — preserving the `types → zero deps` layering constraint.
 *
 * The actual `Message` class from `@google-cloud/pubsub` satisfies this shape.
 */
export interface AckableMessage {
  /** The message payload as a Buffer. */
  readonly data: Buffer;
  /** Pub/Sub message attributes (string-to-string map). */
  readonly attributes: Record<string, string>;
  /** The message ID assigned by the service. */
  readonly id: string;
  /** Publication timestamp as an ISO-8601 string (may be undefined). */
  readonly publishTime?: { toISOString?(): string } | string;
  /** Ordering key (empty string when not set). */
  readonly orderingKey?: string;
  /** Delivery attempt count (present only with dead-letter policy). */
  readonly deliveryAttempt?: number;
  /** Acknowledge the message — instructs Pub/Sub not to redeliver it. */
  ack(): void;
  /** Negatively acknowledge the message — instructs Pub/Sub to redeliver it. */
  nack(): void;
}

// ============================================================================
// Topic-side interfaces
// ============================================================================

/**
 * Minimal structural interface for a Pub/Sub topic handle as returned by
 * `PubSub.topic(name, opts)`.
 *
 * The actual `Topic` class from `@google-cloud/pubsub` satisfies this shape.
 */
export interface TopicLike {
  /**
   * Publishes a message and returns the server-assigned message ID.
   *
   * @param message - The message to publish.
   * @returns A promise that resolves to the message ID string.
   */
  publishMessage(message: {
    data: Buffer;
    attributes?: Record<string, string>;
    orderingKey?: string;
  }): Promise<string>;

  /**
   * Resumes ordered publishing for a given ordering key after a publish
   * failure. Required when `enableMessageOrdering` is configured on the topic.
   *
   * @param orderingKey - The key whose publishing should be resumed.
   */
  resumePublishing(orderingKey: string): void;
}

// ============================================================================
// Subscription-side interfaces
// ============================================================================

/**
 * Flow-control options forwarded to the native Pub/Sub subscription.
 *
 * Defined here so that `SubscriberPubSubLike.subscription()` can reference it
 * without creating a cross-module import cycle.
 */
export interface SubscriberFlowControlLike {
  /** Maximum number of messages the client holds in memory at once. */
  maxMessages?: number;
  /** Maximum number of bytes the client holds in memory at once. */
  maxBytes?: number;
}

/**
 * Minimal structural interface for a Pub/Sub subscription handle as returned
 * by `PubSub.subscription(name, opts)`.
 *
 * The actual `Subscription` class from `@google-cloud/pubsub` satisfies this shape.
 */
export interface SubscriptionLike {
  /**
   * Registers a listener for the given event.
   *
   * @param event    - `'message'` for inbound messages, `'error'` for stream errors.
   * @param listener - The callback to invoke.
   */
  on(event: 'message', listener: (msg: AckableMessage) => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;

  /**
   * Removes all listeners, optionally scoped to a specific event.
   *
   * @param event - When provided, removes only listeners for that event.
   */
  removeAllListeners(event?: string): unknown;

  /**
   * Closes the subscription and stops message delivery.
   * Optional because not all subscription handles expose this method.
   */
  close?(): Promise<void>;
}

// ============================================================================
// Client interfaces (publisher-side and subscriber-side)
// ============================================================================

/**
 * Minimal structural interface for the Pub/Sub client used by the **publisher**.
 *
 * Requires only `topic()`. The real `PubSub` class satisfies this shape
 * (it exposes both `topic()` and `subscription()`). Publisher-only apps can
 * pass a client stub that does not implement `subscription()`.
 *
 * @example Shared client (satisfies both PubSubLike and SubscriberPubSubLike)
 * ```ts
 * import { PubSub } from '@google-cloud/pubsub';
 * const client = new PubSub();
 *
 * const publisher  = createResilientPublisher({ topic: 'orders', pubSubClient: client });
 * const subscriber = createResilientSubscriber({ subscription: 'orders-sub', pubSubClient: client });
 * ```
 */
export interface PubSubLike {
  /**
   * Returns a `Topic` handle for the given topic name.
   *
   * @param name - The fully-qualified or short topic name.
   * @param opts - Optional publisher options passed through to the native client.
   * @returns A `TopicLike` handle for publishing.
   */
  topic(name: string, opts?: Record<string, unknown>): TopicLike;
}

/**
 * Minimal structural interface for the Pub/Sub client used by the **subscriber**.
 *
 * Requires only `subscription()`. The real `PubSub` class satisfies this shape.
 * Subscriber-only apps can pass a client stub that does not implement `topic()`.
 *
 * This is intentionally a distinct interface (not a deprecated alias) so that
 * test code that builds stubs with only `subscription()` continues to compile.
 * The real `PubSub` client satisfies both `PubSubLike` and `SubscriberPubSubLike`.
 */
export interface SubscriberPubSubLike {
  /**
   * Returns a `Subscription` handle for the given subscription name.
   *
   * @param name    - The fully-qualified or short subscription name.
   * @param options - Optional subscriber options passed through to the native client.
   * @returns A `SubscriptionLike` handle for consuming messages.
   */
  subscription(name: string, options?: { flowControl?: SubscriberFlowControlLike }): SubscriptionLike;
}
