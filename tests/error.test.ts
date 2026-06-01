/**
 * Tests for PR-3: error surface — ResilientPubSubError, SerializationError,
 * isResilientPubSubError, and redaction helpers.
 *
 * Covers acceptance criteria:
 * - AC-3.1: ResilientPubSubError exposes kind/classification/retryable/cause;
 *            classification is derived from cause when not given.
 * - AC-3.2: toJSON() redacts secrets (Redis URL, private key) and excludes
 *            body/cause/meta/raw attributes.
 * - AC-3.3: toJSON() is free of PII/sensitive headers; message is length-capped.
 * - AC-3.4: SerializationError has classification==='poison', retryable===false,
 *            isResilientPubSubError returns true, classify returns 'poison'.
 * - Brand check: isResilientPubSubError true/false.
 * - redact.ts: redactSecrets, redactHeaders, capMessage unit tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ResilientPubSubError,
  SerializationError,
  isResilientPubSubError,
} from '../src/errors/error.ts';
import { redactSecrets, redactHeaders, capMessage } from '../src/utils/redact.ts';
import { classify } from '../src/core/classify.ts';

// ============================================================================
// AC-3.1: ResilientPubSubError — fields and derivation
// ============================================================================

describe('ResilientPubSubError — kind, classification, retryable', () => {
  test('all ErrorKind variants can be constructed', () => {
    const kinds = ['publish', 'subscribe', 'process', 'serialization', 'ack', 'config'] as const;
    for (const kind of kinds) {
      const err = new ResilientPubSubError(`test ${kind}`, { kind });
      assert.equal(err.kind, kind);
      assert.equal(err.name, 'ResilientPubSubError');
      assert.ok(err instanceof Error);
    }
  });

  test('classification is derived from cause gRPC code 14 (UNAVAILABLE) → transient', () => {
    const cause = { code: 14, message: 'UNAVAILABLE' };
    const err = new ResilientPubSubError('publish failed', { kind: 'publish', cause });
    assert.equal(err.classification, 'transient');
    assert.equal(err.retryable, true);
  });

  test('classification is derived from cause gRPC code 5 (NOT_FOUND) → permanent', () => {
    const cause = { code: 5, message: 'NOT_FOUND' };
    const err = new ResilientPubSubError('topic not found', { kind: 'publish', cause });
    assert.equal(err.classification, 'permanent');
    assert.equal(err.retryable, false);
  });

  test('classification is derived from cause gRPC code 8 (RESOURCE_EXHAUSTED) → transient', () => {
    const cause = { code: 8 };
    const err = new ResilientPubSubError('quota exceeded', { kind: 'subscribe', cause });
    assert.equal(err.classification, 'transient');
    assert.equal(err.retryable, true);
  });

  test('classification explicit override is respected', () => {
    const cause = { code: 14 }; // would normally be transient
    const err = new ResilientPubSubError('forced permanent', {
      kind: 'config',
      cause,
      classification: 'permanent',
    });
    assert.equal(err.classification, 'permanent');
    assert.equal(err.retryable, false);
  });

  test('retryable explicit override is respected', () => {
    const err = new ResilientPubSubError('force retryable', {
      kind: 'ack',
      classification: 'unknown',
      retryable: true,
    });
    assert.equal(err.retryable, true);
  });

  test('cause without a code → unknown classification', () => {
    const cause = new Error('some generic error');
    const err = new ResilientPubSubError('something went wrong', { kind: 'process', cause });
    assert.equal(err.classification, 'unknown');
    assert.equal(err.retryable, false);
  });

  test('no cause → unknown classification', () => {
    const err = new ResilientPubSubError('config error', { kind: 'config' });
    assert.equal(err.classification, 'unknown');
    assert.equal(err.retryable, false);
  });

  test('cause is accessible via .cause property', () => {
    const cause = new Error('original');
    const err = new ResilientPubSubError('wrapped', { kind: 'process', cause });
    assert.equal(err.cause, cause);
  });

  test('grpcCode is extracted from cause.code when numeric', () => {
    const cause = { code: 14, message: 'UNAVAILABLE' };
    const err = new ResilientPubSubError('failed', { kind: 'publish', cause });
    assert.equal(err.grpcCode, 14);
  });

  test('grpcCode is undefined when cause has no numeric code', () => {
    const err = new ResilientPubSubError('no grpc', { kind: 'publish', cause: new Error('plain') });
    assert.equal(err.grpcCode, undefined);
  });

  test('grpcCode extracted from cause.cause.code (one extra level)', () => {
    const cause = { message: 'wrapper', cause: { code: 7 } };
    const err = new ResilientPubSubError('double-wrapped', { kind: 'publish', cause });
    // grpcCode only walks one level; cause.cause.code is not reached by extractGrpcCode
    // (it walks at most cause.code then cause.cause.code — both levels are checked)
    assert.equal(err.grpcCode, 7);
  });
});

// ============================================================================
// AC-3.2: toJSON() — secrets redacted, sensitive fields excluded
// ============================================================================

describe('ResilientPubSubError.toJSON() — secrets redaction', () => {
  test('toJSON includes name, kind, classification, retryable, message', () => {
    const err = new ResilientPubSubError('something failed', {
      kind: 'publish',
      classification: 'transient',
      retryable: true,
    });
    const json = err.toJSON();
    assert.equal(json['name'], 'ResilientPubSubError');
    assert.equal(json['kind'], 'publish');
    assert.equal(json['classification'], 'transient');
    assert.equal(json['retryable'], true);
    assert.equal(json['message'], 'something failed');
  });

  test('toJSON does NOT include cause', () => {
    const cause = new Error('internal raw error');
    const err = new ResilientPubSubError('wrapped', { kind: 'process', cause });
    const json = err.toJSON();
    assert.equal(json['cause'], undefined);
  });

  test('toJSON does NOT include body field', () => {
    const err = new ResilientPubSubError('payload error', { kind: 'serialization' });
    const json = err.toJSON();
    assert.equal(json['body'], undefined);
  });

  test('toJSON does NOT include meta field', () => {
    const err = new ResilientPubSubError('meta error', { kind: 'subscribe' });
    const json = err.toJSON();
    assert.equal(json['meta'], undefined);
  });

  test('toJSON redacts Redis URL credentials in message', () => {
    const err = new ResilientPubSubError(
      'Connection failed: redis://alice:s3cr3t@cache.internal:6379/0',
      { kind: 'config' }
    );
    const json = err.toJSON();
    const msg = json['message'] as string;
    assert.ok(!msg.includes('s3cr3t'), `Password must be redacted. Got: "${msg}"`);
    assert.ok(!msg.includes('alice:'), `Userinfo must be redacted. Got: "${msg}"`);
    assert.ok(msg.includes('cache.internal'), 'Host should remain');
  });

  test('toJSON redacts rediss:// URL credentials in message', () => {
    const err = new ResilientPubSubError(
      'Failed to connect rediss://user:p@ssw0rd@10.0.0.1/1',
      { kind: 'config' }
    );
    const json = err.toJSON();
    const msg = json['message'] as string;
    assert.ok(!msg.includes('p@ssw0rd'), `Password must be redacted. Got: "${msg}"`);
  });

  test('toJSON redacts private key block in message', () => {
    const keyBlock = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBAD...\n-----END PRIVATE KEY-----';
    const err = new ResilientPubSubError(`Auth failed: ${keyBlock}`, { kind: 'config' });
    const json = err.toJSON();
    const msg = json['message'] as string;
    assert.ok(!msg.includes('BEGIN PRIVATE KEY'), `Private key block must be redacted. Got: "${msg}"`);
    assert.ok(!msg.includes('MIIEvQIBAD'), `Key content must be redacted. Got: "${msg}"`);
  });

  test('toJSON includes grpcCode when present', () => {
    const cause = { code: 14 };
    const err = new ResilientPubSubError('unavailable', { kind: 'publish', cause });
    const json = err.toJSON();
    assert.equal(json['grpcCode'], 14);
  });

  test('toJSON omits grpcCode when absent', () => {
    const err = new ResilientPubSubError('no grpc', { kind: 'config' });
    const json = err.toJSON();
    assert.equal('grpcCode' in json, false);
  });
});

// ============================================================================
// AC-3.3: toJSON() — message length cap
// ============================================================================

describe('ResilientPubSubError.toJSON() — message length cap', () => {
  test('message under 512 chars is not truncated', () => {
    const msg = 'a'.repeat(100);
    const err = new ResilientPubSubError(msg, { kind: 'publish' });
    const json = err.toJSON();
    assert.equal(json['message'], msg);
  });

  test('message over 512 chars is truncated to 512 and ends with ellipsis', () => {
    const msg = 'b'.repeat(600);
    const err = new ResilientPubSubError(msg, { kind: 'publish' });
    const json = err.toJSON();
    const result = json['message'] as string;
    assert.equal(result.length, 512);
    assert.ok(result.endsWith('…'), 'Truncated message must end with ellipsis');
  });

  test('toJSON is safe to pass to JSON.stringify', () => {
    const err = new ResilientPubSubError('safe message', { kind: 'ack' });
    assert.doesNotThrow(() => JSON.stringify(err));
  });
});

// ============================================================================
// AC-3.4: SerializationError — subclass, brand, and poison classification
// ============================================================================

describe('SerializationError — reconciled ResilientPubSubError subclass', () => {
  test('is an instance of Error', () => {
    const err = new SerializationError('bad json');
    assert.ok(err instanceof Error);
  });

  test('is an instance of ResilientPubSubError', () => {
    const err = new SerializationError('bad json');
    assert.ok(err instanceof ResilientPubSubError);
  });

  test('kind === serialization', () => {
    const err = new SerializationError('bad json');
    assert.equal(err.kind, 'serialization');
  });

  test('classification === poison', () => {
    const err = new SerializationError('bad json');
    assert.equal(err.classification, 'poison');
  });

  test('retryable === false', () => {
    const err = new SerializationError('bad json');
    assert.equal(err.retryable, false);
  });

  test('name === SerializationError', () => {
    const err = new SerializationError('bad json');
    assert.equal(err.name, 'SerializationError');
  });

  test('isResilientPubSubError returns true for SerializationError', () => {
    const err = new SerializationError('bad payload');
    assert.equal(isResilientPubSubError(err), true);
  });

  test('classify(serializationError) === poison', () => {
    const err = new SerializationError('cannot decode');
    assert.equal(classify(err), 'poison');
  });

  test('cause is accessible when provided', () => {
    const cause = new SyntaxError('Unexpected token');
    const err = new SerializationError('json parse failed', cause);
    assert.equal(err.cause, cause);
  });

  test('cause is undefined when not provided', () => {
    const err = new SerializationError('json parse failed');
    assert.equal(err.cause, undefined);
  });

  test('toJSON() is safe and excludes cause', () => {
    const cause = new SyntaxError('raw parse error with secrets');
    const err = new SerializationError('failed to parse', cause);
    const json = err.toJSON();
    assert.equal(json['cause'], undefined);
    assert.equal(json['kind'], 'serialization');
    assert.equal(json['classification'], 'poison');
    assert.equal(json['retryable'], false);
  });
});

// ============================================================================
// Brand check: isResilientPubSubError
// ============================================================================

describe('isResilientPubSubError — brand guard', () => {
  test('returns true for a ResilientPubSubError instance', () => {
    const err = new ResilientPubSubError('test', { kind: 'publish' });
    assert.equal(isResilientPubSubError(err), true);
  });

  test('returns true for a SerializationError instance', () => {
    const err = new SerializationError('test');
    assert.equal(isResilientPubSubError(err), true);
  });

  test('returns false for a plain Error', () => {
    assert.equal(isResilientPubSubError(new Error('plain')), false);
  });

  test('returns false for null', () => {
    assert.equal(isResilientPubSubError(null), false);
  });

  test('returns false for undefined', () => {
    assert.equal(isResilientPubSubError(undefined), false);
  });

  test('returns false for a plain object', () => {
    assert.equal(isResilientPubSubError({ kind: 'publish' }), false);
  });

  test('returns false for a string', () => {
    assert.equal(isResilientPubSubError('error string'), false);
  });
});

// ============================================================================
// redactSecrets — unit tests
// ============================================================================

describe('redactSecrets — Redis URL credentials', () => {
  test('redacts password in redis:// URL', () => {
    const result = redactSecrets('redis://alice:s3cr3t@cache.internal:6379/0');
    assert.ok(!result.includes('s3cr3t'), `Got: "${result}"`);
    assert.ok(!result.includes('alice:'), `Userinfo must be gone. Got: "${result}"`);
    assert.ok(result.includes('cache.internal'), `Host should remain. Got: "${result}"`);
  });

  test('redacts password in rediss:// URL', () => {
    const result = redactSecrets('rediss://user:p@ssw0rd@10.0.0.1/1');
    assert.ok(!result.includes('p@ssw0rd'), `Got: "${result}"`);
  });

  test('redacts bare password (no username) in redis URL', () => {
    const result = redactSecrets('redis://:mypassword@host:6379');
    assert.ok(!result.includes('mypassword'), `Got: "${result}"`);
  });

  test('does not alter text with no redis URLs', () => {
    const input = 'Connected to postgres://host:5432/db';
    assert.equal(redactSecrets(input), input);
  });

  test('redacts redis URL embedded in a longer string', () => {
    const result = redactSecrets(
      'Connection error for redis://svc:tok3n@redis.prod.internal:6380, retrying...'
    );
    assert.ok(!result.includes('tok3n'), `Got: "${result}"`);
  });
});

describe('redactSecrets — GCP private key', () => {
  test('redacts a PEM private key block', () => {
    const input = [
      'credentials: {',
      '  key: "-----BEGIN PRIVATE KEY-----',
      '  MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC',
      '  -----END PRIVATE KEY-----"',
      '}',
    ].join('\n');
    const result = redactSecrets(input);
    assert.ok(!result.includes('BEGIN PRIVATE KEY'), `Key block must be redacted. Got: "${result}"`);
    assert.ok(!result.includes('MIIEvQIBAD'), `Key body must be redacted. Got: "${result}"`);
  });

  test('redacts private_key JSON field value', () => {
    const input = '{"client_email":"sa@proj.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n"}';
    const result = redactSecrets(input);
    assert.ok(!result.includes('-----BEGIN'), `Got: "${result}"`);
  });

  test('redacts keyFile path assignment', () => {
    const input = 'keyFile: "/etc/secrets/service-account.json"';
    const result = redactSecrets(input);
    assert.ok(
      !result.includes('/etc/secrets/service-account.json'),
      `Path must be redacted. Got: "${result}"`
    );
  });

  test('does not alter strings with no credential patterns', () => {
    const input = 'All systems nominal. Latency: 42ms.';
    assert.equal(redactSecrets(input), input);
  });

  // fix(security-m1): ReDoS regression — unterminated BEGIN KEY block
  // A payload with a -----BEGIN ... KEY----- prefix but no closing delimiter
  // caused catastrophic backtracking in PRIVATE_KEY_BLOCK_PATTERN (O(N²)).
  // Post-fix: redactSecrets caps input to MAX_REDACT_INPUT (8192) before
  // applying regex rules, so the regex always runs on a bounded string.
  test('completes in bounded time on a large unterminated private-key block (ReDoS regression)', () => {
    const payload = '-----BEGIN PRIVATE KEY-----' + 'A'.repeat(100_000);
    const start = performance.now();
    const result = redactSecrets(payload);
    const elapsed = performance.now() - start;

    assert.ok(
      elapsed < 50,
      `redactSecrets must complete in < 50 ms on large unterminated block; took ${elapsed.toFixed(1)} ms`
    );
    // redactSecrets caps its input to MAX_REDACT_INPUT (8192), so output is bounded.
    assert.ok(
      result.length <= 8192,
      `Output length must be bounded to MAX_REDACT_INPUT (got ${result.length})`
    );
    // The raw payload (100k chars) must not pass through unabridged.
    assert.ok(
      !result.includes('A'.repeat(8193)),
      'Raw body beyond MAX_REDACT_INPUT must not appear in the output'
    );
  });

  // fix(security-m1): order guard — cap-before-redact enforces correct behaviour.
  // With the CORRECT order redactSecrets(capMessage(msg)):
  //   capMessage first truncates a 560-char message to 512 chars.  The PEM block
  //   starts at char 500, so only its header appears in the 512-char window and
  //   there is NO closing delimiter → PRIVATE_KEY_BLOCK_PATTERN does not match →
  //   the (truncated, non-functional) fragment passes through un-redacted.
  // With the WRONG order capMessage(redactSecrets(msg)):
  //   redactSecrets first processes the full 560-char message, finds the complete
  //   PEM block (header + body + footer all within 8192-char cap), replaces it
  //   with '[REDACTED]' → capMessage sees a 510-char result and does NOT truncate
  //   → the output contains the literal string '[REDACTED]'.
  // The test asserts the CORRECT order outcome: output does NOT contain '[REDACTED]'
  // for that block (the fragment was truncated away, not redacted).
  // If someone reverts the ordering to capMessage(redactSecrets(...)) or removes
  // capMessage from toJSON() altogether, this test FAILS.
  test('toJSON() caps before redacting — order is enforced (ReDoS order guard)', () => {
    // 500 chars of filler, then a complete PEM block; total ≈ 560 chars.
    const prefix = 'x'.repeat(500);
    const pemBlock = '-----BEGIN PRIVATE KEY-----\nABC123\n-----END PRIVATE KEY-----';
    const payload = prefix + pemBlock;

    const err = new ResilientPubSubError(payload, { kind: 'publish' });
    const json = err.toJSON();
    const msg = json['message'] as string;

    // With cap-before-redact: capMessage truncates to 512 first.
    // The PEM block starts at char 500 → only 12 chars of its header fit before
    // the ellipsis at position 511.  The regex cannot match without the closing
    // delimiter → the word '[REDACTED]' never appears in the output.
    assert.ok(
      typeof msg === 'string' && msg.length <= 512,
      `toJSON().message must be ≤ 512 chars (got ${msg?.length})`
    );
    assert.ok(
      !msg.includes('[REDACTED]'),
      `With cap-before-redact the truncated PEM fragment must NOT be replaced by [REDACTED]; ` +
        `got: "${msg.slice(490)}"`
    );
    // Sanity: the filler prefix is present (message was not wiped entirely).
    assert.ok(msg.startsWith('x'), 'filler prefix must be present in the capped message');
  });

  // fix(security-m1): toJSON() regression — the ORDER redactSecrets(capMessage(...))
  // ensures that ResilientPubSubError.toJSON() never passes an unbounded message
  // to redactSecrets. toJSON() output is always ≤ 512 chars.
  test('toJSON() is bounded in time and length on a large unterminated key block (ReDoS regression)', () => {
    const payload = '-----BEGIN PRIVATE KEY-----' + 'A'.repeat(100_000);
    const err = new ResilientPubSubError(payload, { kind: 'publish' });
    const start = performance.now();
    const json = err.toJSON();
    const elapsed = performance.now() - start;

    assert.ok(
      elapsed < 50,
      `toJSON() must complete in < 50 ms on large unterminated block; took ${elapsed.toFixed(1)} ms`
    );
    const msg = json['message'] as string;
    assert.ok(
      typeof msg === 'string' && msg.length <= 512,
      `toJSON().message must be ≤ 512 chars (got ${msg?.length})`
    );
    // The payload is 100k chars; after cap to 512 the full raw body (100k chars)
    // cannot be present. Check that the message was indeed truncated.
    assert.ok(
      !msg.includes('A'.repeat(513)),
      'toJSON().message must not contain the full oversized payload body'
    );
  });
});

// ============================================================================
// redactHeaders — unit tests
// ============================================================================

describe('redactHeaders', () => {
  test('redacts Authorization header (case-insensitive)', () => {
    const result = redactHeaders({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    assert.equal(result['Authorization'], '[REDACTED]');
    assert.equal(result['Content-Type'], 'application/json');
  });

  test('redacts cookie header (lower-case)', () => {
    const result = redactHeaders({ cookie: 'session=abc123' });
    assert.equal(result['cookie'], '[REDACTED]');
  });

  test('redacts x-api-key', () => {
    const result = redactHeaders({ 'x-api-key': 'key-value' });
    assert.equal(result['x-api-key'], '[REDACTED]');
  });

  test('redacts x-auth-token', () => {
    const result = redactHeaders({ 'X-Auth-Token': 'secret-token' });
    assert.equal(result['X-Auth-Token'], '[REDACTED]');
  });

  test('redacts proxy-authorization', () => {
    const result = redactHeaders({ 'Proxy-Authorization': 'Basic abc' });
    assert.equal(result['Proxy-Authorization'], '[REDACTED]');
  });

  test('redacts any header key matching /secret/i', () => {
    const result = redactHeaders({ 'X-My-Secret': 'value', 'X-Normal': 'ok' });
    assert.equal(result['X-My-Secret'], '[REDACTED]');
    assert.equal(result['X-Normal'], 'ok');
  });

  test('redacts any header key matching /password/i', () => {
    const result = redactHeaders({ 'X-DB-Password': 'hunter2' });
    assert.equal(result['X-DB-Password'], '[REDACTED]');
  });

  test('redacts any header key matching /token/i', () => {
    const result = redactHeaders({ 'x-refresh-token': 'rt-abc' });
    assert.equal(result['x-refresh-token'], '[REDACTED]');
  });

  test('redacts any header key matching /credential/i', () => {
    const result = redactHeaders({ 'X-GCP-Credential': 'val' });
    assert.equal(result['X-GCP-Credential'], '[REDACTED]');
  });

  test('custom denylist is used instead of default when provided', () => {
    const result = redactHeaders(
      { 'X-Trace-Id': '123', Authorization: 'Bearer tok' },
      new Set(['x-trace-id'])
    );
    // Custom denylist only has x-trace-id; Authorization would still be caught
    // by the regex pattern (/token|secret|.../ does not match 'authorization').
    assert.equal(result['X-Trace-Id'], '[REDACTED]');
    // 'authorization' is not in the custom denylist and not matched by the regex,
    // so it passes through with a custom denylist.
    assert.equal(result['Authorization'], 'Bearer tok');
  });

  test('preserves non-sensitive headers unchanged', () => {
    const result = redactHeaders({
      'Content-Type': 'application/json',
      'X-Request-Id': 'req-1',
      Accept: 'application/json',
    });
    assert.equal(result['Content-Type'], 'application/json');
    assert.equal(result['X-Request-Id'], 'req-1');
    assert.equal(result['Accept'], 'application/json');
  });

  test('returns a new object (does not mutate input)', () => {
    const input = { Authorization: 'Bearer tok' };
    const result = redactHeaders(input);
    assert.notEqual(result, input);
    assert.equal(input['Authorization'], 'Bearer tok');
  });
});

// ============================================================================
// capMessage — unit tests
// ============================================================================

describe('capMessage', () => {
  test('string under the cap is returned unchanged', () => {
    const msg = 'short message';
    assert.equal(capMessage(msg), msg);
  });

  test('string at exactly 512 chars is not truncated', () => {
    const msg = 'x'.repeat(512);
    assert.equal(capMessage(msg), msg);
    assert.equal(capMessage(msg).length, 512);
  });

  test('string at 513 chars is truncated to 512 with ellipsis', () => {
    const msg = 'y'.repeat(513);
    const result = capMessage(msg);
    assert.equal(result.length, 512);
    assert.ok(result.endsWith('…'));
  });

  test('string at 600 chars is truncated to 512 with ellipsis', () => {
    const msg = 'z'.repeat(600);
    const result = capMessage(msg);
    assert.equal(result.length, 512);
    assert.ok(result.endsWith('…'));
  });

  test('custom max is respected', () => {
    const result = capMessage('hello world', 5);
    assert.equal(result.length, 5);
    assert.ok(result.endsWith('…'));
  });

  test('custom max — string under cap', () => {
    assert.equal(capMessage('hi', 10), 'hi');
  });

  test('empty string is returned unchanged', () => {
    assert.equal(capMessage(''), '');
  });
});
