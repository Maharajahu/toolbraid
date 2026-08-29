import {
  GENESIS_HASH,
  computeAuditEntryHash,
  verifyAuditChain,
} from '../engine/audit.js';
import { stableStringify } from '../engine/approval.js';

export class PersistentAuditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PersistentAuditError';
    this.code = code;
    this.details = details;
  }
}

function cloneJson(value) {
  return JSON.parse(stableStringify(value ?? null));
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Audit timestamp must be a valid date.');
  return date.toISOString();
}

function emptyRecord() {
  return { version: 1, entries: [], seal: null };
}

function validateRecord(record, key) {
  if (!record || typeof record !== 'object' || record.version !== 1 || !Array.isArray(record.entries)) {
    throw new PersistentAuditError('AUDIT_RECORD_INVALID', `Persistent audit record is invalid: ${key}`);
  }
  if (!verifyAuditChain(record.entries)) {
    throw new PersistentAuditError('AUDIT_CHAIN_TAMPERED', `Persistent audit chain verification failed: ${key}`);
  }
  if (record.seal !== null) {
    const expected = {
      algorithm: 'sha256-chain-v1',
      entries: record.entries.length,
      head: record.entries.at(-1)?.hash ?? GENESIS_HASH,
    };
    if (stableStringify(record.seal) !== stableStringify(expected)) {
      throw new PersistentAuditError('AUDIT_SEAL_INVALID', `Persistent audit seal verification failed: ${key}`);
    }
  }
  return record;
}

export async function createPersistentAuditTrail({
  store,
  key,
  now = () => new Date(),
  maxEntries = 10_000,
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('Persistent audit store must implement get() and set().');
  }
  if (typeof key !== 'string' || key.trim() === '') throw new TypeError('Persistent audit key is required.');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer.');

  const stored = await store.get(key);
  if (stored === undefined) await store.set(key, emptyRecord());
  else validateRecord(stored, key);

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
    async append(event, details = {}) {
      return exclusive(async () => {
        if (typeof event !== 'string' || event.trim() === '') throw new TypeError('Audit event must be a non-empty string.');
        const record = await load();
        if (record.seal) throw new PersistentAuditError('AUDIT_ALREADY_SEALED', 'Persistent audit trail is sealed.');
        if (record.entries.length >= maxEntries) {
          throw new PersistentAuditError('AUDIT_CAPACITY_EXCEEDED', `Persistent audit trail reached ${maxEntries} entries.`);
        }
        const entry = {
          sequence: record.entries.length + 1,
          event,
          timestamp: isoTimestamp(now()),
          details: cloneJson(details),
          previousHash: record.entries.at(-1)?.hash ?? GENESIS_HASH,
        };
        entry.hash = computeAuditEntryHash(entry);
        record.entries.push(entry);
        await store.set(key, record);
        return Object.freeze(structuredClone(entry));
      });
    },
    async entries() {
      await tail;
      return structuredClone((await load()).entries);
    },
    async head() {
      await tail;
      const record = await load();
      return record.entries.at(-1)?.hash ?? GENESIS_HASH;
    },
    async status() {
      await tail;
      const record = await load();
      return Object.freeze({
        sealed: record.seal !== null,
        entries: record.entries.length,
        head: record.entries.at(-1)?.hash ?? GENESIS_HASH,
      });
    },
    async seal() {
      return exclusive(async () => {
        const record = await load();
        if (record.seal) return Object.freeze(structuredClone(record.seal));
        record.seal = {
          algorithm: 'sha256-chain-v1',
          entries: record.entries.length,
          head: record.entries.at(-1)?.hash ?? GENESIS_HASH,
        };
        await store.set(key, record);
        return Object.freeze(structuredClone(record.seal));
      });
    },
    async verify() {
      await tail;
      try {
        validateRecord(await store.get(key), key);
        return true;
      } catch (error) {
        if (error instanceof PersistentAuditError) return false;
        throw error;
      }
    },
  });
}
