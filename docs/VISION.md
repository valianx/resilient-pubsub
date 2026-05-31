# Vision — resilient-pubsub

> Why this library exists, what it promises, what it deliberately does **not**
> promise, and the boundaries it will not cross.

## The problem

Google Cloud Pub/Sub gives you a reliable transport, but it deliberately leaves
the hard correctness problems to the application:

- **Delivery is at-least-once.** Every subscriber *will* eventually see a
  duplicate. Exactly-once *delivery* is available per-subscription, but it is not
  exactly-once *processing*: a crash between "side effect applied" and "ack
  confirmed" still re-applies the effect. The application needs a deduplication
  strategy — and, crucially, that strategy has limits of its own (see
  [Idempotency: an honest contract](#idempotency-an-honest-contract)).
- **Retries, backoff, and jitter are your job.** The raw client surfaces gRPC
  errors; deciding what is transient, how long to wait, and how to avoid a
  thundering herd is left to the caller.
- **Poison messages need a policy.** Native dead-letter topics exist, but wiring
  `deadLetterPolicy`, the IAM grants, and the delivery-attempt accounting is
  manual and easy to get subtly wrong — and a misconfiguration fails silently,
  surfacing only when a poison message loops forever in production.
- **Long processing fights the ack deadline.** If a handler runs longer than the
  ack deadline, Pub/Sub redelivers the message *while it is still being
  processed*. Without deadline extension, deduplication becomes the only thing
  standing between you and a double-effect.
- **Message shape is unstructured.** Attributes are a flat string map and the
  body is raw bytes. Teams reinvent an envelope, a content-type convention, and a
  schema-version marker on every project.

`resilient-pubsub` closes these gaps **without taking the transport away from
you**, and it is explicit about the gaps it can only *narrow* rather than close.

## What this library is

A transparent, framework-agnostic resilience layer that wraps the official
`@google-cloud/pubsub` client and adds:

1. **Idempotency** — deduplication of message processing through a pluggable
   `IdempotencyStore`, with a `claim → effect → commit` lifecycle and a leased
   in-progress marker. Redis is the preferred backing store; the interface is
   storage-agnostic; an in-memory store ships for tests and single-instance use.
   The guarantee it provides — and the assumptions it requires — are stated
   precisely below.
2. **Structured envelopes** — a typed `Envelope<T>` plus a pluggable
   `Serializer<T>` (JSON by default), with content-type and schema-version
   carried in attributes.
3. **Retries** — backoff and jitter primitives (exponential / linear / constant
   backoff; full / equal / decorrelated / none jitter) for both publish and
   subscriber processing.
4. **Ordering-aware publishing** — when ordering keys are enabled, the publisher
   preserves per-key order across retries and resumes publishing after a failure
   (`resumePublishing`) instead of silently reordering.
5. **Flow control and ack-deadline management** — `maxOutstandingMessages` /
   `maxOutstandingBytes` as documented pass-through, plus automatic ack-deadline
   extension while a handler is still running, so long processing does not
   trigger premature redelivery.
6. **Dead-letter handling** — native `deadLetterPolicy` pass-through. Dead-letter
   support is **opt-in**: a subscriber that does not configure it pays no cost
   and runs no checks. The `delivery_attempt` count is surfaced on the envelope.
7. **First-class observability** — lifecycle hooks for retries, deduplication
   hits/misses, dead-letter routing, and poison detection, plus an
   OpenTelemetry-compatible seam. For a resilience library, this is part of the
   value, not an add-on.
8. **A safe, standardized error surface** — `ResilientPubSubError` with explicit
   kinds and a `toJSON()` that never leaks secrets or PII by default.

## Idempotency: an honest contract

This is the most important section of this document, because it is the easiest
promise to overstate.

A generic `IdempotencyStore` does **not**, by itself, give you exactly-once
processing. It moves the at-least-once problem; it does not erase it. The reason
is a two-phase gap: the deduplication mark and the side effect usually live in
**different systems** (the mark in Redis, the effect in Postgres or a remote
API), and there is no atomic commit across the two.

There are four distinct hazards, and the library addresses them differently:

1. **Concurrent duplicate delivery** (two workers, same message, same instant).
   *Solved.* `claim()` is a single-round-trip atomic compare-and-set
   (Redis `SET key value NX PX <ttl>`). Exactly one worker wins (`claimed`); the
   others observe `in-progress` and nack. A read-then-write check would
   reintroduce the race — the store contract therefore requires atomicity.
2. **Claim then crash → key locked forever.** *Solved, with a trade-off.* The
   in-progress marker is a **lease with a TTL**. On expiry the key becomes
   reclaimable, so a dead worker does not poison the key permanently.
3. **Lease expiry vs ack deadline vs slow processing.** *Mitigated, not
   eliminated.* If the effect outlives the lease, a second worker can reclaim and
   process concurrently → a duplicate. The library mitigates this by extending
   the ack deadline while the handler runs and by recommending a lease TTL
   greater than the maximum expected processing time. It cannot make slow
   processing free.
4. **The two-phase commit gap (effect vs mark).** *Narrowed, not closed, in the
   general case.* Mark-before-effect plus a crash loses the effect;
   effect-before-mark plus a crash duplicates it. The `claim → effect → commit`
   lifecycle shrinks the duplicate window but does not remove it when the mark
   and the effect live in separate stores.

**The contract, stated plainly:**

> `resilient-pubsub` delivers **idempotent processing** when *either* (a) the
> deduplication mark and the side effect commit atomically in the same
> transactional store, *or* (b) the side effect is naturally idempotent in its
> sink. When neither holds — for example, a Redis dedup mark guarding a
> non-idempotent effect in a separate system — the library **reduces duplicate
> processing to a small window; it does not eliminate it.** It never silently
> claims exactly-once.

To let users reach the strong guarantee, the library offers two paths:

- **A transactional store adapter** so `claim`/`commit` can live in the same
  store as the side effect (e.g., a Postgres-backed store committing in the same
  transaction as the business write). *(Planned — see `ROADMAP.md`.)*
- **Guidance and helpers for idempotent sinks** (deterministic keys, upserts),
  so the effect itself absorbs duplicates.

### Deduplication key lifecycle (a design decision, not an implementation detail)

Because the key lifecycle directly affects the guarantee, it is part of the
vision:

- **Deduplication window.** A committed key is retained for a configurable TTL.
  Two deliveries of the same key *within* the window are deduplicated; deliveries
  *after* the window are treated as new. The window is a deliberate trade-off
  between memory and how far apart redeliveries can be safely caught — there is
  no infinite-memory exactly-once.
- **In-progress lease.** The pre-commit marker has its own (shorter) TTL, tuned
  to exceed the maximum expected processing time; see hazard 3 above.
- **Store eviction.** With Redis as the store, eviction policy matters: if keys
  can be evicted under memory pressure (`allkeys-lru` and similar), the dedup
  guarantee weakens silently. The library documents that the dedup keyspace
  should use a `noeviction` (or `volatile-ttl`) policy, or a dedicated instance,
  and surfaces an observability signal when a claim does not find a prior key it
  expected.

## Dead-letter handling: opt-in, with a v0.2 preflight

Dead-letter support is **optional and configured per subscriber**. A project that
does not need it sets nothing and incurs no checks. A project that does opt in
declares it explicitly, and — from v0.2 — can request a **startup preflight**
that validates the `deadLetterPolicy` and the required IAM grants (the Pub/Sub
service account needs `pubsub.publisher` on the dead-letter topic and
`pubsub.subscriber` on the source subscription) and fails loudly if they are
missing. This resolves the tension in the problem statement — "the wiring is easy
to get subtly wrong" — without crossing into infrastructure provisioning: the
library *verifies*, it does not *create*. The preflight only runs for subscribers
that opted into dead-letter handling. (v0.1 ships the native pass-through and
documents the requirements; the preflight validation lands in v0.2 — see
`ROADMAP.md`.)

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
- **Honest guarantees over marketing.** The library states what it can and
  cannot guarantee (see the idempotency contract). It would rather under-promise
  and be trusted by senior operators than over-promise and burn credibility in
  production.
- **Minimal dependency footprint.** The **core** (backoff, jitter, envelope,
  errors) has **zero runtime dependencies** and is tree-shakeable.
  `@google-cloud/pubsub` is a **required peer**; the Redis client is an
  **optional peer**. The accurate phrasing is "zero runtime dependencies in the
  core, with explicit peers" — never a bare "zero-dependency" claim, which would
  be misleading. The backoff/jitter core is reimplemented here, not imported from
  `resilient-http` — these are independent libraries.
- **Correctness over convenience.** Defaults are safe. When a trade-off exists
  between an easy default and a correct one, the library chooses correct and
  documents the knob.

## Non-goals

- It is **not** a message broker or a Pub/Sub replacement.
- It does **not** abstract away Google Cloud Pub/Sub behind a generic
  multi-broker interface. It is Pub/Sub-specific on purpose.
- It does **not** guarantee exactly-once processing in the general case — see the
  idempotency contract. It reduces duplicates; it eliminates them only under the
  stated atomicity / idempotent-sink assumptions.
- It does **not** decide your business definition of a duplicate beyond providing
  a configurable key extractor.
- It does **not** provision infrastructure (topics, subscriptions, IAM). It
  documents the requirements and, for dead-letter, can *validate* them at startup
  (v0.2) — but it never creates resources.

## Scope

**v0.1 (current cycle):** publisher resilience (including ordering-aware
publishing), subscriber resilience (including flow-control pass-through and
ack-deadline extension), idempotency (agnostic store + in-memory + Redis, with
the leased `claim → effect → commit` lifecycle), **opt-in native** dead-letter
support, and **first-class observability** (lifecycle hooks + OpenTelemetry
seam) — plus complete documentation, end-to-end tests against the Pub/Sub
emulator and Redis, and full governance (security policy, contributing guide,
Dependabot, branch protection).

**Deferred (see `ROADMAP.md`):**

- **Dead-letter startup preflight** — validate `deadLetterPolicy` + IAM grants
  for subscribers that opted into dead-letter handling, failing loudly on
  misconfiguration.
- **A transactional `IdempotencyStore` adapter** (e.g., Postgres) so the dedup
  mark and the side effect commit atomically — the path to a true exactly-once
  guarantee for non-idempotent sinks.
- **Application-level dead-letter republishing** with redacted error metadata
  (raw body only with explicit opt-in).
- **A Bun test/CI matrix.**

## Definition of done

Nothing is published to npm until the entire surface is complete and verified:
end-to-end suites green in CI on both consumer repositories, README usage
documentation finished, CHANGELOG current, security and contributing policies in
place, Dependabot enabled, and `main` protected. The first release is the last
gate, not the first milestone — a deliberate quality stance for a library that
sits on the path of money and events, accepting slower external feedback in
exchange for a stable, trustworthy first public version.
