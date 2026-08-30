import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const BRIDGE_CONFIG_VERSION = 1;
export const BRIDGE_PROTOCOL = 'toolbraid.local-bridge';
export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024;

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}\/$/;
const WINDOWS_PIPE_PATTERN = /^\\\\\.\\pipe\\toolbraid-mcp-[a-f0-9-]{8,80}$/;

export class LocalBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalBridgeError';
    this.code = code;
  }
}

export function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function safeError(error, fallbackCode = 'BRIDGE_FAILED', fallbackMessage = 'The ToolBraid bridge request failed.') {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string'
    ? error.message.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320)
    : fallbackMessage;
  return Object.freeze({ code, message: message || fallbackMessage });
}

export function messageByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function validateBridgeConfig(value) {
  if (!plainObject(value)
    || value.version !== BRIDGE_CONFIG_VERSION
    || typeof value.token !== 'string' || !TOKEN_PATTERN.test(value.token)
    || typeof value.pipe !== 'string'
    || typeof value.allowedOrigin !== 'string' || !EXTENSION_ORIGIN_PATTERN.test(value.allowedOrigin)) {
    throw new LocalBridgeError('BRIDGE_CONFIG_INVALID', 'The ToolBraid bridge configuration is invalid.');
  }
  const validPipe = process.platform === 'win32'
    ? WINDOWS_PIPE_PATTERN.test(value.pipe)
    : path.isAbsolute(value.pipe) && value.pipe.length <= 220 && !value.pipe.includes('\0');
  if (!validPipe) throw new LocalBridgeError('BRIDGE_CONFIG_INVALID', 'The ToolBraid bridge endpoint is invalid.');
  return Object.freeze({
    version: BRIDGE_CONFIG_VERSION,
    token: value.token,
    pipe: value.pipe,
    allowedOrigin: value.allowedOrigin,
  });
}

export async function loadBridgeConfig(configPath) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) {
    throw new LocalBridgeError('BRIDGE_CONFIG_PATH_INVALID', 'An absolute bridge configuration path is required.');
  }
  const text = await readFile(configPath, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
    throw new LocalBridgeError('BRIDGE_CONFIG_TOO_LARGE', 'The ToolBraid bridge configuration is too large.');
  }
  try {
    return validateBridgeConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof LocalBridgeError) throw error;
    throw new LocalBridgeError('BRIDGE_CONFIG_INVALID', 'The ToolBraid bridge configuration is not valid JSON.');
  }
}

export function configPathFromArgs(args = process.argv.slice(2)) {
  const index = args.indexOf('--config');
  const candidate = index >= 0 ? args[index + 1] : null;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new LocalBridgeError('BRIDGE_CONFIG_PATH_INVALID', 'Use --config with an absolute ToolBraid bridge configuration path.');
  }
  return candidate;
}

export class JsonLineDecoder {
  #buffer = Buffer.alloc(0);
  #onMessage;
  #onError;

  constructor({ onMessage, onError } = {}) {
    if (typeof onMessage !== 'function' || typeof onError !== 'function') {
      throw new TypeError('onMessage and onError are required.');
    }
    this.#onMessage = onMessage;
    this.#onError = onError;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_BRIDGE_MESSAGE_BYTES * 2) {
      this.#buffer = Buffer.alloc(0);
      this.#onError(new LocalBridgeError('BRIDGE_MESSAGE_TOO_LARGE', 'The local bridge message exceeded its size limit.'));
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length === 0) continue;
      if (line.length > MAX_BRIDGE_MESSAGE_BYTES) {
        this.#onError(new LocalBridgeError('BRIDGE_MESSAGE_TOO_LARGE', 'The local bridge message exceeded its size limit.'));
        continue;
      }
      try {
        const value = JSON.parse(line.toString('utf8'));
        if (!plainObject(value)) throw new Error('object required');
        this.#onMessage(value);
      } catch {
        this.#onError(new LocalBridgeError('BRIDGE_MESSAGE_INVALID', 'The local bridge message is invalid JSON.'));
      }
    }
  }
}

export function writeJsonLine(stream, message) {
  if (!plainObject(message) || messageByteLength(message) > MAX_BRIDGE_MESSAGE_BYTES) {
    throw new LocalBridgeError('BRIDGE_MESSAGE_INVALID', 'The local bridge response is invalid or too large.');
  }
  stream.write(`${JSON.stringify(message)}\n`);
}
