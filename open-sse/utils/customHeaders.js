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
  const allowedEnvNames = new Set(
    String(env.CUSTOM_HEADER_ENV_ALLOWLIST || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const resolved = {};
  for (const [name, template] of Object.entries(normalizeCustomHeaders(headers))) {
    resolved[name] = template.replace(ENV_PATTERN, (_, key) => {
      if (!allowedEnvNames.has(key)) {
        throw new Error("Custom header environment variable is not allowlisted");
      }
      if (env[key] == null) {
        throw new Error("Custom header environment variable is not set");
      }
      if (/\r|\n/.test(env[key])) {
        throw new Error("Custom header environment variable contains invalid characters");
      }
      return env[key];
    });
  }
  return resolved;
}

export function hasCustomHeaderEnvReferences(headers) {
  return Object.values(headers).some((value) => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value));
}

export function mergeNormalizedCustomHeaders(baseHeaders, customHeaders) {
  const result = { ...baseHeaders };
  for (const [name, value] of Object.entries(customHeaders)) {
    for (const existing of Object.keys(result)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
    }
    result[name] = value;
  }
  return result;
}

export function mergeCustomHeaders(baseHeaders, customHeaders) {
  return mergeNormalizedCustomHeaders(baseHeaders, resolveCustomHeaders(customHeaders));
}
