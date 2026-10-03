import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentControl } from './control.mjs';

export function findPython() {
  for (const candidate of ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    const result = spawnSync(candidate, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'], { timeout: 3000, stdio: 'ignore' });
    if (result.status === 0) return candidate;
  }
  throw new Error('需要 Python 3.10+ 才能读取 Codex 日志。');
}

export class MonitorBackend {
  constructor({ python, bridge, sessionsDir, control } = {}) {
    this.python = python;
    this.bridge = bridge || fileURLToPath(new URL('backend/desktop_bridge.py', import.meta.url));
    this.sessionsDir = sessionsDir;
    this.readers = new Map();
    this.closed = false;
    this.detailTasks = new Set();
    this.control = control || new AgentControl();
    this.demoSettings = new Map();
  }

  async read({ mode = 'live', sessionId } = {}) {
    if (this.closed) throw new Error('监控连接已关闭。');
    if (!['live', 'demo'].includes(mode)) throw new Error('未知数据源。');
    if (sessionId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) throw new Error('会话 ID 格式不正确。');
    const key = mode + ':' + (sessionId || 'latest');
    let reader = this.readers.get(key);
    if (reader?.error) {
      this.stopReader(reader);
      this.readers.delete(key);
      reader = undefined;
    }
    if (!reader) {
      // A few independent readers let multiple open panels choose their own session.
      if (this.readers.size >= 6) {
        const oldest = [...this.readers.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
        this.stopReader(oldest[1]);
        this.readers.delete(oldest[0]);
      }
      reader = this.startReader(mode, sessionId);
      this.readers.set(key, reader);
    }
    reader.usedAt = Date.now();
    if (reader.error) throw new Error(reader.error);
    if (reader.snapshot && Date.now() - reader.emittedAt > 10000) {
      throw new Error('读取器超过 10 秒未更新，数据已过期。请刷新或重新打开面板。');
    }
    if (reader.snapshot) return reader.snapshot;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      reader.waiters.add(waiter);
      waiter.timer = setTimeout(() => {
        reader.waiters.delete(waiter);
        reject(new Error('读取日志超时，请重试或切换演示。'));
      }, 15000);
    });
  }

  startReader(mode, sessionId) {
    if (!existsSync(this.bridge)) throw new Error('读取器未构建，请先运行 npm run build。');
    this.python ||= findPython();
    const args = ['-u', this.bridge];
    if (mode === 'demo') args.push('--demo');
    else if (sessionId) args.push('--session', sessionId);
    if (this.sessionsDir) args.push('--sessions-dir', this.sessionsDir);
    const process = spawn(this.python, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...globalThis.process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const reader = { process, buffer: '', stderr: '', snapshot: null, error: null, waiters: new Set(), usedAt: Date.now() };
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', chunk => {
      reader.buffer += chunk;
      if (reader.buffer.length > 4 * 1024 * 1024) {
        this.fail(reader, '日志快照过大，已停止读取。');
        process.kill();
        return;
      }
      let newline;
      while ((newline = reader.buffer.indexOf('\n')) >= 0) {
        const line = reader.buffer.slice(0, newline);
        reader.buffer = reader.buffer.slice(newline + 1);
        try {
          const data = JSON.parse(line);
          if (!Array.isArray(data.agents) || !Array.isArray(data.flows)) throw new Error('格式不正确');
          reader.snapshot = data;
          reader.emittedAt = Date.now();
          for (const waiter of reader.waiters) { clearTimeout(waiter.timer); waiter.resolve(data); }
          reader.waiters.clear();
        } catch { this.fail(reader, '无法解析日志快照。'); }
      }
    });
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', chunk => { reader.stderr = (reader.stderr + chunk).slice(-2000); });
    process.on('error', () => this.fail(reader, '无法启动日志读取器，请检查 Python。'));
    process.on('exit', (code, signal) => {
      if (!this.closed && !reader.stopping) this.fail(reader, `日志读取器已退出（${code ?? signal}）。请重试。`);
    });
    return reader;
  }

  async details({ mode = 'live', sessionId, agentId }) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(agentId || '')) throw new Error('节点 ID 格式不正确。');
    const snapshot = await this.read({ mode, sessionId });
    if (!snapshot.agents.some(agent => agent.id === agentId)) throw new Error('该节点不属于所选会话。');
    const args = ['-u', this.bridge, '--once', '--details-agent', agentId];
    if (mode === 'demo') args.push('--demo');
    else args.push('--session', snapshot.root_id);
    if (this.sessionsDir) args.push('--sessions-dir', this.sessionsDir);
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      this.detailTasks.add(child);
      let output = '', failure;
      const timeout = setTimeout(() => { failure = '读取节点正文超时。'; child.kill(); }, 20000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (Buffer.byteLength(output) > 256 * 1024) { failure = '节点正文过大。'; child.kill(); }
      });
      child.on('error', () => { failure = '无法启动节点读取器。'; });
      child.on('close', code => {
        clearTimeout(timeout); this.detailTasks.delete(child);
        if (failure || code !== 0) { reject(new Error(failure || '节点读取器已退出。')); return; }
        try {
          const data = JSON.parse(output);
          if (data.agent_id !== agentId || !Array.isArray(data.public_process) || typeof data.result !== 'string') throw new Error();
          resolve(data);
        } catch { reject(new Error('节点正文格式不正确。')); }
      });
    });
  }

  fail(reader, message) {
    reader.error = message;
    for (const waiter of reader.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); }
    reader.waiters.clear();
  }

  async selectedNode({ mode = 'live', sessionId, agentId }) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(agentId || '')) throw new Error('节点 ID 格式不正确。');
    const snapshot = await this.read({ mode, sessionId });
    const agent = snapshot.agents.find(agent => agent.id === agentId);
    if (!agent) throw new Error('该节点不属于所选会话。');
    return { snapshot, agent };
  }

  async modelSettings(input) {
    const { snapshot, agent } = await this.selectedNode(input);
    if (snapshot.demo) {
      const saved = this.demoSettings.get(agent.id);
      return { agent_id: agent.id, simulated: true, connected: true, controllable: true,
        models: ['demo-sol', 'demo-luna', 'demo-astra'].map(model => ({ model, name: model + '（模拟）', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })),
        configured_model: saved?.model || agent.model, configured_effort: saved?.effort || agent.effort,
        active_turn_id: agent.status === 'running' ? 'demo-turn-' + agent.id : null, reason: '' };
    }
    try { return await this.control.settings(agent.id); }
    catch (error) { return { agent_id: agent.id, connected: false, controllable: false, models: [], reason: error.message }; }
  }

  async updateModel(input) {
    const { snapshot, agent } = await this.selectedNode(input);
    if (!snapshot.demo) return this.control.update(input);
    const settings = await this.modelSettings(input);
    if (!['future', 'current'].includes(input.scope)) throw new Error('未知生效范围。');
    const option = settings.models.find(model => model.model === input.model);
    if (!option?.efforts.includes(input.effort)) throw new Error('演示模型或推理强度不正确。');
    if (input.scope === 'current' && (!settings.active_turn_id || input.turnId !== settings.active_turn_id)) throw new Error('演示节点当前没有可修改的运行轮次。');
    if (input.scope === 'future') this.demoSettings.set(agent.id, { model: input.model, effort: input.effort });
    return { ...await this.modelSettings(input), applied: true, scope: input.scope, applied_model: input.model, applied_effort: input.effort,
      message: '模拟修改成功，仅影响此演示面板，不会修改真实会话。' };
  }

  stopReader(reader) {
    reader.stopping = true;
    this.fail(reader, '监控数据源已切换，请刷新。');
    reader.process.kill('SIGTERM');
  }

  close() {
    this.closed = true;
    this.control.close();
    for (const child of this.detailTasks) child.kill();
    for (const reader of this.readers.values()) this.stopReader(reader);
    this.readers.clear();
  }
}
