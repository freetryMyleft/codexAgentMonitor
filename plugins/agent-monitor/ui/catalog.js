const statusGroups = [
  { key: 'running', label: '执行中', matches: status => ['running', 'waiting'].includes(status) },
  { key: 'history', label: '历史记录 · 已结束', matches: status => ['done', 'error', 'interrupted'].includes(status) },
  { key: 'unknown', label: '状态未确定 / 空闲', matches: status => !['running', 'waiting', 'done', 'error', 'interrupted'].includes(status) },
];

export function sessionProjectPath(session) {
  return (session.cwd || '').replaceAll('\\', '/').replace(/\/+$/, '');
}

export function sessionProject(session) {
  const path = sessionProjectPath(session);
  return path.split('/').filter(Boolean).at(-1) || '未命名项目';
}

export function sessionStatusGroup(status) {
  return statusGroups.find(group => group.matches(status))?.key || 'unknown';
}

export function filterSessions(sessions, { query = '', project = '', status = 'all' } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return sessions.filter(session => {
    const searchable = `${session.title || ''}\n${session.id || ''}\n${session.cwd || ''}\n${session.parent_id || ''}`.toLocaleLowerCase();
    return (!needle || searchable.includes(needle)) &&
      (!project || sessionProjectPath(session) === project) &&
      (status === 'all' || sessionStatusGroup(session.status) === status);
  });
}

export function groupSessions(sessions) {
  return statusGroups.map(group => {
    const matches = sessions.filter(session => group.matches(session.status));
    const projects = new Map();
    for (const session of matches) {
      const path = sessionProjectPath(session);
      if (!projects.has(path)) projects.set(path, []);
      projects.get(path).push(session);
    }
    return { key: group.key, label: group.label, projects: [...projects]
      .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
      .map(([path, items]) => ({ path, project: path ? sessionProject({ cwd: path }) : '未命名项目', sessions: items })) };
  }).filter(group => group.projects.length);
}

// Values are normalized full paths so projects with the same folder name remain distinct.
export function catalogProjectOptions(sessions) {
  return [...new Set(sessions.map(sessionProjectPath))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

export function catalogProjectLabel(path, paths = []) {
  const name = sessionProject({ cwd: path });
  return paths.filter(candidate => sessionProject({ cwd: candidate }) === name).length > 1 ? path || name : name;
}
