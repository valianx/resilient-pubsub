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

// ============================================================================
// Constants
// ============================================================================

/** Replacement marker for redacted values. */
const REDACTED = '[REDACTED]';

/**
 * Default set of HTTP header names whose values must always be redacted.
 * Keys are stored in lower-case; matching is case-insensitive at runtime.
 *
 * @internal
 */
const DEFAULT_HEADER_DENYLIST = new Set<string>([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'proxy-authorization',
]);

/**
 * Regex that matches any header key containing a sensitive word.
 * Applied in addition to the exact-match denylist.
 *
 * @internal
 */
const SENSITIVE_HEADER_PATTERN = /secret|token|password|credential/i;

/**
 * Regex that matches Redis / Rediss connection URLs that embed credentials.
 *
 * Group 1 (optional): userinfo component — everything between `://` and `@`.
 * The password is the part after `:` in userinfo, but we redact the entire
 * userinfo block because the username alone may also constitute PII.
 *
 * Pattern: `redis[s]://[userinfo@]host[...]`
 *
 * Examples matched:
 * - `redis://alice:s3cr3t@cache.internal:6379`
 * - `rediss://user:pass@10.0.0.1/0`
 * - `redis://:password@host` (no username)
 *
 * @internal
 */
const REDIS_URL_PATTERN = /rediss?:\/\/([^@\s]+@)/gi;

/**
 * Regex that matches GCP service-account JSON file path fragments that are
 * commonly logged when a keyfile is passed as a connection option.
 *
 * Conservative match: any path segment ending in `.json` that immediately
 * follows common credential key names.
 *
 * @internal
 */
const GCP_KEYFILE_PATTERN =
  /(?:keyFile(?:name)?|credentialsFile|serviceAccountKey)\s*[:=]\s*["']?[^\s"',;)]+["']?/gi;

/**
 * Regex that matches PEM private-key blocks (GCP service-account keys and
 * similar certificates that may appear in logged configuration strings).
 *
 * Matches from `-----BEGIN PRIVATE KEY-----` through the closing delimiter.
 *
 * @internal
 */
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]+KEY-----[\s\S]*?-----END [A-Z ]+KEY-----/g;

/**
 * Regex that matches bare `private_key` field assignments that appear in
 * logged JSON snippets of GCP service-account credential objects.
 *
 * @internal
 */
const PRIVATE_KEY_FIELD_PATTERN = /"private_key"\s*:\s*"[^"]+"/g;

// ============================================================================
// Public API
// ============================================================================

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
/** Maximum input length accepted by redactSecrets before applying regex rules.
 * Defensive cap so any direct caller also gets bounded regex execution.
 * @internal */
const MAX_REDACT_INPUT = 8192;

export function redactSecrets(text: string): string {
  // fix(security-m1): defensive input cap — guards against ReDoS from any
  // call site, not just toJSON(). PRIVATE_KEY_BLOCK_PATTERN is O(N²) on
  // unterminated BEGIN blocks; keeping the input ≤ 8 KB bounds the regex cost.
  let result = text.length > MAX_REDACT_INPUT ? text.slice(0, MAX_REDACT_INPUT) : text;

  // Rule 1 — Redis/Rediss URLs: redact userinfo (user:pass@) segment.
  result = result.replace(REDIS_URL_PATTERN, (match, userinfo: string) => {
    // Attempt URL-parse to ensure we are replacing only the credential part.
    // The URL constructor requires a valid base; wrap with a dummy scheme if needed.
    try {
      const urlStr = match;
      // Rebuild without the userinfo block.
      const withoutUserinfo = match.replace(userinfo, `${REDACTED}@`);
      // Validate that the remainder still looks like a URL (parse must not throw).
      const scheme = urlStr.startsWith('rediss') ? 'rediss://' : 'redis://';
      const hostPart = withoutUserinfo.slice(scheme.length).replace(`${REDACTED}@`, '');
      void new URL(`redis://${hostPart}`);
      return withoutUserinfo;
    } catch {
      // Fail-safe: if anything in URL parsing throws, redact the entire match.
      return `${match.startsWith('rediss') ? 'rediss' : 'redis'}://${REDACTED}`;
    }
  });

  // Rule 2 — PEM private-key blocks.
  result = result.replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTED);

  // Rule 3 — JSON `private_key` field values.
  result = result.replace(PRIVATE_KEY_FIELD_PATTERN, `"private_key":"${REDACTED}"`);

  // Rule 4 — GCP keyfile path assignments.
  result = result.replace(GCP_KEYFILE_PATTERN, (match) => {
    // Preserve the key name, redact only the value portion.
    const eqIdx = match.search(/[:=]/);
    if (eqIdx === -1) return REDACTED;
    return `${match.slice(0, eqIdx + 1)} ${REDACTED}`;
  });

  return result;
}

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
export function redactHeaders(
  headers: Record<string, string>,
  denylist: Set<string> = DEFAULT_HEADER_DENYLIST
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    const isSensitive = denylist.has(lower) || SENSITIVE_HEADER_PATTERN.test(lower);
    result[key] = isSensitive ? REDACTED : value;
  }

  return result;
}

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
export function capMessage(message: string, max = 512): string {
  if (message.length <= max) return message;
  return `${message.slice(0, max - 1)}…`;
}
