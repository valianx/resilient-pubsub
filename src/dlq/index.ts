/**
 * resilient-pubsub/dlq
 *
 * Native dead-letter support for resilient-pubsub (opt-in, v0.1).
 *
 * This sub-module provides utilities for building and validating the
 * `deadLetterPolicy` object consumed by `@google-cloud/pubsub` when creating
 * or updating a subscription, along with discoverable documentation of the
 * required IAM grants.
 *
 * **Pub/Sub subscriber side (onPoison + deliveryAttempt):**
 * The subscriber hook `onPoison` and `meta.deliveryAttempt` are already
 * available via `createResilientSubscriber` (see `resilient-pubsub/subscriber`).
 * This module does NOT re-implement those; it adds the policy builder and
 * opt-in DLQ-awareness helpers.
 *
 * Exports:
 * - `buildDeadLetterPolicy`      — validate + build the native policy object.
 * - `getDeliveryAttempt`         — ergonomic accessor for `meta.deliveryAttempt`.
 * - `withDeadLetter`             — merge helper: adds `deadLetterPolicy` to sub options.
 * - `DELIVERY_ATTEMPT_ATTRIBUTE` — raw Pub/Sub attribute key for delivery-attempt count.
 * - `DEAD_LETTER_IAM_REQUIREMENTS` — IAM grants required for DLQ forwarding (doc-in-code).
 * - `DeadLetterOptions`          — input interface for `buildDeadLetterPolicy`.
 * - `DeadLetterPolicy`           — output type (native-shaped policy object).
 * - `SubscriptionOptions`        — loose subscription options type for `withDeadLetter`.
 *
 * @module dlq
 */

export {
  buildDeadLetterPolicy,
  getDeliveryAttempt,
  withDeadLetter,
  DELIVERY_ATTEMPT_ATTRIBUTE,
  DEAD_LETTER_IAM_REQUIREMENTS,
} from './dlq';

export type { DeadLetterOptions, DeadLetterPolicy, SubscriptionOptions } from './dlq';
