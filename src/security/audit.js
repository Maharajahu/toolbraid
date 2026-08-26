import { canonicalHash, cloneCanonical } from "./canonical.js";
import { SecurityError } from "./errors.js";
import { redactSecrets } from "./redaction.js";

const ZERO_HASH = "0".repeat(64);

/**
 * In-memory append-only, hash-chained audit log.
 *
 * The log intentionally has no update or delete operation.  Returned records
 * are independent frozen copies, and each entry commits to the prior entry,
 * making accidental mutation or truncation detectable by verifyIntegrity().
 * A durable deployment can mirror append() to an append-only database while
 * retaining this same record format.
 */
export class AuditLog {
  #entries = [];
  #clock;
  #maxEntries;
  #lastHash = ZERO_HASH;
  #sink;

  constructor({ clock = () => Date.now(), maxEntries = Number.POSITIVE_INFINITY, sink } = {}) {
    if (typeof clock !== "function") throw new SecurityError("INVALID_AUDIT_OPTIONS", "clock must be a function.");
    if (!(maxEntries === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxEntries) && maxEntries > 0))) {
      throw new SecurityError("INVALID_AUDIT_OPTIONS", "maxEntries must be a positive safe integer.");
    }
    if (sink !== undefined && typeof sink !== "function") {
      throw new SecurityError("INVALID_AUDIT_OPTIONS", "sink must be a function.");
    }
    this.#clock = clock;
    this.#maxEntries = maxEntries;
    this.#sink = sink;
  }

  /**
   * Append either `append("event.type", details)` or
   * `append({ type: "event.type", ...details })`.
   */
  append(eventOrType, details = {}) {
    const event = normalizeEvent(eventOrType, details);
    if (this.#entries.length >= this.#maxEntries) {
      throw new SecurityError("AUDIT_LOG_FULL", "Audit log append limit reached.");
    }

    const timestamp = auditTimestamp(this.#clock());
    const redacted = redactSecrets(event);
    // Sequence, timestamps and chain fields are server-owned and cannot be
    // supplied by a caller through event details.
    delete redacted.sequence;
    delete redacted.timestamp;
    delete redacted.previousHash;
    delete redacted.entryHash;

    const sequence = this.#entries.length + 1;
    const material = {
      sequence,
      timestamp,
      event: redacted,
      previousHash: this.#lastHash,
    };
    const entryHash = canonicalHash(material);
    const record = deepFreeze({
      ...redacted,
      sequence,
      timestamp,
      previousHash: this.#lastHash,
      entryHash,
    });

    // Push before notifying a sink: the local append remains authoritative if
    // a telemetry sink is unavailable.  A sink receives a detached copy and
    // cannot mutate the chain.
    this.#entries.push(record);
    this.#lastHash = entryHash;
    if (this.#sink) {
      try {
        this.#sink(cloneCanonical(record));
      } catch {
        // Audit transport is best effort; failures must not roll back or
        // corrupt the append-only local record.
      }
    }
    return deepFreeze(cloneCanonical(record));
  }

  get length() {
    return this.#entries.length;
  }

  get lastHash() {
    return this.#lastHash;
  }

  /** Return detached records so callers cannot mutate the internal log. */
  entries() {
    return this.#entries.map((entry) => deepFreeze(cloneCanonical(entry)));
  }

  /** Alias for integrations that use a snapshot terminology. */
  snapshot() {
    return this.entries();
  }

  /**
   * Verify sequence numbers, previous-hash links and entry hashes.  This does
   * not trust fields from the returned snapshot and recomputes every digest.
   */
  verifyIntegrity() {
    let previousHash = ZERO_HASH;
    for (let index = 0; index < this.#entries.length; index += 1) {
      const record = this.#entries[index];
      if (record.sequence !== index + 1 || record.previousHash !== previousHash) return false;
      const { entryHash, sequence, timestamp, previousHash: prior, ...event } = record;
      const expected = canonicalHash({ sequence, timestamp, event, previousHash: prior });
      if (entryHash !== expected) return false;
      previousHash = entryHash;
    }
    return previousHash === this.#lastHash;
  }
}

export const AppendOnlyAuditLog = AuditLog;

function normalizeEvent(eventOrType, details) {
  let event;
  if (typeof eventOrType === "string") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(eventOrType)) {
      throw new SecurityError("INVALID_AUDIT_EVENT", "Audit event type is invalid.");
    }
    if (details === null || typeof details !== "object" || Array.isArray(details)) {
      throw new SecurityError("INVALID_AUDIT_EVENT", "Audit event details must be an object.");
    }
    event = { ...details, type: eventOrType };
  } else {
    if (eventOrType === null || typeof eventOrType !== "object" || Array.isArray(eventOrType)) {
      throw new SecurityError("INVALID_AUDIT_EVENT", "Audit event must be an object.");
    }
    event = { ...eventOrType };
    if (typeof event.type !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(event.type)) {
      throw new SecurityError("INVALID_AUDIT_EVENT", "Audit event type is invalid.");
    }
  }
  return event;
}

function auditTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new SecurityError("INVALID_AUDIT_OPTIONS", "clock must return a non-negative timestamp.");
  }
  return Math.floor(timestamp);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
