# Architecture — resilient-pubsub

> Internal architecture reference for contributors. For design intent and
> honest guarantees see [VISION.md](VISION.md); for configuration options see
> [configuration.md](configuration.md).

---

## Module structure

```
resilient-pubsub/
├── src/
│   ├── index.ts                     # Root barrel — re-exports all public modules
│   ├── types/
│   │   └── index.ts                 # Shared TypeScript types (Attributes, EnvelopeMeta, …)
│   ├── core/
│   │   ├── index.ts                 # Core barrel (calculateBackoff, applyJitter, classify, isRetryable)
│   │   ├── backoff.ts               # Backoff strategies: exponential / linear / constant
│   │   ├── jitter.ts                # Jitter algorithms: full / equal / decorrelated / none
│   │   └── classify.ts              # gRPC + Node.js error → Classification; isRetryable predicate
│   ├── envelope/
│   │   ├── index.ts                 # Envelope barrel
│   │   ├── envelope.ts              # Envelope<T> class (outbound / inbound factory methods)
│   │   └── serializer.ts            # Serializer<T> interface, JsonSerializer<T>, SerializationError re-export
│   ├── errors/
│   │   ├── index.ts                 # Error barrel
│   │   └── error.ts                 # ResilientPubSubError, isResilientPubSubError, SerializationError
│   ├── propagation/
│   │   ├── index.ts                 # Propagation barrel
│   │   └── propagation.ts           # injectContext, extractContext, W3C_TRACE_HEADERS, PropagationOptions
│   ├── utils/
│   │   ├── index.ts                 # Utils barrel
│   │   └── redact.ts                # capMessage, redactSecrets (used by ResilientPubSubError.toJSON)
│   ├── publisher/                   # v0.1 — in progress
│   │   └── index.ts                 # createResilientPublisher
│   └── subscriber/                  # v0.1 — in progress
│       └── index.ts                 # createResilientSubscriber
├── tests/                           # Unit tests (bun test / node --test)
├── docs/
│   ├── VISION.md                    # Design intent and honest guarantees
│   ├── ARCHITECTURE.md              # This file
│   ├── configuration.md             # Configuration reference
│   └── use-cases/                   # Runnable examples (excluded from typecheck/lint)
├── dist/                            # Build output (tsup, gitignored)
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Dependency hierarchy

Modules depend downward only. No circular imports.

```
utils          ← base helpers (redact, random); zero deps
types          ← TypeScript types only; zero deps
core           ← depends on: types, utils
errors         ← depends on: core/classify, utils/redact
envelope       ← depends on: types, errors   (re-exports SerializationError)
propagation    ← depends on: types
publisher      ← depends on: core, envelope, errors, propagation, utils   [in progress]
subscriber     ← depends on: core, envelope, errors, propagation, utils   [in progress]
index (root)   ← re-exports all public modules
```

The key constraint: `errors` MUST NOT import from `envelope`. The envelope
module imports `SerializationError` from `errors`, not the other way around.
`core` MUST NOT import from `errors` or `envelope` — classification is pure
structural inspection with no cross-module imports.

---

## Package exports map

```json
{
  ".":             { "import": "dist/index.js",             "require": "dist/index.cjs" },
  "./publisher":   { "import": "dist/publisher/index.js",   "require": "dist/publisher/index.cjs" },
  "./subscriber":  { "import": "dist/subscriber/index.js",  "require": "dist/subscriber/index.cjs" },
  "./core":        { "import": "dist/core/index.js",        "require": "dist/core/index.cjs" },
  "./envelope":    { "import": "dist/envelope/index.js",    "require": "dist/envelope/index.cjs" },
  "./errors":      { "import": "dist/errors/index.js",      "require": "dist/errors/index.cjs" },
  "./propagation": { "import": "dist/propagation/index.js", "require": "dist/propagation/index.cjs" },
  "./idempotency": { "import": "dist/idempotency/index.js", "require": "dist/idempotency/index.cjs" }
}
```

`sideEffects: false` — every subpath is individually tree-shakeable.

For publisher-only apps, import from `resilient-pubsub/publisher` so subscriber
code is never bundled. See [configuration.md](configuration.md#imports--subpath-vs-barrel).

---

## The message contract

### Outbound (publish side)

```typescript
// What the caller passes to publish():
{
  body: T;                              // typed payload, serialized by Serializer<T>
  headers?: Record<string, string>;     // allowlist-gated; marshalled to attributes
}
```

### Inbound (consume side)

```typescript
// What the handler receives from on():
{
  body: T;                              // deserialized payload
  headers: Record<string, string>;      // reconstructed from attributes via extractContext
  meta: {
    messageId: string;
    publishTime?: string;               // ISO-8601
    deliveryAttempt?: number;           // present only with deadLetterPolicy
    orderingKey?: string;               // present only when ordering is enabled
  };
}
```

`meta` is Pub/Sub-populated and frozen at construction time (`Object.freeze`).
It is inbound-only: the publish shape does not accept it.

---

## Delivery guarantees

| Guarantee | Status |
|-----------|--------|
| At-least-once delivery | Native Pub/Sub — always holds |
| Failure → nack (retry) | Library — enforced by subscriber lifecycle |
| Success → ack (done) | Library — enforced by subscriber lifecycle |
| Exactly-once processing | **Not provided** — application's responsibility |
| Idempotency deduplication | Deferred to v0.2 (IdempotencyStore, optional Redis) |

---

## Idempotency model — honest by design

Pub/Sub redelivers any message whose ack is lost (crash, network drop, expired
deadline). Two workers can receive the same message simultaneously near the ack
deadline. The library makes the *lifecycle* correct; it does not deduplicate
business effects.

**Application contract:** make handler effects idempotent (deterministic keys,
upserts, "insert if not exists"). See [VISION.md — Idempotency](VISION.md#idempotency-is-a-shared-responsibility).

**v0.2 plan:** an opt-in `IdempotencyStore` abstraction (Redis-backed) for the
narrow case of non-idempotent, non-controllable effects — with limits documented
plainly, never marketed as exactly-once.

---

## Error classification model

`classify(error)` returns one of four values:

| Classification | Meaning | Retry? |
|----------------|---------|--------|
| `'transient'`  | gRPC UNAVAILABLE / DEADLINE_EXCEEDED / RESOURCE_EXHAUSTED / ABORTED / INTERNAL; Node ECONNREFUSED / ECONNRESET / ETIMEDOUT | Yes |
| `'permanent'`  | gRPC NOT_FOUND / PERMISSION_DENIED / UNAUTHENTICATED / INVALID_ARGUMENT / UNIMPLEMENTED | No |
| `'poison'`     | Deserialization failure (bad bytes, malformed JSON) | No — route to DLQ |
| `'unknown'`    | Unrecognized error shape | Treat as non-retryable |

Classification walks the cause chain up to depth 5 with a `Set`-based cycle
guard. Poison detection is duck-typed (`kind === 'serialization'` or
`classification === 'poison'`) so `core/classify` remains dependency-free.

---

## Propagation model

`injectContext` (publish side) and `extractContext` (consume side) are pure
string marshalling functions with no runtime dependencies:

1. **W3C trace headers** (`traceparent`, `tracestate`) — always propagated.
2. **Caller allowlist** — additional header keys provided via `opts.allowlist`
   (case-insensitive matching).
3. **W3C baggage** — opt-in via `opts.baggage: true`. Off by default because
   it is the canonical PII-leak vector.
4. **Everything else** — dropped silently.

Attribute keys are stored in lower-case. Non-string and empty-string values are
skipped. The functions are symmetric: `extractContext(injectContext(h, opts), opts)`
round-trips every allowlisted header that had a valid string value.

---

## Build

```bash
pnpm build      # tsup → dist/ (ESM + CJS + .d.ts for each subpath)
pnpm typecheck  # tsc --noEmit (src/**/* only)
pnpm lint       # eslint src/
pnpm test       # bun test
pnpm test:node  # node --import tsx --test tests/*.test.ts
```

`docs/**` is excluded from `tsconfig include` and from the lint scope, so
use-case `.ts` files may reference the not-yet-implemented publisher/subscriber
factories without breaking CI.
