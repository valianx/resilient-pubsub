/**
 * Tests for PR-4: context and header propagation.
 *
 * Covers acceptance criteria:
 * - AC-4.1: injectContext always includes traceparent/tracestate when present,
 *            even with no allowlist.
 * - AC-4.2: business headers travel ONLY if in the extended allowlist; a
 *            header NOT in the allowlist is dropped; matching is case-insensitive.
 * - AC-4.3: baggage is NOT propagated unless opts.baggage === true.
 * - AC-4.4: extractContext is the symmetric inverse of injectContext; a
 *            round-trip with the same opts preserves the allowlisted set.
 * - AC-4.5: zero runtime deps (no @google-cloud/pubsub, no OTel SDK);
 *            undefined inputs return {}; non-string / empty values are skipped.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { injectContext, extractContext, W3C_TRACE_HEADERS } from '../src/propagation/propagation.ts';

// ============================================================================
// AC-4.1: W3C trace headers are always propagated
// ============================================================================

describe('injectContext — AC-4.1: trace headers always propagated', () => {
  test('includes traceparent when present, no opts', () => {
    const result = injectContext({ traceparent: '00-abc123-01' });
    assert.equal(result['traceparent'], '00-abc123-01');
  });

  test('includes tracestate when present, no opts', () => {
    const result = injectContext({ tracestate: 'vendor=value' });
    assert.equal(result['tracestate'], 'vendor=value');
  });

  test('includes both traceparent and tracestate together, no opts', () => {
    const result = injectContext({
      traceparent: '00-abc-01',
      tracestate: 'rojo=00f067',
    });
    assert.equal(result['traceparent'], '00-abc-01');
    assert.equal(result['tracestate'], 'rojo=00f067');
  });

  test('includes trace headers even when non-trace headers are also present', () => {
    const result = injectContext({
      traceparent: '00-abc-01',
      authorization: 'Bearer secret',
      'x-tenant-id': 'acme',
    });
    assert.equal(result['traceparent'], '00-abc-01');
    // non-allowlisted headers are dropped
    assert.equal(result['authorization'], undefined);
    assert.equal(result['x-tenant-id'], undefined);
  });

  test('includes trace headers even when allowlist is an empty array', () => {
    const result = injectContext(
      { traceparent: '00-abc-01', tracestate: 'k=v' },
      { allowlist: [] }
    );
    assert.equal(result['traceparent'], '00-abc-01');
    assert.equal(result['tracestate'], 'k=v');
  });

  test('W3C_TRACE_HEADERS constant contains traceparent and tracestate', () => {
    assert.ok(W3C_TRACE_HEADERS.includes('traceparent'));
    assert.ok(W3C_TRACE_HEADERS.includes('tracestate'));
  });
});

// ============================================================================
// AC-4.2: business headers travel only if in the allowlist; case-insensitive
// ============================================================================

describe('injectContext — AC-4.2: allowlist controls business header propagation', () => {
  test('business header in allowlist is propagated', () => {
    const result = injectContext(
      { 'x-tenant-id': 'acme', traceparent: '00-abc-01' },
      { allowlist: ['x-tenant-id'] }
    );
    assert.equal(result['x-tenant-id'], 'acme');
    assert.equal(result['traceparent'], '00-abc-01');
  });

  test('business header NOT in allowlist is dropped silently', () => {
    const result = injectContext(
      { 'x-tenant-id': 'acme', 'x-request-source': 'api' },
      { allowlist: ['x-tenant-id'] }
    );
    assert.equal(result['x-tenant-id'], 'acme');
    assert.equal(result['x-request-source'], undefined);
  });

  test('allowlist matching is case-insensitive — uppercase key in headers', () => {
    const result = injectContext(
      { 'X-Tenant-Id': 'acme' },
      { allowlist: ['x-tenant-id'] }
    );
    // Key normalized to lower-case in output
    assert.equal(result['x-tenant-id'], 'acme');
  });

  test('allowlist matching is case-insensitive — uppercase entry in allowlist', () => {
    const result = injectContext(
      { 'x-tenant-id': 'acme' },
      { allowlist: ['X-Tenant-Id'] }
    );
    assert.equal(result['x-tenant-id'], 'acme');
  });

  test('allowlist matching is case-insensitive — mixed case in both', () => {
    const result = injectContext(
      { 'X-Correlation-ID': 'req-42' },
      { allowlist: ['x-correlation-id'] }
    );
    assert.equal(result['x-correlation-id'], 'req-42');
  });

  test('multiple allowlisted business headers all propagate', () => {
    const result = injectContext(
      {
        traceparent: '00-abc-01',
        'x-tenant-id': 'acme',
        'x-correlation-id': 'req-99',
        authorization: 'Bearer secret',
      },
      { allowlist: ['x-tenant-id', 'x-correlation-id'] }
    );
    assert.equal(result['traceparent'], '00-abc-01');
    assert.equal(result['x-tenant-id'], 'acme');
    assert.equal(result['x-correlation-id'], 'req-99');
    assert.equal(result['authorization'], undefined);
  });

  test('output keys are all lower-cased (canonical attribute form)', () => {
    const result = injectContext(
      { 'X-Tenant-Id': 'acme', Traceparent: '00-abc-01' },
      { allowlist: ['x-tenant-id'] }
    );
    const keys = Object.keys(result);
    for (const key of keys) {
      assert.equal(key, key.toLowerCase(), `Key '${key}' should be lower-cased`);
    }
  });
});

// ============================================================================
// AC-4.3: baggage is NOT propagated unless opts.baggage === true
// ============================================================================

describe('injectContext — AC-4.3: baggage is off by default', () => {
  test('baggage header is dropped when opts.baggage is not set', () => {
    const result = injectContext({
      traceparent: '00-abc-01',
      baggage: 'userId=42,feature=x',
    });
    assert.equal(result['baggage'], undefined);
    assert.equal(result['traceparent'], '00-abc-01');
  });

  test('baggage header is dropped when opts.baggage === false', () => {
    const result = injectContext(
      { traceparent: '00-abc-01', baggage: 'userId=42' },
      { baggage: false }
    );
    assert.equal(result['baggage'], undefined);
  });

  test('baggage header IS propagated when opts.baggage === true', () => {
    const result = injectContext(
      { traceparent: '00-abc-01', baggage: 'userId=42' },
      { baggage: true }
    );
    assert.equal(result['baggage'], 'userId=42');
    assert.equal(result['traceparent'], '00-abc-01');
  });

  test('baggage opt-in does not affect other non-allowlisted headers', () => {
    const result = injectContext(
      { baggage: 'k=v', authorization: 'Bearer tok', traceparent: '00-abc-01' },
      { baggage: true }
    );
    assert.equal(result['baggage'], 'k=v');
    assert.equal(result['authorization'], undefined);
  });

  test('baggage + allowlist together both work', () => {
    const result = injectContext(
      { baggage: 'k=v', 'x-tenant-id': 'acme', traceparent: '00-abc-01' },
      { baggage: true, allowlist: ['x-tenant-id'] }
    );
    assert.equal(result['baggage'], 'k=v');
    assert.equal(result['x-tenant-id'], 'acme');
    assert.equal(result['traceparent'], '00-abc-01');
  });
});

// ============================================================================
// AC-4.4: extractContext — symmetric inverse of injectContext
// ============================================================================

describe('extractContext — AC-4.4: symmetric inverse of injectContext', () => {
  test('extracts traceparent from attributes', () => {
    const result = extractContext({ traceparent: '00-abc-01', tracestate: 'k=v' });
    assert.equal(result['traceparent'], '00-abc-01');
    assert.equal(result['tracestate'], 'k=v');
  });

  test('drops attributes not in the effective allowlist', () => {
    const result = extractContext({
      traceparent: '00-abc-01',
      'x-tenant-id': 'acme',
      authorization: 'Bearer tok',
    });
    assert.equal(result['traceparent'], '00-abc-01');
    assert.equal(result['x-tenant-id'], undefined);
    assert.equal(result['authorization'], undefined);
  });

  test('extracts allowlisted business headers', () => {
    const result = extractContext(
      { traceparent: '00-abc-01', 'x-tenant-id': 'acme', 'x-other': 'val' },
      { allowlist: ['x-tenant-id'] }
    );
    assert.equal(result['x-tenant-id'], 'acme');
    assert.equal(result['x-other'], undefined);
  });

  test('extractContext is case-insensitive on attribute keys', () => {
    const result = extractContext(
      { Traceparent: '00-abc-01' },
      {}
    );
    // lower-cased key 'traceparent' is in allowlist
    assert.equal(result['traceparent'], '00-abc-01');
  });

  test('round-trip — inject then extract with no opts preserves trace headers', () => {
    const original = { traceparent: '00-abc-01', tracestate: 'vendor=00' };
    const attrs = injectContext(original);
    const recovered = extractContext(attrs);
    assert.equal(recovered['traceparent'], original['traceparent']);
    assert.equal(recovered['tracestate'], original['tracestate']);
  });

  test('round-trip — inject then extract with allowlist preserves the allowlisted set', () => {
    const opts = { allowlist: ['x-tenant-id', 'x-correlation-id'] };
    const original = {
      traceparent: '00-abc-01',
      'x-tenant-id': 'acme',
      'x-correlation-id': 'req-99',
      authorization: 'Bearer secret',
    };
    const attrs = injectContext(original, opts);
    const recovered = extractContext(attrs, opts);

    assert.equal(recovered['traceparent'], '00-abc-01');
    assert.equal(recovered['x-tenant-id'], 'acme');
    assert.equal(recovered['x-correlation-id'], 'req-99');
    // authorization was never injected, so it cannot be recovered
    assert.equal(recovered['authorization'], undefined);
  });

  test('round-trip — baggage opt-in is preserved across the hop', () => {
    const opts = { baggage: true as const };
    const original = { traceparent: '00-abc-01', baggage: 'userId=42' };
    const attrs = injectContext(original, opts);
    const recovered = extractContext(attrs, opts);
    assert.equal(recovered['baggage'], 'userId=42');
  });

  test('round-trip — baggage is absent when not opted in', () => {
    const original = { traceparent: '00-abc-01', baggage: 'userId=42' };
    // inject drops baggage (no opt-in)
    const attrs = injectContext(original);
    // extract also would not find it (it was never injected)
    const recovered = extractContext(attrs);
    assert.equal(recovered['baggage'], undefined);
  });
});

// ============================================================================
// AC-4.5: zero runtime deps, undefined inputs, non-string / empty values
// ============================================================================

describe('injectContext / extractContext — AC-4.5: edge cases and purity', () => {
  // Undefined inputs
  test('injectContext(undefined) returns {}', () => {
    assert.deepEqual(injectContext(undefined), {});
  });

  test('injectContext(undefined, opts) returns {}', () => {
    assert.deepEqual(injectContext(undefined, { allowlist: ['x-foo'] }), {});
  });

  test('extractContext(undefined) returns {}', () => {
    assert.deepEqual(extractContext(undefined), {});
  });

  test('extractContext(undefined, opts) returns {}', () => {
    assert.deepEqual(extractContext(undefined, { allowlist: ['x-foo'] }), {});
  });

  // Empty objects
  test('injectContext({}) returns {}', () => {
    assert.deepEqual(injectContext({}), {});
  });

  test('extractContext({}) returns {}', () => {
    assert.deepEqual(extractContext({}), {});
  });

  // Non-string / empty values in headers are skipped
  test('injectContext skips empty-string values for trace headers', () => {
    const result = injectContext({ traceparent: '' });
    assert.equal(result['traceparent'], undefined);
  });

  test('injectContext skips empty-string values for allowlisted headers', () => {
    const result = injectContext(
      { 'x-tenant-id': '' },
      { allowlist: ['x-tenant-id'] }
    );
    assert.equal(result['x-tenant-id'], undefined);
  });

  test('extractContext skips empty-string attribute values', () => {
    const result = extractContext({ traceparent: '' });
    assert.equal(result['traceparent'], undefined);
  });

  // Behavior is pure string marshalling — output is plain objects
  test('injectContext result is a plain object with string values', () => {
    const result = injectContext({ traceparent: '00-abc-01' });
    assert.ok(result !== null && typeof result === 'object');
    for (const val of Object.values(result)) {
      assert.equal(typeof val, 'string');
    }
  });

  test('extractContext result is a plain object with string values', () => {
    const result = extractContext({ traceparent: '00-abc-01' });
    assert.ok(result !== null && typeof result === 'object');
    for (const val of Object.values(result)) {
      assert.equal(typeof val, 'string');
    }
  });

  // No mutation of input
  test('injectContext does not mutate the input headers', () => {
    const headers = { traceparent: '00-abc-01', authorization: 'Bearer tok' };
    const copy = { ...headers };
    injectContext(headers, { allowlist: [] });
    assert.deepEqual(headers, copy);
  });

  test('extractContext does not mutate the input attributes', () => {
    const attrs = { traceparent: '00-abc-01', 'x-sensitive': 'val' };
    const copy = { ...attrs };
    extractContext(attrs);
    assert.deepEqual(attrs, copy);
  });

  // The module must NOT import @google-cloud/pubsub or any OTel package.
  // This is a structural constraint verified by inspecting the module imports.
  // A runtime check: both functions return plain objects with only string values.
  test('injectContext and extractContext produce only Record<string,string> output', () => {
    const injected = injectContext(
      { traceparent: '00-abc-01', 'x-tenant-id': 'acme' },
      { allowlist: ['x-tenant-id'] }
    );
    const extracted = extractContext(injected, { allowlist: ['x-tenant-id'] });

    for (const [k, v] of Object.entries(injected)) {
      assert.equal(typeof k, 'string');
      assert.equal(typeof v, 'string');
    }
    for (const [k, v] of Object.entries(extracted)) {
      assert.equal(typeof k, 'string');
      assert.equal(typeof v, 'string');
    }
  });

  // Duplicate keys differing only by case — only the lower-cased form wins
  test('duplicate keys differing only in case — last matching value wins (lowercase normalized)', () => {
    // When a headers object has both 'Traceparent' and 'traceparent' (unusual
    // but possible via Object spread), both map to the same lowercased key.
    // The last entry in iteration order wins.
    const result = injectContext({
      Traceparent: '00-first-01',
      traceparent: '00-second-01',
    });
    // Both normalized to 'traceparent'; the last one wins.
    assert.equal(result['traceparent'], '00-second-01');
  });
});
