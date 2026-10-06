import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repository = new URL('../../../', import.meta.url);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'monitor install test '));
  const source = join(directory, 'source');
  const bin = join(directory, 'bin');
  const home = join(directory, 'codex home');
  await mkdir(join(source, 'plugins/agent-monitor'), { recursive: true });
  await mkdir(join(source, 'releases'), { recursive: true });
  await mkdir(bin);
  await cp(new URL('install.sh', repository), join(source, 'install.sh'));
  await writeFile(join(source, 'plugins/agent-monitor/package.json'), '{"version":"1.2.0"}');
  const calls = join(directory, 'calls.jsonl');
  await writeFile(join(bin, 'codex'), '#!' + process.execPath + '\n' +
    'const fs=require("node:fs");const args=process.argv.slice(2);fs.appendFileSync(process.env.MONITOR_TEST_CALLS,JSON.stringify(args)+"\\n");if(process.env.MONITOR_TEST_FAIL_INSTALL&&args[1]==="add")process.exit(1);if(process.env.MONITOR_TEST_FAIL_MARKET&&args[2]==="add"&&args[3].includes("agent-monitor-installs"))process.exit(1);console.log(JSON.stringify(args[2]==="list"?{marketplaces:process.env.MONITOR_TEST_MARKET?JSON.parse(process.env.MONITOR_TEST_MARKET):[]}:{installedPath:"fixture",version:"1.2.0"}));', { mode: 0o755 });
  // Would fail if install tries to invoke npm at all.
  await writeFile(join(bin, 'npm'), '#!/bin/bash\nexit 99\n', { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, CODEX_HOME: home, MONITOR_TEST_CALLS: calls };
  return { directory, source, bin, home, calls, env };
}
async function archive(f, { badChecksum = false } = {}) {
  const staged = join(f.directory, 'payload/agent-monitor');
  await mkdir(join(staged, 'scripts'), { recursive: true });
  await mkdir(join(staged, '.codex-plugin'));
  await writeFile(join(staged, '.codex-plugin/plugin.json'), '{"name":"agent-monitor","version":"1.2.0"}');
  await writeFile(join(staged, 'scripts/start.sh'), '#!/bin/bash\nexit 0\n');
  await writeFile(join(staged, 'doctor.mjs'), 'console.log("fixture doctor passed");');
  const output = join(f.source, 'releases/agent-monitor-1.2.0.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', output, '-C', join(f.directory, 'payload'), 'agent-monitor']).status, 0);
  const hash = badChecksum ? '0'.repeat(64) : createHash('sha256').update(await readFile(output)).digest('hex');
  await writeFile(output + '.sha256', hash + '  agent-monitor-1.2.0.tar.gz\n');
}
function run(f) {
  return spawnSync('bash', [join(f.source, 'install.sh')], { env: f.env, encoding: 'utf8', timeout: 15000 });
}

test('one command installs a checksum verified prebuilt package without npm, including paths with spaces', async () => {
  const f = await fixture();
  try {
    await archive(f);
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    const registered = calls.find(args => args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add');
    assert(registered);
    assert(registered[3].startsWith(f.home + '/agent-monitor-installs/'));
    assert.equal(registered.length, 5);
    const marketplace = JSON.parse(await readFile(join(registered[3], '.agents/plugins/marketplace.json'), 'utf8'));
    assert.equal(marketplace.plugins[0].source.path, './plugins/agent-monitor');
    assert(calls.some(args => args.join(' ') === 'plugin add agent-monitor@agent-monitor-local --json'));
    assert.match(result.stdout, /无需.*编译|安装完成/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('tampered archive is refused before creating install directory or invoking Codex', async () => {
  const f = await fixture();
  try {
    await archive(f, { badChecksum: true });
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256|校验/);
    await assert.rejects(readFile(f.calls));
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(f.home));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('missing prebuilt archive fails with a release instruction, never compiling source', async () => {
  const f = await fixture();
  try {
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /预构建|安装包/);
    await assert.rejects(readFile(f.calls));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('checksum-valid archive containing a symbolic link is rejected before extraction', async () => {
  const f = await fixture();
  try {
    await archive(f);
    await symlink('/tmp', join(f.directory, 'payload/agent-monitor/escape'));
    const output = join(f.source, 'releases/agent-monitor-1.2.0.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', output, '-C', join(f.directory, 'payload'), 'agent-monitor']).status, 0);
    const hash = createHash('sha256').update(await readFile(output)).digest('hex');
    await writeFile(output + '.sha256', hash + '  agent-monitor-1.2.0.tar.gz\n');
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不安全|非普通文件/);
    await assert.rejects(readFile(f.calls));
    await assert.rejects(access(f.home));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('upgrade replaces only a verified monitor-only marketplace registration', async () => {
  const f = await fixture();
  try {
    await archive(f);
    const previous = join(f.directory, 'previous');
    await mkdir(join(previous, '.agents/plugins'), { recursive: true });
    await writeFile(join(previous, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'agent-monitor-local', plugins: [{ name: 'agent-monitor' }] }));
    f.env.MONITOR_TEST_MARKET = JSON.stringify([{ name: 'agent-monitor-local', root: previous, marketplaceSource: { sourceType: 'local', source: previous } }]);
    assert.equal(run(f).status, 0);
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert(calls.some(args => args.join(' ') === 'plugin marketplace remove agent-monitor-local --json'));
    await access(previous);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('upgrade refuses a same-named marketplace containing unrelated plugins', async () => {
  const f = await fixture();
  try {
    await archive(f);
    const previous = join(f.directory, 'previous');
    await mkdir(join(previous, '.agents/plugins'), { recursive: true });
    await writeFile(join(previous, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'agent-monitor-local', plugins: [{ name: 'agent-monitor' }, { name: 'other' }] }));
    f.env.MONITOR_TEST_MARKET = JSON.stringify([{ name: 'agent-monitor-local', root: previous, marketplaceSource: { sourceType: 'local', source: previous } }]);
    assert.notEqual(run(f).status, 0);
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert(!calls.some(args => args[2] === 'remove' || args[2] === 'add'));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

for (const failure of ['MONITOR_TEST_FAIL_INSTALL', 'MONITOR_TEST_FAIL_MARKET']) test(`${failure} restores the previous marketplace source`, async () => {
  const f = await fixture();
  try {
    await archive(f);
    const previous = join(f.directory, 'previous');
    await mkdir(join(previous, '.agents/plugins'), { recursive: true });
    await writeFile(join(previous, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'agent-monitor-local', plugins: [{ name: 'agent-monitor' }] }));
    f.env.MONITOR_TEST_MARKET = JSON.stringify([{ name: 'agent-monitor-local', root: previous, marketplaceSource: { sourceType: 'local', source: previous } }]);
    f.env[failure] = 'true';
    assert.notEqual(run(f).status, 0);
    const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert(calls.some(args => args[2] === 'add' && args[3] === previous));
    await access(previous);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
