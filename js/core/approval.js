function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : stableStringify(value));
  const words = [];
  const bitLength = bytes.length * 8;
  for (let index = 0; index < bytes.length; index += 1) words[index >> 2] |= bytes[index] << (24 - (index % 4) * 8);
  words[bitLength >> 5] |= 0x80 << (24 - bitLength % 32);
  words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const rotateRight = (number, amount) => (number >>> amount) | (number << (32 - amount));
  const schedule = new Array(64);
  for (let offset = 0; offset < words.length; offset += 16) {
    for (let index = 0; index < 64; index += 1) {
      if (index < 16) schedule[index] = words[offset + index] | 0;
      else {
        const x = schedule[index - 15];
        const y = schedule[index - 2];
        const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
        const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
        schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) | 0;
      }
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e,6) ^ rotateRight(e,11) ^ rotateRight(e,25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choice + constants[index] + schedule[index]) | 0;
      const bigSigma0 = rotateRight(a,2) ^ rotateRight(a,13) ^ rotateRight(a,22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) | 0;
      h=g; g=f; f=e; e=(d+temp1)|0; d=c; c=b; b=a; a=(temp1+temp2)|0;
    }
    hash[0]=(hash[0]+a)|0; hash[1]=(hash[1]+b)|0; hash[2]=(hash[2]+c)|0; hash[3]=(hash[3]+d)|0;
    hash[4]=(hash[4]+e)|0; hash[5]=(hash[5]+f)|0; hash[6]=(hash[6]+g)|0; hash[7]=(hash[7]+h)|0;
  }
  return hash.map((number) => (number >>> 0).toString(16).padStart(8, '0')).join('');
}

function approvalError(message, code = 'APPROVAL_INVALID', details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function planProjection(plan) {
  return {
    id: plan.id,
    createdAt: plan.createdAt,
    mission: {
      goal: plan.mission?.goal,
      origin: plan.mission?.origin,
      destination: plan.mission?.destination,
      destinationAddress: plan.mission?.destinationAddress,
      date: plan.mission?.date,
      budget: plan.mission?.budget,
      currency: plan.mission?.currency,
      passengers: plan.mission?.passengers,
      nights: plan.mission?.nights,
    },
    nodes: plan.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      capabilityId: node.capabilityId ?? null,
      operation: node.operation ?? null,
      tool: node.mapping?.tool?.name ?? null,
      alternatives: (node.alternatives ?? []).map((mapping) => mapping.tool.name),
      dependencies: [...node.dependencies],
      risk: node.risk,
      approvalRequired: node.approvalRequired,
    })),
  };
}

export function actionBinding(node, recommendation) {
  if (!node?.approvalRequired) throw approvalError(`Node ${node?.id ?? 'unknown'} is not approval-gated.`, 'APPROVAL_SCOPE_INVALID');
  const base = {
    nodeId: node.id,
    capabilityId: node.capabilityId,
    tool: node.mapping?.tool?.name,
    provider: String(node.mapping?.tool?.name ?? '').split('.')[0],
    risk: node.risk,
  };
  if (node.id === 'travel-hold') {
    return { ...base, selectedOption: { id: recommendation?.travel?.id, provider: recommendation?.travel?.provider, price: recommendation?.travel?.price, currency: recommendation?.currency ?? 'GBP' } };
  }
  if (node.id === 'stay-hold') {
    return { ...base, selectedOption: { id: recommendation?.stay?.id, provider: recommendation?.stay?.provider, label: recommendation?.stay?.label, price: recommendation?.stay?.price, currency: recommendation?.currency ?? 'GBP' } };
  }
  return { ...base, selectedOption: null };
}

async function buildFingerprints(plan, recommendation, actionIds) {
  const uniqueIds = [...new Set(actionIds)].sort();
  const actionFingerprints = [];
  for (const actionId of uniqueIds) {
    const node = plan.nodes.find((candidate) => candidate.id === actionId);
    if (!node) throw approvalError(`Approval references unknown plan node: ${actionId}`, 'APPROVAL_SCOPE_INVALID', { actionId });
    const binding = actionBinding(node, recommendation);
    actionFingerprints.push({ actionId, binding, fingerprint: await sha256Hex(binding) });
  }
  return { actionIds: uniqueIds, planFingerprint: await sha256Hex(planProjection(plan)), actionFingerprints };
}

export async function createApprovalRecord({ plan, recommendation, actionIds, channel = 'human-ui', now = new Date() }) {
  if (!plan || !Array.isArray(actionIds) || !actionIds.length) throw approvalError('A plan and at least one action are required.', 'APPROVAL_SCOPE_INVALID');
  const fingerprints = await buildFingerprints(plan, recommendation, actionIds);
  const record = {
    version: 1,
    source: 'human',
    channel,
    actionIds: fingerprints.actionIds,
    planFingerprint: fingerprints.planFingerprint,
    actionFingerprints: fingerprints.actionFingerprints,
    approvedAt: now.toISOString(),
    nonce: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    consumedAt: null,
  };
  record.recordFingerprint = await sha256Hex({ version: record.version, source: record.source, channel: record.channel, actionIds: record.actionIds, planFingerprint: record.planFingerprint, actionFingerprints: record.actionFingerprints, approvedAt: record.approvedAt, nonce: record.nonce });
  return record;
}

export async function verifyApprovalRecord(record, { plan, recommendation, expectedActionIds = null } = {}) {
  if (!record || record.version !== 1 || record.source !== 'human') throw approvalError('No valid human approval record exists.');
  if (record.consumedAt) throw approvalError('This approval has already been consumed.', 'APPROVAL_REPLAY_BLOCKED');
  const fingerprints = await buildFingerprints(plan, recommendation, record.actionIds);
  if (fingerprints.planFingerprint !== record.planFingerprint) throw approvalError('The plan changed after approval.', 'APPROVAL_PLAN_MISMATCH');
  const expectedById = new Map(fingerprints.actionFingerprints.map((entry) => [entry.actionId, entry.fingerprint]));
  for (const entry of record.actionFingerprints ?? []) {
    if (expectedById.get(entry.actionId) !== entry.fingerprint) throw approvalError(`Approved action changed after approval: ${entry.actionId}`, 'APPROVAL_ACTION_MISMATCH', { actionId: entry.actionId });
  }
  if ((record.actionFingerprints ?? []).length !== fingerprints.actionFingerprints.length) throw approvalError('Approval action set is incomplete.', 'APPROVAL_ACTION_MISMATCH');
  if (expectedActionIds) {
    const actual = [...record.actionIds].sort();
    const expected = [...new Set(expectedActionIds)].sort();
    if (stableStringify(actual) !== stableStringify(expected)) throw approvalError('Approved nodes do not match the execution request.', 'APPROVAL_SCOPE_INVALID', { actual, expected });
  }
  const recordFingerprint = await sha256Hex({ version: record.version, source: record.source, channel: record.channel, actionIds: record.actionIds, planFingerprint: record.planFingerprint, actionFingerprints: record.actionFingerprints, approvedAt: record.approvedAt, nonce: record.nonce });
  if (recordFingerprint !== record.recordFingerprint) throw approvalError('The approval record was modified.', 'APPROVAL_RECORD_TAMPERED');
  return true;
}

export async function consumeApprovalRecord(record, context, now = new Date()) {
  await verifyApprovalRecord(record, context);
  return { ...record, consumedAt: now.toISOString() };
}
