/**
 * 01-quickstart-publisher.ts
 *
 * // Target v0.1 API (see docs/VISION.md) — publisher implementation in progress.
 *
 * Tool: createResilientPublisher — minimal publisher setup.
 *
 * Contract (v0.1 target):
 *   - createResilientPublisher<T>(options) returns a ResilientPublisher<T>.
 *   - options.topic (string) is required; everything else has a safe default.
 *   - publish({ body, headers }) retries internally with exponential backoff +
 *     full jitter by default, then REJECTS with a typed ResilientPubSubError
 *     if it exhausts retries — it never silently drops an event.
 *   - headers are allowlist-gated before being written to Pub/Sub attributes —
 *     only W3C trace headers and explicitly allowed keys cross the hop.
 *
 * The happy path is ≤ 3 lines of library code (import, create, publish).
 * Error handling around publish() is the caller's responsibility by design —
 * the library retries, but does not conceal a permanently lost event.
 *
 * Environment:
 *   GOOGLE_CLOUD_PROJECT=my-project     (or set via PubSub options)
 *   GOOGLE_APPLICATION_CREDENTIALS=...  (or use Workload Identity on GCP)
 */

// Target v0.1 API (see docs/VISION.md) — publisher implementation in progress.
import { createResilientPublisher } from 'resilient-pubsub';

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

interface OrderCreated {
  orderId: string;
  customerId: string;
  totalCents: number;
}

// ---------------------------------------------------------------------------
// Example A: minimal happy path — ≤ 3 lines of library code.
// ---------------------------------------------------------------------------

/**
 * Publishes an order-created event with the default configuration.
 * Retry, backoff, jitter, and context propagation are on by default.
 */
export async function example1a(): Promise<void> {
  const publisher = createResilientPublisher<OrderCreated>({ topic: 'orders' });

  await publisher.publish({
    body: { orderId: '42', customerId: 'cust-7', totalCents: 9999 },
    headers: { 'x-tenant-id': 'acme' },
  });
  // publish() resolved → message is in Pub/Sub; no try/catch needed on success.
}

// ---------------------------------------------------------------------------
// Example B: handling a permanent publish failure.
// ---------------------------------------------------------------------------

/**
 * Demonstrates the error contract: publish() rejects with ResilientPubSubError
 * after exhausting retries. The caller handles the rejection.
 *
 * Hiding a permanently failed publish would silently drop an event — the
 * library owns retrying, not concealing the outcome.
 */
export async function example1b(): Promise<void> {
  const publisher = createResilientPublisher<OrderCreated>({ topic: 'orders' });

  try {
    await publisher.publish({
      body: { orderId: '43', customerId: 'cust-8', totalCents: 4999 },
      headers: {
        'traceparent': '00-abc123-01',  // W3C trace — always propagated
        'x-tenant-id': 'acme',          // propagated if 'x-tenant-id' is in the allowlist
        'authorization': 'Bearer secret', // NOT propagated — attributes are unredacted
      },
    });
  } catch (err) {
    // err is a ResilientPubSubError: the publish failed permanently.
    // Options: alert, persist the event for a later retry, or fail the caller request.
    console.error('Publish exhausted retries:', err);
  }
}

// ---------------------------------------------------------------------------
// Example C: with explicit retry knobs.
// ---------------------------------------------------------------------------

/**
 * All resilience options have safe defaults. Override them when you need
 * finer control (e.g., aggressive retry for a critical payment event).
 */
export async function example1c(): Promise<void> {
  const publisher = createResilientPublisher<OrderCreated>({
    topic: 'orders',
    // Resilience overrides — all optional; values below are illustrative.
    maxAttempts: 5,
    backoff: 'exponential',
    initialDelay: 500,   // ms
    maxDelay: 15_000,    // ms
    jitter: 'full',
    // Propagation allowlist — extend beyond the default W3C trace headers.
    propagation: {
      allowlist: ['x-tenant-id', 'x-correlation-id'],
    },
    onRetry: (err, attempt, delayMs) => {
      console.warn(`Publish retry ${attempt}, waiting ${delayMs} ms`, err.kind);
    },
  });

  try {
    await publisher.publish({
      body: { orderId: '44', customerId: 'cust-9', totalCents: 19_999 },
      headers: {
        'traceparent': '00-def456-01',
        'x-tenant-id': 'acme',
        'x-correlation-id': 'req-abc',
      },
    });
  } catch (err) {
    // permanent failure after 5 attempts
    console.error('Payment event lost after max retries', err);
  }
}
