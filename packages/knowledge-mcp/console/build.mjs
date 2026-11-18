// Builds the console page into dist/console-ui (run from the package folder; `npm run build` does).
// esbuild only: it is already in the tree through tsx, so the page adds no build tool of its own.
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const outdir = 'dist/console-ui';
const options = {
  entryPoints: { app: 'console/src/main.tsx' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: !process.argv.includes('--watch'),
  sourcemap: process.argv.includes('--watch') ? 'inline' : false,
  outdir,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
};
mkdirSync(outdir, { recursive: true });
copyFileSync('console/index.html', `${outdir}/index.html`);

// The bundle holds other people's code (minified, so their file headers are gone): their notices go out with it.
const require = createRequire(import.meta.url);
const licenseOf = (name) => readFileSync(join(dirname(require.resolve(`${name}/package.json`)), 'LICENSE'), 'utf8').trim();
const notices = [
  'The console page (app.js, app.css) includes the following software.',
  ...['react', 'react-dom', 'scheduler'].map((name) => `── ${name} ${require(`${name}/package.json`).version} ──\n\n${licenseOf(name)}`),
  `── affectUI components ──\n\n${readFileSync('console/src/ui/NOTICE.md', 'utf8').trim()}`,
];
writeFileSync(`${outdir}/THIRD-PARTY-NOTICES.txt`, `${notices.join('\n\n\n')}\n`);
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.error('[console] watching console/src');
} else {
  await build(options);
}
