# Contributing to resilient-pubsub

Thanks for your interest in contributing! This document explains how to set up
the project, the conventions we follow, and the pull-request process.

> **Status:** resilient-pubsub is under active development toward its first
> release (v0.1). The public API (`createResilientPublisher` /
> `createResilientSubscriber`) is still being implemented — see
> [`docs/VISION.md`](./docs/VISION.md) for the firm design contract and
> [`ROADMAP.md`](./ROADMAP.md) for what is in scope.

## Prerequisites

- **Node.js >= 24.0.0**
- **pnpm** (the repo uses a pnpm lockfile; `packageManager` pins the version)

## Getting started

```bash
# Install dependencies (frozen lockfile, like CI)
pnpm install --frozen-lockfile

# Type-check, build, lint, and run the test suite
pnpm typecheck
pnpm build
pnpm lint
pnpm test:node
```

## Project layout

```
src/
  core/         # backoff, jitter, gRPC-aware error classification
  envelope/     # Envelope<T> + pluggable Serializer (JSON default)
  errors/       # ResilientPubSubError + safe toJSON + SerializationError
  propagation/  # W3C trace + allowlisted header propagation across the hop
  publisher/    # createResilientPublisher (in progress)
  subscriber/   # createResilientSubscriber (in progress)
  utils/        # redaction helpers (secrets / PII)
  types/        # public type definitions
tests/          # node:test + tsx
docs/           # VISION, ARCHITECTURE, configuration, runnable use-cases
```

## Conventions

### Commits — Conventional Commits

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — a new feature
- `fix:` — a bug fix
- `docs:` — documentation only
- `test:` — adding or fixing tests
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `chore:` — tooling, deps, CI

Example: `feat(subscriber): add graceful stop drain`

### Code style

- TypeScript strict mode; no `any` without a justifying comment.
- Formatting and linting are enforced: run `pnpm lint` and `pnpm format`.
- Keep the public API documented with JSDoc (it powers editor hints).

### Design rules (non-negotiable)

These keep the library true to its vision. A PR that violates them will be asked
to change before review continues:

- **Zero runtime dependencies in the core** (`core`, `envelope`, `errors`,
  `propagation`, `utils`). The only runtime peers the library assumes are
  `@google-cloud/pubsub` (required) and, if and when the deferred dedup tool
  lands, a Redis client (optional). Do not add other dependencies.
- **Never swallow a failed publish.** `publish()` retries, then rejects with a
  typed `ResilientPubSubError` — it must never hide a lost event.
- **Honest guarantees.** The library makes the at-least-once lifecycle correct;
  it never claims exactly-once processing. Deduplicating business effects is the
  application's responsibility (see [`docs/VISION.md`](./docs/VISION.md)).
- **Security-first.** Secrets and PII are redacted from error output by default;
  `toJSON()` never includes body/cause/meta. Header propagation is allowlist-gated
  and `baggage` is off by default — message attributes are an unredacted channel.
- **Transparent, never a black box.** Wrap the official client; never hide it.
  Keep the underlying `Topic` / `Subscription` / `Message` reachable.
- **Zero-config by default.** Resilience is on without configuration; a config
  option only *changes* a default, it never *enables* one.

## Testing

- All new behavior needs tests. We use the Node.js test runner via `tsx`.
- Run the full suite with `pnpm test:node`; run a single file with
  `node --import tsx --test tests/propagation.test.ts`.
- Tests must be deterministic — mock the Pub/Sub client and timers; never hit a
  real network. End-to-end tests against the Pub/Sub emulator live in the
  separate consumer repositories.

## Pull requests

1. Fork and create a feature branch (`feat/...`, `fix/...`).
2. Make your change with tests and docs.
3. Run `pnpm typecheck && pnpm lint && pnpm build && pnpm test:node` locally.
4. Open a PR against `main` with a clear description and a conventional-commit title.
5. Ensure CI is green; address review feedback.

By contributing, you agree that your contributions will be licensed under the
project's MIT License.

## Reporting bugs & security issues

- **Bugs:** open a GitHub issue with a minimal reproduction.
- **Security vulnerabilities:** please follow the process in
  [SECURITY.md](./SECURITY.md) — do not open a public issue for security reports.
