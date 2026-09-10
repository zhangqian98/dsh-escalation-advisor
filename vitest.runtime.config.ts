import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const anchor = process.env.DSH_RUNTIME_PACKAGE_JSON
if (!anchor) throw new Error('Set DSH_RUNTIME_PACKAGE_JSON to the installed DSH package.json to test that runtime.')
const runtime = createRequire(resolve(anchor))

export default defineConfig({
  resolve: {
    alias: [{
      find: /^@deepseek-ai\//,
      replacement: '@deepseek-ai/',
      customResolver(source) { return runtime.resolve(source) },
    }],
  },
  test: { include: ['test/**/*.spec.ts'], testTimeout: 15000 },
})
