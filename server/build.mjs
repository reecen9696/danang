/**
 * Bundles the server into a single file.
 *
 * We bundle rather than `tsc` because the simulation is imported straight out
 * of `../game/src` — sharing the client's modules is the whole point, and a
 * plain tsc build can't emit sources from outside its rootDir. esbuild inlines
 * them and leaves node_modules external for npm to install at deploy time.
 */
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'build/index.js',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  // three ships an ESM build; keep the import graph honest for Node.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});
