const REGISTERED_TOOL_TOKEN = Symbol('toolbraid.registeredTool');

export class WebMcpError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WebMcpError';
    this.code = code;
    this.details = details;
  }
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    throw new WebMcpError('WEBMCP_ORIGIN_INVALID', `Invalid WebMCP origin: ${value}`);
  }
}

function normalizeOriginSet(origins) {
  return new Set((origins ?? []).map(normalizeOrigin));
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function validateToolDefinition(tool) {
  if (!tool || typeof tool !== 'object') throw new TypeError('Tool definition must be an object.');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name ?? '')) throw new TypeError(`Invalid WebMCP tool name: ${tool.name ?? ''}`);
  if (typeof tool.description !== 'string' || tool.description.length === 0) throw new TypeError('Tool description is required.');
  if (typeof tool.execute !== 'function') throw new TypeError('Tool execute callback is required.');
}

function validateRegisteredTool(tool, allowedOrigins) {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || typeof tool.origin !== 'string') {
    throw new WebMcpError('WEBMCP_TOOL_INVALID', 'WebMCP returned an invalid RegisteredTool.');
  }
  const origin = normalizeOrigin(tool.origin);
  if (origin !== tool.origin || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
    throw new WebMcpError('WEBMCP_TOOL_INVALID', 'WebMCP returned a non-canonical tool identity.', {
      origin: tool.origin,
      tool: tool.name,
    });
  }
  if ((tool.title !== undefined && typeof tool.title !== 'string') || typeof tool.description !== 'string') {
    throw new WebMcpError('WEBMCP_TOOL_INVALID', 'WebMCP returned invalid primitive metadata.', {
      origin,
      tool: tool.name,
    });
  }
  if (!allowedOrigins.has(origin)) {
    throw new WebMcpError('WEBMCP_ORIGIN_DENIED', `Tool origin is not allowed: ${origin}`, { origin, tool: tool.name });
  }
  return origin;
}

function parseNativeResult(serialized, tool) {
  if (typeof serialized !== 'string') {
    throw new WebMcpError('WEBMCP_RESULT_INVALID', 'Native executeTool() did not return a serialized JSON string.', {
      origin: tool.origin,
      tool: tool.name,
    });
  }
  try {
    return JSON.parse(serialized);
  } catch (cause) {
    throw new WebMcpError('WEBMCP_RESULT_INVALID', 'Native executeTool() returned invalid JSON.', {
      origin: tool.origin,
      tool: tool.name,
      cause: String(cause),
    });
  }
}

function isLegacyChromeInputSerializationError(error) {
  return error?.name === 'UnknownError'
    && error?.message === 'Failed to parse input arguments';
}

function createClient({ context, allowedOrigins, mode, callerOrigin = null, includeCallerOrigin = false }) {
  const requestedOrigins = normalizeOriginSet(allowedOrigins);
  const allowed = new Set(requestedOrigins);
  if (includeCallerOrigin && callerOrigin) allowed.add(normalizeOrigin(callerOrigin));
  const liveHandles = new WeakSet();
  let generation = 0;
  const listeners = new Set();

  const handleToolChange = (event) => {
    generation += 1;
    for (const listener of listeners) listener({ generation, event });
  };
  context.addEventListener?.('toolchange', handleToolChange);

  return Object.freeze({
    mode,
    allowedOrigins: Object.freeze([...requestedOrigins]),
    get generation() {
      return generation;
    },
    async discover() {
      const tools = await context.getTools({ fromOrigins: [...requestedOrigins] });
      const accepted = [];
      for (const tool of tools) {
        validateRegisteredTool(tool, allowed);
        liveHandles.add(tool);
        accepted.push(tool);
      }
      return accepted;
    },
    async execute(tool, input = {}, options = {}) {
      if (!tool || typeof tool !== 'object' || !liveHandles.has(tool)) {
        throw new WebMcpError('WEBMCP_HANDLE_REQUIRED', 'Execution requires the live RegisteredTool returned by discover().');
      }
      validateRegisteredTool(tool, allowed);
      let serialized;
      try {
        serialized = await context.executeTool(tool, input, options);
      } catch (error) {
        // Chrome's first experimental executeTool implementation predates the
        // object-input WebIDL and still expects a JSON string. Retry only its
        // exact pre-dispatch parse failure; every other execution error remains
        // fail-closed and is never replayed.
        if (mode !== 'native' || !isLegacyChromeInputSerializationError(error)) throw error;
        serialized = await context.executeTool(tool, JSON.stringify(input), options);
      }
      return parseNativeResult(serialized, tool);
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Tool-change listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      context.removeEventListener?.('toolchange', handleToolChange);
    },
  });
}

export function createNativeWebMcpClient({
  documentRef = globalThis.document,
  allowedOrigins = [],
  includeCallerOrigin = false,
} = {}) {
  const context = documentRef?.modelContext;
  if (!context
      || typeof context.registerTool !== 'function'
      || typeof context.getTools !== 'function'
      || typeof context.executeTool !== 'function') {
    throw new WebMcpError(
      'WEBMCP_UNSUPPORTED',
      'This build requires the standards-track document.modelContext WebMCP API.',
    );
  }
  const callerOrigin = documentRef?.location?.origin ?? globalThis.location?.origin ?? null;
  return createClient({ context, allowedOrigins, mode: 'native', callerOrigin, includeCallerOrigin });
}

class InMemoryModelContext extends EventTarget {
  constructor(hub, origin, ownerId) {
    super();
    this.hub = hub;
    this.origin = normalizeOrigin(origin);
    this.ownerId = ownerId;
    this.ownerWindow = Object.freeze({ origin: this.origin, ownerId });
  }

  async registerTool(tool, options = {}) {
    validateToolDefinition(tool);
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Registration aborted.', 'AbortError');
    }

    const key = `${this.ownerId}\u0000${tool.name}`;
    if (this.hub.records.has(key)) throw new DOMException(`Tool already registered: ${tool.name}`, 'InvalidStateError');

    const record = {
      key,
      generation: this.hub.nextGeneration(),
      ownerId: this.ownerId,
      ownerWindow: this.ownerWindow,
      origin: this.origin,
      exposedTo: normalizeOriginSet(options.exposedTo ?? []),
      definition: tool,
      abortSignal: options.signal ?? null,
    };
    this.hub.records.set(key, record);

    const unregister = () => {
      if (this.hub.records.get(key) !== record) return;
      this.hub.records.delete(key);
      this.hub.notifyToolChange();
    };
    options.signal?.addEventListener('abort', unregister, { once: true });
    this.hub.notifyToolChange();
  }

  async getTools(options = {}) {
    const requested = normalizeOriginSet(options.fromOrigins ?? []);
    return [...this.hub.records.values()]
      .filter((record) => {
        if (record.origin === this.origin) return true;
        return requested.has(record.origin) && record.exposedTo.has(this.origin);
      })
      .map((record) => {
        const registered = {
          name: record.definition.name,
          title: record.definition.title ?? record.definition.name,
          description: record.definition.description,
          inputSchema: clone(record.definition.inputSchema ?? { type: 'object', properties: {} }),
          window: record.ownerWindow,
          origin: record.origin,
          annotations: clone(record.definition.annotations ?? null),
        };
        Object.defineProperty(registered, REGISTERED_TOOL_TOKEN, {
          value: Object.freeze({ key: record.key, generation: record.generation }),
          enumerable: false,
        });
        return registered;
      });
  }

  async executeTool(tool, inputObject = {}, options = {}) {
    const token = tool?.[REGISTERED_TOOL_TOKEN];
    const record = token ? this.hub.records.get(token.key) : null;
    if (!record || record.generation !== token.generation) {
      throw new DOMException('Execution requires a live RegisteredTool handle.', 'NotFoundError');
    }
    if (record.origin !== tool.origin || record.definition.name !== tool.name) {
      throw new DOMException('RegisteredTool identity mismatch.', 'SecurityError');
    }
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Execution aborted.', 'AbortError');
    }

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await record.definition.execute.call(record.ownerWindow, clone(inputObject), {
        signal: controller.signal,
      });
      return JSON.stringify(result ?? null);
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

export function createInMemoryWebMcpHub() {
  let ownerSequence = 0;
  let generation = 0;
  const contexts = new Set();
  const hub = {
    records: new Map(),
    nextGeneration() {
      generation += 1;
      return generation;
    },
    notifyToolChange() {
      for (const context of contexts) {
        queueMicrotask(() => context.dispatchEvent(new Event('toolchange')));
      }
    },
    createContext(origin) {
      ownerSequence += 1;
      const context = new InMemoryModelContext(hub, origin, `context-${ownerSequence}`);
      contexts.add(context);
      return context;
    },
  };
  return hub;
}

export function createTestWebMcpClient({ context, allowedOrigins = [], includeCallerOrigin = false } = {}) {
  if (!(context instanceof InMemoryModelContext)) {
    throw new TypeError('Test mode requires a context created by createInMemoryWebMcpHub().');
  }
  return createClient({
    context,
    allowedOrigins,
    mode: 'test',
    callerOrigin: context.origin,
    includeCallerOrigin,
  });
}
