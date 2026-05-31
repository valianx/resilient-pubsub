# resilient-pubsub

A transparent, framework-agnostic resilience layer around `@google-cloud/pubsub`.

> **Warning: Under active development — not ready for production use.**
>
> This library is a work in progress. APIs are unstable and may change without notice until v1.0.0.

Zero runtime dependencies in the core, with explicit peers. It wraps the
official client transparently — it never takes the transport away from you. See
[`docs/VISION.md`](docs/VISION.md) for the full design intent and honest
guarantees.

## Planned features (v0.1)

- **Resilient publishing** — retry with exponential / linear / constant backoff
  and full / equal / decorrelated jitter; ordering-aware (`resumePublishing`).
- **Correct subscriber lifecycle** — `throw → nack` (retry), `return → ack`
  (done), over the native client's flow-control and ack-deadline lease
  management.
- **Structured envelopes** — typed `Envelope<T>` with a pluggable serializer
  (JSON by default) and a `schema-version` marker carried in attributes.
- **Context propagation across the hop** — W3C trace correlation and
  allowlist-gated headers travel publisher → message → consumer. Zero-dep, no
  OpenTelemetry SDK. `baggage` is off by default; **do not put PII in propagated
  headers** — attributes are not a redacted channel.
- **Opt-in native dead-letter** — `deadLetterPolicy` pass-through; `delivery_attempt`
  surfaced on the envelope.
- **Safe error surface** — `ResilientPubSubError` whose `toJSON()` never leaks
  secrets or PII by default.
- **TypeScript first** — full type definitions, dual ESM + CJS, tree-shakeable.

> **On idempotency:** Pub/Sub is at-least-once, so handlers must tolerate
> redelivery (make effects idempotent). The library makes the ack/nack lifecycle
> correct but does **not** guarantee exactly-once processing. A built-in
> deduplication store is intentionally out of v0.1 scope — see
> [`ROADMAP.md`](ROADMAP.md) and the vision's
> [Idempotency](docs/VISION.md#idempotency-is-a-shared-responsibility) section.

## Installation

```bash
# pnpm
pnpm add resilient-pubsub @google-cloud/pubsub

# npm
npm install resilient-pubsub @google-cloud/pubsub

# yarn
yarn add resilient-pubsub @google-cloud/pubsub
```

`@google-cloud/pubsub` is a required peer dependency.

## License

MIT
