# Roadmap

This document tracks deferred work for **resilient-pubsub**. Items here are
intentionally out of scope for the current release cycle and are recorded so the
decisions are not lost.

## Deferred to a later release

### Runtime support
- **Bun test runner / Bun CI matrix.** The initial scaffold included a Bun CI
  job, but it was removed to keep CI focused on the Node.js 24 target during the
  v0.1 build. Bun support (a `bun test` job alongside the Node.js job, and
  validation that the published package works under Bun) is deferred. The
  `test` script (`bun test`) remains in `package.json` for local use.

## v0.2 backlog (post v0.1)

- **Optional `IdempotencyStore` deduplication tool (Redis).** v0.1 deliberately
  ships without a built-in dedup store: Pub/Sub's ack/nack lifecycle already
  gives "fails → repeats", and deduplicating business effects is the
  application's responsibility (see `docs/VISION.md` § "Idempotency is a shared
  responsibility"). A dedup store helps only in a narrow case — a non-idempotent
  effect that cannot be made idempotent, running across multiple instances (e.g.
  sending an email, calling a non-idempotent third-party API). For those teams,
  v0.2 adds an **optional** `IdempotencyStore` interface with an in-memory
  implementation (single-instance / tests) and a Redis implementation
  (multi-instance). Its limits will be documented plainly: it *reduces* duplicate
  handler executions; it does not eliminate them (the mark and the effect live in
  separate systems and cannot commit atomically), and it is never sold as
  exactly-once. Redis would become the only new optional peer — no other
  dependency is added.
- **Dead-letter startup preflight.** For subscribers that opt into dead-letter
  handling, validate at startup that `deadLetterPolicy` is set and that the
  required IAM grants exist (the Pub/Sub service account needs `pubsub.publisher`
  on the dead-letter topic and `pubsub.subscriber` on the source subscription),
  failing loudly on misconfiguration. The preflight runs only for subscribers
  that opted in — projects that do not use dead-letter pay no cost. This
  *validates*, it does not *provision* (provisioning stays a non-goal). v0.1
  ships the native `deadLetterPolicy` pass-through and documents the
  requirements; the preflight lands here.
- **App-level DLQ** (`deadLetter: { mode: 'app', topic }`): republish the
  envelope to a dead-letter topic with redacted error metadata (no secrets/PII;
  raw body only with explicit opt-in). v0.1 ships native `deadLetterPolicy`
  pass-through only.
- **Turnkey OpenTelemetry bridge (optional).** v0.1 already propagates W3C trace
  context across the publisher → consumer hop and exposes neutral observability
  hooks, with no SDK dependency. v0.2 may add an *optional* bridge that creates
  spans automatically via `@opentelemetry/api` (an optional peer) for teams that
  want it turnkey — the core stays dependency-free and backend-neutral.
