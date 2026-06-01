# API Reference — resilient-pubsub

> **Under active development — not ready for production use.**
>
> Items marked *"v0.1, in progress"* describe the target API for the first
> stable release. Items marked *"implemented"* are already in the codebase and
> exercised by the test suite.

## Table of contents

1. [Factory functions](#1-factory-functions)
   - [`createResilientPublisher<T>(options)`](#createresilientpublishert-options)
   - [`createResilientSubscriber<T>(options)`](#createresilientsubscribert-options)
2. [Envelope & Serializer](#2-envelope--serializer)
   - [`Envelope<T>`](#envelopet)
   - [`Serializer<T>` / `JsonSerializer<T>`](#serializert--jsonserializert)
3. [Error surface](#3-error-surface)
   - [`ResilientPubSubError`](#resilientpubsuberror)
   - [`isResilientPubSubError`](#isresilientpubsuberror)
   - [`SerializationError`](#serializationerror)
   - [Error kinds table](#error-kinds-table)
   - [`toJSON()` safety notes](#tojson-safety-notes)
4. [Context propagation](#4-context-propagation)
   - [`injectContext` / `extractContext`](#injectcontext--extractcontext)
   - [Propagation security rules](#propagation-security-rules)
5. [Core algorithms](#5-core-algorithms)
   - [`calculateBackoff`](#calculatebackoff)
   - [`applyJitter`](#applyjitter)
   - [`classify` / `isRetryable`](#classify--isretryable)
   - [Backoff strategies table](#backoff-strategies-table)
   - [Jitter algorithms table](#jitter-algorithms-table)
6. [Hooks & Observability](#6-hooks--observability)
7. [Testing your integration](#7-testing-your-integration)

---

## 1. Factory functions

### `createResilientPublisher<T>(options)`

> v0.1 — target API, implementation in progress. See [docs/VISION.md](VISION.md).

```typescript
import { createResilientPublisher } from 'resilient-pubsub';
// or, for tree-shaking in publisher-only apps:
import { createResilientPublisher } from 'resilient-pubsub/publisher';

const publisher = createResilientPublisher<OrderCreated>({
  topic: string;                 // Required: Pub/Sub topic name
  pubSubClient?: PubSub;         // Optional: inject an existing client
  // retry, backoff, jitter, propagation knobs — all have safe defaults
});

await publisher.publish({ body: T, headers?: Record<string, string> });
```

`publish()` retries internally with the configured backoff and jitter strategy.
On permanent failure it rejects with a typed `ResilientPubSubError` — it never
silently drops an event. The caller handles the final failure (alert, persist,
or fail the request).

### `createResilientSubscriber<T>(options)`

> v0.1 — target API, implementation in progress. See [docs/VISION.md](VISION.md).

```typescript
import { createResilientSubscriber } from 'resilient-pubsub';
// or:
import { createResilientSubscriber } from 'resilient-pubsub/subscriber';

const worker = createResilientSubscriber<OrderCreated>({
  subscription: string;          // Required: Pub/Sub subscription name
  pubSubClient?: PubSub;         // Optional: inject an existing client
  // deadLetterPolicy, flowControl, maxExtension, etc. — safe defaults
});

worker.on(async (msg: { body: T; headers: Record<string, string>; meta: EnvelopeMeta }) => {
  // throw → nack (Pub/Sub redelivers), return → ack (done)
  // Do NOT write try/catch in the handler — it would silently swallow errors
  // and break the retry contract.
});

worker.start();
await worker.stop();  // graceful drain — stops pulling, waits for in-flight handlers
```

**Lifecycle contract:**

- **Handler returns** → `ack()` — Pub/Sub will not redeliver.
- **Handler throws** → `nack()` — the library catches the throw and triggers redelivery.
- **`stop()`** — drains in-flight handlers up to a configurable timeout; nacks
  anything still running so no message is lost. Wire to `SIGTERM`/`SIGINT` in
  every deployment.

---

## 2. Envelope & Serializer

> Implemented. See [docs/use-cases/03-message-envelope.ts](use-cases/03-message-envelope.ts).

### `Envelope<T>`

The message shape that both sides of the hop share:

| Field     | Publish | Consume | Notes |
|-----------|---------|---------|-------|
| `body`    | yes     | yes     | Typed `T`, JSON-serialized by default |
| `headers` | yes     | yes     | Allowlist-gated; marshalled to/from Pub/Sub attributes |
| `meta`    | —       | yes     | `messageId`, `publishTime`, `deliveryAttempt`, `orderingKey` |

`meta` exists **only on consume** — Pub/Sub populates it at delivery. The
publish side does not accept it.

```typescript
import { Envelope } from 'resilient-pubsub/envelope';

// Outbound envelope (publish side — no meta)
const env = Envelope.outbound<OrderCreated>(body, attributes);

// Inbound envelope (consume side — with frozen meta)
const env = Envelope.inbound<OrderCreated>(body, attributes, meta);
```

### `Serializer<T>` / `JsonSerializer<T>`

```typescript
import { JsonSerializer } from 'resilient-pubsub/envelope';
import type { Serializer } from 'resilient-pubsub/envelope';

// Default JSON serializer
const serializer = new JsonSerializer<OrderCreated>();
const bytes = serializer.serialize({ orderId: '42' });
const body  = serializer.deserialize(bytes);
```

Implement `Serializer<T>` to plug in Protobuf, Avro, or any other format.

---

## 3. Error surface

> Implemented. See [docs/use-cases/06-error-handling.ts](use-cases/06-error-handling.ts).

### `ResilientPubSubError`

Every error the library surfaces is a `ResilientPubSubError`:

```typescript
import { ResilientPubSubError, isResilientPubSubError } from 'resilient-pubsub/errors';

try {
  await publisher.publish({ body: payload, headers });
} catch (err) {
  if (isResilientPubSubError(err)) {
    err.kind;           // 'publish' | 'subscribe' | 'process' | 'serialization' | 'ack' | 'config'
    err.classification; // 'transient' | 'permanent' | 'poison' | 'unknown'
    err.retryable;      // boolean shorthand
    err.grpcCode;       // numeric gRPC code, if present
    err.toJSON();       // log-safe — never leaks body, cause, or meta
  }
}
```

### `isResilientPubSubError`

Use `isResilientPubSubError(err)` — not `instanceof` — so the brand check works
across module/realm boundaries (monorepos, duplicate installs).

### `SerializationError`

A fixed-semantics subclass of `ResilientPubSubError`:

- `kind === 'serialization'`
- `classification === 'poison'`
- `retryable === false`

A message that cannot be deserialized should never loop through retries — route
it to a dead-letter queue or discard it deliberately.

### Error kinds table

| `kind`            | When |
|-------------------|------|
| `'publish'`       | Publish failed (gRPC error, quota, unavailable) |
| `'subscribe'`     | Subscriber setup or stream management error |
| `'process'`       | Error thrown inside a user handler (wrapped for observability) |
| `'serialization'` | Body could not be serialized or deserialized |
| `'ack'`           | Failure acknowledging or nacking a message |
| `'config'`        | Invalid library configuration detected at runtime |

### `toJSON()` safety notes

`toJSON()` is safe by default:

- Caps the message representation at 512 characters.
- Redacts secrets (GCP key paths, credential strings).
- Never includes `body`, `cause`, `meta`, or raw Pub/Sub attributes.

This makes it safe to pass directly to any structured logger without risking
PII or secrets in log output.

---

## 4. Context propagation

> Implemented. See [docs/use-cases/07-context-propagation.ts](use-cases/07-context-propagation.ts).

### `injectContext` / `extractContext`

Trace context and allowlisted business headers travel automatically from
publisher to consumer across the message hop. This is pure W3C-standard string
marshalling — zero dependencies, no OpenTelemetry SDK required.

```typescript
import { injectContext, extractContext, W3C_TRACE_HEADERS } from 'resilient-pubsub/propagation';
import type { PropagationOptions, Headers } from 'resilient-pubsub/propagation';

// Publisher side — embed headers into Pub/Sub attributes
const attrs = injectContext(incomingRequestHeaders, {
  allowlist: ['x-tenant-id', 'x-correlation-id'],
});
// { traceparent: '00-abc...', tracestate: '...', 'x-tenant-id': 'acme' }

// Subscriber side — reconstruct headers from Pub/Sub attributes
const headers = extractContext(message.attributes, {
  allowlist: ['x-tenant-id', 'x-correlation-id'],
});
// Same shape as above — symmetric round-trip
```

### Propagation security rules

Message attributes are an **unredacted channel**: they travel over the wire,
appear in logs, and are copied to the dead-letter topic. The library is
deliberately strict here:

- **`traceparent` and `tracestate` propagate automatically.** W3C correlation
  identifiers are not user data.
- **All other headers are allowlist-only.** Nothing else crosses the hop.
  A default allowlist ships with safe standard correlation headers; extend it
  with the specific business headers you want to travel.
- **W3C `baggage` is off by default.** `baggage` is the classic PII-leak
  vector. Enable with `{ baggage: true }` only when you control both ends and
  can guarantee no PII is in baggage values.
- **Do not put PII in propagated headers.** Attributes are not redacted. The
  allowlist controls *what* travels; it does not sanitize values.

---

## 5. Core algorithms

> Implemented. See [docs/use-cases/04-backoff-strategies.ts](use-cases/04-backoff-strategies.ts)
> and [docs/use-cases/05-jitter.ts](use-cases/05-jitter.ts).

### `calculateBackoff`

```typescript
import { calculateBackoff } from 'resilient-pubsub/core';

const delayMs = calculateBackoff(attempt, {
  strategy: 'exponential', // 'exponential' | 'linear' | 'constant'
  initialDelay: 1000,      // ms — default 1 000
  maxDelay: 30_000,        // ms — default 30 000
  multiplier: 2,           // used by exponential only — default 2
});
```

### `applyJitter`

```typescript
import { applyJitter } from 'resilient-pubsub/core';

const jittered = applyJitter(delayMs, 'full'); // 'full' | 'equal' | 'decorrelated' | 'none'
```

### `classify` / `isRetryable`

```typescript
import { classify, isRetryable } from 'resilient-pubsub/core';

classify({ code: 14 });    // 'transient'
classify({ code: 7 });     // 'permanent'
isRetryable({ code: 14 }); // true
isRetryable({ code: 7 });  // false
```

### Backoff strategies table

| Strategy      | Formula | Default |
|---------------|---------|---------|
| `exponential` | `initialDelay × multiplier^(attempt−1)` | yes |
| `linear`      | `initialDelay × attempt` | — |
| `constant`    | `initialDelay` always | — |

All strategies are capped at `maxDelay` (default 30 000 ms).

### Jitter algorithms table

Four jitter algorithms prevent thundering-herd problems when many instances
retry concurrently:

| Strategy       | Distribution | Use when |
|----------------|-------------|---------|
| `full`         | `[0, baseDelay]` | Maximum spread (AWS-recommended default) |
| `equal`        | `[baseDelay/2, baseDelay]` | Guaranteed minimum delay |
| `decorrelated` | `[initialDelay, previousDelay × 3]` | Smooth, less-correlated spread |
| `none`         | Exact `baseDelay` | Deterministic tests |

---

## 6. Hooks & Observability

> v0.1 — target API, wired into publisher and subscriber options. In progress.
> See [docs/VISION.md](VISION.md) § "What this library is" (point 6).

The library emits neutral lifecycle callbacks. Wire them to any observability
backend (OpenTelemetry, Prometheus, winston, pino) without any SDK dependency.

```typescript
// Target v0.1 API (see docs/VISION.md) — hooks in progress.
const publisher = createResilientPublisher({
  topic: 'orders',
  onRetry: (err, attempt, delayMs) => {
    logger.warn('publish retry', { attempt, delayMs, kind: err.kind });
  },
});

const worker = createResilientSubscriber({
  subscription: 'orders-worker',
  onNack: (msg, err) => {
    metrics.increment('pubsub.nack', { topic: msg.meta.messageId });
  },
  onPoison: (msg, err) => {
    // SerializationError — message will not be retried; going to DLQ.
    logger.error('poison message detected', err.toJSON());
  },
  onDeadLetter: (msg) => {
    // Reached maxDeliveryAttempts — routed to the dead-letter topic.
    alerting.fire('dead_letter', { messageId: msg.meta.messageId });
  },
});
```

The library transports W3C trace context (see [Context propagation](#4-context-propagation))
but does **not** create spans. Wire your own tracing in the hooks.

---

## 7. Testing your integration

The simplest approach is the [Pub/Sub emulator](https://cloud.google.com/pubsub/docs/emulator):

```bash
# Start the emulator
gcloud beta emulators pubsub start --project=test-project

# Point your process at it
export PUBSUB_EMULATOR_HOST=localhost:8085
export GOOGLE_CLOUD_PROJECT=test-project
```

The `@google-cloud/pubsub` client detects `PUBSUB_EMULATOR_HOST` automatically
and routes all calls to the emulator — no code changes needed.

For unit tests, inject a mock `PubSub` client through the `pubSubClient` option
(see [docs/use-cases/10-deployment-patterns.ts](use-cases/10-deployment-patterns.ts)).

The two end-to-end consumer repositories run against the emulator in CI:
`resilient-pubsub-e2e` (plain Node worker) and `resilient-pubsub-e2e-nestjs`
(NestJS app). They enforce the ergonomics budget on real consumer code.
