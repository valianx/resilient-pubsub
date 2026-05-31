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
function isRetryable(error) {
  return classify(error) === "transient";
}

exports.applyJitter = applyJitter;
exports.calculateBackoff = calculateBackoff;
exports.classify = classify;
exports.isRetryable = isRetryable;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map