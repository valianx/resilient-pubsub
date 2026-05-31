/**
 * resilient-pubsub/core
 *
 * Low-level resilience primitives: backoff calculation, jitter algorithms,
 * and error classification for gRPC / Pub/Sub errors.
 *
 * Sub-module imports (tree-shakeable):
 * - {@link calculateBackoff}   — compute retry delay by strategy and attempt number
 * - {@link applyJitter}        — apply randomness to a base delay
 * - {@link classify}           — classify an error as transient/permanent/poison/unknown
 * - {@link isRetryable}        — predicate: `classify(err) === 'transient'`
 *
 * Type exports:
 * - {@link BackoffStrategy}    — `'exponential' | 'linear' | 'constant'`
 * - {@link BackoffOptions}     — options for `calculateBackoff`
 * - {@link JitterStrategy}     — `'full' | 'equal' | 'decorrelated' | 'none'`
 * - {@link JitterOptions}      — options for `applyJitter`
 * - {@link Classification}     — `'transient' | 'permanent' | 'poison' | 'unknown'`
 *
 * @module core
 */

export { calculateBackoff } from './backoff';
export type { BackoffStrategy, BackoffOptions } from './backoff';

export { applyJitter } from './jitter';
export type { JitterStrategy, JitterOptions } from './jitter';

export { classify, isRetryable } from './classify';
export type { Classification } from './classify';
