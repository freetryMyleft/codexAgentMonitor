const sessionPattern = /^[a-zA-Z0-9_-]{1,80}$/;

// Matches metadata keys accepted by the bundled Codex app-tools executor.
// This is per invocation: never infer a caller from server environment variables.
export function resolveBinding(input = {}, extra = {}) {
  if (input.mode === 'demo') return { input, binding: { source: 'demo', label: '模拟会话' } };
  if (input.sessionId !== undefined) {
    if (!sessionPattern.test(input.sessionId)) throw new Error('会话 ID 格式不正确。');
    return { input, binding: { source: 'explicit', label: '所选会话' } };
  }
  const metadata = extra._meta ?? {};
  const invalid = () => { throw new Error('客户端会话信息无效，请手动选择会话。'); };
  if (typeof metadata !== 'object' || Array.isArray(metadata)) invalid();
  let threadId;
  for (const key of ['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id']) {
    if (metadata[key] !== undefined) {
      if (typeof metadata[key] !== 'string' || !metadata[key].trim()) invalid();
      threadId = metadata[key]; break;
    }
  }
  if (threadId === undefined && metadata['x-codex-turn-metadata'] !== undefined) {
    let turn = metadata['x-codex-turn-metadata'];
    if (typeof turn === 'string') {
      try { turn = JSON.parse(turn); } catch { invalid(); }
    }
    if (!turn || typeof turn !== 'object' || Array.isArray(turn) || turn.thread_id === undefined) invalid();
    threadId = turn.thread_id;
  }
  if (threadId === undefined && metadata.thread !== undefined) {
    if (!metadata.thread || typeof metadata.thread !== 'object' || Array.isArray(metadata.thread) || metadata.thread.id === undefined) invalid();
    threadId = metadata.thread.id;
  }
  if (threadId !== undefined) {
    if (typeof threadId !== 'string' || !sessionPattern.test(threadId)) throw new Error('客户端会话信息无效，请手动选择会话。');
    return { input: { ...input, sessionId: threadId }, binding: { source: 'host', label: '当前会话' } };
  }
  return { input, binding: { source: 'latest', label: '最近会话（未绑定当前聊天）' } };
}

export async function readBoundSnapshot(backend, input, extra) {
  const resolved = resolveBinding(input, extra);
  const snapshot = await backend.read(resolved.input);
  if (resolved.input.sessionId && !snapshot.root_id) {
    throw new Error('所选会话日志尚未找到或不可读，请在面板中手动选择会话。不会自动切换到最近会话。');
  }
  return { ...snapshot, binding: resolved.binding,
    warning: [snapshot.warning, resolved.binding.source === 'latest'
      ? '客户端未提供会话绑定：当前展示最近更新的会话，请在会话列表中选择。' : ''].filter(Boolean).join(' ') };
}
