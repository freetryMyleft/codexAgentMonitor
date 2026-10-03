import { App } from '@modelcontextprotocol/ext-apps';
import { layoutAgents, escapeHTML as esc, shortNumber as num, stageFor, nodeEvents, sessionLabel, agentGroups } from './graph.js';

const $ = id => document.getElementById(id);
const statusLabels = { running: '执行中', done: '已完成', waiting: '等待中', idle: '空闲', error: '错误', interrupted: '已中断', unknown: '未知' };
const roleLabels = { main: '主控会话', worker: '工作智能体', explorer: '代码探索', researcher: '资料研究', 'code-reviewer': '代码审查', architect: '架构顾问', 'python-reviewer': 'Python 审查', 'typescript-reviewer': '前端审查' };
const phaseLabels = { dispatch: '派发', start: '开始执行', return: '结果回流', complete: '完成', review: '审查', tool: '工具调用', tool_result: '工具结束', thinking: '推理阶段', wait: '等待结果', decision: '路由决策', interrupt: '中断', event: '状态更新' };
let mode = 'live', sessionId, selectedId, snapshot, paused = false, busy = false, timer, generation = 0;
let app, connected = false, lastSuccess = 0;
let launchPending = false, launchHandled = false;
let launchBinding;
let globalProcess = false;
let detailMap = new Map(), detailTab = 'details';
let detailLoads = new Map();
let modelStates = new Map();
let currentTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
let graphSignature = '', sessionSignature = '', timelineSignature = '';
document.documentElement.dataset.theme = currentTheme;

function notice(message, error = false) {
  $('notice').hidden = !message;
  $('notice').textContent = message || '';
  $('notice').classList.toggle('error', error);
}

function connection(label, stale = false) {
  $('connection').textContent = label;
  $('connection').classList.toggle('stale', stale);
}

async function read(input) {
  if (app && connected) {
    const result = await app.callServerTool({ name: 'get_agent_snapshot', arguments: input });
    if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || '读取快照失败');
    return result.structuredContent;
  }
  if (window.parent !== window) throw new Error('插件连接尚未就绪。');
  const query = new URLSearchParams({ mode: input.mode });
  if (input.sessionId) query.set('sessionId', input.sessionId);
  const response = await fetch(`/api/snapshot?${query}`, { signal: AbortSignal.timeout(16000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '读取快照失败');
  return data;
}

function accept(data) {
  if (!data || !Array.isArray(data.agents) || !Array.isArray(data.flows)) throw new Error('快照格式不正确。');
  snapshot = data;
  if (launchBinding && data.root_id === launchBinding.rootId) snapshot.binding = launchBinding.binding;
  if (snapshot.binding?.source === 'latest' && !snapshot.warning?.includes('客户端未提供会话绑定')) {
    snapshot.warning = [snapshot.warning, '客户端未提供会话绑定：当前展示最近更新的会话，请在会话列表中选择。'].filter(Boolean).join(' ');
  }
  lastSuccess = Date.now();
  const previous = selectedId;
  if (!data.agents.some(a => a.id === selectedId)) selectedId = data.root_id || data.agents[0]?.id;
  render();
  synchronizeSelected(previous !== selectedId);
}

function detailSignature(agent) { return JSON.stringify([agent.updated_at, agent.status, agent.event_count, agent.activity]); }
function synchronizeSelected(changed = false) {
  if (window.parent !== window && !connected) return;
  const agent = snapshot?.agents.find(agent => agent.id === selectedId);
  if (!agent) return;
  const load = detailLoads.get(agent.id);
  const signature = detailSignature(agent);
  if (!load || changed || (!load.loading && load.signature !== signature && (Date.now() - load.startedAt > 3000 || load.status !== agent.status))) void loadNodeDetails(agent);
  if (!modelStates.has(agent.id)) void loadModelSettings(agent);
}

async function refresh() {
  if (busy || paused || launchPending || document.hidden) return;
  const ownGeneration = generation;
  busy = true;
  $('refresh').disabled = true;
  try {
    const data = await read({ mode, ...(sessionId ? { sessionId } : {}) });
    if (ownGeneration === generation) accept(data);
  } catch (error) {
    if (ownGeneration === generation) { notice(error.message, true); connection('连接异常', true); }
  } finally {
    busy = false;
    $('refresh').disabled = false;
    if (ownGeneration !== generation) void refresh();
  }
}

function switchSource(nextMode, nextSession) {
  launchHandled = true;
  launchPending = false;
  generation++;
  mode = nextMode;
  launchBinding = undefined;
  sessionId = nextSession;
  selectedId = undefined;
  detailMap = new Map(); detailTab = 'details';
  detailLoads = new Map();
  modelStates = new Map();
  paused = false;
  snapshot = undefined;
  graphSignature = sessionSignature = timelineSignature = '';
  $('project').textContent = '正在载入会话';
  $('session-id').textContent = nextSession || '等待数据源';
  for (const id of ['running', 'completed', 'attention', 'tokens']) $(id).textContent = '—';
  $('running-caption').textContent = '正在读取日志';
  $('token-caption').textContent = '等待用量记录';
  $('agent-count').textContent = '00';
  $('agent-list').replaceChildren();
  $('timeline').replaceChildren();
  $('active-execution').replaceChildren();
  $('detail').textContent = '数据源已切换，正在载入。';
  $('graph').style.width = '100%';
  $('graph').style.height = '400px';
  $('graph').innerHTML = '<div class="empty-state"><h3>正在载入所选会话</h3></div>';
  $('flow-badge').textContent = '等待事件';
  $('updated').textContent = '—';
  for (const el of $('pipeline').querySelectorAll('[data-stage]')) el.classList.remove('current');
  $('graph').classList.remove('paused');
  $('pause').textContent = '暂停刷新';
  connection('切换中', true);
  $('live-mode').classList.toggle('active', mode === 'live');
  $('demo-mode').classList.toggle('active', mode === 'demo');
  notice(mode === 'demo' ? '演示模式 · 所有节点、用量与流转均为模拟数据。' : '正在读取所选会话…');
  void refresh();
}

function projectName(root) {
  return root?.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || (snapshot?.demo ? 'Agent Studio' : '本地会话');
}

function agentLabel(agent) {
  if (agent.id === snapshot?.root_id) return snapshot.session_title || `主控会话 · ${projectName(agent)}`;
  return agent.name ? `${roleLabels[agent.role] || agent.role} · ${agent.name}` : `${roleLabels[agent.role] || agent.role || '智能体'} · ${agent.session_title || agent.id.slice(0, 8)}`;
}
function symbol(agent) { return agent.id === snapshot?.root_id ? '⌘' : /review|architect/.test(agent.role) ? '◇' : '↳'; }

function render() {
  const data = snapshot;
  const root = data.agents.find(a => a.id === data.root_id) || data.agents[0];
  $('project').textContent = data.session_title || projectName(root);
  $('project').title = data.session_title || projectName(root);
  $('session-id').textContent = data.demo ? '演示会话' : `${projectName(root)} · ${data.binding?.label || '所选本机会话'}`;
  $('running').textContent = data.agents.filter(a => a.status === 'running').length;
  $('completed').textContent = data.agents.filter(a => a.status === 'done').length;
  $('attention').textContent = data.agents.filter(a => ['error', 'interrupted'].includes(a.status)).length;
  const known = data.agents.filter(a => a.total_tokens != null);
  $('tokens').textContent = known.length ? num(known.reduce((sum, a) => sum + a.total_tokens, 0)) : '—';
  $('token-caption').textContent = known.length < data.agents.length ? `${data.agents.length - known.length} 个节点的用量未知` : '输入 + 输出，不重复计数';
  $('running-caption').textContent = `${data.agents.length} 个执行单元 · 含主控`;
  $('agent-count').textContent = String(data.agents.length).padStart(2, '0');
  const stage = stageFor(data);
  const stageLabels = { main: '主控工作中', dispatch: '正在派发', execute: '执行中', return: '结果回流', review: '审查中' };
  $('flow-badge').textContent = data.agents.length ? stageLabels[stage] : '等待事件';
  for (const el of $('pipeline').querySelectorAll('[data-stage]')) el.classList.toggle('current', el.dataset.stage === stage);
  $('updated').textContent = '更新于 ' + new Date(data.generated_at).toLocaleTimeString('zh-CN', { hour12: false });
  connection(paused ? '已暂停' : data.demo ? '模拟数据' : '实时连接', paused);
  notice(data.warning || (data.demo ? '演示模式 · 所有节点、用量与流转均为模拟数据。' : ''));
  renderSessions(data);
  renderAgents(data);
  renderGraph(data);
  renderDetail(data);
  renderTimeline(data);
}

function renderSessions(data) {
  const key = JSON.stringify([data.sessions, sessionId, mode]);
  if (key === sessionSignature) return;
  sessionSignature = key;
  const select = $('sessions');
  select.replaceChildren(new Option('最近更新的会话', ''));
  for (const session of data.sessions || []) {
    const name = sessionLabel(session);
    select.add(new Option(`${name} · ${session.cwd.split(/[\\/]/).filter(Boolean).at(-1) || '本地项目'}`, session.id));
  }
  select.value = sessionId || '';
  select.disabled = mode === 'demo';
}

function renderAgents(data) {
  $('agent-list').innerHTML = data.agents.length ? agentGroups(data.agents).map(group => `<div class="agent-group-heading">${esc(group.label)}<span>${group.agents.length}</span></div>` + group.agents.map(agent => `
    <button class="agent-item ${agent.id === selectedId ? 'selected' : ''}" data-agent="${esc(agent.id)}" title="${esc(agentLabel(agent))}">
      <span class="agent-symbol">${symbol(agent)}</span><span class="agent-copy"><strong>${esc(agentLabel(agent))}</strong><small>${esc(roleLabels[agent.role] || agent.role)} · ${esc(agent.effort)}</small></span>
      <b class="dot ${esc(agent.status)}" title="${esc(statusLabels[agent.status] || '未知')}"></b>
    </button>`).join('')).join('') : '<p class="muted">尚未找到会话，可切换演示。</p>';
}

function pathBetween(from, to) {
  const x1 = from.x + from.width / 2, y1 = from.y + from.height;
  const x2 = to.x + to.width / 2, y2 = to.y;
  return `M${x1},${y1} C${x1},${y1 + 33} ${x2},${y2 - 33} ${x2},${y2}`;
}

function flowEdge(path, index, type, animated) {
  const id = `edge-${index}`;
  return `<path id="${id}" class="flow-line ${type}" d="${path}" marker-end="url(#arrow-${type === 'returned' ? 'return' : 'flow'})"/>
    ${animated ? `<circle r="3" class="flow-particle ${type}"><animateMotion dur="2.8s" repeatCount="indefinite"><mpath href="#${id}"/></animateMotion></circle>` : ''}`;
}

function renderGraph(data) {
  const filter = $('filter').value;
  // Avoid replacing the SVG on every poll: the moving particles retain their phase.
  const key = JSON.stringify([data.session_title, data.agents.map(a => [a.id, a.parent_id, a.name, a.session_title, a.model, a.status, a.activity, a.total_tokens]), filter,
    data.agents.map(a => a.returned_at)]);
  if (key === graphSignature) { updateSelection(); return; }
  graphSignature = key;
  const layout = layoutAgents(data.agents, data.root_id, filter);
  const graph = $('graph');
  if (!layout.root) {
    graph.style.width = '100%'; graph.style.height = '400px';
    graph.innerHTML = '<div class="empty-state"><div class="empty-symbol">⌘</div><h3>等待 Agent 会话</h3><p>选择本地会话，或切换演示查看完整流转。</p></div>';
    return;
  }
  graph.style.width = `${layout.width}px`;
  graph.style.height = `${layout.height}px`;
  let edges = layout.edges.map((edge, index) => flowEdge(pathBetween(edge.from, edge.to), index, edge.to.agent.status === 'running' ? 'active' : '', edge.to.agent.status === 'running')).join('');
  const returned = new Set(data.agents.filter(a => a.returned_at).map(a => a.id));
  const aggregateY = layout.height - 88;
  const aggregate = { x: layout.width / 2 - 112, y: aggregateY, width: 224, height: 74 };
  const directReturned = layout.nodes.filter(n => n.agent.parent_id === layout.root.id && returned.has(n.agent.id));
  for (const [index, node] of layout.nodes.filter(n => returned.has(n.agent.id)).entries()) {
    const parent = layout.nodes.find(n => n.agent.id === node.agent.parent_id);
    if (!parent) continue;
    const direct = parent.agent.id === layout.root.id;
    const target = direct ? aggregate : parent;
    const startX = node.x + node.width, startY = node.y + node.height / 2;
    const endX = direct ? target.x + target.width / 2 : target.x + target.width;
    const endY = direct ? target.y : target.y + target.height / 2;
    const bendX = Math.max(startX, endX) + 24;
    const path = `M${startX},${startY} C${bendX},${startY} ${bendX},${endY} ${endX},${endY}`;
    edges += flowEdge(path, 'r' + index, 'returned', false);
  }
  const labels = layout.nodes.filter(n => n.depth === 0 || n === layout.nodes.find(other => other.depth === n.depth))
    .map(n => `<span class="graph-label" style="top:${n.y - 16}px">${n.depth === 0 ? 'CONTROLLER' : `LAYER ${n.depth} · EXECUTION`}</span>`).join('');
  graph.innerHTML = `<svg width="${layout.width}" height="${layout.height}" aria-hidden="true"><defs>
    <marker id="arrow-flow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 1L7 4L0 7" fill="none" stroke="var(--blue)"/></marker>
    <marker id="arrow-return" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 1L7 4L0 7" fill="none" stroke="var(--green)"/></marker></defs>${edges}</svg>${labels}
    ${layout.nodes.map(node => {
      const a = node.agent;
      return `<button class="node ${a.id === layout.root.id ? 'root' : ''} ${esc(a.status)} ${a.id === selectedId ? 'selected' : ''}" data-agent="${esc(a.id)}" title="${esc(agentLabel(a))}" style="left:${node.x}px;top:${node.y}px" aria-label="查看 ${esc(agentLabel(a))}，${esc(statusLabels[a.status] || '未知')}">
        <div class="node-header"><b class="dot ${esc(a.status)}"></b><span class="node-name">${esc(agentLabel(a))}</span><span class="node-role">${esc(a.id === layout.root.id ? 'MAIN' : a.role)}</span></div>
        <div class="node-model">${esc(a.model)} · ${esc(a.effort)}</div><div class="node-activity">${esc(a.activity)}</div>
        <div class="node-foot"><span class="node-status">${esc(statusLabels[a.status] || '未知')}</span><span>${num(a.total_tokens)} tokens</span></div></button>`;
    }).join('')}
    ${layout.nodes.length > 1 ? `<button class="node aggregate" data-agent="${esc(layout.root.id)}" style="left:${aggregate.x}px;top:${aggregate.y}px"><div class="node-header"><span class="node-name">主控 · 汇总结果</span><span class="node-role">RETURN</span></div><div class="node-activity">${directReturned.length ? `${directReturned.length} 个直属节点已记录回流` : '等待直属子 Agent 完成事件'}</div></button>` : ''}`;
}

function updateSelection() {
  for (const node of document.querySelectorAll('[data-agent]')) {
    node.classList.toggle('selected', node.dataset.agent === selectedId);
    node.setAttribute('aria-pressed', String(node.dataset.agent === selectedId));
  }
}

function renderDetail(data) {
  const agent = data.agents.find(a => a.id === selectedId);
  if (!agent) { $('detail').innerHTML = '<div class="detail-empty">点击任意节点，查看执行详情。</div>'; return; }
  const ratio = agent.context_tokens != null && agent.context_window > 0 ? Math.min(1, agent.context_tokens / agent.context_window) : null;
  const parent = data.agents.find(a => a.id === agent.parent_id);
  // Polling must not close an open model picker or discard an in-progress choice.
  if ($('detail').dataset.agent === agent.id && document.activeElement?.closest('[data-model-form]')) { renderNodeDetails(agent); return; }
  $('detail').dataset.agent = agent.id;
  $('detail').innerHTML = `<div class="detail-top"><div><div class="detail-title">${esc(agentLabel(agent))}</div><div class="detail-id">${esc(roleLabels[agent.role] || agent.role)} · ${esc(statusLabels[agent.status] || '未知')}</div><details class="id-disclosure"><summary>会话信息</summary><code>${esc(agent.id)}</code>${agent.session_title ? `<span>${esc(agent.session_title)}</span>` : ''}</details></div><span class="badge">${esc(statusLabels[agent.status] || '未知')}</span></div>
    <div class="detail-tabs"><button data-detail-tab="details">节点详情</button><button data-detail-tab="process">公开过程</button><button data-detail-tab="result">最终结果</button></div>
    <div class="detail-view" data-detail-view="details"><div class="detail-grid">${[['模型', agent.model], ['推理强度', agent.effort], ['输入 / 缓存', `${num(agent.input_tokens)} / ${num(agent.cached_tokens)}`], ['输出 Token', num(agent.output_tokens)]].map(([label, value]) => `<div class="detail-cell"><span>${label}</span><strong>${esc(value)}</strong></div>`).join('')}</div>
    <div class="context-row"><span>上下文占用</span><div class="context-track"><div class="context-fill" style="width:${ratio == null ? 0 : Math.round(ratio * 100)}%"></div></div><span>${ratio == null ? '—' : Math.round(ratio * 100) + '%'}</span></div>
    <div class="detail-activity">${esc(agent.activity)}${parent ? ` · 来自 ${esc(agentLabel(parent))}` : ''} · ${agent.tool_calls} 次工具调用${agent.advice ? `<br>审查建议：${esc(agent.advice)}` : ''}</div>
    <div id="model-control" class="model-control"></div></div>
    <div class="detail-view" data-detail-view="process"><p class="muted">公开过程说明；不包含内部推理正文。</p><div id="public-process"></div></div>
    <div class="detail-view" data-detail-view="result"><p class="muted">该节点最近一次已记录的最终回答。</p><div id="final-result" class="public-result"></div></div>`;
  for (const button of document.querySelectorAll('[data-detail-tab]')) button.classList.toggle('active', button.dataset.detailTab === detailTab);
  for (const view of document.querySelectorAll('[data-detail-view]')) view.hidden = view.dataset.detailView !== detailTab;
  renderNodeDetails(agent);
  renderModelControl(agent);
}

function renderModelControl(agent) {
  const state = modelStates.get(agent.id), panel = $('model-control');
  if (!panel) return;
  if (!state || state.loading) { panel.innerHTML = '<strong>模型设置</strong><p class="muted">正在连接本机控制服务…</p>'; return; }
  const data = state.data;
  if (!data?.controllable) {
    panel.innerHTML = `<strong>模型设置</strong><p>${esc(data?.reason || state.message || '配置读取失败。')}</p>${data?.configured_model ? `<small>后续轮次配置：${esc(data.configured_model)}</small>` : ''}<button data-model-action="reload">重新读取配置</button>`;
    return;
  }
  panel.innerHTML = `<div class="model-control-heading"><strong>${data.simulated ? '模拟模型设置' : '模型设置'}</strong><button data-model-action="reload" ${state.pending ? 'disabled' : ''}>重新读取</button></div>
    <p class="model-configured">后续轮次配置：${esc(data.configured_model || '未知')} · ${esc(data.configured_effort || '默认')}</p>
    <div class="model-form" data-model-form>
      <label for="model-choice">模型<select id="model-choice" ${state.pending ? 'disabled' : ''}>${data.models.map(option => `<option value="${esc(option.model)}" ${option.model === state.model ? 'selected' : ''}>${esc(option.name)}</option>`).join('')}</select></label>
      <label for="model-effort">推理强度<select id="model-effort" ${state.pending ? 'disabled' : ''}></select></label>
      <label for="model-scope">生效范围<select id="model-scope" ${state.pending ? 'disabled' : ''}><option value="future" ${state.scope === 'future' ? 'selected' : ''}>后续轮次</option>${data.active_turn_id ? `<option value="current" ${state.scope === 'current' ? 'selected' : ''}>当前轮次的后续调用</option>` : ''}</select></label>
      <button class="model-apply" data-model-action="apply" ${state.pending ? 'disabled' : ''}>${state.pending ? '正在提交…' : data.simulated ? '模拟应用' : '应用模型设置'}</button>
    </div>
    <p class="model-scope-hint">${state.scope === 'current' ? '已发出的请求保持原设置；只修改此节点当前轮次的后续调用。' : '只修改此节点后续轮次；当前轮次保持原设置。'}</p>
    ${state.message ? `<p role="status" class="model-feedback ${state.error ? 'model-error' : ''}">${esc(state.message)}</p>` : ''}`;
  renderEfforts(state);
}

function renderEfforts(state) {
  const select = $('model-effort');
  if (!select) return;
  const option = state.data.models.find(option => option.model === state.model);
  select.innerHTML = (option?.efforts || []).map(effort => `<option value="${esc(effort)}" ${effort === state.effort ? 'selected' : ''}>${esc(effort)}</option>`).join('');
  const apply = $('model-control').querySelector('[data-model-action="apply"]');
  if (apply) apply.disabled = state.pending || state.requiresReload || !option?.efforts.includes(state.effort);
}

async function modelTool(name, input) {
  if (app && connected) {
    const reply = await app.callServerTool({ name, arguments: input });
    if (reply.isError) throw new Error(reply.content?.find(item => item.type === 'text')?.text || '模型设置请求失败');
    return reply.structuredContent;
  }
  if (window.parent !== window) throw new Error('插件连接尚未就绪。');
  const update = name === 'update_agent_model';
  const query = new URLSearchParams(input);
  const response = await fetch(update ? '/api/model' : `/api/model-settings?${query}`, {
    ...(update ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
    signal: AbortSignal.timeout(45000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '模型设置请求失败');
  return data;
}

async function loadModelSettings(agent) {
  if (!agent || modelStates.get(agent.id)?.pending) return;
  const ownGeneration = generation, state = { loading: true, scope: 'future' };
  modelStates.set(agent.id, state); renderModelControl(agent);
  try {
    const data = await modelTool('get_agent_model_settings', { mode, ...(sessionId ? { sessionId } : {}), agentId: agent.id });
    if (ownGeneration !== generation || modelStates.get(agent.id) !== state) return;
    state.data = data;
    const option = data.models.find(option => option.model === data.configured_model) || data.models[0];
    state.model = option?.model;
    state.effort = option?.efforts.includes(data.configured_effort) ? data.configured_effort : option?.defaultEffort || option?.efforts[0];
  } catch (error) { state.message = error.message; state.error = true; }
  finally {
    state.loading = false;
    if (ownGeneration === generation && selectedId === agent.id && modelStates.get(agent.id) === state) renderModelControl(agent);
  }
}

async function applyModel(agent) {
  const state = modelStates.get(agent.id), ownGeneration = generation;
  if (!state?.data?.controllable || state.pending || state.requiresReload) return;
  const input = { mode, ...(sessionId ? { sessionId } : {}), agentId: agent.id, model: state.model, effort: state.effort, scope: state.scope,
    ...(state.scope === 'current' ? { turnId: state.data.active_turn_id } : {}) };
  state.pending = true; state.message = ''; state.error = false; renderModelControl(agent);
  try {
    const data = await modelTool('update_agent_model', input);
    state.data = data; state.message = `${data.message} ${data.applied_model} · ${data.applied_effort}`;
  } catch (error) {
    state.requiresReload = true;
    state.message = `修改结果未确认：${error.message} 请点击“重新读取”核对配置后再操作。`;
    state.error = true;
  }
  finally {
    state.pending = false;
    if (ownGeneration === generation && selectedId === agent.id && modelStates.get(agent.id) === state) renderModelControl(agent);
  }
}

function renderNodeDetails(agent) {
  const info = detailMap.get(agent.id);
  if (!info) {
    $('public-process').innerHTML = '<p class="muted">正在读取此节点记录…</p>';
    $('final-result').innerHTML = '<p class="muted">尚无已读取的结果。</p>';
    return;
  }
  $('public-process').innerHTML = info.public_process.length ? info.public_process.map(item => `<article class="public-note"><time>${esc(item.clock)}</time><p>${esc(item.text)}</p>${item.truncated ? '<small>内容已截断</small>' : ''}</article>`).join('') : '<p class="muted">没有公开过程说明。</p>';
  $('final-result').innerHTML = info.result ? `<article class="public-answer">${esc(info.result).replaceAll('\n', '<br>')}</article>${info.result_truncated ? '<small class="muted">结果已截断显示</small>' : ''}` : '<p class="muted">尚无最终回答记录。</p>';
}

async function loadNodeDetails(agent) {
  if (!agent || (window.parent !== window && !connected) || detailLoads.get(agent.id)?.loading) return;
  const load = { loading: true, signature: detailSignature(agent), status: agent.status, startedAt: Date.now() };
  detailLoads.set(agent.id, load);
  const ownGeneration = generation, selected = agent.id, rootId = snapshot.root_id, sourceMode = mode;
  renderNodeDetails(agent);
  try {
    let info;
    if (app && connected) {
      const reply = await app.callServerTool({ name: 'get_agent_details', arguments: { mode, ...(sessionId ? { sessionId } : {}), agentId: selected } });
      if (reply.isError) throw new Error(reply.content?.find(item => item.type === 'text')?.text || '读取节点失败');
      info = reply.structuredContent;
    } else {
      const params = new URLSearchParams({ mode, agentId: selected });
      if (sessionId) params.set('sessionId', sessionId);
      const response = await fetch(`/api/details?${params}`, { signal: AbortSignal.timeout(22000) });
      info = await response.json();
      if (!response.ok) throw new Error(info.error || '读取节点失败');
    }
    if (ownGeneration !== generation || detailLoads.get(selected) !== load || snapshot?.root_id !== rootId || mode !== sourceMode) return;
    detailMap.set(selected, info);
    if (selectedId === selected) renderDetail(snapshot);
  } catch (error) {
    load.signature = '';
    if (ownGeneration === generation && detailLoads.get(selected) === load && selectedId === selected) {
      $('public-process').textContent = error.message;
      $('final-result').textContent = error.message;
    }
  } finally { load.loading = false; }
}

function renderTimeline(data) {
  const agent = data.agents.find(a => a.id === selectedId);
  const ongoing = (globalProcess ? data.agents : agent ? [agent] : []).filter(a => ['running', 'waiting'].includes(a.status));
  $('active-execution').innerHTML = ongoing.length ? ongoing.map(a => `<button class="current-execution" data-agent="${esc(a.id)}"><span class="current-label"><b class="dot ${esc(a.status)}"></b>${esc(statusLabels[a.status])}</span><strong>${esc(agentLabel(a))}</strong><p>${esc(a.active_tools?.length ? '工具：' + a.active_tools.join('、') : a.activity)}</p><small>日志最后记录 · ${esc(a.updated_at ? new Date(a.updated_at).toLocaleTimeString('zh-CN', { hour12: false }) : '时间未知')}</small></button>`).join('') : '<p class="muted current-empty">当前没有已记录的执行活动。</p>';
  const flows = nodeEvents(data, selectedId, globalProcess);
  const key = JSON.stringify([selectedId, globalProcess, agent ? agentLabel(agent) : '', flows]);
  if (key === timelineSignature) return;
  timelineSignature = key;
  $('process-title').textContent = globalProcess ? '全局执行过程' : `${agent ? agentLabel(agent) : '节点'} · 执行过程`;
  $('process-summary').textContent = globalProcess ? '最近 100 条全局事件' : `${flows.length} 条记录${agent?.event_count > flows.length ? ' · 较早记录已截断' : ''} · 按发生时间排列`;
  $('node-process').classList.toggle('active', !globalProcess);
  $('global-process').classList.toggle('active', globalProcess);
  const timeline = $('timeline');
  const wasAtBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 50;
  timeline.innerHTML = flows.length ? flows.map(flow => `<div class="timeline-item ${esc(flow.phase)}"><div class="timeline-meta"><span class="event-phase">${esc(phaseLabels[flow.phase] || '事件')}</span><time title="${esc(flow.timestamp)}">${esc(flow.clock)}</time></div><div class="event-agent">${esc(flow.name)}</div><p class="event-detail">${esc(flow.detail)}</p></div>`).join('') : '<p class="muted">该节点尚无执行事件。日志到达后会自动更新。</p>';
  if (wasAtBottom) timeline.scrollTop = timeline.scrollHeight;
}

document.addEventListener('click', event => {
  const item = event.target.closest('[data-agent]');
  if (item && snapshot) {
    selectedId = item.dataset.agent;
    globalProcess = false;
    updateSelection(); renderDetail(snapshot); renderTimeline(snapshot);
    void loadNodeDetails(snapshot.agents.find(agent => agent.id === selectedId));
    void loadModelSettings(snapshot.agents.find(agent => agent.id === selectedId));
    $('timeline').scrollTop = $('timeline').scrollHeight;
  }
});
$('detail').addEventListener('click', event => {
  const tab = event.target.closest('[data-detail-tab]');
  if (tab && snapshot) { detailTab = tab.dataset.detailTab; renderDetail(snapshot); }
  const action = event.target.closest('[data-model-action]');
  const agent = snapshot?.agents.find(agent => agent.id === selectedId);
  if (action && agent) {
    if (action.dataset.modelAction === 'reload') void loadModelSettings(agent);
    if (action.dataset.modelAction === 'apply') void applyModel(agent);
  }
});
$('detail').addEventListener('change', event => {
  const state = modelStates.get(selectedId);
  if (!state?.data || state.pending) return;
  if (event.target.id === 'model-choice') {
    state.model = event.target.value;
    const option = state.data.models.find(option => option.model === state.model);
    if (!option?.efforts.includes(state.effort)) state.effort = option?.defaultEffort || option?.efforts[0];
    renderEfforts(state);
  } else if (event.target.id === 'model-effort') state.effort = event.target.value;
  else if (event.target.id === 'model-scope') {
    state.scope = event.target.value;
    $('model-control').querySelector('.model-scope-hint').textContent = state.scope === 'current'
      ? '已发出的请求保持原设置；只修改此节点当前轮次的后续调用。' : '只修改此节点后续轮次；当前轮次保持原设置。';
  }
});
$('node-process').addEventListener('click', () => { globalProcess = false; if (snapshot) renderTimeline(snapshot); });
$('global-process').addEventListener('click', () => { globalProcess = true; if (snapshot) renderTimeline(snapshot); });
$('live-mode').addEventListener('click', () => switchSource('live'));
$('demo-mode').addEventListener('click', () => switchSource('demo'));
$('sessions').addEventListener('change', event => switchSource('live', event.target.value || undefined));
$('filter').addEventListener('change', () => snapshot && renderGraph(snapshot));
$('refresh').addEventListener('click', () => {
  paused = false; $('graph').classList.remove('paused'); $('pause').textContent = '暂停刷新';
  const load = detailLoads.get(selectedId);
  if (load) load.signature = '';
  void refresh();
});
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('graph').classList.toggle('paused', paused);
  $('pause').textContent = paused ? '继续刷新' : '暂停刷新';
  connection(paused ? '已暂停' : '实时连接', paused);
  if (!paused) void refresh();
});
$('theme').addEventListener('click', () => {
  currentTheme = currentTheme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = currentTheme;
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('pagehide', () => clearInterval(timer));

async function start() {
  if (window.parent !== window) {
    launchPending = true;
    app = new App({ name: 'Agent Monitor', version: '1.1.0' });
    app.ontoolinput = input => {
      if (launchHandled) return;
      generation++;
      mode = input.arguments?.mode === 'demo' ? 'demo' : 'live';
      sessionId = input.arguments?.sessionId;
    };
    app.ontoolresult = result => {
      if (launchHandled) return;
      launchHandled = true;
      launchPending = false;
      generation++;
      if (result.isError) {
        launchPending = true;
        notice((result.content?.find(c => c.type === 'text')?.text || '无法读取当前会话。') + ' 点击“真实会话”可浏览并手动选择其他会话。', true);
        connection('会话读取失败', true);
        return;
      }
      if (result.structuredContent) {
        const data = result.structuredContent;
        if (data.binding) launchBinding = { rootId: data.root_id, binding: data.binding };
        mode = data.demo ? 'demo' : 'live';
        if (!sessionId && !data.demo) sessionId = data.root_id || undefined;
        $('live-mode').classList.toggle('active', mode === 'live');
        $('demo-mode').classList.toggle('active', mode === 'demo');
        try { accept(data); } catch (error) { notice(error.message, true); }
      }
      if (connected) void refresh();
    };
    app.onhostcontextchanged = context => {
      if (context.theme) document.documentElement.dataset.theme = currentTheme = context.theme;
    };
    try {
      await app.connect(); connected = true;
      synchronizeSelected();
      const theme = app.getHostContext()?.theme;
      if (theme) document.documentElement.dataset.theme = currentTheme = theme;
    } catch (error) { notice('插件连接失败：' + error.message, true); connection('连接异常', true); return; }
  } else {
    const params = new URLSearchParams(location.search);
    mode = params.get('mode') === 'demo' ? 'demo' : 'live';
    sessionId = params.get('sessionId') || undefined;
    $('live-mode').classList.toggle('active', mode === 'live');
    $('demo-mode').classList.toggle('active', mode === 'demo');
  }
  await refresh();
  timer = setInterval(() => {
    if (!paused && lastSuccess && Date.now() - lastSuccess > 10000) connection('数据更新延迟', true);
    void refresh();
  }, 1800);
}
void start();
