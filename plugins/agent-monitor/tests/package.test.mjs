import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = new URL('../', import.meta.url);

async function checkPackage(directory, env = process.env) {
  const client = new Client({ name: 'cold-install-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'bash', args: [join(directory, 'scripts/start.sh')], env, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk.toString(); });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert(tools.some(tool => tool.name === 'open_agent_monitor'));
    const resource = await client.readResource({ uri: 'ui://agent-monitor/dashboard' });
    assert.match(resource.contents[0].text, /调度流转/);
    const result = await client.callTool({ name: 'open_agent_monitor', arguments: { mode: 'demo' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.agents.length, 5);
    assert.equal(result.structuredContent.binding.source, 'demo');
    return diagnostics;
  } finally { await client.close(); }
}

test('isolated source first launch builds offline; release runs without node_modules or parent repo', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitor-cold-install-'));
  const source = join(directory, 'source');
  try {
    await mkdir(source);
    for (const path of ['scripts', 'ui', 'backend', 'assets', '.codex-plugin', '.mcp.json', 'package.json', 'package-lock.json', 'README.md', 'server.mjs', 'backend.mjs', 'control.mjs', 'binding.mjs', 'preview.mjs']) {
      await cp(new URL(path, root), join(source, path), { recursive: true, filter: path => !path.endsWith('__pycache__') });
    }
    assert(!(await readdir(directory)).includes('agent_monitor.py'));
    // CI warms the dependency cache with npm ci before running this suite.
    const diagnostic = await checkPackage(source, { ...process.env, npm_config_offline: 'true' });
    assert.match(diagnostic, /preparing first launch/);
    const release = spawnSync(process.execPath, ['scripts/release.mjs'], { cwd: source, encoding: 'utf8', timeout: 30000 });
    assert.equal(release.status, 0, release.stderr);
    const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const archive = join(source, `dist/agent-monitor-${version}.tar.gz`);
    const unpacked = join(directory, 'unpacked');
    await mkdir(unpacked);
    assert.equal(spawnSync('tar', ['-xzf', archive, '-C', unpacked]).status, 0);
    const plugin = join(unpacked, 'agent-monitor');
    const files = await readdir(plugin);
    assert(!files.includes('node_modules'));
    assert(!files.includes('server.mjs'));
    assert(!files.includes('package-lock.json'));
    const logs = await checkPackage(plugin);
    assert.doesNotMatch(logs, /preparing first launch/);
    const doctor = spawnSync(process.execPath, [join(plugin, 'doctor.mjs'), plugin], { encoding: 'utf8', timeout: 15000 });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.server_ready, true);
    assert.equal(report.sidebar_visibility, 'unverified');
    assert(report.checks.some(check => check.id === 'catalog_tool' && check.ok));

    // Invocation metadata never selects a tree; the catalog exposes every ID, including children.
    const codexHome = join(directory, 'codex-home');
    await mkdir(join(codexHome, 'sessions'), { recursive: true });
    for (const [id, parent_thread_id] of [['chat-a', undefined], ['chat-b', undefined], ['child-a', 'chat-a']]) {
      await writeFile(join(codexHome, 'sessions', `${id}.jsonl`), JSON.stringify({
        type: 'session_meta', payload: { id, parent_thread_id, cwd: '/fixture' }, timestamp: '2026-10-03T00:00:00Z',
      }) + '\n');
    }
    const client = new Client({ name: 'binding-protocol-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: 'bash', args: [join(plugin, 'scripts/start.sh')], env: { ...process.env, CODEX_HOME: codexHome } });
    try {
      await client.connect(transport);
      for (const id of ['chat-a', 'chat-b']) {
        const result = await client.callTool({ name: 'open_agent_monitor', arguments: {}, _meta: { 'openai/threadId': id } });
        assert.equal(result.structuredContent.root_id, null);
        assert.equal(result.structuredContent.agents.length, 0);
        assert.equal(result.structuredContent.binding.source, 'unselected');
      }
      const firstPage = await client.callTool({ name: 'list_agent_sessions', arguments: { offset: 0, limit: 2, refresh: true } });
      const secondPage = await client.callTool({ name: 'list_agent_sessions', arguments: { offset: 2, limit: 2, revision: firstPage.structuredContent.revision } });
      assert.equal(firstPage.structuredContent.total, 3);
      assert.equal([...firstPage.structuredContent.sessions, ...secondPage.structuredContent.sessions].find(session => session.id === 'child-a').parent_id, 'chat-a');
      const selected = await client.callTool({ name: 'open_agent_monitor', arguments: { sessionId: 'chat-a' } });
      assert.equal(selected.structuredContent.root_id, 'chat-a');
      assert.equal(selected.structuredContent.binding.source, 'explicit');
      const missing = await client.callTool({ name: 'open_agent_monitor', arguments: { sessionId: 'missing' } });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /不会自动切换/);
    } finally { await client.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('incomplete package fails on stderr without polluting MCP stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitor-incomplete-'));
  try {
    await mkdir(join(directory, 'scripts'));
    await cp(new URL('scripts/start.sh', root), join(directory, 'scripts/start.sh'));
    const result = spawnSync('bash', [join(directory, 'scripts/start.sh')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /reader is missing/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
