import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { MonitorBackend } from './backend.mjs';
import { readBoundSnapshot } from './binding.mjs';

const backend = new MonitorBackend();
const server = createServer(async (request, response) => {
  const host = request.headers.host;
  if (!/^127\.0\.0\.1:\d+$/.test(host || '')) { response.writeHead(403).end(); return; }
  if (request.headers.origin && request.headers.origin !== `http://${host}`) { response.writeHead(403).end(); return; }
  let url;
  try { url = new URL(request.url, `http://${host}`); }
  catch { response.writeHead(400).end(); return; }
  if (url.pathname === '/api/model' && request.method === 'POST') {
    if (request.headers.origin !== `http://${host}` || request.headers['content-type'] !== 'application/json') { response.writeHead(403).end(); return; }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 8192) { response.writeHead(413).end(); return; }
      }
      const input = JSON.parse(body);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求格式不正确。');
      const data = await backend.updateModel(input);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  if (url.pathname === '/api/sessions') {
    try {
      const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined;
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
      const data = await backend.sessions({ offset, limit,
        ...(url.searchParams.has('revision') ? { revision: url.searchParams.get('revision') } : {}),
        refresh: url.searchParams.get('refresh') === 'true' });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    } catch (error) { response.writeHead(/目录已更新/.test(error.message) ? 409 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (['/api/snapshot', '/api/details', '/api/model-settings'].includes(url.pathname)) {
    try {
      const input = { mode: url.searchParams.get('mode') || 'live', sessionId: url.searchParams.get('sessionId') || undefined };
      const node = { ...input, agentId: url.searchParams.get('agentId') };
      const data = url.pathname === '/api/details' ? await backend.details(node)
        : url.pathname === '/api/model-settings' ? await backend.modelSettings(node) : await readBoundSnapshot(backend, input);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message })); }
  } else if (url.pathname === '/') {
    try {
      const html = await readFile(new URL('dist/dashboard.html', import.meta.url));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
    } catch { response.writeHead(500).end('请先构建插件界面。'); }
  } else if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); }
  else { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${server.address().port}`));
function stop() { backend.close(); server.close(() => process.exit(0)); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
