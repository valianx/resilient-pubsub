# Use Cases — resilient-pubsub

Runnable examples that demonstrate each feature of the library in isolation.
All files use the implemented publisher/subscriber factories and are correct
against the real exports.

> **Note:** This directory is excluded from `tsconfig include` and from the
> ESLint scope, so `.ts` files here will not break the build even when they
> reference factories that are not yet tree-shake-optimized.

---

## Index

| File | Feature illustrated | API status |
|------|---------------------|------------|
| [01-quickstart-publisher.ts](01-quickstart-publisher.ts) | `createResilientPublisher` + `publish({ body, headers })` + error handling | Implemented |
| [02-quickstart-subscriber.ts](02-quickstart-subscriber.ts) | `createResilientSubscriber` + handler + `start()` + SIGTERM→`stop()` | Implemented |
| [03-message-envelope.ts](03-message-envelope.ts) | `Envelope` outbound/inbound, `JsonSerializer`, custom `Serializer` | Implemented |
| [04-backoff-strategies.ts](04-backoff-strategies.ts) | `calculateBackoff` across exponential / linear / constant | Implemented |
| [05-jitter.ts](05-jitter.ts) | `applyJitter` across full / equal / decorrelated / none | Implemented |
| [06-error-handling.ts](06-error-handling.ts) | `ResilientPubSubError` kinds, `isResilientPubSubError`, `classify`, `isRetryable`, safe `toJSON()` | Implemented |
| [07-context-propagation.ts](07-context-propagation.ts) | `injectContext` / `extractContext`, allowlist, baggage off, cross-hop forwarding | Implemented |
| [08-dead-letter.ts](08-dead-letter.ts) | `withDeadLetter` / `buildDeadLetterPolicy` builder, `onPoison` hook, `deliveryAttempt` on meta | Implemented |
| [09-graceful-shutdown.ts](09-graceful-shutdown.ts) | `stop()` drain wired to SIGTERM/SIGINT | Implemented |
| [10-deployment-patterns.ts](10-deployment-patterns.ts) | Publisher-only / consumer-only / both; subpath imports; shared client | Implemented |
