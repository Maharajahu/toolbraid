import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { configPathFromArgs, loadBridgeConfig } from '../bridge/common.mjs';
import { BridgeClient } from '../bridge/mcp-server.mjs';

const NATIVE_PROTOCOL = 'toolbraid.native-mcp';
const NATIVE_VERSION = 1;
const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function writeNative(stream, message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  stream.write(header);
  stream.write(payload);
}

function nativeDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length < 2 || length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('Invalid native frame length.');
      if (buffer.length < length + 4) return;
      const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
      buffer = buffer.subarray(length + 4);
      onMessage(message);
    }
  };
}

export async function smokeMcpBridge({ args = process.argv.slice(2) } = {}) {
  const configPath = configPathFromArgs(args);
  const config = await loadBridgeConfig(configPath);
  const launcher = option(args, '--launcher');
  if (!launcher || !path.isAbsolute(launcher)) throw new Error('Use --launcher with the absolute native host launcher path.');

  const child = spawn(launcher, [config.allowedOrigin, '--parent-window=0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let hostReadyResolve;
  let hostReadyReject;
  const hostReady = new Promise((resolve, reject) => {
    hostReadyResolve = resolve;
    hostReadyReject = reject;
  });
  const timeout = setTimeout(() => hostReadyReject(new Error('Native host smoke test timed out.')), 5_000);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000); });
  child.once('error', hostReadyReject);
  child.once('exit', (code) => {
    if (code !== 0) hostReadyReject(new Error(`Native host exited with ${code}: ${stderr}`));
  });
  child.stdout.on('data', nativeDecoder((message) => {
    if (message.protocol !== NATIVE_PROTOCOL || message.version !== NATIVE_VERSION) return;
    if (message.kind === 'event' && message.event === 'host_ready') {
      hostReadyResolve();
      return;
    }
    if (message.kind === 'request') {
      writeNative(child.stdin, {
        protocol: NATIVE_PROTOCOL,
        version: NATIVE_VERSION,
        kind: 'response',
        requestId: message.requestId,
        ok: true,
        result: { connected: true, transport: 'native-messaging+authenticated-pipe' },
      });
    }
  }));

  try {
    await hostReady;
    writeNative(child.stdin, {
      protocol: NATIVE_PROTOCOL,
      version: NATIVE_VERSION,
      kind: 'event',
      event: 'extension_ready',
    });
    const bridge = new BridgeClient(config, { timeoutMs: 3_000 });
    try {
      const result = await bridge.request('bridge.status', {});
      if (result?.connected !== true) throw new Error('Native host smoke response was not connected.');
      return result;
    } finally {
      bridge.close();
    }
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
      child.once('exit', () => { clearTimeout(killTimer); resolve(); });
    });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  smokeMcpBridge()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
