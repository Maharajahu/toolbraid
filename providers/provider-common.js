import { createWebMcpRuntime } from '../js/core/webmcp-runtime.js';

function safeText(value) {
  return String(value ?? '').replace(/[<>&"']/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#039;',
  })[char]);
}

export async function delay(ms, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Execution aborted', 'AbortError'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function messageOrigin() {
  if (location.origin !== 'null') return location.origin;
  try { const origin = parent.location.origin; return origin === 'null' ? '*' : origin; } catch { return '*'; }
}

export async function bootProvider({ id, label, tools, initialMessage = 'Waiting for an agent call.' }) {
  const runtime = createWebMcpRuntime();
  const toolList = document.querySelector('[data-tools]');
  document.querySelector('[data-mode]').textContent = runtime.mode === 'native' ? 'WebMCP native' : 'WebMCP test runtime';
  toolList.innerHTML = tools.map((tool) => `<span class="tool">${safeText(tool.name)}</span>`).join('');
  setProviderEvent('Ready', initialMessage);

  for (const tool of tools) {
    const wrapped = {
      ...tool,
      async execute(input, options) {
        setProviderEvent('Executing', tool.title ?? tool.name, input);
        const result = await tool.execute(input, options);
        setProviderEvent('Completed', tool.title ?? tool.name, result);
        parent.postMessage({ type: 'toolbraid:provider-event', provider: id, tool: tool.name, result }, messageOrigin());
        return result;
      },
    };
    await runtime.registerTool(wrapped, { exposedTo: [messageOrigin()] });
  }

  parent.postMessage({
    type: 'toolbraid:provider-ready',
    provider: id,
    label,
    mode: runtime.mode,
    tools: tools.map((tool) => tool.name),
  }, messageOrigin());
}

export function setProviderEvent(title, meta, payload = null) {
  const event = document.querySelector('[data-event]');
  const summary = payload ? summarize(payload) : '';
  event.innerHTML = `
    <div class="event-label">Latest activity</div>
    <div class="event-title">${safeText(title)}</div>
    <div class="event-meta">${safeText(meta)}${summary ? `<div class="results">${summary}</div>` : ''}</div>
  `;
}

function summarize(payload) {
  const entries = [];
  if (payload && typeof payload === 'object') {
    const arrays = Object.entries(payload).find(([, value]) => Array.isArray(value));
    if (arrays) {
      entries.push(`<div class="result-row"><span>${safeText(arrays[0])}</span><strong>${arrays[1].length} returned</strong></div>`);
      for (const item of arrays[1].slice(0, 2)) {
        const label = item.name ?? item.operator ?? item.label ?? item.id ?? item.spaceCode ?? item.quoteId ?? 'Option';
        const value = item.fare ?? item.nightly ?? item.minutes ?? item.walkingMinutes ?? item.status ?? '';
        entries.push(`<div class="result-row"><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`);
      }
    } else {
      for (const [key, value] of Object.entries(payload).slice(0, 3)) {
        entries.push(`<div class="result-row"><span>${safeText(key)}</span><strong>${safeText(typeof value === 'object' ? JSON.stringify(value) : value)}</strong></div>`);
      }
    }
  }
  return entries.join('');
}
