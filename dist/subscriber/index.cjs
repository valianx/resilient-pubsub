'use strict';

// src/envelope/envelope.ts
var Envelope = class _Envelope {
  constructor(body, attributes, meta) {
    this.body = body;
    this.attributes = Object.freeze({ ...attributes });
    this.meta = meta !== void 0 ? Object.freeze({ ...meta }) : void 0;
  }
  /**
   * Creates an outbound envelope (publish side).
   *
   * The resulting envelope has no `meta` field. The serializer will encode
   * only `body` and `attributes` — Pub/Sub populates messageId / publishTime
   * server-side after delivery.
   *
   * @param body - The typed message payload.
   * @param attributes - Pub/Sub message attributes (string-to-string).
   * @returns A new outbound Envelope instance.
   */
  static outbound(body, attributes = {}) {
    return new _Envelope(body, attributes, void 0);
  }
  /**
   * Creates an inbound envelope (consume side) from a deserialized body and
   * the metadata extracted from a received Pub/Sub message.
   *
   * The `meta` field is frozen at construction time to prevent accidental
   * mutation inside handlers.
   *
   * @param body - The deserialized message payload.
   * @param attributes - Pub/Sub message attributes from the received message.
   * @param meta - Runtime metadata extracted from the Pub/Sub message.
   * @returns A new inbound Envelope instance with frozen meta.
   */
  static inbound(body, attributes, meta) {
    return new _Envelope(body, attributes, meta);
  }
  /**
   * Extracts `EnvelopeMeta` from a received Pub/Sub message.
   *
   * This helper converts the raw Pub/Sub message shape into the typed
   * `EnvelopeMeta` interface so callers do not need to handle the conversion
   * themselves.
   *
   * @param message - An inbound Pub/Sub message satisfying InboundPubSubMessage.
   * @returns The extracted EnvelopeMeta.
   */
  static extractMeta(message) {
    const publishTime = resolvePublishTime(message.publishTime);
    return {
      messageId: message.id,
      publishTime,
      orderingKey: message.orderingKey || void 0,
      deliveryAttempt: message.deliveryAttempt
    };
  }
};
function resolvePublishTime(raw) {
  if (raw === void 0 || raw === null) {
    return void 0;
  }
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw.toISOString === "function") {
    return raw.toISOString();
  }
  return void 0;
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
function extractContext(attributes, opts) {
  if (!attributes) return {};
  const allowlist = buildEffectiveAllowlist(opts);
  const result = {};
  for (const [key, value] of Object.entries(attributes)) {
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

// src/subscriber/subscriber.ts
var DEFAULT_STOP_TIMEOUT_MS = 3e4;
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
function createResilientSubscriber(opts) {
  const serializer = opts.serializer ?? new JsonSerializer();
  const sleep = opts._sleep ?? defaultSleep;
  const clientResolver = opts._clientResolver ?? getDefaultPubSubClient;
  const envConfig = resolveConfigFromEnv();
  const stopTimeoutMs = opts.stopTimeoutMs ?? envConfig.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const resolvedFlowControl = {
    maxMessages: opts.flowControl?.maxMessages ?? envConfig.maxMessages,
    maxBytes: opts.flowControl?.maxBytes ?? envConfig.maxBytes
  };
  const hasFlowControl = resolvedFlowControl.maxMessages !== void 0 || resolvedFlowControl.maxBytes !== void 0;
  let handler;
  let nativeSubscription;
  let started = false;
  let stopped = false;
  const inFlight = /* @__PURE__ */ new Set();
  function processMessage(message) {
    const messageId = message.id || void 0;
    const handlerPromise = runHandler(message, messageId);
    const entry = {
      promise: handlerPromise,
      nack: () => message.nack()
    };
    inFlight.add(entry);
    void handlerPromise.finally(() => {
      inFlight.delete(entry);
    });
  }
  async function runHandler(message, messageId) {
    let body;
    try {
      body = serializer.deserialize(message.data);
    } catch (deserializeError) {
      message.nack();
      safeHook(() => opts.hooks?.onPoison?.({ messageId, error: deserializeError }));
      return;
    }
    const headers = extractContext(message.attributes, opts.propagation);
    const meta = Envelope.extractMeta(message);
    try {
      await handler({ body, headers, meta });
      message.ack();
      safeHook(() => opts.hooks?.onAck?.({ messageId }));
    } catch (handlerError) {
      const processError = new ResilientPubSubError(
        `Message handler failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
        { kind: "process", cause: handlerError, classification: "unknown" }
      );
      message.nack();
      safeHook(() => opts.hooks?.onError?.(processError));
      safeHook(() => opts.hooks?.onNack?.({ messageId, error: handlerError }));
    }
  }
  function attachListeners(sub) {
    nativeSubscription = sub;
    sub.on("message", (msg) => {
      processMessage(msg);
    });
    sub.on("error", (err) => {
      const subscribeError = new ResilientPubSubError(
        `Subscription error on '${opts.subscription}': ${err instanceof Error ? err.message : String(err)}`,
        { kind: "subscribe", cause: err }
      );
      safeHook(() => opts.hooks?.onError?.(subscribeError));
    });
  }
  async function asyncBootstrap() {
    if (stopped) return;
    try {
      const client = await clientResolver();
      if (stopped) return;
      const flowOptions = hasFlowControl ? { flowControl: resolvedFlowControl } : void 0;
      const sub = client.subscription(opts.subscription, flowOptions);
      attachListeners(sub);
    } catch (err) {
      const configError = err instanceof ResilientPubSubError ? err : new ResilientPubSubError(
        `Failed to initialize default Pub/Sub client for subscription '${opts.subscription}': ${err instanceof Error ? err.message : String(err)}`,
        { kind: "config", cause: err, classification: "permanent", retryable: false }
      );
      safeHook(() => opts.hooks?.onError?.(configError));
    }
  }
  function drainAll() {
    const pending = [...inFlight].map((e) => e.promise);
    if (pending.length === 0) return Promise.resolve();
    return Promise.all(pending).then(() => void 0);
  }
  function nackAllInFlight() {
    for (const entry of inFlight) {
      safeHook(() => entry.nack());
    }
  }
  return {
    on(newHandler) {
      handler = newHandler;
    },
    start() {
      if (started) return;
      started = true;
      if (opts.pubSubClient !== void 0) {
        const flowOptions = hasFlowControl ? { flowControl: resolvedFlowControl } : void 0;
        const sub = opts.pubSubClient.subscription(opts.subscription, flowOptions);
        attachListeners(sub);
      } else {
        void asyncBootstrap();
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (nativeSubscription !== void 0) {
        nativeSubscription.removeAllListeners("message");
      }
      const result = await Promise.race([
        drainAll().then(() => "drained"),
        sleep(stopTimeoutMs).then(() => "timeout")
      ]);
      if (result === "timeout") {
        nackAllInFlight();
      }
      if (nativeSubscription?.close !== void 0) {
        await nativeSubscription.close();
      }
    },
    get subscription() {
      return nativeSubscription;
    }
  };
}

exports.createResilientSubscriber = createResilientSubscriber;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map