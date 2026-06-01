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

export { Envelope, JsonSerializer, SerializationError };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map