import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { advisorConfigReader, modernRuntime, onAdvisorConfigChange, PluginConfigSchema } from '../src/runtime-compat.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/config.js'

const anchor = process.env.DSH_RUNTIME_PACKAGE_JSON

describe.skipIf(!anchor || !modernRuntime)('deployed V4 Config forms', () => {
  it('persists Advisor fields and updates its live reader without remounting', async () => {
    const runtime = createRequire(resolve(anchor!))
    const load = (name: string) => import(pathToFileURL(runtime.resolve(name)).href)
    const { boot, initProfile, readProfilePatches } = await load('@deepseek-ai/dsh-app-boot')
    const { default: Settings } = await load('@deepseek-ai/dsh-settings')
    const { default: ConfigEditor } = await load('@deepseek-ai/dsh-config-editor')
    const home = mkdtempSync(join(tmpdir(), 'advisor-config-'))
    const dir = join(home, 'profiles', 'test')
    let ctx: Context | undefined
    let read: (() => Config) | undefined
    let mounts = 0, updates = 0
    try {
      initProfile(dir, ['test-bundle'])
      const bundle = join(dir, 'node_modules', 'test-bundle')
      mkdirSync(bundle, { recursive: true })
      writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}')
      writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
        { id: 'config-editor', name: 'cordis:editor' },
        { id: 'settings', name: 'cordis:settings' },
        { id: 'escalation-advisor', name: 'cordis:probe', config: { model: 'original', provider: 'mock' } },
      ] }]))
      writeFileSync(join(dir, 'cordis.yml'), '[]\n')
      const profile = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
      ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root: Context & { loader: { builtins: object } }) => {
        root.provide('profileContext', profile)
        root.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
        Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: Settings, probe: {
          Config: PluginConfigSchema,
          apply(scope: Context, config: Parameters<typeof advisorConfigReader>[1]) {
            mounts++
            read = advisorConfigReader(scope, config)
            onAdvisorConfigChange(scope, () => { updates++ })
          },
        } })
      })
      expect(read!().model).toBe('original')
      expect(ctx!.settings.describe().find(row => row.ns === 'escalation-advisor')?.value).toMatchObject({ provider: 'mock', model: 'original' })
      await ctx!.settings.update('escalation-advisor', { model: 'changed', defaultEnabledTools: ['grep'], timeoutMs: 1000 })
      expect(read!()).toMatchObject({ model: 'changed', defaultEnabledTools: ['grep'], timeoutMs: 1000 })
      expect(mounts).toBe(1)
      expect(updates).toBeGreaterThan(0)
      expect(readFileSync(profile.patchPath, 'utf8')).toContain('changed')
      await expect(ctx!.settings.update('escalation-advisor', { timeoutMs: 0 })).rejects.toThrow()
      expect(read!().timeoutMs).toBe(1000)
    } finally { await ctx?.fiber.dispose(); rmSync(home, { recursive: true, force: true }) }
  })
})
