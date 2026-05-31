/**
 * Context and header propagation for resilient-pubsub.
 *
 * This module marshals developer-facing HTTP headers into Pub/Sub message
 * attributes (outbound) and back into headers (inbound). It enforces an
 * allowlist model: only explicitly permitted headers cross the message hop.
 *
 * **Security model:**
 * - W3C trace correlation headers (`traceparent`, `tracestate`) are always
 *   propagated — they are correlation IDs, not user data.
 * - All other headers require explicit inclusion via `opts.allowlist`.
 * - W3C `baggage` is **off by default** (classic PII-leak vector). Enable
 *   with `opts.baggage === true` only when you control the full pipeline.
 * - Attributes are an unredacted channel (wire / logs / DLQ). This module
 *   controls WHAT travels, not HOW it is stored. Do NOT put PII in propagated
 *   headers.
 *
 * **Zero runtime dependencies.** Pure W3C-standard string marshalling; no
 * OpenTelemetry SDK, no @google-cloud/pubsub at import time.
 *
 * @module propagation/propagation
 */

import type { Attributes } from '../types/index';

// ============================================================================
// Public types
// ============================================================================

/**
 * Developer-facing header map. Shape-compatible with `Attributes` (both are
 * `Record<string, string>`) but carries the semantic meaning of HTTP-style
 * headers on the caller side of the abstraction boundary.
 */
export type Headers = Record<string, string>;

/**
 * Options controlling which headers cross the message hop.
 *
 * @example Propagate trace headers only (default — no options needed)
 * ```ts
 * injectContext(req.headers);
 * ```
 *
 * @example Extend with business headers
 * ```ts
 * injectContext(req.headers, { allowlist: ['x-tenant-id', 'x-correlation-id'] });
 * ```
 *
 * @example Also propagate W3C baggage (opt-in)
 * ```ts
 * injectContext(req.headers, {
 *   allowlist: ['x-tenant-id'],
 *   baggage: true,
 * });
 * ```
 */
export interface PropagationOptions {
  /**
   * Additional header keys to propagate beyond the default W3C trace headers.
   *
   * Matching is **case-insensitive** — entries are compared against
   * lower-cased header keys. The W3C trace headers (`traceparent`,
   * `tracestate`) are always included regardless of this list.
   *
   * @default [] (only the W3C trace headers travel)
   */
  allowlist?: string[];

  /**
   * Whether to propagate W3C `baggage` across the hop.
   *
   * `baggage` is a structured key-value header commonly used to carry
   * per-request context such as user identifiers, A/B variants, or feature
   * flags. Because its values are defined by the application rather than the
   * W3C standard, it is a known PII-leak vector and is therefore **disabled
   * by default**.
   *
   * Set to `true` only when you control both the publishing and consuming
   * ends of the pipeline and can guarantee the baggage contents do not
   * contain PII.
   *
   * @default false
   */
  baggage?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * W3C Trace Context header names (canonical lower-case).
 *
 * These headers are correlation IDs (not user data) and are **always**
 * propagated regardless of the `allowlist` option.
 *
 * @see https://www.w3.org/TR/trace-context/
 */
export const W3C_TRACE_HEADERS: readonly string[] = ['traceparent', 'tracestate'];

/** W3C `baggage` header name (canonical lower-case). */
const BAGGAGE_HEADER = 'baggage';

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Builds the effective allowlist Set for a propagation call.
 *
 * The Set always contains the W3C trace headers plus any caller-provided
 * entries (lowercased). `baggage` is added only when `opts.baggage === true`.
 *
 * @internal
 */
function buildEffectiveAllowlist(opts: PropagationOptions | undefined): Set<string> {
  const effective = new Set<string>(W3C_TRACE_HEADERS);

  if (opts?.baggage === true) {
    effective.add(BAGGAGE_HEADER);
  }

  if (opts?.allowlist) {
    for (const key of opts.allowlist) {
      effective.add(key.toLowerCase());
    }
  }

  return effective;
}

/**
 * Returns `true` when `value` is a non-empty string — the only shape that
 * Pub/Sub attributes accept.
 *
 * @internal
 */
function isValidAttributeValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extracts the subset of caller headers that should travel as Pub/Sub message
 * attributes (outbound / publish side).
 *
 * **Rules:**
 * 1. W3C trace headers (`traceparent`, `tracestate`) are always included when
 *    present, regardless of any allowlist.
 * 2. A caller header is included if and only if its key (matched
 *    case-insensitively) appears in the effective allowlist =
 *    `W3C_TRACE_HEADERS ∪ opts.allowlist [∪ 'baggage' if opts.baggage]`.
 * 3. Everything else is dropped silently — it does not cross the hop.
 * 4. Attribute keys are stored in lower-case (canonical W3C form for the
 *    standard headers; lower-cased for consistency on business headers).
 * 5. Non-string and empty-string values are skipped.
 * 6. `undefined` input returns an empty object `{}`.
 *
 * @param headers - The caller's outbound header map (or `undefined`).
 * @param opts    - Optional propagation options (allowlist, baggage).
 * @returns The Pub/Sub `attributes` object to merge onto the message.
 *
 * @example Trace headers only
 * ```ts
 * const attrs = injectContext({
 *   traceparent: '00-abc-01',
 *   authorization: 'Bearer secret',
 * });
 * // → { traceparent: '00-abc-01' }
 * // 'authorization' is NOT on the allowlist — dropped silently.
 * ```
 *
 * @example With business header allowlist
 * ```ts
 * const attrs = injectContext(
 *   { traceparent: '00-abc-01', 'X-Tenant-Id': 'acme' },
 *   { allowlist: ['x-tenant-id'] }
 * );
 * // → { traceparent: '00-abc-01', 'x-tenant-id': 'acme' }
 * ```
 */
export function injectContext(
  headers: Headers | undefined,
  opts?: PropagationOptions
): Attributes {
  if (!headers) return {};

  const allowlist = buildEffectiveAllowlist(opts);
  const result: Attributes = {};

  for (const [key, value] of Object.entries(headers)) {
    if (!isValidAttributeValue(value)) continue;

    const lower = key.toLowerCase();
    if (allowlist.has(lower)) {
      // Normalize to lower-case for attribute storage (consistent with W3C
      // canonical names and Pub/Sub's case-sensitive attribute keys).
      result[lower] = value;
    }
  }

  return result;
}

/**
 * Reconstructs the header map that a message handler should see from inbound
 * Pub/Sub message attributes (inbound / consume side).
 *
 * This is the **symmetric inverse** of {@link injectContext}: given the same
 * `opts`, a round-trip `injectContext` → `extractContext` preserves every
 * allowlisted header that had a valid value.
 *
 * **Rules:**
 * 1. W3C trace headers are always extracted when present.
 * 2. Business headers are extracted only if their key is in the effective
 *    allowlist (same case-insensitive matching as inject).
 * 3. `baggage` is extracted only when `opts.baggage === true`.
 * 4. Non-string and empty-string attribute values are skipped.
 * 5. `undefined` input returns an empty object `{}`.
 *
 * @param attributes - The Pub/Sub message attributes (or `undefined`).
 * @param opts       - Optional propagation options (allowlist, baggage).
 * @returns The reconstructed header map for the message handler.
 *
 * @example Round-trip
 * ```ts
 * const opts = { allowlist: ['x-tenant-id'] };
 * const attrs = injectContext({ traceparent: '00-abc-01', 'x-tenant-id': 'acme' }, opts);
 * const headers = extractContext(attrs, opts);
 * // → { traceparent: '00-abc-01', 'x-tenant-id': 'acme' }
 * ```
 *
 * @example Baggage opt-in
 * ```ts
 * const headers = extractContext(
 *   { traceparent: '00-abc-01', baggage: 'userId=42' },
 *   { baggage: true }
 * );
 * // → { traceparent: '00-abc-01', baggage: 'userId=42' }
 * ```
 */
export function extractContext(
  attributes: Attributes | undefined,
  opts?: PropagationOptions
): Headers {
  if (!attributes) return {};

  const allowlist = buildEffectiveAllowlist(opts);
  const result: Headers = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!isValidAttributeValue(value)) continue;

    const lower = key.toLowerCase();
    if (allowlist.has(lower)) {
      result[lower] = value;
    }
  }

  return result;
}
