'use strict';

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

exports.W3C_TRACE_HEADERS = W3C_TRACE_HEADERS;
exports.extractContext = extractContext;
exports.injectContext = injectContext;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map