import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import WebSocket from 'ws';

// Connect to the owner of a running thread. Never spawn/resume a second copy.
export class AgentControl {
  constructor({ socketPath, timeoutMs = 8000 } = {}) {
    this.socketPath = socketPath || process.env.AGENT_MONITOR_CONTROL_SOCKET || join(process.env.CODEX_HOME || homedir() + '/.codex', 'app-server-control/app-server-control.sock');
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  async connect() {
    if (this.closed) throw new Error('控制连接已关闭。');
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try { await this.connecting; }
    catch (error) {
      if (this.socket) this.fail(this.socket, '控制连接初始化失败。');
      this.connecting = undefined; throw error;
    }
  }

  async open() {
    if (!isAbsolute(this.socketPath) || /[:?#]/.test(this.socketPath)) throw new Error('控制连接需要本机 Unix socket 的绝对路径。');
    const socket = new WebSocket(`ws+unix://${this.socketPath}:/`, { maxPayload: 512 * 1024, handshakeTimeout: this.timeoutMs });
    this.socket = socket;
    socket.on('message', bytes => {
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      // Ignore notifications and unsolicited requests, including conversation text.
      if (message.method) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex 控制接口：${String(message.error.message).slice(0, 400)}`));
      else pending.resolve(message.result);
    });
    socket.on('error', () => this.fail(socket, '无法连接本机 Codex 控制服务。'));
    socket.on('close', () => this.fail(socket, 'Codex 控制连接已断开，请重新读取配置。'));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(new Error('无法连接本机 Codex 控制服务。')));
      socket.once('close', () => reject(new Error('Codex 控制连接已断开。')));
    });
    await this.request('initialize', {
      clientInfo: { name: 'agent_monitor', title: 'Agent Monitor', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  }

  fail(socket, message) {
    if (this.socket !== socket) return;
    this.connecting = undefined;
    this.socket = undefined;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error(message)); }
    this.pending.clear();
    socket.terminate();
  }

  request(method, params, deadline = Infinity) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex 控制连接尚未就绪。'));
    const id = ++this.nextId;
    const timeoutMs = Math.min(this.timeoutMs, deadline - Date.now());
    if (timeoutMs <= 0) return Promise.reject(new Error('控制操作已超时，结果未确认。请重新读取配置核对。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('控制请求超时，结果未确认。请重新读取配置核对，勿自动重复提交。'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(new Error('发送控制请求失败。'));
      });
    });
  }

  async models(deadline = Date.now() + 30000) {
    await this.connect();
    const models = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await this.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, deadline);
      if (!Array.isArray(result?.data)) throw new Error('模型列表格式不正确。');
      for (const model of result.data) {
        if (model.hidden || typeof model.model !== 'string') continue;
        models.push({ model: model.model, name: model.displayName || model.model,
          efforts: (model.supportedReasoningEfforts || []).map(value => value.reasoningEffort).filter(value => typeof value === 'string'),
          defaultEffort: model.defaultReasoningEffort });
      }
      if (!result.nextCursor) return models;
      if (cursor === result.nextCursor) break;
      cursor = result.nextCursor;
    }
    throw new Error('模型列表未完整读取，请重试。');
  }

  async settings(agentId, deadline = Date.now() + 30000, catalog) {
    const models = catalog || await this.models(deadline);
    const { thread } = await this.request('thread/read', { threadId: agentId, includeTurns: false }, deadline);
    if (thread?.id !== agentId) throw new Error('控制服务返回了不同的节点。');
    const loaded = ['idle', 'active'].includes(thread.status?.type);
    let activeTurnId;
    if (loaded && thread.status.type === 'active') {
      const turns = await this.request('thread/turns/list', { threadId: agentId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }, deadline);
      activeTurnId = turns.data?.find(turn => turn.status === 'inProgress')?.id;
    }
    return { agent_id: agentId, connected: true, controllable: loaded, models,
      configured_model: thread.model || null, configured_effort: thread.reasoningEffort || null,
      active_turn_id: activeTurnId || null,
      reason: loaded ? '' : '此节点未接入当前控制服务。请连接运行此节点的 Codex 服务后再修改。' };
  }

  async update({ agentId, model, effort, scope, turnId }) {
    const deadline = Date.now() + 30000;
    if (!['future', 'current'].includes(scope)) throw new Error('未知生效范围。');
    const before = await this.settings(agentId, deadline);
    if (!before.controllable) throw new Error(before.reason);
    const option = before.models.find(option => option.model === model);
    if (!option) throw new Error('该模型不在当前可用列表中，请重新读取配置。');
    if (typeof effort !== 'string' || !option.efforts.includes(effort)) throw new Error('该模型不支持所选推理强度。');
    if (scope === 'current') {
      if (!turnId || before.active_turn_id !== turnId) throw new Error('当前轮次已变化或结束，请重新读取配置再提交。');
      const result = await this.request('turn/settings/update', { threadId: agentId, turnId, model, effort }, deadline);
      if (result?.status !== 'applied') throw new Error('此轮次已无法接收设置，修改未确认。请重新读取节点状态。');
      return { ...before, applied: true, scope, applied_model: model, applied_effort: effort,
        message: '已发布到当前轮次的后续调用。正在进行的模型请求保持原设置；后续轮次配置不变。' };
    }
    await this.request('thread/settings/update', { threadId: agentId, model, effort }, deadline);
    // The ACK alone does not prove the persisted configuration matches the request.
    let after;
    try { after = await this.settings(agentId, deadline, before.models); }
    catch { throw new Error('Codex 已接受修改，但配置回读失败。请重新读取配置核对后再操作。'); }
    if (after.configured_model !== model || after.configured_effort !== effort) throw new Error('Codex 已接受修改，但回读配置尚未匹配。请重新读取配置核对。');
    return { ...after, applied: true, scope, applied_model: model, applied_effort: effort,
      message: '模型配置已回读确认，将用于此节点的后续轮次。当前轮次设置不变。' };
  }

  close() {
    this.closed = true;
    if (this.socket) this.fail(this.socket, '控制连接已关闭。');
  }
}
