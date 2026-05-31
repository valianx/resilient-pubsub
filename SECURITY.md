# Security Policy

## Supported versions

resilient-pubsub is pre-release. Until v1.0, the latest published `0.x` version
receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, use GitHub's **private vulnerability reporting**:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Provide a description, reproduction steps, and impact assessment.

You can expect an initial response within a few business days. Once the issue is
confirmed and a fix is released, we will credit you in the release notes (unless
you prefer to remain anonymous).

## Scope

resilient-pubsub keeps a zero-dependency core (it wraps the official
`@google-cloud/pubsub` client and, optionally in a later release, a Redis
client). The main attack surface is:

- **Error message exposure** — `ResilientPubSubError.toJSON()` is designed to
  redact secrets (GCP key paths, Redis URL credentials) and exclude
  body/cause/meta. If you find a way to leak secrets through error output, that
  is in scope.
- **Propagation leakage** — message attributes are an unredacted channel that
  travels to logs and the dead-letter topic. Header propagation is
  allowlist-gated and `baggage` is off by default. A path that propagates
  unallowlisted headers, or that leaks credentials into attributes, is in scope.
- **ReDoS** — any regular expression (e.g. in redaction) that can be made to
  backtrack catastrophically on attacker-controlled input is in scope.
- **Prototype pollution** — any path where merging options, headers, or
  attributes could pollute `Object.prototype` is in scope.

## Disclosure policy

We follow coordinated disclosure. Please give us a reasonable window to release
a fix before any public disclosure.
