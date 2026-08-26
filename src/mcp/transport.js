import {
  JSON_RPC_ERROR_CODES,
  errorResponse,
  serializeMessage,
} from './protocol.js';

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

function asUint8Length(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value && typeof value.byteLength === 'number') return value.byteLength;
  return 0;
}

/**
 * Newline-delimited stdio MCP transport.
 *
 * The transport intentionally does not print diagnostics to stdout.  Every
 * stdout write is a serialized JSON-RPC response/notification, while callers
 * may use onError/stderr for diagnostics.  Requests are dispatched
 * concurrently so a cancellation notification can reach an in-flight tool.
 */
export class StdioTransport {
  constructor(gateway, options = {}) {
    if (!gateway || typeof gateway.handleMessage !== 'function') {
      throw new TypeError('A gateway with handleMessage is required');
    }
    this.gateway = gateway;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.maxLineBytes = Number.isSafeInteger(options.maxLineBytes) && options.maxLineBytes > 0
      ? options.maxLineBytes
      : DEFAULT_MAX_LINE_BYTES;
    this.onError = typeof options.onError === 'function'
      ? options.onError
      : (error) => {
        if (options.logToStderr !== false && process.stderr?.write) {
          process.stderr.write(`${error?.message ?? String(error)}\n`);
        }
      };
    this.session = options.session ?? gateway.createSession?.();
    this.context = {
      ...(options.context ?? {}),
      session: this.session,
    };
    this.decoder = new TextDecoder('utf-8');
    this.buffer = '';
    this.discardingOversizedFrame = false;
    this.started = false;
    this.closed = false;
    this.tasks = new Set();
    this._onData = (chunk) => this.#receive(chunk);
    this._onEnd = () => this.close();
    this._onError = (error) => this.#report(error);
  }

  start() {
    if (this.started || this.closed) return this;
    this.started = true;
    this.input.on?.('data', this._onData);
    this.input.on?.('end', this._onEnd);
    this.input.on?.('error', this._onError);
    return this;
  }

  async processLine(line) {
    if (this.closed) return null;
    let response;
    try {
      response = await this.gateway.handleMessage(line, this.context);
    } catch (error) {
      this.#report(error);
      response = errorResponse(undefined, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
    }
    if (response === null || response === undefined || this.closed) return null;
    let encoded;
    try {
      encoded = serializeMessage(response);
    } catch (error) {
      this.#report(error);
      encoded = serializeMessage(
        errorResponse(undefined, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, 'Internal error'),
      );
    }
    try {
      this.output.write(`${encoded}\n`);
    } catch (error) {
      this.#report(error);
      this.close();
    }
    return encoded;
  }

  /** Process a line without writing it; useful for transport tests. */
  async handleLine(line) {
    return this.processLine(line);
  }

  async drain() {
    await Promise.allSettled([...this.tasks]);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.started) {
      this.input.off?.('data', this._onData);
      this.input.off?.('end', this._onEnd);
      this.input.off?.('error', this._onError);
    }
    this.buffer = '';
    this.discardingOversizedFrame = false;
  }

  #receive(chunk) {
    if (this.closed) return;
    let text;
    try {
      text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    } catch (error) {
      this.#report(error);
      this.#writeParseError();
      return;
    }
    if (this.discardingOversizedFrame) {
      const delimiter = text.indexOf('\n');
      if (delimiter === -1) return;
      // Continue only with bytes after the delimiter that terminated the
      // oversized frame.  Without this state, a later chunk containing the
      // tail of that frame could be interpreted as a new JSON-RPC request.
      text = text.slice(delimiter + 1);
      this.discardingOversizedFrame = false;
    }

    this.buffer += text;

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (asUint8Length(line) > this.maxLineBytes) this.#writeParseError();
      else this.#enqueue(line);
      newlineIndex = this.buffer.indexOf('\n');
    }

    if (asUint8Length(this.buffer) > this.maxLineBytes) {
      // Drop this frame through its next delimiter.  Keep explicit discard
      // state across chunks so no suffix of the rejected frame can execute.
      this.buffer = '';
      this.discardingOversizedFrame = true;
      this.#writeParseError();
    }
  }

  #enqueue(line) {
    const task = this.processLine(line).catch((error) => {
      this.#report(error);
    });
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task));
  }

  #writeParseError() {
    if (this.closed) return;
    try {
      this.output.write(`${serializeMessage(errorResponse(undefined, JSON_RPC_ERROR_CODES.PARSE_ERROR, 'Parse error'))}\n`);
    } catch (error) {
      this.#report(error);
      this.close();
    }
  }

  #report(error) {
    try {
      this.onError(error);
    } catch {
      // Diagnostics must never break the protocol stream.
    }
  }
}

export function createStdioTransport(gateway, options = {}) {
  return new StdioTransport(gateway, options);
}

/** Start a transport and resolve when stdin reaches EOF. */
export function runStdio(gateway, options = {}) {
  const transport = new StdioTransport(gateway, options);
  transport.start();
  return new Promise((resolve) => {
    const input = transport.input;
    const done = () => {
      void transport.drain().finally(() => resolve(transport));
    };
    input.once?.('end', done);
    input.once?.('close', done);
  });
}
