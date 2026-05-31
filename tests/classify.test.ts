/**
 * Tests for PR-2: classify + isRetryable — error classification.
 *
 * Covers:
 * - Transient gRPC codes (numeric and string names)
 * - Permanent gRPC codes
 * - Node network error codes
 * - Nested cause-chain traversal → correct classification
 * - SerializationError-shaped object → 'poison'
 * - Unrecognized errors → 'unknown'
 * - isRetryable predicate (true/false)
 * - Cycle guard: a self-referential cause does not infinite-loop
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classify, isRetryable } from '../src/core/classify.ts';

// ============================================================================
// Transient gRPC codes (numeric)
// ============================================================================

describe('classify — transient gRPC numeric codes', () => {
  const transientCodes = [
    { code: 4, name: 'DEADLINE_EXCEEDED' },
    { code: 8, name: 'RESOURCE_EXHAUSTED' },
    { code: 10, name: 'ABORTED' },
    { code: 13, name: 'INTERNAL' },
    { code: 14, name: 'UNAVAILABLE' },
  ];

  for (const { code, name } of transientCodes) {
    test(`code=${code} (${name}) → 'transient'`, () => {
      assert.equal(classify({ code, message: name }), 'transient');
    });
  }
});

// ============================================================================
// Transient gRPC codes (string names)
// ============================================================================

describe('classify — transient gRPC string names', () => {
  const names = ['DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED', 'ABORTED', 'INTERNAL', 'UNAVAILABLE'];

  for (const name of names) {
    test(`code='${name}' → 'transient'`, () => {
      assert.equal(classify({ code: name }), 'transient');
    });

    test(`code='${name.toLowerCase()}' → 'transient' (case-insensitive)`, () => {
      assert.equal(classify({ code: name.toLowerCase() }), 'transient');
    });
  }
});

// ============================================================================
// Permanent gRPC codes (numeric)
// ============================================================================

describe('classify — permanent gRPC numeric codes', () => {
  const permanentCodes = [
    { code: 3, name: 'INVALID_ARGUMENT' },
    { code: 5, name: 'NOT_FOUND' },
    { code: 6, name: 'ALREADY_EXISTS' },
    { code: 7, name: 'PERMISSION_DENIED' },
    { code: 9, name: 'FAILED_PRECONDITION' },
    { code: 11, name: 'OUT_OF_RANGE' },
    { code: 12, name: 'UNIMPLEMENTED' },
    { code: 16, name: 'UNAUTHENTICATED' },
  ];

  for (const { code, name } of permanentCodes) {
    test(`code=${code} (${name}) → 'permanent'`, () => {
      assert.equal(classify({ code, message: name }), 'permanent');
    });
  }
});

// ============================================================================
// Permanent gRPC codes (string names)
// ============================================================================

describe('classify — permanent gRPC string names', () => {
  const names = [
    'INVALID_ARGUMENT', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED',
    'FAILED_PRECONDITION', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'UNAUTHENTICATED',
  ];

  for (const name of names) {
    test(`code='${name}' → 'permanent'`, () => {
      assert.equal(classify({ code: name }), 'permanent');
    });
  }
});

// ============================================================================
// Node network error codes
// ============================================================================

describe('classify — Node network error codes', () => {
  const nodeCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'];

  for (const code of nodeCodes) {
    test(`code='${code}' → 'transient'`, () => {
      assert.equal(classify({ code }), 'transient');
    });

    test(`'${code}' in message → 'transient'`, () => {
      assert.equal(classify(new Error(`connect ${code} 127.0.0.1:8080`)), 'transient');
    });
  }
});

// ============================================================================
// Cause-chain traversal
// ============================================================================

describe('classify — cause-chain traversal', () => {
  test('one level of nesting: surface error unrecognized, cause is transient', () => {
    const err = { message: 'transport error', cause: { code: 14 } };
    assert.equal(classify(err), 'transient');
  });

  test('two levels of nesting: code buried at cause.cause', () => {
    const err = {
      message: 'outer',
      cause: {
        message: 'middle',
        cause: { code: 14, message: 'UNAVAILABLE' },
      },
    };
    assert.equal(classify(err), 'transient');
  });

  test('surface code wins over nested code', () => {
    const err = { code: 7, cause: { code: 14 } };
    // code=7 is PERMISSION_DENIED (permanent) — surface is checked first
    assert.equal(classify(err), 'permanent');
  });

  test('permanent code in nested cause', () => {
    const err = { message: 'wrapper', cause: { code: 5 } };
    assert.equal(classify(err), 'permanent');
  });

  test('unrecognized at all depths → unknown', () => {
    const err = {
      message: 'outer',
      cause: { message: 'middle', cause: { message: 'inner' } },
    };
    assert.equal(classify(err), 'unknown');
  });
});

// ============================================================================
// Poison: SerializationError-shaped object
// ============================================================================

describe('classify — poison (SerializationError-shaped)', () => {
  test('object with kind=serialization → poison', () => {
    const err = { kind: 'serialization', message: 'JSON parse failed' };
    assert.equal(classify(err), 'poison');
  });

  test('object with classification=poison → poison', () => {
    const err = { classification: 'poison', retryable: false };
    assert.equal(classify(err), 'poison');
  });

  test('both kind=serialization and classification=poison → poison', () => {
    const err = {
      kind: 'serialization',
      classification: 'poison',
      retryable: false,
      message: 'cannot decode payload',
    };
    assert.equal(classify(err), 'poison');
  });

  test('actual SerializationError-shaped class instance → poison', () => {
    // Simulates what SerializationError looks like without importing it.
    class FakeSerializationError extends Error {
      kind = 'serialization' as const;
      classification = 'poison' as const;
      retryable = false as const;
      constructor(msg: string) {
        super(msg);
        this.name = 'SerializationError';
      }
    }
    const err = new FakeSerializationError('bad payload');
    assert.equal(classify(err), 'poison');
  });
});

// ============================================================================
// Unknown errors
// ============================================================================

describe('classify — unknown', () => {
  test('plain Error with no code → unknown', () => {
    assert.equal(classify(new Error('something went wrong')), 'unknown');
  });

  test('null → unknown', () => {
    assert.equal(classify(null), 'unknown');
  });

  test('undefined → unknown', () => {
    assert.equal(classify(undefined), 'unknown');
  });

  test('string → unknown', () => {
    assert.equal(classify('error string'), 'unknown');
  });

  test('number → unknown', () => {
    assert.equal(classify(42), 'unknown');
  });

  test('empty object → unknown', () => {
    assert.equal(classify({}), 'unknown');
  });

  test('unrecognized numeric code (e.g. 99) → unknown', () => {
    assert.equal(classify({ code: 99 }), 'unknown');
  });

  test('unrecognized string code → unknown', () => {
    assert.equal(classify({ code: 'CUSTOM_ERROR' }), 'unknown');
  });
});

// ============================================================================
// isRetryable predicate
// ============================================================================

describe('isRetryable', () => {
  test('transient error → true', () => {
    assert.equal(isRetryable({ code: 14 }), true);
  });

  test('permanent error → false', () => {
    assert.equal(isRetryable({ code: 7 }), false);
  });

  test('poison error → false', () => {
    assert.equal(isRetryable({ kind: 'serialization' }), false);
  });

  test('unknown error → false', () => {
    assert.equal(isRetryable(new Error('whoops')), false);
  });

  test('Node ECONNRESET → true', () => {
    assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
  });

  test('null → false', () => {
    assert.equal(isRetryable(null), false);
  });
});

// ============================================================================
// Cycle guard
// ============================================================================

describe('classify — cycle guard', () => {
  test('self-referential cause does not infinite-loop', () => {
    const err: Record<string, unknown> = { message: 'cyclic error' };
    err['cause'] = err; // self-referential
    // Must complete in bounded time and return 'unknown'.
    const result = classify(err);
    assert.equal(result, 'unknown');
  });

  test('mutual cycle (A → B → A) does not infinite-loop', () => {
    const a: Record<string, unknown> = { message: 'node A' };
    const b: Record<string, unknown> = { message: 'node B', cause: a };
    a['cause'] = b;
    const result = classify(a);
    assert.equal(result, 'unknown');
  });
});
