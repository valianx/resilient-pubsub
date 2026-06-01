/**
 * 10-deployment-patterns.ts
 *
 * Tools: deployment patterns — publisher-only / consumer-only / both;
 *        subpath imports for tree-shaking; shared PubSub client.
 *
 * See also: docs/configuration.md for the canonical reference.
 *
 * Key rule: import from the role subpath, not the root barrel, so that a
 * publisher-only app never bundles subscriber code (and vice versa).
 *
 *   Publisher-only app:
 *     import { createResilientPublisher } from 'resilient-pubsub/publisher';
 *
 *   Consumer-only app:
 *     import { createResilientSubscriber } from 'resilient-pubsub/subscriber';
 *
 *   Both roles in one app:
 *     import { createResilientPublisher } from 'resilient-pubsub/publisher';
 *     import { createResilientSubscriber } from 'resilient-pubsub/subscriber';
 *     (Or use the root barrel 'resilient-pubsub' — same implementations, less tree-shaking.)
 *
 * Shared client:
 *   When an app uses both a publisher and a subscriber, they share a single
 *   underlying @google-cloud/pubsub client by default — one connection and one
 *   authentication path. For full control, inject your own PubSub instance.
 */

// ---------------------------------------------------------------------------
// Pattern 1: Publisher-only app.
// ---------------------------------------------------------------------------

import { createResilientPublisher } from 'resilient-pubsub/publisher';

interface OrderCreated {
  orderId: string;
  totalCents: number;
}

/**
 * A service that only publishes. Import from 'resilient-pubsub/publisher'
 * so the subscriber module is tree-shaken out of the bundle.
 *
 * Environment:
 *   GOOGLE_CLOUD_PROJECT=my-project     (standard GCP — no library-specific var)
 *   GOOGLE_APPLICATION_CREDENTIALS=...  (or Workload Identity)
 */
export async function patternPublisherOnly(): Promise<void> {
  const orders = createResilientPublisher<OrderCreated>({ topic: 'orders' });

  try {
    await orders.publish({
      body: { orderId: '42', totalCents: 9999 },
      headers: { 'x-tenant-id': 'acme' },
    });
  } catch (err) {
    // Permanent publish failure — alert, persist, or fail the caller request.
    console.error('Failed to publish order event', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pattern 2: Consumer-only app.
// ---------------------------------------------------------------------------

import { createResilientSubscriber } from 'resilient-pubsub/subscriber';

/**
 * A worker that only consumes. Import from 'resilient-pubsub/subscriber'
 * so the publisher module is never bundled.
 */
export function patternConsumerOnly(): void {
  const worker = createResilientSubscriber<OrderCreated>({
    subscription: 'orders-worker',
  });

  worker.on(async (msg) => {
    console.log('Processing order', msg.body.orderId);
    // throw → nack (retry), return → ack (done)
  });

  worker.start();
  process.on('SIGTERM', () => void worker.stop());
}

// ---------------------------------------------------------------------------
// Pattern 3: App that both consumes and publishes.
// ---------------------------------------------------------------------------

interface PaymentCharged {
  paymentId: string;
  orderId: string;
  amountCents: number;
}

/**
 * Consumes OrderCreated events, charges payment, publishes PaymentCharged.
 *
 * The message contract is symmetric: msg.headers from the consumed message
 * can be passed directly into the next publish() — trace context flows
 * service-to-service automatically, with no extra wiring.
 *
 * Both the publisher and subscriber share a single @google-cloud/pubsub
 * client by default (one connection, one auth path). No wiring required.
 */
export function patternBothRoles(): void {
  const payments = createResilientPublisher<PaymentCharged>({ topic: 'payments' });
  const orders   = createResilientSubscriber<OrderCreated>({ subscription: 'orders-worker' });

  orders.on(async (msg) => {
    const charged = await chargePayment(msg.body);

    // Forward the same headers → trace context travels service → service.
    await payments.publish({
      body: charged,
      headers: msg.headers, // { traceparent, 'x-tenant-id', … } — all allowlisted keys
    });
    // Return → ack. If payments.publish() throws, the error propagates → nack.
  });

  orders.start();
  process.on('SIGTERM', () => void orders.stop());
}

// ---------------------------------------------------------------------------
// Pattern 4: Injecting a shared PubSub client.
// ---------------------------------------------------------------------------

import { PubSub } from '@google-cloud/pubsub';

/**
 * Inject a pre-configured PubSub instance when you need custom client options
 * (e.g., a specific projectId, a mock in tests, or an existing managed client).
 *
 * A provided client is used as-is; the library never reconfigures or closes
 * a client it did not create.
 */
export function patternSharedClient(): void {
  const pubSubClient = new PubSub({ projectId: 'my-project' });

  const publisher = createResilientPublisher<OrderCreated>({
    topic: 'orders',
    pubSubClient, // shared
  });

  const worker = createResilientSubscriber<OrderCreated>({
    subscription: 'orders-worker',
    pubSubClient, // same instance — one connection
  });

  worker.on(async (msg) => {
    console.log('Order received', msg.body.orderId);
  });

  worker.start();

  console.log('Publisher and subscriber share the same client:', publisher !== null);
  process.on('SIGTERM', () => void worker.stop());
}

// ---------------------------------------------------------------------------
// Pattern 5: Injecting a mock client in tests.
// ---------------------------------------------------------------------------

/**
 * In unit or integration tests, pass a mock or emulator-backed PubSub client
 * through pubSubClient. This keeps library internals testable without real GCP.
 *
 * For end-to-end integration, use the Pub/Sub emulator:
 *   PUBSUB_EMULATOR_HOST=localhost:8085
 *   GOOGLE_CLOUD_PROJECT=test-project
 *
 * The @google-cloud/pubsub client detects PUBSUB_EMULATOR_HOST automatically
 * and routes all calls to the emulator — no code changes needed.
 */
export function patternMockClientInTests(): void {
  // Point the client at the emulator in tests:
  process.env['PUBSUB_EMULATOR_HOST'] = 'localhost:8085';
  process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';

  // The standard PubSub client picks up PUBSUB_EMULATOR_HOST automatically.
  const testClient = new PubSub();

  const publisher = createResilientPublisher<OrderCreated>({
    topic: 'test-orders',
    pubSubClient: testClient,
  });

  // publisher.publish({ ... }) now routes to the emulator.
  console.log('Publisher wired to emulator:', publisher !== null);
}

// ---------------------------------------------------------------------------
// Stub: business logic.
// ---------------------------------------------------------------------------

async function chargePayment(order: OrderCreated): Promise<PaymentCharged> {
  return { paymentId: `pay-${order.orderId}`, orderId: order.orderId, amountCents: order.totalCents };
}
