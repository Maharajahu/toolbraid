import {
  JSON_RPC_ERROR_CODES,
  errorResponse,
  isRequestId,
  serializeMessage,
} from './protocol.js';

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ACTIVE_TASKS = 16;
const DEFAULT_MAX_QUEUED_TASKS = 256;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CANCELLATION_TASKS = 1;
const DEFAULT_MAX_CANCELLATION_QUEUE = 64;
const DEFAULT_MAX_OVERLOAD_RESPONSES = 16;
const TRANSPORT_OVERLOADED = -32024;

function asUint8Length(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value && typeof value.byteLength === 'number') return value.byteLength;
  return 0;
}

function integerOption(value, fallback, { minimum = 1 } = {}) {
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function messageFromLine(line) {
  try {
    const message = JSON.parse(line);
    return message && typeof message === 'object' && !Array.isArray(message)
      ? message
      : undefined;
  } catch {
    return undefined;
  }
}

function isCancellationLine(line) {
  const message = messageFromLine(line);
  return Boolean(
    message &&
    message.jsonrpc === '2.0' &&
    message.method === 'notifications/cancelled' &&
    !Object.prototype.hasOwnProperty.call(message, 'id'),
  );
}

/**
 * Newline-delimited stdio MCP transport.
 *
 * The transport intentionally does not print diagnostics to stdout.  Every
 * stdout write is a serialized JSON-RPC response/notification, while callers
 * may use onError/stderr for diagnostics.  Requests are dispatched
 * concurrently so a cancellation notification can reach an in-flight tool.
 * Admission is bounded: normal requests have a finite active set and FIFO
 * queue, while cancellation notifications use a small reserved control lane
 * so they cannot be stranded behind hanging requests.
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
    this.maxActiveTasks = integerOption(
      options.maxActiveTasks ?? options.maxConcurrentTasks ?? options.maxTasks,
      DEFAULT_MAX_ACTIVE_TASKS,
    );
    this.maxQueuedTasks = integerOption(
      options.maxQueuedTasks ?? options.maxQueueTasks,
      DEFAULT_MAX_QUEUED_TASKS,
      { minimum: 0 },
    );
    this.maxQueuedBytes = integerOption(
      options.maxQueuedBytes ?? options.maxQueueBytes,
      DEFAULT_MAX_QUEUED_BYTES,
      { minimum: 0 },
    );
    this.maxCancellationTasks = integerOption(
      options.maxCancellationTasks,
      DEFAULT_MAX_CANCELLATION_TASKS,
    );
    this.maxCancellationQueue = integerOption(
      options.maxCancellationQueue ?? options.maxQueuedCancellations,
      Math.min(DEFAULT_MAX_CANCELLATION_QUEUE, Math.max(1, this.maxQueuedTasks)),
      { minimum: 0 },
    );
    this.maxOverflowResponses = integerOption(
      options.maxOverflowResponses,
      DEFAULT_MAX_OVERLOAD_RESPONSES,
      { minimum: 0 },
    );
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
    this.queue = [];
    this.queueBytes = 0;
    this.cancellationQueue = [];
    this.cancellationQueueBytes = 0;
    this.activeTaskCount = 0;
    this.activeCancellationCount = 0;
    this.admissionBlocked = false;
    this.inputPaused = false;
    this.outputBackpressured = false;
    this.overflowResponses = 0;
    this._onData = (chunk) => this.#receive(chunk);
    this._onEnd = () => this.close();
    this._onError = (error) => this.#report(error);
    this._onOutputDrain = () => {
      this.outputBackpressured = false;
      this.#pump();
    };
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
      this.#writeEncoded(encoded);
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
    // A completion callback can start the next queued task.  Keep taking
    // snapshots until the scheduler is actually empty rather than leaving a
    // queued task behind after the first batch settles.
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
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
    this.queue.length = 0;
    this.queueBytes = 0;
    this.cancellationQueue.length = 0;
    this.cancellationQueueBytes = 0;
    this.admissionBlocked = false;
    this.#refreshInputFlow();
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
    const bytes = asUint8Length(line) + 1;
    if (isCancellationLine(line)) {
      this.#enqueueCancellation(line, bytes);
      return;
    }

    // Once a normal queue is saturated, keep parsing only far enough to spot
    // cancellation notifications.  Dropped requests never create promises or
    // retain their input bytes.
    if (this.admissionBlocked) {
      this.#rejectOverloaded(line);
      return;
    }

    if (this.activeTaskCount < this.maxActiveTasks && this.queue.length === 0) {
      this.#startNormal(line);
      return;
    }

    if (
      this.queue.length < this.maxQueuedTasks &&
      this.queueBytes + bytes <= this.maxQueuedBytes
    ) {
      this.queue.push({ line, bytes });
      this.queueBytes += bytes;
      return;
    }

    this.admissionBlocked = true;
    this.#pauseInput();
    this.#rejectOverloaded(line);
  }

  #writeParseError() {
    if (this.closed) return;
    try {
      this.#writeEncoded(serializeMessage(
        errorResponse(undefined, JSON_RPC_ERROR_CODES.PARSE_ERROR, 'Parse error'),
      ));
    } catch (error) {
      this.#report(error);
      this.close();
    }
  }

  #enqueueCancellation(line, bytes) {
    if (this.closed) return;
    if (this.activeCancellationCount < this.maxCancellationTasks) {
      this.#startCancellation(line);
      return;
    }
    if (
      this.cancellationQueue.length < this.maxCancellationQueue &&
      this.cancellationQueueBytes + bytes <= this.maxQueuedBytes
    ) {
      this.cancellationQueue.push({ line, bytes });
      this.cancellationQueueBytes += bytes;
    }
    // Cancellation notifications are deliberately best-effort after the
    // bounded control queue is full: they have no response and must not turn
    // an input flood into an unbounded promise list.
  }

  #startNormal(line) {
    this.activeTaskCount += 1;
    this.#trackTask(
      () => this.processLine(line),
      () => {
        this.activeTaskCount -= 1;
        this.#pump();
      },
    );
  }

  #startCancellation(line) {
    this.activeCancellationCount += 1;
    this.#trackTask(
      () => this.processLine(line),
      () => {
        this.activeCancellationCount -= 1;
        this.#pump();
      },
    );
  }

  #trackTask(run, onComplete) {
    const task = Promise.resolve()
      .then(run)
      .catch((error) => {
        this.#report(error);
      });
    this.tasks.add(task);
    task.then(() => {
      this.tasks.delete(task);
      onComplete();
    });
  }

  #pump() {
    if (this.closed) return;

    // Control work always wins over ordinary queued calls.  It has its own
    // bounded lane so a hanging tool cannot prevent cancellation delivery.
    while (
      this.activeCancellationCount < this.maxCancellationTasks &&
      this.cancellationQueue.length > 0
    ) {
      const item = this.cancellationQueue.shift();
      this.cancellationQueueBytes -= item.bytes;
      this.#startCancellation(item.line);
    }

    // A Writable returning false is a hard admission boundary.  Keep the
    // normal queue intact until its drain event; otherwise a never-draining
    // stdout would allow every queued call to materialize a large response.
    if (!this.outputBackpressured) {
      while (this.activeTaskCount < this.maxActiveTasks && this.queue.length > 0) {
        const item = this.queue.shift();
        this.queueBytes -= item.bytes;
        this.#startNormal(item.line);
      }
    }

    if (this.admissionBlocked && this.#hasNormalCapacity()) {
      this.admissionBlocked = false;
      this.overflowResponses = 0;
    }
    this.#refreshInputFlow();
  }

  #hasNormalCapacity() {
    if (this.activeTaskCount < this.maxActiveTasks) return true;
    return this.queue.length < this.maxQueuedTasks && this.queueBytes < this.maxQueuedBytes;
  }

  #rejectOverloaded(line) {
    if (this.closed || this.overflowResponses >= this.maxOverflowResponses) return;
    const message = messageFromLine(line);
    if (!message || !Object.prototype.hasOwnProperty.call(message, 'id')) return;
    if (!isRequestId(message.id)) return;
    this.overflowResponses += 1;
    try {
      this.#writeEncoded(serializeMessage(
        errorResponse(message.id, TRANSPORT_OVERLOADED, 'Transport overloaded'),
      ));
    } catch (error) {
      this.#report(error);
      this.close();
    }
  }

  #writeEncoded(encoded) {
    const accepted = this.output.write(`${encoded}\n`);
    if (accepted === false && !this.outputBackpressured) {
      this.outputBackpressured = true;
      this.#pauseInput();
      this.output.once?.('drain', this._onOutputDrain);
    }
  }

  #pauseInput() {
    if (this.closed || this.inputPaused || typeof this.input.pause !== 'function') return;
    try {
      this.input.pause();
      this.inputPaused = true;
    } catch (error) {
      this.#report(error);
    }
  }

  #refreshInputFlow() {
    if (this.closed) return;
    const shouldPause = this.admissionBlocked || this.outputBackpressured;
    if (shouldPause) {
      this.#pauseInput();
      return;
    }
    if (!this.inputPaused || typeof this.input.resume !== 'function') return;
    try {
      this.input.resume();
      this.inputPaused = false;
    } catch (error) {
      this.#report(error);
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
