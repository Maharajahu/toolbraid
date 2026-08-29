import {
  claimApprovalEnvelopeSet,
  sha256Hex,
  stableStringify,
  verifyApprovalEnvelope,
} from '../engine/approval.js';

export class PersistentApprovalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PersistentApprovalError';
    this.code = code;
    this.details = details;
  }
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Approval ledger timestamp must be a valid date.');
  return date.toISOString();
}

function claimProjection(claim) {
  return {
    version: claim.version,
    nonce: claim.nonce,
    fingerprint: claim.fingerprint,
    planId: claim.planId,
    planRevision: claim.planRevision,
    nodeId: claim.nodeId,
    claimedAt: claim.claimedAt,
    expiresAt: claim.expiresAt,
  };
}

function checksum(claim) {
  return sha256Hex(stableStringify(claimProjection(claim)));
}

function emptyRecord() {
  return { version: 1, generation: 0, claims: {} };
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function validateRecord(record, key, maxClaims = Number.MAX_SAFE_INTEGER) {
  if (!plainRecord(record) || record.version !== 1 || !Number.isInteger(record.generation)
    || !plainRecord(record.claims)) {
    throw new PersistentApprovalError('APPROVAL_LEDGER_INVALID', `Persistent approval ledger is invalid: ${key}`);
  }
  let entries;
  try {
    entries = Object.entries(record.claims);
  } catch {
    throw new PersistentApprovalError('APPROVAL_LEDGER_INVALID', `Persistent approval ledger is invalid: ${key}`);
  }
  if (entries.length > maxClaims) {
    throw new PersistentApprovalError('APPROVAL_LEDGER_CAPACITY_EXCEEDED', `Approval ledger reached ${maxClaims} claims.`);
  }
  for (const [nonce, claim] of entries) {
    if (RESERVED_KEYS.has(nonce)) {
      throw new PersistentApprovalError('APPROVAL_LEDGER_INVALID', `Persistent approval nonce is reserved: ${nonce}`);
    }
    const expiresAt = Date.parse(claim?.expiresAt);
    if (!claim || claim.nonce !== nonce || !Number.isFinite(expiresAt)
      || new Date(expiresAt).toISOString() !== claim.expiresAt
      || claim.checksum !== checksum(claim)) {
      throw new PersistentApprovalError('APPROVAL_LEDGER_TAMPERED', `Persistent approval claim verification failed: ${nonce}`);
    }
  }
  return record;
}

function pruneExpiredClaims(record, cutoff) {
  const cutoffMs = Date.parse(timestamp(cutoff));
  let removed = 0;
  for (const [nonce, claim] of Object.entries(record.claims)) {
    if (Date.parse(claim.expiresAt) <= cutoffMs) {
      delete record.claims[nonce];
      removed += 1;
    }
  }
  if (removed > 0) record.generation += 1;
  return removed;
}

export async function createPersistentApprovalLedger({
  store,
  key = 'toolbraid:approval-ledger',
  now = () => new Date(),
  maxClaims = 10_000,
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('Persistent approval store must implement get() and set().');
  }
  if (typeof key !== 'string' || key.trim() === '') throw new TypeError('Persistent approval ledger key is required.');
  if (!Number.isInteger(maxClaims) || maxClaims < 1) throw new RangeError('maxClaims must be a positive integer.');

  const initial = await store.get(key);
  if (initial === undefined) await store.set(key, emptyRecord());
  else {
    validateRecord(initial, key);
    const removed = pruneExpiredClaims(initial, now());
    validateRecord(initial, key, maxClaims);
    if (removed > 0) await store.set(key, initial);
  }

  let tail = Promise.resolve();
  function exclusive(operation) {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function load() {
    return validateRecord((await store.get(key)) ?? emptyRecord(), key);
  }

  return Object.freeze({
    key,
    async claim(envelope, expected, options = {}) {
      const receipts = await this.claimSet([{ envelope, expected }], options);
      return receipts[0];
    },
    async claimSet(requests, options = {}) {
      return exclusive(async () => {
        if (!Array.isArray(requests) || requests.length === 0) {
          throw new PersistentApprovalError('APPROVAL_SET_INVALID', 'Approval claim set must be a non-empty array.');
        }
        const claimedAt = timestamp(options.now ?? now());
        const nonces = new Set();
        for (const [index, request] of requests.entries()) {
          if (!request || typeof request !== 'object') throw new PersistentApprovalError('APPROVAL_SET_INVALID', 'Approval request is invalid.', { index });
          if (!request.envelope || typeof request.envelope.nonce !== 'string') {
            throw new PersistentApprovalError('APPROVAL_SET_INVALID', 'Approval envelope nonce is invalid.', { index });
          }
          if (RESERVED_KEYS.has(request.envelope.nonce)) {
            throw new PersistentApprovalError('APPROVAL_NONCE_INVALID', 'Approval envelope nonce is reserved.', {
              nonce: request.envelope.nonce,
            });
          }
          if (nonces.has(request.envelope.nonce)) {
            throw new PersistentApprovalError('APPROVAL_DUPLICATE_NONCE', 'Approval nonce appears twice in the claim set.', { nonce: request.envelope.nonce });
          }
          nonces.add(request.envelope.nonce);
        }

        const record = await load();
        pruneExpiredClaims(record, claimedAt);
        for (const request of requests) {
          const existing = record.claims[request.envelope.nonce];
          if (existing) {
            throw new PersistentApprovalError('APPROVAL_REPLAY_PERSISTED', 'Approval nonce was already consumed in persistent storage.', {
              nonce: request.envelope.nonce,
              firstClaim: structuredClone(existing),
            });
          }
        }
        if (Object.keys(record.claims).length + requests.length > maxClaims) {
          throw new PersistentApprovalError('APPROVAL_LEDGER_CAPACITY_EXCEEDED', `Approval ledger reached ${maxClaims} claims.`);
        }
        for (const request of requests) {
          verifyApprovalEnvelope(request.envelope, request.expected, { now: claimedAt });
        }

        const persisted = requests.map(({ envelope }) => {
          const claim = {
            version: envelope.version,
            nonce: envelope.nonce,
            fingerprint: envelope.fingerprint,
            planId: envelope.planId,
            planRevision: envelope.planRevision,
            nodeId: envelope.nodeId,
            claimedAt,
            expiresAt: envelope.expiresAt,
          };
          claim.checksum = checksum(claim);
          return Object.freeze(claim);
        });

        for (const claim of persisted) record.claims[claim.nonce] = structuredClone(claim);
        record.generation += 1;
        await store.set(key, record);

        // Persistence happens before the in-realm claim. If the runtime claim
        // fails, the nonce deliberately remains consumed in durable storage.
        claimApprovalEnvelopeSet(requests, { now: claimedAt });
        return Object.freeze(persisted.map((claim) => Object.freeze(structuredClone(claim))));
      });
    },
    async has(nonce, options = {}) {
      return exclusive(async () => {
        const record = await load();
        if (pruneExpiredClaims(record, options.now ?? now()) > 0) await store.set(key, record);
        return Object.hasOwn(record.claims, String(nonce));
      });
    },
    async claims(options = {}) {
      return exclusive(async () => {
        const record = await load();
        if (pruneExpiredClaims(record, options.now ?? now()) > 0) await store.set(key, record);
        return Object.freeze(Object.values(record.claims).map((claim) => Object.freeze(structuredClone(claim))));
      });
    },
    async verify() {
      await tail;
      try {
        validateRecord(await store.get(key), key);
        return true;
      } catch (error) {
        if (error instanceof PersistentApprovalError) return false;
        throw error;
      }
    },
  });
}
