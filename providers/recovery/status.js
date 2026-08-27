import { createProviderRuntime } from './runtime.js';

const { provider, orchestratorOrigin, signal, ready, fail } = createProviderRuntime('status');

try {
  for (const tool of provider.tools) {
    await document.modelContext.registerTool({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      execute: (input) => tool.execute(input),
    }, { exposedTo: [orchestratorOrigin], signal });
  }
  ready();
} catch (error) {
  fail(error);
}
