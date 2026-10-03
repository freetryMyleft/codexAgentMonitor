import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIExtensions } from '@openai/mcp-extensions/server';
import { z } from 'zod';
import { MonitorBackend } from './backend.mjs';

const server = new McpServer({ name: 'agent-monitor', version: '1.0.0' });
new OpenAIExtensions(server);
const backend = new MonitorBackend();
const uri = 'ui://agent-monitor/dashboard';
const html = await readFile(new URL('dist/dashboard.html', import.meta.url), 'utf8');
const icon = 'data:image/svg+xml;base64,' + Buffer.from(await readFile(new URL('assets/icon.svg', import.meta.url))).toString('base64');

registerAppResource(server, 'Agent Monitor', uri, {}, async () => ({
  contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: {
    ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
    'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen', 'pip', 'inline'] },
  } }],
}));

const inputSchema = {
  mode: z.enum(['live', 'demo']).optional().describe('live reads local logs; demo is explicitly simulated.'),
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional().describe('A local Codex session ID or unique prefix; omitted selects latest.'),
};
async function readSnapshot(input) {
  try {
    const data = await backend.read(input);
    return { content: [{ type: 'text', text: `${data.demo ? '演示' : '本地会话'}：${data.agents.length} 个 Agent。${data.warning || ''}` }], structuredContent: data };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
}

registerAppTool(server, 'open_agent_monitor', {
  title: 'Agent Monitor', description: '打开本地 Agent 调度监控，展示真实父子流程、执行状态、结果回流、Token 与时间线。只读本地日志。',
  inputSchema, icons: [{ src: icon, mimeType: 'image/svg+xml', sizes: ['any'] }],
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: uri, visibility: ['model', 'app'] },
    'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
}, readSnapshot);

server.registerTool('get_agent_snapshot', {
  title: '刷新 Agent Monitor', description: '读取当前本地会话快照供监控界面刷新；无需模型参与。',
  inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ['app'] } },
}, readSnapshot);

server.registerTool('get_agent_details', {
  title: '读取选中节点的公开过程与结果', description: '仅在点击节点时读取该节点公开的过程说明和最终回答，不返回内部推理或其他节点正文。',
  inputSchema: { ...inputSchema, agentId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } },
}, async input => {
  try { return { content: [{ type: 'text', text: '已读取选中节点。' }], structuredContent: await backend.details(input) }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});

const nodeSchema = { ...inputSchema, agentId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) };
server.registerTool('get_agent_model_settings', {
  title: '读取节点模型配置', description: '读取本机可用模型与选中节点的控制状态。只读；不会加载或启动节点。',
  inputSchema: nodeSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } },
}, async input => {
  try { return { content: [{ type: 'text', text: '已读取模型配置。' }], structuredContent: await backend.modelSettings(input) }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});

server.registerTool('update_agent_model', {
  title: '修改选中节点模型', description: '用户在节点面板点击应用后，修改此节点当前轮次的后续调用或后续轮次配置。不会修改其他节点，也不会启动任务。',
  inputSchema: { ...nodeSchema, model: z.string().min(1).max(120), effort: z.string().min(1).max(32),
    scope: z.enum(['future', 'current']), turnId: z.string().min(1).max(120).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } },
}, async input => {
  try { const data = await backend.updateModel(input); return { content: [{ type: 'text', text: data.message }], structuredContent: data }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});

process.on('SIGTERM', () => { backend.close(); process.exit(0); });
process.on('SIGINT', () => { backend.close(); process.exit(0); });
process.stdin.on('end', () => { backend.close(); process.exit(0); });
await server.connect(new StdioServerTransport());
