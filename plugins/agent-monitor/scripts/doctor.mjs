import { readFile, access, realpath } from 'node:fs/promises';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export function inspectDiscovery(tools = [], resource = {}) {
  const tool = tools.find(value => value.name === 'open_agent_monitor');
  const uri = tool?._meta?.ui?.resourceUri;
  const entrypoints = tool?._meta?.['openai/ui']?.entrypoints || [];
  const content = resource.contents?.find(value => value.uri === uri);
  const checks = [
    { id: 'open_tool', label: '监控入口工具', ok: Boolean(tool) },
    { id: 'catalog_tool', label: '全会话目录工具', ok: tools.some(value => value.name === 'list_agent_sessions') },
    { id: 'global_entrypoint', label: '全局侧边栏声明', ok: entrypoints.some(value => value.type === 'global') },
    { id: 'thread_entrypoint', label: '会话面板声明', ok: entrypoints.some(value => value.type === 'thread') },
    { id: 'ui_resource', label: 'MCP App 资源', ok: uri === 'ui://agent-monitor/dashboard' && content?.mimeType === 'text/html;profile=mcp-app' },
    { id: 'bundled_ui', label: '预构建界面', ok: typeof content?.text === 'string' && /<script>/.test(content.text) && !/INLINE_STYLE|INLINE_SCRIPT/.test(content.text) },
  ];
  return { checks, server_ready: checks.every(check => check.ok), sidebar_visibility: 'unverified',
    guidance: '服务声明正确不代表客户端显示了入口。官方侧边栏说明面向 ChatGPT；请在当前客户端实际检查全局侧边栏或会话面板。',
    documentation: 'https://developers.openai.com/plugins/build/extensions' };
}

export async function diagnosePlugin(pluginDirectory, { timeoutMs = 10000 } = {}) {
  const checks = [];
  try {
    const manifest = JSON.parse(await readFile(join(pluginDirectory, '.codex-plugin/plugin.json'), 'utf8'));
    checks.push({ id: 'manifest', label: '插件 manifest', ok: manifest.name === 'agent-monitor', version: manifest.version });
    for (const file of ['runtime.mjs', 'dist/dashboard.html', 'backend/desktop_bridge.py', 'scripts/start.sh']) await access(join(pluginDirectory, file));
    checks.push({ id: 'runtime_files', label: '预构建运行文件', ok: true });
  } catch {
    return { checks: [...checks, { id: 'runtime_files', label: '安装包不完整，请重新安装预构建包', ok: false }], server_ready: false, sidebar_visibility: 'unverified' };
  }
  const client = new Client({ name: 'agent-monitor-doctor', version: '1.2.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(pluginDirectory, 'runtime.mjs')],
    env: { ...process.env }, stderr: 'pipe' });
  // Consume but never print server diagnostics: unrelated environment and log
  // contents do not belong in a shareable discovery report.
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: timeoutMs });
    checks.push({ id: 'mcp_connect', label: 'MCP 初始化', ok: true });
    const tools = (await client.listTools({}, { timeout: timeoutMs })).tools;
    const tool = tools.find(value => value.name === 'open_agent_monitor');
    const uri = tool?._meta?.ui?.resourceUri;
    const resource = uri === 'ui://agent-monitor/dashboard' ? await client.readResource({ uri }, { timeout: timeoutMs }) : {};
    const report = inspectDiscovery(tools, resource);
    return { ...report, checks: [...checks, ...report.checks], server_ready: checks.every(check => check.ok) && report.server_ready };
  } catch {
    return { checks: [...checks, { id: 'mcp_discovery', label: 'MCP 服务连接或资源读取失败（检查包版本和 Node 环境）', ok: false }],
      server_ready: false, sidebar_visibility: 'unverified' };
  } finally { await client.close(); }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && self === await realpath(process.argv[1])) {
  const directory = process.argv[2] || (basename(dirname(self)) === 'scripts' ? resolve(dirname(self), '..') : dirname(self));
  const report = await diagnosePlugin(resolve(directory));
  console.log(JSON.stringify(report, null, 2));
  if (!report.server_ready) process.exitCode = 1;
}
