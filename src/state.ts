import { createHash } from 'node:crypto'
import type { Config } from './config.js'

export interface ObservedToolResult {
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
}
interface SessionState {
  score: number
  recentSignals: EscalationSignal[]
  lastFailureFingerprint?: string
  repeatedFailureCount: number
  mutationCounts: Map<string, number>
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
  reason?: string
}

const MUTATION_TOOL = /(apply[_-]?patch|edit|write|replace|delete|move|rename|create)/i
const VALIDATION_TOOL = /(bash|pwsh|shell|exec|terminal|command)/i
const VALIDATION_COMMAND = /(^|\s)(test|pytest|jest|vitest|go\s+test|cargo\s+test|mvn\s+test|gradle\w*\s+test|pnpm\s+(?:run\s+)?(?:test|lint|build|typecheck)|npm\s+(?:run\s+)?(?:test|lint|build|typecheck)|yarn\s+(?:test|lint|build|typecheck)|tsc\b)/i
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
  for (const key of ['exitCode', 'exit_code', 'code']) { const candidate = record[key]; if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate }
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
function isValidationCommand(name: string, args: unknown): boolean { return VALIDATION_TOOL.test(name) && VALIDATION_COMMAND.test(flattenArgumentStrings(args).join(' ')) }
function mutationKey(name: string, args: unknown): string | undefined {
  if (!MUTATION_TOOL.test(name)) return undefined
  const record = recordOf(args), candidates: string[] = []
  if (record) for (const key of ['file_path', 'filePath', 'path', 'filename', 'target', 'destination']) { const value = record[key]; if (typeof value === 'string' && value.trim()) candidates.push(value.trim()) }
  const body = candidates.length ? candidates.sort().join('|') : JSON.stringify(args).slice(0, 1500)
  return hash(body)
}
function createState(): SessionState { return { score: 0, recentSignals: [], repeatedFailureCount: 0, mutationCounts: new Map(), mutationPenaltyIssued: new Set(), consultCountByProblem: new Map(), autoConsultCountByTurn: new Map() } }

export class EscalationTracker {
  private readonly states = new Map<string, SessionState>()
  private state(sessionId: string): SessionState { let current = this.states.get(sessionId); if (!current) { current = createState(); this.states.set(sessionId, current) } return current }
  private addSignal(state: SessionState, signal: EscalationSignal): void { state.score += signal.weight; state.recentSignals.push(signal); if (state.recentSignals.length > 12) state.recentSignals.splice(0, state.recentSignals.length - 12) }
  observe(sessionId: string, observed: ObservedToolResult, config: Config): void {
    if (observed.name === 'ask_advisor') return
    const state = this.state(sessionId), exitCode = findExitCode(observed.value)
    if (observed.isError && observed.errorCode && /(ABORT|CANCEL|DENIED|APPROVAL|PERMISSION)/i.test(observed.errorCode)) return
    const failureText = observed.errorMessage || observed.contentText || JSON.stringify(observed.value ?? '')
    if (observed.isError || (exitCode !== undefined && exitCode !== 0)) {
      const fingerprint = failureFingerprint(observed.name, failureText), baseWeight = observed.isError ? config.toolErrorWeight : config.nonZeroExitWeight
      this.addSignal(state, { kind: observed.isError ? 'tool-error' : 'nonzero-exit', weight: baseWeight, fingerprint, detail: `${observed.name}: ${normalizeFailureText(failureText).slice(0, 320)}` })
      if (state.lastFailureFingerprint === fingerprint) {
        state.repeatedFailureCount += 1
        if (state.repeatedFailureCount >= 2) this.addSignal(state, { kind: 'repeated-failure', weight: config.repeatedFailureWeight, fingerprint, detail: `same failure repeated ${state.repeatedFailureCount} times` })
      } else { state.lastFailureFingerprint = fingerprint; state.repeatedFailureCount = 1 }
      return
    }
    if (exitCode === 0 && isValidationCommand(observed.name, observed.arguments)) { this.noteProgress(sessionId); return }
    const key = mutationKey(observed.name, observed.arguments)
    if (!key) return
    const count = (state.mutationCounts.get(key) ?? 0) + 1
    state.mutationCounts.set(key, count)
    if (count >= config.repeatedMutationCount && !state.mutationPenaltyIssued.has(key)) { state.mutationPenaltyIssued.add(key); this.addSignal(state, { kind: 'repeated-mutation', weight: config.repeatedMutationWeight, fingerprint: key, detail: `similar mutation target changed ${count} times without a successful validation command` }) }
  }
  noteProgress(sessionId: string): void { const state = this.state(sessionId); state.score = 0; state.recentSignals = []; state.lastFailureFingerprint = undefined; state.repeatedFailureCount = 0; state.mutationCounts.clear(); state.mutationPenaltyIssued.clear() }
  decision(sessionId: string, turn: number, config: Config): EscalationDecision {
    const state = this.state(sessionId)
    const problemFingerprint = state.lastFailureFingerprint ?? state.recentSignals.at(-1)?.fingerprint ?? hash(`${sessionId}:${turn}:no-signal`)
    if (state.score < config.scoreThreshold) return { shouldConsult: false, score: state.score, problemFingerprint, signals: [...state.recentSignals], reason: 'score below threshold' }
    const turnCount = state.autoConsultCountByTurn.get(turn) ?? 0
    if (turnCount >= config.maxAutoConsultsPerTurn) return { shouldConsult: false, score: state.score, problemFingerprint, signals: [...state.recentSignals], reason: 'turn consultation limit reached' }
    const problemCount = state.consultCountByProblem.get(problemFingerprint) ?? 0
    if (problemCount >= config.maxAutoConsultsPerProblem) return { shouldConsult: false, score: state.score, problemFingerprint, signals: [...state.recentSignals], reason: 'problem consultation limit reached' }
    if (state.lastAutoConsultTurn !== undefined && turn - state.lastAutoConsultTurn <= config.cooldownTurns) return { shouldConsult: false, score: state.score, problemFingerprint, signals: [...state.recentSignals], reason: 'cooldown active' }
    return { shouldConsult: true, score: state.score, problemFingerprint, signals: [...state.recentSignals] }
  }
  markAutoConsult(sessionId: string, turn: number, problemFingerprint: string): void { const state = this.state(sessionId); state.autoConsultCountByTurn.set(turn, (state.autoConsultCountByTurn.get(turn) ?? 0) + 1); state.consultCountByProblem.set(problemFingerprint, (state.consultCountByProblem.get(problemFingerprint) ?? 0) + 1); state.lastAutoConsultTurn = turn }
  markContinuousReview(sessionId: string, turn: number): boolean { const state = this.state(sessionId); if (state.lastReviewedTurn === turn) return false; state.lastReviewedTurn = turn; return true }
  clear(sessionId: string): void { this.states.delete(sessionId) }
}
