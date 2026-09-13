import type { Agent } from '@deepseek-ai/dsh-agent'
import { redactSecrets, truncateUtf8 } from './redact.js'
import type { EscalationDecision, TrackerEvidence } from './state.js'

export interface BuildCasePacketInput {
  requester: Agent
  root: Agent
  mode: 'manual' | 'escalation' | 'continuous' | 'completion'
  question: string
  currentHypothesis?: string
  decisionNeeded?: string
  evidence?: string[]
  failedAttempts?: string[]
  trigger?: EscalationDecision & { turn: number; step?: number }
  observedEvidence?: readonly TrackerEvidence[]
  allowedTools: string[]
  unavailableTools: string[]
  mutationPolicy: 'propose-only' | 'may-edit'
  sinceSeq?: number
  taskStartSeq?: number
  consultationId: string
}

export interface CasePacketResult {
  prompt: string
  lastSeq: number
  meaningful: boolean
  /** Fingerprints this packet actually includes (trigger + retained evidence). Deliveries must only mark these covered. */
  coveredFingerprints: string[]
  /** Call ids retained in the packet's canonical activity. */
  coveredCallIds: string[]
}

interface EventRecord {
  type?: unknown
  seq?: unknown
  data?: unknown
}

interface ActivityRecord {
  call_id: string
  tool: string
  arguments_summary?: string
  call_seq: number
  outcome: string
  result_seq?: number
  result_summary?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function eventsOf(agent: Agent): readonly EventRecord[] {
  return agent.session.snapshotEvents() as readonly EventRecord[]
}

function eventSeq(event: EventRecord): number {
  return typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : -1
}

function messageOf(event: EventRecord): Record<string, unknown> | undefined {
  const data = record(event.data)
  if (event.type === 'user/message') return data
  return record(data?.message)
}

function blockTexts(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return []
  const output: string[] = []
  for (const block of blocks) {
    const value = record(block)
    if (value?.type === 'text' && typeof value.text === 'string' && value.text.trim()) {
      output.push(redactSecrets(value.text.trim()))
    }
  }
  return output
}

function messageText(event: EventRecord): string {
  return blockTexts(messageOf(event)?.content).join('\n')
}

function toolResult(event: EventRecord): { callId?: string; text: string; failed: boolean } {
  const data = record(event.data)
  const message = record(data?.message)
  const source = record(message?.source)
  const outer = Array.isArray(message?.content) ? record(message.content[0]) : undefined
  const callId = typeof source?.callId === 'string'
    ? source.callId
    : typeof outer?.toolCallId === 'string' ? outer.toolCallId : undefined
  return {
    ...(callId === undefined ? {} : { callId }),
    text: blockTexts(outer?.content).join('\n'),
    failed: data?.error !== undefined || outer?.isError === true,
  }
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return value }
}

function boundedText(value: string, bytes = 4000): string {
  return truncateUtf8(redactSecrets(value), bytes).trim()
}

function summary(value: unknown, bytes = 2400): string {
  let serialized: string
  try { serialized = typeof value === 'string' ? value : JSON.stringify(value) }
  catch { serialized = String(value) }
  return boundedText(serialized, bytes)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => boundedText(value, 800)).filter(Boolean))]
}

function sessionId(agent: Agent): string {
  return String(agent.session.id ?? agent.id)
}

function isDirectUserMessage(event: EventRecord): boolean {
  return event.type === 'user/message' && record(messageOf(event)?.source)?.kind === 'user'
}

function latestGoal(events: readonly EventRecord[]): Record<string, unknown> | undefined {
  let goal: Record<string, unknown> | undefined
  for (const event of events) {
    if (event.type !== 'goal/change') continue
    const data = record(event.data)
    if (data?.operation === 'clear') goal = undefined
    else {
      const candidate = record(data?.goal)
      if (candidate) goal = candidate
    }
  }
  return goal
}

function rootTask(events: readonly EventRecord[]): { root_objective: string; success_criteria: string[] } {
  const goal = latestGoal(events)
  const goalObjective = typeof goal?.objective === 'string' ? boundedText(goal.objective) : ''
  const firstUser = events.findLast(isDirectUserMessage)
  const rootObjective = goalObjective || (firstUser ? boundedText(messageText(firstUser)) : '')
  const criteriaValue = goal?.successCriteria ?? goal?.success_criteria
  const criteria = Array.isArray(criteriaValue)
    ? unique(criteriaValue.filter((item): item is string => typeof item === 'string')).slice(0, MAX_SUCCESS_CRITERIA)
    : []
  return { root_objective: rootObjective, success_criteria: criteria }
}

function requesterAssignment(requester: Agent, root: Agent, events: readonly EventRecord[], taskStartSeq: number): string | undefined {
  if (sessionId(requester) === sessionId(root)) return undefined
  const inherited = typeof requester.session.inheritedEventCount === 'number'
    ? requester.session.inheritedEventCount
    : 0
  const ownPrompt = events.find(event => eventSeq(event) >= Math.max(inherited, taskStartSeq) && isDirectUserMessage(event))
  const text = ownPrompt ? boundedText(messageText(ownPrompt)) : ''
  return text || undefined
}

const PATH_KEYS = new Set([
  'path', 'file', 'filename', 'file_path', 'filePath', 'target', 'destination',
  'old_path', 'new_path', 'oldPath', 'newPath',
])
const MUTATION_TOOL = /(apply[_-]?patch|edit|write|replace|delete|remove|move|rename|create|mkdir)/i
const VALIDATION_TEXT = /\b(test|vitest|jest|pytest|typecheck|tsc|lint|build|check|cargo test|go test)\b/i

function collectPaths(value: unknown, output: string[] = [], depth = 0, key?: string): string[] {
  if (depth > 5 || output.length >= 40) return output
  if (typeof value === 'string') {
    if (key && PATH_KEYS.has(key) && value.trim()) output.push(value.trim())
    for (const match of value.matchAll(/^\*{3} (?:Add|Update|Delete) File:\s*(.+)$/gm)) output.push(match[1]!.trim())
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, output, depth + 1, key)
    return output
  }
  const object = record(value)
  if (object) for (const [childKey, child] of Object.entries(object)) collectPaths(child, output, depth + 1, childKey)
  return output
}

function validationLabel(name: string, args: unknown): string | undefined {
  const candidate = name + ' ' + summary(args, 1200)
  return VALIDATION_TEXT.test(candidate) ? boundedText(candidate, 1200) : undefined
}

export function materialAssistantConclusion(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  if (value.length >= 80) return true
  return /\b(root cause|conclusion|fixed|implemented|changed|validated|passes?|fails?|blocked|recommend|should|must|because|therefore)\b/i.test(value)
}

/** Whether any assistant message newer than `afterSeq` states a material conclusion.
 * Shapes are defensive: session event payloads vary across runtime versions. */
export function hasNewMaterialConclusion(events: readonly unknown[], afterSeq: number): boolean {
  const tail = events.slice(-24)
  for (const event of tail) {
    const recordEvent = record(event)
    const seq = recordEvent?.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= afterSeq) continue
    if (recordEvent?.type !== 'assistant/message') continue
    const data = record(recordEvent?.data)
    const message = record(data?.message) ?? data
    const content = message?.content
    if (!Array.isArray(content)) continue
    let text = ''
    try { text = textContent(content as readonly unknown[]) } catch { continue }
    if (materialAssistantConclusion(text)) return true
  }
  return false
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(redactValue)
  const object = record(value)
  if (!object) return value
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, redactValue(child)]))
}

// A packet only spans the current task delta, but escalation has no review
// cursor, so that delta keeps growing for as long as the task does. These caps
// keep the evidence proportional to what still needs a decision. A recorded
// packet from one long task carried 204 validation rows (182 KB), of which 203
// had succeeded and none matched the trigger, while tool_activity already
// summarizes the most recent calls with their outcomes.
export const MAX_CASE_PACKET_BYTES = 48 * 1024
export const MAX_REQUESTER_EVIDENCE = 8
export const MAX_REQUESTER_FAILED_ATTEMPTS = 8
export const MAX_SUCCESS_CRITERIA = 12
export const MAX_RECENT_TAIL = 12
const MAX_VALIDATION_ENTRIES = 10
const MAX_UNRELATED_VALIDATION_FAILURES = 3
const VALIDATION_SUCCESS_CONTEXT = 1
const MAX_FAILURES = 4
const BASE_ACTIVITY_ENTRIES = 16
const MAX_ACTIVITY_ENTRIES = 20
const ACTIVITY_SUMMARY_BYTES = 1200
const WRAPPER_FAILURE_SUMMARY_BYTES = 400

function newest(indices: readonly number[], limit: number): number[] {
  return limit <= 0 ? [] : indices.slice(-limit)
}

/**
 * Keeps every failed or trigger-related check plus the most recent successful
 * ones, in the original chronological order. The same rule applies to short and
 * long deltas, so a packet never depends on how far the task has progressed.
 */
function boundedValidation<T extends { outcome: string; relevant_to_problem: boolean }>(entries: readonly T[]): T[] {
  const related: number[] = []
  const failed: number[] = []
  const successful: number[] = []
  entries.forEach((entry, index) => {
    if (entry.relevant_to_problem) related.push(index)
    else if (entry.outcome === 'succeeded') successful.push(index)
    else failed.push(index)
  })
  // A trigger-related check is the reason the consultation exists, so the cap
  // never evicts one. The remaining budget goes to the newest failures and then
  // to a short tail of successful checks.
  const keptRelated = newest(related, MAX_VALIDATION_ENTRIES)
  const keptFailed = newest(failed, Math.min(MAX_UNRELATED_VALIDATION_FAILURES, MAX_VALIDATION_ENTRIES - keptRelated.length))
  const room = Math.max(0, MAX_VALIDATION_ENTRIES - keptRelated.length - keptFailed.length)
  const keptSuccessful = newest(successful, Math.min(VALIDATION_SUCCESS_CONTEXT, room))
  return [...keptRelated, ...keptFailed, ...keptSuccessful].sort((left, right) => left - right).map(index => entries[index]!)
}

/** Pinned entries plus the newest of the rest, in the original chronological order. */
function boundedEvidence<T>(entries: readonly T[], pin: (entry: T) => boolean, limit: number): T[] {
  const pinned: number[] = []
  const rest: number[] = []
  entries.forEach((entry, index) => (pin(entry) ? pinned : rest).push(index))
  const keptPinned = newest(pinned, limit)
  const keptRest = newest(rest, limit - keptPinned.length)
  return [...keptPinned, ...keptRest].sort((left, right) => left - right).map(index => entries[index]!)
}

/**
 * Degrade an oversized packet STRUCTURALLY, never by cutting serialized JSON:
 * a truncated string is unparseable, so instead whole low-priority sections are
 * dropped first (recent tail, tool activity, prior advice), then bounded lists
 * and long text shrink, and every removal is recorded in `truncation` so the
 * Advisor can see what the budget cost. The emitted packet always parses; the
 * worst case is a minimal but well-formed packet.
 */
export function fitCasePacket(packet: Record<string, unknown>): Record<string, unknown> {
  const bytes = () => Buffer.byteLength(JSON.stringify(packet))
  if (bytes() <= MAX_CASE_PACKET_BYTES) return packet
  const omitted: Record<string, number> = {}
  const drop = (owner: unknown, key: string): void => {
    const holder = record(owner), list = holder?.[key]
    if (!Array.isArray(list) || list.length === 0) return
    omitted[key] = (omitted[key] ?? 0) + list.length
    holder![key] = []
  }
  const keep = (owner: unknown, key: string, count: number): void => {
    const holder = record(owner), list = holder?.[key]
    if (!Array.isArray(list) || list.length <= count) return
    omitted[key] = (omitted[key] ?? 0) + list.length - count
    holder![key] = list.slice(0, count)
  }
  const shrink = (owner: unknown, key: string, max: number): void => {
    const holder = record(owner), value = holder?.[key]
    if (typeof value === 'string' && Buffer.byteLength(value) > max) holder![key] = truncateUtf8(value, max)
  }
  const steps: (() => void)[] = [
    () => drop(packet, 'recent_tail'),
    () => drop(packet, 'tool_activity'),
    () => drop(packet, 'prior_advice'),
    () => keep(packet.workspace, 'observed_changed_paths', 8),
    () => {
      // Keep the build-time omission counters truthful: they count input to output.
      const supplied = record(packet.requester_supplied)
      const truncation = { ...(record(packet.truncation) ?? {}) } as Record<string, number>
      for (const [key, counter] of [['evidence', 'requester_evidence_omitted'], ['failed_attempts', 'failed_attempts_omitted']] as const) {
        const list = supplied?.[key]
        if (Array.isArray(list) && list.length > 4) truncation[counter] = (truncation[counter] ?? 0) + list.length - 4
      }
      keep(supplied, 'evidence', 4)
      keep(supplied, 'failed_attempts', 4)
      packet.truncation = truncation
    },
    () => { keep(packet, 'attempts', 4); keep(packet, 'failures', 2); keep(packet, 'validation', 6) },
    () => {
      shrink(packet.question, 'exact_question', 1200)
      shrink(packet.question, 'current_hypothesis', 800)
      shrink(packet.question, 'decision_needed', 400)
      shrink(packet.task, 'root_objective', 800)
      keep(packet.task, 'success_criteria', 4)
      shrink(packet.task, 'requester_assignment', 400)
      shrink(packet.requester, 'cwd', 200)
      keep(packet.capabilities, 'allowed_tools', 10)
      keep(packet.capabilities, 'unavailable_tools', 10)
      const signals = record(packet.trigger)?.signals
      if (Array.isArray(signals)) for (const signal of signals) shrink(signal, 'detail', 200)
    },
  ]
  for (const step of steps) {
    if (bytes() <= MAX_CASE_PACKET_BYTES) break
    step()
  }
  if (Object.keys(omitted).length > 0) {
    packet.truncation = { ...(record(packet.truncation) ?? {}), packet_budget_bytes: MAX_CASE_PACKET_BYTES, packet_omitted: omitted }
  }
  if (bytes() <= MAX_CASE_PACKET_BYTES) return packet
  // Absolute floor: these fixed sections alone stay well under the cap, so the
  // worst-case output is still a complete, parseable packet.
  return {
    schema_version: 1,
    consultation: packet.consultation,
    requester: packet.requester,
    question: packet.question,
    truncation: { packet_budget_bytes: MAX_CASE_PACKET_BYTES, packet_omitted: omitted, degraded_to: 'minimal' },
  }
}

export function buildCasePacket(input: BuildCasePacketInput): CasePacketResult {
  const requesterEvents = eventsOf(input.requester)
  const rootEvents = sessionId(input.requester) === sessionId(input.root) ? requesterEvents : eventsOf(input.root)
  const lastSeq = requesterEvents.reduce((last, event) => Math.max(last, eventSeq(event)), -1)
  const latestUserSeq = (events: readonly EventRecord[]) => eventSeq(events.findLast(isDirectUserMessage) ?? {})
  const taskStartSeq = Math.max(input.taskStartSeq ?? 0, latestUserSeq(requesterEvents), input.requester.session.inheritedEventCount ?? 0)
  const delta = requesterEvents.filter(event => eventSeq(event) >= taskStartSeq && eventSeq(event) > (input.sinceSeq ?? -1))
  const callById = new Map<string, { event: EventRecord; name: string; args: unknown }>()
  for (const event of requesterEvents) {
    if (eventSeq(event) < taskStartSeq) continue
    const data = record(event.data)
    if (event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch' || event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
      const parent = typeof data?.parentCallId === 'string' ? callById.get(data.parentCallId) : undefined
      if (!parent || eventSeq(parent.event) >= eventSeq(event) || typeof data?.subCallId !== 'string' || typeof data.name !== 'string' || data.name === 'consult_advisor') continue
      // Native PTC records identify the actual tool and arguments even when the
      // outer run_code description contains no mutation or validation keywords.
      if (!callById.has(data.subCallId)) callById.set(data.subCallId, { event, name: data.name, args: parseArguments(data.arguments) })
      continue
    }
    if (event.type !== 'tool/call') continue
    if (typeof data?.callId !== 'string' || typeof data.name !== 'string') continue
    // This consultation is still waiting for the Advisor that receives this
    // packet. It is not missing task evidence; earlier advice has its own field.
    if (data.name === 'consult_advisor') continue
    callById.set(data.callId, { event, name: data.name, args: parseArguments(data.arguments) })
  }
  const resultById = new Map<string, { event: EventRecord; text: string; failed: boolean }>()
  for (const event of requesterEvents) {
    if (event.type === 'tool/code-dispatch' || event.type === 'tool/ptc-dispatch') {
      const data = record(event.data)
      if (!data || typeof data.subCallId !== 'string') continue
      const call = callById.get(data.subCallId)
      const started = call && record(call.event.data)
      if (call && call.event.type !== 'tool/call' && call.name === data.name && started?.parentCallId === data.parentCallId && eventSeq(event) >= eventSeq(call.event)) resultById.set(data.subCallId, { event, text: blockTexts(data.content).join('\n'), failed: data.isError === true })
      continue
    }
    if (event.type !== 'tool/result') continue
    const result = toolResult(event)
    const call = result.callId ? callById.get(result.callId) : undefined
    if (!call || eventSeq(event) < eventSeq(call.event)) continue
    const callData = record(call.event.data), resultData = record(event.data)
    if (typeof resultData?.turn === 'number' && (resultData.turn !== callData?.turn || resultData.step !== callData?.step)) continue
    resultById.set(result.callId!, { event, text: result.text, failed: result.failed })
  }
  const deltaSeqs = new Set(delta.map(eventSeq))
  const canInspect = input.allowedTools.some(name => ['read', 'grep', 'glob'].includes(name))
  const inspectionOutput = (callId: string, text: string): string => {
    const call = callById.get(callId)
    const result = resultById.get(callId)
    return canInspect && call && ['read', 'read_image', 'glob', 'grep'].includes(call.name) && result && !result.failed
      ? '(Inspection output omitted; use the allowed tools to read current contents at the supplied paths.)'
      : text
  }
  const observed = new Map((input.observedEvidence ?? input.trigger?.evidence ?? []).filter(item => item.callId).map(item => [item.callId, item]))
  // Tracker evidence ties a call to the trigger through its validation key. That
  // link is what the consultation is about, so it survives every cap below.
  const triggerKeys = new Set((input.trigger?.signals ?? []).flatMap(signal => signal.validationKey === undefined ? [] : [signal.validationKey]))
  const triggerFingerprints = new Set((input.trigger?.signals ?? []).map(signal => signal.fingerprint))
  const triggerRelated = (callId: string): boolean => {
    const evidence = observed.get(callId)
    return evidence?.validationKey !== undefined && triggerKeys.has(evidence.validationKey)
      || evidence?.fingerprint !== undefined && triggerFingerprints.has(evidence.fingerprint)
  }
  // A successful run_code wrapper only reports that its PTC program settled.
  // Its concrete sub-dispatches carry the actual tools, arguments and outcomes,
  // so retaining both doubles the same activity without adding evidence. Keep a
  // failed or unfinished wrapper because it may be the only record of a bridge
  // failure that happened outside every sub-dispatch.
  const ptcParents = new Set([...callById.values()].flatMap(call => {
    if (call.event.type === 'tool/call') return []
    const parentCallId = record(call.event.data)?.parentCallId
    return typeof parentCallId === 'string' ? [parentCallId] : []
  }))
  const allActivity = [...callById.entries()]
    .filter(([callId, call]) => deltaSeqs.has(eventSeq(call.event))
      || (resultById.get(callId) !== undefined && deltaSeqs.has(eventSeq(resultById.get(callId)!.event))))
    .map<ActivityRecord>(([callId, call]) => {
      const result = resultById.get(callId)
      const canonical = observed.get(callId)
      return {
        call_id: callId,
        tool: call.name,
        arguments_summary: summary(call.args, ACTIVITY_SUMMARY_BYTES),
        call_seq: eventSeq(call.event),
        ...(result === undefined ? { outcome: 'result-not-observed' } : {
          outcome: canonical ? (canonical.outcome === 'validation-failure' || canonical.outcome === 'unknown-failure' ? 'failed' : canonical.outcome === 'success' ? 'succeeded' : canonical.outcome) : result.failed ? 'failed' : 'succeeded',
          result_seq: eventSeq(result.event),
          result_summary: summary(inspectionOutput(callId, canonical?.errorSummary || result.text), ACTIVITY_SUMMARY_BYTES),
        }),
      }
    })
  const activity = allActivity.flatMap(item => {
    if (item.tool !== 'run_code' || !ptcParents.has(item.call_id)) return [item]
    if (item.outcome === 'succeeded') return []
    const { arguments_summary: _arguments, ...wrapper } = item
    return [{ ...wrapper, ...('result_summary' in wrapper ? { result_summary: boundedText(String(wrapper.result_summary), WRAPPER_FAILURE_SUMMARY_BYTES) } : {}) }]
  })
  const failures = boundedEvidence(activity.filter(item => item.outcome === 'failed'), item => triggerRelated(item.call_id), MAX_FAILURES)
    .map(item => ({
      call_id: item.call_id,
      tool: item.tool,
      repeat_count: observed.get(item.call_id)?.repeatCount ?? 1,
    }))
  const validationEvidence = activity.flatMap(item => {
    const call = callById.get(item.call_id)
    if (call?.name === 'run_code' && ptcParents.has(item.call_id)) return []
    const label = call && validationLabel(call.name, call.args)
    if (!label || item.outcome === 'result-not-observed') return []
    return [{
      call_id: item.call_id,
      tool: call.name,
      outcome: item.outcome,
      relevant_to_problem: triggerRelated(item.call_id),
    }]
  })
  const validation = boundedValidation(validationEvidence)
  // The caps drop rows, so the aggregate keeps the count the advisor would
  // otherwise lose: two unrelated successes and two hundred look identical.
  const succeededChecks = validationEvidence.filter(entry => entry.outcome === 'succeeded').length
  const failedChecks = validationEvidence.filter(entry => entry.outcome === 'failed').length
  const validationSummary = {
    total: validationEvidence.length,
    retained: validation.length,
    omitted: validationEvidence.length - validation.length,
    succeeded: succeededChecks,
    failed: failedChecks,
    other: validationEvidence.length - succeededChecks - failedChecks,
    relevant: validationEvidence.filter(entry => entry.relevant_to_problem).length,
  }
  const requesterEvidenceAll = unique(input.evidence ?? [])
  const requesterFailedAll = unique(input.failedAttempts ?? [])
  const truncation = {
    requester_evidence_omitted: Math.max(0, requesterEvidenceAll.length - MAX_REQUESTER_EVIDENCE),
    failed_attempts_omitted: Math.max(0, requesterFailedAll.length - MAX_REQUESTER_FAILED_ATTEMPTS),
  }
  const attempts = requesterFailedAll.slice(0, MAX_REQUESTER_FAILED_ATTEMPTS).map(action => ({
    action,
    outcome: 'failed',
    evidence_refs: [] as string[],
    source: 'requester-supplied',
  }))
  const recentTail = delta.flatMap(event => {
    const seq = eventSeq(event)
    if (event.type === 'user/message') {
      const plugin = record(messageOf(event)?.source)?.plugin
      // The child assembles its own runtime context. Copying the requester's
      // snapshot would misstate its permissions and advertise recursive advice.
      if (plugin === 'dsh-escalation-advisor' || plugin === '@deepseek-ai/dsh-system-prompt') return []
      const text = messageText(event)
      return text ? [{ role: 'user', summary: boundedText(text, 1800), seq }] : []
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event)
      return text ? [{ role: 'assistant', summary: boundedText(text, 1800), seq }] : []
    }
    if (event.type === 'tool/result') {
      const result = toolResult(event)
      if (!result.callId || resultById.get(result.callId)?.event !== event) return []
      // Keep a zero-content marker until after the chronological window is cut.
      // Filtering tools before slice(-16) backfilled older conversation and made
      // a long tool burst revive context that was no longer recent.
      return [{ role: 'tool', summary: '', seq }]
    }
    return []
  }).slice(-MAX_RECENT_TAIL).filter(entry => entry.role !== 'tool')
  const referencedActivity = new Set([...failures, ...validation].map(entry => entry.call_id))
  const recentActivity = new Set(allActivity.slice(-BASE_ACTIVITY_ENTRIES).map(entry => entry.call_id))
  const activityCandidates = activity.filter(item => recentActivity.has(item.call_id) || referencedActivity.has(item.call_id))
  const toolActivity = boundedEvidence(activityCandidates, item => referencedActivity.has(item.call_id), MAX_ACTIVITY_ENTRIES)
  const changedPaths = unique(toolActivity.flatMap(item => {
    const call = callById.get(item.call_id)
    return call && item.outcome === 'succeeded' && MUTATION_TOOL.test(call.name) ? collectPaths(call.args) : []
  }))
  const assignment = requesterAssignment(input.requester, input.root, requesterEvents, taskStartSeq)
  // Durable goal state remains authoritative until cleared; only transcript evidence is task-bounded.
  const task = rootTask(rootEvents)
  const trigger = input.trigger
    ? {
        turn: input.trigger.turn,
        ...(input.trigger.step === undefined ? {} : { step: input.trigger.step }),
        score: input.trigger.score,
        fingerprint: boundedText(input.trigger.problemFingerprint, 400),
        signals: input.trigger.signals.map(signal => ({
          kind: signal.kind,
          weight: signal.weight,
          detail: boundedText(signal.detail, 800),
          fingerprint: boundedText(signal.fingerprint, 400),
        })),
      }
    : undefined
  const header = input.requester.session.header as { cwd?: string; delegationDepth?: number; parentSession?: unknown }
  const packet = {
    schema_version: 1,
    consultation: {
      id: boundedText(input.consultationId, 300),
      mode: input.mode,
      delta_after_seq: input.sinceSeq ?? null,
      task_start_seq: taskStartSeq,
      last_seq: lastSeq,
    },
    requester: {
      role: header.parentSession === undefined ? 'root' : 'local-subagent',
      delegation_depth: header.delegationDepth ?? 0,
      session_id: boundedText(sessionId(input.requester), 300),
      ...(header.cwd ? { cwd: boundedText(header.cwd, 1000) } : {}),
    },
    task: {
      ...task,
      ...(assignment === undefined ? {} : { requester_assignment: assignment }),
    },
    question: {
      exact_question: boundedText(input.question),
      ...(input.decisionNeeded ? { decision_needed: boundedText(input.decisionNeeded, 1000) } : {}),
      ...(input.currentHypothesis ? { current_hypothesis: boundedText(input.currentHypothesis, 2400) } : {}),
    },
    ...(trigger === undefined ? {} : { trigger }),
    requester_supplied: {
      evidence: unique(input.evidence ?? []).slice(0, MAX_REQUESTER_EVIDENCE),
      failed_attempts: unique(input.failedAttempts ?? []).slice(0, MAX_REQUESTER_FAILED_ATTEMPTS),
      authority: 'claims-for-review',
    },
    attempts,
    failures,
    validation,
    validation_summary: validationSummary,
    workspace: {
      observed_changed_paths: changedPaths,
      relevant_symbols: [] as string[],
      change_evidence: 'Paths are inferred from successful mutation tool calls; no git diff is claimed.',
    },
    prior_advice: requesterEvents.filter(event => eventSeq(event) >= taskStartSeq && event.type === 'advisor/run' && record(event.data)?.status === 'delivered' && record(event.data)?.requesterId === sessionId(input.requester) && (!input.trigger || record(event.data)?.fingerprint === input.trigger.problemFingerprint)).slice(-4).map(event => {
      const run = record(event.data)!
      return { problem_fingerprint: run.fingerprint ?? null, summary: summary(run.summary), acted_on: null, child_session_id: run.childSessionId ?? null }
    }),
    capabilities: {
      allowed_tools: unique(input.allowedTools),
      unavailable_tools: unique(input.unavailableTools),
      mutation_policy: input.mutationPolicy,
    },
    tool_activity: toolActivity,
    recent_tail: recentTail,
    ...(truncation.requester_evidence_omitted + truncation.failed_attempts_omitted > 0 ? { truncation } : {}),
  }
  const meaningfulDelta = changedPaths.length > 0
    || failures.length > 0
    || validation.length > 0
    || delta.some(event => event.type === 'assistant/message' && materialAssistantConclusion(messageText(event)))
  const fitted = fitCasePacket(redactValue(packet) as Record<string, unknown>)
  const prompt = JSON.stringify(fitted)
  // Coverage candidates come from the FINAL fitted packet: fitCasePacket can drop
  // tool_activity and truncate failures/validation, so pre-fit arrays may name
  // evidence the Advisor never receives. Only delivered call ids count.
  const fittedCalls = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(item => {
    const id = record(item)?.call_id
    return typeof id === 'string' ? [id] : []
  }) : []
  const fittedPacket = record(fitted) ?? {}
  const coveredCallIds = unique([...fittedCalls(fittedPacket.tool_activity), ...fittedCalls(fittedPacket.failures), ...fittedCalls(fittedPacket.validation)])
  // Coverage candidates are an upper bound, not proof of review: with a trigger,
  // only the trigger fingerprint plus trigger-related evidence (same validation
  // identity or fingerprint as the trigger signals) can count, so reviewing B
  // never refreshes A's per-fingerprint epoch. Without a trigger every delivered
  // failure evidence is a candidate; the verdict attribution below decides what
  // was actually examined.
  const retainedObserved = (input.observedEvidence ?? []).filter(item => item.fingerprint && item.callId && coveredCallIds.includes(item.callId))
  const scopedObserved = input.trigger ? retainedObserved.filter(item => triggerRelated(item.callId as string)) : retainedObserved
  const coveredFingerprints = unique([
    ...(input.trigger ? [input.trigger.problemFingerprint] : []),
    ...scopedObserved.map(item => item.fingerprint as string),
  ])
  return {
    // DSH owns token accounting for the complete model request, including its
    // system prompt and tool schemas. Bytes are not a model token limit.
    prompt,
    lastSeq,
    meaningful: input.mode === 'continuous' ? meaningfulDelta : true,
    coveredFingerprints,
    coveredCallIds,
  }
}

export function textContent(blocks: readonly unknown[]): string {
  return blockTexts(blocks).join('\n')
}

/**
 * Verdict attribution (the stricter audit variant): retention is an upper bound
 * on coverage, never proof of review. A candidate fingerprint is marked covered
 * only with verifiable attribution — the verdict names one of its delivered
 * tool calls (`{kind:'tool'}`), or explicitly claims the fingerprint itself
 * (`{kind:'fingerprint'}`, verified against the candidates). Anything else,
 * including an empty verdict or references that match nothing delivered, marks
 * nothing: the trigger fingerprint itself is always marked separately by the
 * caller as explicit host scope, so raising a consultation still counts.
 */
export function narrowCoveredByVerdict(args: {
  candidates: readonly string[]
  evidenceUsed: readonly { kind: string; reference: string }[]
  coveredCallIds: readonly string[]
  callsForFingerprint: (fingerprint: string) => readonly string[]
}): string[] {
  const delivered = new Set(args.coveredCallIds)
  const toolRefs = new Set(args.evidenceUsed.filter(item => item.kind === 'tool').map(item => item.reference).filter(ref => delivered.has(ref)))
  const fingerprintRefs = new Set(args.evidenceUsed.filter(item => item.kind === 'fingerprint').map(item => item.reference).filter(ref => args.candidates.includes(ref)))
  if (toolRefs.size === 0 && fingerprintRefs.size === 0) return []
  return args.candidates.filter(fingerprint => fingerprintRefs.has(fingerprint) || args.callsForFingerprint(fingerprint).some(callId => toolRefs.has(callId)))
}