// Builds the console page into dist/console-ui (run from the package folder; `npm run build` does).
// esbuild only: it is already in the tree through tsx, so the page adds no build tool of its own.
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
// Which packages are in it is read from the build itself, so a library added later is never left out.
function notices(inputs) {
  const packages = new Map();
  for (const file of Object.keys(inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file.split('node_modules/').length > 2 ? file.slice(file.lastIndexOf('node_modules/')) : file);
    if (!m || packages.has(m[1])) continue;
    const dir = file.slice(0, file.lastIndexOf(`node_modules/${m[1]}/`) + `node_modules/${m[1]}/`.length);
    packages.set(m[1], dir);
  }
  const blocks = [...packages.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, dir]) => {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
      const text = file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${pkg.license ?? 'see the package'}${pkg.author ? `\nAuthor: ${typeof pkg.author === 'string' ? pkg.author : pkg.author.name}` : ''}`;
      return `── ${name} ${pkg.version} ──\n\n${text}`;
    });
  return [
    'The console page (app.js, app.css) includes the following software.',
    ...blocks,
    `── affectUI components ──\n\n${readFileSync('console/src/ui/NOTICE.md', 'utf8').trim()}`,
  ].join('\n\n\n');
}
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.error('[console] watching console/src');
} else {
  const result = await build({ ...options, metafile: true });
  writeFileSync(`${outdir}/THIRD-PARTY-NOTICES.txt`, `${notices(result.metafile.inputs)}\n`);
}
