import { sha256Hex, stableStringify } from './approval.js';

const GENESIS_HASH = '0'.repeat(64);

function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((entry) => entry === undefined ? null : jsonSafe(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, jsonSafe(child)]),
  );
}

function cloneJson(value) {
  return JSON.parse(stableStringify(jsonSafe(value)));
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Audit timestamp must be a valid date.');
  return date.toISOString();
}

function projection({ sequence, event, timestamp: occurredAt, details, previousHash }) {
  return { sequence, event, timestamp: occurredAt, details, previousHash };
}

export function computeAuditEntryHash(entry) {
  return sha256Hex(stableStringify(projection(entry)));
}

export function verifyAuditChain(entries) {
  if (!Array.isArray(entries)) return false;
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.sequence !== index + 1 || entry.previousHash !== previousHash) return false;
    if (entry.hash !== computeAuditEntryHash(entry)) return false;
    previousHash = entry.hash;
  }
  return true;
}

export function createAuditTrail({ now = () => new Date() } = {}) {
  const entries = [];
  let sealed = false;

  return Object.freeze({
    append(event, details = {}) {
      if (sealed) throw new Error('Audit trail is sealed.');
      if (typeof event !== 'string' || event.trim() === '') throw new TypeError('Audit event must be a non-empty string.');
      const entry = {
        sequence: entries.length + 1,
        event,
        timestamp: timestamp(now()),
        details: cloneJson(details),
        previousHash: entries.at(-1)?.hash ?? GENESIS_HASH,
      };
      entry.hash = computeAuditEntryHash(entry);
      const frozen = Object.freeze(entry);
      entries.push(frozen);
      return frozen;
    },
    entries() {
      return entries.map((entry) => structuredClone(entry));
    },
    head() {
      return entries.at(-1)?.hash ?? GENESIS_HASH;
    },
    seal() {
      sealed = true;
      return Object.freeze({
        algorithm: 'sha256-chain-v1',
        entries: entries.length,
        head: entries.at(-1)?.hash ?? GENESIS_HASH,
      });
    },
    get sealed() {
      return sealed;
    },
  });
}

export { GENESIS_HASH };
