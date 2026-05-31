/**
 * Scaffold smoke test.
 *
 * Verifies that the public barrel and sub-module barrels load without throwing
 * and expose their placeholder surface. Real unit tests land per feature PR.
 *
 * NOTE: _envelopeVersion removed — the envelope placeholder was replaced by
 * real exports in PR-1 (Envelope, Serializer, JsonSerializer).
 * NOTE: _coreVersion removed — core placeholder replaced by real exports in PR-2.
 * NOTE: _errorsVersion removed — errors placeholder replaced by real exports in PR-3.
 * NOTE: _publisherVersion removed — publisher placeholder replaced by real
 * exports in PR-5 (createResilientPublisher, PublisherOptions, etc.).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('root barrel re-exports the sub-module placeholders', async () => {
  const mod = await import('../src/index.ts');
  assert.equal(mod._idempotencyVersion, '0.0.0');
  assert.equal(mod._subscriberVersion, '0.0.0');
});
