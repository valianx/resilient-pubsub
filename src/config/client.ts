/**
 * Lazy default Pub/Sub client for resilient-pubsub zero-config mode.
 *
 * When a caller creates a publisher or subscriber without providing a
 * `pubSubClient`, the library resolves a default client from this module.
 * The client is created via a **dynamic import** of `@google-cloud/pubsub` so
 * that:
 *
 * - The peer dependency is **never loaded** for apps that pass their own client
 *   (publisher-only apps, apps with a shared client, etc.).
 * - The core library bundle stays import-light — no top-level require of the
 *   peer at module evaluation time.
 *
 * The resolved client is **cached** (a singleton per process) so that multiple
 * publishers and subscribers created without an explicit client share one
 * underlying connection.
 *
 * **GCP project and credentials** are read automatically by the native
 * `@google-cloud/pubsub` client from the standard GCP environment:
 * - `GOOGLE_CLOUD_PROJECT` — GCP project ID
 * - `GOOGLE_APPLICATION_CREDENTIALS` — path to a service-account key file
 * - Application Default Credentials (ADC) via the metadata server on GCP
 *
 * The library does **not** re-implement credential logic; it delegates entirely
 * to the native client.
 *
 * **Error path:** if the dynamic import fails (peer not installed or the module
 * cannot be loaded), the function rejects with a `ResilientPubSubError` of
 * `kind: 'config'` that includes an actionable message.
 *
 * @module config/client
 */

import { ResilientPubSubError } from '../errors/error';
import type { PubSubLike, SubscriberPubSubLike } from '../types/pubsub';

// ============================================================================
// Full-client type (publisher + subscriber combined)
// ============================================================================

/**
 * Combined interface satisfied by the real `PubSub` class from
 * `@google-cloud/pubsub`. Used as the return type of `getDefaultPubSubClient`
 * so that both the publisher (needs `topic()`) and the subscriber (needs
 * `subscription()`) can use the same cached instance.
 *
 * @internal
 */
export type FullPubSubClient = PubSubLike & SubscriberPubSubLike;

// ============================================================================
// Singleton cache
// ============================================================================

/**
 * Lazily resolved singleton. `undefined` until the first call to
 * `getDefaultPubSubClient()`. Retained across calls so that subsequent
 * invocations return the same instance without re-importing the peer.
 *
 * @internal
 */
let cachedClient: FullPubSubClient | undefined;

// ============================================================================
// Public API
// ============================================================================

/**
 * Returns the default `PubSub` client instance, creating it on the first call
 * via a dynamic import of `@google-cloud/pubsub`.
 *
 * The client is cached after the first successful resolution — subsequent calls
 * return the same instance without re-importing the module or creating a new
 * connection.
 *
 * **GCP credentials** are resolved automatically by the native client from
 * the standard GCP environment (`GOOGLE_CLOUD_PROJECT`,
 * `GOOGLE_APPLICATION_CREDENTIALS`, or ADC on GCP runtimes).
 *
 * @returns A promise that resolves to the shared default `PubSubLike` client.
 * @throws {ResilientPubSubError} `{ kind: 'config' }` when the peer dependency
 *   `@google-cloud/pubsub` is not installed or cannot be imported.
 *
 * @example Zero-config publisher (no explicit client)
 * ```ts
 * // Internally called by createResilientPublisher when pubSubClient is omitted.
 * // Set GOOGLE_CLOUD_PROJECT (and ADC / GOOGLE_APPLICATION_CREDENTIALS) in env.
 * const client = await getDefaultPubSubClient();
 * ```
 *
 * @example Resetting the cache in tests (via the internal seam)
 * ```ts
 * import { _resetDefaultClientCache } from 'resilient-pubsub/config';
 * _resetDefaultClientCache(); // clears cachedClient for the next test
 * ```
 */
export async function getDefaultPubSubClient(): Promise<FullPubSubClient> {
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  let PubSubConstructor: new () => FullPubSubClient;

  try {
    // Dynamic import keeps the peer out of the static module graph. This is
    // intentional: apps that provide their own client never pay the cost of
    // loading @google-cloud/pubsub here.
    const module = await import('@google-cloud/pubsub');
    PubSubConstructor = module.PubSub as new () => FullPubSubClient;
  } catch {
    throw new ResilientPubSubError(
      `Could not import '@google-cloud/pubsub'. ` +
        `Install the peer dependency ('pnpm add @google-cloud/pubsub') or pass a ` +
        `'pubSubClient' explicitly to createResilientPublisher / createResilientSubscriber.`,
      { kind: 'config', classification: 'permanent', retryable: false }
    );
  }

  // Credentials and project are read from GCP environment by the native client.
  cachedClient = new PubSubConstructor();
  return cachedClient;
}

/**
 * Resets the cached default client. Intended exclusively for test isolation —
 * allows tests that exercise the lazy-resolution path to start with a clean
 * slate without affecting each other.
 *
 * **Do not call in production code.**
 *
 * @internal
 *
 * @example
 * ```ts
 * import { _resetDefaultClientCache } from 'resilient-pubsub/config';
 *
 * afterEach(() => _resetDefaultClientCache());
 * ```
 */
export function _resetDefaultClientCache(): void {
  cachedClient = undefined;
}
