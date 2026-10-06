import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogProjectLabel, catalogProjectOptions, filterSessions, groupSessions,
  sessionProject, sessionProjectPath, sessionStatusGroup,
} from '../ui/catalog.js';

const sessions = [
  { id: 'root-a', title: 'Planning', cwd: '/work/one/app', status: 'running' },
  { id: 'child-a', parent_id: 'root-a', title: '', cwd: '/work/one/app', status: 'waiting' },
  { id: 'root-b', title: 'Release notes', cwd: '/work/two/app', status: 'done' },
  { id: 'child-b', parent_id: 'root-b', title: 'Review', cwd: '/work/two/app', status: 'error' },
  { id: 'idle', title: 'Scratch', cwd: '/work/other', status: 'unknown' },
];

test('catalog search covers child session IDs, parent IDs, titles and paths', () => {
  assert.deepEqual(filterSessions(sessions, { query: 'child-a' }).map(item => item.id), ['child-a']);
  assert.deepEqual(filterSessions(sessions, { query: 'root-b' }).map(item => item.id), ['root-b', 'child-b']);
  assert.deepEqual(filterSessions(sessions, { query: 'release notes' }).map(item => item.id), ['root-b']);
  assert.deepEqual(filterSessions(sessions, { query: '/work/two' }).map(item => item.id), ['root-b', 'child-b']);
});

test('same-named project folders remain distinct by normalized full path', () => {
  const paths = catalogProjectOptions(sessions);
  assert.deepEqual(paths, ['/work/one/app', '/work/other', '/work/two/app']);
  assert.equal(sessionProjectPath({ cwd: 'C:\\work\\one\\app\\' }), 'C:/work/one/app');
  assert.equal(sessionProject({ cwd: paths[0] }), 'app');
  assert.equal(catalogProjectLabel(paths[0], paths), '/work/one/app');
  assert.equal(catalogProjectLabel('/work/other', paths), 'other');
  assert.deepEqual(filterSessions(sessions, { project: paths[0] }).map(item => item.id), ['root-a', 'child-a']);
});

test('catalog groups sessions by status and then by full project path', () => {
  assert.equal(sessionStatusGroup('interrupted'), 'history');
  const groups = groupSessions(sessions);
  assert.deepEqual(groups.map(group => group.key), ['running', 'history', 'unknown']);
  assert.deepEqual(groups[0].projects[0].sessions.map(item => item.id), ['root-a', 'child-a']);
  assert.deepEqual(groups[1].projects.map(project => project.path), ['/work/two/app']);
});
