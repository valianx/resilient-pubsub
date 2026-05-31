# resilient-pubsub

A transparent, framework-agnostic resilience layer around `@google-cloud/pubsub`.

> **Warning: Under active development — not ready for production use.**
>
> This library is a work in progress. APIs are unstable and may change without notice until v1.0.0.

## Planned Features

- **Idempotent Publishing** — deduplication via pluggable idempotency stores (in-memory + Redis)
- **Structured Envelopes** — typed message codec with schema versioning
- **Retry with Backoff/Jitter** — exponential, linear, and constant strategies with full/equal/decorrelated jitter
- **Dead-Letter Support** — native integration with Google Cloud Pub/Sub dead-letter policies
- **Resilient Subscriber** — concurrency-controlled message consumption with ack/nack management
- **TypeScript First** — full type definitions included

## Installation

```bash
# pnpm
pnpm add resilient-pubsub @google-cloud/pubsub

# npm
npm install resilient-pubsub @google-cloud/pubsub

# yarn
yarn add resilient-pubsub @google-cloud/pubsub
```

### Optional: Redis idempotency store

```bash
pnpm add redis
```

## License

MIT
