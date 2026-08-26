import { randomBytes as nodeRandomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AuditLog } from "./audit.js";
import {
  BINDING_FIELDS,
  constantTimeStringEqual,
  normalizeBinding,
} from "./binding.js";
import { SecurityError } from "./errors.js";

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_TTL_MS = 5 * 60 * 1000;
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/u;

/**
 * Server-side, single-use approval authority.
 *
 * There is intentionally no public `grant()` method on the authority.  The
 * composition root obtains a private issuer capability via createIssuer() and
 * keeps that capability away from MCP tool arguments/dispatch.  Consumers can
 * only verify or consume an approval reference (id + nonce) against a freshly
 * normalized execution binding.
 */
export class ApprovalAuthority {
  #records = new Map();
  #clock;
  #nonceFactory;
  #idFactory;
  #maxTtlMs;
  #defaultTtlMs;
  #audit;
  #issuerSecret = Object.freeze({});

  constructor({
    clock = () => Date.now(),
    nonceFactory,
    idFactory = () => randomUUID(),
    defaultTtlMs = DEFAULT_TTL_MS,
    maxTtlMs = DEFAULT_MAX_TTL_MS,
    audit,
  } = {}) {
    if (typeof clock !== "function") throw new SecurityError("INVALID_APPROVAL_OPTIONS", "clock must be a function.");
    if (nonceFactory !== undefined && typeof nonceFactory !== "function") {
      throw new SecurityError("INVALID_APPROVAL_OPTIONS", "nonceFactory must be a function.");
    }
    if (typeof idFactory !== "function") throw new SecurityError("INVALID_APPROVAL_OPTIONS", "idFactory must be a function.");
    validateTtl(defaultTtlMs, "defaultTtlMs");
    validateTtl(maxTtlMs, "maxTtlMs");
    if (defaultTtlMs > maxTtlMs) {
      throw new SecurityError("INVALID_APPROVAL_OPTIONS", "defaultTtlMs cannot exceed maxTtlMs.");
    }
    if (audit !== undefined && !(audit instanceof AuditLog) && typeof audit.append !== "function") {
      throw new SecurityError("INVALID_APPROVAL_OPTIONS", "audit must expose append().");
    }
    this.#clock = clock;
    this.#nonceFactory = nonceFactory ?? (() => nodeRandomBytes(32).toString("base64url"));
    this.#idFactory = idFactory;
    this.#defaultTtlMs = defaultTtlMs;
    this.#maxTtlMs = maxTtlMs;
    this.#audit = audit;
  }

  /**
   * Return a narrow capability object used only by trusted server code.
   * Calling this method is not enough to mint an approval unless the returned
   * capability itself is kept out of public request handling.
   */
  createIssuer(label = "server") {
    const authority = this;
    if (typeof label !== "string" || label.length === 0 || label.length > 128 || label.trim() !== label) {
      throw new SecurityError("INVALID_APPROVAL_ISSUER", "issuer label is invalid.");
    }
    return Object.freeze({
      issue(binding, options = {}) {
        return authority.#issue(authority.#issuerSecret, label, binding, options);
      },
      grant(binding, options = {}) {
        return authority.#issue(authority.#issuerSecret, label, binding, options);
      },
      issueApproval(binding, options = {}) {
        return authority.#issue(authority.#issuerSecret, label, binding, options);
      },
    });
  }

  /**
   * Inspect only non-secret status for diagnostics.  The nonce and arguments
   * are never returned from this method.
   */
  status(approvalId) {
    if (typeof approvalId !== "string") return { found: false };
    const record = this.#records.get(approvalId);
    if (!record) return { found: false };
    return {
      found: true,
      approvalId: record.approvalId,
      tenantId: record.tenantId,
      subjectId: record.subjectId,
      workflowId: record.workflowId,
      revision: record.revision,
      nodeId: record.nodeId,
      origin: record.origin,
      adapter: record.adapter,
      capabilityId: record.capabilityId,
      capabilityVersion: record.capabilityVersion,
      argsHash: record.argsHash,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      usedAt: record.usedAt,
    };
  }

  get size() {
    return this.#records.size;
  }

  /** Validate a credential without consuming its single-use nonce. */
  verify(bindingOrInput, credential, { now } = {}) {
    const split = splitCheckInput(bindingOrInput, credential);
    return this.#check(split.binding, split.credential, false, now);
  }

  /**
   * Atomically validate and consume a credential.  JavaScript's synchronous
   * execution means no caller can interleave between the checks and usedAt
   * update; a durable implementation must use an equivalent compare-and-swap
   * transaction on its backing store.
   */
  consume(bindingOrInput, credential, { now } = {}) {
    const split = splitCheckInput(bindingOrInput, credential);
    return this.#check(split.binding, split.credential, true, now);
  }

  /** One-object spelling used by stores plugged into execution brokers. */
  verifyAndConsume(input) {
    return this.consume(input);
  }

  #issue(secret, issuerLabel, bindingInput, options) {
    if (secret !== this.#issuerSecret) {
      throw new SecurityError("ISSUER_CAPABILITY_REQUIRED", "Only trusted server code may issue approvals.");
    }
    const binding = normalizeBinding(bindingInput, { requireArgs: true });
    const issuedAt = currentTime(this.#clock());
    const expiresAt = resolveExpiry(options, issuedAt, this.#defaultTtlMs, this.#maxTtlMs);
    const approvalId = this.#newApprovalId();
    const nonce = this.#newNonce();
    if (this.#records.has(approvalId)) {
      throw new SecurityError("APPROVAL_ID_COLLISION", "Approval identifier collision.", { retryable: true });
    }

    const record = Object.freeze({
      approvalId,
      nonce,
      ...withoutArgs(binding),
      issuedAt,
      expiresAt,
      usedAt: null,
      issuer: issuerLabel,
    });
    this.#records.set(approvalId, record);
    this.#appendAudit("approval.issued", {
      approvalId,
      issuer: issuerLabel,
      ...withoutArgs(binding),
      nonce,
      issuedAt,
      expiresAt,
    });
    return Object.freeze({ approvalId, nonce, expiresAt });
  }

  #check(bindingInput, credential, consume, nowOverride) {
    let binding;
    try {
      binding = normalizeBinding(bindingInput, { requireArgs: true });
    } catch {
      return failure("INVALID_BINDING", "Execution binding is invalid.");
    }

    const reference = parseCredential(credential);
    if (!reference) {
      return failure("APPROVAL_REQUIRED", "A trusted approval is required for this operation.");
    }

    const record = this.#records.get(reference.approvalId);
    if (!record) {
      return this.#reject("APPROVAL_INVALID", "Approval reference is unknown.", binding, reference, consume);
    }
    if (!safeNonceEqual(record.nonce, reference.nonce)) {
      return this.#reject("APPROVAL_INVALID", "Approval reference is invalid.", binding, reference, consume);
    }

    const now = nowOverride === undefined ? currentTime(this.#clock()) : currentTime(nowOverride);
    if (now >= record.expiresAt) {
      return this.#reject("APPROVAL_EXPIRED", "Approval has expired.", binding, reference, consume);
    }
    if (record.usedAt !== null) {
      return this.#reject("APPROVAL_REPLAY", "Approval has already been consumed.", binding, reference, consume);
    }
    if (!bindingEqualsRecord(binding, record)) {
      return this.#reject("APPROVAL_BINDING_MISMATCH", "Approval does not match this execution binding.", binding, reference, consume);
    }

    if (!consume) {
      return {
        ok: true,
        valid: true,
        approved: true,
        approvalId: record.approvalId,
        expiresAt: record.expiresAt,
      };
    }

    // Replace rather than mutate a frozen record.  Since this method contains
    // no await, the replacement is a single-use state transition.
    const usedAt = now;
    this.#records.set(record.approvalId, Object.freeze({ ...record, usedAt }));
    this.#appendAudit("approval.consumed", {
      approvalId: record.approvalId,
      ...withoutArgs(record),
      usedAt,
    });
    return {
      ok: true,
      valid: true,
      approved: true,
      consumed: true,
      approvalId: record.approvalId,
      expiresAt: record.expiresAt,
    };
  }

  #reject(code, message, binding, reference, consume) {
    this.#appendAudit("approval.rejected", {
      approvalId: reference.approvalId,
      ...withoutArgs(binding),
      code,
      consume,
    });
    return failure(code, message);
  }

  #appendAudit(type, details) {
    if (!this.#audit) return;
    try {
      this.#audit.append(type, details);
    } catch {
      // A failure in telemetry cannot turn a valid authorization into a
      // bypass or mutate approval state.  The in-memory authority remains the
      // source of truth.
    }
  }

  #newApprovalId() {
    const value = this.#idFactory();
    if (typeof value !== "string" || !APPROVAL_ID_PATTERN.test(value)) {
      throw new SecurityError("INVALID_APPROVAL_ID", "Approval identifier factory returned an invalid value.");
    }
    return value;
  }

  #newNonce() {
    const value = this.#nonceFactory();
    if (typeof value !== "string" || !NONCE_PATTERN.test(value)) {
      throw new SecurityError("INVALID_APPROVAL_NONCE", "Approval nonce factory returned an invalid value.");
    }
    return value;
  }
}

export const ApprovalStore = ApprovalAuthority;

function resolveExpiry(options, issuedAt, defaultTtlMs, maxTtlMs) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new SecurityError("INVALID_APPROVAL_OPTIONS", "Approval options must be an object.");
  }
  const hasExpiry = Object.prototype.hasOwnProperty.call(options, "expiresAt");
  const hasTtl = Object.prototype.hasOwnProperty.call(options, "ttlMs");
  if (hasExpiry && hasTtl) {
    throw new SecurityError("INVALID_APPROVAL_OPTIONS", "Specify either expiresAt or ttlMs, not both.");
  }
  let expiresAt;
  if (hasExpiry) {
    expiresAt = options.expiresAt;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
      throw new SecurityError("INVALID_APPROVAL_EXPIRY", "expiresAt must be a future safe-integer timestamp.");
    }
    if (expiresAt - issuedAt > maxTtlMs) {
      throw new SecurityError("INVALID_APPROVAL_EXPIRY", "Approval expiry exceeds the maximum lifetime.");
    }
  } else {
    const ttlMs = options.ttlMs ?? defaultTtlMs;
    validateTtl(ttlMs, "ttlMs");
    if (ttlMs > maxTtlMs) {
      throw new SecurityError("INVALID_APPROVAL_EXPIRY", "Approval lifetime exceeds the maximum lifetime.");
    }
    expiresAt = issuedAt + ttlMs;
  }
  return expiresAt;
}

function validateTtl(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SecurityError("INVALID_APPROVAL_OPTIONS", `${label} must be a positive safe integer.`);
  }
}

function currentTime(value) {
  const now = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new SecurityError("INVALID_APPROVAL_OPTIONS", "clock must return a non-negative safe-integer timestamp.");
  }
  return now;
}

function parseCredential(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const approvalId = value.approvalId;
  const nonce = value.nonce ?? value.approvalNonce;
  if (typeof approvalId !== "string" || !APPROVAL_ID_PATTERN.test(approvalId)) return null;
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) return null;
  return { approvalId, nonce };
}

function safeNonceEqual(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function bindingEqualsRecord(binding, record) {
  return BINDING_FIELDS.every((field) => {
    if (field === "argsHash") return constantTimeStringEqual(binding[field], record[field]);
    return binding[field] === record[field];
  });
}

function withoutArgs(binding) {
  const result = {};
  for (const field of BINDING_FIELDS) result[field] = binding[field];
  return result;
}

function failure(code, message) {
  return { ok: false, valid: false, approved: false, consumed: false, code, message };
}

function splitCheckInput(bindingOrInput, credential) {
  if (credential !== undefined) return { binding: bindingOrInput, credential };
  if (bindingOrInput === null || typeof bindingOrInput !== "object" || Array.isArray(bindingOrInput)) {
    return { binding: bindingOrInput, credential: undefined };
  }
  const input = bindingOrInput;
  const nestedBinding = input.binding;
  if (nestedBinding !== undefined) {
    // A one-object envelope is either `{ binding, approval }` or an inline
    // binding.  Never let an attacker put an approved binding under `binding`
    // while leaving different origin/adapter/args fields at the top level for
    // the caller to execute.  Treat the mixed shape as invalid instead of
    // guessing which copy is authoritative.
    const hasInlineBinding = [
      "tenantId",
      "subjectId",
      "subject",
      "userId",
      "workflowId",
      "runId",
      "revision",
      "nodeId",
      "origin",
      "siteOrigin",
      "adapter",
      "adapterId",
      "capabilityId",
      "capability",
      "capabilityVersion",
      "version",
      "args",
      "argsHash",
      "argumentHash",
      "canonicalArgsHash",
    ].some((field) => Object.prototype.hasOwnProperty.call(input, field));
    return {
      binding: hasInlineBinding ? null : nestedBinding,
      credential: input.approval ?? input.approvalRef ?? input.credential ?? input.token,
    };
  }
  const hasInlineCredential = input.approval !== undefined
    || input.approvalRef !== undefined
    || input.credential !== undefined
    || input.token !== undefined
    || input.approvalId !== undefined
    || input.approvalNonce !== undefined;
  if (!hasInlineCredential) return { binding: input, credential: undefined };
  const {
    approval,
    approvalRef,
    credential: inline,
    token,
    approvalId,
    approvalNonce,
    nonce,
    ...binding
  } = input;
  let reference = approval ?? approvalRef ?? inline ?? token;
  if (reference === undefined && approvalId !== undefined) reference = { approvalId, nonce: nonce ?? approvalNonce };
  return { binding, credential: reference };
}
