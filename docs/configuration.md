# Configuration

> Status: design reference for v0.1 (under active development). This describes the
> intended configuration model; behavior is verified by the end-to-end consumer
> repositories as the implementation lands.

resilient-pubsub is **zero-config by default**: with the standard GCP environment
in place, a publisher or a subscriber works without any library-specific
configuration. Everything below is either inherited from the GCP environment or
an optional override with a safe default.

## Environment

### Standard GCP environment (shared by every app)

These come from Google's own conventions — the library does not invent its own
scheme:

| Variable | Purpose |
|----------|---------|
| `GOOGLE_CLOUD_PROJECT` | The GCP project id. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to a service-account key file. On GCP (Cloud Run, GKE, GCE) prefer Workload Identity / the metadata server and omit this. |

If your runtime already provides Application Default Credentials (ADC), nothing
else is required.

### Resilience knobs (optional, safe defaults)

Tuning is read from a documented `RESILIENT_PUBSUB_*` environment-variable
convention, each with a safe default, so a 12-factor deployment can adjust
behavior without touching code. Programmatic overrides are always available and
take precedence. (The exact variable names are finalized with the publisher and
subscriber implementations; this file is updated as they land.)

## Imports — subpath vs barrel

The package ships a conditional exports map with `sideEffects: false`, so apps
pull in only what they import.

- **Recommended:** import from the role subpath, so a publisher-only app does not
  bundle subscriber code (and vice versa):
  ```ts
  import { createResilientPublisher } from 'resilient-pubsub/publisher';
  import { createResilientSubscriber } from 'resilient-pubsub/subscriber';
  ```
- **Also available:** the root barrel re-exports both, for apps that use everything
  and prefer a single import path:
  ```ts
  import { createResilientPublisher, createResilientSubscriber } from 'resilient-pubsub';
  ```

Both resolve to the same implementations; the subpath form just gives the bundler
the cleanest tree-shaking boundary.

## The three deployment patterns

### 1. Publisher-only app

Imports only the publisher; subscriber code is never bundled.

```ts
import { createResilientPublisher } from 'resilient-pubsub/publisher';

const orders = createResilientPublisher<OrderCreated>({ topic: 'orders' });

// publish() retries internally and rejects with a typed ResilientPubSubError
// if it fails after exhausting retries — handle it; it never swallows the event.
try {
  await orders.publish({
    body: { orderId: '42' },
    // Only allowlisted headers cross the hop. Use an explicit allowlist for
    // business headers; traceparent / tracestate propagate automatically.
    headers: { 'x-correlation-id': 'abc-123' },
  });
} catch (err) {
  // permanent publish failure — alert / persist / fail the request
}
```

### 2. Consumer-only app

Imports only the subscriber; publisher code is never bundled.

```ts
import { createResilientSubscriber } from 'resilient-pubsub/subscriber';

const worker = createResilientSubscriber<OrderCreated>({
  subscription: 'orders-worker',
});

worker.on(async (msg) => {
  msg.body; // OrderCreated — typed, already deserialized
  msg.headers; // propagated headers (allowlist), already parsed
  msg.meta; // messageId, deliveryAttempt, publishTime, orderingKey
  // throw to nack (retry), return to ack (done) — no try/catch here
});

worker.start();
```

### 3. App that both consumes and publishes

A common shape: consume one event, do work, publish another. Import both roles.
Because the message contract is symmetric, forwarding context across the hop is
trivial — pass the inbound `headers` straight into the outbound `publish`.

```ts
import { createResilientPublisher } from 'resilient-pubsub/publisher';
import { createResilientSubscriber } from 'resilient-pubsub/subscriber';

const payments = createResilientPublisher<PaymentCharged>({ topic: 'payments' });
const orders = createResilientSubscriber<OrderCreated>({
  subscription: 'orders-worker',
});

orders.on(async (msg) => {
  const charged = await charge(msg.body);
  // forward the same headers → trace context flows service → service automatically
  await payments.publish({ body: charged, headers: msg.headers });
});

orders.start();
```

## Shared Pub/Sub client

When an app uses both a publisher and a subscriber, they **share a single
underlying `@google-cloud/pubsub` client by default** — one connection and one
authentication path, rather than two. This is automatic; no wiring required.

For full control (custom client options, a mock in tests, an existing client you
already manage), pass your own instance to either factory:

```ts
import { PubSub } from '@google-cloud/pubsub';
import { createResilientPublisher } from 'resilient-pubsub/publisher';
import { createResilientSubscriber } from 'resilient-pubsub/subscriber';

const pubSubClient = new PubSub({ projectId: 'my-project' });

const publisher = createResilientPublisher({ topic: 'orders', pubSubClient });
const subscriber = createResilientSubscriber({ subscription: 'orders-worker', pubSubClient });
```

A provided client is used as-is; the library never reconfigures or closes a client
it did not create.
