# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial scaffold: package.json, tsconfig, tsup, eslint flat config, prettier, CI workflow
- Stub source barrels for all planned sub-modules: publisher, subscriber, idempotency, idempotency/redis, core, envelope, errors
- Scaffold smoke test (`tests/smoke.test.ts`) run via the Node.js test runner
- ROADMAP.md tracking deferred work (Bun support, idempotency store, native schemas/Avro, all deferred)
- Core: `Envelope<T>` + pluggable `Serializer` / `JsonSerializer` (`envelope`)
- Core: `calculateBackoff`, `applyJitter`, `classify`, `isRetryable` (`core`, zero-dep)
- Error surface: `ResilientPubSubError` with safe-by-default `toJSON()`, `isResilientPubSubError`, `SerializationError`; redaction helpers (`utils`)
- Context propagation: `injectContext` / `extractContext` — W3C trace headers always-on, business headers by allowlist, `baggage` off by default, zero-dep (`propagation`)
- Documentation: README (Resilient PubSub), `docs/ARCHITECTURE.md`, `docs/configuration.md`, `docs/VISION.md`, and `docs/use-cases/` runnable examples
- Governance: `CONTRIBUTING.md`, `SECURITY.md` (private vulnerability reporting), `.github/dependabot.yml` (npm + github-actions, weekly), PR template
