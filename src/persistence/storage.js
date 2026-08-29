function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createMemoryKeyValueStore(initial = {}) {
  const values = new Map(Object.entries(clone(initial)));
  return Object.freeze({
    async get(key) {
      return clone(values.get(String(key)));
    },
    async set(key, value) {
      values.set(String(key), clone(value));
    },
    async remove(key) {
      values.delete(String(key));
    },
    async keys() {
      return Object.freeze([...values.keys()]);
    },
  });
}
export function createChromeStorageAdapter(area) {
  if (!area || typeof area.get !== 'function' || typeof area.set !== 'function' || typeof area.remove !== 'function') {
    throw new TypeError('A chrome.storage area with get(), set(), and remove() is required.');
  }
  return Object.freeze({
    async get(key) {
      const result = await area.get(String(key));
      return clone(result?.[String(key)]);
    },
    async set(key, value) {
      await area.set({ [String(key)]: clone(value) });
    },
    async remove(key) {
      await area.remove(String(key));
    },
  });
}

export function createNamespacedStore(store, namespace) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function' || typeof store.remove !== 'function') {
    throw new TypeError('store must implement get(), set(), and remove().');
  }
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(namespace ?? '')) throw new TypeError('Storage namespace is invalid.');
  const key = (value) => `${namespace}:${String(value)}`;
  return Object.freeze({
    get(name) { return store.get(key(name)); },
    set(name, value) { return store.set(key(name), value); },
    remove(name) { return store.remove(key(name)); },
  });
}
