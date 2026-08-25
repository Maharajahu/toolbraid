const REGISTRY_KEY = '__toolbraid_webmcp_registry_v1__';
const FRAME_ID_KEY = '__toolbraid_webmcp_frame_id_v1__';

function randomId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function rootWindow() {
  try {
    void window.top.location.origin;
    return window.top;
  } catch {
    return window;
  }
}

function registry() {
  const root = rootWindow();
  if (!root[REGISTRY_KEY]) {
    Object.defineProperty(root, REGISTRY_KEY, {
      value: { tools: new Map(), contexts: new Set() },
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return root[REGISTRY_KEY];
}

function frameId() {
  if (!window[FRAME_ID_KEY]) {
    Object.defineProperty(window, FRAME_ID_KEY, {
      value: randomId(window === rootWindow() ? 'root' : 'frame'),
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return window[FRAME_ID_KEY];
}

function ensureValidTool(tool) {
  if (!tool || typeof tool !== 'object') throw new TypeError('Tool definition must be an object.');
  if (!tool.name || typeof tool.name !== 'string') throw new TypeError('Tool name is required.');
  if (!tool.description || typeof tool.description !== 'string') throw new TypeError('Tool description is required.');
  if (typeof tool.execute !== 'function') throw new TypeError('Tool execute callback is required.');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) throw new TypeError(`Invalid WebMCP tool name: ${tool.name}`);
}

function asRegisteredTool(record) {
  const registered = {
    name: record.definition.name,
    title: record.definition.title ?? record.definition.name,
    description: record.definition.description,
    inputSchema: JSON.stringify(record.definition.inputSchema ?? { type: 'object', properties: {} }),
    annotations: record.definition.annotations ?? null,
    origin: record.origin,
  };
  Object.defineProperties(registered, {
    __toolbraidKey: { value: record.key, enumerable: false },
    __toolbraidOwner: { value: record.ownerId, enumerable: false },
  });
  return registered;
}

class LocalModelContext extends EventTarget {
  constructor(ownerDocument) {
    super();
    this.ownerDocument = ownerDocument;
    this.localKeys = new Set();
    this.ontoolchange = null;
    registry().contexts.add(this);
  }

  async registerTool(tool, options = {}) {
    ensureValidTool(tool);
    const ownerId = frameId();
    const key = `${ownerId}:${tool.name}`;
    const store = registry();
    if (store.tools.has(key)) throw new DOMException(`Tool already registered: ${tool.name}`, 'InvalidStateError');

    const record = {
      key,
      ownerId,
      ownerWindow: window,
      ownerDocument: this.ownerDocument,
      origin: location.origin,
      definition: tool,
      exposedTo: [...(options.exposedTo ?? [])],
    };
    store.tools.set(key, record);
    this.localKeys.add(key);

    const unregister = () => {
      if (!store.tools.delete(key)) return;
      this.localKeys.delete(key);
      notifyToolChange();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        unregister();
        throw options.signal.reason ?? new DOMException('Registration aborted', 'AbortError');
      }
      options.signal.addEventListener('abort', unregister, { once: true });
    }
    notifyToolChange();
  }

  async getTools(options = {}) {
    const requestedOrigins = new Set(options.fromOrigins ?? []);
    const callerOrigin = location.origin;
    return [...registry().tools.values()]
      .filter((record) => {
        if (record.origin === callerOrigin) return true;
        if (requestedOrigins.has(record.origin) && record.exposedTo.includes(callerOrigin)) return true;
        return false;
      })
      .map(asRegisteredTool);
  }

  async executeTool(tool, inputObject = {}, options = {}) {
    const store = registry();
    const key = tool?.__toolbraidKey;
    let record = key ? store.tools.get(key) : null;
    if (!record && tool?.name) {
      const matches = [...store.tools.values()].filter((candidate) => candidate.definition.name === tool.name);
      if (matches.length === 1) record = matches[0];
    }
    if (!record) throw new DOMException(`Tool not found: ${tool?.name ?? 'unknown'}`, 'NotFoundError');
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Execution aborted', 'AbortError');

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await record.definition.execute.call(record.ownerWindow, inputObject, { signal: controller.signal });
      return JSON.stringify(result ?? null);
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

function notifyToolChange() {
  for (const context of registry().contexts) {
    queueMicrotask(() => {
      const event = new Event('toolchange');
      context.dispatchEvent(event);
      if (typeof context.ontoolchange === 'function') context.ontoolchange(event);
    });
  }
}

export function ensureModelContext() {
  const nativeContext = document.modelContext;
  if (nativeContext
      && typeof nativeContext.registerTool === 'function'
      && typeof nativeContext.getTools === 'function'
      && typeof nativeContext.executeTool === 'function') {
    return { context: nativeContext, mode: 'native' };
  }

  const context = new LocalModelContext(document);
  Object.defineProperty(document, 'modelContext', {
    value: context,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return { context, mode: 'polyfill' };
}

export function createWebMcpRuntime() {
  const { context, mode } = ensureModelContext();
  return {
    mode,
    context,
    registerTool(tool, options = {}) {
      // Keep the native call explicit so WebMCP usage is auditable in source.
      if (mode === 'native') return document.modelContext.registerTool(tool, options);
      return context.registerTool(tool, options);
    },
    async getTools(options = {}) {
      return context.getTools(options);
    },
    executeTool(tool, input = {}, options = {}) {
      return context.executeTool(tool, input, options);
    },
    async waitForTools({ minimum = 1, timeout = 5000, predicate = () => true } = {}) {
      const started = performance.now();
      while (performance.now() - started < timeout) {
        const tools = (await context.getTools()).filter(predicate);
        if (tools.length >= minimum) return tools;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return (await context.getTools()).filter(predicate);
    },
  };
}

export function resetLocalWebMcpRegistryForTests() {
  const store = registry();
  store.tools.clear();
  notifyToolChange();
}
