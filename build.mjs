import { build } from 'esbuild'

// Each action ships a self-contained CommonJS bundle committed to the repo,
// since GitHub runs actions straight from the tree at the consumed ref.
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  legalComments: 'inline',
}

// .cjs because the repo's package.json declares "type": "module" for the
// TypeScript sources, while the bundles are CommonJS.
await build({ ...shared, entryPoints: ['src/main.ts'], outfile: 'dist/index.cjs' })
await build({ ...shared, entryPoints: ['src/publish.ts'], outfile: 'release/dist/index.cjs' })
await build({ ...shared, entryPoints: ['src/novidades.ts'], outfile: 'novidades/dist/index.cjs' })
