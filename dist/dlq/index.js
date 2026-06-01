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

// src/dlq/dlq.ts
var DELIVERY_ATTEMPT_ATTRIBUTE = "googclient_deliveryattempt";
var DEAD_LETTER_IAM_REQUIREMENTS = "The Pub/Sub service account service-{PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com requires (1) roles/pubsub.publisher on the dead-letter topic and (2) roles/pubsub.subscriber on the source subscription. IAM preflight validation is deferred to v0.2.";
function buildDeadLetterPolicy(opts) {
  validateDeadLetterTopic(opts.deadLetterTopic);
  const maxDeliveryAttempts = opts.maxDeliveryAttempts ?? 5;
  validateMaxDeliveryAttempts(maxDeliveryAttempts);
  return {
    deadLetterTopic: opts.deadLetterTopic,
    maxDeliveryAttempts
  };
}
function getDeliveryAttempt(meta) {
  return meta.deliveryAttempt;
}
function withDeadLetter(subscriptionOptions, dlqOpts) {
  const policy = buildDeadLetterPolicy(dlqOpts);
  return { ...subscriptionOptions, deadLetterPolicy: policy };
}
function validateDeadLetterTopic(topic) {
  if (typeof topic !== "string" || topic.trim().length === 0) {
    throw new ResilientPubSubError(
      'deadLetterTopic must be a non-empty string (e.g. "projects/my-project/topics/my-dlq").',
      { kind: "config", classification: "permanent", retryable: false }
    );
  }
}
function validateMaxDeliveryAttempts(attempts) {
  if (!Number.isInteger(attempts)) {
    throw new ResilientPubSubError(
      `maxDeliveryAttempts must be an integer, received: ${attempts}.`,
      { kind: "config", classification: "permanent", retryable: false }
    );
  }
  if (attempts < 5 || attempts > 100) {
    throw new ResilientPubSubError(
      `maxDeliveryAttempts must be in the range [5, 100] (Pub/Sub limit), received: ${attempts}.`,
      { kind: "config", classification: "permanent", retryable: false }
    );
  }
}

export { DEAD_LETTER_IAM_REQUIREMENTS, DELIVERY_ATTEMPT_ATTRIBUTE, buildDeadLetterPolicy, getDeliveryAttempt, withDeadLetter };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map