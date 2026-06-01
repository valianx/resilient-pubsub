/**
 * 09-graceful-shutdown.ts
 *
 * Tool: subscriber.stop() — graceful drain wired to SIGTERM/SIGINT.
 *
 * Why graceful shutdown matters:
 *   On GKE, Cloud Run, or any container platform, SIGTERM is routine — it fires
 *   on every rolling deploy, scale-down, or preemption. A subscriber that dies
 *   mid-handler without draining leaves Pub/Sub with unacked messages that it
 *   redelivers. Those extra redeliveries increase the burden on idempotency and
 *   inflate delivery_attempt counts toward the dead-letter threshold.
 *
 *   stop() resolves the problem:
 *     1. Stops pulling new messages from Pub/Sub immediately.
 *     2. Waits for every in-flight handler to complete up to a drain timeout.
 *     3. Any handler still running when the timeout elapses is nacked cleanly —
 *        the message is redelivered, never lost.
 *
 * The lifecycle contract:
 *   start()  — begins pulling messages and routing them to the handler.
 *   stop()   — drains in-flight handlers and releases the underlying connection.
 *   The promise returned by stop() resolves when the drain is complete.
 *
 * SIGTERM timeout budget:
 *   Container platforms give a fixed SIGTERM-to-SIGKILL window (default 30 s on
 *   GKE, 10 s on Cloud Run). Set the drain timeout below that window to ensure
 *   stop() resolves before the hard kill. A reasonable formula:
 *     drainTimeout = platform_sigkill_window - (2 s safety buffer)
 */

import { createResilientSubscriber } from 'resilient-pubsub';

// ---------------------------------------------------------------------------
// Domain type
// ---------------------------------------------------------------------------

interface InvoiceEvent {
  invoiceId: string;
  totalCents: number;
}

// ---------------------------------------------------------------------------
// Example A: minimal graceful shutdown pattern.
// ---------------------------------------------------------------------------

/**
 * The simplest correct wiring: stop() on SIGTERM, then exit.
 * Works for most GKE / Cloud Run workloads.
 */
export function example9a(): void {
  const worker = createResilientSubscriber<InvoiceEvent>({
    subscription: 'invoices-worker',
  });

  worker.on(async (msg) => {
    await renderInvoice(msg.body); // throw → nack, return → ack
  });

  worker.start();

  // Wire stop() to SIGTERM — called by the container platform on shutdown.
  process.on('SIGTERM', async () => {
    await worker.stop();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Example B: with drain timeout and SIGINT wiring.
// ---------------------------------------------------------------------------

/**
 * Configures an explicit drain timeout and handles both SIGTERM and SIGINT.
 * drainTimeoutMs should be less than the platform's SIGKILL window.
 *
 * For GKE with the default 30 s terminationGracePeriodSeconds:
 *   drainTimeoutMs = 28_000  (leaves 2 s for process exit)
 * For Cloud Run with the default 10 s:
 *   drainTimeoutMs = 8_000
 */
export function example9b(): void {
  const DRAIN_TIMEOUT_MS = 28_000; // GKE default minus 2 s safety buffer

  const worker = createResilientSubscriber<InvoiceEvent>({
    subscription: 'invoices-worker',
    drainTimeoutMs: DRAIN_TIMEOUT_MS, // any handler still running after this → nacked
  });

  worker.on(async (msg) => {
    await renderInvoice(msg.body);
  });

  worker.start();

  let stopping = false;

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return; // guard against double-SIGTERM
    stopping = true;

    console.log(`Received ${signal}, draining in-flight handlers…`);
    await worker.stop();
    console.log('Drain complete, exiting.');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

// ---------------------------------------------------------------------------
// Example C: multiple subscribers in one process.
// ---------------------------------------------------------------------------

/**
 * When a single process hosts more than one subscriber (e.g., an orders
 * worker and a payments worker), stop all of them concurrently so that the
 * drain of the slowest subscriber does not delay the others.
 */
export function example9c(): void {
  const ordersWorker = createResilientSubscriber<InvoiceEvent>({
    subscription: 'orders-invoices-worker',
  });
  const paymentsWorker = createResilientSubscriber<InvoiceEvent>({
    subscription: 'payments-invoices-worker',
  });

  ordersWorker.on(async (msg) => renderInvoice(msg.body));
  paymentsWorker.on(async (msg) => renderInvoice(msg.body));

  ordersWorker.start();
  paymentsWorker.start();

  process.on('SIGTERM', async () => {
    // Drain both concurrently — total wait is max(ordersTimeout, paymentsTimeout),
    // not sum of both.
    await Promise.all([ordersWorker.stop(), paymentsWorker.stop()]);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Example D: graceful shutdown in NestJS / lifecycle hooks.
// ---------------------------------------------------------------------------

/**
 * In NestJS, wire stop() into OnApplicationShutdown so the framework's
 * shutdown pipeline handles the drain before closing other providers.
 *
 * @example NestJS module provider
 * ```typescript
 * @Injectable()
 * class InvoiceWorkerService implements OnApplicationShutdown {
 *   private readonly worker = createResilientSubscriber<InvoiceEvent>({
 *     subscription: 'invoices-worker',
 *   });
 *
 *   onModuleInit(): void {
 *     this.worker.on(async (msg) => renderInvoice(msg.body));
 *     this.worker.start();
 *   }
 *
 *   async onApplicationShutdown(): Promise<void> {
 *     await this.worker.stop();
 *   }
 * }
 * ```
 */
export function example9d(): void {
  // This example is shown above as a JSDoc code block.
  // See resilient-pubsub-e2e-nestjs for a full working integration.
}

// ---------------------------------------------------------------------------
// Stub: business logic.
// ---------------------------------------------------------------------------

async function renderInvoice(invoice: InvoiceEvent): Promise<void> {
  console.log(`Rendering invoice ${invoice.invoiceId} for ${invoice.totalCents} cents`);
}
