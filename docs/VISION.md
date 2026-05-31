# Vision — resilient-pubsub

> Why this library exists, what it promises, what it deliberately does **not**
> promise, and the boundaries it will not cross.

## The problem

Google Cloud Pub/Sub gives you a reliable transport, but it deliberately leaves
several correctness and ergonomics problems to the application:

- **Publish can fail transiently.** The raw client surfaces gRPC errors; deciding
  what is transient, how long to wait, and how to avoid a thundering herd is left
  to the caller. Done wrong, you either drop events or hammer a struggling
  backend.
- **The ack/nack lifecycle is easy to get subtly wrong.** Pub/Sub's delivery
  contract is simple — `ack()` means "done, do not redeliver"; a failure (nack or
  timeout) means "redeliver and retry" — but wiring a handler so that a thrown
  error reliably becomes a nack, and a success reliably becomes an ack, with the
  ack deadline extended while a slow handler is still running, is repetitive
  boilerplate that every project re-implements.
- **Poison messages need a policy.** Native dead-letter topics exist, but wiring
  `deadLetterPolicy`, the IAM grants, and the delivery-attempt accounting is
  manual and easy to get subtly wrong — and a misconfiguration fails silently,
  surfacing only when a poison message loops forever in production.
- **Context is lost at the hop.** When service A publishes a message and service
  B consumes it, the trace context and any business headers do not travel unless
  you manually marshal them through message attributes on both sides. The thread
  of "what request caused this" breaks at the topic.
- **Message shape is unstructured.** Attributes are a flat string map and the
  body is raw bytes. Teams reinvent an envelope, a content-type convention, and a
  schema-version marker on every project.

`resilient-pubsub` closes these gaps **without taking the transport away from
you**, and it is explicit about the things it deliberately leaves to the
application (see [What this library does not do](#what-this-library-does-not-do)).

## The core model: ack means done, no-ack means retry

The entire library is built on Pub/Sub's own delivery contract, not on top of a
heavier guarantee:

> **A handler that succeeds gets `ack()` — the work is finished.
> A handler that fails gets `nack()` — Pub/Sub redelivers and it runs again.**

That is the spine. Everything else (retry on publish, dead-letter on repeated
failure, context propagation, observability) hangs off it. The library does not
try to invent exactly-once processing or hide the at-least-once nature of
Pub/Sub — it makes the at-least-once lifecycle correct, observable, and
ergonomic, and it is honest that **deduplication of business effects is the
application's responsibility** (see below).

## Zero-config by default — the primary design goal

The headline promise of this library is **ergonomics**: install it, set your
environment variables, and have a working, resilient publisher or subscriber with
a handful of lines. Resilience is on by default; you write configuration only to
*change* a default, never to *enable* one.

**The happy path, in full:**

```ts
// Publisher — retry, backoff, jitter, and context propagation are already on.
import { createResilientPublisher } from 'resilient-pubsub';

const publisher = createResilientPublisher({ topic: 'orders' });
await publisher.publish({ orderId: '42' });
```

```ts
// Subscriber — throw → nack (retry), return → ack (done). Deadline extension,
// envelope decoding, and context extraction are already on.
import { createResilientSubscriber } from 'resilient-pubsub';

const subscriber = createResilientSubscriber({ subscription: 'orders-worker' });
subscriber.on(async (message) => {
  // your business logic
});
subscriber.start();
```

**The ergonomics budget (a verifiable commitment, not an aspiration):**

- The publisher happy path is **≤ 3 lines** of library code (import, create,
  publish).
- The subscriber happy path is **≤ 4 lines** of library code (import, create,
  register handler, start).
- The only things the caller *must* provide are the **resource name** (topic /
  subscription) and, for the subscriber, the **handler** — both irreducible: the
  library cannot guess what you subscribe to or what your business logic is.
- Everything else has a **safe default** and is overridable.

This budget is enforced through the end-to-end consumer repositories and the
README quickstart: if the happy path grows past it, that is a regression to fix,
not a new normal to accept.

**Configuration model — convention + environment variables:**

- **GCP project and credentials** come from the standard GCP environment
  (`GOOGLE_CLOUD_PROJECT` / `GOOGLE_APPLICATION_CREDENTIALS`) — the library does
  not invent its own scheme for what Google already standardizes.
- **Resilience knobs** (retry attempts, backoff/jitter strategy, deadlines, flow
  control) are read from a documented `RESILIENT_PUBSUB_*` environment-variable
  convention, each with a safe default. A 12-factor deployment can tune behavior
  without touching code.
- **Programmatic overrides** are always available for callers who prefer explicit
  configuration in code; env vars and defaults are the convenience layer, not the
  only layer.

## What this library is

A transparent, framework-agnostic resilience layer that wraps the official
`@google-cloud/pubsub` client and adds, in v0.1:

1. **Resilient publishing** — retry with backoff and jitter (exponential /
   linear / constant backoff; full / equal / decorrelated / none jitter), and
   **ordering-aware** publishing: when ordering keys are enabled, the publisher
   preserves per-key order and resumes after a failure (`resumePublishing`)
   instead of silently reordering. The heavy lifting is the native client's; the
   library just exposes the option and handles resume correctly.
2. **A correct subscriber lifecycle** — a handler that throws becomes a `nack`
   (redelivery); a handler that resolves becomes an `ack`. Flow control
   (`maxOutstandingMessages` / `maxOutstandingBytes`) is documented pass-through,
   and the ack deadline is extended automatically while a slow handler is still
   running, so long processing does not trigger premature redelivery.
3. **Structured envelopes** — a typed `Envelope<T>` plus a pluggable
   `Serializer<T>` (JSON by default), with content-type and schema-version
   carried in attributes.
4. **Context and header propagation across the hop** — on publish, the library
   writes the inbound trace context (W3C `traceparent` / `tracestate` /
   `baggage`) and any caller-provided business headers into the message
   attributes; on consume, it extracts them and exposes them to the handler. The
   trace and the headers survive the publisher → message → consumer hop. This is
   pure string marshalling following the W3C standard — **zero dependencies, no
   OpenTelemetry SDK required**.
5. **Dead-letter handling** — native `deadLetterPolicy` pass-through. Dead-letter
   support is **opt-in**: a subscriber that does not configure it pays no cost and
   runs no checks. The `delivery_attempt` count is surfaced on the envelope.
6. **Neutral observability hooks** — lifecycle callbacks for publish retries,
   nacks, dead-letter routing, and poison detection. The hooks are
   dependency-free; anyone can wire them to OpenTelemetry, a logger, or metrics.
   The library transports trace context (point 4) but does not create spans
   itself.
7. **A safe, standardized error surface** — `ResilientPubSubError` with explicit
   kinds and a `toJSON()` that never leaks secrets or PII by default.

## Idempotency is a shared responsibility (and mostly the application's)

This section exists so no one is misled in production.

Pub/Sub is **at-least-once**: a handler that succeeded but whose `ack` was lost
(crash, network, or an expired ack deadline) will be **redelivered and run
again**; and near the ack deadline the same message can be delivered to two
workers at once. The library makes the *lifecycle* correct — failure reliably
repeats, success reliably acks — but it **cannot make a non-idempotent business
effect safe to run twice**. That is the application's job, because only the
application knows what a duplicate means for its domain.

The honest division of labour:

- **The library guarantees** the ack/nack contract: a failed handler is retried,
  a succeeded handler is acked, slow handlers keep their lease via deadline
  extension, and repeated poison failures route to the dead-letter topic.
- **The application is responsible** for making its effects tolerate
  at-least-once delivery — typically by making the effect idempotent
  (deterministic keys, upserts/`PUT`, "insert if not exists") so that a
  redelivery reproduces the same result instead of a double effect.

**Why there is no built-in deduplication store in v0.1.** A generic dedup store
(e.g., a Redis "already processed" marker) helps in exactly one narrow case: the
effect is **not** idempotent, **cannot** be made idempotent, and runs across
**multiple instances** (for example, sending an email or calling a non-idempotent
third-party API). Even then it only *reduces* duplicates — it does not eliminate
them, because the mark and the effect live in separate systems and cannot commit
atomically. For the common cases (idempotent effects, single instance) it adds a
dependency and operational burden for little gain. So v0.1 ships **without** a
dedup store, and an **optional** `IdempotencyStore` tool is deferred to the
roadmap for the teams that genuinely hit that narrow case — with its limits
documented plainly, never sold as exactly-once.

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

- **Zero-config by default.** The library must work out of the box from
  environment variables and safe defaults, within the ergonomics budget above.
  Configuration changes a default; it is never required to enable resilience. Any
  feature that cannot be made to work with a safe default must justify why it
  needs explicit configuration.
- **Framework-agnostic.** No coupling to any web framework, DI container, or
  runtime beyond Node.js. It works the same in a plain script, in NestJS, or in
  any worker.
- **Transparent, never a black box.** The library wraps the official client; it
  does not hide it. Advanced users can always reach the underlying `Topic`,
  `Subscription`, and `Message` for cases the wrapper does not cover.
- **No dependency creep.** The only runtime peers the library will ever assume
  are `@google-cloud/pubsub` (required) and, if and when the deferred dedup tool
  lands, a Redis client (optional). No other dependency is added unless it is
  strictly required and there is no alternative. In particular, observability is
  achieved through neutral hooks and W3C-standard string propagation — **no
  OpenTelemetry SDK dependency**.
- **Security-first, in every sense.** Secrets (GCP key paths, and — if the dedup
  tool lands — Redis URLs with credentials) and PII are redacted from error
  output by default. The message body is never serialized into error JSON unless
  explicitly opted in. Supply-chain hygiene is part of the contract: GitHub
  Actions pinned by commit SHA, dependency review, and provenance on publish.
- **Honest guarantees over marketing.** The library states what it can and
  cannot guarantee — it makes the at-least-once lifecycle correct and observable,
  and it never claims exactly-once processing. It would rather under-promise and
  be trusted by senior operators than over-promise and burn credibility in
  production.
- **Zero runtime dependencies in the core.** The core (backoff, jitter, envelope,
  errors, propagation) has **zero runtime dependencies** and is tree-shakeable.
  The accurate phrasing is "zero runtime dependencies in the core, with explicit
  peers" — never a bare "zero-dependency" claim. The backoff/jitter core is
  reimplemented here, not imported from `resilient-http` — these are independent
  libraries.
- **Correctness over convenience.** Defaults are safe. When a trade-off exists
  between an easy default and a correct one, the library chooses correct and
  documents the knob.

## What this library does not do

- It is **not** a message broker or a Pub/Sub replacement.
- It does **not** abstract Pub/Sub behind a generic multi-broker interface. It is
  Pub/Sub-specific on purpose.
- It does **not** guarantee exactly-once processing, and it does **not**
  deduplicate business effects for you. It makes the at-least-once lifecycle
  correct; your effects must tolerate redelivery (idempotent sinks) — that is the
  application's responsibility.
- It does **not** create spans or depend on an observability SDK. It transports
  trace context and exposes neutral hooks; you wire your own backend.
- It does **not** provision infrastructure (topics, subscriptions, IAM). It
  documents the requirements and, for dead-letter, can *validate* them at startup
  (v0.2) — but it never creates resources.

## Scope

**v0.1 (current cycle):** resilient publishing (retry/backoff/jitter,
ordering-aware), a correct subscriber lifecycle (ack/nack, flow-control
pass-through, ack-deadline extension), structured envelopes, **context + header
propagation across publisher and consumer** (zero-dep, W3C), **opt-in native**
dead-letter support, neutral observability hooks, and a safe error surface —
plus complete documentation, end-to-end tests against the Pub/Sub emulator, and
full governance (security policy, contributing guide, Dependabot, branch
protection).

**Deferred (see `ROADMAP.md`):**

- **Optional `IdempotencyStore` tool (Redis)** for the narrow case of
  non-idempotent, non-controllable effects across multiple instances — with its
  limits documented, never sold as exactly-once.
- **Dead-letter startup preflight** — validate `deadLetterPolicy` + IAM grants
  for subscribers that opted into dead-letter handling, failing loudly on
  misconfiguration.
- **Application-level dead-letter republishing** with redacted error metadata
  (raw body only with explicit opt-in).
- **A Bun test/CI matrix.**

## Definition of done

Nothing is published to npm until the entire v0.1 surface is complete and
verified: the ergonomics budget holds (publisher ≤ 3 lines, subscriber ≤ 4 lines
in the consumer e2e repos), end-to-end suites green in CI on both consumer
repositories, README usage documentation finished, CHANGELOG current, security
and contributing policies in place, Dependabot enabled, and `main` protected. The
first release is the last gate, not the first milestone — a deliberate quality
stance for a library that sits on the path of money and events, accepting slower
external feedback in exchange for a stable, trustworthy first public version.
