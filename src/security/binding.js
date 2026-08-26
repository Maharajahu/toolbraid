import { timingSafeEqual } from "node:crypto";
import { canonicalHash } from "./canonical.js";
import { SecurityError } from "./errors.js";

export const BINDING_FIELDS = Object.freeze([
  "tenantId",
  "subjectId",
  "workflowId",
  "revision",
  "nodeId",
  "origin",
  "adapter",
  "capabilityId",
  "capabilityVersion",
  "argsHash",
]);

const ID_LIMIT = 256;
const ADAPTER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Normalize and validate every value that an approval is bound to.  In
 * particular, origin and adapter are canonicalized once here and compared in
 * exactly this form on consumption; callers cannot swap either at execution
 * time.
 */
export function normalizeBinding(input, { requireArgs = true } = {}) {
  assertRecord(input, "binding");

  const tenantId = aliasedValue(input, "tenantId", []);
  const subjectId = aliasedValue(input, "subjectId", ["subject", "userId"]);
  const workflowId = aliasedValue(input, "workflowId", ["runId"]);
  const nodeId = aliasedValue(input, "nodeId", []);
  const origin = aliasedValue(input, "origin", ["siteOrigin"]);
  const adapter = aliasedValue(input, "adapter", ["adapterId"]);
  const capabilityId = aliasedValue(input, "capabilityId", ["capability"]);
  const capabilityVersion = aliasedValue(input, "capabilityVersion", ["version"]);
  const normalized = {
    tenantId: normalizeIdentity("tenantId", tenantId),
    subjectId: normalizeIdentity("subjectId", subjectId),
    workflowId: normalizeIdentity("workflowId", workflowId),
    revision: normalizeRevision(input.revision),
    nodeId: normalizeIdentity("nodeId", nodeId),
    origin: normalizeOrigin(origin),
    adapter: normalizeAdapter(adapter),
    capabilityId: normalizeCapabilityToken("capabilityId", capabilityId, CAPABILITY_PATTERN),
    capabilityVersion: normalizeCapabilityToken("capabilityVersion", capabilityVersion, VERSION_PATTERN),
  };

  if (!Object.prototype.hasOwnProperty.call(input, "args")) {
    if (requireArgs) {
      throw new SecurityError("INVALID_BINDING", "Approval binding requires canonical arguments.");
    }
  } else {
    normalized.argsHash = canonicalHash(input.args);
  }

  const suppliedHash = aliasedValue(input, "argsHash", ["argumentHash", "canonicalArgsHash"]);
  if (suppliedHash !== undefined) {
    const supplied = normalizeHash(suppliedHash);
    if (normalized.argsHash !== undefined && !constantTimeStringEqual(normalized.argsHash, supplied)) {
      throw new SecurityError("ARGS_HASH_MISMATCH", "Supplied argument hash does not match canonical arguments.");
    }
    normalized.argsHash = supplied;
  }

  if (!normalized.argsHash) {
    throw new SecurityError("INVALID_BINDING", "Approval binding requires an argument hash.");
  }

  return Object.freeze(normalized);
}

export function normalizeIdentity(name, value) {
  if (typeof value !== "string" || value.length === 0 || value.length > ID_LIMIT) {
    throw new SecurityError("INVALID_BINDING", `${name} must be a non-empty string.`);
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SecurityError("INVALID_BINDING", `${name} contains surrounding whitespace or control characters.`);
  }
  return value;
}

export function normalizeRevision(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SecurityError("INVALID_BINDING", "revision must be a non-negative safe integer.");
    }
    return String(value);
  }
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value) && value.length <= 32) {
    return value;
  }
  throw new SecurityError("INVALID_BINDING", "revision must be a non-negative integer.");
}

export function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || value.trim() !== value) {
    throw new SecurityError("INVALID_ORIGIN", "origin must be an absolute HTTP(S) origin.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SecurityError("INVALID_ORIGIN", "origin must be an absolute HTTP(S) origin.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SecurityError("INVALID_ORIGIN", "Only HTTP(S) origins are permitted.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname) {
    throw new SecurityError("INVALID_ORIGIN", "origin must not include credentials, path, query, or fragment.");
  }
  // URL.origin lowercases the scheme/host and drops default ports.  It also
  // performs IDN/punycode normalization, eliminating host spelling swaps.
  return url.origin;
}

export function normalizeAdapter(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) {
    throw new SecurityError("INVALID_ADAPTER", "adapter must be a non-empty identifier.");
  }
  const adapter = value.toLowerCase();
  if (!ADAPTER_PATTERN.test(adapter)) {
    throw new SecurityError("INVALID_ADAPTER", "adapter contains unsupported characters.");
  }
  return adapter;
}

export function normalizeHash(value) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new SecurityError("INVALID_BINDING", "argsHash must be a lowercase SHA-256 hex digest.");
  }
  return value;
}

function normalizeCapabilityToken(name, value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new SecurityError("INVALID_BINDING", `${name} must be a valid identifier.`);
  }
  return value;
}

export function bindingWithoutArgs(binding) {
  const normalized = normalizeBinding(binding, { requireArgs: false });
  return Object.freeze({
    tenantId: normalized.tenantId,
    subjectId: normalized.subjectId,
    workflowId: normalized.workflowId,
    revision: normalized.revision,
    nodeId: normalized.nodeId,
    origin: normalized.origin,
    adapter: normalized.adapter,
    capabilityId: normalized.capabilityId,
    capabilityVersion: normalized.capabilityVersion,
    argsHash: normalized.argsHash,
  });
}

export function bindingEquals(left, right) {
  try {
    const a = bindingWithoutArgs(left);
    const b = bindingWithoutArgs(right);
    return BINDING_FIELDS.every((field) => {
      if (field === "argsHash") return constantTimeStringEqual(a[field], b[field]);
      return a[field] === b[field];
    });
  } catch {
    return false;
  }
}

export function bindingKey(binding) {
  const normalized = bindingWithoutArgs(binding);
  return canonicalHash(normalized);
}

export function constantTimeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SecurityError("INVALID_BINDING", `${label} must be an object.`);
  }
}

function aliasedValue(input, canonical, aliases) {
  const fields = [canonical, ...aliases].filter((name) => Object.prototype.hasOwnProperty.call(input, name));
  if (fields.length === 0) return undefined;
  const value = input[fields[0]];
  for (const field of fields.slice(1)) {
    if (input[field] !== value) {
      throw new SecurityError("INVALID_BINDING", `${canonical} has conflicting aliases.`);
    }
  }
  return value;
}
