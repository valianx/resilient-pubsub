# Resilient PubSub

A transparent, framework-agnostic resilience layer around `@google-cloud/pubsub`.

> **Under active development — not ready for production use.**
>
> v0.0.0 is pre-release. APIs may change without notice until the first stable
> release. The package is not yet published to npm. Install instructions below
> show the intended form once published.

[![npm version](https://img.shields.io/npm/v/resilient-pubsub.svg)](https://www.npmjs.com/package/resilient-pubsub)
[![CI](https://github.com/valianx/resilient-pubsub/actions/workflows/ci.yml/badge.svg)](https://github.com/valianx/resilient-pubsub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue.svg)](https://www.typescriptlang.org/)

Zero runtime dependencies in the core, with `@google-cloud/pubsub` as the only
required peer. It wraps the official client transparently — it never takes the
transport away from you.

---

## 📦 Installation

Once published:

```bash
# pnpm (recommended)
pnpm add resilient-pubsub @google-cloud/pubsub

# npm
npm install resilient-pubsub @google-cloud/pubsub

# yarn
yarn add resilient-pubsub @google-cloud/pubsub
```

`@google-cloud/pubsub` **^5.x** is a required peer dependency.
`redis` **^4–6** is an optional peer — needed only for the future
`IdempotencyStore` feature (deferred to v0.2; see [ROADMAP.md](ROADMAP.md)).

**Requirement:** Node.js >= 24.0.0.

---

## 🚀 Quick Start

### Publisher

Retry, backoff, jitter, and context propagation are on by default.
`publish()` retries internally and rejects with a typed `ResilientPubSubError`
if it exhausts retries — it never silently drops an event.

```typescript
// Target v0.1 API (see docs/VISION.md) — publisher implementation in progress.
import { createResilientPublisher } from 'resilient-pubsub';

const publisher = createResilientPublisher<OrderCreated>({ topic: 'orders' });

try {
  await publisher.publish({
    body: { orderId: '42', amount: 99.99 },
    headers: { 'x-tenant-id': 'acme' }, // allowlist-gated, never leaks PII
  });
} catch (err) {
  // Permanent publish failure — alert, persist, or fail the request.
  // The library retries; it does NOT hide a permanently lost event.
}
```

### Subscriber

Throw → nack (retry). Return → ack (done). The library catches your handler's
throw — **do not** write try/catch in the handler body.

```typescript
// Target v0.1 API (see docs/VISION.md) — subscriber implementation in progress.
import { createResilientSubscriber } from 'resilient-pubsub';

const worker = createResilientSubscriber<OrderCreated>({
  subscription: 'orders-worker',
});

worker.on(async (msg) => {
  msg.body;    // OrderCreated — typed, already deserialized
  msg.headers; // { 'x-tenant-id': 'acme' } — same shape you published
  msg.meta;    // messageId, deliveryAttempt, publishTime, orderingKey
  // throw to nack (retry), return to ack (done)
});

worker.start();

// Graceful shutdown — drain in-flight handlers before the process exits.
// Essential on GKE / Cloud Run where SIGTERM is routine.
process.on('SIGTERM', () => worker.stop());
```

---

## 📚 Core Concepts

### The message contract — symmetric `{ body, headers }`

You **publish** `{ body, headers }` and you **receive** `{ body, headers, meta }`.
One message shape, learned once, used everywhere.

| Field     | Publish | Consume | Notes |
|-----------|---------|---------|-------|
| `body`    | yes     | yes     | Typed `T`, JSON-serialized by default |
| `headers` | yes     | yes     | Allowlist-gated; marshalled to/from Pub/Sub attributes |
| `meta`    | —       | yes     | `messageId`, `publishTime`, `deliveryAttempt`, `orderingKey` |

`meta` exists **only on consume** — Pub/Sub populates it at delivery. The
publish side does not pretend to accept it.

### Ack means done. No-ack means retry.

The library is built on Pub/Sub's own delivery contract:

- **Handler returns** → `ack()` — the work is finished; Pub/Sub will not redeliver.
- **Handler throws** → `nack()` — Pub/Sub redelivers; the handler runs again.

The library **catches** your handler's throw and nacks it. You do not write
try/catch in the handler — doing so would silently swallow errors and break the
retry contract.

### Idempotency is the application's responsibility

Pub/Sub is **at-least-once**: a handler that succeeds but whose `ack()` is lost
(crash, network, expired deadline) will be redelivered and run again. The
library makes the *lifecycle* correct — failure reliably retries, success
reliably acks — but it cannot make a non-idempotent business effect safe to run
twice.

Make your effects tolerate redelivery (deterministic keys, upserts, "insert if
not exists"). See [Idempotency is a shared responsibility](docs/VISION.md#idempotency-is-a-shared-responsibility)
in the vision document.

### Graceful shutdown — `stop()` drains in-flight handlers

`stop()` stops pulling new messages, waits for in-flight handlers up to a
configurable timeout, and nacks anything still running so it is cleanly
redelivered, never lost. Wire it to SIGTERM/SIGINT in every deployment.

---

## 🧱 API Reference

### `createResilientPublisher<T>(options)` — v0.1, in progress

> Target v0.1 API (see [docs/VISION.md](docs/VISION.md)).

```typescript
import { createResilientPublisher } from 'resilient-pubsub';
// or, for tree-shaking in publisher-only apps:
import { createResilientPublisher } from 'resilient-pubsub/publisher';

const publisher = createResilientPublisher<T>({
  topic: string;                 // Required: Pub/Sub topic name
  pubSubClient?: PubSub;         // Optional: inject an existing client
  // retry, backoff, jitter, propagation knobs — all have safe defaults
});

await publisher.publish({ body: T, headers?: Record<string, string> });
```

`publish()` rejects with `ResilientPubSubError` when it exhausts retries.

### `createResilientSubscriber<T>(options)` — v0.1, in progress

> Target v0.1 API (see [docs/VISION.md](docs/VISION.md)).

```typescript
import { createResilientSubscriber } from 'resilient-pubsub';
// or:
import { createResilientSubscriber } from 'resilient-pubsub/subscriber';

const worker = createResilientSubscriber<T>({
  subscription: string;          // Required: Pub/Sub subscription name
  pubSubClient?: PubSub;         // Optional: inject an existing client
  // deadLetterPolicy, flowControl, maxExtension, etc. — safe defaults
});

worker.on(async (msg: { body: T; headers: Record<string, string>; meta: EnvelopeMeta }) => {
  // throw → nack, return → ack
});

worker.start();
await worker.stop();  // graceful drain
```

### `Envelope<T>` / `Serializer<T>` / `JsonSerializer<T>` — implemented

```typescript
import { Envelope, JsonSerializer } from 'resilient-pubsub/envelope';
import type { Serializer } from 'resilient-pubsub/envelope';

// Outbound envelope (publish side — no meta)
const env = Envelope.outbound<OrderCreated>(body, attributes);

// Inbound envelope (consume side — with frozen meta)
const env = Envelope.inbound<OrderCreated>(body, attributes, meta);

// Default JSON serializer
const serializer = new JsonSerializer<OrderCreated>();
const bytes = serializer.serialize({ orderId: '42' });
const body  = serializer.deserialize(bytes);
```

### `ResilientPubSubError` / `isResilientPubSubError` / `SerializationError` — implemented

```typescript
import { ResilientPubSubError, isResilientPubSubError, SerializationError } from 'resilient-pubsub/errors';

try {
  await publisher.publish(envelope);
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

Use `isResilientPubSubError(err)` — not `instanceof` — so the brand check
works across module/realm boundaries (monorepos, duplicate installs).

`SerializationError` is a fixed-semantics subclass:
`kind === 'serialization'`, `classification === 'poison'`, `retryable === false`.
A poison message should never be retried; route it to a dead-letter queue.

### `injectContext` / `extractContext` — implemented

```typescript
import { injectContext, extractContext, W3C_TRACE_HEADERS } from 'resilient-pubsub/propagation';
import type { PropagationOptions, Headers } from 'resilient-pubsub/propagation';

// Outbound: extract headers to embed in Pub/Sub attributes
const attrs = injectContext(requestHeaders, {
  allowlist: ['x-tenant-id', 'x-correlation-id'],
});

// Inbound: reconstruct headers from Pub/Sub attributes
const headers = extractContext(message.attributes, {
  allowlist: ['x-tenant-id', 'x-correlation-id'],
});
```

### `calculateBackoff` / `applyJitter` / `classify` / `isRetryable` — implemented

```typescript
import { calculateBackoff, applyJitter, classify, isRetryable } from 'resilient-pubsub/core';

const delayMs = calculateBackoff(attempt, { strategy: 'exponential', initialDelay: 1000 });
const jittered = applyJitter(delayMs, 'full');

classify({ code: 14 });   // 'transient'
classify({ code: 7 });    // 'permanent'
isRetryable({ code: 14 }); // true
```

---

## 🔁 Backoff & Jitter

Three backoff strategies (via `calculateBackoff`):

| Strategy      | Formula | Default |
|---------------|---------|---------|
| `exponential` | `initialDelay × multiplier^(attempt−1)` | yes |
| `linear`      | `initialDelay × attempt` | — |
| `constant`    | `initialDelay` always | — |

All strategies are capped at `maxDelay` (default 30 000 ms).

Four jitter algorithms (via `applyJitter`) — prevent thundering-herd when many
instances retry concurrently:

| Strategy       | Distribution | Use when |
|----------------|-------------|---------|
| `full`         | `[0, baseDelay]` | Maximum spread (AWS-recommended default) |
| `equal`        | `[baseDelay/2, baseDelay]` | Guaranteed minimum delay |
| `decorrelated` | `[initialDelay, previousDelay × 3]` | Smooth, less-correlated spread |
| `none`         | Exact `baseDelay` | Deterministic tests |

See [docs/use-cases/04-backoff-strategies.ts](docs/use-cases/04-backoff-strategies.ts)
and [docs/use-cases/05-jitter.ts](docs/use-cases/05-jitter.ts) for runnable examples.

---

## 🧯 Error Handling

Every error the library surfaces is a `ResilientPubSubError`:

| `kind`          | When |
|-----------------|------|
| `'publish'`     | Publish failed (gRPC error, quota, unavailable) |
| `'subscribe'`   | Subscriber setup or stream management error |
| `'process'`     | Error thrown inside a user handler (wrapped for observability) |
| `'serialization'` | Body could not be serialized or deserialized |
| `'ack'`         | Failure acknowledging or nacking a message |
| `'config'`      | Invalid library configuration detected at runtime |

```typescript
import { ResilientPubSubError, isResilientPubSubError, SerializationError } from 'resilient-pubsub/errors';

try {
  await publisher.publish({ body: payload, headers });
} catch (err) {
  if (isResilientPubSubError(err)) {
    if (err.classification === 'transient') {
      // Exhausted retries on a transient error — escalate / alert.
    } else if (err.classification === 'permanent') {
      // Bad config or missing resource — do not retry.
    } else if (err.classification === 'poison') {
      // Unprocessable message — route to DLQ.
    }

    // Always log-safe: body, cause, and meta are never included.
    logger.error('publish failed', err.toJSON());
  }
}
```

`SerializationError` is always poison (`retryable: false`). A message that
cannot be deserialized should never loop through retries — route it to a
dead-letter queue or discard it.

`toJSON()` is safe by default: it caps the message at 512 characters, redacts
secrets (GCP key paths, credential strings), and never includes `body`, `cause`,
`meta`, or raw attributes.

See [docs/use-cases/06-error-handling.ts](docs/use-cases/06-error-handling.ts).

---

## 🔌 Context Propagation

This is a first-class differentiator: trace context and allowlisted business
headers travel automatically from publisher to consumer across the message hop.

**Zero dependencies.** Pure W3C-standard string marshalling. No OpenTelemetry
SDK, no gRPC interceptors.

```typescript
import { injectContext, extractContext } from 'resilient-pubsub/propagation';

// Publisher side — embed headers into attributes
const attrs = injectContext(incomingRequestHeaders, {
  allowlist: ['x-tenant-id', 'x-correlation-id'],
});
// { traceparent: '00-abc...', tracestate: '...', 'x-tenant-id': 'acme' }

// Subscriber side — reconstruct headers from attributes
const headers = extractContext(message.attributes, {
  allowlist: ['x-tenant-id', 'x-correlation-id'],
});
// Same shape as above — symmetric round-trip
```

**Security rules:**

- `traceparent` and `tracestate` (W3C correlation IDs) propagate **automatically**.
- All other headers are **allowlist-only** — nothing else crosses the hop.
- W3C `baggage` is **off by default** — it is the classic PII-leak vector.
  Enable with `{ baggage: true }` only when you control both ends and can
  guarantee no PII is in baggage values.
- Attributes are an unredacted channel (wire, logs, DLQ). The allowlist
  controls *what* travels; it does not redact.

**Do not put PII in propagated headers.** Attributes are not redacted.

See [docs/use-cases/07-context-propagation.ts](docs/use-cases/07-context-propagation.ts)
for a complete example including cross-hop forwarding.

---

## 🪝 Hooks & Observability

> Hooks are part of the v0.1 target API per [docs/VISION.md](docs/VISION.md)
> — wired into the publisher and subscriber options. **In progress.**

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

The library transports W3C trace context (see [🔌 Context Propagation](#-context-propagation))
but does **not** create spans. Wire your own tracing in the hooks.

---

## 🧪 Testing Your Integration

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
(see [docs/use-cases/10-deployment-patterns.ts](docs/use-cases/10-deployment-patterns.ts)).

The two end-to-end consumer repositories run against the emulator in CI:
`resilient-pubsub-e2e` (plain Node worker) and `resilient-pubsub-e2e-nestjs`
(NestJS app). They enforce the ergonomics budget on real consumer code.

---

## 🤝 Contributing

Contributions are welcome. The library is framework-agnostic and zero-dependency
in the core by design — orchestration patterns belong in consumer code.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions, and the
PR process.

---

## 📄 License

MIT

---

## 🗺️ Roadmap / Use cases

- [ROADMAP.md](ROADMAP.md) — versioned feature plan
- [docs/VISION.md](docs/VISION.md) — design intent, guarantees, and honest limits
- [docs/configuration.md](docs/configuration.md) — full configuration reference
  (deployment patterns, env vars, shared client)
- [docs/use-cases/](docs/use-cases/) — runnable examples for each feature

---

## 🧭 Design Principles

These are inherited from [`resilient-http`](https://github.com/valianx/resilient-http),
the sibling library:

- **Zero-config by default.** Works from environment variables and safe
  defaults. Configuration changes a default; it never *enables* resilience.
- **Transparent, never a black box.** Wraps the official client; never hides
  it. Advanced callers can always reach the underlying `Topic`, `Subscription`,
  and `Message`.
- **Security-first.** Secrets and PII are redacted from error output by
  default. Propagation onto message attributes is allowlist-gated — the
  unredacted-channel risk is controlled, not ignored.
- **Honest guarantees over marketing.** At-least-once is stated plainly;
  exactly-once is never claimed. The library under-promises and earns trust.
- **Zero runtime dependencies in the core, with explicit peers.** The core
  (backoff, jitter, envelope, errors, propagation) has zero runtime
  dependencies and is tree-shakeable. The required peer is
  `@google-cloud/pubsub`; the optional peer (for the future IdempotencyStore)
  is `redis`.
- **Correctness over convenience.** When a trade-off exists between an easy
  default and a correct one, the library chooses correct and documents the knob.
- **Framework-agnostic.** No coupling to any web framework or DI container.
  Works the same in a plain script, in NestJS, or in any worker.

---

## 🇪🇸 ¿Qué hace esta librería?

`resilient-pubsub` es una capa de resiliencia transparente alrededor del cliente
oficial `@google-cloud/pubsub`. Agrega reintentos con backoff y jitter, un ciclo
de vida correcto de ack/nack, envelopes tipados y simétricos (`{ body, headers }`),
propagación de contexto W3C entre saltos, soporte nativo de dead-letter y una
superficie de error segura — todo sin dependencias en tiempo de ejecución en el
núcleo. El cliente subyacente queda siempre accesible.

## 🇬🇧 What this library does (English)

`resilient-pubsub` is a transparent resilience layer around the official
`@google-cloud/pubsub` client. It adds retry with backoff and jitter, a correct
ack/nack lifecycle, typed symmetric envelopes (`{ body, headers }`), W3C context
propagation across message hops, opt-in native dead-letter support, and a safe
error surface — all with zero runtime dependencies in the core. The underlying
client is always accessible.
