/** Build the browser half into a Node-loadable ESM bundle for the unit suite. */
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('.test', { recursive: true })

// The client half imports only local modules and type-only ports, so nothing is
// external and no alias stands in for a shell package: the bundle under .test/
// is the exact browser module the specs exercise.
await build({
  entryPoints: ['src/client.ts'], outfile: '.test/client.js',
  bundle: true, format: 'esm', platform: 'node', target: 'es2022',
  sourcemap: true,
})
