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

- **App-level DLQ** (`deadLetter: { mode: 'app', topic }`): republish the
  envelope to a dead-letter topic with redacted error metadata (no secrets/PII;
  raw body only with explicit opt-in). v0.1 ships native `deadLetterPolicy`
  pass-through only.
- **Advanced exactly-once *processing*** beyond deterministic idempotency-based
  deduplication.
