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

import type { BackoffStrategy, JitterStrategy } from '../core/index';

// ============================================================================
// Documented env-var name constants (exported for consumer reference)
// ============================================================================

/**
 * Maximum number of publish attempts (first attempt + retries).
 * Positive integer; default `3`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_MAX_ATTEMPTS=5
 * ```
 */
export const ENV_MAX_ATTEMPTS = 'RESILIENT_PUBSUB_MAX_ATTEMPTS';

/**
 * Backoff strategy between publish retries.
 * Accepted values: `exponential` | `linear` | `constant`. Default `exponential`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_BACKOFF_STRATEGY=linear
 * ```
 */
export const ENV_BACKOFF_STRATEGY = 'RESILIENT_PUBSUB_BACKOFF_STRATEGY';

/**
 * Base delay in milliseconds for the first publish retry.
 * Positive integer; default `1000`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_INITIAL_DELAY=500
 * ```
 */
export const ENV_INITIAL_DELAY = 'RESILIENT_PUBSUB_INITIAL_DELAY';

/**
 * Upper bound for the publish retry backoff delay in milliseconds.
 * Positive integer; default `30000`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_MAX_DELAY=60000
 * ```
 */
export const ENV_MAX_DELAY = 'RESILIENT_PUBSUB_MAX_DELAY';

/**
 * Growth multiplier used by exponential and linear backoff strategies.
 * Positive number (float allowed); default `2`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_MULTIPLIER=1.5
 * ```
 */
export const ENV_MULTIPLIER = 'RESILIENT_PUBSUB_MULTIPLIER';

/**
 * Jitter algorithm applied to the computed publish backoff delay.
 * Accepted values: `full` | `equal` | `decorrelated` | `none`. Default `full`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_JITTER=equal
 * ```
 */
export const ENV_JITTER = 'RESILIENT_PUBSUB_JITTER';

/**
 * Maximum milliseconds to wait for in-flight subscriber handlers when
 * `stop()` is called. Positive integer; default `30000`.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_STOP_TIMEOUT_MS=15000
 * ```
 */
export const ENV_STOP_TIMEOUT_MS = 'RESILIENT_PUBSUB_STOP_TIMEOUT_MS';

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
export const ENV_MAX_MESSAGES = 'RESILIENT_PUBSUB_MAX_MESSAGES';

/**
 * Maximum bytes the subscriber client holds in memory at once (flow control).
 * Positive integer; default is the native Pub/Sub client's default.
 *
 * @example
 * ```sh
 * RESILIENT_PUBSUB_MAX_BYTES=10485760
 * ```
 */
export const ENV_MAX_BYTES = 'RESILIENT_PUBSUB_MAX_BYTES';

// ============================================================================
// Resolved config shapes
// ============================================================================

/**
 * Publisher-relevant configuration resolved from environment variables.
 * All fields are optional — unset variables produce `undefined`.
 */
export interface EnvPublisherConfig {
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
export interface EnvSubscriberConfig {
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
export interface ResolvedEnvConfig extends EnvPublisherConfig, EnvSubscriberConfig {}

// ============================================================================
// Valid value sets for enum-like variables
// ============================================================================

const VALID_BACKOFF_STRATEGIES: readonly BackoffStrategy[] = ['exponential', 'linear', 'constant'];
const VALID_JITTER_STRATEGIES: readonly JitterStrategy[] = ['full', 'equal', 'decorrelated', 'none'];

// ============================================================================
// Internal parsers (lenient — return undefined on invalid input)
// ============================================================================

/**
 * Parses a positive integer from a string. Returns `undefined` when the
 * string is absent, empty, non-numeric, non-positive, or not finite.
 *
 * @internal
 */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * Parses a positive number (float allowed) from a string. Returns `undefined`
 * when the string is absent, empty, non-numeric, or non-positive.
 *
 * @internal
 */
function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Parses a `BackoffStrategy` enum value. Returns `undefined` when the string
 * is absent or not one of the accepted values.
 *
 * @internal
 */
function parseBackoffStrategy(raw: string | undefined): BackoffStrategy | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim() as BackoffStrategy;
  return (VALID_BACKOFF_STRATEGIES as readonly string[]).includes(trimmed) ? trimmed : undefined;
}

/**
 * Parses a `JitterStrategy` enum value. Returns `undefined` when the string
 * is absent or not one of the accepted values.
 *
 * @internal
 */
function parseJitterStrategy(raw: string | undefined): JitterStrategy | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim() as JitterStrategy;
  return (VALID_JITTER_STRATEGIES as readonly string[]).includes(trimmed) ? trimmed : undefined;
}

// ============================================================================
// Public API
// ============================================================================

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
export function resolveConfigFromEnv(env: Record<string, string | undefined> = process.env): ResolvedEnvConfig {
  return {
    maxAttempts: parsePositiveInt(env[ENV_MAX_ATTEMPTS]),
    strategy: parseBackoffStrategy(env[ENV_BACKOFF_STRATEGY]),
    initialDelay: parsePositiveInt(env[ENV_INITIAL_DELAY]),
    maxDelay: parsePositiveInt(env[ENV_MAX_DELAY]),
    multiplier: parsePositiveNumber(env[ENV_MULTIPLIER]),
    jitter: parseJitterStrategy(env[ENV_JITTER]),
    stopTimeoutMs: parsePositiveInt(env[ENV_STOP_TIMEOUT_MS]),
    maxMessages: parsePositiveInt(env[ENV_MAX_MESSAGES]),
    maxBytes: parsePositiveInt(env[ENV_MAX_BYTES]),
  };
}
