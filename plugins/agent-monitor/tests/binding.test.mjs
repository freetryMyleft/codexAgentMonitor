import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBinding, readBoundSnapshot } from '../binding.mjs';

test('explicit selection overrides invocation metadata; demo stays simulated', () => {
  assert.equal(resolveBinding({ sessionId: 'chosen' }, { _meta: { 'openai/threadId': 'other' } }).input.sessionId, 'chosen');
  assert.equal(resolveBinding({ mode: 'demo' }, { _meta: { 'openai/threadId': 'other' } }).binding.source, 'demo');
});

test('binds each invocation independently using executor metadata', () => {
  for (const _meta of [{ 'openai/threadId': 'chat-a' }, { 'x-codex-turn-metadata': { thread_id: 'chat-a' } },
    { 'x-codex-turn-metadata': '{"thread_id":"chat-a"}' }, { thread: { id: 'chat-a' } }]) {
    assert.equal(resolveBinding({}, { _meta }).input.sessionId, 'chat-a');
    assert.equal(resolveBinding({}, { _meta }).binding.source, 'host');
  }
  assert.equal(resolveBinding({}, { _meta: { threadId: 'chat-b' } }).input.sessionId, 'chat-b');
});

test('invalid caller identifiers fail instead of selecting an unrelated latest session', () => {
  assert.throws(() => resolveBinding({}, { _meta: { threadId: '../secret' } }), /无效/);
  assert.throws(() => resolveBinding({}, { _meta: { thread: { id: [] } } }), /无效/);
  for (const _meta of [{ threadId: [] }, { threadId: 123 }, { threadId: '' }, { threadId: null },
    { 'x-codex-turn-metadata': 'not json' }, { 'x-codex-turn-metadata': null }, { thread: [] }, { thread: { id: null } }]) {
    assert.throws(() => resolveBinding({}, { _meta }), /无效/);
  }
});

test('missing metadata is clearly labelled; snapshot annotations do not mutate reader cache', async () => {
  const cached = { agents: [], flows: [], warning: '原有警告' };
  const result = await readBoundSnapshot({ read: async () => cached }, {});
  assert.equal(result.binding.source, 'latest');
  assert.match(result.warning, /原有警告.*未提供会话绑定/);
  assert.equal(cached.warning, '原有警告');
  assert.equal(cached.binding, undefined);
});

test('missing host session logs fail instead of accepting an empty unpinned launch', async () => {
  await assert.rejects(readBoundSnapshot({ read: async () => ({ root_id: null, agents: [], flows: [] }) }, {},
    { _meta: { threadId: 'missing' } }), /不会自动切换/);
});
