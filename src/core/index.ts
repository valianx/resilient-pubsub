/**
 * resilient-pubsub/core
 *
 * Low-level resilience primitives: backoff calculation, jitter algorithms,
 * sleep utilities, and random number helpers.
 *
 * Future exports:
 * - calculateBackoff(strategy, attempt, options): number
 * - applyJitter(delay, strategy): number
 * - sleep(ms): Promise<void>
 * - BackoffStrategy: 'exponential' | 'linear' | 'constant'
 * - JitterStrategy: 'full' | 'equal' | 'decorrelated' | 'none'
 *
 * @module core
 */

/**
 * Placeholder export — implementation lands in a future PR.
 *
 * @internal
 */
export const _coreVersion = '0.0.0' as const;
