import { describe, expect, it } from 'vitest'
import { classifyToolOutcome } from '../src/state.js'

/**
 * A validation identity names the CHECK, not the shell plumbing around it.
 *
 * Hashing the whole argument text made every retry a new identity, so an
 * obligation opened by a failing run could never be closed by the passing run
 * that verified the repair: the mechanism could accuse but never clear.
 * Reproduced from a live session, where the failing typecheck was piped to
 * `Select-Object -First 40` and the repair was then verified with `-First 30`,
 * with a `; "TSC_EXIT=$LASTEXITCODE"` suffix, and bare.
 */
describe('validation identity', () => {
  const key = (command: string) => classifyToolOutcome({
    name: 'pwsh', arguments: { command }, isError: false, value: { exitCode: 0 }, contentText: '',
  }).validationKey
  const TSC = 'npx tsc -p tsconfig.json --noEmit'

  it('is unchanged by how the same check reports its output', () => {
    expect(key(TSC + ' 2>&1 | Select-Object -First 40')).toBe(key(TSC))
    expect(key(TSC + ' 2>&1 | Select-Object -Last 3')).toBe(key(TSC))
    expect(key(TSC + ' > out.log 2>&1')).toBe(key(TSC))
    expect(key(TSC + '; "TSC_EXIT=$LASTEXITCODE"')).toBe(key(TSC))
  })

  it('is unchanged by a recording prefix in the same call', () => {
    expect(key('$env:DSH_RUNTIME_PACKAGE_JSON = "package.json"; ' + TSC)).toBe(key(TSC))
    expect(key('$env:DSH_RUNTIME_PACKAGE_JSON = "package.json"\n' + TSC)).toBe(key(TSC))
  })

  it('still separates different checks of the same family', () => {
    expect(key('npx vitest run test/other.spec.ts')).not.toBe(key('npx vitest run'))
    expect(key('npx vitest run --config vitest.runtime.config.ts')).not.toBe(key('npx vitest run'))
    expect(key('npm run typecheck')).not.toBe(key('npm test'))
    expect(key('npm run lint')).not.toBe(key('npm test'))
  })

  it('still refuses an ordinary command that merely mentions a check', () => {
    expect(key('echo npm test')).toBeUndefined()
    expect(key('node scripts/benchmark.mjs')).toBeUndefined()
  })
})
