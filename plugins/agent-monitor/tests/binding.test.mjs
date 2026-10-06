import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBinding, readBoundSnapshot } from '../binding.mjs';

test('explicit selection overrides invocation metadata; demo stays simulated', () => {
  assert.equal(resolveBinding({ sessionId: 'chosen' }, { _meta: { 'openai/threadId': 'other' } }).input.sessionId, 'chosen');
  assert.equal(resolveBinding({ mode: 'demo' }, { _meta: { 'openai/threadId': 'other' } }).binding.source, 'demo');
});

test('opens the hub without inferring a session from executor metadata', () => {
  for (const _meta of [{ 'openai/threadId': 'chat-a' }, { 'x-codex-turn-metadata': { thread_id: 'chat-a' } },
    { 'x-codex-turn-metadata': '{"thread_id":"chat-a"}' }, { thread: { id: 'chat-a' } }]) {
    assert.equal(resolveBinding({}, { _meta }).input.sessionId, undefined);
    assert.equal(resolveBinding({}, { _meta }).binding.source, 'unselected');
  }
  assert.equal(resolveBinding({}, { _meta: { threadId: 'chat-b' } }).input.sessionId, undefined);
});

test('invalid invocation metadata is ignored while explicit session IDs are validated', () => {
  assert.equal(resolveBinding({}, { _meta: { threadId: '../secret' } }).binding.source, 'unselected');
  assert.equal(resolveBinding({}, { _meta: { thread: { id: [] } } }).binding.source, 'unselected');
  for (const sessionId of ['../secret', [], 123, '', null]) {
    assert.throws(() => resolveBinding({ sessionId }), /格式不正确/);
  }
});

test('unselected snapshot returns the catalog without reading a tree or mutating its cache', async () => {
  const cached = { root_id: null, agents: [], flows: [], sessions: [{ id: 'chat-a' }], warning: '目录提示' };
  let calls = 0;
  const result = await readBoundSnapshot({ read: async input => { calls++; assert.equal(input.sessionId, undefined); return cached; } }, {});
  assert.equal(calls, 1);
  assert.equal(result.root_id, null);
  assert.equal(result.binding.source, 'unselected');
  assert.equal(result.warning, '目录提示');
  assert.equal(cached.binding, undefined);
});

test('an explicitly selected missing session fails instead of accepting an empty tree', async () => {
  await assert.rejects(readBoundSnapshot({ read: async () => ({ root_id: null, agents: [], flows: [] }) },
    { sessionId: 'missing' }), /不会自动切换/);
});
