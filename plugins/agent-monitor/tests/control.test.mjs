import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { AgentControl } from '../control.mjs';
import { MonitorBackend } from '../backend.mjs';

// Exercise the real Unix/WebSocket RPC transport against a local fixture.
// No account, inference call, persisted real session or Codex config is changed.
async function fixture(t, { timeoutMs = 3000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-rpc-'));
  const socketPath = join(directory, 'control.sock');
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const state = { loaded: true, active: true, turnId: 'turn-a', model: 'model-a', effort: 'high', writes: [], calls: [], dropWrites: false, wrongRead: false, turnUnavailable: false };
  ws.on('connection', socket => socket.on('message', bytes => {
    const message = JSON.parse(bytes);
    if (!message.id) return;
    if (state.noise) socket.send('null');
    state.calls.push(message);
    let result = {};
    if (message.method === 'model/list') result = { data: [{ model: 'model-a', displayName: 'A', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
      { model: 'model-b', displayName: 'B', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }] };
    if (message.method === 'thread/read') result = { thread: { id: state.wrongRead ? 'other' : message.params.threadId, model: state.model, reasoningEffort: state.effort,
      status: { type: state.loaded ? state.active ? 'active' : 'idle' : 'notLoaded' } } };
    if (message.method === 'thread/turns/list') result = { data: state.active ? [{ id: state.turnId, status: 'inProgress', items: [] }] : [] };
    if (message.method.endsWith('settings/update')) {
      state.writes.push(message);
      if (state.dropWrites) return;
      if (message.method === 'thread/settings/update') { state.model = message.params.model; state.effort = message.params.effort; }
      else result = { status: state.turnUnavailable ? 'targetUnavailable' : 'applied' };
    }
    socket.send(JSON.stringify({ id: message.id, result }));
  }));
  http.listen(socketPath); await once(http, 'listening');
  const control = new AgentControl({ socketPath, timeoutMs });
  t.after(async () => {
    control.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => http.close(resolve));
    await rm(directory, { recursive: true });
  });
  return { state, control };
}

test('connects once, reads only metadata and verifies future configuration', async t => {
  const { state, control } = await fixture(t);
  const [a, b] = await Promise.all([control.settings('agent-a'), control.settings('agent-b')]);
  assert.equal(a.active_turn_id, 'turn-a');
  assert.equal(b.configured_model, 'model-a');
  assert.equal(state.calls.filter(call => call.method === 'initialize').length, 1);
  assert(state.calls.filter(call => call.method === 'thread/read').every(call => call.params.includeTurns === false));
  assert(state.calls.filter(call => call.method === 'thread/turns/list').every(call => call.params.itemsView === 'notLoaded'));
  const applied = await control.update({ agentId: 'agent-b', model: 'model-b', effort: 'low', scope: 'future' });
  assert.equal(applied.configured_model, 'model-b');
  assert.equal(applied.configured_effort, 'low');
  assert.equal(state.writes[0].params.threadId, 'agent-b');
  assert.equal(state.writes[0].method, 'thread/settings/update');
});

test('current-turn update targets only the checked turn and preserves future settings', async t => {
  const { state, control } = await fixture(t);
  const applied = await control.update({ agentId: 'agent-a', model: 'model-b', effort: 'medium', scope: 'current', turnId: 'turn-a' });
  assert.equal(applied.applied_model, 'model-b');
  assert.equal(applied.configured_model, 'model-a');
  assert.deepEqual(state.writes[0].params, { threadId: 'agent-a', turnId: 'turn-a', model: 'model-b', effort: 'medium' });
  assert.equal(state.writes[0].method, 'turn/settings/update');
  state.turnId = 'turn-b';
  await assert.rejects(control.update({ agentId: 'agent-a', model: 'model-b', effort: 'low', scope: 'current', turnId: 'turn-a' }), /轮次已变化/);
  assert.equal(state.writes.length, 1);
});

test('unloaded node, mismatched identity, unknown model and invalid effort cannot write', async t => {
  const { state, control } = await fixture(t);
  const input = { agentId: 'agent-a', model: 'model-b', effort: 'low', scope: 'future' };
  state.loaded = false;
  await assert.rejects(control.update(input), /未接入/);
  state.loaded = true;
  await assert.rejects(control.update({ ...input, model: 'missing' }), /可用列表/);
  await assert.rejects(control.update({ ...input, effort: 'high' }), /推理强度/);
  state.wrongRead = true;
  await assert.rejects(control.update(input), /不同的节点/);
  assert.equal(state.writes.length, 0);
  assert.equal(state.calls.some(call => /thread\/(resume|start)|turn\/start/.test(call.method)), false);
});

test('mutation timeout stays unconfirmed and is never retried automatically', async t => {
  const { state, control } = await fixture(t, { timeoutMs: 200 });
  state.dropWrites = true;
  await assert.rejects(control.update({ agentId: 'agent-a', model: 'model-b', effort: 'low', scope: 'future' }), /结果未确认/);
  assert.equal(state.writes.length, 1);
});

test('a disappeared live task is not reported as a successful current-turn change', async t => {
  const { state, control } = await fixture(t);
  state.turnUnavailable = true;
  await assert.rejects(control.update({ agentId: 'agent-a', model: 'model-b', effort: 'low', scope: 'current', turnId: 'turn-a' }), /无法接收/);
});

test('non-object JSON messages cannot crash the control reader', async t => {
  const { state, control } = await fixture(t);
  state.noise = true;
  assert.equal((await control.settings('agent-a')).controllable, true);
});

test('node membership enforced before control; demo writes isolated from real service', async () => {
  let requests = 0;
  const backend = new MonitorBackend({ control: { settings() { requests++; throw new Error('unexpected read'); }, update() { requests++; throw new Error('unexpected write'); }, close() {} } });
  try {
    await assert.rejects(backend.updateModel({ mode: 'demo', agentId: 'outside-tree', model: 'demo-sol', effort: 'medium', scope: 'future' }), /不属于/);
    const data = await backend.updateModel({ mode: 'demo', agentId: 'worker', model: 'demo-luna', effort: 'low', scope: 'future' });
    assert.equal(data.simulated, true);
    assert.equal(data.configured_model, 'demo-luna');
    assert.equal((await backend.modelSettings({ mode: 'demo', agentId: 'explorer' })).configured_model, 'demo-luna');
    assert.equal((await backend.modelSettings({ mode: 'demo', agentId: 'worker' })).configured_effort, 'low');
    assert.equal(requests, 0);
  } finally { backend.close(); }
});
