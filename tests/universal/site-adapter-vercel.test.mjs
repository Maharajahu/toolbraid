import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPageSnapshot, generateWebMcpToolDescriptors, prepareAction } from '../../src/universal/index.js';
import {
  SiteAdapterError,
  createSiteAdapterRegistry,
  createVercelAdapter,
  extractVercelPage,
  parseVercelRoute,
} from '../../src/site-adapters/index.js';

const FIXTURE_ROOT = new URL('../../fixtures/universal/', import.meta.url);

async function fixture(name) {
  const text = await readFile(new URL(name, FIXTURE_ROOT), 'utf8');
  return createPageSnapshot(JSON.parse(text));
}

function urlSnapshot(url, extra = {}) {
  return createPageSnapshot({
    metadata: { url, origin: (() => { try { return new URL(url).origin; } catch { return ''; } })(), ...extra.metadata },
    headings: extra.headings ?? [],
    mainText: extra.mainText ?? '',
    links: extra.links ?? [],
    forms: [],
    accessibleControls: [],
    elementRefs: [],
  });
}

function deploymentSnapshot({
  id = 'dpl_123',
  state = 'READY',
  controls = [],
  owner = 'toolbraid',
  project = 'mission-control',
  commitSha = '0123456789abcdef0123456789abcdef01234567',
  host = 'vercel.com',
} = {}) {
  const url = `https://${host}/${owner}/${project}/${id}`;
  return createPageSnapshot({
    metadata: {
      url,
      origin: `https://${host}`,
      title: `${id} - Vercel`,
      vercel: { deployment: { id, state, commitSha } },
    },
    headings: [{ ref: 'deployment-heading', level: 1, text: id }],
    mainText: `${id} ${state}`,
    links: [],
    forms: [],
    accessibleControls: controls,
    elementRefs: [],
  });
}

test('Vercel adapter recognizes exact project and deployment routes', async () => {
  const cases = [
    ['vercel-project.snapshot.json', 'project', 'read_vercel_project'],
    ['vercel-deployment.snapshot.json', 'deployment', 'read_vercel_deployment'],
  ];
  const registry = createSiteAdapterRegistry({ adapters: [createVercelAdapter()] });

  for (const [name, kind, toolName] of cases) {
    const snapshot = await fixture(name);
    assert.deepEqual(parseVercelRoute(snapshot).kind, kind);
    assert.deepEqual(registry.resolve(snapshot), [{ id: 'vercel', version: '1', priority: 90 }]);
    const tools = registry.generateTools(snapshot);
    assert.deepEqual(tools.map((tool) => tool.name), [toolName]);
    const [tool] = tools;
    assert.equal(tool.adapter.id, 'vercel');
    assert.equal(tool.provenance.source, 'toolbraid.verified-adapter');
    assert.equal(tool.provenance.adapterId, 'vercel');
    assert.equal(tool.provenance.pageFingerprint, snapshot.pageFingerprint);
    assert.equal(tool.classification, 'read');
    assert.equal(tool.kind, 'read');
    assert.equal(tool.risk, 'read-only');
    assert.equal(tool.requiresApproval, false);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.untrustedContentHint, true);
    assert.equal(tool.effect.externalStateChange, false);
    assert.equal(tool.effect.requiresApproval, false);
    assert.equal(tool.target.ref, null);
    assert.equal(Object.prototype.hasOwnProperty.call(tool, 'execute'), false);
  }
});

test('Vercel adapter returns structured project and deployment evidence as untrusted receipts', async () => {
  const registry = createSiteAdapterRegistry({ adapters: [createVercelAdapter()] });

  const project = await fixture('vercel-project.snapshot.json');
  const projectResult = registry.executeRead(registry.generateTools(project)[0], project);
  assert.equal(projectResult.type, 'vercel-project');
  assert.equal(projectResult.project.name, 'mission-control');
  assert.equal(projectResult.project.owner, 'toolbraid');
  assert.equal(projectResult.project.team, 'toolbraid');
  assert.equal(projectResult.framework, 'Next.js');
  assert.equal(projectResult.productionDomain, 'mission-control.example');
  assert.equal(projectResult.repositoryUrl, 'https://github.com/toolbraid/mission-control');
  assert.equal(projectResult.latestDeployment.id, 'dpl_123');
  assert.deepEqual(projectResult.environments, ['production', 'preview', 'development']);
  assert.equal(projectResult.pageFingerprint, project.pageFingerprint);
  assert.equal(projectResult.provenance, 'toolbraid.verified-adapter/vercel');
  assert.equal(projectResult.untrustedContent, true);

  const deployment = await fixture('vercel-deployment.snapshot.json');
  const deploymentResult = registry.executeRead(registry.generateTools(deployment)[0], deployment);
  assert.equal(deploymentResult.type, 'vercel-deployment');
  assert.equal(deploymentResult.deploymentId, 'dpl_123');
  assert.equal(deploymentResult.deploymentUrl, 'https://mission-control-abc.vercel.app/');
  assert.equal(deploymentResult.environment, 'production');
  assert.equal(deploymentResult.durationMs, 60000);
  assert.equal(deploymentResult.creator, 'toolbraid');
  assert.equal(deploymentResult.checks.length, 2);
  assert.equal(deploymentResult.build.status, 'succeeded');
  assert.equal(deploymentResult.untrustedContent, true);
});

test('Vercel extraction is bounded and rejects unsafe metadata URLs', () => {
  const environments = Array.from({ length: 40 }, (_, index) => ({ name: `env-${index}` }));
  const snapshot = createPageSnapshot({
    metadata: {
      url: 'https://acme.vercel.com/widget/dpl_1',
      title: 'Deployment',
      vercel: {
        deployment: {
          deploymentUrl: 'javascript:alert(1)',
          creator: { username: 'builder' },
          checks: Array.from({ length: 100 }, (_, index) => ({ name: `check-${index}`, state: 'passed' })),
        },
        environments,
      },
    },
    headings: [{ level: 1, text: 'Deployment' }],
    mainText: 'Deployment',
    links: [
      { href: 'https://evilgithub.com/acme/widget', text: 'fake repo' },
      { href: 'https://widget.evil.vercel.app', text: 'deployment' },
    ],
    forms: [],
    accessibleControls: [],
    elementRefs: [],
  });
  assert.equal(parseVercelRoute(snapshot), null);
  assert.equal(extractVercelPage(snapshot), null);

  const valid = createPageSnapshot({
    metadata: {
      ...Object.fromEntries(Object.entries(snapshot.metadata).filter(([key]) => key !== 'pageFingerprint' && key !== 'fingerprint')),
      url: 'https://vercel.com/acme/widget/dpl_1',
      vercel: {
        deployment: snapshot.metadata.vercel.deployment,
        environments,
      },
    },
  });
  const result = extractVercelPage(valid);
  assert.equal(result.deploymentUrl, null);
  assert.equal(result.creator, 'builder');
  assert.equal(result.checks.length, 32);
});

test('Vercel adapter rejects lookalike hosts, dashboard/list paths, unsafe schemes, and stale snapshots', async () => {
  const registry = createSiteAdapterRegistry({ adapters: [createVercelAdapter()] });
  const lookalikes = [
    'https://vercel.com.attacker.test/acme/widget',
    'https://vercel.com/docs/concepts',
    'https://vercel.com/acme/widget/deployments',
    'https://vercel.com/acme/widget/settings',
    'https://vercel.com/acme//widget',
    'http://vercel.com/acme/widget',
  ];
  for (const url of lookalikes) {
    const snapshot = urlSnapshot(url);
    assert.equal(parseVercelRoute(snapshot), null, url);
    assert.deepEqual(registry.generateTools(snapshot), [], url);
  }

  const original = await fixture('vercel-project.snapshot.json');
  const tool = registry.generateTools(original)[0];
  const changed = createPageSnapshot({
    metadata: { ...original.metadata, title: 'Changed after generation' },
    headings: original.headings,
    mainText: original.mainText,
    links: original.links,
    forms: original.forms,
    accessibleControls: original.accessibleControls,
    elementRefs: original.elementRefs,
  });
  assert.notEqual(changed.pageFingerprint, original.pageFingerprint);
  assert.throws(
    () => registry.executeRead(tool, changed),
    (error) => error instanceof SiteAdapterError && error.code === 'ADAPTER_PAGE_DRIFT',
  );
});

test('Vercel adapter supports an explicit test host without widening the default allowlist', () => {
  const snapshot = urlSnapshot('https://vercel.example/acme/widget', {
    metadata: { vercel: { project: { name: 'widget' } } },
  });
  assert.equal(parseVercelRoute(snapshot), null);
  const adapter = createVercelAdapter({ hosts: ['vercel.example'] });
  const registry = createSiteAdapterRegistry({ adapters: [adapter] });
  assert.equal(registry.generateTools(snapshot)[0].name, 'read_vercel_project');
});

test('Vercel mutation verification preserves an explicit adapter host binding', () => {
  const adapter = createVercelAdapter({ hosts: ['vercel.example'] });
  const registry = createSiteAdapterRegistry({ adapters: [adapter] });
  const before = deploymentSnapshot({
    owner: 'acme',
    project: 'widget',
    id: 'dpl-old',
    state: 'READY',
    controls: [{ ref: 'redeploy', role: 'button', type: 'button', name: 'Redeploy' }],
    host: 'vercel.example',
  });
  const customBefore = before;
  const customAfter = createPageSnapshot({
    metadata: {
      ...customBefore.metadata,
      url: 'https://vercel.example/acme/widget/dpl-new',
      origin: 'https://vercel.example',
      vercel: { deployment: { id: 'dpl-new', state: 'BUILDING', commitSha: '0123456789abcdef0123456789abcdef01234567' } },
    },
    headings: customBefore.headings,
    mainText: customBefore.mainText,
    links: customBefore.links,
    forms: customBefore.forms,
    accessibleControls: customBefore.accessibleControls,
    elementRefs: customBefore.elementRefs,
  });
  const redeploy = registry.generateTools(customBefore).find((tool) => tool.name === 'redeploy_vercel_deployment');
  assert.ok(redeploy);
  assert.equal(registry.verifyPostcondition(redeploy, {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-vercel-custom-host',
    beforeSnapshot: customBefore,
    afterSnapshot: customAfter,
  }).status, 'verified-success');
});

test('Vercel specialized reads add structured semantics without duplicating generic page tools or claiming mutation', async () => {
  const snapshot = await fixture('vercel-project.snapshot.json');
  const registry = createSiteAdapterRegistry({ adapters: [createVercelAdapter()] });
  const verified = registry.generateTools(snapshot);
  const generic = generateWebMcpToolDescriptors(snapshot, { includePageRead: true });
  assert.equal(verified.length, 1);
  assert.equal(generic.some((tool) => tool.name === verified[0].name), false);
  assert.equal(verified[0].target.ref, null);
  assert.equal(verified[0].classification, 'read');
  assert.equal(verified[0].requiresApproval, false);
  assert.equal(verified[0].effect.externalStateChange, false);
  assert.equal(verified[0].annotations.readOnlyHint, true);
});

test('Vercel exposes only one exact enabled redeploy control on a known redeployable deployment', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createVercelAdapter()] });
  const duplicate = deploymentSnapshot({
    controls: [
      { ref: 'redeploy-1', role: 'button', type: 'button', name: 'Redeploy' },
      { ref: 'redeploy-2', role: 'button', type: 'button', name: 'Redeploy deployment' },
    ],
  });
  assert.deepEqual(registry.generateTools(duplicate).map((tool) => tool.name), ['read_vercel_deployment']);

  const disabledDuplicate = deploymentSnapshot({
    controls: [
      { ref: 'redeploy-disabled', role: 'button', type: 'button', name: 'Redeploy', disabled: true },
      { ref: 'redeploy-enabled', role: 'button', type: 'button', name: 'Redeploy' },
    ],
  });
  assert.deepEqual(registry.generateTools(disabledDuplicate).map((tool) => tool.name), ['read_vercel_deployment']);

  const snapshot = deploymentSnapshot({
    controls: [
      { ref: 'redeploy', role: 'button', type: 'button', name: 'Redeploy' },
      { ref: 'cancel', role: 'button', type: 'button', name: 'Cancel deployment', disabled: true },
    ],
  });
  const tools = registry.generateTools(snapshot);
  const redeploy = tools.find((tool) => tool.name === 'redeploy_vercel_deployment');
  assert.ok(redeploy);
  assert.equal(redeploy.classification, 'mutate');
  assert.equal(redeploy.kind, 'mutate');
  assert.equal(redeploy.requiresApproval, true);
  assert.equal(redeploy.effect.externalStateChange, true);
  assert.equal(redeploy.effect.requiresApproval, true);
  assert.equal(redeploy.annotations.readOnlyHint, false);
  assert.equal(redeploy.target.ref, 'redeploy');
  assert.equal(redeploy.target.type, 'control');
  assert.deepEqual(redeploy.target.binding, {
    role: 'button',
    name: 'Redeploy',
    formRef: null,
    type: 'button',
  });
  assert.equal(redeploy.sourceType, 'control');
  assert.equal(redeploy.postcondition.id, 'vercel.deployment.redeploy.v1');
  assert.doesNotThrow(() => prepareAction({ snapshot, descriptor: redeploy, input: {} }));
});

test('Vercel exposes cancel only for one enabled cancel control while deployment is active', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createVercelAdapter()] });
  const active = deploymentSnapshot({
    id: 'dpl-building',
    state: 'BUILDING',
    controls: [{ ref: 'cancel', role: 'button', type: 'button', name: 'Cancel deployment' }],
  });
  const cancel = registry.generateTools(active).find((tool) => tool.name === 'cancel_vercel_deployment');
  assert.ok(cancel);
  assert.equal(cancel.target.ref, 'cancel');
  assert.equal(cancel.postcondition.id, 'vercel.deployment.cancel.v1');

  const alreadyReady = deploymentSnapshot({
    state: 'READY',
    controls: [{ ref: 'cancel', role: 'button', type: 'button', name: 'Cancel deployment' }],
  });
  assert.equal(registry.generateTools(alreadyReady).some((tool) => tool.name === 'cancel_vercel_deployment'), false);

  const duplicate = deploymentSnapshot({
    id: 'dpl-duplicate',
    state: 'QUEUED',
    controls: [
      { ref: 'cancel-1', role: 'button', type: 'button', name: 'Cancel' },
      { ref: 'cancel-2', role: 'button', type: 'button', name: 'Stop deployment' },
    ],
  });
  assert.equal(registry.generateTools(duplicate).some((tool) => tool.name === 'cancel_vercel_deployment'), false);

  const genericLive = deploymentSnapshot({ state: null, controls: [
    { ref: 'redeploy-live', role: 'button', type: 'button', name: 'Redeploy' },
    { ref: 'cancel-live', role: 'button', type: 'button', name: 'Cancel deployment' },
  ] });
  assert.deepEqual(registry.generateTools(genericLive)
    .filter((tool) => tool.classification === 'mutate')
    .map((tool) => tool.name).sort(), ['cancel_vercel_deployment', 'redeploy_vercel_deployment']);
});

test('Vercel rejects lookalike, disabled, project-level, and target-drift mutation controls', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createVercelAdapter()] });
  const lookalikes = deploymentSnapshot({
    controls: [
      { ref: 'deploy', role: 'button', type: 'button', name: 'Deploy' },
      { ref: 'project-redeploy', role: 'button', type: 'button', name: 'Redeploy project' },
      { ref: 'hidden-cancel', role: 'button', type: 'button', name: 'Cancel deployment', attributes: { 'aria-hidden': 'true' } },
      { ref: 'aria-disabled', role: 'button', type: 'button', name: 'Redeploy', attributes: { 'ariaDisabled': 'true' } },
    ],
  });
  assert.deepEqual(registry.generateTools(lookalikes).map((tool) => tool.name), ['read_vercel_deployment']);

  const original = deploymentSnapshot({ controls: [{ ref: 'redeploy', role: 'button', type: 'button', name: 'Redeploy' }] });
  const tool = registry.generateTools(original).find((entry) => entry.name === 'redeploy_vercel_deployment');
  const changed = deploymentSnapshot({ controls: [{ ref: 'redeploy', role: 'button', type: 'button', name: 'Redeploy another deployment' }] });
  assert.throws(() => prepareAction({ snapshot: changed, descriptor: tool, input: {} }), /page changed|fingerprint/i);
});

test('Vercel postconditions require a same-project state transition and never claim stale success', () => {
  const registry = createSiteAdapterRegistry({ adapters: [createVercelAdapter()] });
  const beforeRedeploy = deploymentSnapshot({
    id: 'dpl-old',
    state: 'READY',
    controls: [{ ref: 'redeploy', role: 'button', type: 'button', name: 'Redeploy' }],
  });
  const redeploy = registry.generateTools(beforeRedeploy).find((tool) => tool.name === 'redeploy_vercel_deployment');
  const afterRedeploy = deploymentSnapshot({ id: 'dpl-new', state: 'BUILDING' });
  const redeployResult = registry.verifyPostcondition(redeploy, {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-vercel-redeploy',
    beforeSnapshot: beforeRedeploy,
    afterSnapshot: afterRedeploy,
  });
  assert.equal(redeployResult.status, 'verified-success');
  assert.equal(redeployResult.reasonCode, 'VERCEL_REDEPLOY_STATE_CONFIRMED');

  const genericBefore = deploymentSnapshot({ id: 'dpl-generic-old', state: null, controls: [
    { ref: 'redeploy-generic', role: 'button', type: 'button', name: 'Redeploy' },
  ] });
  const genericRedeploy = registry.generateTools(genericBefore).find((tool) => tool.name === 'redeploy_vercel_deployment');
  const genericAfter = deploymentSnapshot({ id: 'dpl-generic-new', state: null });
  assert.equal(registry.verifyPostcondition(genericRedeploy, {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-vercel-generic',
    beforeSnapshot: genericBefore,
    afterSnapshot: genericAfter,
  }).status, 'verified-success');

  const unchanged = registry.verifyPostcondition(redeploy, {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-vercel-redeploy',
    beforeSnapshot: beforeRedeploy,
    afterSnapshot: deploymentSnapshot({ id: 'dpl-old', state: 'READY' }),
  });
  assert.equal(unchanged.status, 'unverified');

  const wrongProject = registry.verifyPostcondition(redeploy, {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-vercel-redeploy',
    beforeSnapshot: beforeRedeploy,
    afterSnapshot: deploymentSnapshot({ owner: 'attacker', id: 'dpl-new', state: 'BUILDING' }),
  });
  assert.equal(wrongProject.status, 'unverified');

  const beforeCancel = deploymentSnapshot({
    id: 'dpl-cancel',
    state: 'BUILDING',
    controls: [{ ref: 'cancel', role: 'button', type: 'button', name: 'Cancel deployment' }],
  });
  const cancel = registry.generateTools(beforeCancel).find((tool) => tool.name === 'cancel_vercel_deployment');
  const canceled = registry.verifyPostcondition(cancel, {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-vercel-cancel',
    beforeSnapshot: beforeCancel,
    afterSnapshot: deploymentSnapshot({ id: 'dpl-cancel', state: 'CANCELED' }),
  });
  assert.equal(canceled.status, 'verified-success');
  assert.equal(canceled.reasonCode, 'VERCEL_CANCEL_STATE_CONFIRMED');

  const notCanceled = registry.verifyPostcondition(cancel, {
    tabId: 1,
    frameId: 0,
    sessionId: 'session-vercel-cancel',
    beforeSnapshot: beforeCancel,
    afterSnapshot: deploymentSnapshot({ id: 'dpl-cancel', state: 'READY' }),
  });
  assert.equal(notCanceled.status, 'unverified');
});
