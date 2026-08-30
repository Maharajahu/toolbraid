import { iconNameForNode } from './icons.js';

const TAU = Math.PI * 2;

export const CONSTELLATION_STATES = Object.freeze([
  'idle',
  'active',
  'complete',
  'quarantined',
  'locked',
]);

const STATE_SET = new Set(CONSTELLATION_STATES);

const DEFAULT_MUTATIONS = Object.freeze([
  Object.freeze({
    id: 'recovery.option.apply',
    label: 'Apply recovery',
    state: 'locked',
  }),
  Object.freeze({
    id: 'status.notice.publish',
    label: 'Publish notice',
    state: 'locked',
  }),
]);

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number.`);
  return number;
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new TypeError(`${label} must be greater than zero.`);
  return number;
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function stateOf(value, fallback = 'idle') {
  return STATE_SET.has(value) ? value : fallback;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function semanticToken(value) {
  const source = String(value);
  const slug = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'item';
  return `${slug}-${fnv1a(source)}`;
}

function semanticNodeId(type, value) {
  return `node--${type}--${semanticToken(value)}`;
}

export function createEdgeId(kind, fromId, toId) {
  return `edge--${semanticToken(kind)}--${semanticToken(fromId)}--${semanticToken(toId)}`;
}

function formatNumber(value) {
  const rounded = Math.round(finiteNumber(value, 'Coordinate') * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function pointOnRing(centerX, centerY, radius, angle) {
  return {
    x: Math.round((centerX + Math.cos(angle) * radius) * 100) / 100,
    y: Math.round((centerY + Math.sin(angle) * radius) * 100) / 100,
  };
}

function angleAcrossArc(index, count, start, end) {
  return count === 1 ? (start + end) / 2 : start + ((end - start) * index) / (count - 1);
}

function boundaryPoint(node, toward, padding = 0) {
  const dx = finiteNumber(toward.x, 'toward.x') - finiteNumber(node.x, 'node.x');
  const dy = finiteNumber(toward.y, 'toward.y') - finiteNumber(node.y, 'node.y');
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;

  if (Number.isFinite(node.width) && Number.isFinite(node.height)) {
    const halfWidth = node.width / 2;
    const halfHeight = node.height / 2;
    const scale = 1 / Math.max(Math.abs(ux) / halfWidth, Math.abs(uy) / halfHeight);
    return {
      x: node.x + ux * (scale + padding),
      y: node.y + uy * (scale + padding),
    };
  }

  const radius = Number.isFinite(node.radius) ? node.radius : 0;
  return {
    x: node.x + ux * (radius + padding),
    y: node.y + uy * (radius + padding),
  };
}

function providerLabel(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort(compareText);
}

function normaliseInputs({ providers = [], capabilities, tools, mutations, hub = {} }) {
  if (!Array.isArray(providers)) throw new TypeError('providers must be an array.');
  const capabilityInputs = capabilities ?? tools ?? [];
  if (!Array.isArray(capabilityInputs)) throw new TypeError('capabilities must be an array.');

  const providerMap = new Map();
  for (const provider of providers) {
    const origin = requiredText(provider?.origin, 'Provider origin');
    if (providerMap.has(origin)) throw new TypeError(`Duplicate provider origin: ${origin}`);
    providerMap.set(origin, {
      providerId: provider.id ?? provider.providerId ?? null,
      origin,
      label: String(provider.label ?? provider.title ?? providerLabel(origin)),
      state: stateOf(provider.state),
      meta: provider.meta ?? null,
    });
  }

  const capabilityMap = new Map();
  for (const capability of capabilityInputs) {
    const id = requiredText(capability?.id ?? capability?.capability ?? capability?.name, 'Capability id');
    if (capabilityMap.has(id)) throw new TypeError(`Duplicate capability id: ${id}`);
    const providerOrigins = uniqueSorted([
      ...(capability.providerOrigins ?? capability.origins ?? []),
      capability.providerOrigin,
      capability.origin,
    ]);
    for (const origin of providerOrigins) {
      if (!providerMap.has(origin)) {
        providerMap.set(origin, {
          origin,
          label: providerLabel(origin),
          state: 'idle',
          meta: null,
        });
      }
    }
    capabilityMap.set(id, {
      id,
      label: id === 'unsafe.override'
        ? 'Override attempt'
        : String(capability.label ?? capability.title ?? id),
      state: stateOf(capability.state),
      providerOrigins,
      providerEdgeState: stateOf(capability.providerEdgeState),
      hubEdgeState: stateOf(capability.hubEdgeState),
      meta: capability.meta ?? null,
    });
  }

  const mutationInputs = mutations ?? DEFAULT_MUTATIONS;
  if (!Array.isArray(mutationInputs) || mutationInputs.length !== 2) {
    throw new TypeError('A constellation requires exactly two mutation nodes.');
  }
  const mutationMap = new Map();
  for (const mutation of mutationInputs) {
    const id = requiredText(mutation?.id ?? mutation?.capability ?? mutation?.name, 'Mutation id');
    if (mutationMap.has(id)) throw new TypeError(`Duplicate mutation id: ${id}`);
    mutationMap.set(id, {
      id,
      label: String(mutation.label ?? mutation.title ?? id),
      state: stateOf(mutation.state, 'locked'),
      edgeState: stateOf(mutation.edgeState, 'locked'),
      meta: mutation.meta ?? null,
    });
  }

  return {
    providers: [...providerMap.values()].sort((a, b) => compareText(a.origin, b.origin)),
    capabilities: [...capabilityMap.values()].sort((a, b) => compareText(a.id, b.id)),
    mutations: [...mutationMap.values()].sort((a, b) => compareText(a.id, b.id)),
    hub: {
      id: requiredText(hub.id ?? 'toolbraid', 'Hub id'),
      label: String(hub.label ?? hub.title ?? 'ToolBraid'),
      subtitle: String(hub.subtitle ?? 'Mission Control'),
      state: stateOf(hub.state),
    },
  };
}

/**
 * Build a deterministic radial layout. Input order never changes geometry.
 * Capability entries may reference one or more providers through
 * `providerOrigin` or `providerOrigins`.
 */
export function createConstellationLayout(input = {}) {
  const width = positiveNumber(input.width ?? 1200, 'width');
  const height = positiveNumber(input.height ?? 820, 'height');
  const centerX = finiteNumber(input.centerX ?? width / 2, 'centerX');
  const centerY = finiteNumber(input.centerY ?? height * 0.4, 'centerY');
  const outerRadius = positiveNumber(
    input.outerRadius ?? Math.min(width * 0.34, height * 0.33),
    'outerRadius',
  );
  const innerRadius = positiveNumber(
    input.innerRadius ?? Math.min(width * 0.22, height * 0.2),
    'innerRadius',
  );
  const inputs = normaliseInputs(input);

  const providerStartAngle = (-7 * Math.PI) / 6;
  const providerEndAngle = Math.PI / 6;
  const providerNodes = inputs.providers.map((provider, index, all) => {
    const angle = angleAcrossArc(index, all.length, providerStartAngle, providerEndAngle);
    return {
      ...provider,
      id: semanticNodeId('provider', provider.origin),
      semanticId: provider.origin,
      type: 'provider',
      ...pointOnRing(centerX, centerY, outerRadius, angle),
      radius: 40,
      labelPlacement: Math.sin(angle) < -0.15 ? 'above' : 'below',
    };
  });

  const providerOrder = new Map(inputs.providers.map((provider, index) => [provider.origin, index]));
  const capabilityOrder = [...inputs.capabilities].sort((left, right) => {
    const anchor = (capability) => {
      const indexes = capability.providerOrigins
        .map((origin) => providerOrder.get(origin))
        .filter(Number.isInteger);
      return indexes.length
        ? indexes.reduce((sum, value) => sum + value, 0) / indexes.length
        : Number.POSITIVE_INFINITY;
    };
    const anchorDifference = anchor(left) - anchor(right);
    return anchorDifference || compareText(left.id, right.id);
  });
  const capabilityStartAngle = (-10 * Math.PI) / 9;
  const capabilityEndAngle = Math.PI / 9;
  const capabilityNodes = capabilityOrder.map((capability, index, all) => ({
    ...capability,
    id: semanticNodeId('capability', capability.id),
    semanticId: capability.id,
    capabilityId: capability.id,
    type: 'capability',
    ...pointOnRing(
      centerX,
      centerY,
      innerRadius,
      angleAcrossArc(index, all.length, capabilityStartAngle, capabilityEndAngle),
    ),
    radius: 27,
  }));

  const hubNode = {
    ...inputs.hub,
    id: semanticNodeId('hub', inputs.hub.id),
    semanticId: inputs.hub.id,
    type: 'hub',
    x: centerX,
    y: centerY,
    radius: 64,
  };

  const mutationGap = positiveNumber(
    input.mutationGap ?? Math.min(180, width * 0.16),
    'mutationGap',
  );
  const mutationWidth = positiveNumber(input.mutationWidth ?? 214, 'mutationWidth');
  const mutationHeight = positiveNumber(input.mutationHeight ?? 64, 'mutationHeight');
  const mutationY = height - 58;
  const mutationNodes = inputs.mutations.map((mutation, index) => ({
    ...mutation,
    id: semanticNodeId('mutation', mutation.id),
    semanticId: mutation.id,
    capabilityId: mutation.id,
    type: 'mutation',
    x: centerX + (index === 0 ? -mutationGap : mutationGap),
    y: mutationY,
    width: mutationWidth,
    height: mutationHeight,
    approvalRequired: true,
    gate: 'approval',
  }));

  const providerByOrigin = new Map(providerNodes.map((provider) => [provider.origin, provider]));
  const edgeStates = input.edgeStates ?? {};
  const edges = [];

  const addEdge = ({ kind, from, to, fallbackState, curvature, direction = 1 }) => {
    const id = createEdgeId(kind, from.semanticId, to.semanticId);
    const state = stateOf(edgeStates[id], fallbackState);
    const start = boundaryPoint(from, to, 2);
    const end = boundaryPoint(to, from, 8);
    edges.push({
      id,
      semanticId: `${from.semanticId} -> ${to.semanticId}`,
      kind,
      from: from.id,
      fromSemanticId: from.semanticId,
      to: to.id,
      toSemanticId: to.semanticId,
      state,
      path: createCurvedSvgPath(start, end, { curvature, direction }),
    });
  };

  for (const capability of capabilityNodes) {
    for (const origin of capability.providerOrigins) {
      const provider = providerByOrigin.get(origin);
      if (provider) {
        addEdge({
          kind: 'provider-capability',
          from: provider,
          to: capability,
          fallbackState: capability.state === 'quarantined' ? 'quarantined' : capability.providerEdgeState,
          curvature: 0,
        });
      }
    }
    addEdge({
      kind: 'capability-hub',
      from: capability,
      to: hubNode,
      fallbackState: capability.state === 'quarantined' ? 'quarantined' : capability.hubEdgeState,
      curvature: 0,
    });
  }

  for (const mutation of mutationNodes) {
    addEdge({
      kind: 'hub-mutation',
      from: hubNode,
      to: mutation,
      fallbackState: mutation.edgeState,
      curvature: 0.06,
      direction: mutation.x < hubNode.x ? 1 : -1,
    });
  }

  const nodes = [...providerNodes, ...capabilityNodes, hubNode, ...mutationNodes];
  return Object.freeze({
    width,
    height,
    viewBox: `0 0 ${formatNumber(width)} ${formatNumber(height)}`,
    center: Object.freeze({ x: centerX, y: centerY }),
    radii: Object.freeze({ outer: outerRadius, inner: innerRadius }),
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    providers: Object.freeze(providerNodes),
    capabilities: Object.freeze(capabilityNodes),
    hub: hubNode,
    mutations: Object.freeze(mutationNodes),
  });
}

/** Produce a stable quadratic SVG path between two finite points. */
export function createCurvedSvgPath(from, to, { curvature = 0.1, direction = 1 } = {}) {
  const x1 = finiteNumber(from?.x, 'from.x');
  const y1 = finiteNumber(from?.y, 'from.y');
  const x2 = finiteNumber(to?.x, 'to.x');
  const y2 = finiteNumber(to?.y, 'to.y');
  const curve = finiteNumber(curvature, 'curvature');
  const side = finiteNumber(direction, 'direction') < 0 ? -1 : 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.hypot(dx, dy);
  const offset = distance * curve * side;
  const normalX = distance === 0 ? 0 : -dy / distance;
  const normalY = distance === 0 ? 0 : dx / distance;
  const controlX = (x1 + x2) / 2 + normalX * offset;
  const controlY = (y1 + y2) / 2 + normalY * offset;
  return `M ${formatNumber(x1)} ${formatNumber(y1)} Q ${formatNumber(controlX)} ${formatNumber(controlY)} ${formatNumber(x2)} ${formatNumber(y2)}`;
}

export function escapeSvgText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeSvgAttribute(value) {
  return escapeSvgText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stateClasses(base, type, state) {
  return `${base} ${base}--${type} is-${state}`;
}

function semanticIconKind(node) {
  if (node.type === 'hub') return 'toolbraid';
  const mapped = iconNameForNode(node);
  if (mapped === 'recovery-plan') return 'recovery';
  if (!['spark', 'provider', 'lock'].includes(mapped)) return mapped;
  const meaning = `${node.semanticId ?? ''} ${node.label ?? ''}`.toLowerCase();
  if (/advers|attack|quarant|security|untrusted|unsafe|override|bypass|mirage/.test(meaning)) return 'quarantine';
  if (/publish|send|outbound/.test(meaning)) return 'send';
  if (/prepare|stage/.test(meaning)) return 'shield';
  if (/pulse|radar/.test(meaning)) return 'radar';
  if (/health|uptime|monitor|service/.test(meaning)) return 'activity';
  if (/release|source|repository|\bgit\b/.test(meaning)) return 'branch';
  if (/deploy/.test(meaning)) return 'deployment';
  if (/recover|rollback|restore/.test(meaning)) return 'recovery';
  if (/status|notice|customer|communicat|publish/.test(meaning)) return 'broadcast';
  return node.type === 'provider' ? 'provider' : 'capability';
}

function semanticIconGeometry(kind) {
  switch (kind) {
    case 'waveform':
      return '<path class="tb-icon__stroke" d="M-12 0h3l1.7-7 3.1 14 3.1-11 2.5 8L4-1l2 1h6" /><path class="tb-icon__accent" d="M-11-10h22M-11 10h22" />';
    case 'health':
      return '<path class="tb-icon__stroke" d="M0 11S-10 5-10-3a6 6 0 0 1 10-4 6 6 0 0 1 10 4C10 5 0 11 0 11Z" /><path class="tb-icon__accent" d="M-7 1h3l1.5-4L1 5l2-5 1.5 1H7" />';
    case 'activity':
      return '<path class="tb-icon__stroke" d="M-11 1h4l2.5-7 5 13 3.5-8 2 2h5" /><circle class="tb-icon__signal" cx="-11" cy="1" r="1.7" /><circle class="tb-icon__signal" cx="11" cy="1" r="1.7" />';
    case 'radar':
      return '<circle class="tb-icon__stroke" cx="0" cy="0" r="10" /><circle class="tb-icon__accent" cx="0" cy="0" r="5" /><path class="tb-icon__stroke" d="M0 0l7-7" /><circle class="tb-icon__signal" cx="0" cy="0" r="2" />';
    case 'branch':
      return '<path class="tb-icon__stroke" d="M-11-7h7l2-3h13V9h-22V-7Z" /><path class="tb-icon__accent" d="M-7-2h4M2-2h5M-5-2v6h10v-6" /><circle class="tb-icon__signal" cx="-5" cy="6" r="1.4" /><circle class="tb-icon__signal" cx="5" cy="6" r="1.4" />';
    case 'history':
    case 'release-history':
      return '<path class="tb-icon__stroke" d="M-8-11H3l5 5v17H-8V-11Z" /><path class="tb-icon__accent" d="M3-11v5h5M-4-2h2M1-2h3M-4 3h2M1 3h3M-4 8h2M1 8h3" /><circle class="tb-icon__signal" cx="-0.5" cy="-2" r=".8" /><circle class="tb-icon__signal" cx="-0.5" cy="3" r=".8" /><circle class="tb-icon__signal" cx="-0.5" cy="8" r=".8" />';
    case 'deployment':
      return '<path class="tb-icon__stroke" d="M0-11 10-6 0-1-10-6 0-11Z" /><path class="tb-icon__accent" d="m-10 0 10 5 10-5M-10 6l10 5 10-5" />';
    case 'deployment-history':
      return '<path class="tb-icon__stroke" d="m-3-10 8 4-8 4-8-4 8-4ZM-11 0l8 4 4-2" /><circle class="tb-icon__stroke" cx="6" cy="6" r="6" /><path class="tb-icon__accent" d="M6 2v4l3 2" />';
    case 'status-board':
      return '<path class="tb-icon__stroke" d="M-11-9h22V7H-3l-5 4V7h-3V-9Z" /><circle class="tb-icon__signal" cx="-6" cy="-1" r="1.4" /><path class="tb-icon__accent" d="M-1-4h8M-1 1h6" />';
    case 'notice-read':
      return '<path class="tb-icon__stroke" d="M-11-9h22V6H-3l-5 4V6h-3V-9Z" /><path class="tb-icon__accent" d="M-7-1s3-4 7-4 7 4 7 4-3 4-7 4-7-4-7-4Z" /><circle class="tb-icon__signal" cx="0" cy="-1" r="1.8" />';
    case 'recovery':
      return '<path class="tb-icon__stroke" d="M-7-6h-5v-5M-11.5-6A10 10 0 1 1-9 7" /><path class="tb-icon__accent" d="M0-5v5l4 2" />';
    case 'rollback':
      return '<path class="tb-icon__stroke" d="M-7-6h-5v-5M-11.5-6A10 10 0 1 1-9 7" /><path class="tb-icon__accent" d="M0-6v6l5 3" /><circle class="tb-icon__signal" cx="0" cy="0" r="1.5" />';
    case 'broadcast':
      return '<path class="tb-icon__stroke" d="M-11-3h4L3-9V9L-7 3h-4v-6Z" /><path class="tb-icon__accent" d="m-6 3 2 7h4l-2-6M7-5a8 8 0 0 1 0 10M10-9a13 13 0 0 1 0 18" />';
    case 'shield':
      return '<path class="tb-icon__stroke" d="M0-11 10-7v7c0 6-4 10-10 13-6-3-10-7-10-13v-7L0-11Z" /><path class="tb-icon__accent" d="m-5 0 3.5 3.5L5-4" />';
    case 'recovery-plan':
      return '<path class="tb-icon__stroke" d="M0-11 10-7v7c0 6-4 10-10 13-6-3-10-7-10-13v-7L0-11Z" /><path class="tb-icon__accent" d="M-5-3h7M2-3 0-5M2-3 0-1M5 4h-7M-2 4l2-2M-2 4l2 2" />';
    case 'quarantine':
      return '<path class="tb-icon__stroke" d="M0-11 10-7v7c0 6-4 10-10 13-6-3-10-7-10-13v-7L0-11Z" /><path class="tb-icon__accent" d="m-4-3 8 8M4-3l-8 8" />';
    case 'mirage':
      return '<path class="tb-icon__stroke" d="M0-12 11 9h-22L0-12Z" /><path class="tb-icon__accent" d="m-5 6 5-11L5 6M-9 12H9M-11-7h4M7-7h4" />';
    case 'send':
      return '<path class="tb-icon__stroke" d="m-11-3 22-8-8 22-4-9-10-5Z" /><path class="tb-icon__accent" d="M-1 2 5-4" />';
    case 'provider':
      return '<rect class="tb-icon__stroke" x="-10" y="-9" width="20" height="7" rx="2" /><rect class="tb-icon__stroke" x="-10" y="2" width="20" height="7" rx="2" /><circle class="tb-icon__signal" cx="-6" cy="-5.5" r="1.3" /><circle class="tb-icon__signal" cx="-6" cy="5.5" r="1.3" /><path class="tb-icon__accent" d="M-2-5.5h7M-2 5.5h7" />';
    case 'toolbraid':
      return '<path class="tb-icon__stroke tb-icon__stroke--a" d="M-15-8C-9-15-4-15 1-8l8 13c2 4 5 4 7 0" /><path class="tb-icon__stroke tb-icon__stroke--b" d="M-15 8C-9 15-4 15 1 8l8-13c2-4 5-4 7 0" /><path class="tb-icon__accent" d="M-16 0c4-6 8-6 12 0L5 13M-4 0 5-13c3-4 7-4 10 0" /><circle class="tb-icon__signal" cx="0" cy="0" r="2" />';
    default:
      return '<path class="tb-icon__stroke" d="M0-14l5 9 10 5-10 5-5 9-5-9-10-5 10-5z" /><circle class="tb-icon__signal" cx="0" cy="0" r="3" />';
  }
}

function renderSemanticIcon(node, { x = node.x, y = node.y, scale = 1 } = {}) {
  const kind = semanticIconKind(node);
  const opticalOffsets = {
    'deployment-history': { x: -0.4, y: -0.8 },
    recovery: { x: 1.8, y: 0.7 },
    health: { x: 0, y: -0.9 },
    'notice-read': { x: 0, y: -0.4 },
    quarantine: { x: 0, y: -0.8 },
    branch: { x: 0, y: 0.5 },
    'status-board': { x: 0, y: -0.9 },
  };
  const offset = opticalOffsets[kind] ?? { x: 0, y: 0 };
  return `<g class="tb-node__icon tb-node__icon--${kind}" data-icon="${kind}" transform="translate(${formatNumber(x + offset.x)} ${formatNumber(y + offset.y)}) scale(${formatNumber(scale)})" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${semanticIconGeometry(kind)}</g>`;
}

function regularPolygonPath(x, y, radius, sides = 6, rotation = -Math.PI / 2) {
  return Array.from({ length: sides }, (_, index) => {
    const angle = rotation + (TAU * index) / sides;
    const point = `${formatNumber(x + Math.cos(angle) * radius)} ${formatNumber(y + Math.sin(angle) * radius)}`;
    return `${index ? 'L' : 'M'} ${point}`;
  }).join(' ') + ' Z';
}

function renderEdge(edge, arrowMarkerId) {
  const id = escapeSvgAttribute(edge.id);
  const kind = escapeSvgAttribute(edge.kind);
  const state = escapeSvgAttribute(stateOf(edge.state));
  const path = escapeSvgAttribute(edge.path);
  const routeId = `${id}--route`;
  const staticState = state === 'complete' || state === 'quarantined';
  const packetClass = staticState ? 'tb-edge__packet-static' : 'tb-edge__packet';
  const trailClass = staticState ? 'tb-edge__packet-trail-static' : 'tb-edge__packet-trail';
  const pulseClass = staticState ? 'tb-edge__pulse is-static' : 'tb-edge__pulse';
  const packetRadius = staticState ? '0' : null;
  return [
    `<g id="${id}" class="${stateClasses('tb-edge', kind, state)}" data-edge-id="${id}" data-from="${escapeSvgAttribute(edge.fromSemanticId)}" data-to="${escapeSvgAttribute(edge.toSemanticId)}" data-state="${state}" data-flow-direction="a-to-b" data-animation="${staticState ? 'disabled' : 'available'}" data-pulse-route="${routeId}" aria-hidden="true">`,
    `<path id="${routeId}" class="tb-edge__route" d="${path}" pathLength="1" fill="none" stroke="none" />`,
    `<path class="tb-edge__track" d="${path}" pathLength="1" marker-end="url(#${escapeSvgAttribute(arrowMarkerId)})" />`,
    `<path class="${pulseClass}" d="${path}" pathLength="1" />`,
    `<path class="${trailClass} ${trailClass}--lead" data-packet-trail="lead" d="${path}" pathLength="1" fill="none" opacity="0" />`,
    `<path class="${trailClass} ${trailClass}--echo" data-packet-trail="echo" d="${path}" pathLength="1" fill="none" opacity="0" />`,
    `<circle class="${packetClass} ${packetClass}--lead" data-packet="lead" cx="0" cy="0" r="${packetRadius ?? '3'}" opacity="0">`,
    `<animateMotion class="tb-edge__packet-motion" data-motion="lead" begin="indefinite" dur="1.25s" path="${path}" />`,
    '</circle>',
    `<circle class="${packetClass} ${packetClass}--echo" data-packet="echo" cx="0" cy="0" r="${packetRadius ?? '2'}" opacity="0">`,
    `<animateMotion class="tb-edge__packet-motion" data-motion="echo" begin="indefinite" dur="1.7s" path="${path}" />`,
    '</circle>',
    '</g>',
  ].join('');
}

function renderNode(node) {
  const state = stateOf(node.state, node.type === 'mutation' ? 'locked' : 'idle');
  const stateAttribute = escapeSvgAttribute(state);
  const type = escapeSvgAttribute(node.type);
  const id = escapeSvgAttribute(node.id);
  const label = escapeSvgText(node.label);
  const accessibleLabel = escapeSvgAttribute(`${node.label}, ${node.type}, ${state}`);
  const tier = node.type === 'provider'
    ? 'origin'
    : node.type === 'capability'
      ? 'canonical-capability'
      : node.type === 'mutation'
        ? 'authority-gate'
        : 'orchestrator';
  const hierarchyLevel = node.type === 'provider' ? '1' : node.type === 'capability' ? '2' : node.type === 'mutation' ? '3' : '0';
  const dataIdentity = node.type === 'provider'
    ? ` data-origin="${escapeSvgAttribute(node.origin)}"`
    : node.capabilityId
      ? ` data-capability="${escapeSvgAttribute(node.capabilityId)}"`
      : '';
  const common = `id="${id}" class="${stateClasses('tb-node', type, state)}" data-node-id="${id}" data-node-type="${type}" data-tier="${tier}" data-hierarchy-level="${hierarchyLevel}" data-state="${stateAttribute}"${dataIdentity} role="button" aria-label="${accessibleLabel}" aria-pressed="false" tabindex="0"`;
  const x = formatNumber(node.x);
  const y = formatNumber(node.y);

  if (node.type === 'mutation') {
    const width = formatNumber(node.width);
    const height = formatNumber(node.height);
    const rectX = formatNumber(node.x - node.width / 2);
    const rectY = formatNumber(node.y - node.height / 2);
    const gateX = node.x - node.width / 2 + 32;
    const kindX = node.x + node.width / 2 - 32;
    const isSealed = state === 'complete';
    const gateGlyph = isSealed
      ? '<path class="tb-approval-gate__seal" d="M-7 0l4.5 4.5L7-6" fill="none" stroke="currentColor" />'
      : [
        '<g class="tb-approval-gate__shield" data-icon="shield"><path d="M0-12 10-8v7c0 6-4 10-10 13-6-3-10-7-10-13v-7Z" fill="none" stroke="currentColor" opacity=".28" /></g>',
        '<path class="tb-approval-gate__lock" d="M-6-1v-4a6 6 0 0 1 12 0v4M-8-1h16v12h-16Z" />',
        '<path class="tb-approval-gate__scan" d="M-14-13a20 20 0 0 1 28 0" fill="none" stroke="currentColor" />',
      ].join('');
    return [
      `<g ${common} data-gate="approval" data-approval-required="${isSealed ? 'false' : 'true'}">`,
      `<title>${label}: ${isSealed ? 'execution sealed' : 'approval required'}</title>`,
      `<rect class="tb-node__surface" x="${rectX}" y="${rectY}" width="${width}" height="${height}" rx="18" />`,
      `<g class="tb-approval-gate is-${stateAttribute}" data-gate="approval" data-icon="${isSealed ? 'approval-seal' : 'approval-lock'}" data-state="${stateAttribute}" data-center-x="${formatNumber(gateX)}" data-center-y="${y}" transform="translate(${formatNumber(gateX)} ${y})" aria-hidden="true">`,
      '<circle class="tb-approval-gate__ring" cx="0" cy="0" r="14" />',
      gateGlyph,
      '</g>',
      `<circle class="tb-mutation-kind__ring" data-center-x="${formatNumber(kindX)}" data-center-y="${y}" cx="${formatNumber(kindX)}" cy="${y}" r="14" />`,
      renderSemanticIcon(node, { x: kindX, y: node.y, scale: 0.68 }),
      `<text class="tb-node__label" x="${x}" y="${formatNumber(node.y + 5)}" text-anchor="middle">${label}</text>`,
      '</g>',
    ].join('');
  }

  if (node.type === 'hub') {
    const haloClass = state === 'complete' || state === 'quarantined'
      ? 'tb-node__halo is-static'
      : 'tb-node__halo';
    return [
      `<g ${common}>`,
      `<title>${label}: ${escapeSvgText(node.subtitle)}</title>`,
      `<circle class="${haloClass}" cx="${x}" cy="${y}" r="${formatNumber(node.radius + 14)}" />`,
      `<circle class="tb-node__surface" cx="${x}" cy="${y}" r="${formatNumber(node.radius)}" />`,
      renderSemanticIcon(node, { y: node.y - 19, scale: 1.02 }),
      `<text class="tb-node__label" x="${x}" y="${formatNumber(node.y + 13)}" text-anchor="middle">${label}</text>`,
      `<text class="tb-node__subtitle" x="${x}" y="${formatNumber(node.y + 30)}" text-anchor="middle">${escapeSvgText(node.subtitle)}</text>`,
      '</g>',
    ].join('');
  }

  if (node.type === 'provider') {
    const labelY = node.labelPlacement === 'above'
      ? node.y - node.radius - 12
      : node.y + node.radius + 20;
    return [
      `<g ${common} data-shape="origin-hexagon" data-label-placement="${escapeSvgAttribute(node.labelPlacement ?? 'below')}">`,
      `<title>${label}</title>`,
      `<circle class="tb-node__halo" cx="${x}" cy="${y}" r="${formatNumber(node.radius + 8)}" />`,
      `<path class="tb-node__surface" d="${regularPolygonPath(node.x, node.y, node.radius, 6)}" />`,
      renderSemanticIcon(node, { scale: 0.9 }),
      `<text class="tb-node__label" x="${x}" y="${formatNumber(labelY)}" text-anchor="middle">${label}</text>`,
      '</g>',
    ].join('');
  }

  return [
    `<g ${common} data-shape="capability-circle">`,
    `<title>${label}</title>`,
    `<circle class="tb-node__halo" cx="${x}" cy="${y}" r="${formatNumber(node.radius + 7)}" />`,
    `<circle class="tb-node__surface" cx="${x}" cy="${y}" r="${formatNumber(node.radius)}" />`,
    `<circle class="tb-node__capability-ring" cx="${x}" cy="${y}" r="${formatNumber(node.radius - 5)}" fill="none" stroke="currentColor" opacity=".18" />`,
    renderSemanticIcon(node, { scale: 0.72 }),
    `<text class="tb-node__label" x="${x}" y="${formatNumber(node.y + node.radius + 20)}" text-anchor="middle">${label}</text>`,
    '</g>',
  ].join('');
}

/** Render accessible SVG markup; no DOM or framework is required. */
export function renderConstellationSvg(layoutOrInput = {}, options = {}) {
  const layout = Array.isArray(layoutOrInput.nodes) && Array.isArray(layoutOrInput.edges)
    ? layoutOrInput
    : createConstellationLayout(layoutOrInput);
  const title = options.title ?? 'ToolBraid provider constellation';
  const description = options.description
    ?? 'Provider origins feed semantic capabilities into ToolBraid. Mutating actions remain behind human approval gates.';
  const prefix = semanticToken(options.idPrefix ?? 'toolbraid-constellation');
  const titleId = `${prefix}--title`;
  const descriptionId = `${prefix}--description`;
  const arrowMarkerId = `${prefix}--flow-arrow`;
  const nodes = [...layout.nodes].sort((a, b) => compareText(a.id, b.id));
  const edges = [...layout.edges].sort((a, b) => compareText(a.id, b.id));

  return [
    `<svg class="tb-constellation" xmlns="http://www.w3.org/2000/svg" viewBox="${escapeSvgAttribute(layout.viewBox)}" role="group" aria-labelledby="${titleId} ${descriptionId}" data-component="toolbraid-constellation">`,
    `<title id="${titleId}">${escapeSvgText(title)}</title>`,
    `<desc id="${descriptionId}">${escapeSvgText(description)}</desc>`,
    '<defs>',
    `<marker id="${arrowMarkerId}" class="tb-edge__arrow-marker" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto">`,
    '<path class="tb-edge__arrowhead" d="M0 0 8 4 0 8Z" fill="#579bc4" fill-opacity=".72" />',
    '</marker>',
    '</defs>',
    '<g class="tb-constellation__rings" aria-hidden="true">',
    `<circle class="orbit-ring outer" cx="${formatNumber(layout.center.x)}" cy="${formatNumber(layout.center.y)}" r="${formatNumber(layout.radii?.outer ?? 0)}" />`,
    `<circle class="orbit-ring inner" cx="${formatNumber(layout.center.x)}" cy="${formatNumber(layout.center.y)}" r="${formatNumber(layout.radii?.inner ?? 0)}" />`,
    '</g>',
    '<g class="tb-constellation__edges">',
    ...edges.map((edge) => renderEdge(edge, arrowMarkerId)),
    '</g>',
    '<g class="tb-constellation__nodes">',
    ...nodes.map(renderNode),
    '</g>',
    '</svg>',
  ].join('');
}
