import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Bundles the Privy/React pay island into the zero-dependency server's static
// ui/ directory as a self-contained classic script (window.buenaPay).
await build({
  entryPoints: [join(here, 'src/island.jsx')],
  outfile: join(here, '../ui/pay.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
  minify: true, sourcemap: false, logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
});
