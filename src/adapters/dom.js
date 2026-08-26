import { createAdapter } from './base.js';
import {
  ADAPTER_KINDS,
  AdapterContractError,
  assertRecord,
  cloneJson,
  isJsonSafe,
  isPlainObject,
} from './contracts.js';

const TARGET_FORBIDDEN_KEYS = new Set(['selector', 'css', 'xpath', 'query', 'script', 'code', 'event']);

function normalizeTarget({ target, capability }) {
  if (!isPlainObject({ value: target })) {
    throw new AdapterContractError({ code: 'DOM_TARGET_REQUIRED', message: `DOM capability ${capability} must declare a semantic target.` });
  }
  for (const key of Object.keys(target)) {
    if (TARGET_FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new AdapterContractError({ code: 'ADAPTER_RAW_OPERATION_FORBIDDEN', message: 'DOM adapters accept semantic accessibility targets only.' });
    }
  }
  if (typeof target.role !== 'string' || target.role.trim() === '') {
    throw new AdapterContractError({ code: 'DOM_TARGET_INVALID', message: `DOM capability ${capability} target role is required.` });
  }
  if (target.name !== undefined && typeof target.name !== 'string') {
    throw new AdapterContractError({ code: 'DOM_TARGET_INVALID', message: `DOM capability ${capability} target name must be a string.` });
  }
  if (target.name === undefined && target.label === undefined && target.id === undefined) {
    throw new AdapterContractError({ code: 'DOM_TARGET_INVALID', message: `DOM capability ${capability} target needs an accessible name, label, or stable id.` });
  }
  if (!isJsonSafe({ value: target })) {
    throw new AdapterContractError({ code: 'DOM_TARGET_INVALID', message: `DOM capability ${capability} target must be JSON-safe.` });
  }
  return cloneJson({ value: target });
}

function treeContainsTarget({ tree, target }) {
  if (tree === undefined || tree === null) return false;
  const visit = (node) => {
    if (Array.isArray(node)) return node.some((entry) => visit(entry));
    if (!isPlainObject({ value: node })) return false;
    const roleMatches = typeof node.role === 'string' && node.role.toLowerCase() === target.role.toLowerCase();
    const name = node.name ?? node.label;
    const nameMatches = target.name === undefined || (typeof name === 'string' && name === target.name);
    const labelMatches = target.label === undefined || (typeof node.label === 'string' && node.label === target.label);
    const idMatches = target.id === undefined || node.id === target.id;
    if (roleMatches && nameMatches && labelMatches && idMatches) return true;
    return Object.values(node).some((child) => Array.isArray(child) || isPlainObject({ value: child }) ? visit(child) : false);
  };
  return visit(tree);
}

/**
 * Create a semantic DOM/accessibility adapter.  Locators are accessibility
 * roles/names/labels or stable application ids; CSS/XPath/query/script data is
 * rejected at construction time.
 */
export function createDomAccessibilityAdapter(spec = {}) {
  const input = assertRecord({ value: spec, name: 'DOM accessibility adapter specification' });
  const rawCapabilities = input.capabilities ?? input.operations;
  if (!Array.isArray(rawCapabilities) || rawCapabilities.length === 0) {
    throw new AdapterContractError({ code: 'ADAPTER_CAPABILITIES_REQUIRED', message: 'DOM accessibility adapter requires semantic capabilities.' });
  }
  const capabilities = rawCapabilities.map((descriptor) => {
    if (!isPlainObject({ value: descriptor })) throw new AdapterContractError({ code: 'ADAPTER_CAPABILITY_INVALID', message: 'DOM capability must be a plain object.' });
    const semanticTarget = descriptor.semanticTarget ?? descriptor.target;
    return { ...descriptor, semanticTarget: normalizeTarget({ target: semanticTarget, capability: descriptor.name ?? descriptor.id }) };
  });
  const tree = input.accessibilityTree ?? input.tree;
  if (tree !== undefined && !isJsonSafe({ value: tree })) {
    throw new AdapterContractError({ code: 'DOM_TREE_INVALID', message: 'Accessibility tree must be JSON-safe.' });
  }
  const userAvailability = input.availability;
  return createAdapter({
    ...input,
    id: input.id ?? 'dom.accessibility',
    kind: ADAPTER_KINDS.DOM_ACCESSIBILITY,
    source: input.source ?? 'accessibility-tree',
    capabilities,
    availability: ({ capability, request, ...rest }) => {
      const descriptor = capabilities.find((entry) => (entry.name ?? entry.id) === capability);
      const present = descriptor ? treeContainsTarget({ tree: request?.accessibilityTree ?? request?.tree ?? tree, target: descriptor.semanticTarget ?? descriptor.target }) : false;
      let custom = { available: present, reason: present ? undefined : 'Semantic target was not present in the accessibility tree.' };
      if (userAvailability) {
        const user = userAvailability({ capability, request, ...rest });
        if (user && typeof user.then === 'function') return { available: false, reason: 'Asynchronous availability checks are not permitted during routing.' };
        if (typeof user === 'boolean') custom = { ...custom, available: custom.available && user };
        else if (isPlainObject({ value: user })) custom = { ...custom, ...user, available: custom.available && user.available !== false };
      }
      return custom;
    },
  });
}

// A short alias keeps imports ergonomic while retaining the explicit contract
// name in stack traces and descriptors.
export const createDomAdapter = createDomAccessibilityAdapter;

