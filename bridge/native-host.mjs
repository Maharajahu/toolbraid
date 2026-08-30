import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  BRIDGE_PROTOCOL,
  BRIDGE_PROTOCOL_VERSION,
  JsonLineDecoder,
  LocalBridgeError,
  MAX_BRIDGE_MESSAGE_BYTES,
  configPathFromArgs,
  loadBridgeConfig,
  messageByteLength,
  plainObject,
  safeError,
  writeJsonLine,
} from './common.mjs';

const NATIVE_PROTOCOL = 'toolbraid.native-mcp';
const NATIVE_VERSION = 1;
const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
const SAFE_METHODS = new Set(['bridge.status', 'tools.list', 'tools.call']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function callerOrigin(args) {
  return args.find((value) => typeof value === 'string' && value.startsWith('chrome-extension://')) ?? null;
}

function nativeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new LocalBridgeError('NATIVE_MESSAGE_TOO_LARGE', 'The native message exceeded Chrome\'s response limit.');
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
}

class NativeDecoder {
  #buffer = Buffer.alloc(0);
  #onMessage;

  constructor(onMessage) {
    this.#onMessage = onMessage;
  }

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length < 2 || length > MAX_NATIVE_MESSAGE_BYTES) {
        throw new LocalBridgeError('NATIVE_MESSAGE_INVALID', 'Chrome sent an invalid native message length.');
      }
      if (this.#buffer.length < length + 4) return;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      const parsed = JSON.parse(payload.toString('utf8'));
      if (!plainObject(parsed)) throw new LocalBridgeError('NATIVE_MESSAGE_INVALID', 'Chrome sent an invalid native message.');
      this.#onMessage(parsed);
    }
  }
}

export async function runNativeHost({ args = process.argv.slice(2) } = {}) {
  const configPath = configPathFromArgs(args);
  const config = await loadBridgeConfig(configPath);
  if (callerOrigin(args) !== config.allowedOrigin) {
    throw new LocalBridgeError('NATIVE_ORIGIN_REJECTED', 'The calling extension origin is not allowed.');
  }

  const clients = new Set();
  const pending = new Map();
  let extensionReady = false;

  function sendClient(socket, message) {
    if (!socket.destroyed) writeJsonLine(socket, message);
  }

  function broadcast(message) {
    for (const client of clients) if (client.authenticated) sendClient(client.socket, message);
  }

  function closeClient(client) {
    clients.delete(client);
    for (const [requestId, request] of pending) {
      if (request.client === client) pending.delete(requestId);
    }
    try { client.socket.destroy(); } catch { /* already closed */ }
  }

  function onClientMessage(client, message) {
    if (!client.authenticated) {
      if (message.kind !== 'auth' || message.protocol !== BRIDGE_PROTOCOL
        || message.version !== BRIDGE_PROTOCOL_VERSION || message.token !== config.token) {
        sendClient(client.socket, { protocol: BRIDGE_PROTOCOL, version: BRIDGE_PROTOCOL_VERSION, kind: 'auth', ok: false });
        closeClient(client);
        return;
      }
      client.authenticated = true;
      sendClient(client.socket, {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_PROTOCOL_VERSION,
        kind: 'auth',
        ok: true,
        extensionReady,
      });
      return;
    }
    if (message.kind !== 'request'
      || typeof message.requestId !== 'string' || !SAFE_ID.test(message.requestId)
      || !SAFE_METHODS.has(message.method)
      || !plainObject(message.params ?? {})
      || messageByteLength(message) > MAX_BRIDGE_MESSAGE_BYTES) {
      sendClient(client.socket, {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_PROTOCOL_VERSION,
        kind: 'response',
        requestId: typeof message.requestId === 'string' ? message.requestId.slice(0, 128) : 'invalid',
        ok: false,
        error: { code: 'BRIDGE_REQUEST_INVALID', message: 'The local bridge request is invalid.' },
      });
      return;
    }
    if (!extensionReady) {
      sendClient(client.socket, {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_PROTOCOL_VERSION,
        kind: 'response',
        requestId: message.requestId,
        ok: false,
        error: { code: 'EXTENSION_UNAVAILABLE', message: 'ToolBraid is not connected in Chrome.' },
      });
      return;
    }
    const nativeRequestId = randomUUID();
    pending.set(nativeRequestId, { client, clientRequestId: message.requestId });
    try {
      nativeFrame({
        protocol: NATIVE_PROTOCOL,
        version: NATIVE_VERSION,
        kind: 'request',
        requestId: nativeRequestId,
        method: message.method,
        params: message.params ?? {},
      });
    } catch (error) {
      pending.delete(nativeRequestId);
      sendClient(client.socket, {
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_PROTOCOL_VERSION,
        kind: 'response',
        requestId: message.requestId,
        ok: false,
        error: safeError(error),
      });
    }
  }

  const server = net.createServer((socket) => {
    const client = { socket, authenticated: false };
    clients.add(client);
    const decoder = new JsonLineDecoder({
      onMessage: (message) => onClientMessage(client, message),
      onError: () => closeClient(client),
    });
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', () => closeClient(client));
    socket.on('close', () => closeClient(client));
  });

  if (process.platform !== 'win32') await rm(config.pipe, { force: true }).catch(() => undefined);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.pipe, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const decoder = new NativeDecoder((message) => {
    if (message.protocol !== NATIVE_PROTOCOL || message.version !== NATIVE_VERSION) return;
    if (message.kind === 'event') {
      if (message.event === 'extension_ready') {
        extensionReady = true;
        broadcast({ protocol: BRIDGE_PROTOCOL, version: BRIDGE_PROTOCOL_VERSION, kind: 'event', event: 'extension_ready' });
      } else if (message.event === 'tools_changed') {
        broadcast({ protocol: BRIDGE_PROTOCOL, version: BRIDGE_PROTOCOL_VERSION, kind: 'event', event: 'tools_changed' });
      }
      return;
    }
    if (message.kind !== 'response' || typeof message.requestId !== 'string') return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    sendClient(request.client.socket, {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_PROTOCOL_VERSION,
      kind: 'response',
      requestId: request.clientRequestId,
      ok: message.ok === true,
      ...(message.ok === true ? { result: message.result } : { error: safeError(message.error, 'EXTENSION_REJECTED', 'ToolBraid rejected the request.') }),
    });
  });

  process.stdin.on('data', (chunk) => {
    try { decoder.push(chunk); } catch { process.exitCode = 1; process.stdin.destroy(); }
  });
  process.stdin.on('end', () => {
    for (const client of clients) closeClient(client);
    server.close();
  });
  process.stdin.resume();

  nativeFrame({
    protocol: NATIVE_PROTOCOL,
    version: NATIVE_VERSION,
    kind: 'event',
    event: 'host_ready',
  });
  return Object.freeze({ server, config });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runNativeHost().catch((error) => {
    process.stderr.write(`${safeError(error).code}: ${safeError(error).message}\n`);
    process.exitCode = 1;
  });
}
