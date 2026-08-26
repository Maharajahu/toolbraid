import {
  bindingWithoutArgs,
  normalizeAdapter,
  normalizeBinding,
  normalizeHash,
  normalizeIdentity,
  normalizeOrigin,
} from "./binding.js";
import { canonicalHash } from "./canonical.js";
import { SecurityError } from "./errors.js";

const EFFECTS = new Set(["allow", "deny"]);
const VALUE_FIELDS = Object.freeze([
  ["tenantId", "tenantIds"],
  ["subjectId", "subjectIds", ["subject"]],
  ["workflowId", "workflowIds", ["runId"]],
  ["nodeId", "nodeIds"],
  ["origin", "origins"],
  ["adapter", "adapters", ["adapterId"]],
  ["capability", "capabilities", ["capabilityId"]],
  ["action", "actions", ["operation"]],
]);

/**
 * Policy decisions are deliberately independent of provider metadata or UI
 * state.  A policy rule can match only the normalized execution request and
 * explicit, server-configured selectors.  Mutation authorization additionally
 * requires an ApprovalAuthority credential and consumes it atomically.
 */
export class PolicyEngine {
  #rules;
  #allowReadOnly;
  #approvalAuthority;
  #audit;

  constructor({
    rules = [],
    allowReadOnly = false,
    approvalAuthority,
    audit,
    allowedOrigins,
    allowedAdapters,
    allowedCapabilities,
    allowedActions,
    deniedOrigins,
    deniedAdapters,
    deniedCapabilities,
    deniedActions,
  } = {}) {
    if (!Array.isArray(rules)) throw new SecurityError("INVALID_POLICY", "rules must be an array.");
    if (typeof allowReadOnly !== "boolean") throw new SecurityError("INVALID_POLICY", "allowReadOnly must be boolean.");
    if (approvalAuthority !== undefined && typeof approvalAuthority.consume !== "function") {
      throw new SecurityError("INVALID_POLICY", "approvalAuthority must expose consume().");
    }
    if (audit !== undefined && typeof audit.append !== "function") {
      throw new SecurityError("INVALID_POLICY", "audit must expose append().");
    }

    const shorthandRules = [];
    const allowSelectors = {
      origins: allowedOrigins,
      adapters: allowedAdapters,
      capabilities: allowedCapabilities,
      actions: allowedActions,
    };
    const denySelectors = {
      origins: deniedOrigins,
      adapters: deniedAdapters,
      capabilities: deniedCapabilities,
      actions: deniedActions,
    };
    if (hasAnySelector(allowSelectors)) shorthandRules.push({ effect: "allow", ...allowSelectors });
    if (hasAnySelector(denySelectors)) shorthandRules.push({ effect: "deny", ...denySelectors });
    this.#rules = Object.freeze([...rules, ...shorthandRules].map((rule, index) => normalizeRule(rule, index)));
    this.#allowReadOnly = allowReadOnly;
    this.#approvalAuthority = approvalAuthority;
    this.#audit = audit;
  }

  get rules() {
    return this.#rules.map((rule) => ({ ...rule, selectors: { ...rule.selectors } }));
  }

  /** Pure policy/approval preflight.  No approval nonce is consumed. */
  evaluate(request) {
    let normalized;
    try {
      normalized = normalizeRequest(request);
    } catch {
      return denial("INVALID_REQUEST", "Execution request is invalid.");
    }

    const { binding, mutation, capability, action } = normalized;
    const matchingDeny = this.#rules.find((rule) => rule.effect === "deny" && matches(rule, normalized));
    if (matchingDeny) {
      const result = denial("POLICY_DENIED", "Execution is denied by policy.", matchingDeny.id);
      this.#auditDecision(normalized, result);
      return result;
    }

    const allowRules = this.#rules.filter((rule) => rule.effect === "allow");
    const hasExplicitAllow = allowRules.some((rule) => matches(rule, normalized));
    // Read-only access can be enabled explicitly for a deployment with no
    // rules.  If rules exist, an explicit allow is still required, so a broad
    // read-only default can never bypass a deny/allow configuration.
    const allowByDefault = !mutation && this.#allowReadOnly && this.#rules.length === 0;
    if (!hasExplicitAllow && !allowByDefault) {
      const result = denial("POLICY_DENIED", "Execution is not allowed by policy.");
      this.#auditDecision(normalized, result);
      return result;
    }

    if (mutation) {
      if (!this.#approvalAuthority) {
        const result = denial("APPROVAL_REQUIRED", "Mutating execution requires a trusted server-side approval.");
        this.#auditDecision(normalized, result);
        return result;
      }
      const approval = this.#credential(request);
      // Recompute argsHash inside the authority from the original request;
      // passing only the normalized hash here would allow a caller to present
      // a hash-only binding that the authority cannot independently validate.
      let verified;
      try {
        verified = this.#approvalAuthority.verify(request, approval);
      } catch {
        verified = { ok: false, code: "APPROVAL_INVALID" };
      }
      if (!verified || verified.ok !== true) {
        const result = denial(verified?.code ?? "APPROVAL_INVALID", "Trusted approval is missing or invalid.");
        this.#auditDecision(normalized, result);
        return result;
      }
    }

    const result = {
      allowed: true,
      authorized: false,
      code: "OK",
      mutation,
      capability,
      action,
      binding: bindingWithoutArgs(binding),
    };
    this.#auditDecision(normalized, result);
    return result;
  }

  check(request) {
    return this.evaluate(request);
  }

  /**
   * Authorize an execution and, for mutations, consume its approval in the
   * same synchronous call.  Callers must use this method immediately before
   * invoking an adapter; a later adapter/origin/args change is rejected by the
   * binding check.
   */
  authorize(request) {
    const preflight = this.evaluate(request);
    if (!preflight.allowed) return preflight;
    let normalized;
    try {
      normalized = normalizeRequest(request);
    } catch {
      return denial("INVALID_REQUEST", "Execution request is invalid.");
    }
    if (!normalized.mutation) return { ...preflight, authorized: true };

    // As above, hand the authority the original argument object so the
    // canonical hash is recomputed at the trust boundary.
    let consumed;
    try {
      consumed = this.#approvalAuthority.consume(request, this.#credential(request));
    } catch {
      consumed = { ok: false, code: "APPROVAL_INVALID" };
    }
    if (!consumed || consumed.ok !== true || consumed.consumed !== true) {
      const result = denial(consumed?.code ?? "APPROVAL_INVALID", "Trusted approval could not be consumed.");
      this.#auditDecision(normalized, result);
      return result;
    }
    return {
      ...preflight,
      authorized: true,
      approvalId: consumed.approvalId,
      expiresAt: consumed.expiresAt,
    };
  }

  authorizeMutation(request) {
    return this.authorize({ ...request, mutation: true });
  }

  #credential(request) {
    if (request && request.approval !== undefined) return request.approval;
    return request?.approvalRef;
  }

  #auditDecision(normalized, result) {
    if (!this.#audit) return;
    try {
      this.#audit.append(result.allowed ? "policy.allowed" : "policy.denied", {
        ...bindingWithoutArgs(normalized.binding),
        mutation: normalized.mutation,
        capability: normalized.capability,
        action: normalized.action,
        code: result.code,
      });
    } catch {
      // Audit transport failure must not turn a denial into an allow or vice
      // versa.  The decision itself remains fail-closed at its caller.
    }
  }
}

export const SecurityPolicy = PolicyEngine;

export function createPolicyEngine(options = {}) {
  return new PolicyEngine(options);
}

export function evaluatePolicy(engineOrInput, maybeInput) {
  if (engineOrInput instanceof PolicyEngine) return engineOrInput.evaluate(maybeInput);
  if (engineOrInput && typeof engineOrInput.evaluate === "function") return engineOrInput.evaluate(maybeInput);
  return new PolicyEngine().evaluate(engineOrInput);
}

export function normalizeRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new SecurityError("INVALID_REQUEST", "Execution request must be an object.");
  }
  const binding = normalizeBinding(request, { requireArgs: true });
  const mutation = resolveMutation(request);
  const capabilityValue = aliasedRequestValue(request, "capability", ["capabilityId"]);
  const actionValue = aliasedRequestValue(request, "action", ["operation"]);
  const capability = capabilityValue === undefined ? undefined : normalizeToken("capability", capabilityValue);
  const action = actionValue === undefined ? undefined : normalizeToken("action", actionValue);
  if (capability === undefined && action === undefined) {
    throw new SecurityError("INVALID_REQUEST", "Execution request requires capability or action.");
  }
  return Object.freeze({
    binding,
    mutation,
    capability,
    action,
    // Arguments are intentionally not copied into policy results or audit;
    // only their canonical hash crosses the security boundary.
    argsHash: binding.argsHash,
  });
}

export function isMutationRequest(request) {
  return resolveMutation(request);
}

function normalizeRule(rule, index) {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
    throw new SecurityError("INVALID_POLICY", `Rule ${index} must be an object.`);
  }
  if (!EFFECTS.has(rule.effect)) throw new SecurityError("INVALID_POLICY", `Rule ${index} has an invalid effect.`);
  const id = rule.id === undefined ? `rule-${index + 1}` : normalizeToken("rule id", rule.id);
  const selectors = {};
  for (const [singular, plural] of VALUE_FIELDS) {
    const aliases = VALUE_FIELDS.find(([name]) => name === singular)?.[2] ?? [];
    const supplied = firstDefinedProperty(rule, [plural, singular, ...aliases]);
    if (supplied !== undefined) selectors[plural] = normalizeSelector(plural, supplied, singular);
  }
  if (rule.argsHash !== undefined) selectors.argsHash = normalizeHash(rule.argsHash);
  if (rule.args !== undefined) {
    const computedArgsHash = canonicalHash(rule.args);
    if (selectors.argsHash !== undefined && selectors.argsHash !== computedArgsHash) {
      throw new SecurityError("INVALID_POLICY", `Rule ${index} argsHash does not match args.`);
    }
    selectors.argsHash = computedArgsHash;
  }
  if (rule.mutation !== undefined) {
    if (typeof rule.mutation !== "boolean") throw new SecurityError("INVALID_POLICY", `Rule ${index} mutation must be boolean.`);
    selectors.mutation = rule.mutation;
  }
  return Object.freeze({ effect: rule.effect, id, selectors: Object.freeze(selectors) });
}

function normalizeSelector(name, value, singular) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new SecurityError("INVALID_POLICY", `${name} may not be empty.`);
  return Object.freeze(values.map((entry) => {
    if (singular === "origin") return normalizeOrigin(entry);
    if (singular === "adapter") return normalizeAdapter(entry);
    return normalizeIdentity(name, entry);
  }));
}

function matches(rule, request) {
  const { selectors } = rule;
  const binding = request.binding;
  const values = {
    tenantIds: binding.tenantId,
    subjectIds: binding.subjectId,
    workflowIds: binding.workflowId,
    nodeIds: binding.nodeId,
    origins: binding.origin,
    adapters: binding.adapter,
    capabilities: request.capability,
    actions: request.action,
  };
  for (const [key, expected] of Object.entries(selectors)) {
    if (key === "mutation") {
      if (request.mutation !== expected) return false;
      continue;
    }
    if (key === "argsHash") {
      if (binding.argsHash !== expected) return false;
      continue;
    }
    if (!Array.isArray(expected)) continue;
    if (!expected.includes(values[key])) return false;
  }
  return true;
}

function resolveMutation(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new SecurityError("INVALID_REQUEST", "Execution request must be an object.");
  }
  const indicators = [];
  if (request.mutation !== undefined) {
    if (typeof request.mutation !== "boolean") throw new SecurityError("INVALID_REQUEST", "mutation must be boolean.");
    indicators.push(request.mutation);
  }
  if (request.readOnly !== undefined) {
    if (typeof request.readOnly !== "boolean") throw new SecurityError("INVALID_REQUEST", "readOnly must be boolean.");
    indicators.push(!request.readOnly);
  }
  if (request.mode !== undefined) {
    if (typeof request.mode !== "string") throw new SecurityError("INVALID_REQUEST", "mode must be a string.");
    const mode = request.mode.toLowerCase();
    if (mode !== "read" && mode !== "readonly" && mode !== "mutate" && mode !== "mutation") {
      throw new SecurityError("INVALID_REQUEST", "mode must be read-only or mutation.");
    }
    indicators.push(mode === "mutate" || mode === "mutation");
  }
  if (indicators.length === 0) return true; // fail closed when unspecified
  if (indicators.some((entry) => entry !== indicators[0])) {
    throw new SecurityError("INVALID_REQUEST", "mutation, readOnly and mode disagree.");
  }
  return indicators[0];
}

function normalizeToken(name, value) {
  return normalizeIdentity(name, value);
}

function hasAnySelector(selectors) {
  return Object.values(selectors).some((value) => value !== undefined);
}

function firstDefinedProperty(object, fields) {
  const present = fields.filter((field) => Object.prototype.hasOwnProperty.call(object, field) && object[field] !== undefined);
  if (present.length === 0) return undefined;
  const value = object[present[0]];
  for (const field of present.slice(1)) {
    if (object[field] !== value) throw new SecurityError("INVALID_POLICY", `Conflicting ${present[0]} selectors.`);
  }
  return value;
}

function aliasedRequestValue(request, canonical, aliases) {
  return firstDefinedProperty(request, [canonical, ...aliases]);
}

function denial(code, message, ruleId) {
  return {
    allowed: false,
    authorized: false,
    code,
    message,
    ...(ruleId === undefined ? {} : { ruleId }),
  };
}
