/**
 * resilient-pubsub/config
 *
 * Configuration utilities: environment-variable resolution and the lazy
 * default Pub/Sub client for zero-config mode.
 *
 * Sub-module import (tree-shakeable):
 * ```ts
 * import { resolveConfigFromEnv } from 'resilient-pubsub/config';
 * import { getDefaultPubSubClient } from 'resilient-pubsub/config';
 * ```
 *
 * **Environment-variable resolution** (`resolveConfigFromEnv`):
 * Reads `RESILIENT_PUBSUB_*` variables and returns a parsed partial config.
 * Pass a fake `env` object in tests to avoid mutating `process.env`.
 *
 * **Zero-config default client** (`getDefaultPubSubClient`):
 * Lazily imports `@google-cloud/pubsub` on first call and caches the instance.
 * GCP credentials come from the standard GCP environment automatically.
 *
 * **Documented env-var name constants** (`ENV_*`):
 * String constants for each supported `RESILIENT_PUBSUB_*` variable, useful
 * for consumers that want to reference the variable names programmatically.
 *
 * @module config
 */

export {
  resolveConfigFromEnv,
  ENV_MAX_ATTEMPTS,
  ENV_BACKOFF_STRATEGY,
  ENV_INITIAL_DELAY,
  ENV_MAX_DELAY,
  ENV_MULTIPLIER,
  ENV_JITTER,
  ENV_STOP_TIMEOUT_MS,
  ENV_MAX_MESSAGES,
  ENV_MAX_BYTES,
} from './env';

export type {
  EnvPublisherConfig,
  EnvSubscriberConfig,
  ResolvedEnvConfig,
} from './env';

export { getDefaultPubSubClient, _resetDefaultClientCache } from './client';
