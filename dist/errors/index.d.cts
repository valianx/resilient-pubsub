export { E as ErrorKind, R as ResilientPubSubError, a as ResilientPubSubErrorOptions, S as SerializationError, i as isResilientPubSubError } from '../error-D2Fc_HlK.cjs';
export { C as Classification } from '../classify-mrmGdAaM.cjs';

/**
 * Redaction helpers for resilient-pubsub.
 *
 * Pure, zero-dependency utilities that sanitize secrets and PII from
 * free-text messages, header maps, and log strings before they are
 * emitted to structured logs or serialized into error payloads.
 *
 * **Design principles:**
 * - Conservative: when in doubt, redact.
 * - Fail-safe: if URL parsing throws, redact the entire token rather than
 *   leaking a partial credential.
 * - No side effects, no I/O, no global state.
 *
 * @module utils/redact
 */
/**
 * Redacts known secret patterns from a free-text string.
 *
 * Rules applied in order:
 * 1. **Redis / Rediss URLs with credentials** — the userinfo component
 *    (everything between `://` and `@`) is replaced with `[REDACTED]@`.
 *    If URL parsing fails for any reason, the entire `redis[s]://...` token
 *    is redacted defensively.
 * 2. **PEM private-key blocks** (`-----BEGIN ... KEY-----` … `-----END ... KEY-----`).
 * 3. **`private_key` JSON field values** (GCP service-account objects logged
 *    as JSON snippets).
 * 4. **GCP keyfile path assignments** (e.g., `keyFile: '/path/to/sa.json'`).
 *
 * The function is conservative: overlapping matches are handled by applying
 * rules in order; the output is not guaranteed to be valid JSON or a valid
 * connection string after redaction.
 *
 * @param text - The input string to sanitize.
 * @returns The sanitized string with secrets replaced by `'[REDACTED]'`.
 *
 * @example Redis URL with credentials
 * ```ts
 * redactSecrets('redis://alice:s3cr3t@cache.internal:6379/0');
 * // → 'redis://[REDACTED]@cache.internal:6379/0'
 * ```
 *
 * @example GCP private key block
 * ```ts
 * redactSecrets('key: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----"');
 * // → 'key: "[REDACTED]"'
 * ```
 */
declare function redactSecrets(text: string): string;
/**
 * Returns a copy of `headers` with sensitive values replaced by `'[REDACTED]'`.
 *
 * A header is considered sensitive when its lower-cased key:
 * - Is present in `denylist` (default: authorization, cookie, set-cookie,
 *   x-api-key, api-key, x-auth-token, proxy-authorization), **or**
 * - Matches the pattern `/secret|token|password|credential/i`.
 *
 * Matching is always case-insensitive regardless of the original key casing.
 *
 * @param headers  - The header map to sanitize. Values must be strings.
 * @param denylist - Optional custom denylist (lower-cased keys). When provided,
 *   it is used **in addition to** the regex pattern; it replaces the built-in
 *   denylist entirely if you want stricter or looser defaults, pass a superset.
 * @returns A new object with the same keys but sensitive values redacted.
 *
 * @example Default denylist
 * ```ts
 * redactHeaders({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
 * // → { Authorization: '[REDACTED]', 'Content-Type': 'application/json' }
 * ```
 *
 * @example Custom denylist
 * ```ts
 * redactHeaders({ 'X-Trace-Id': '123' }, new Set(['x-trace-id']));
 * // → { 'X-Trace-Id': '[REDACTED]' }
 * ```
 */
declare function redactHeaders(headers: Record<string, string>, denylist?: Set<string>): Record<string, string>;
/**
 * Truncates `message` to at most `max` characters, appending `'…'` when the
 * original is longer.
 *
 * The truncation is applied to the Unicode code-unit count (string `.length`),
 * which is consistent with JSON serialization and log-line length limits.
 *
 * @param message - The string to cap.
 * @param max     - Maximum allowed length in code units. Defaults to `512`.
 * @returns The original string when `message.length <= max`, otherwise the
 *   first `max - 1` characters followed by `'…'` (U+2026, HORIZONTAL ELLIPSIS).
 *
 * @example Under the cap
 * ```ts
 * capMessage('hello', 512); // → 'hello'
 * ```
 *
 * @example Over the cap
 * ```ts
 * capMessage('a'.repeat(600), 512); // → 'a'.repeat(511) + '…'
 * ```
 */
declare function capMessage(message: string, max?: number): string;

export { capMessage, redactHeaders, redactSecrets };
