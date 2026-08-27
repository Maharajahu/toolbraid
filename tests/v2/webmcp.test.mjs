import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WebMcpError,
  createInMemoryWebMcpHub,
  createNativeWebMcpClient,
  createTestWebMcpClient,
} from '../../src/engine/webmcp.js';

const ORCHESTRATOR = 'https://control.toolbraid.test';
const HEALTH = 'https://health.toolbraid.test';
const DEPLOY = 'https://deploy.toolbraid.test';
const ROGUE = 'https://rogue.toolbraid.test';

function definition(name, execute = async (input) => ({ name, input })) {
  return {
    name,
    description: `Execute ${name}`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
    annotations: { readOnlyHint: true },
    execute,
  };
}

test('native mode fails closed instead of using a legacy navigator fallback', () => {
  assert.throws(
    () => createNativeWebMcpClient({ documentRef: {}, allowedOrigins: [HEALTH] }),
    (error) => error instanceof WebMcpError && error.code === 'WEBMCP_UNSUPPORTED',
  );
});

test('native mode retries only Chrome legacy pre-dispatch input parsing with serialized JSON', async () => {
  const tool = {
    name: 'probe',
    title: 'Probe',
    description: 'Probe service health.',
    inputSchema: JSON.stringify({ type: 'object' }),
    origin: HEALTH,
    window: {},
  };
  const inputs = [];
  const context = new EventTarget();
  context.registerTool = async () => {};
  context.getTools = async () => [tool];
  context.executeTool = async (_tool, input) => {
    inputs.push(input);
    if (inputs.length === 1) throw new DOMException('Failed to parse input arguments', 'UnknownError');
    return JSON.stringify({ received: JSON.parse(input) });
  };
  const client = createNativeWebMcpClient({
    documentRef: { modelContext: context, location: { origin: ORCHESTRATOR } },
    allowedOrigins: [HEALTH],
  });
  const [handle] = await client.discover();

  assert.deepEqual(await client.execute(handle, { value: 'checkout' }), {
    received: { value: 'checkout' },
  });
  assert.deepEqual(inputs, [{ value: 'checkout' }, JSON.stringify({ value: 'checkout' })]);
});

test('native mode uses the standards object input exactly once when the runtime accepts it', async () => {
  const tool = {
    name: 'probe',
    title: 'Probe',
    description: 'Probe service health.',
    inputSchema: JSON.stringify({ type: 'object' }),
    origin: HEALTH,
    window: {},
  };
  const calls = [];
  const context = new EventTarget();
  context.registerTool = async () => {};
  context.getTools = async () => [tool];
  context.executeTool = async (...args) => {
    calls.push(args);
    return JSON.stringify({ healthy: true });
  };
  const client = createNativeWebMcpClient({
    documentRef: { modelContext: context, location: { origin: ORCHESTRATOR } },
    allowedOrigins: [HEALTH],
  });
  const [handle] = await client.discover();
  const input = { value: 'checkout' };
  const options = { signal: new AbortController().signal };

  assert.deepEqual(await client.execute(handle, input, options), { healthy: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], handle);
  assert.equal(calls[0][1], input);
  assert.equal(calls[0][2], options);
});

test('native mode never retries an execution error that is not the exact legacy parse failure', async () => {
  const tool = {
    name: 'probe',
    title: 'Probe',
    description: 'Probe service health.',
    inputSchema: JSON.stringify({ type: 'object' }),
    origin: HEALTH,
    window: {},
  };
  let calls = 0;
  const context = new EventTarget();
  context.registerTool = async () => {};
  context.getTools = async () => [tool];
  context.executeTool = async () => {
    calls += 1;
    throw new DOMException('Provider execution failed', 'UnknownError');
  };
  const client = createNativeWebMcpClient({
    documentRef: { modelContext: context, location: { origin: ORCHESTRATOR } },
    allowedOrigins: [HEALTH],
  });
  const [handle] = await client.discover();

  await assert.rejects(() => client.execute(handle, { value: 'checkout' }), /Provider execution failed/);
  assert.equal(calls, 1);
});

test('discovers only cross-origin tools explicitly exposed to the orchestrator', async () => {
  const hub = createInMemoryWebMcpHub();
  const orchestrator = hub.createContext(ORCHESTRATOR);
  const health = hub.createContext(HEALTH);
  const deploy = hub.createContext(DEPLOY);
  const rogue = hub.createContext(ROGUE);

  await health.registerTool(definition('probe'), { exposedTo: [ORCHESTRATOR] });
  await deploy.registerTool(definition('rollout'), { exposedTo: ['https://someone-else.test'] });
  await rogue.registerTool(definition('attractive_offer'), { exposedTo: [ORCHESTRATOR] });

  const client = createTestWebMcpClient({ context: orchestrator, allowedOrigins: [HEALTH, DEPLOY] });
  const tools = await client.discover();

  assert.deepEqual(tools.map((tool) => [tool.origin, tool.name]), [[HEALTH, 'probe']]);
});

test('rejects undeclared same-origin orchestrator tools by default', async () => {
  const hub = createInMemoryWebMcpHub();
  const orchestrator = hub.createContext(ORCHESTRATOR);
  await orchestrator.registerTool(definition('toolbraid.inspect_state'));

  const client = createTestWebMcpClient({ context: orchestrator, allowedOrigins: [HEALTH] });
  assert.deepEqual(client.allowedOrigins, [HEALTH]);
  await assert.rejects(
    () => client.discover(),
    (error) => error instanceof WebMcpError
      && error.code === 'WEBMCP_ORIGIN_DENIED'
      && error.details.origin === ORCHESTRATOR,
  );
});

test('accepts same-origin tools only through explicit opt-in', async () => {
  const hub = createInMemoryWebMcpHub();
  const orchestrator = hub.createContext(ORCHESTRATOR);
  await orchestrator.registerTool(definition('toolbraid.inspect_state'));

  const client = createTestWebMcpClient({
    context: orchestrator,
    allowedOrigins: [HEALTH],
    includeCallerOrigin: true,
  });
  const tools = await client.discover();

  assert.deepEqual(client.allowedOrigins, [HEALTH]);
  assert.deepEqual(tools.map((tool) => [tool.origin, tool.name]), [[ORCHESTRATOR, 'toolbraid.inspect_state']]);
});

test('keeps duplicate tool names from different origins as distinct handles', async () => {
  const hub = createInMemoryWebMcpHub();
  const orchestrator = hub.createContext(ORCHESTRATOR);
  const health = hub.createContext(HEALTH);
  const deploy = hub.createContext(DEPLOY);

  await health.registerTool(definition('inspect'), { exposedTo: [ORCHESTRATOR] });
  await deploy.registerTool(definition('inspect'), { exposedTo: [ORCHESTRATOR] });

  const client = createTestWebMcpClient({ context: orchestrator, allowedOrigins: [HEALTH, DEPLOY] });
  const tools = await client.discover();

  assert.equal(tools.length, 2);
  assert.deepEqual(new Set(tools.map((tool) => tool.origin)), new Set([HEALTH, DEPLOY]));
});

test('executes only the exact live handle and parses the serialized native result', async () => {
  const hub = createInMemoryWebMcpHub();
  const orchestrator = hub.createContext(ORCHESTRATOR);
  const health = hub.createContext(HEALTH);
  await health.registerTool(definition('probe', async ({ value }) => ({ healthy: true, value })), {
    exposedTo: [ORCHESTRATOR],
  });

  const client = createTestWebMcpClient({ context: orchestrator, allowedOrigins: [HEALTH] });
  const [tool] = await client.discover();
  assert.deepEqual(await client.execute(tool, { value: 'checkout' }), { healthy: true, value: 'checkout' });

  await assert.rejects(
    () => client.execute({ name: tool.name, origin: tool.origin }, { value: 'forged' }),
    (error) => error instanceof WebMcpError && error.code === 'WEBMCP_HANDLE_REQUIRED',
  );
});

test('unregisters an aborted tool and rejects its stale handle', async () => {
  const hub = createInMemoryWebMcpHub();
  const orchestrator = hub.createContext(ORCHESTRATOR);
  const health = hub.createContext(HEALTH);
  const lifecycle = new AbortController();
  await health.registerTool(definition('probe'), {
    exposedTo: [ORCHESTRATOR],
    signal: lifecycle.signal,
  });

  const client = createTestWebMcpClient({ context: orchestrator, allowedOrigins: [HEALTH] });
  const [tool] = await client.discover();
  lifecycle.abort();
  await new Promise((resolve) => queueMicrotask(resolve));

  assert.deepEqual(await client.discover(), []);
  await assert.rejects(() => client.execute(tool), (error) => error?.name === 'NotFoundError');
});

test('toolchange increments the client generation', async () => {
  const hub = createInMemoryWebMcpHub();
  const orchestrator = hub.createContext(ORCHESTRATOR);
  const health = hub.createContext(HEALTH);
  const client = createTestWebMcpClient({ context: orchestrator, allowedOrigins: [HEALTH] });
  const changes = [];
  client.subscribe((change) => changes.push(change.generation));

  await health.registerTool(definition('probe'), { exposedTo: [ORCHESTRATOR] });
  await new Promise((resolve) => queueMicrotask(resolve));

  assert.equal(client.generation, 1);
  assert.deepEqual(changes, [1]);
});

test('rejects duplicate names within one provider context', async () => {
  const hub = createInMemoryWebMcpHub();
  const health = hub.createContext(HEALTH);
  await health.registerTool(definition('probe'));
  await assert.rejects(() => health.registerTool(definition('probe')), (error) => error?.name === 'InvalidStateError');
});
