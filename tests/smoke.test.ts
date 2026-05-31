/**
 * Scaffold smoke test.
 *
 * Verifies that the public barrel and sub-module barrels load without throwing
 * and expose their placeholder surface. Real unit tests land per feature PR.
 *
 * NOTE: _envelopeVersion removed — the envelope placeholder was replaced by
 * real exports in PR-1 (Envelope, Serializer, JsonSerializer).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('root barrel re-exports the sub-module placeholders', async () => {
  const mod = await import('../src/index.ts');
  // _coreVersion removed — core placeholder replaced by real exports in PR-2.
  assert.equal(mod._errorsVersion, '0.0.0');
  assert.equal(mod._idempotencyVersion, '0.0.0');
  assert.equal(mod._publisherVersion, '0.0.0');
  assert.equal(mod._subscriberVersion, '0.0.0');
});
