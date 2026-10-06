import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDiscovery } from '../scripts/doctor.mjs';

const tool = { name: 'open_agent_monitor', _meta: { ui: { resourceUri: 'ui://agent-monitor/dashboard', visibility: ['model', 'app'] },
  'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } };
const resource = { contents: [{ uri: 'ui://agent-monitor/dashboard', mimeType: 'text/html;profile=mcp-app', text: '<html><script>ready()</script></html>' }] };
test('doctor validates live advertised entrypoints/resource and keeps actual sidebar visibility unverified', () => {
  const result = inspectDiscovery([tool, { name: 'list_agent_sessions' }], resource);
  assert.equal(result.server_ready, true);
  assert.equal(result.sidebar_visibility, 'unverified');
  assert(result.checks.every(check => check.ok));
});
test('doctor pinpoints missing global metadata instead of declaring server ready', () => {
  const broken = { ...tool, _meta: { ...tool._meta, 'openai/ui': { entrypoints: [{ type: 'thread' }] } } };
  const result = inspectDiscovery([broken, { name: 'list_agent_sessions' }], resource);
  assert.equal(result.server_ready, false);
  assert(result.checks.some(check => check.id === 'global_entrypoint' && !check.ok));
});
test('doctor rejects unbuilt UI and does not report any conversation content', () => {
  const result = inspectDiscovery([tool], { contents: [{ ...resource.contents[0], text: '/* INLINE_SCRIPT */' }] });
  assert(result.checks.some(check => check.id === 'bundled_ui' && !check.ok));
  assert(!JSON.stringify(result).includes('INLINE_SCRIPT'));
});
