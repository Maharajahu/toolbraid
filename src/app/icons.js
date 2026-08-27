const ICON_PATHS = Object.freeze({
  spark: '<path d="M12 2.7v3.1M12 18.2v3.1M2.7 12h3.1M18.2 12h3.1M5.4 5.4l2.2 2.2M16.4 16.4l2.2 2.2M18.6 5.4l-2.2 2.2M7.6 16.4l-2.2 2.2"/><circle cx="12" cy="12" r="3.2"/>',
  mission: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3"/><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3"/>',
  braid: '<path d="M3.2 7.2C6.1 2.8 9.2 2.8 12 7.2l4.7 7.3c1.5 2.4 3 2.5 4.1.3"/><path d="M3.2 16.8c2.9 4.4 6 4.4 8.8 0l4.7-7.3c1.5-2.4 3-2.5 4.1-.3"/><path d="M2.5 12c2.2-3.1 4.5-3.1 6.8 0l5.3 7.4"/><path d="M9.3 12l5.3-7.4c1.7-2.5 3.7-2.5 5.7-.2"/><circle cx="12" cy="12" r="1.7"/>',
  provider: '<path d="M5 7.2h14v9.6H5z"/><path d="M8 7.2V4.5h8v2.7M8 19.5h8M12 16.8v2.7"/><circle cx="8" cy="12" r="1"/><path d="M11 12h5"/>',
  pulse: '<path d="M2.8 12h4l1.8-4.2 3.2 8.4 2.2-5.1 1.3.9h5.9"/><circle cx="12" cy="12" r="9"/>',
  radar: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.3"/><circle cx="12" cy="12" r="1.3"/><path d="M12 12l5.8-5.8M12 3.5v2M20.5 12h-2"/>',
  branch: '<path d="M3.5 7h6l2-2.4h9v14.8h-17V7Z"/><path d="M7 11h3.2M13.8 11H17M8.5 11v4h7v-4"/><circle cx="8.5" cy="16.8" r="1.2"/><circle cx="15.5" cy="16.8" r="1.2"/>',
  history: '<path d="M5.2 2.8h9l4.6 4.6v13.8H5.2V2.8Z"/><path d="M14.2 2.8v4.6h4.6M8.2 10h2M13.5 10h2.3M8.2 14h2M13.5 14h2.3M8.2 18h2M13.5 18h2.3"/><circle cx="11.8" cy="10" r=".8"/><circle cx="11.8" cy="14" r=".8"/><circle cx="11.8" cy="18" r=".8"/>',
  deployment: '<path d="m12 3 7 3.6-7 3.6-7-3.6L12 3Z"/><path d="m5 11.2 7 3.6 7-3.6M5 15.8l7 3.6 7-3.6"/>',
  waveform: '<path d="M2.5 12h3l1.7-5.2 3.1 10.4 3.1-8 2.1 5.2 1.6-2.4h4.4"/><path d="M3.5 4.5h17M3.5 19.5h17"/>',
  health: '<path d="M12 20.2S4 15.8 4 9.4A4.6 4.6 0 0 1 12 6a4.6 4.6 0 0 1 8 3.4c0 6.4-8 10.8-8 10.8Z"/><path d="M6.8 12h2.7l1.4-3.1 2.2 6.1 1.5-3h2.6"/>',
  'release-history': '<path d="M5.2 2.8h9l4.6 4.6v13.8H5.2V2.8Z"/><path d="M14.2 2.8v4.6h4.6M8.2 10h2M13.5 10h2.3M8.2 14h2M13.5 14h2.3M8.2 18h2M13.5 18h2.3"/><circle cx="11.8" cy="10" r=".8"/><circle cx="11.8" cy="14" r=".8"/><circle cx="11.8" cy="18" r=".8"/>',
  'deployment-history': '<path d="m9.5 3 6 3-6 3-6-3 6-3ZM3.5 10.2l6 3 3.4-1.7"/><circle cx="16.7" cy="16.7" r="4.1"/><path d="M16.7 14.3v2.7l1.8 1"/>',
  'status-board': '<path d="M3.5 4.2h17v12.5H9l-4.2 3v-3H3.5V4.2Z"/><circle cx="7" cy="10.5" r="1.1"/><path d="M10.3 8.3h6.5M10.3 12.5h4.5"/>',
  'notice-read': '<path d="M3.5 4.5h17v11.8H9l-4.2 3v-3H3.5V4.5Z"/><path d="M7 10.5s2-2.4 5-2.4 5 2.4 5 2.4-2 2.4-5 2.4-5-2.4-5-2.4Z"/><circle cx="12" cy="10.5" r="1.4"/>',
  'recovery-plan': '<path d="M12 2.8 19 5.5v5.7c0 4.4-2.7 7.8-7 10-4.3-2.2-7-5.6-7-10V5.5L12 2.8Z"/><path d="M8 9h5.2M13.2 9l-2-2M13.2 9l-2 2M16 15h-5.2M10.8 15l2-2M10.8 15l2 2"/>',
  mirage: '<path d="m12 2.8 8.5 15H3.5l8.5-15Z"/><path d="m8.2 15.4 3.8-7 3.8 7M6.2 19.8h11.6"/><path d="M4.8 6.8h3M16.2 6.8h3"/>',
  broadcast: '<path d="M5.6 8.2a5.5 5.5 0 0 0 0 7.6M2.8 5.5a9.2 9.2 0 0 0 0 13M18.4 8.2a5.5 5.5 0 0 1 0 7.6M21.2 5.5a9.2 9.2 0 0 1 0 13"/><circle cx="12" cy="12" r="2.3"/><path d="M12 14.3v6"/>',
  shield: '<path d="M12 2.8 19 5.5v5.7c0 4.4-2.7 7.8-7 10-4.3-2.2-7-5.6-7-10V5.5L12 2.8Z"/><path d="m8.7 12 2.1 2.1 4.6-4.7"/>',
  quarantine: '<path d="M12 2.8 19 5.5v5.7c0 4.4-2.7 7.8-7 10-4.3-2.2-7-5.6-7-10V5.5L12 2.8Z"/><path d="m9 9 6 6M15 9l-6 6"/>',
  rollback: '<path d="M8 7H4V3"/><path d="M4.5 7.2A8.2 8.2 0 1 1 4 16"/><path d="M12 8v4.4l3 1.8"/>',
  send: '<path d="m3 11 17-7-6.5 16-2.7-6.8L3 11Z"/><path d="m10.8 13.2 4-4"/>',
  lock: '<rect x="5" y="10" width="14" height="10.5" rx="2.2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  reset: '<path d="M4.2 8.8A8.4 8.4 0 1 1 5 17"/><path d="M4 3.8v5.5h5.5"/>',
  swap: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
  check: '<path d="m4.5 12.5 4.5 4.3L19.5 6.5"/>',
  play: '<path d="m9 6 9 6-9 6V6Z"/><circle cx="12" cy="12" r="10"/>',
  pause: '<circle cx="12" cy="12" r="10"/><path d="M9.5 8v8M14.5 8v8"/>',
});

const NODE_ICON_NAMES = Object.freeze({
  'https://signals.toolbraid.dev': 'waveform',
  'https://pulse.toolbraid.dev': 'radar',
  'https://source.toolbraid.dev': 'branch',
  'https://deploy.toolbraid.dev': 'deployment',
  'https://status.toolbraid.dev': 'status-board',
  'https://mirage.toolbraid.dev': 'mirage',
  'service.health.read': 'health',
  'release.history.read': 'history',
  'deployment.history.read': 'deployment-history',
  'status.notice.read': 'notice-read',
  'recovery.option.prepare': 'recovery-plan',
  'unsafe.override': 'quarantine',
  'recovery.option.apply': 'rollback',
  'status.notice.publish': 'send',
  toolbraid: 'braid',
});

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function iconMarkup(name, { className = 'ui-icon', label = '' } = {}) {
  const iconName = Object.hasOwn(ICON_PATHS, name) ? name : 'spark';
  const safeClass = /^[a-z0-9 _-]+$/i.test(className) ? className : 'ui-icon';
  const accessibility = label
    ? `role="img" aria-label="${escapeText(label)}"`
    : 'aria-hidden="true"';
  return `<svg class="${safeClass}" data-icon-name="${iconName}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" ${accessibility}>${ICON_PATHS[iconName]}</svg>`;
}

export function iconNameForNode(node) {
  if (!node) return 'spark';
  return NODE_ICON_NAMES[node.semanticId]
    ?? NODE_ICON_NAMES[node.origin]
    ?? (node.type === 'provider' ? 'provider' : node.type === 'mutation' ? 'lock' : 'spark');
}

export function hydrateIcons(root = document) {
  for (const element of root.querySelectorAll('[data-ui-icon]')) {
    element.innerHTML = iconMarkup(element.dataset.uiIcon, {
      className: element.dataset.iconClass || 'ui-icon',
    });
  }
}

export const ICON_NAMES = Object.freeze(Object.keys(ICON_PATHS));
