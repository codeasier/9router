const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Headers that must remain controlled by the router or the underlying HTTP client.
const RESERVED_HEADERS = new Set([
  "authorization", "x-api-key", "content-type", "accept", "host",
  "content-length", "connection", "transfer-encoding", "te", "trailer",
  "upgrade", "proxy-authorization", "proxy-authenticate",
]);

export function normalizeCustomHeaders(headers) {
  if (headers == null || headers === "") return {};
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("Custom headers must be an object");
  }

  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`Invalid custom header name: ${name}`);
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new Error(`Invalid custom header value: ${name}`);
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    normalized[name] = value;
  }
  return normalized;
}

export function resolveCustomHeaders(headers, env = process.env) {
  const resolved = {};
  for (const [name, template] of Object.entries(normalizeCustomHeaders(headers))) {
    resolved[name] = template.replace(ENV_PATTERN, (_, key) => env[key] ?? "");
  }
  return resolved;
}

export function mergeCustomHeaders(baseHeaders, customHeaders) {
  const result = { ...baseHeaders };
  for (const [name, value] of Object.entries(resolveCustomHeaders(customHeaders))) {
    for (const existing of Object.keys(result)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
    }
    result[name] = value;
  }
  return result;
}
