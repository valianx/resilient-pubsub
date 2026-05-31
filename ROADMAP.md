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
- **Optional inbound body validation.** A caller-supplied validator (schema or
  function) checked on consume: a body that does not match the expected type `T`
  is classified **poison** and routed to the dead-letter topic (or nacked)
  **without invoking the handler**, so inside the handler `body` is always a valid
  `T` with no defensive shape-checking. v0.1 passes the deserialized body through
  as-is and leaves shape validation to the application; this brings it into the
  library as an opt-in. Never migrates schemas — only gate-keeps the shape.
- **Turnkey OpenTelemetry bridge (optional).** v0.1 already propagates W3C trace
  context across the publisher → consumer hop and exposes neutral observability
  hooks, with no SDK dependency. v0.2 may add an *optional* bridge that creates
  spans automatically via `@opentelemetry/api` (an optional peer) for teams that
  want it turnkey — the core stays dependency-free and backend-neutral.

## Deferred: Native Pub/Sub schemas & Avro (revisit after v0.1 base is stable and tested)

**Status:** deferred by design. Do not start until the v0.1 base (publishing,
subscriber lifecycle, envelopes, propagation, dead-letter, hooks) is complete,
green in the e2e consumer repos, and proven in real use. New features go to the
roadmap; the base must be solid first.

**Why this needs its own design pass:** Pub/Sub has *native* schema support that
partially overlaps with our message-contract concern. We must define the
relationship before writing any code, or we risk competing with a server-side
feature instead of complementing it.

### Established facts (so we don't re-derive them)

- **Native validation is server-side, at publish time**, against a schema
  attached to the topic. It works for any client/language — even a raw REST
  publish is validated. It is an *ingress* control on the topic.
- **Formats are Avro or Protobuf**, with **JSON or BINARY** encoding. These are
  not arbitrary TypeScript types.
- **The consume side is the gap.** Pub/Sub does **not** validate or decode on
  delivery — the subscriber receives bytes. For Avro with revisions, the consumer
  must fetch the *writer* schema (identified via message attributes) and resolve
  it against its compiled *reader* schema. GCP leaves this entirely to the app.
- **Schema evolution is GA** via *revisions*: compatible changes (add/remove
  optional fields) are allowed, and a topic can accept a range of revisions,
  enabling zero-downtime migration.
- **The schema validates the message body (data), not attributes.** Our
  `headers → attributes` mapping is therefore orthogonal to native validation and
  is unaffected by it.

References to re-check when revisiting (GCP changes):
- Pub/Sub schema evolution (GA): https://cloud.google.com/blog/products/data-analytics/pub-sub-schema-evolution-is-now-ga
- Pub/Sub schemas docs: https://cloud.google.com/pubsub/docs/schemas

### Architectural stance (the layering decision)

Native schemas and our optional validator are **different layers — they compose,
they do not compete:**

- **Transport layer — native Pub/Sub schemas (the user's choice, on the topic).**
  Validates the body at publish, server-side. If a topic has a schema and a
  publish violates it, the publish is rejected — which our publisher already
  surfaces as a `ResilientPubSubError` (we never swallow it). The library
  *respects* this; it does not manage or abstract it.
- **Library layer — our optional consume-side validator.** Covers the side GCP
  leaves empty (no consume-side validation). This is the validator's real niche:
  it removes defensive shape-checking from every handler. It is **not** redundant
  with native schemas because native validation never runs on consume.

### Candidate scope (for the future feature)

- Optional **Avro reader/writer schema resolution on consume** — the genuine GCP
  gap — delivered as a **separate, opt-in extension package**, never in the
  zero-dep core (it requires an Avro dependency).

### Non-goals to preserve

- The **core stays JSON + TS types, zero runtime dependencies.**
- **No binary Avro/Protobuf encoding in the core** (would pull in a dependency
  and re-implement GCP's job).
- The library **does not abstract or manage native schemas** — they remain an
  orthogonal, topic-level feature owned by the user.

### Open questions to resolve before building

1. **Reconcile the envelope's `schema-version` marker with native revisions.**
   When native schemas are used, Pub/Sub already injects a schema + revision
   identifier into the message attributes. Our hand-rolled `schema-version` would
   then be a *second*, parallel version identifier that can diverge. Decide which
   is authoritative: our marker for schema-less topics (likely the default), the
   native identifier when a schema is attached. Document the rule.
2. **Reconcile two compatibility strategies.** Shared TS types give *compile-time*
   safety only within a shared type boundary (monorepo / shared package); native
   schema revisions give *runtime* evolution across independent services. These
   can contradict each other (a backward-compatible field add is valid under
   revisions but invisible to a consumer's stale TS copy). Clarify which strategy
   the library assumes/recommends, and condition the "publisher changes shape →
   consumer won't compile" claim on shared types.
3. **Evaluate JSON-encoded Avro as a lightweight middle ground.** Avro with JSON
   encoding can validate JSON bodies without binary serialization — but parsing
   the schema still needs an Avro library, so it stays out of the zero-dep core.
   Decide if it's worth an extension or not worth it at all.
