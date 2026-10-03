import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await mkdir(output, { recursive: true });
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('ui/app.js', root))],
  bundle: true, write: false, format: 'iife', minify: true, target: 'es2022',
});
const html = await readFile(new URL('ui/index.html', root), 'utf8');
const css = await readFile(new URL('ui/style.css', root), 'utf8');
const script = bundled.outputFiles[0].text.replaceAll('</script', '<\\/script');
await writeFile(new URL('dashboard.html', output), html.replace('/* INLINE_STYLE */', () => css).replace('/* INLINE_SCRIPT */', () => script));
await build({
  entryPoints: [fileURLToPath(new URL('server.mjs', root))],
  outfile: fileURLToPath(new URL('runtime.pending.mjs', root)),
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  banner: { js: 'import { createRequire as runtimeCreateRequire } from "node:module"; const require = runtimeCreateRequire(import.meta.url);' },
});
await rename(new URL('runtime.pending.mjs', root), new URL('runtime.mjs', root));
console.error('Built standalone MCP runtime and sidebar UI.');
