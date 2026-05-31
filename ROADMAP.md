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

- **Dead-letter startup preflight.** For subscribers that opt into dead-letter
  handling, validate at startup that `deadLetterPolicy` is set and that the
  required IAM grants exist (the Pub/Sub service account needs `pubsub.publisher`
  on the dead-letter topic and `pubsub.subscriber` on the source subscription),
  failing loudly on misconfiguration. The preflight runs only for subscribers
  that opted in — projects that do not use dead-letter pay no cost. This
  *validates*, it does not *provision* (provisioning stays a non-goal). v0.1
  ships the native `deadLetterPolicy` pass-through and documents the
  requirements; the preflight lands here.
- **Transactional `IdempotencyStore` adapter** (e.g., Postgres). Lets the
  deduplication mark and the side effect commit in the same transaction, closing
  the two-phase gap described in `docs/VISION.md` § "Idempotency: an honest
  contract". This is the path to a true exactly-once guarantee for
  non-idempotent sinks; the v0.1 Redis store reduces duplicates but cannot make
  the mark and a separate effect atomic.
- **App-level DLQ** (`deadLetter: { mode: 'app', topic }`): republish the
  envelope to a dead-letter topic with redacted error metadata (no secrets/PII;
  raw body only with explicit opt-in). v0.1 ships native `deadLetterPolicy`
  pass-through only.
- **Advanced exactly-once *processing*** beyond deterministic idempotency-based
  deduplication.
