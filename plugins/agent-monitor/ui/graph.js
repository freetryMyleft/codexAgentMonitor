export function layoutAgents(agents, rootId, filter = 'all') {
  const root = agents.find(a => a.id === rootId) || agents.find(a => !a.parent_id) || agents[0];
  if (!root) return { nodes: [], edges: [], width: 680, height: 400, root: null };
  const byParent = new Map();
  for (const agent of agents) {
    if (agent.id === root.id) continue;
    if (!byParent.has(agent.parent_id)) byParent.set(agent.parent_id, []);
    byParent.get(agent.parent_id).push(agent);
  }
  const visited = new Set();
  const levels = [];
  let frontier = [root];
  while (frontier.length) {
    const level = [], next = [];
    for (const agent of frontier) {
      if (visited.has(agent.id)) continue;
      visited.add(agent.id);
      level.push(agent);
      next.push(...(byParent.get(agent.id) || []));
    }
    if (level.length) levels.push(level);
    frontier = next;
  }
  // Preserve ancestors of filtered nodes so edges never imply new parentage.
  const keep = new Set([root.id]);
  for (const agent of agents) {
    const matches = filter === 'all' || (filter === 'running' && agent.status === 'running') ||
      (filter === 'attention' && ['error', 'interrupted'].includes(agent.status));
    if (!matches) continue;
    let cursor = agent;
    const seen = new Set();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id); keep.add(cursor.id);
      cursor = agents.find(a => a.id === cursor.parent_id);
    }
  }
  const visibleLevels = levels.map(level => level.filter(a => keep.has(a.id))).filter(level => level.length);
  const width = Math.max(680, ...visibleLevels.map(level => level.length * 220 + 60));
  const nodes = [];
  visibleLevels.forEach((level, depth) => {
    const rowLeft = (width - level.length * 220) / 2;
    level.forEach((agent, index) => {
      const size = agent.id === root.id ? 224 : 190;
      nodes.push({ agent, x: rowLeft + index * 220 + 110 - size / 2, y: 25 + depth * 185, width: size, height: 118, depth });
    });
  });
  const edges = [];
  for (const node of nodes) {
    const parent = nodes.find(n => n.agent.id === node.agent.parent_id);
    if (parent && parent !== node) edges.push({ from: parent, to: node });
  }
  return { root, nodes, edges, width, height: Math.max(400, visibleLevels.length * 185 + (nodes.length > 1 ? 100 : 30)) };
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function shortNumber(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

export function sessionLabel(session) {
  return session.title || session.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || '未命名会话';
}

export function agentLabel(agent, rootId, sessionTitle) {
  if (agent.id === rootId && sessionTitle) return sessionTitle;
  const role = ({ main: '主控', worker: '工作智能体', explorer: '代码探索', researcher: '资料研究', architect: '架构顾问', 'code-reviewer': '代码审查', 'python-reviewer': 'Python 审查', 'typescript-reviewer': '前端审查' })[agent.role] || agent.role || '智能体';
  return agent.name ? `${role} · ${agent.name}` : `${role} · ${agent.session_title || agent.id.slice(0, 8)}`;
}

export function nodeEvents(snapshot, selectedId, global = false) {
  if (global) return snapshot.flows || [];
  const agent = snapshot.agents.find(a => a.id === selectedId);
  return agent?.events || (snapshot.flows || []).filter(event => event.agent_id === selectedId);
}

export function agentGroups(agents) {
  return [
    { label: '正在执行', agents: agents.filter(a => ['running', 'waiting'].includes(a.status)) },
    { label: '历史记录 · 已结束', agents: agents.filter(a => ['done', 'error', 'interrupted'].includes(a.status)) },
    { label: '状态未确定 / 空闲', agents: agents.filter(a => !['running', 'waiting', 'done', 'error', 'interrupted'].includes(a.status)) },
  ].filter(group => group.agents.length);
}

export function stageFor(snapshot) {
  if (snapshot.agents.some(a => /reviewer|architect/.test(a.role) && a.status === 'running')) return 'review';
  const latest = snapshot.flows?.at(-1);
  if (latest?.phase === 'dispatch') return 'dispatch';
  if (latest?.phase === 'return' || latest?.phase === 'complete') return 'return';
  if (snapshot.agents.some(a => a.parent_id && a.status === 'running')) return 'execute';
  return 'main';
}
