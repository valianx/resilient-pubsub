/**
 * 06-error-handling.ts
 *
 * Tools: ResilientPubSubError, isResilientPubSubError, SerializationError,
 *        classify, isRetryable — REAL implemented API.
 *
 * Error kinds (ErrorKind):
 *   'publish'       — error during message publishing.
 *   'subscribe'     — error during subscriber setup or stream management.
 *   'process'       — error thrown inside a user handler (wrapped for observability).
 *   'serialization' — message could not be serialized or deserialized.
 *   'ack'           — failure acknowledging or nacking a message.
 *   'config'        — invalid library configuration at runtime.
 *
 * Classification (from core/classify):
 *   'transient' — may succeed on a retry (UNAVAILABLE, DEADLINE_EXCEEDED, …).
 *   'permanent' — will not succeed as-is (PERMISSION_DENIED, NOT_FOUND, …).
 *   'poison'    — the message itself is unprocessable (bad serialization).
 *   'unknown'   — cannot be determined from the error shape.
 *
 * isResilientPubSubError(err): type guard. Use this, NOT instanceof.
 *   Reason: the brand (Symbol.for) works across module/realm boundaries;
 *   instanceof does not when the library appears more than once in the tree.
 *
 * toJSON(): always log-safe. Excludes body, cause, meta, and raw attributes.
 *   message is capped at 512 chars and secrets are redacted.
 *   grpcCode is included when present (convenience field for observability).
 */

import {
  ResilientPubSubError,
  isResilientPubSubError,
  SerializationError,
} from 'resilient-pubsub/errors';

import { classify, isRetryable } from 'resilient-pubsub/core';

// ---------------------------------------------------------------------------
// Example A: constructing a ResilientPubSubError.
// ---------------------------------------------------------------------------

/**
 * The library wraps every internal error into a ResilientPubSubError.
 * You can also construct one in your own code (e.g., in a custom serializer
 * or an onRetry hook).
 */
export function example6a(): void {
  // Simulate a gRPC UNAVAILABLE error (code 14) from @google-cloud/pubsub
  const grpcError = Object.assign(new Error('UNAVAILABLE: server overloaded'), { code: 14 });

  const err = new ResilientPubSubError('Publish failed: backend unavailable', {
    kind: 'publish',
    cause: grpcError,
    // classification and retryable are derived automatically from cause when omitted
  });

  console.log(err.name);           // 'ResilientPubSubError'
  console.log(err.kind);           // 'publish'
  console.log(err.classification); // 'transient' — gRPC code 14 = UNAVAILABLE
  console.log(err.retryable);      // true
  console.log(err.grpcCode);       // 14
}

// ---------------------------------------------------------------------------
// Example B: explicit classification override.
// ---------------------------------------------------------------------------

/**
 * Pass an explicit classification when you have authoritative information the
 * classifier cannot determine from the cause alone.
 */
export function example6b(): void {
  const err = new ResilientPubSubError('Topic does not exist', {
    kind: 'config',
    classification: 'permanent',
    retryable: false,
  });

  console.log(err.classification); // 'permanent'
  console.log(err.retryable);      // false
  console.log(err.grpcCode);       // undefined — no gRPC cause
}

// ---------------------------------------------------------------------------
// Example C: isResilientPubSubError type guard.
// ---------------------------------------------------------------------------

/**
 * Always use isResilientPubSubError(err) instead of instanceof.
 * The brand (Symbol.for) survives duplicate module installs in monorepos.
 */
export function example6c(): void {
  const err = new ResilientPubSubError('Connection reset', {
    kind: 'publish',
    cause: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
  });

  if (isResilientPubSubError(err)) {
    console.log(err.kind);           // 'publish'
    console.log(err.classification); // 'transient' — ECONNRESET is a transient Node error
    console.log(err.retryable);      // true

    // Log-safe: body, cause, meta, and raw attributes are excluded.
    const safe = err.toJSON();
    console.log(safe);
    // {
    //   name: 'ResilientPubSubError',
    //   kind: 'publish',
    //   classification: 'transient',
    //   retryable: true,
    //   message: 'Connection reset',
    // }
    console.log('cause' in safe);  // false — excluded for log safety
    console.log('body' in safe);   // false
  }
}

// ---------------------------------------------------------------------------
// Example D: SerializationError — always poison.
// ---------------------------------------------------------------------------

/**
 * SerializationError is a ResilientPubSubError subclass with fixed semantics:
 *   kind           = 'serialization' (const)
 *   classification = 'poison'        (const)
 *   retryable      = false           (const)
 *
 * A poison message must never loop through retries — route it to a dead-letter
 * queue or discard it. The library's subscriber lifecycle detects SerializationError
 * and nacks without further retry.
 */
export function example6d(): void {
  const raw = new SyntaxError('Unexpected token }');

  const serErr = new SerializationError(
    'Failed to parse message payload as JSON: invalid JSON structure',
    raw
  );

  console.log(serErr.name);           // 'SerializationError'
  console.log(serErr.kind);           // 'serialization'
  console.log(serErr.classification); // 'poison'
  console.log(serErr.retryable);      // false

  // isResilientPubSubError works on SerializationError (inherited brand).
  console.log(isResilientPubSubError(serErr)); // true

  // toJSON() is also safe — the raw payload is never included.
  const json = serErr.toJSON();
  console.log(json['kind']);           // 'serialization'
  console.log(json['classification']); // 'poison'
}

// ---------------------------------------------------------------------------
// Example E: classify and isRetryable — raw error inspection.
// ---------------------------------------------------------------------------

/**
 * classify(error) and isRetryable(error) can be used directly on any raw error
 * — you do not need to construct a ResilientPubSubError first. Useful in custom
 * retry loops or observability hooks.
 */
export function example6e(): void {
  // gRPC numeric codes
  console.log(classify({ code: 14 }));  // 'transient'  — UNAVAILABLE
  console.log(classify({ code: 7 }));   // 'permanent'  — PERMISSION_DENIED
  console.log(classify({ code: 5 }));   // 'permanent'  — NOT_FOUND
  console.log(classify({ code: 4 }));   // 'transient'  — DEADLINE_EXCEEDED

  // Node.js network codes
  console.log(classify({ code: 'ECONNREFUSED' })); // 'transient'
  console.log(classify({ code: 'ETIMEDOUT' }));    // 'transient'

  // Poison (duck-typed — no import from envelope needed)
  console.log(classify({ kind: 'serialization', classification: 'poison' })); // 'poison'

  // Unknown
  console.log(classify(new Error('something unexpected'))); // 'unknown'

  // isRetryable is a shorthand for classify(err) === 'transient'
  console.log(isRetryable({ code: 14 })); // true
  console.log(isRetryable({ code: 7 }));  // false

  // Nested cause chain — classify walks up to 5 levels
  const wrapped = { message: 'transport error', cause: { code: 14 } };
  console.log(classify(wrapped)); // 'transient' — found code 14 in cause
}

// ---------------------------------------------------------------------------
// Example F: gRPC classification reference table.
// ---------------------------------------------------------------------------

/**
 * Quick reference: common gRPC status codes and their classifications.
 * Use this when deciding how to handle errors in onRetry or custom logic.
 */
export function example6f(): void {
  const table: Array<[number, string, string]> = [
    [4,  'DEADLINE_EXCEEDED',    'transient'],
    [8,  'RESOURCE_EXHAUSTED',   'transient'],
    [10, 'ABORTED',              'transient'],
    [13, 'INTERNAL',             'transient'],
    [14, 'UNAVAILABLE',          'transient'],
    [3,  'INVALID_ARGUMENT',     'permanent'],
    [5,  'NOT_FOUND',            'permanent'],
    [7,  'PERMISSION_DENIED',    'permanent'],
    [9,  'FAILED_PRECONDITION',  'permanent'],
    [12, 'UNIMPLEMENTED',        'permanent'],
    [16, 'UNAUTHENTICATED',      'permanent'],
  ];

  console.log('gRPC classification reference:');
  for (const [code, name, expected] of table) {
    const actual = classify({ code });
    const ok = actual === expected ? 'ok' : 'MISMATCH';
    console.log(`  code=${code} (${name}) → ${actual} [${ok}]`);
  }
}
