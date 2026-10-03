import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await mkdir(output, { recursive: true });
await mkdir(new URL('backend/', root), { recursive: true });
for (const name of ['agent_monitor.py', 'desktop_bridge.py', 'sidebar_state.py']) {
  await copyFile(new URL(`../../${name}`, root), new URL(`backend/${name}`, root));
}
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('ui/app.js', root))],
  bundle: true, write: false, format: 'iife', minify: true, target: 'es2022',
});
const html = await readFile(new URL('ui/index.html', root), 'utf8');
const css = await readFile(new URL('ui/style.css', root), 'utf8');
const script = bundled.outputFiles[0].text.replaceAll('</script', '<\\/script');
await writeFile(new URL('dashboard.html', output), html.replace('/* INLINE_STYLE */', () => css).replace('/* INLINE_SCRIPT */', () => script));
console.log('Built sidebar UI and bundled Python reader.');
