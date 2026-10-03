import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { Script } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MonitorBackend } from '../backend.mjs';
import { layoutAgents, escapeHTML, stageFor, nodeEvents, sessionLabel, agentGroups, agentLabel } from '../ui/graph.js';

test('MCP discovery exposes both entrypoints and a bundled UI; demo refresh returns flows', async () => {
  const client = new Client({ name: 'monitor-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['server.mjs'], cwd: new URL('../', import.meta.url).pathname });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const open = tools.find(tool => tool.name === 'open_agent_monitor');
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    assert.equal(open._meta.ui.resourceUri, 'ui://agent-monitor/dashboard');
    const resource = await client.readResource({ uri: open._meta.ui.resourceUri });
    assert.match(resource.contents[0].text, /调度流转/);
    assert.doesNotMatch(resource.contents[0].text, /INLINE_STYLE|INLINE_SCRIPT/);
    const script = resource.contents[0].text.match(/<script>([\s\S]*)<\/script>/)[1];
    assert.doesNotThrow(() => new Script(script));
    const snapshot = await client.callTool({ name: 'get_agent_snapshot', arguments: { mode: 'demo' } });
    assert.equal(snapshot.isError, undefined);
    assert.equal(snapshot.structuredContent.demo, true);
    assert.equal(snapshot.structuredContent.agents.length, 5);
    assert(snapshot.structuredContent.flows.some(flow => flow.phase === 'return'));
    assert(snapshot.structuredContent.flows.some(flow => flow.phase === 'dispatch'));
    assert.equal(snapshot.structuredContent.forks, 1656);
  } finally { await client.close(); }
});

test('persistent reader isolates real session trees', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitor-test-'));
  const meta = (id, parent_thread_id) => ({ timestamp: '2026-10-03T06:00:00Z', type: 'session_meta', payload: { id, parent_thread_id, cwd: '/fixture' } });
  await writeFile(join(directory, 'a.jsonl'), JSON.stringify(meta('root-a')) + '\n');
  await writeFile(join(directory, 'b.jsonl'), JSON.stringify(meta('root-b')) + '\n');
  const backend = new MonitorBackend({ sessionsDir: directory });
  try {
    const [a, b] = await Promise.all([backend.read({ sessionId: 'root-a' }), backend.read({ sessionId: 'root-b' })]);
    assert.deepEqual(a.agents.map(agent => agent.id), ['root-a']);
    assert.deepEqual(b.agents.map(agent => agent.id), ['root-b']);
    assert.equal((await backend.read({ sessionId: 'root-a' })).root_id, 'root-a');
    await assert.rejects(backend.read({ sessionId: '../../secret' }));
    assert.equal(backend.readers.size, 2);
  } finally { backend.close(); await rm(directory, { recursive: true }); }
});

test('cached reader cannot report stale snapshots as live', async () => {
  const backend = new MonitorBackend();
  try {
    await backend.read({ mode: 'demo' });
    backend.readers.get('demo:latest').emittedAt = Date.now() - 11000;
    await assert.rejects(backend.read({ mode: 'demo' }), /过期/);
  } finally { backend.close(); }
});

test('reader reports missing bridge instead of silently returning stale state', async () => {
  const backend = new MonitorBackend({ bridge: '/nonexistent/agent-monitor-reader.py' });
  await assert.rejects(backend.read(), /未构建/);
  backend.close();
  await assert.rejects(backend.read(), /已关闭/);
});

test('graph preserves nested parentage and ancestors under status filters', () => {
  const agents = [
    { id: 'main', status: 'running' },
    { id: 'worker', parent_id: 'main', status: 'done' },
    { id: 'nested', parent_id: 'worker', status: 'error' },
    { id: 'other', parent_id: 'main', status: 'done' },
  ];
  const layout = layoutAgents(agents, 'main', 'attention');
  assert.deepEqual(layout.nodes.map(node => node.agent.id), ['main', 'worker', 'nested']);
  assert.deepEqual(layout.edges.map(edge => [edge.from.agent.id, edge.to.agent.id]), [['main', 'worker'], ['worker', 'nested']]);
  assert.equal(layoutAgents([], null).nodes.length, 0);
});

test('cycles cannot hang graph layout and external labels are escaped', () => {
  const graph = layoutAgents([{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }], 'a');
  assert.equal(graph.nodes.length, 2);
  assert.equal(escapeHTML('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('review stage requires a running reviewer; completed reviews do not imply active review', () => {
  assert.equal(stageFor({ agents: [{ role: 'code-reviewer', status: 'done' }], flows: [{ phase: 'return' }] }), 'return');
  assert.equal(stageFor({ agents: [{ role: 'code-reviewer', status: 'running' }], flows: [] }), 'review');
});

test('selected node history is isolated and session labels prefer saved titles', () => {
  const data = { agents: [{ id: 'a', events: [{ agent_id: 'a', phase: 'tool' }] }, { id: 'b', events: [{ agent_id: 'b' }] }], flows: [{ agent_id: 'b' }] };
  assert.equal(nodeEvents(data, 'a')[0].agent_id, 'a');
  assert.equal(nodeEvents(data, 'a', true)[0].agent_id, 'b');
  assert.deepEqual(nodeEvents(data, 'unknown'), []);
  assert.equal(sessionLabel({ title: '创建监控脚本', cwd: '/project' }), '创建监控脚本');
  assert.equal(sessionLabel({ cwd: '/project' }), 'project');
  assert.equal(agentLabel({ id: '42', role: 'code-reviewer', name: 'Tesla' }), '代码审查 · Tesla');
  assert.equal(agentLabel({ id: 'x', role: 'main' }, 'x', '调度监控'), '调度监控');
});

test('running, ended and unknown agents are never mixed in the list', () => {
  const groups = agentGroups([{ id: 'running', status: 'running' }, { id: 'done', status: 'done' }, { id: 'unknown', status: 'unknown' }]);
  assert.deepEqual(groups.map(group => group.agents.map(agent => agent.id)), [['running'], ['done'], ['unknown']]);
});
