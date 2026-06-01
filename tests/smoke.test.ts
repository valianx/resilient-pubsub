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
 * NOTE: _subscriberVersion removed — subscriber placeholder replaced by real
 * exports in PR-6 (createResilientSubscriber, SubscriberOptions, etc.).
 * NOTE: _idempotencyVersion removed — idempotency/redis stubs removed from the
 * public surface in pre-release-review-fixes; deferred to v0.2.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('root barrel loads without throwing', async () => {
  const mod = await import('../src/index.ts');
  // The barrel re-exports real modules; verify at least one known export is present.
  assert.ok(typeof mod.createResilientPublisher === 'function', 'createResilientPublisher must be exported');
  assert.ok(typeof mod.createResilientSubscriber === 'function', 'createResilientSubscriber must be exported');
});
