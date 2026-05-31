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
Pub/Sub — it makes the at-least-once lifecycle correct, observable, and ergonomic.
Deduplicating business effects remains the application's responsibility; see
[Idempotency is a shared responsibility](#idempotency-is-a-shared-responsibility).

## A standard message contract — the core value

Resilience (retry, backoff, jitter, ack/nack, dead-letter) is worthwhile, but the
native client already does or eases much of it. The thing no other tool gives a
team — and the reason this library earns its place — is a **single, typed,
symmetric message contract**:

> You **publish** `{ body, headers }` and you **receive** `{ body, headers, meta }`.
> One message shape, learned once, used everywhere.

This reframes the library: it is not "another retry layer over Pub/Sub" — it is
**the standard way an organization produces and consumes messages, with
resilience built in**. Resilience becomes a property; the message contract is the
product. The value comes from removing decisions and drift:

- **No "where does this go?" decisions.** Without a contract, every developer
  decides whether `tenantId` lives in the body or in attributes, and what to name
  `traceId`. With it, there is one place and one name. Five teams emit
  structurally identical messages.
- **End-to-end type safety.** `createResilientPublisher<OrderCreated>` and
  `createResilientSubscriber<OrderCreated>` share the type. If a publisher changes
  the shape, the consumer **does not compile** — a runtime "malformed message in
  production" bug becomes a compile-time error.
- **Flat onboarding.** A new developer learns *one* format and can publish to and
  consume from any service in the organization. No "payments does it this way,
  notifications does it that way."
- **The optional validator closes the contract.** Inside the handler, `body` is
  always a valid `T` — no defensive shape-checking repeated in every consumer
  (malformed input is classified poison before the handler runs).

The full shape and its rules live in
[What this library is](#what-this-library-is) (points 2–4); the point here is that
this contract is a **first-class goal**, on par with zero-config and honest
guarantees — not a side feature.

## Zero-config by default — the primary design goal

The headline promise of this library is **ergonomics**: install it, set your
environment variables, and have a working, resilient publisher or subscriber with
a handful of lines. Resilience is on by default; you write configuration only to
*change* a default, never to *enable* one.

**The happy path, in full:**

```ts
// Publisher — retry, backoff, jitter, and context propagation are already on.
import { createResilientPublisher } from 'resilient-pubsub';

const publisher = createResilientPublisher<OrderCreated>({ topic: 'orders' });

// You pass the SAME { body, headers } shape you receive when consuming —
// symmetric input/output. publish() retries internally; if it still fails after
// exhausting retries it REJECTS with a typed ResilientPubSubError — it never
// swallows a lost event.
try {
  await publisher.publish({
    body: { orderId: '42' },
    headers: { traceId: 'abc-123' }, // allowlist-gated; marshalled to attributes
  });
} catch (err) {
  // err is a ResilientPubSubError: the publish failed permanently. Handle it
  // (alert, persist for later, fail the request) — the library will not hide it.
}
```

```ts
// Subscriber — throw → nack (retry), return → ack (done). The library catches
// the throw for you: you do NOT write try/catch in the handler. Deadline
// extension, envelope decoding, and context extraction are already on.
import { createResilientSubscriber } from 'resilient-pubsub';

const subscriber = createResilientSubscriber<OrderCreated>({
  subscription: 'orders-worker',
});
subscriber.on(async (msg) => {
  msg.body; // OrderCreated — typed, already deserialized
  msg.headers; // { traceId: 'abc-123' } — SAME shape you published
  msg.meta; // messageId, deliveryAttempt, publishTime, orderingKey (inbound only)
  // your business logic — throw to retry, return to ack
});
subscriber.start();
```

The **`{ body, headers }` shape is symmetric**: you publish it and you receive
it, so a developer learns one message format for both sides. This is the
library's own surface, not the wire format — `headers` are marshalled to/from
Pub/Sub `attributes` under the hood. The one asymmetry is `meta` (messageId,
deliveryAttempt, publishTime, orderingKey): it exists **only on consume**, because
Pub/Sub populates it at delivery — you cannot set it when publishing, so the
publish shape does not pretend to accept it.

**Who handles the throw — opposite on each side, by design:**

- **Subscriber:** the library **catches** your handler's throw and turns it into
  a `nack` (retry). You do **not** write try/catch in the handler — swallowing
  the error there would break the retry contract. That boilerplate removal is the
  point.
- **Publisher:** the library **retries** the publish but does **not** swallow the
  final failure. After exhausting retries, `publish()` rejects with a typed
  `ResilientPubSubError`, and the caller is expected to handle it (`await` +
  try/catch). Hiding a permanently failed publish would silently drop an event —
  unacceptable on the path of money. The library owns *retrying*, not *concealing
  the outcome*.

**The ergonomics budget (a verifiable commitment, not an aspiration):**

- The publisher happy path is **≤ 3 lines** of library code to wire (import,
  create, publish); error handling around `publish()` is the caller's, by design
  (see above).
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
2. **A correct subscriber lifecycle** — the handler receives a typed
   `{ body, headers, meta }` message (the same `{ body, headers }` shape used to
   publish, plus inbound-only `meta`). A handler that throws becomes a `nack`
   (redelivery) — **the library catches the throw**, so handlers stay free of
   try/catch boilerplate; a handler that resolves becomes an `ack`. Flow control
   (`maxOutstandingMessages` / `maxOutstandingBytes`) and ack-deadline extension
   are **the native client's own lease management** (it modacks automatically up
   to `maxExtension`); the library exposes these as documented pass-through with
   sensible defaults rather than reimplementing them. The value the library adds
   here is the ergonomic throw→nack / resolve→ack wiring and the typed message,
   not the lease machinery — that heavy lifting is the native client's.
3. **Structured, symmetric envelopes** — you publish `{ body, headers }` and you
   receive `{ body, headers, meta }`: one message shape for both sides. `body` is
   typed (`Envelope<T>`) and serialized through a pluggable `Serializer<T>` (JSON
   by default), with content-type and schema-version carried in attributes. An
   **optional validator** can be supplied: if an inbound `body` does not match the
   expected type, the library classifies it as **poison** and routes it to the
   dead-letter topic (or nacks) **without invoking your handler** — so inside the
   handler `body` is always a valid `T`, with no defensive shape-checking. Without
   a validator, the deserialized body is passed through as-is.
4. **Context and header propagation across the hop** — on publish, the library
   writes W3C trace-correlation context (`traceparent` / `tracestate`) into the
   message attributes; on consume, it extracts it and exposes it to the handler,
   so the trace survives the publisher → message → consumer hop. This is pure
   string marshalling following the W3C standard — **zero dependencies, no
   OpenTelemetry SDK required**. Header propagation is governed by a **safe
   allowlist** and `baggage` is **off by default** — see
   [Propagation safety](#propagation-safety-no-pii-on-the-wire); attributes are
   an unredacted channel, so what travels is controlled, not arbitrary.
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

## Propagation safety: no PII on the wire

Message attributes are an **unredacted channel**: they travel over the wire, land
in logs, and are copied to the dead-letter topic. That makes propagation a
security decision, not just an ergonomics one — especially for a payments
context. The library is deliberately strict here, to match the same standard it
applies to error output.

- **Trace correlation propagates automatically.** `traceparent` and `tracestate`
  are W3C correlation identifiers, not user data, so they are propagated by
  default.
- **Business headers propagate by allowlist only.** The library never copies
  arbitrary caller headers into attributes. A **default allowlist** ships with
  the safe standard correlation headers already included; the caller extends it
  with the specific business headers they want to travel. Anything not on the
  allowlist does not cross the hop.
- **W3C `baggage` is off by default.** `baggage` is the classic vector for
  accidental PII leakage (teams stuff sensitive values into it and it propagates
  everywhere). It is opt-in, and the documentation states plainly: **do not put
  PII in baggage or in propagated headers** — attributes are not redacted.

This keeps the promise symmetric: the library is as careful with what leaves on
the message as it is with what leaves in an error.

## Idempotency is a shared responsibility

Pub/Sub is **at-least-once**: a handler that succeeded but whose `ack` was lost
(crash, network, or an expired ack deadline) will be **redelivered and run
again**; near the ack deadline the same message can even reach two workers at
once. The library makes the *lifecycle* correct — failure reliably repeats,
success reliably acks — but it **cannot make a non-idempotent business effect
safe to run twice**. Only the application knows what a duplicate means for its
domain, so making effects tolerate redelivery (deterministic keys, upserts/`PUT`,
"insert if not exists") is the application's job.

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
  output by default, and propagation onto message attributes is allowlist-gated
  so the unredacted-channel risk is controlled too (see
  [Propagation safety](#propagation-safety-no-pii-on-the-wire)). The message body
  is never serialized into error JSON unless explicitly opted in. Supply-chain
  hygiene is part of the contract: GitHub Actions pinned by commit SHA, dependency
  review, and provenance on publish.
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
- It does **not** guarantee exactly-once processing or deduplicate business
  effects for you — your effects must tolerate redelivery. See
  [Idempotency is a shared responsibility](#idempotency-is-a-shared-responsibility).
- It does **not** migrate message schemas, and it validates only when you opt in.
  The envelope carries a `schema-version` marker across the hop; an optional
  validator can reject a malformed `body` as poison on consume, but interpreting a
  `schema-version` mismatch — routing, transforming, or migrating between
  versions — is the application's responsibility. The library transports the
  marker and, if asked, gate-keeps the shape; it does not migrate.
- It does **not** create spans or depend on an observability SDK. It transports
  trace context and exposes neutral hooks; you wire your own backend.
- It does **not** provision infrastructure (topics, subscriptions, IAM). It
  documents the requirements and, for dead-letter, can *validate* them at startup
  (v0.2) — but it never creates resources.

## Scope

**v0.1 (current cycle):** resilient publishing (retry/backoff/jitter,
ordering-aware), a correct subscriber lifecycle (ack/nack wiring over the native
client's flow-control and ack-deadline lease management), structured envelopes,
**allowlist-gated context + header propagation across publisher and consumer**
(zero-dep, W3C), **opt-in native** dead-letter support, neutral observability
hooks, and a safe error surface — plus complete documentation, end-to-end tests
against the Pub/Sub emulator, and full governance (security policy, contributing
guide, Dependabot, branch protection).

The **two consumer repositories** are the project's own end-to-end proof
(dogfooding): `resilient-pubsub-e2e` exercises the library from a plain Node
worker, and `resilient-pubsub-e2e-nestjs` exercises it inside a NestJS app — both
against the Pub/Sub emulator in CI. They demonstrate the framework-agnostic
claim and enforce the ergonomics budget on real consumer code.

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
