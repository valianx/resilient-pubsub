/**
 * 02-quickstart-subscriber.ts
 *
 * // Target v0.1 API (see docs/VISION.md) — subscriber implementation in progress.
 *
 * Tool: createResilientSubscriber — minimal subscriber setup.
 *
 * Contract (v0.1 target):
 *   - createResilientSubscriber<T>(options) returns a ResilientSubscriber<T>.
 *   - options.subscription (string) is required; everything else has a safe default.
 *   - The handler receives { body: T, headers: Record<string,string>, meta }.
 *   - Throw in the handler → nack() (Pub/Sub redelivers). The library catches the
 *     throw — do NOT wrap the handler body in try/catch (that would swallow the error
 *     and turn a retry into a silent ack of a failed operation).
 *   - Return from the handler → ack() (done; Pub/Sub will not redeliver).
 *   - stop() performs a graceful drain: stops pulling, waits for in-flight handlers,
 *     nacks anything still running when the drain timeout elapses.
 *
 * The happy path is ≤ 4 lines of library code (import, create, on, start).
 *
 * Environment:
 *   GOOGLE_CLOUD_PROJECT=my-project
 *   GOOGLE_APPLICATION_CREDENTIALS=...  (or Workload Identity)
 */

// Target v0.1 API (see docs/VISION.md) — subscriber implementation in progress.
import { createResilientSubscriber } from 'resilient-pubsub';

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

interface OrderCreated {
  orderId: string;
  customerId: string;
  totalCents: number;
}

// ---------------------------------------------------------------------------
// Stub: business logic called inside the handler.
// ---------------------------------------------------------------------------

async function chargePayment(order: OrderCreated): Promise<void> {
  // idempotent: use order.orderId as the idempotency key in your payment API.
  console.log('Charging order', order.orderId, 'for', order.totalCents, 'cents');
}

// ---------------------------------------------------------------------------
// Example A: minimal subscriber — ≤ 4 lines of library code.
// ---------------------------------------------------------------------------

/**
 * Sets up a subscriber on 'orders-worker'.
 * Throw → nack (retry). Return → ack (done).
 */
export async function example2a(): Promise<void> {
  const worker = createResilientSubscriber<OrderCreated>({
    subscription: 'orders-worker',
  });

  worker.on(async (msg) => {
    await chargePayment(msg.body); // throws → nack; resolves → ack
  });

  worker.start();
}

// ---------------------------------------------------------------------------
// Example B: accessing all message fields and graceful shutdown.
// ---------------------------------------------------------------------------

/**
 * Demonstrates the full inbound message shape and the SIGTERM wiring that is
 * essential for GKE / Cloud Run deployments where graceful pod shutdown is routine.
 */
export function example2b(): void {
  const worker = createResilientSubscriber<OrderCreated>({
    subscription: 'orders-worker',
  });

  worker.on(async (msg) => {
    // --- body: typed, already deserialized
    const { orderId, totalCents } = msg.body;

    // --- headers: propagated from the publisher (allowlist-gated)
    const tenantId = msg.headers['x-tenant-id'];    // set by the publisher
    const traceParent = msg.headers['traceparent']; // W3C trace, always propagated

    // --- meta: Pub/Sub-populated; frozen, read-only
    console.log('messageId', msg.meta.messageId);
    console.log('publishTime', msg.meta.publishTime);       // ISO-8601
    console.log('deliveryAttempt', msg.meta.deliveryAttempt); // present only with DLQ policy
    console.log('orderingKey', msg.meta.orderingKey);

    // Business logic — throw to nack (retry), return to ack (done).
    await chargePayment({ orderId, customerId: tenantId ?? '', totalCents });

    console.log('traceparent for this hop:', traceParent);
  });

  worker.start();

  // Graceful shutdown — essential on GKE/Cloud Run.
  // stop() stops pulling new messages, waits for in-flight handlers to finish
  // (up to a configurable timeout), then nacks anything still running so it is
  // cleanly redelivered rather than lost.
  process.on('SIGTERM', async () => {
    await worker.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await worker.stop();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Example C: idempotency reminder.
// ---------------------------------------------------------------------------

/**
 * Pub/Sub is at-least-once: the same message can be delivered more than once
 * (ack lost on crash, near-deadline concurrent delivery). The handler below
 * uses the orderId as a deterministic idempotency key to make the payment
 * charge safe to run twice.
 *
 * The library makes the lifecycle correct (failure retries, success acks),
 * but it cannot make a non-idempotent effect safe. That is the application's
 * responsibility — see docs/VISION.md#idempotency-is-a-shared-responsibility.
 */
export function example2c(): void {
  const worker = createResilientSubscriber<OrderCreated>({
    subscription: 'orders-worker',
  });

  worker.on(async (msg) => {
    const { orderId, totalCents } = msg.body;

    // Use orderId as the idempotency key in the payment API call.
    // If the payment was already recorded for this orderId, the charge is a no-op.
    await chargePayment({ orderId, customerId: '', totalCents });
    // No try/catch here — let any thrown error propagate so the library nacks.
  });

  worker.start();
  process.on('SIGTERM', () => void worker.stop());
}
