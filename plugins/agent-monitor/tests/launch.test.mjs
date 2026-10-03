import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function hostHarness({ earlyResult, agents = [], detailsResponder } = {}) {
  const source = (await readFile(new URL('../ui/app.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '')
    .replace(/function render\(\) \{[\s\S]*?\nfunction renderSessions/, 'function render() { acceptedRoots.push(snapshot.root_id); }\nfunction renderSessions')
    .replace(/function renderDetail\(data\) \{[\s\S]*?\nfunction renderModelControl/, 'function renderDetail() {}\nfunction renderModelControl')
    .replace(/function renderModelControl\(agent\) \{[\s\S]*?\nfunction renderEfforts/, 'function renderModelControl() {}\nfunction renderEfforts')
    .replace(/function renderNodeDetails\(agent\) \{[\s\S]*?\nasync function loadNodeDetails/, 'function renderNodeDetails() {}\nasync function loadNodeDetails');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { classList: { toggle() {}, remove() {} }, addEventListener() {}, querySelectorAll: () => [], replaceChildren() {}, style: {}, value: 'all' });
    return elements.get(id);
  };
  const calls = [], acceptedRoots = [];
  let instance;
  class App {
    constructor() { instance = this; }
    async connect() { if (earlyResult) this.ontoolresult({ structuredContent: earlyResult }); }
    getHostContext() { return {}; }
    async callServerTool(request) {
      calls.push(request);
      if (request.name === 'get_agent_details') return detailsResponder ? detailsResponder(request) : { structuredContent: { public_process: [], result: agents[0]?.status === 'done' ? 'completed answer' : '' } };
      if (request.name === 'get_agent_model_settings') return { structuredContent: { models: [], controllable: false } };
      return { structuredContent: { root_id: request.arguments.sessionId || 'latest', agents, flows: [] } };
    }
  }
  const context = vm.createContext({ App, acceptedRoots, console, matchMedia: () => ({ matches: false }),
    document: { getElementById: element, documentElement: { dataset: {} }, addEventListener() {}, hidden: false },
    window: { parent: {}, addEventListener() {} }, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { instance, calls, acceptedRoots, context };
}

test('delayed host launch cannot race an initial latest-session refresh', async () => {
  const host = await hostHarness();
  assert.equal(host.calls.length, 0);
  host.instance.ontoolinput({ arguments: { sessionId: 'chosen', mode: 'live' } });
  host.instance.ontoolresult({ structuredContent: { root_id: 'chosen', agents: [], flows: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.calls[0].arguments.sessionId, 'chosen');
  assert(host.acceptedRoots.every(id => id === 'chosen'));
});

test('host result pins selected root even if launch arguments are absent', async () => {
  const host = await hostHarness();
  host.instance.ontoolresult({ structuredContent: { root_id: 'chosen', agents: [], flows: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.calls[0].arguments.sessionId, 'chosen');
});

test('an early host result defers details and model reads until the app connects', async () => {
  const agents = [{ id: 'chosen', status: 'running', updated_at: 'initial' }];
  const host = await hostHarness({ agents, earlyResult: { root_id: 'chosen', agents, flows: [] } });
  assert.equal(host.calls.filter(call => call.name === 'get_agent_details').length, 1);
  assert.equal(host.calls.filter(call => call.name === 'get_agent_model_settings').length, 1);
  assert(host.calls.filter(call => call.name !== 'get_agent_snapshot').every(call => call.arguments.sessionId === 'chosen'));
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
