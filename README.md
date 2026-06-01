# Resilient PubSub

A transparent, framework-agnostic resilience layer around `@google-cloud/pubsub`.

> **Implemented, not yet published.**
>
> v0.0.0 is pre-release. The API is implemented and tested (v0.1).
> The package is not yet published to npm. Install instructions below
> show the intended form once published.

[![npm version](https://img.shields.io/npm/v/resilient-pubsub.svg)](https://www.npmjs.com/package/resilient-pubsub)
[![CI](https://github.com/valianx/resilient-pubsub/actions/workflows/ci.yml/badge.svg)](https://github.com/valianx/resilient-pubsub/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue.svg)](https://www.typescriptlang.org/)

Zero runtime dependencies in the core, with `@google-cloud/pubsub` as the only
required peer. It wraps the official client transparently — it never takes the
transport away from you.

## Features

- **Resilient publish** — retry with exponential / linear / constant backoff and full / equal / decorrelated jitter
- **Correct ack/nack lifecycle** — handler throws → nack (retry); handler returns → ack (done); `stop()` drains gracefully
- **Symmetric typed envelope** — publish `{ body, headers }`, receive `{ body, headers, meta }` — one shape, learned once
- **W3C context propagation** — trace context and allowlisted business headers cross the message hop automatically, zero dependencies
- **Opt-in native dead-letter** — native `deadLetterPolicy` pass-through with `deliveryAttempt` surfaced on the envelope
- **Safe error surface** — `ResilientPubSubError` with explicit kinds, classifications, and `toJSON()` that never leaks secrets or PII
- **TypeScript-first** — full type definitions included; publisher and subscriber share the same typed `T`
- **Zero-dep core** — backoff, jitter, envelope, errors, and propagation have zero runtime dependencies; tree-shakeable

## Installation

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
**Requirement:** Node.js >= 24.0.0.

## Quick Start

### Publisher

Retry, backoff, jitter, and context propagation are on by default.
`publish()` retries internally and rejects with a typed `ResilientPubSubError`
if it exhausts retries — it never silently drops an event.

```typescript
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
throw — do not write try/catch in the handler body.

```typescript
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

See [docs/use-cases/](./docs/use-cases/) for the full example set, including
deployment patterns, backoff strategies, context propagation, dead-letter, and
graceful shutdown.

## Error handling

Every failure the library surfaces is a `ResilientPubSubError` with an explicit
`kind` (`'publish'` / `'subscribe'` / `'process'` / `'serialization'` / `'ack'`
/ `'config'`) and `classification` (`'transient'` / `'permanent'` / `'poison'`).
`toJSON()` is safe by default and never includes the message body, cause, or raw
attributes.

```typescript
import { isResilientPubSubError } from 'resilient-pubsub/errors';

try {
  await publisher.publish({ body: payload, headers });
} catch (err) {
  if (isResilientPubSubError(err)) {
    logger.error('publish failed', err.toJSON()); // log-safe
  }
}
```

Use `isResilientPubSubError(err)` — not `instanceof` — so the check works across
module/realm boundaries. See the full error reference and the `SerializationError`
poison-message pattern in [docs/api-reference.md](./docs/api-reference.md#3-error-surface)
and [docs/use-cases/06-error-handling.ts](./docs/use-cases/06-error-handling.ts).

## Documentation

### [docs/VISION.md](./docs/VISION.md) — Design intent, guarantees, and honest limits

The problem the library solves, the core model (ack/nack), the message contract,
the ergonomics budget, idempotency responsibility, dead-letter handling, and
guiding principles.

### [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — Module structure and dependency hierarchy

Module layout, subpath exports, dependency rules, and build configuration.

### [docs/configuration.md](./docs/configuration.md) — Full configuration reference

Environment variables, deployment patterns (publisher-only / subscriber-only /
both), shared client injection, and the `RESILIENT_PUBSUB_*` env-var convention.

### [docs/api-reference.md](./docs/api-reference.md) — Full API reference

All public APIs with types, code samples, and tables:
factory functions, `Envelope<T>`, `Serializer<T>`, `ResilientPubSubError`,
context propagation, backoff/jitter algorithms, hooks, and testing.

### [docs/use-cases/](./docs/use-cases/) — Runnable examples

| File | Feature illustrated | Status |
|------|---------------------|--------|
| [01-quickstart-publisher.ts](./docs/use-cases/01-quickstart-publisher.ts) | `createResilientPublisher` + `publish` + error handling | Implemented |
| [02-quickstart-subscriber.ts](./docs/use-cases/02-quickstart-subscriber.ts) | `createResilientSubscriber` + handler + `start()` + SIGTERM | Implemented |
| [03-message-envelope.ts](./docs/use-cases/03-message-envelope.ts) | `Envelope` outbound/inbound, `JsonSerializer`, custom `Serializer` | Implemented |
| [04-backoff-strategies.ts](./docs/use-cases/04-backoff-strategies.ts) | `calculateBackoff` across exponential / linear / constant | Implemented |
| [05-jitter.ts](./docs/use-cases/05-jitter.ts) | `applyJitter` across full / equal / decorrelated / none | Implemented |
| [06-error-handling.ts](./docs/use-cases/06-error-handling.ts) | `ResilientPubSubError` kinds, `isResilientPubSubError`, `toJSON()` | Implemented |
| [07-context-propagation.ts](./docs/use-cases/07-context-propagation.ts) | `injectContext` / `extractContext`, allowlist, baggage, cross-hop | Implemented |
| [08-dead-letter.ts](./docs/use-cases/08-dead-letter.ts) | Native dead-letter policy builder, `onPoison` hook, `deliveryAttempt` | Implemented |
| [09-graceful-shutdown.ts](./docs/use-cases/09-graceful-shutdown.ts) | `stop()` drain wired to SIGTERM/SIGINT | Implemented |
| [10-deployment-patterns.ts](./docs/use-cases/10-deployment-patterns.ts) | Publisher-only / consumer-only / both; subpath imports; shared client | Implemented |

### [ROADMAP.md](./ROADMAP.md) — Versioned feature plan

What ships in v0.1, what is deferred to v0.2, and the definition of done for
the first public release.

## Contributing

Contributions are welcome. The library is framework-agnostic and zero-dependency
in the core by design — orchestration patterns belong in consumer code. Please
read [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, conventions, and the PR
process.

## License

MIT

---

## En español / In English

**🇪🇸** `resilient-pubsub` es una capa de resiliencia transparente alrededor del cliente
oficial `@google-cloud/pubsub`. Agrega reintentos con backoff y jitter, un ciclo de vida
correcto de ack/nack, envelopes tipados y simétricos (`{ body, headers }`), propagación de
contexto W3C entre saltos, soporte nativo de dead-letter y una superficie de error segura —
todo sin dependencias en tiempo de ejecución en el núcleo.

**🇬🇧** `resilient-pubsub` is a transparent resilience layer around the official
`@google-cloud/pubsub` client. It adds retry with backoff and jitter, a correct ack/nack
lifecycle, typed symmetric envelopes (`{ body, headers }`), W3C context propagation across
message hops, opt-in native dead-letter support, and a safe error surface — all with zero
runtime dependencies in the core.
