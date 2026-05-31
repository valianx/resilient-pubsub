# Vision — resilient-pubsub

> Why this library exists, what it promises, and the boundaries it will not cross.

## The problem

Google Cloud Pub/Sub gives you a reliable transport, but it deliberately leaves
the hard correctness problems to the application:

- **Delivery is at-least-once.** Every subscriber *will* eventually see a
  duplicate. Exactly-once *delivery* is available per-subscription, but it is not
  exactly-once *processing*: a crash between "side effect applied" and "ack
  confirmed" still re-applies the effect. The robust guarantee has to come from
  an application-level deduplication layer.
- **Retries, backoff, and jitter are your job.** The raw client surfaces gRPC
  errors; deciding what is transient, how long to wait, and how to avoid a
  thundering herd is left to the caller.
- **Poison messages need a policy.** Native dead-letter topics exist, but wiring
  `deadLetterPolicy`, the IAM grants, and the delivery-attempt accounting is
  manual and easy to get subtly wrong.
- **Message shape is unstructured.** Attributes are a flat string map and the
  body is raw bytes. Teams reinvent an envelope, a content-type convention, and a
  schema-version marker on every project.

`resilient-pubsub` closes these gaps **without taking the transport away from
you**.

## What this library is

A transparent, framework-agnostic resilience layer that wraps the official
`@google-cloud/pubsub` client and adds:

1. **Idempotency** — deduplication of message processing through a pluggable
   `IdempotencyStore`. Redis is the preferred backing store, but the interface is
   storage-agnostic; an in-memory store ships for tests and single-instance use.
2. **Structured envelopes** — a typed `Envelope<T>` plus a pluggable
   `Serializer<T>` (JSON by default), with content-type and schema-version
   carried in attributes.
3. **Retries** — backoff and jitter primitives (exponential / linear / constant
   backoff; full / equal / decorrelated / none jitter) for both publish and
   subscriber processing.
4. **Dead-letter handling** — native `deadLetterPolicy` pass-through with the IAM
   requirements documented and the `delivery_attempt` surfaced on the envelope.
5. **A safe, standardized error surface** — `ResilientPubSubError` with explicit
   kinds and a `toJSON()` that never leaks secrets or PII by default.

## Guiding principles

These are inherited directly from `resilient-http`, the sibling library.

- **Framework-agnostic.** No coupling to any web framework, DI container, or
  runtime beyond Node.js. It works the same in a plain script, in NestJS, or in
  any worker.
- **Transparent, never a black box.** The library wraps the official client; it
  does not hide it. Advanced users can always reach the underlying `Topic`,
  `Subscription`, and `Message` for cases the wrapper does not cover.
- **Security-first, in every sense.** Secrets (GCP key paths, Redis URLs with
  credentials) and PII are redacted from error output by default. The message
  body is never serialized into error JSON unless explicitly opted in.
  Supply-chain hygiene is part of the contract: GitHub Actions pinned by commit
  SHA, dependency review, and provenance on publish.
- **Minimal dependency footprint.** The core (backoff, jitter, envelope, errors)
  is zero runtime dependencies and tree-shakeable. `@google-cloud/pubsub` is a
  required peer; the Redis client is an optional peer. The backoff/jitter core is
  reimplemented here, not imported from `resilient-http` — these are independent
  libraries.
- **Correctness over convenience.** Defaults are safe. When a trade-off exists
  between an easy default and a correct one, the library chooses correct and
  documents the knob.

## Non-goals

- It is **not** a message broker or a Pub/Sub replacement.
- It does **not** abstract away Google Cloud Pub/Sub behind a generic
  multi-broker interface. It is Pub/Sub-specific on purpose.
- It does **not** own your business logic for what counts as a duplicate beyond
  providing a configurable key extractor.
- It does **not** manage infrastructure (topic/subscription/IAM provisioning);
  it documents the requirements and works against resources you provision.

## Scope

**v0.1 (current cycle):** publisher resilience, subscriber resilience,
idempotency (agnostic store + in-memory + Redis), and **native** dead-letter
support — plus complete documentation, end-to-end tests against the Pub/Sub
emulator and Redis, and full governance (security policy, contributing guide,
Dependabot, branch protection).

**Deferred (see `ROADMAP.md`):** application-level dead-letter republishing with
redacted error metadata, advanced exactly-once *processing* beyond deterministic
idempotency, and a Bun test/CI matrix.

## Definition of done

Nothing is published to npm until the entire surface is complete and verified:
end-to-end suites green in CI on both consumer repositories, README usage
documentation finished, CHANGELOG current, security and contributing policies in
place, Dependabot enabled, and `main` protected. The first release is the last
gate, not the first milestone.
