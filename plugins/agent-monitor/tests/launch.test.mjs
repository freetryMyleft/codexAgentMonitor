import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as catalog from '../ui/catalog.js';

async function hostHarness({ earlyResult, agents = [], detailsResponder, catalogResponder } = {}) {
  const source = (await readFile(new URL('../ui/app.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '')
    .replace(/function render\(\) \{[\s\S]*?\nfunction renderSessions/, 'function render() { acceptedRoots.push(snapshot.root_id); }\nfunction renderSessions')
    .replace(/function renderDetail\(data\) \{[\s\S]*?\nfunction renderModelControl/, 'function renderDetail() {}\nfunction renderModelControl')
    .replace(/function renderModelControl\(agent\) \{[\s\S]*?\nfunction renderEfforts/, 'function renderModelControl() {}\nfunction renderEfforts')
    .replace(/function renderNodeDetails\(agent\) \{[\s\S]*?\nasync function loadNodeDetails/, 'function renderNodeDetails() {}\nasync function loadNodeDetails');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { classList: { toggle() {}, remove() {} }, addEventListener() {}, querySelectorAll: () => [], replaceChildren() {}, add() {}, dataset: {}, style: {}, value: id === 'catalog-search' || id === 'catalog-project' ? '' : 'all' });
    return elements.get(id);
  };
  const calls = [], acceptedRoots = [];
  let instance;
  class App {
    constructor() { instance = this; }
    async connect() {
      if (earlyResult) {
        if (earlyResult.root_id) this.ontoolinput({ arguments: { sessionId: earlyResult.root_id, mode: earlyResult.demo ? 'demo' : 'live' } });
        this.ontoolresult({ structuredContent: earlyResult });
      }
    }
    getHostContext() { return {}; }
    async callServerTool(request) {
      calls.push(request);
      if (request.name === 'list_agent_sessions') return catalogResponder ? catalogResponder(request) : { structuredContent: { sessions: [], total: 0, offset: request.arguments.offset || 0, next_offset: null, revision: 'empty-revision', warning: '' } };
      if (request.name === 'get_agent_details') return detailsResponder ? detailsResponder(request) : { structuredContent: { public_process: [], result: agents[0]?.status === 'done' ? 'completed answer' : '' } };
      if (request.name === 'get_agent_model_settings') return { structuredContent: { models: [], controllable: false } };
      return { structuredContent: { root_id: request.arguments.sessionId || null, agents: request.arguments.sessionId ? agents : [], flows: [] } };
    }
  }
  const context = vm.createContext({ App, acceptedRoots, ...catalog, esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'), Option: class Option { constructor(text, value) { this.text = text; this.value = value; } }, console, matchMedia: () => ({ matches: false }),
    document: { getElementById: element, documentElement: { dataset: {} }, addEventListener() {}, hidden: false },
    window: { parent: {}, addEventListener() {} }, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { instance, calls, acceptedRoots, context };
}

async function waitFor(context, expression) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!vm.runInContext(expression, context)) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${expression}`);
}

async function waitForInitialCatalog(host) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
    const requested = host.calls.some(call => call.name === 'list_agent_sessions');
    if (requested && !vm.runInContext('catalogBusy', host.context)) return;
  }
  assert.fail('Timed out waiting for the initial catalog refresh');
}

test('explicit launch selection remains pinned while initial refresh is pending', async () => {
  const host = await hostHarness();
  assert.equal(host.calls.some(call => call.name === 'get_agent_snapshot'), false);
  host.instance.ontoolinput({ arguments: { sessionId: 'chosen', mode: 'live' } });
  host.instance.ontoolresult({ structuredContent: { root_id: 'chosen', agents: [], flows: [] } });
  await new Promise(resolve => setImmediate(resolve));
  const snapshotCall = host.calls.find(call => call.name === 'get_agent_snapshot');
  assert.equal(snapshotCall.arguments.sessionId, 'chosen');
  assert(host.acceptedRoots.every(id => id === 'chosen'));
});

test('opening without an explicit session remains on the unselected hub', async () => {
  const host = await hostHarness();
  host.instance.ontoolresult({ structuredContent: { root_id: null, sessions: [], agents: [], flows: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.calls[0].arguments.sessionId, undefined);
  assert.equal(vm.runInContext('selectedId', host.context), undefined);
  assert.equal(host.calls.some(call => call.name === 'get_agent_details'), false);
  assert.equal(host.calls.some(call => call.name === 'get_agent_model_settings'), false);
});

test('failed open still allows an independent catalog refresh', async () => {
  const host = await hostHarness();
  host.instance.ontoolresult({ isError: true, content: [{ type: 'text', text: '所选会话不可读' }] });
  await new Promise(resolve => setImmediate(resolve));
  await vm.runInContext('refresh()', host.context);
  assert(host.calls.some(call => call.name === 'get_agent_snapshot'));
  assert.equal(host.calls.some(call => call.name === 'get_agent_details'), false);
  assert.equal(vm.runInContext('launchPending', host.context), false);
});

test('host metadata is not attached as an implicit session binding', async () => {
  const host = await hostHarness();
  host.instance.ontoolresult({ structuredContent: { root_id: null, agents: [], flows: [], binding: { source: 'unselected', label: '先选择会话' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('snapshot.binding.source', host.context), 'unselected');
  assert.equal(vm.runInContext('sessionId', host.context), undefined);
});

test('unselected state survives subsequent refreshes without a latest-session warning', async () => {
  const host = await hostHarness();
  host.instance.ontoolresult({ structuredContent: { root_id: null, agents: [], flows: [], binding: { source: 'unselected', label: '先选择会话' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('snapshot.root_id', host.context), null);
  assert.doesNotMatch(vm.runInContext('snapshot.warning || ""', host.context), /最近更新|未提供会话绑定/);
});

test('catalog reads every page with a stable revision and explicit refresh flags', async () => {
  const sessions = Array.from({ length: 205 }, (_, index) => ({ id: `session-${index}`, cwd: '/fixture', status: 'unknown' }));
  const host = await hostHarness({ catalogResponder: request => {
    const { offset = 0, limit = 100 } = request.arguments;
    return { structuredContent: { sessions: sessions.slice(offset, offset + limit), total: sessions.length,
      offset, next_offset: offset + limit < sessions.length ? offset + limit : null, revision: 'rev-a', warning: '' } };
  } });
  await waitForInitialCatalog(host);
  const before = host.calls.length;
  const catalogData = await vm.runInContext('readWholeCatalog()', host.context);
  const requests = host.calls.slice(before).filter(call => call.name === 'list_agent_sessions').map(call => call.arguments);
  assert.equal(catalogData.sessions.length, 205);
  assert.equal(catalogData.sessions.at(-1).id, 'session-204');
  assert.deepEqual(requests.map(request => request.offset), [0, 100, 200]);
  assert.deepEqual(requests.map(request => request.refresh), [true, false, false]);
  assert.deepEqual(requests.slice(1).map(request => request.revision), ['rev-a', 'rev-a']);
});

test('catalog restarts from page zero when its revision changes mid-read', async () => {
  const requestsSeen = [];
  let readAttempt = 0;
  const host = await hostHarness({ catalogResponder: request => {
    const { offset = 0, limit = 100, revision } = request.arguments;
    requestsSeen.push({ offset, revision, refresh: request.arguments.refresh });
    if (offset === 100 && revision === 'old-rev') return { isError: true, content: [{ type: 'text', text: '目录已更新，请重新载入。' }] };
    if (offset === 0) readAttempt++;
    const currentRevision = readAttempt === 1 ? 'old-rev' : 'new-rev';
    const chunk = Array.from({ length: Math.min(limit, 101 - offset) }, (_, index) => ({ id: `session-${offset + index}` }));
    return { structuredContent: { sessions: chunk, total: 101, offset,
      next_offset: offset + chunk.length < 101 ? offset + chunk.length : null,
      revision: offset === 0 ? currentRevision : revision, warning: '' } };
  } });
  await waitForInitialCatalog(host);
  readAttempt = 0;
  const start = requestsSeen.length;
  const data = await vm.runInContext('readWholeCatalog()', host.context);
  assert.equal(data.sessions.length, 101);
  assert.deepEqual(requestsSeen.slice(start).map(request => [request.offset, request.revision, request.refresh]), [
    [0, undefined, true], [100, 'old-rev', false], [0, undefined, true], [100, 'new-rev', false],
  ]);
});

test('catalog refresh failure preserves the selected tree and session', async () => {
  let failCatalog = false;
  const agents = [{ id: 'chosen', status: 'running', updated_at: 'initial' }];
  const host = await hostHarness({ agents, earlyResult: { root_id: 'chosen', agents, flows: [] }, catalogResponder: request => {
    if (failCatalog) return { isError: true, content: [{ type: 'text', text: '目录读取失败。' }] };
    return { structuredContent: { sessions: [], total: 0, offset: request.arguments.offset || 0,
      next_offset: null, revision: 'rev-a', warning: '' } };
  } });
  await waitForInitialCatalog(host);
  failCatalog = true;
  await vm.runInContext('refreshCatalog()', host.context);
  assert.equal(vm.runInContext('snapshot.root_id', host.context), 'chosen');
  assert.equal(vm.runInContext('sessionId', host.context), 'chosen');
  assert.equal(vm.runInContext('selectedId', host.context), 'chosen');
});

test('an early host result defers details and model reads until the app connects', async () => {
  const agents = [{ id: 'chosen', status: 'running', updated_at: 'initial' }];
  const host = await hostHarness({ agents, earlyResult: { root_id: 'chosen', agents, flows: [] } });
  assert.equal(host.calls.filter(call => call.name === 'get_agent_details').length, 1);
  assert.equal(host.calls.filter(call => call.name === 'get_agent_model_settings').length, 1);
  assert(host.calls.filter(call => ['get_agent_details', 'get_agent_model_settings'].includes(call.name)).every(call => call.arguments.sessionId === 'chosen'));
});

test('completion of the selected running node refreshes its result without reselection', async () => {
  const agents = [{ id: 'chosen', status: 'running', updated_at: 'initial' }];
  const host = await hostHarness({ agents, earlyResult: { root_id: 'chosen', agents, flows: [] } });
  agents[0].status = 'done'; agents[0].updated_at = 'completed';
  await vm.runInContext('refresh()', host.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.calls.filter(call => call.name === 'get_agent_details').length, 2);
  assert.equal(vm.runInContext('detailMap.get("chosen").result', host.context), 'completed answer');
});

test('an unconfirmed update blocks resubmission until an explicit settings reload', async () => {
  const host = await hostHarness();
  vm.runInContext('modelStates.set("chosen", { data: { controllable: true }, model: "a", effort: "low", scope: "future" }); let updates = 0; modelTool = async () => { updates++; throw new Error("network timeout"); };', host.context);
  await vm.runInContext('applyModel({ id: "chosen" })', host.context);
  assert.equal(vm.runInContext('modelStates.get("chosen").requiresReload', host.context), true);
  assert.match(vm.runInContext('modelStates.get("chosen").message', host.context), /结果未确认.*重新读取/);
  await vm.runInContext('applyModel({ id: "chosen" })', host.context);
  assert.equal(vm.runInContext('updates', host.context), 1);
});

test('rapid A to B to A selection preserves each pending node response', async () => {
  const agents = [{ id: 'chosen', status: 'running' }, { id: 'other', status: 'running' }];
  const pending = new Map();
  const host = await hostHarness({ agents, earlyResult: { root_id: 'chosen', agents, flows: [] },
    detailsResponder: request => new Promise(resolve => pending.set(request.arguments.agentId, resolve)) });
  vm.runInContext('selectedId = "other"; void loadNodeDetails(snapshot.agents[1]); selectedId = "chosen"; void loadNodeDetails(snapshot.agents[0]);', host.context);
  pending.get('chosen')({ structuredContent: { public_process: [], result: 'answer A' } });
  pending.get('other')({ structuredContent: { public_process: [], result: 'answer B' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('detailMap.get("chosen").result', host.context), 'answer A');
  assert.equal(vm.runInContext('detailMap.get("other").result', host.context), 'answer B');
  assert.equal(vm.runInContext('selectedId', host.context), 'chosen');
  assert.equal(host.calls.filter(call => call.name === 'get_agent_details').length, 2);
});
