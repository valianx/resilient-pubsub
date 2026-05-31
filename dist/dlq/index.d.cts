import { E as EnvelopeMeta } from '../index-BCwaxBg3.cjs';

/**
 * Native dead-letter support for resilient-pubsub (opt-in, v0.1).
 *
 * This module provides:
 * - `buildDeadLetterPolicy` — validates and constructs the `deadLetterPolicy`
 *   object that `@google-cloud/pubsub` expects when creating or updating a
 *   subscription.
 * - `getDeliveryAttempt` — ergonomic accessor for `meta.deliveryAttempt`.
 * - `withDeadLetter` — convenience merger that folds a `deadLetterPolicy` into
 *   a subscription-options object.
 * - `DEAD_LETTER_IAM_REQUIREMENTS` — a readonly documentation string describing
 *   the IAM grants required for native DLQ routing to function. Surfaced in
 *   code so users can discover it without leaving their editor. IAM preflight
 *   *validation* is deferred to v0.2.
 * - `DELIVERY_ATTEMPT_ATTRIBUTE` — the raw Pub/Sub message attribute key for
 *   the delivery-attempt counter. Provided for reference; the native client
 *   surfaces the parsed value as `message.deliveryAttempt`, which
 *   `Envelope.extractMeta` already reads into `EnvelopeMeta.deliveryAttempt`.
 *
 * **v0.1 scope — validate and document, never provision.**
 * The subscriber attaches to an *existing* subscription. Dead-letter topology
 * (creating subscriptions/topics, attaching policies) is infrastructure owned
 * by the operator. This library builds and validates the policy object so the
 * operator can pass it to the `@google-cloud/pubsub` subscription create/update
 * call, but it never calls that API itself.
 *
 * **Layering:** dlq → envelope (EnvelopeMeta), errors (ResilientPubSubError).
 * No runtime import of `@google-cloud/pubsub`; the returned policy object is a
 * plain JavaScript object shaped to satisfy the native API's type contract.
 *
 * @module dlq/dlq
 */

/**
 * The raw Pub/Sub message attribute key for the delivery-attempt counter.
 *
 * Pub/Sub sets this attribute on every message delivered via a subscription
 * that has a dead-letter policy attached. The native `@google-cloud/pubsub`
 * client also exposes the parsed integer as `message.deliveryAttempt`, which
 * `Envelope.extractMeta` already reads into `EnvelopeMeta.deliveryAttempt`.
 *
 * Use `getDeliveryAttempt(meta)` for ergonomic access instead of reading the
 * raw attribute directly.
 *
 * @example
 * ```ts
 * // Reading from raw attributes (usually unnecessary):
 * const raw = message.attributes[DELIVERY_ATTEMPT_ATTRIBUTE];
 * const attempt = raw !== undefined ? parseInt(raw, 10) : undefined;
 *
 * // Preferred: use the parsed value from EnvelopeMeta:
 * const attempt = getDeliveryAttempt(meta);
 * ```
 */
declare const DELIVERY_ATTEMPT_ATTRIBUTE: "googclient_deliveryattempt";
/**
 * IAM grants required for native Pub/Sub dead-letter routing to function.
 *
 * When a subscription has a `deadLetterPolicy`, Pub/Sub forwards undeliverable
 * messages using its own service account. That account needs two grants:
 *
 * 1. `roles/pubsub.publisher` on the **dead-letter topic** — so it can publish
 *    the forwarded message.
 * 2. `roles/pubsub.subscriber` on the **source subscription** — so it can
 *    acknowledge the original message after forwarding it.
 *
 * The service account identity follows the pattern:
 * `service-{PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com`
 *
 * **Note:** IAM preflight validation (programmatically checking that these
 * grants are in place before the subscriber starts) is deferred to v0.2.
 * In v0.1 this constant surfaces the requirement as discoverable documentation.
 *
 * @example Applying the grants via gcloud CLI:
 * ```sh
 * # Publisher role on the dead-letter topic:
 * gcloud pubsub topics add-iam-policy-binding projects/PROJECT/topics/DLQ_TOPIC \
 *   --member="serviceAccount:service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" \
 *   --role="roles/pubsub.publisher"
 *
 * # Subscriber role on the source subscription:
 * gcloud pubsub subscriptions add-iam-policy-binding \
 *   projects/PROJECT/subscriptions/SOURCE_SUB \
 *   --member="serviceAccount:service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" \
 *   --role="roles/pubsub.subscriber"
 * ```
 *
 * @see https://cloud.google.com/pubsub/docs/dead-letter-topics#granting_pubsub_the_right_to_forward_dead_letter_messages
 */
declare const DEAD_LETTER_IAM_REQUIREMENTS: string;
/**
 * Options accepted by {@link buildDeadLetterPolicy}.
 *
 * Maps directly to the `deadLetterPolicy` field of a Pub/Sub subscription
 * create/update request. Provide these values when constructing a subscription
 * via `@google-cloud/pubsub`; the returned policy object is the exact shape
 * the native client expects.
 */
interface DeadLetterOptions {
    /**
     * The fully-qualified name of the Pub/Sub topic to use as the dead-letter
     * destination. Must be a non-empty string.
     *
     * Format: `projects/{project}/topics/{topic}`
     *
     * @example `'projects/my-project/topics/orders-dlq'`
     */
    deadLetterTopic: string;
    /**
     * Maximum number of delivery attempts before a message is forwarded to the
     * dead-letter topic. Must be an integer in the range **[5, 100]** (Pub/Sub's
     * documented limits).
     *
     * @defaultValue `5`
     */
    maxDeliveryAttempts?: number;
}
/**
 * The native-shaped `deadLetterPolicy` object accepted by
 * `@google-cloud/pubsub` when creating or updating a subscription.
 *
 * The returned object is intentionally typed as a plain record (no import of
 * the peer library's types) so this module has zero hard runtime dependencies.
 */
interface DeadLetterPolicy {
    /** Fully-qualified dead-letter topic name. */
    readonly deadLetterTopic: string;
    /** Number of delivery attempts in [5, 100]. */
    readonly maxDeliveryAttempts: number;
}
/**
 * Subscription options shape used by {@link withDeadLetter}.
 *
 * Deliberately loose — the helper accepts any object that may already contain
 * other subscription options, and merges in the `deadLetterPolicy`.
 */
type SubscriptionOptions = Record<string, unknown> & {
    deadLetterPolicy?: DeadLetterPolicy;
};
/**
 * Validates {@link DeadLetterOptions} and returns the native-shaped
 * `deadLetterPolicy` object ready to pass to `@google-cloud/pubsub` when
 * creating or updating a subscription.
 *
 * **Validation rules:**
 * - `deadLetterTopic` must be a non-empty string.
 * - `maxDeliveryAttempts` (when provided) must be an integer in `[5, 100]`
 *   (Google Cloud Pub/Sub documented range). Defaults to `5` when omitted.
 *
 * **v0.1 scope:** this function only builds and validates the policy object.
 * It does NOT call any Pub/Sub API — subscription creation/update is the
 * operator's responsibility.
 *
 * @param opts - Dead-letter configuration options.
 * @returns The validated `{ deadLetterTopic, maxDeliveryAttempts }` policy.
 *
 * @throws {ResilientPubSubError} `{ kind: 'config' }` when any option fails
 *   validation.
 *
 * @example Basic usage (default maxDeliveryAttempts = 5)
 * ```ts
 * const policy = buildDeadLetterPolicy({
 *   deadLetterTopic: 'projects/my-project/topics/orders-dlq',
 * });
 * // policy.maxDeliveryAttempts === 5
 *
 * // Pass the policy to the native client:
 * const [subscription] = await pubSub.createSubscription(topic, 'orders-sub', {
 *   deadLetterPolicy: policy,
 * });
 * ```
 *
 * @example Custom attempt limit
 * ```ts
 * const policy = buildDeadLetterPolicy({
 *   deadLetterTopic: 'projects/my-project/topics/orders-dlq',
 *   maxDeliveryAttempts: 10,
 * });
 * ```
 */
declare function buildDeadLetterPolicy(opts: DeadLetterOptions): DeadLetterPolicy;
/**
 * Returns the delivery attempt count from `EnvelopeMeta`, or `undefined` when
 * the subscription does not have a dead-letter policy attached.
 *
 * Pub/Sub only populates `deliveryAttempt` when a `deadLetterPolicy` is
 * configured on the subscription. For subscriptions without a policy the field
 * is always `undefined`.
 *
 * @param meta - The `EnvelopeMeta` from a received message (available as
 *   `message.meta` inside a subscriber handler).
 * @returns The delivery attempt count, or `undefined`.
 *
 * @example
 * ```ts
 * subscriber.on(async ({ body, meta }) => {
 *   const attempt = getDeliveryAttempt(meta);
 *   if (attempt !== undefined && attempt >= 3) {
 *     logger.warn('High delivery-attempt count', { attempt });
 *   }
 *   await processOrder(body);
 * });
 * ```
 */
declare function getDeliveryAttempt(meta: EnvelopeMeta): number | undefined;
/**
 * Merges a `deadLetterPolicy` (built by {@link buildDeadLetterPolicy}) into an
 * existing subscription-options object.
 *
 * This is a thin convenience helper. The core deliverable is
 * {@link buildDeadLetterPolicy} + its validation; `withDeadLetter` exists only
 * to reduce one-time boilerplate at the call site.
 *
 * @param subscriptionOptions - Existing subscription options (may be empty `{}`).
 * @param dlqOpts - Dead-letter options passed through to `buildDeadLetterPolicy`.
 * @returns A new object with `deadLetterPolicy` merged in.
 *
 * @throws {ResilientPubSubError} `{ kind: 'config' }` when `dlqOpts` fails
 *   validation (delegates to `buildDeadLetterPolicy`).
 *
 * @example
 * ```ts
 * const subOptions = withDeadLetter(
 *   { flowControl: { maxMessages: 10 } },
 *   { deadLetterTopic: 'projects/my-project/topics/orders-dlq', maxDeliveryAttempts: 10 }
 * );
 * // subOptions.deadLetterPolicy === { deadLetterTopic: '...', maxDeliveryAttempts: 10 }
 * // subOptions.flowControl    === { maxMessages: 10 }
 * ```
 */
declare function withDeadLetter(subscriptionOptions: SubscriptionOptions, dlqOpts: DeadLetterOptions): SubscriptionOptions;

export { DEAD_LETTER_IAM_REQUIREMENTS, DELIVERY_ATTEMPT_ATTRIBUTE, type DeadLetterOptions, type DeadLetterPolicy, type SubscriptionOptions, buildDeadLetterPolicy, getDeliveryAttempt, withDeadLetter };
