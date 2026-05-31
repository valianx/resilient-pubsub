'use strict';

// src/core/backoff.ts
var DEFAULT_STRATEGY = "exponential";
var DEFAULT_INITIAL_DELAY = 1e3;
var DEFAULT_MAX_DELAY = 3e4;
var DEFAULT_MULTIPLIER = 2;
function clamp(value, max) {
  if (!isFinite(value) || isNaN(value) || value < 0) return 0;
  return Math.min(value, max);
}
function exponentialBackoff(attempt, opts) {
  const raw = opts.initialDelay * Math.pow(opts.multiplier, attempt - 1);
  return clamp(raw, opts.maxDelay);
}
function linearBackoff(attempt, opts) {
  const raw = opts.initialDelay * attempt;
  return clamp(raw, opts.maxDelay);
}
function constantBackoff(_attempt, opts) {
  return clamp(opts.initialDelay, opts.maxDelay);
}
function calculateBackoff(attempt, opts = {}) {
  const resolved = {
    strategy: opts.strategy ?? DEFAULT_STRATEGY,
    initialDelay: opts.initialDelay ?? DEFAULT_INITIAL_DELAY,
    maxDelay: opts.maxDelay ?? DEFAULT_MAX_DELAY,
    multiplier: opts.multiplier ?? DEFAULT_MULTIPLIER
  };
  switch (resolved.strategy) {
    case "exponential":
      return exponentialBackoff(attempt, resolved);
    case "linear":
      return linearBackoff(attempt, resolved);
    case "constant":
      return constantBackoff(attempt, resolved);
    default: {
      return exponentialBackoff(attempt, resolved);
    }
  }
}

// src/core/jitter.ts
var DEFAULT_INITIAL_DELAY2 = 1e3;
var DEFAULT_MAX_DELAY2 = 3e4;
function randomBetween(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomFloatBetween(min, max) {
  if (max <= min) return min;
  return Math.random() * (max - min) + min;
}
function clampPositive(value) {
  return isFinite(value) && value > 0 ? value : 0;
}
function fullJitter(baseDelay) {
  return randomBetween(0, Math.floor(baseDelay));
}
function equalJitter(baseDelay) {
  const half = Math.floor(baseDelay / 2);
  return half + randomBetween(0, half);
}
function decorrelatedJitter(previousDelay, initialDelay, maxDelay) {
  const lower = initialDelay;
  const upper = previousDelay * 3;
  const raw = randomFloatBetween(lower, upper);
  return Math.min(Math.floor(raw), maxDelay);
}
function applyJitter(baseDelay, strategy = "full", opts = {}) {
  const {
    previousDelay = baseDelay,
    initialDelay = DEFAULT_INITIAL_DELAY2,
    maxDelay = DEFAULT_MAX_DELAY2
  } = opts;
  let result;
  switch (strategy) {
    case "full":
      result = fullJitter(baseDelay);
      break;
    case "equal":
      result = equalJitter(baseDelay);
      break;
    case "decorrelated":
      result = decorrelatedJitter(previousDelay, initialDelay, maxDelay);
      break;
    case "none":
      result = baseDelay;
      break;
    default: {
      result = fullJitter(baseDelay);
    }
  }
  const clamped = Math.min(clampPositive(result), maxDelay);
  return clamped;
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
function redactSecrets(text) {
  let result = text;
  result = result.replace(REDIS_URL_PATTERN, (match, userinfo) => {
    try {
      const urlStr = match.endsWith(userinfo) ? match : match;
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
    const safe = capMessage(redactSecrets(this.message));
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
var SerializationError = class extends ResilientPubSubError {
  /**
   * @param message - Human-readable description of the failure. MUST NOT
   *   include raw payload bytes (security / log safety).
   * @param cause   - The underlying parse error, if any.
   */
  constructor(message, cause) {
    super(message, {
      kind: "serialization",
      cause,
      classification: "poison",
      retryable: false
    });
    /** Always `'serialization'`. Retained as a typed `const` for catch-handler discriminant use. */
    this.kind = "serialization";
    /** Always `'poison'`. */
    this.classification = "poison";
    /** Always `false`. */
    this.retryable = false;
    this.name = "SerializationError";
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

// src/envelope/serializer.ts
var JsonSerializer = class {
  constructor() {
    /** Always 'application/json'. */
    this.contentType = "application/json";
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }
  /**
   * Serializes a typed body to UTF-8 JSON bytes.
   *
   * @param body - The message payload to encode.
   * @returns UTF-8 encoded JSON bytes as a Uint8Array.
   * @throws {TypeError} If `body` contains non-JSON-serializable values.
   */
  serialize(body) {
    return this.encoder.encode(JSON.stringify(body));
  }
  /**
   * Deserializes UTF-8 JSON bytes back into a typed body.
   *
   * @param data - Raw bytes from the Pub/Sub message.
   * @returns The parsed message payload.
   * @throws {SerializationError} If the bytes are not valid UTF-8 JSON.
   *   The error message does not include the raw payload bytes.
   */
  deserialize(data) {
    let text;
    try {
      text = this.decoder.decode(data);
    } catch (cause) {
      throw new SerializationError(
        "Failed to decode message payload as UTF-8: bytes are malformed",
        cause
      );
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new SerializationError(
        "Failed to parse message payload as JSON: invalid JSON structure",
        cause
      );
    }
  }
};

// src/propagation/propagation.ts
var W3C_TRACE_HEADERS = ["traceparent", "tracestate"];
var BAGGAGE_HEADER = "baggage";
function buildEffectiveAllowlist(opts) {
  const effective = new Set(W3C_TRACE_HEADERS);
  if (opts?.baggage === true) {
    effective.add(BAGGAGE_HEADER);
  }
  if (opts?.allowlist) {
    for (const key of opts.allowlist) {
      effective.add(key.toLowerCase());
    }
  }
  return effective;
}
function isValidAttributeValue(value) {
  return typeof value === "string" && value.length > 0;
}
function injectContext(headers, opts) {
  if (!headers) return {};
  const allowlist = buildEffectiveAllowlist(opts);
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isValidAttributeValue(value)) continue;
    const lower = key.toLowerCase();
    if (allowlist.has(lower)) {
      result[lower] = value;
    }
  }
  return result;
}

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

// src/publisher/publisher.ts
var DEFAULT_MAX_ATTEMPTS = 3;
var DEFAULT_STRATEGY2 = "exponential";
var DEFAULT_INITIAL_DELAY3 = 1e3;
var DEFAULT_MAX_DELAY3 = 3e4;
var DEFAULT_MULTIPLIER2 = 2;
var DEFAULT_JITTER = "full";
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function safeHook(fn) {
  if (fn === void 0) return;
  try {
    fn();
  } catch {
  }
}
function buildAttributes(input, contentType, schemaVersion, propagationOpts) {
  const propagated = injectContext(input.headers, propagationOpts);
  const callerAttrs = input.attributes ?? {};
  const envelopeAttrs = { "content-type": contentType };
  if (schemaVersion !== void 0) {
    envelopeAttrs["schema-version"] = schemaVersion;
  }
  return { ...propagated, ...callerAttrs, ...envelopeAttrs };
}
function createResilientPublisher(opts) {
  const serializer = opts.serializer ?? new JsonSerializer();
  const sleep = opts._sleep ?? defaultSleep;
  const clientResolver = opts._clientResolver ?? getDefaultPubSubClient;
  const envConfig = resolveConfigFromEnv();
  const retryOpts = opts.retry ?? {};
  const maxAttempts = retryOpts.maxAttempts ?? envConfig.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const strategy = retryOpts.strategy ?? envConfig.strategy ?? DEFAULT_STRATEGY2;
  const initialDelay = retryOpts.initialDelay ?? envConfig.initialDelay ?? DEFAULT_INITIAL_DELAY3;
  const maxDelay = retryOpts.maxDelay ?? envConfig.maxDelay ?? DEFAULT_MAX_DELAY3;
  const multiplier = retryOpts.multiplier ?? envConfig.multiplier ?? DEFAULT_MULTIPLIER2;
  const jitter = retryOpts.jitter ?? envConfig.jitter ?? DEFAULT_JITTER;
  let nativeTopic;
  if (opts.pubSubClient !== void 0) {
    const topicOpts = {};
    if (opts.ordering === true) {
      topicOpts["enableMessageOrdering"] = true;
    }
    nativeTopic = opts.pubSubClient.topic(opts.topic, topicOpts);
  }
  async function resolveNativeTopic() {
    if (nativeTopic !== void 0) return nativeTopic;
    const client = await clientResolver();
    const topicOpts = {};
    if (opts.ordering === true) {
      topicOpts["enableMessageOrdering"] = true;
    }
    nativeTopic = client.topic(opts.topic, topicOpts);
    return nativeTopic;
  }
  async function publish(input) {
    const topic = await resolveNativeTopic();
    const data = Buffer.from(serializer.serialize(input.body));
    const attributes = buildAttributes(
      input,
      serializer.contentType,
      opts.schemaVersion,
      opts.propagation
    );
    let lastError;
    let previousDelay = initialDelay;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const messageId = await topic.publishMessage({
          data,
          attributes,
          orderingKey: input.orderingKey
        });
        safeHook(() => opts.hooks?.onPublish?.({ messageId }));
        return { messageId };
      } catch (err) {
        lastError = err;
        const classification = classify(err);
        if (classification !== "transient") {
          if (opts.ordering === true && input.orderingKey !== void 0) {
            topic.resumePublishing(input.orderingKey);
          }
          throw new ResilientPubSubError(
            `Publish failed (${classification}) on attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
            { kind: "publish", cause: err, classification }
          );
        }
        if (attempt === maxAttempts) break;
        if (opts.ordering === true && input.orderingKey !== void 0) {
          topic.resumePublishing(input.orderingKey);
        }
        const base = calculateBackoff(attempt, { strategy, initialDelay, maxDelay, multiplier });
        const delay = applyJitter(base, jitter, { previousDelay, initialDelay, maxDelay });
        previousDelay = delay;
        safeHook(() => opts.hooks?.onRetry?.({ attempt, delay, error: err }));
        await sleep(delay);
      }
    }
    throw new ResilientPubSubError(
      `Publish failed after ${maxAttempts} attempts (topic: '${opts.topic}')`,
      { kind: "publish", cause: lastError, classification: "transient" }
    );
  }
  return {
    publish,
    get topic() {
      return nativeTopic;
    }
  };
}

exports.createResilientPublisher = createResilientPublisher;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map