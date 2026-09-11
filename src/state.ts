import { createHash } from 'node:crypto'
import type { Config } from './config.js'

export interface ObservedToolResult {
  callId?: string
  /** Execution scope the call belongs to: the task identity of its requester. */
  scope?: string
  name: string
  arguments: unknown
  isError: boolean
  errorMessage?: string
  errorCode?: string
  value?: unknown
  contentText: string
}
export interface EscalationSignal {
  kind: 'tool-error' | 'repeated-failure' | 'nonzero-exit' | 'repeated-mutation'
  weight: number
  fingerprint: string
  detail: string
  validationKey?: string
}
interface SessionState {
  score: number
  activeSignals: EscalationSignal[]
  recentSignals: EscalationSignal[]
  evidence: TrackerEvidence[]
  lastFailureFingerprint?: string
  lastFailureValidationKey?: string
  repeatedFailureCount: number
  mutationCounts: Map<string, number>
  mutationTargets: Map<string, string[]>
  mutationPenaltyIssued: Set<string>
  consultCountByProblem: Map<string, number>
  autoConsultCountByTurn: Map<number, number>
  lastAutoConsultTurn?: number
  lastReviewedTurn?: number
}
export interface EscalationDecision {
  shouldConsult: boolean
  score: number
  problemFingerprint: string
  signals: readonly EscalationSignal[]
  evidence?: readonly TrackerEvidence[]
  reason?: string
}
export type OutcomeClass =
  | 'success'
  | 'validation-failure'
  | 'expected-negative'
  | 'permission-denial'
  | 'cancelled'
  | 'timeout'
  | 'tool-infrastructure-error'
  | 'unknown-failure'
export interface ToolOutcome {
  class: OutcomeClass
  exitCode?: number
  validationKey?: string
}
export interface TrackerEvidence {
  callId?: string
  tool: string
  fingerprint?: string
  argumentsSummary: string
  outcome: OutcomeClass
  errorSummary: string
  repeatCount: number
  validationKey?: string
}

const ADVISOR_TOOL = 'consult_advisor'
const MUTATION_TOOL = /(apply[_-]?patch|edit|write|replace|delete|move|rename|create)/i
const VALIDATION_TOOL = /(bash|pwsh|shell|exec|terminal|command)/i
function hash(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 20) }
export function normalizeFailureText(text: string): string {
  return text.toLowerCase().replace(/\b0x[0-9a-f]+\b/g, '<hex>').replace(/\b[0-9a-f]{8,64}\b/g, '<id>').replace(/:\d+(?::\d+)?\b/g, ':#').replace(/\b\d{4}-\d{2}-\d{2}t[^\s]+/g, '<time>').replace(/\b\d{10,}\b/g, '<n>').replace(/\s+/g, ' ').trim().slice(0, 4000)
}
export function failureFingerprint(tool: string, text: string): string { return hash(`${tool.toLowerCase()}\n${normalizeFailureText(text)}`) }
function recordOf(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
export function findExitCode(value: unknown, depth = 0): number | undefined {
  if (depth > 4) return undefined
  const record = recordOf(value)
  if (!record) return undefined
  for (const key of ['exitCode', 'exit_code']) { const candidate = record[key]; if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate }
  for (const child of Object.values(record)) { const found = findExitCode(child, depth + 1); if (found !== undefined) return found }
  return undefined
}
function flattenArgumentStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || out.length > 30) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const child of value) flattenArgumentStrings(child, out, depth + 1)
  else { const record = recordOf(value); if (record) for (const child of Object.values(record)) flattenArgumentStrings(child, out, depth + 1) }
  return out
}
function argumentText(args: unknown): string { return flattenArgumentStrings(args).join(' ') }
const VALIDATION_FAMILY = /\b(?:pytest|jest|vitest|go\s+test|cargo\s+test|mvn\s+test|gradle\w*\s+test|(?:pnpm|npm|yarn)\s+(?:run\s+)?(?:typecheck|test|lint|build)|tsc)\b/
/** The same family, scanned for EVERY match so a mention can be rejected and the
 * scan continued to the invocation behind it. */
const VALIDATION_FAMILY_SCAN = new RegExp(VALIDATION_FAMILY.source, 'g')

/** A half-open span of the original command text. */
interface CommandSpan { readonly start: number; readonly end: number }

/**
 * A wrapper's operand grammar: how to find the command it runs WITHOUT mistaking
 * one of the wrapper's own option VALUES for that command.
 */
interface WrapperGrammar {
  /** Flags that consume the FOLLOWING token as a value, which is not a command. */
  readonly valueOptions: readonly string[]
  /** Flags whose operand is itself a command STRING to scan. */
  readonly commandOptions: readonly string[]
  /** Flags after which no command runs at all, such as `command -v`. */
  readonly queryOptions: readonly string[]
  /** Subcommands standing between the wrapper and the command it runs. */
  readonly subcommands: readonly string[]
  /** True when a bare operand names a script FILE the wrapper reads, not a check. */
  readonly scriptOperand: boolean
}

const wrapper = (overrides: Partial<WrapperGrammar> = {}): WrapperGrammar => ({
  valueOptions: [], commandOptions: [], queryOptions: [], subcommands: [], scriptOperand: false, ...overrides,
})

/**
 * Commands that run ANOTHER command given as an operand, enumerated rather than
 * guessed, because a missing entry loses a genuine invocation SILENTLY. Measured
 * gaps in an earlier revision, each recognized before the position rule existed:
 * `time npm test`, `sudo npm test`, `nice -n 5 npm test`, `pnpm exec vitest run`,
 * `yarn dlx vitest run`, `cross-env CI=1 npm test` and `command npm test`.
 */
const WRAPPERS: Record<string, WrapperGrammar> = {
  // Shells: the command is the -c/-Command string, never a bare script operand.
  bash: wrapper({ commandOptions: ['-c'], scriptOperand: true }),
  sh: wrapper({ commandOptions: ['-c'], scriptOperand: true }),
  zsh: wrapper({ commandOptions: ['-c'], scriptOperand: true }),
  pwsh: wrapper({ commandOptions: ['-c', '-command'], scriptOperand: true }),
  powershell: wrapper({ commandOptions: ['-c', '-command'], scriptOperand: true }),
  cmd: wrapper({ commandOptions: ['/c', '/k'], scriptOperand: true }),
  // Runners whose operand IS the check, or the binary that provides it.
  npx: wrapper({ valueOptions: ['-p', '--package'], commandOptions: ['-c', '--call'] }),
  env: wrapper({ valueOptions: ['-u', '--unset', '-c', '--chdir'], commandOptions: ['-s', '--split-string'] }),
  time: wrapper({ valueOptions: ['-f', '--format', '-o', '--output'] }),
  sudo: wrapper({
    valueOptions: ['-u', '--user', '-g', '--group', '-p', '--prompt', '-c', '--close-from', '-h', '--host', '-r', '--role', '-t', '--type', '-d', '--chdir'],
    // `sudo -v` refreshes the timestamp and runs nothing.
    queryOptions: ['-v', '--validate', '-l', '--list', '-e', '--edit', '-k', '--reset-timestamp'],
  }),
  nice: wrapper({ valueOptions: ['-n', '--adjustment'] }),
  'cross-env': wrapper(),
  // `command -v npm` REPORTS where npm is; it does not run it.
  command: wrapper({ queryOptions: ['-v', '-p'] }),
  // Package managers that can execute a check through a subcommand.
  pnpm: wrapper({ subcommands: ['exec', 'dlx'] }),
  yarn: wrapper({ subcommands: ['exec', 'dlx'] }),
  npm: wrapper({ subcommands: ['exec'] }),
}

/** Split a command at UNQUOTED separators, keeping every token's exact span. */
function shellSegments(command: string): CommandSpan[][] {
  const segments: CommandSpan[][] = []
  let tokens: CommandSpan[] = []
  let start = -1
  let quote = ''
  for (let index = 0; index < command.length; index++) {
    const character = command.charAt(index)
    if (quote !== '') {
      if (character === quote) quote = ''
      // Inside double quotes a backslash escapes only a quote or another
      // backslash. Escaping the next character unconditionally would make the
      // closing quote of a PowerShell path such as "C:\proj\" part of the
      // string, and every token after it would read as argument text.
      else if (character === '\\' && quote === '"' && (command.charAt(index + 1) === '"' || command.charAt(index + 1) === '\\')) index++
      continue
    }
    if (character === '"' || character === "'") {
      if (start < 0) start = index
      quote = character
      continue
    }
    // A backslash is NOT an escape outside quotes: this runs for PowerShell too,
    // where it is the path separator, and treating `C:\dir\ x` as an escaped
    // space silently merges two tokens.
    if (character === ' ' || character === '\t') {
      if (start >= 0) { tokens.push({ start, end: index }); start = -1 }
      continue
    }
    // UNQUOTED separators end a statement. Redirection operators deliberately do
    // NOT: their operand is a file name, so `echo ok > vitest` would otherwise
    // make the file `vitest` look like an invocation of a check.
    if (';|&\n\r'.includes(character)) {
      if (start >= 0) { tokens.push({ start, end: index }); start = -1 }
      if (tokens.length > 0) { segments.push(tokens); tokens = [] }
      continue
    }
    if (start < 0) start = index
  }
  if (start >= 0) tokens.push({ start, end: command.length })
  if (tokens.length > 0) segments.push(tokens)
  return segments
}

/**
 * Shells whose `-c` / `-Command` operand is ITSELF a command line. The operand is
 * quoted, so without this the genuine check inside `pwsh -Command "npm test"`
 * would be read as argument text and lost - the false-negative direction, which is
 * the more expensive one here.
 */
/** Nesting deeper than this is not worth resolving; treat it as not a check. */
const MAX_WRAPPER_DEPTH = 3

/** The spans of one segment that occupy an executable position. */
function executableSpans(segment: CommandSpan[], command: string, depth = 0): CommandSpan[] {
  const textAt = (span: CommandSpan): string => command.slice(span.start, span.end)
  let cursor = 0
  while (cursor < segment.length) {
    const span = segment[cursor]
    if (span === undefined) break
    const text = textAt(span)
    // `FOO=1 npm test` configures the run; the check is what remains.
    if (/^[A-Za-z_][\w-]*=/.test(text)) { cursor++; continue }
    // PowerShell `$env:NAME = "value"` is a binding, not an invocation.
    if (/^\$[\w:]+$/i.test(text)) {
      const next = segment[cursor + 1]
      cursor += next !== undefined && textAt(next) === '=' ? 3 : 1
      continue
    }
    break
  }
  const executable = segment[cursor]
  if (executable === undefined) return []
  const spans: CommandSpan[] = [executable]
  const base = (textAt(executable).replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '')
  const operands = segment.slice(cursor + 1)
  const grammar = WRAPPERS[base]
  return grammar === undefined ? spans : spans.concat(wrapperSpans(grammar, operands, command, depth))
}

/** Walk a wrapper's operands to the command it actually runs, if it runs one. */
function wrapperSpans(grammar: WrapperGrammar, operands: CommandSpan[], command: string, depth: number): CommandSpan[] {
  const textAt = (span: CommandSpan): string => command.slice(span.start, span.end)
  for (let index = 0; index < operands.length; index++) {
    const operand = operands[index]
    if (operand === undefined) return []
    const raw = textAt(operand)
    const name = (raw.split('=')[0] ?? '').toLowerCase()
    const inline = raw.includes('=')
    if (raw === '--') continue
    if (name.startsWith('-') || name.startsWith('/')) {
      // A flag that only REPORTS something runs no command at all.
      if (grammar.queryOptions.includes(name)) return []
      if (grammar.commandOptions.includes(name)) {
        if (inline) return []
        const inner = operands[index + 1]
        return inner === undefined ? [] : nestedSpans(inner, command, depth)
      }
      // An option that takes a VALUE must not leave that value looking like a check.
      index += grammar.valueOptions.includes(name) && !inline ? 1 : 0
      continue
    }
    if (grammar.subcommands.includes(name)) continue
    // `cross-env CI=1 npm test`: a bare assignment configures the run.
    if (/^[A-Za-z_][\w-]*=/.test(raw)) continue
    // A shell invoked with a bare operand reads a FILE, which is not a check.
    return grammar.scriptOperand ? [] : [operand]
  }
  return []
}

/**
 * The invocations inside the quoted command string of a shell wrapper, mapped back
 * into the ORIGINAL command's coordinates so the caller can slice its own text.
 */
function nestedSpans(operand: CommandSpan, command: string, depth: number): CommandSpan[] {
  if (depth >= MAX_WRAPPER_DEPTH) return []
  const raw = command.slice(operand.start, operand.end)
  const quote = raw.charAt(0)
  const quoted = quote === '"' || quote === "'"
  const closed = quoted && raw.length > 1 && raw.charAt(raw.length - 1) === quote ? 1 : 0
  const open = quoted ? 1 : 0
  const content = raw.slice(open, raw.length - closed)
  const offset = operand.start + open
  return invocationSpans(content, depth + 1).map(span => ({ start: span.start + offset, end: span.end + offset }))
}

/** Every span of a command in which a family match is an invocation. */
function invocationSpans(command: string, depth = 0): CommandSpan[] {
  return shellSegments(command).flatMap(segment => executableSpans(segment, command, depth))
}

/**
 * The index of the first family match that INVOKES a check rather than merely
 * appearing in argument text.
 *
 * The distinction is positional, not textual: `git commit -m "notes; npm test"`
 * puts the phrase inside a quoted argument of an unrelated executable, while
 * `echo "npm test"; npm test` both mentions it and really runs it - the mention
 * is rejected and the scan continues to the invocation behind the separator.
 */
function validationMatchIndex(command: string): number | undefined {
  const spans = invocationSpans(command)
  if (spans.length === 0) return undefined
  VALIDATION_FAMILY_SCAN.lastIndex = 0
  for (let match = VALIDATION_FAMILY_SCAN.exec(command); match !== null; match = VALIDATION_FAMILY_SCAN.exec(command)) {
    const index = match.index
    if (spans.some(span => index >= span.start && index < span.end)) return index
  }
  return undefined
}

/**
 * The validation statement a shell call performs: the segment that names the
 * check, with its reporting plumbing removed.
 *
 * Only the plugin's own identity uses this. `2>&1 | Select-Object -First 40`,
 * an appended `; "TSC_EXIT=$LASTEXITCODE"`, a trailing `Select-String` stage and
 * a leading `$env:VAR = ...` assignment only control how one and the same check
 * is observed. Hashing them made every retry a new validation identity, so an
 * obligation opened by a failing run could never be matched by the passing run
 * that verified the repair, and the item stayed open forever.
 *
 * The statement is located rather than assumed to come first: a compound
 * command such as `grep needle file; npm test` still validates. The match starts
 * at the family word, so `npm run test -- x` and `npx vitest run a.spec.ts`
 * remain distinct targets, and a command that only mentions a family inside a
 * longer word (`npm testx`) is not a validation at all.
 *
 * The match must also OCCUPY an executable position. A phrase quoted into the
 * argument of some other command - `git commit -m "notes; npm test"` - only
 * mentions a check, and giving it an identity opened an obligation for a run
 * that never happened. The test is positional rather than a denylist of
 * innocent executables, so a real invocation later in the same command is still
 * found.
 */
function validationStatement(command: string): string | undefined {
  const index = validationMatchIndex(command)
  if (index === undefined) return undefined
  const rest = command.slice(index)
  const boundary = rest.search(/[|;\r\n]|\d?>>?\s*&?\S|<\s*&?\S/)
  let statement = boundary >= 0 ? rest.slice(0, boundary) : rest
  // A recording prefix such as `$env:DSH_RUNTIME_PACKAGE_JSON = "...";` or
  // `FOO=1 npm test` configures the run; the check is what remains.
  let previous: string
  do {
    previous = statement
    statement = statement.replace(/^\s*(?:\$env:[\w:]+|\$[\w:]+|[a-z_][\w-]*=\S*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;|&]+)\s*;?\s*/i, '')
  } while (statement !== previous)
  return statement.trim() || undefined
}

function validationKey(name: string, args: unknown, scope?: string): string | undefined {
  if (!VALIDATION_TOOL.test(name)) return undefined
  const command = argumentText(args).toLowerCase()
  // An `echo "npm test"` or a `cat vitest.log` is rejected below by POSITION
  // rather than by an executable-name denylist: the denylist read the START of
  // the command, so `echo "npm test"; npm test` also lost the real check.
  const statement = validationStatement(command)
  if (!statement) return undefined
  let kind: string | undefined
  if (/\b(?:pytest|jest|vitest|go\s+test|cargo\s+test|mvn\s+test|gradle\w*\s+test)\b/.test(statement) || /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?test\b/.test(statement)) kind = 'test'
  else if (/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?lint\b/.test(statement)) kind = 'lint'
  else if (/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?build\b/.test(statement)) kind = 'build'
  else if (/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?typecheck\b/.test(statement) || /\btsc\b/.test(statement)) kind = 'typecheck'
  // The key identifies a validation target inside one execution scope; a pass in
  // another scope or task must never be mistaken for the same check.
  return kind ? hash(`validation:${kind}\n${scope ?? ''}\n${normalizeFailureText(statement)}`) : undefined
}
function isExpectedNegativeExit(name: string, args: unknown, exitCode: number | undefined): boolean {
  if (exitCode !== 1) return false
  const command = argumentText(args)
  // A compound shell command can exit on a later validation failure.
  if (/[;&|\n]/.test(command)) return false
  if (/\b(?:rg|grep)\b/i.test(name) || /(?:^|[\s;|&])(?:rg|grep)\b/i.test(command)) return true
  if (/\bgit\b[\s\S]*\bdiff\b[\s\S]*--quiet\b/i.test(command)) return true
  return /\btest\s+-[a-z]\b/i.test(command) || /\[\[?\s+!?(?:-[a-z]|[^\]]+\s*(?:=|!=|-eq|-ne|-gt|-lt))/i.test(command)
}
function hasStructuredFlag(value: unknown, flags: readonly string[], depth = 0): boolean {
  if (depth > 4) return false
  const record = recordOf(value)
  if (!record) return false
  for (const [key, child] of Object.entries(record)) {
    if (flags.includes(key.toLowerCase()) && child === true) return true
    if (hasStructuredFlag(child, flags, depth + 1)) return true
  }
  return false
}
function structuredCodes(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out
  const record = recordOf(value)
  if (!record) return out
  for (const [key, child] of Object.entries(record)) {
    if ((key === 'code' || key === 'errorCode') && typeof child === 'string') out.push(child)
    structuredCodes(child, out, depth + 1)
  }
  return out
}
function structuredOutcome(observed: ObservedToolResult): OutcomeClass | undefined {
  const codes = [observed.errorCode, ...structuredCodes(observed.value)].filter((code): code is string => typeof code === 'string').map((code) => code.toUpperCase())
  if (hasStructuredFlag(observed.value, ['denied', 'permissiondenied', 'approvaldenied']) || codes.some((code) => /(?:PERMISSION|APPROVAL|POLICY)[_-]?(?:DENIED|REQUIRED)?|DENIED$|^(?:EACCES|EPERM)$/.test(code))) return 'permission-denial'
  if (observed.isError && /^(?:Error:\s*)?(?:EACCES\b|EPERM\b|permission denied\b|access (?:is )?denied\b|approval (?:denied|required)\b)/i.test(observed.errorMessage ?? observed.contentText)) return 'permission-denial'
  if (hasStructuredFlag(observed.value, ['aborted', 'cancelled', 'canceled']) || codes.some((code) => /ABORT|CANCEL/.test(code))) return 'cancelled'
  if (hasStructuredFlag(observed.value, ['timedout', 'timeout']) || codes.some((code) => /TIMEOUT|TIMED_OUT|ETIMEDOUT|DEADLINE_EXCEEDED/.test(code))) return 'timeout'
  if (hasStructuredFlag(observed.value, ['infrastructure', 'networkerror', 'unavailable']) || codes.some((code) => /ECONN|ENOTFOUND|EAI_AGAIN|NETWORK|INTERNAL|INFRASTRUCTURE|SERVICE_UNAVAILABLE|PROVIDER|UNAVAILABLE|RATE_LIMIT/.test(code))) return 'tool-infrastructure-error'
  return undefined
}
export function classifyToolOutcome(observed: ObservedToolResult): ToolOutcome {
  const exitCode = findExitCode(observed.value), validation = validationKey(observed.name, observed.arguments, observed.scope)
  const exclusion = structuredOutcome(observed)
  if (exclusion) return { class: exclusion, exitCode, validationKey: validation }
  if (!observed.isError && isExpectedNegativeExit(observed.name, observed.arguments, exitCode)) return { class: 'expected-negative', exitCode, validationKey: validation }
  if (observed.isError || (exitCode !== undefined && exitCode !== 0)) return { class: validation ? 'validation-failure' : 'unknown-failure', exitCode, validationKey: validation }
  return { class: 'success', exitCode, validationKey: validation }
}
function mutationPaths(args: unknown): string[] {
  const record = recordOf(args), candidates: string[] = []
  if (record) for (const key of ['file_path', 'filePath', 'path', 'filename', 'target', 'destination']) { const value = record[key]; if (typeof value === 'string' && value.trim()) candidates.push(value.trim()) }
  return candidates
}
export function mutationKey(name: string, args: unknown): string | undefined {
  if (!MUTATION_TOOL.test(name)) return undefined
  const candidates = mutationPaths(args)
  const body = candidates.length ? candidates.sort().join('|') : JSON.stringify(args).slice(0, 1500)
  return hash(body)
}
function createState(): SessionState { return { score: 0, activeSignals: [], recentSignals: [], evidence: [], repeatedFailureCount: 0, mutationCounts: new Map(), mutationTargets: new Map(), mutationPenaltyIssued: new Set(), consultCountByProblem: new Map(), autoConsultCountByTurn: new Map() } }

export class EscalationTracker {
  private readonly states = new Map<string, SessionState>()
  private state(sessionId: string): SessionState { let current = this.states.get(sessionId); if (!current) { current = createState(); this.states.set(sessionId, current) } return current }
  evidence(sessionId: string): readonly TrackerEvidence[] { return [...this.state(sessionId).evidence] }
  private addSignal(state: SessionState, signal: EscalationSignal): void { state.score += signal.weight; state.activeSignals.push(signal); state.recentSignals.push(signal); if (state.recentSignals.length > 12) state.recentSignals.splice(0, state.recentSignals.length - 12) }
  observe(sessionId: string, observed: ObservedToolResult, config: Config): void {
    if (observed.name === ADVISOR_TOOL) return
    const state = this.state(sessionId), outcome = classifyToolOutcome(observed)
    const failureText = observed.errorMessage || observed.contentText || JSON.stringify(observed.value ?? '')
    const fingerprint = failureFingerprint(observed.name, failureText)
    state.evidence.push({ ...(observed.callId ? { callId: observed.callId } : {}), tool: observed.name, fingerprint, argumentsSummary: JSON.stringify(observed.arguments ?? {}).slice(0, 2400), outcome: outcome.class, errorSummary: failureText.slice(0, 2400), repeatCount: state.lastFailureFingerprint === fingerprint ? state.repeatedFailureCount + 1 : 1, ...(outcome.validationKey ? { validationKey: outcome.validationKey } : {}) })
    if (state.evidence.length > 24) state.evidence.shift()
    if (outcome.class === 'permission-denial' || outcome.class === 'cancelled' || outcome.class === 'timeout' || outcome.class === 'tool-infrastructure-error' || outcome.class === 'expected-negative') return
    if (outcome.class === 'validation-failure' || outcome.class === 'unknown-failure') {
      const baseWeight = observed.isError ? config.toolErrorWeight : config.nonZeroExitWeight
      this.addSignal(state, { kind: observed.isError ? 'tool-error' : 'nonzero-exit', weight: baseWeight, fingerprint, detail: `${observed.name}: ${normalizeFailureText(failureText).slice(0, 320)}`, validationKey: outcome.validationKey })
      if (state.lastFailureFingerprint === fingerprint) {
        state.repeatedFailureCount += 1
        if (state.repeatedFailureCount >= 2) this.addSignal(state, { kind: 'repeated-failure', weight: config.repeatedFailureWeight, fingerprint, detail: `same failure repeated ${state.repeatedFailureCount} times`, validationKey: outcome.validationKey })
      } else { state.lastFailureFingerprint = fingerprint; state.lastFailureValidationKey = outcome.validationKey; state.repeatedFailureCount = 1 }
      return
    }
    if (outcome.class === 'success' && outcome.validationKey && outcome.exitCode === 0) {
      const tokens = argumentText(observed.arguments).replace(/\\/g, '/').split(/[\s"']+/)
      const validated = new Set<string>()
      for (const [key, paths] of state.mutationTargets) if (paths.length && paths.every(path => {
        const normalized = path.replace(/\\/g, '/'), stem = normalized.split('/').at(-1)!.replace(/\.[^.]+$/, '')
        return tokens.some(token => token === normalized || token === stem)
      })) validated.add(key)
      this.noteProgress(sessionId, outcome.validationKey, validated)
      return
    }
    const key = mutationKey(observed.name, observed.arguments)
    if (!key) return
    const count = (state.mutationCounts.get(key) ?? 0) + 1
    state.mutationCounts.set(key, count)
    state.mutationTargets.set(key, mutationPaths(observed.arguments))
    if (count >= config.repeatedMutationCount && !state.mutationPenaltyIssued.has(key)) { state.mutationPenaltyIssued.add(key); this.addSignal(state, { kind: 'repeated-mutation', weight: config.repeatedMutationWeight, fingerprint: key, detail: `similar mutation target changed ${count} times without a successful validation command` }) }
  }
  noteProgress(sessionId: string, validationKey?: string, validatedMutations = new Set<string>()): void {
    const state = this.state(sessionId)
    if (!validationKey) {
      state.score = 0; state.activeSignals = []; state.recentSignals = []; state.lastFailureFingerprint = undefined; state.lastFailureValidationKey = undefined; state.repeatedFailureCount = 0
      state.mutationCounts.clear(); state.mutationPenaltyIssued.clear(); state.mutationTargets.clear()
    } else {
      const retained = (signal: EscalationSignal): boolean => signal.kind === 'repeated-mutation' ? !validatedMutations.has(signal.fingerprint) : signal.validationKey !== validationKey
      state.activeSignals = state.activeSignals.filter(retained); state.recentSignals = state.recentSignals.filter(retained)
      state.score = state.activeSignals.reduce((score, signal) => score + signal.weight, 0)
      if (state.lastFailureValidationKey === validationKey) { state.lastFailureFingerprint = undefined; state.lastFailureValidationKey = undefined; state.repeatedFailureCount = 0 }
      for (const key of validatedMutations) { state.mutationCounts.delete(key); state.mutationPenaltyIssued.delete(key); state.mutationTargets.delete(key) }
    }
  }
  decision(sessionId: string, turn: number, config: Config): EscalationDecision {
    const state = this.state(sessionId)
    const problemFingerprint = state.lastFailureFingerprint ?? state.recentSignals.at(-1)?.fingerprint ?? hash(`${sessionId}:${turn}:no-signal`)
    if (state.score < config.scoreThreshold) return { shouldConsult: false, score: state.score, problemFingerprint, signals: [...state.recentSignals], evidence: [...state.evidence], reason: 'score below threshold' }
    const turnCount = state.autoConsultCountByTurn.get(turn) ?? 0
    if (turnCount >= config.maxAutoConsultsPerTurn) return { shouldConsult: false, score: state.score, problemFingerprint, signals: [...state.recentSignals], evidence: [...state.evidence], reason: 'turn consultation limit reached' }
    const problemCount = state.consultCountByProblem.get(problemFingerprint) ?? 0
    if (problemCount >= config.maxAutoConsultsPerProblem) return { shouldConsult: false, score: state.score, problemFingerprint, signals: [...state.recentSignals], evidence: [...state.evidence], reason: 'problem consultation limit reached' }
    if (state.lastAutoConsultTurn !== undefined && turn - state.lastAutoConsultTurn <= config.cooldownTurns) return { shouldConsult: false, score: state.score, problemFingerprint, signals: [...state.recentSignals], evidence: [...state.evidence], reason: 'cooldown active' }
    return { shouldConsult: true, score: state.score, problemFingerprint, signals: [...state.recentSignals], evidence: [...state.evidence] }
  }
  markAutoConsult(sessionId: string, turn: number, problemFingerprint: string): void { const state = this.state(sessionId); state.autoConsultCountByTurn.set(turn, (state.autoConsultCountByTurn.get(turn) ?? 0) + 1); state.consultCountByProblem.set(problemFingerprint, (state.consultCountByProblem.get(problemFingerprint) ?? 0) + 1); state.lastAutoConsultTurn = turn }
  markContinuousReview(sessionId: string, turn: number): boolean { const state = this.state(sessionId); if (state.lastReviewedTurn === turn) return false; state.lastReviewedTurn = turn; return true }
  clear(sessionId: string): void { this.states.delete(sessionId) }
}
