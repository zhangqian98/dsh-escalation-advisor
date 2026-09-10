import { createHash } from 'node:crypto'
import type { Config } from './config.js'

export interface ObservedToolResult {
  callId?: string
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
function validationKey(name: string, args: unknown): string | undefined {
  if (!VALIDATION_TOOL.test(name)) return undefined
  const command = argumentText(args).toLowerCase()
  if (/^\s*(?:echo|printf|write-output|cat)\b/.test(command)) return undefined
  let kind: string | undefined
  if (/\b(?:pytest|jest|vitest|go\s+test|cargo\s+test|mvn\s+test|gradle\w*\s+test)\b/.test(command) || /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?test\b/.test(command)) kind = 'test'
  else if (/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?lint\b/.test(command)) kind = 'lint'
  else if (/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?build\b/.test(command)) kind = 'build'
  else if (/\b(?:pnpm|npm|yarn)\s+(?:run\s+)?typecheck\b/.test(command) || /\btsc\b/.test(command)) kind = 'typecheck'
  return kind ? hash(`validation:${kind}\n${normalizeFailureText(command)}`) : undefined
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
  const exitCode = findExitCode(observed.value), validation = validationKey(observed.name, observed.arguments)
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
function mutationKey(name: string, args: unknown): string | undefined {
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
    state.evidence.push({ ...(observed.callId ? { callId: observed.callId } : {}), tool: observed.name, argumentsSummary: JSON.stringify(observed.arguments ?? {}).slice(0, 2400), outcome: outcome.class, errorSummary: failureText.slice(0, 2400), repeatCount: state.lastFailureFingerprint === fingerprint ? state.repeatedFailureCount + 1 : 1, ...(outcome.validationKey ? { validationKey: outcome.validationKey } : {}) })
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
