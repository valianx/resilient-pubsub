// src/config/env.ts
var ENV_MAX_ATTEMPTS = "RESILIENT_PUBSUB_MAX_ATTEMPTS";
var ENV_BACKOFF_STRATEGY = "RESILIENT_PUBSUB_BACKOFF_STRATEGY";
var ENV_INITIAL_DELAY = "RESILIENT_PUBSUB_INITIAL_DELAY";
var ENV_MAX_DELAY = "RESILIENT_PUBSUB_MAX_DELAY";
var ENV_MULTIPLIER = "RESILIENT_PUBSUB_MULTIPLIER";
var ENV_JITTER = "RESILIENT_PUBSUB_JITTER";
var ENV_STOP_TIMEOUT_MS = "RESILIENT_PUBSUB_STOP_TIMEOUT_MS";
var ENV_MAX_MESSAGES = "RESILIENT_PUBSUB_MAX_MESSAGES";
var ENV_MAX_BYTES = "RESILIENT_PUBSUB_MAX_BYTES";
var VALID_BACKOFF_STRATEGIES = ["exponential", "linear", "constant"];
var VALID_JITTER_STRATEGIES = ["full", "equal", "decorrelated", "none"];
function parsePositiveInt(raw) {
  if (raw === void 0 || raw.trim() === "") return void 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return void 0;
  return n;
}
function parsePositiveNumber(raw) {
  if (raw === void 0 || raw.trim() === "") return void 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return void 0;
  return n;
}
function parseBackoffStrategy(raw) {
  if (raw === void 0) return void 0;
  const trimmed = raw.trim();
  return VALID_BACKOFF_STRATEGIES.includes(trimmed) ? trimmed : void 0;
}
function parseJitterStrategy(raw) {
  if (raw === void 0) return void 0;
  const trimmed = raw.trim();
  return VALID_JITTER_STRATEGIES.includes(trimmed) ? trimmed : void 0;
}
function resolveConfigFromEnv(env = process.env) {
  return {
    maxAttempts: parsePositiveInt(env[ENV_MAX_ATTEMPTS]),
    strategy: parseBackoffStrategy(env[ENV_BACKOFF_STRATEGY]),
    initialDelay: parsePositiveInt(env[ENV_INITIAL_DELAY]),
    maxDelay: parsePositiveInt(env[ENV_MAX_DELAY]),
    multiplier: parsePositiveNumber(env[ENV_MULTIPLIER]),
    jitter: parseJitterStrategy(env[ENV_JITTER]),
    stopTimeoutMs: parsePositiveInt(env[ENV_STOP_TIMEOUT_MS]),
    maxMessages: parsePositiveInt(env[ENV_MAX_MESSAGES]),
    maxBytes: parsePositiveInt(env[ENV_MAX_BYTES])
  };
}

// src/core/classify.ts
var TRANSIENT_GRPC_CODES = /* @__PURE__ */ new Set([4, 8, 10, 13, 14]);
var TRANSIENT_GRPC_NAMES = /* @__PURE__ */ new Set([
  "DEADLINE_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "ABORTED",
  "INTERNAL",
  "UNAVAILABLE"
]);
var PERMANENT_GRPC_CODES = /* @__PURE__ */ new Set([3, 5, 6, 7, 9, 11, 12, 16]);
var PERMANENT_GRPC_NAMES = /* @__PURE__ */ new Set([
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "FAILED_PRECONDITION",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "UNAUTHENTICATED"
]);
var TRANSIENT_NODE_CODES = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE"
]);
var MAX_CAUSE_DEPTH = 5;
function classifySingle(err) {
  if (err === null || typeof err !== "object") return null;
  const obj = err;
  if (obj["kind"] === "serialization" || obj["classification"] === "poison") {
    return "poison";
  }
  const code = obj["code"];
  if (typeof code === "number") {
    if (TRANSIENT_GRPC_CODES.has(code)) return "transient";
    if (PERMANENT_GRPC_CODES.has(code)) return "permanent";
    return null;
  }
  if (typeof code === "string") {
    const upper = code.toUpperCase();
    if (TRANSIENT_GRPC_NAMES.has(upper) || TRANSIENT_NODE_CODES.has(upper)) {
      return "transient";
    }
    if (PERMANENT_GRPC_NAMES.has(upper)) return "permanent";
    return null;
  }
  const message = typeof obj["message"] === "string" ? obj["message"] : "";
  for (const nodeCode of TRANSIENT_NODE_CODES) {
    if (message.includes(nodeCode)) return "transient";
  }
  return null;
}
function classify(error) {
  const visited = /* @__PURE__ */ new Set();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || current === void 0) break;
    if (visited.has(current)) break;
    visited.add(current);
    const result = classifySingle(current);
    if (result !== null) return result;
    if (typeof current === "object") {
      current = current["cause"];
    } else {
      break;
    }
  }
  return "unknown";
}

// src/utils/redact.ts
var REDACTED = "[REDACTED]";
var REDIS_URL_PATTERN = /rediss?:\/\/([^@\s]+@)/gi;
var GCP_KEYFILE_PATTERN = /(?:keyFile(?:name)?|credentialsFile|serviceAccountKey)\s*[:=]\s*["']?[^\s"',;)]+["']?/gi;
var PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]+KEY-----[\s\S]*?-----END [A-Z ]+KEY-----/g;
var PRIVATE_KEY_FIELD_PATTERN = /"private_key"\s*:\s*"[^"]+"/g;
var MAX_REDACT_INPUT = 8192;
function redactSecrets(text) {
  let result = text.length > MAX_REDACT_INPUT ? text.slice(0, MAX_REDACT_INPUT) : text;
  result = result.replace(REDIS_URL_PATTERN, (match, userinfo) => {
    try {
      const urlStr = match;
      const withoutUserinfo = match.replace(userinfo, `${REDACTED}@`);
      const scheme = urlStr.startsWith("rediss") ? "rediss://" : "redis://";
      const hostPart = withoutUserinfo.slice(scheme.length).replace(`${REDACTED}@`, "");
      void new URL(`redis://${hostPart}`);
      return withoutUserinfo;
    } catch {
      return `${match.startsWith("rediss") ? "rediss" : "redis"}://${REDACTED}`;
    }
  });
  result = result.replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTED);
  result = result.replace(PRIVATE_KEY_FIELD_PATTERN, `"private_key":"${REDACTED}"`);
  result = result.replace(GCP_KEYFILE_PATTERN, (match) => {
    const eqIdx = match.search(/[:=]/);
    if (eqIdx === -1) return REDACTED;
    return `${match.slice(0, eqIdx + 1)} ${REDACTED}`;
  });
  return result;
}
function capMessage(message, max = 512) {
  if (message.length <= max) return message;
  return `${message.slice(0, max - 1)}\u2026`;
}

// src/errors/error.ts
var BRAND = /* @__PURE__ */ Symbol.for("resilient-pubsub.error");
var _a, _b;
var ResilientPubSubError = class extends (_b = Error, _a = BRAND, _b) {
  constructor(message, options) {
    super(message, options.cause !== void 0 ? { cause: options.cause } : void 0);
    /** Brand property enabling cross-realm instanceof checks. @internal */
    this[_a] = true;
    this.name = "ResilientPubSubError";
    this.kind = options.kind;
    const derived = options.classification ?? classify(options.cause);
    this.classification = derived;
    this.retryable = options.retryable ?? derived === "transient";
    this.grpcCode = extractGrpcCode(options.cause);
  }
  /**
   * Returns a plain, log-safe JSON representation of this error.
   *
   * **Included fields:** `name`, `kind`, `classification`, `retryable`,
   * `message` (length-capped + secrets redacted), `grpcCode` (when present).
   *
   * **Excluded fields:** `cause`, `body`, `meta`, raw attributes / headers,
   * stack trace. This exclusion is intentional — those fields may contain
   * secrets, PII, or raw payload bytes.
   *
   * @returns A plain object safe for `JSON.stringify`.
   *
   * @example
   * ```ts
   * JSON.stringify(err);
   * // {
   * //   "name": "ResilientPubSubError",
   * //   "kind": "publish",
   * //   "classification": "transient",
   * //   "retryable": true,
   * //   "message": "Publish failed: UNAVAILABLE",
   * //   "grpcCode": 14
   * // }
   * ```
   */
  toJSON() {
    const safe = redactSecrets(capMessage(this.message));
    const base = {
      name: this.name,
      kind: this.kind,
      classification: this.classification,
      retryable: this.retryable,
      message: safe
    };
    if (this.grpcCode !== void 0) {
      base["grpcCode"] = this.grpcCode;
    }
    return base;
  }
};
function extractGrpcCode(err) {
  if (err === null || typeof err !== "object") return void 0;
  const obj = err;
  if (typeof obj["code"] === "number") return obj["code"];
  const cause = obj["cause"];
  if (cause !== null && typeof cause === "object") {
    const causeCode = cause["code"];
    if (typeof causeCode === "number") return causeCode;
  }
  return void 0;
}

// src/config/client.ts
var cachedClient;
async function getDefaultPubSubClient() {
  if (cachedClient !== void 0) {
    return cachedClient;
  }
  let PubSubConstructor;
  try {
    const module = await import('@google-cloud/pubsub');
    PubSubConstructor = module.PubSub;
  } catch {
    throw new ResilientPubSubError(
      `Could not import '@google-cloud/pubsub'. Install the peer dependency ('pnpm add @google-cloud/pubsub') or pass a 'pubSubClient' explicitly to createResilientPublisher / createResilientSubscriber.`,
      { kind: "config", classification: "permanent", retryable: false }
    );
  }
  cachedClient = new PubSubConstructor();
  return cachedClient;
}
function _resetDefaultClientCache() {
  cachedClient = void 0;
}

export { ENV_BACKOFF_STRATEGY, ENV_INITIAL_DELAY, ENV_JITTER, ENV_MAX_ATTEMPTS, ENV_MAX_BYTES, ENV_MAX_DELAY, ENV_MAX_MESSAGES, ENV_MULTIPLIER, ENV_STOP_TIMEOUT_MS, _resetDefaultClientCache, getDefaultPubSubClient, resolveConfigFromEnv };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map