export class AuditLog {
  #entries = [];
  #listeners = new Set();

  add(event, details = {}) {
    const entry = {
      id: `audit-${this.#entries.length + 1}`,
      timestamp: new Date().toISOString(),
      event,
      details,
    };
    this.#entries.push(entry);
    for (const listener of this.#listeners) listener(entry, this.entries());
    return entry;
  }

  entries() {
    return this.#entries.map((entry) => structuredClone(entry));
  }

  clear() {
    this.#entries = [];
    for (const listener of this.#listeners) listener(null, []);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
