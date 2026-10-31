/** Build the Host entry and the browser factory a DSH profile loads. */
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('lib', { recursive: true })

// The Host half carries no @deepseek-ai/* import: it reads the services it
// needs off the injected context through the structural views in src/ports.ts.
// zod is the only runtime dependency, and it is inlined here so the installed
// package needs nothing resolvable beyond its own directory.
await build({
  entryPoints: ['src/index.ts'], outfile: 'lib/index.js',
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  sourcemap: true,
})

await build({
  entryPoints: ['src/client.ts'], outfile: 'lib/client.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022',
  // Seed words of the frozen browser module table. Everything else is bundled.
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  sourcemap: true,
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-claude-ultra", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})
