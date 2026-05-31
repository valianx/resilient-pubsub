/**
 * resilient-pubsub/propagation
 *
 * Allowlist-gated context propagation across the Pub/Sub message hop.
 *
 * **Design contract:**
 * - W3C trace headers (`traceparent`, `tracestate`) travel **always** — they
 *   are correlation IDs, not user data, and require no opt-in.
 * - Business headers travel **only** when explicitly listed in `opts.allowlist`.
 *   The library never copies arbitrary caller headers into attributes.
 * - W3C `baggage` is **off by default** (opt-in via `opts.baggage: true`). It
 *   is a classic PII-leak vector and must be enabled deliberately.
 * - Attributes are an unredacted channel (wire / logs / DLQ). This module
 *   controls WHAT travels. Do NOT propagate headers that contain PII.
 * - **Zero runtime dependencies.** No OpenTelemetry SDK, no
 *   @google-cloud/pubsub at import time. Pure W3C-standard string marshalling.
 *
 * **Exports:**
 * - {@link injectContext}    — outbound: headers → Pub/Sub attributes subset
 * - {@link extractContext}   — inbound: Pub/Sub attributes → headers
 * - {@link W3C_TRACE_HEADERS} — constant set of always-propagated header names
 * - {@link Headers}          — `Record<string, string>` (developer-facing alias)
 * - {@link PropagationOptions} — options type (`allowlist`, `baggage`)
 *
 * @module propagation
 */

export { injectContext, extractContext, W3C_TRACE_HEADERS } from './propagation';
export type { Headers, PropagationOptions } from './propagation';
