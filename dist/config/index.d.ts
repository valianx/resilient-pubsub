import { a as BackoffStrategy, b as JitterStrategy } from '../jitter-WIUHHRu7.js';
import { P as PubSubLike, a as SubscriberPubSubLike } from '../pubsub-h9anVIwg.js';

/**
 * Environment-variable configuration resolution for resilient-pubsub.
 *
 * Reads the documented `RESILIENT_PUBSUB_*` environment variables and returns
 * a partial configuration object. Unset or unparseable variables are silently
 * ignored (lenient policy) — the caller falls back to the built-in safe
 * defaults. No exception is ever thrown from this module.
 *
 * **Resolution precedence (highest wins):**
 * 1. Programmatic options (caller-supplied at construction time)
 * 2. Environment variables (`RESILIENT_PUBSUB_*`)
 * 3. Built-in safe defaults (defined in publisher.ts / subscriber.ts)
 *
 * **Lenient-vs-strict policy:** invalid values (non-numeric where an integer
 * is expected, unrecognized enum values) are silently ignored and the variable
 * is treated as unset. This prevents a misconfigured env var from crashing a
 * healthy service on startup. The expected values for each variable are
 * documented below.
 *
 * @module config/env
 */

/**
 * Maximum number of publish attempts (first attempt + retries).
 * Positive integer; default `3`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_MAX_ATTEMPTS=5
 * ```
 */
declare const ENV_MAX_ATTEMPTS = "RESILIENT_PUBSUB_MAX_ATTEMPTS";
/**
 * Backoff strategy between publish retries.
 * Accepted values: `exponential` | `linear` | `constant`. Default `exponential`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_BACKOFF_STRATEGY=linear
 * ```
 */
declare const ENV_BACKOFF_STRATEGY = "RESILIENT_PUBSUB_BACKOFF_STRATEGY";
/**
 * Base delay in milliseconds for the first publish retry.
 * Positive integer; default `1000`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_INITIAL_DELAY=500
 * ```
 */
declare const ENV_INITIAL_DELAY = "RESILIENT_PUBSUB_INITIAL_DELAY";
/**
 * Upper bound for the publish retry backoff delay in milliseconds.
 * Positive integer; default `30000`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_MAX_DELAY=60000
 * ```
 */
declare const ENV_MAX_DELAY = "RESILIENT_PUBSUB_MAX_DELAY";
/**
 * Growth multiplier used by exponential and linear backoff strategies.
 * Positive number (float allowed); default `2`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_MULTIPLIER=1.5
 * ```
 */
declare const ENV_MULTIPLIER = "RESILIENT_PUBSUB_MULTIPLIER";
/**
 * Jitter algorithm applied to the computed publish backoff delay.
 * Accepted values: `full` | `equal` | `decorrelated` | `none`. Default `full`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_JITTER=equal
 * ```
 */
declare const ENV_JITTER = "RESILIENT_PUBSUB_JITTER";
/**
 * Maximum milliseconds to wait for in-flight subscriber handlers when
 * `stop()` is called. Positive integer; default `30000`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_STOP_TIMEOUT_MS=15000
 * ```
 */
declare const ENV_STOP_TIMEOUT_MS = "RESILIENT_PUBSUB_STOP_TIMEOUT_MS";
/**
 * Maximum number of messages the subscriber client holds in memory at once
 * (flow control). Positive integer; default is the native Pub/Sub client's
 * default (typically 100).
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_MAX_MESSAGES=50
 * ```
 */
declare const ENV_MAX_MESSAGES = "RESILIENT_PUBSUB_MAX_MESSAGES";
/**
 * Maximum bytes the subscriber client holds in memory at once (flow control).
 * Positive integer; default is the native Pub/Sub client's default.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_MAX_BYTES=10485760
 * ```
 */
declare const ENV_MAX_BYTES = "RESILIENT_PUBSUB_MAX_BYTES";
/**
 * Publisher-relevant configuration resolved from environment variables.
 * All fields are optional — unset variables produce `undefined`.
 */
interface EnvPublisherConfig {
    /** Maximum number of publish attempts. */
    readonly maxAttempts?: number;
    /** Backoff strategy for publish retries. */
    readonly strategy?: BackoffStrategy;
    /** Base delay in milliseconds. */
    readonly initialDelay?: number;
    /** Upper bound for the backoff delay in milliseconds. */
    readonly maxDelay?: number;
    /** Growth multiplier for backoff calculation. */
    readonly multiplier?: number;
    /** Jitter algorithm for publish retries. */
    readonly jitter?: JitterStrategy;
}
/**
 * Subscriber-relevant configuration resolved from environment variables.
 * All fields are optional — unset variables produce `undefined`.
 */
interface EnvSubscriberConfig {
    /** Graceful-stop drain timeout in milliseconds. */
    readonly stopTimeoutMs?: number;
    /** Flow-control: maximum messages buffered in memory. */
    readonly maxMessages?: number;
    /** Flow-control: maximum bytes buffered in memory. */
    readonly maxBytes?: number;
}
/**
 * Combined resolved configuration from `RESILIENT_PUBSUB_*` environment
 * variables. Contains both publisher and subscriber fields.
 */
interface ResolvedEnvConfig extends EnvPublisherConfig, EnvSubscriberConfig {
}
/**
 * Reads the documented `RESILIENT_PUBSUB_*` environment variables from the
 * provided `env` map and returns a {@link ResolvedEnvConfig} with the parsed
 * values. Unset or unparseable variables produce `undefined` for the
 * corresponding field (lenient policy — never throws).
 *
 * **Why accept `env` as a parameter?**
 * Accepting `env = process.env` makes the function fully deterministic in tests
 * without mutating `process.env`. Pass a fake env object and the function reads
 * from it; in production, the default `process.env` is used automatically.
 *
 * @param env - The environment map to read from. Defaults to `process.env`.
 * @returns Parsed configuration values. Undefined fields should fall back to
 *          built-in safe defaults in the consumer.
 *
 * @example Production usage (reads process.env automatically)
 * ```ts
 * import { resolveConfigFromEnv } from 'resilient-pubsub/config';
 *
 * const envConfig = resolveConfigFromEnv();
 * // envConfig.maxAttempts — set only when RESILIENT_PUBSUB_MAX_ATTEMPTS is a valid int
 * ```
 *
 * @example Test usage (fake env — does not touch process.env)
 * ```ts
 * const cfg = resolveConfigFromEnv({ RESILIENT_PUBSUB_MAX_ATTEMPTS: '5' });
 * assert.equal(cfg.maxAttempts, 5);
 * ```
 */
declare function resolveConfigFromEnv(env?: Record<string, string | undefined>): ResolvedEnvConfig;

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

/**
 * Combined interface satisfied by the real `PubSub` class from
 * `@google-cloud/pubsub`. Used as the return type of `getDefaultPubSubClient`
 * so that both the publisher (needs `topic()`) and the subscriber (needs
 * `subscription()`) can use the same cached instance.
 *
 * @internal
 */
type FullPubSubClient = PubSubLike & SubscriberPubSubLike;
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
declare function getDefaultPubSubClient(): Promise<FullPubSubClient>;
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
declare function _resetDefaultClientCache(): void;

export { ENV_BACKOFF_STRATEGY, ENV_INITIAL_DELAY, ENV_JITTER, ENV_MAX_ATTEMPTS, ENV_MAX_BYTES, ENV_MAX_DELAY, ENV_MAX_MESSAGES, ENV_MULTIPLIER, ENV_STOP_TIMEOUT_MS, type EnvPublisherConfig, type EnvSubscriberConfig, type ResolvedEnvConfig, _resetDefaultClientCache, getDefaultPubSubClient, resolveConfigFromEnv };
