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
    expect(key('cat vitest.log')).toBeUndefined()
    expect(key('npm testx')).toBeUndefined()
  })

  it('refuses a check quoted into the argument of another command', () => {
    // The defect being fixed: each of these minted an identity, so a commit that
    // only QUOTED the test command opened an obligation for a run that never
    // happened. A quoted separator is not a separator.
    expect(key('git commit -m "notes; npx vitest run"')).toBeUndefined()
    expect(key('git commit -m "npx vitest run"')).toBeUndefined()
    expect(key('echo "npm test"')).toBeUndefined()
    expect(key("git commit -m 'npm test'")).toBeUndefined()
  })

  it('refuses a redirection target that merely looks like a check', () => {
    // A file named `vitest` is not an invocation of vitest.
    expect(key('echo ok > vitest')).toBeUndefined()
    expect(key('echo ok < pytest')).toBeUndefined()
  })

  it('still finds the real check behind an earlier mention', () => {
    // The old guard read only the START of the command, so the genuine check
    // here was discarded along with the mention.
    expect(key('echo "npm test"; npm test')).toBe(key('npm test'))
    expect(key('echo "npm test" && npm test')).toBe(key('npm test'))
    expect(key('grep needle file; npm test')).toBe(key('npm test'))
    expect(key('git commit -m "notes; npm test"; npm test')).toBe(key('npm test'))
  })

  it('still finds a check behind a wrapper, an assignment, or a redirection', () => {
    expect(key('CI=1 npm test')).toBe(key('npm test'))
    expect(key('FOO=bar npm test')).toBe(key('npm test'))
    expect(key('env CI=1 npm test')).toBe(key('npm test'))
    expect(key('$env:CI = "1"; npm test')).toBe(key('npm test'))
    expect(key('npm test > out.log 2>&1')).toBe(key('npm test'))
    expect(key('npm test 2>&1 | Select-Object -First 40')).toBe(key('npm test'))
    expect(key('npx vitest run')).toBeDefined()
    expect(key('npx --yes vitest run')).toBeDefined()
  })

  it('still finds a check inside the command string of a shell wrapper', () => {
    // A quoted command string is argument text, so a naive rule loses these: the
    // false-negative direction. The wrapper executes what it quotes, so the
    // quoted line is re-read as a command line rather than dismissed.
    expect(key('bash -c "npm test"')).toBeDefined()
    expect(key('pwsh -Command "npm test"')).toBeDefined()
    expect(key('cmd /c "npm test"')).toBeDefined()
    expect(key('pwsh -Command "npx vitest run"')).toBeDefined()
    // Stable across identical retries, which is what the identity is for.
    expect(key('pwsh -Command "npm test"')).toBe(key('pwsh -Command "npm test"'))
    // A mention nested one level deeper is still only a mention.
    expect(key('bash -c "echo npm test"')).toBeUndefined()
    expect(key("bash -c 'git commit -m \"notes; npm test\"'")).toBeUndefined()
    // A shell invoked with a script file runs no check we can see.
    expect(key('bash scripts/check.sh')).toBeUndefined()
  })

  it('does not leak scan state between calls', () => {
    // The family is scanned with ONE shared global RegExp, so a missing reset
    // would make later calls skip matches depending on the previous command.
    const mention = 'git commit -m "notes; npm test"'
    expect(key(mention)).toBeUndefined()
    expect(key('npm test')).toBe(key('npm test'))
    expect(key(mention)).toBeUndefined()
    expect(key('npm test')).toBeDefined()
    expect(key(TSC)).toBeDefined()
    expect(key(mention)).toBeUndefined()
  })
})
