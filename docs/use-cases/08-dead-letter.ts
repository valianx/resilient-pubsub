/**
 * 08-dead-letter.ts
 *
 * // Target v0.1 API (see docs/VISION.md) — subscriber implementation in progress.
 *
 * Tools: createResilientSubscriber with deadLetterPolicy, onPoison hook,
 *        deliveryAttempt on meta.
 *
 * Dead-letter handling is opt-in: a subscriber that does not configure it
 * pays no cost and runs no checks. A subscriber that opts in declares it
 * explicitly; the library surfaces delivery_attempt on msg.meta and fires
 * the onPoison / onDeadLetter hooks at the right moments.
 *
 * Native deadLetterPolicy setup (must be done once, outside the library):
 *   - Create a dead-letter topic in Pub/Sub.
 *   - Configure deadLetterPolicy on the subscription (maxDeliveryAttempts).
 *   - Grant the Pub/Sub service account pubsub.publisher on the DLT and
 *     pubsub.subscriber on the source subscription.
 *
 * The library documents the requirements and passes the policy through; it
 * does NOT create IAM resources. A v0.2 startup preflight will validate the
 * grants and fail loudly on misconfiguration (see ROADMAP.md).
 *
 * WARNING: Do NOT catch errors inside your handler when using dead-letter.
 * A caught error becomes a silent ack — the message is marked done and the
 * dead-letter counter never increments. Let throws propagate so the library
 * nacks and Pub/Sub counts the delivery attempt.
 */

// Target v0.1 API (see docs/VISION.md) — subscriber implementation in progress.
import { createResilientSubscriber } from 'resilient-pubsub';
import { isResilientPubSubError } from 'resilient-pubsub/errors';

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

interface PaymentEvent {
  paymentId: string;
  amountCents: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Example A: subscriber with deadLetterPolicy opt-in.
// ---------------------------------------------------------------------------

/**
 * Opts into native dead-letter support. The subscription must already have
 * deadLetterPolicy configured in Pub/Sub (this is infrastructure, not code).
 *
 * After maxDeliveryAttempts failures, Pub/Sub moves the message to the
 * dead-letter topic automatically. onDeadLetter fires when the library
 * detects delivery_attempt >= maxDeliveryAttempts.
 */
export function example8a(): void {
  const worker = createResilientSubscriber<PaymentEvent>({
    subscription: 'payments-worker',

    // Pass the deadLetterPolicy configuration through to the native client.
    // The dead-letter topic must already exist with the correct IAM grants.
    deadLetterPolicy: {
      deadLetterTopic: 'projects/my-project/topics/payments-dlq',
      maxDeliveryAttempts: 5,
    },

    // Fires when a SerializationError is detected — message is unprocessable.
    // The library nacks without retry; Pub/Sub routes to the dead-letter topic.
    onPoison: (msg, err) => {
      console.error('Poison message detected, routing to DLQ', {
        messageId: msg.meta.messageId,
        error: isResilientPubSubError(err) ? err.toJSON() : String(err),
      });
      // Do NOT throw here — the library already handles the nack.
    },

    // Fires when delivery_attempt reaches maxDeliveryAttempts.
    // Pub/Sub will route this message to the dead-letter topic.
    onDeadLetter: (msg) => {
      console.error('Message exhausted delivery attempts — dead-lettered', {
        messageId: msg.meta.messageId,
        deliveryAttempt: msg.meta.deliveryAttempt,
      });
    },
  });

  worker.on(async (msg) => {
    // deliveryAttempt is surfaced on meta when deadLetterPolicy is configured.
    const attempt = msg.meta.deliveryAttempt ?? 1;
    console.log(`Processing payment ${msg.body.paymentId} (delivery attempt ${attempt})`);

    // Business logic — throw to nack (increments delivery_attempt), return to ack.
    await processPayment(msg.body);
  });

  worker.start();
  process.on('SIGTERM', () => void worker.stop());
}

// ---------------------------------------------------------------------------
// Example B: reading deliveryAttempt to implement custom escalation.
// ---------------------------------------------------------------------------

/**
 * Even without a formal deadLetterPolicy, you can read deliveryAttempt
 * to implement custom escalation — for example, alerting on the 3rd attempt.
 */
export function example8b(): void {
  const ALERT_AFTER_ATTEMPTS = 3;

  const worker = createResilientSubscriber<PaymentEvent>({
    subscription: 'payments-worker',
  });

  worker.on(async (msg) => {
    const attempt = msg.meta.deliveryAttempt ?? 1;

    if (attempt >= ALERT_AFTER_ATTEMPTS) {
      // Alert before trying again — this message is struggling.
      console.warn(`Payment ${msg.body.paymentId} on attempt ${attempt} — escalating`);
    }

    await processPayment(msg.body);
  });

  worker.start();
  process.on('SIGTERM', () => void worker.stop());
}

// ---------------------------------------------------------------------------
// Example C: onPoison hook — handling SerializationError (always poison).
// ---------------------------------------------------------------------------

/**
 * When the library's deserializer fails (bad bytes, malformed JSON), it throws
 * a SerializationError before the user handler runs. The library catches it,
 * fires onPoison, and nacks the message. Pub/Sub redelivers up to
 * maxDeliveryAttempts and then routes to the DLT.
 *
 * In v0.1, body shape validation (user-schema mismatch) is not built in;
 * throw a SerializationError manually in your handler if the parsed body
 * is structurally wrong, and it will be treated as poison.
 */
export function example8c(): void {
  const worker = createResilientSubscriber<PaymentEvent>({
    subscription: 'payments-worker',
    onPoison: (msg, err) => {
      // Log the error safely — toJSON() excludes body, cause, and raw attributes.
      console.error('Undeserializable message', {
        messageId: msg.meta.messageId,
        ...(isResilientPubSubError(err) ? err.toJSON() : { message: String(err) }),
      });
      // Emit a metric for monitoring poisoned message rates.
    },
  });

  worker.on(async (msg) => {
    // If the deserialized body is semantically wrong, throw a SerializationError
    // to classify it as poison and trigger onPoison + dead-letter routing.
    if (msg.body.amountCents <= 0) {
      const { SerializationError } = await import('resilient-pubsub/errors');
      throw new SerializationError(
        `Payment ${msg.body.paymentId} has non-positive amountCents — treating as poison`
      );
    }

    await processPayment(msg.body);
  });

  worker.start();
}

// ---------------------------------------------------------------------------
// Stub: business logic.
// ---------------------------------------------------------------------------

async function processPayment(payment: PaymentEvent): Promise<void> {
  console.log(`Processing payment ${payment.paymentId} for ${payment.amountCents} ${payment.currency}`);
}
