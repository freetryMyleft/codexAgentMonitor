const sessionPattern = /^[a-zA-Z0-9_-]{1,80}$/;

// Invocation metadata is not a session selection. The hub starts unselected and
// only an explicit sessionId may open a local tree.
export function resolveBinding(input = {}) {
  if (input.mode === 'demo') return { input, binding: { source: 'demo', label: '模拟会话' } };
  if (input.sessionId !== undefined) {
    if (typeof input.sessionId !== 'string' || !sessionPattern.test(input.sessionId)) throw new Error('会话 ID 格式不正确。');
    return { input, binding: { source: 'explicit', label: '所选会话' } };
  }
  return { input, binding: { source: 'unselected', label: '先选择会话' } };
}

export async function readBoundSnapshot(backend, input = {}) {
  const resolved = resolveBinding(input);
  const snapshot = await backend.read(resolved.input);
  if (resolved.input.sessionId && !snapshot.root_id) {
    throw new Error('所选会话日志尚未找到或不可读，请在面板中手动选择会话。不会自动切换到最近会话。');
  }
  return { ...snapshot, binding: resolved.binding };
}
