import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import './build.mjs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const staging = await mkdtemp(join(tmpdir(), 'agent-monitor-release-'));
const packageDir = join(staging, 'agent-monitor');
const archive = fileURLToPath(new URL(`dist/agent-monitor-${version}.tar.gz`, root));
try {
  await mkdir(packageDir);
  // Only runtime files: no repo checkout, npm tree, logs, or developer config.
  for (const path of ['runtime.mjs', 'doctor.mjs', 'preview-runtime.mjs', 'dist/dashboard.html', 'backend', 'assets', '.codex-plugin', '.mcp.json', 'package.json', 'README.md', 'scripts/start.sh']) {
    await mkdir(join(packageDir, path, '..'), { recursive: true });
    await cp(new URL(path, root), join(packageDir, path), { recursive: true, filter: source => !source.endsWith('__pycache__') && !source.endsWith('.pyc') });
  }
  const result = spawnSync('tar', ['-czf', archive, '-C', staging, 'agent-monitor'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Unable to create release archive (tar required).');
  const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(archive + '.sha256', `${checksum}  agent-monitor-${version}.tar.gz\n`);
  console.error(`Release: ${archive}`);
} finally { await rm(staging, { recursive: true, force: true }); }
