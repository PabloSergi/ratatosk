/**
 * The front-end build: type-check with tsc (see web/tsconfig.json), bundle with esbuild, and copy the
 * static shell. The result is plain files in public/ which the server hands out — no framework, no
 * runtime dependency, and every line of it type-checked against the engine's own types.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('public', { recursive: true, force: true });
await mkdir('public', { recursive: true });

const result = await build({
  entryPoints: ['web/app.ts'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: 'public/app.js',
  minify: process.env.NODE_ENV === 'production',
  sourcemap: process.env.NODE_ENV !== 'production',
  logLevel: 'warning',
  metafile: true,
});

// The pure rendering helpers are bundled once more for the test runner, which imports from dist/.
await build({
  entryPoints: ['web/render.ts'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: 'dist/web-render.js',
  logLevel: 'warning',
});

await cp('web/index.html', 'public/index.html');
await cp('web/styles.css', 'public/styles.css');

const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(`web bundle: ${(bytes / 1024).toFixed(1)} kB`);
