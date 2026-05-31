/**
 * 07-context-propagation.ts
 *
 * Tools: injectContext, extractContext, W3C_TRACE_HEADERS — REAL implemented API.
 *
 * This is PR-4 — the propagation module is fully implemented and exported.
 *
 * Purpose: marshal developer-facing HTTP headers into Pub/Sub message attributes
 * (outbound) and back into headers (inbound) so that trace context and
 * allowlisted business headers survive the publisher → message → consumer hop.
 *
 * Security model:
 *   - W3C trace headers ('traceparent', 'tracestate') propagate automatically.
 *     They are correlation IDs, not user data.
 *   - All other headers require explicit inclusion via opts.allowlist.
 *   - W3C 'baggage' is OFF by default — it is the classic PII-leak vector.
 *     Enable with opts.baggage: true only when you control both ends and can
 *     guarantee baggage values contain no PII.
 *   - Attributes are an unredacted channel (wire / logs / DLQ). The allowlist
 *     controls WHAT travels; it does not redact. Do NOT put PII in headers.
 *
 * Zero runtime dependencies — pure W3C-standard string marshalling; no
 * OpenTelemetry SDK, no @google-cloud/pubsub at import time.
 *
 * The publish-side publisher and subscribe-side subscriber call these functions
 * automatically when the factories are implemented (v0.1). This file shows
 * the raw functions for understanding and custom integration.
 */

import {
  injectContext,
  extractContext,
  W3C_TRACE_HEADERS,
} from 'resilient-pubsub/propagation';
import type { PropagationOptions, Headers } from 'resilient-pubsub/propagation';

// ---------------------------------------------------------------------------
// Example A: inject — outbound (publish side), trace headers only.
// ---------------------------------------------------------------------------

/**
 * injectContext extracts the subset of caller headers that should travel as
 * Pub/Sub message attributes. With no options, only W3C trace headers cross.
 */
export function example7a(): void {
  const requestHeaders: Headers = {
    'traceparent': '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    'tracestate': 'vendor1=abc',
    'authorization': 'Bearer secret-token', // NOT on allowlist — dropped silently
    'x-tenant-id': 'acme',                  // NOT on allowlist — dropped silently
  };

  const attributes = injectContext(requestHeaders);

  // Only W3C trace headers cross the hop by default:
  console.log(attributes);
  // {
  //   traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  //   tracestate:  'vendor1=abc'
  // }

  console.log('authorization' in attributes); // false — secret never crosses
  console.log('x-tenant-id' in attributes);   // false — not on default allowlist
}

// ---------------------------------------------------------------------------
// Example B: inject — with business header allowlist.
// ---------------------------------------------------------------------------

/**
 * Extend the default allowlist to propagate specific business headers.
 * Matching is case-insensitive — 'X-Tenant-Id' matches 'x-tenant-id'.
 */
export function example7b(): void {
  const headers: Headers = {
    'traceparent': '00-abc-01',
    'X-Tenant-Id': 'acme',          // will be stored as 'x-tenant-id' (lower-cased)
    'x-correlation-id': 'req-789',  // also on allowlist
    'x-internal-secret': 'do-not-propagate', // NOT on allowlist — dropped
  };

  const opts: PropagationOptions = {
    allowlist: ['x-tenant-id', 'x-correlation-id'],
  };

  const attributes = injectContext(headers, opts);

  console.log(attributes);
  // {
  //   traceparent:        '00-abc-01',
  //   'x-tenant-id':      'acme',       ← stored lower-cased for consistency
  //   'x-correlation-id': 'req-789',
  // }
  // 'x-internal-secret' was silently dropped.
}

// ---------------------------------------------------------------------------
// Example C: extract — inbound (consume side).
// ---------------------------------------------------------------------------

/**
 * extractContext reconstructs the header map from Pub/Sub message attributes.
 * Use the SAME opts as inject to get the symmetric round-trip.
 */
export function example7c(): void {
  // Simulated message.attributes as received by the subscriber
  const messageAttributes: Record<string, string> = {
    'traceparent': '00-abc-01',
    'tracestate': '',               // empty string — skipped (not a valid value)
    'x-tenant-id': 'acme',
    'x-correlation-id': 'req-789',
    'content-type': 'application/json', // not on allowlist — not extracted
    'schema-version': '1',              // not on allowlist — not extracted
  };

  const opts: PropagationOptions = {
    allowlist: ['x-tenant-id', 'x-correlation-id'],
  };

  const headers = extractContext(messageAttributes, opts);

  console.log(headers);
  // {
  //   traceparent:        '00-abc-01',
  //   'x-tenant-id':      'acme',
  //   'x-correlation-id': 'req-789',
  // }
  // 'tracestate' was skipped — empty string is not a valid attribute value.
  // 'content-type' and 'schema-version' were not on the allowlist.
}

// ---------------------------------------------------------------------------
// Example D: symmetric round-trip.
// ---------------------------------------------------------------------------

/**
 * injectContext → attributes → extractContext is a lossless round-trip for
 * every allowlisted header that had a non-empty string value.
 */
export function example7d(): void {
  const original: Headers = {
    'traceparent': '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    'x-tenant-id': 'acme',
    'x-correlation-id': 'req-123',
    'authorization': 'Bearer token', // not on allowlist — dropped on inject
  };

  const opts: PropagationOptions = {
    allowlist: ['x-tenant-id', 'x-correlation-id'],
  };

  const attributes = injectContext(original, opts);
  const restored = extractContext(attributes, opts);

  // Round-trip preserves every allowlisted header:
  console.log(restored['traceparent']);        // '00-0af7...'
  console.log(restored['x-tenant-id']);        // 'acme'
  console.log(restored['x-correlation-id']);   // 'req-123'
  console.log('authorization' in restored);    // false — was dropped on inject
}

// ---------------------------------------------------------------------------
// Example E: baggage opt-in (disabled by default).
// ---------------------------------------------------------------------------

/**
 * W3C baggage propagates ONLY when opts.baggage: true.
 * Never use this when baggage may contain PII (user IDs, emails, etc.).
 */
export function example7e(): void {
  const headers: Headers = {
    'traceparent': '00-abc-01',
    'baggage': 'tenantId=acme,featureFlag=new-checkout', // safe non-PII values
  };

  // Without baggage opt-in — baggage is dropped:
  const withoutBaggage = injectContext(headers);
  console.log('baggage' in withoutBaggage); // false

  // With baggage opt-in:
  const withBaggage = injectContext(headers, { baggage: true });
  console.log(withBaggage['baggage']); // 'tenantId=acme,featureFlag=new-checkout'
}

// ---------------------------------------------------------------------------
// Example F: cross-hop header forwarding (service A → service B).
// ---------------------------------------------------------------------------

/**
 * A common pattern: service A consumes a message, does some work, and publishes
 * a new message. Forwarding msg.headers directly into publish's headers
 * keeps the trace context flowing end-to-end without extra wiring.
 *
 * This works because the message contract is symmetric: the shape you receive
 * is the same shape you publish. Forwarding is a pass-through.
 */
export function example7f(): void {
  // Simulates what the subscriber hands to the handler
  const inboundMsgHeaders: Headers = {
    'traceparent': '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    'x-tenant-id': 'acme',
    'x-correlation-id': 'req-789',
  };

  // The handler can forward headers verbatim into the next publish().
  // The publisher will call injectContext(forwardedHeaders, opts) internally,
  // so only allowlisted keys cross the next hop — no accidental leakage.
  const forwardedHeaders = inboundMsgHeaders;

  // Simulate what the publisher does internally before sending:
  const opts: PropagationOptions = { allowlist: ['x-tenant-id', 'x-correlation-id'] };
  const outboundAttributes = injectContext(forwardedHeaders, opts);

  console.log(outboundAttributes);
  // { traceparent: '00-0af7...', 'x-tenant-id': 'acme', 'x-correlation-id': 'req-789' }
  // Trace context is preserved end-to-end with zero extra wiring.
}

// ---------------------------------------------------------------------------
// Example G: W3C_TRACE_HEADERS constant.
// ---------------------------------------------------------------------------

/**
 * W3C_TRACE_HEADERS is the exported list of header names that are always
 * propagated regardless of the allowlist. Reference it in custom integrations
 * or when building your own propagation logic.
 */
export function example7g(): void {
  console.log(W3C_TRACE_HEADERS); // ['traceparent', 'tracestate']
}
