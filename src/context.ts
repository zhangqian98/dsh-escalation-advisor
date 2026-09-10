import type { Agent } from '@deepseek-ai/dsh-agent'
import { redactSecrets, truncateUtf8 } from './redact.js'
import type { EscalationDecision, TrackerEvidence } from './state.js'

export interface BuildCasePacketInput {
  requester: Agent
  root: Agent
  mode: 'manual' | 'escalation' | 'continuous'
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
}

interface EventRecord {
  type?: unknown
  seq?: unknown
  data?: unknown
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
    ? unique(criteriaValue.filter((item): item is string => typeof item === 'string'))
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

function materialAssistantConclusion(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  if (value.length >= 80) return true
  return /\b(root cause|conclusion|fixed|implemented|changed|validated|passes?|fails?|blocked|recommend|should|must|because|therefore)\b/i.test(value)
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
const MAX_VALIDATION_ENTRIES = 10
const VALIDATION_SUCCESS_CONTEXT = 2
const MAX_FAILURES = 8

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
  const keptRelated = related.slice(-MAX_VALIDATION_ENTRIES)
  const keptFailed = failed.slice(-Math.max(0, MAX_VALIDATION_ENTRIES - keptRelated.length))
  const room = Math.max(0, MAX_VALIDATION_ENTRIES - keptRelated.length - keptFailed.length)
  const keptSuccessful = successful.slice(-Math.min(VALIDATION_SUCCESS_CONTEXT, room))
  return [...keptRelated, ...keptFailed, ...keptSuccessful].sort((left, right) => left - right).map(index => entries[index]!)
}

/** Pinned entries plus the newest of the rest, in the original chronological order. */
function boundedEvidence<T>(entries: readonly T[], pin: (entry: T) => boolean, limit: number): T[] {
  const pinned: number[] = []
  const rest: number[] = []
  entries.forEach((entry, index) => (pin(entry) ? pinned : rest).push(index))
  const keptPinned = pinned.slice(-limit)
  const keptRest = rest.slice(-Math.max(0, limit - keptPinned.length))
  return [...keptPinned, ...keptRest].sort((left, right) => left - right).map(index => entries[index]!)
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
  const triggerRelated = (callId: string): boolean => {
    const key = observed.get(callId)?.validationKey
    return key !== undefined && triggerKeys.has(key)
  }
  const activity = [...callById.entries()]
    .filter(([callId, call]) => deltaSeqs.has(eventSeq(call.event))
      || (resultById.get(callId) !== undefined && deltaSeqs.has(eventSeq(resultById.get(callId)!.event))))
    .map(([callId, call]) => {
      const result = resultById.get(callId)
      const canonical = observed.get(callId)
      return {
        call_id: callId,
        tool: call.name,
        arguments_summary: summary(call.args),
        call_seq: eventSeq(call.event),
        ...(result === undefined ? { outcome: 'result-not-observed' } : {
          outcome: canonical ? (canonical.outcome === 'validation-failure' || canonical.outcome === 'unknown-failure' ? 'failed' : canonical.outcome === 'success' ? 'succeeded' : canonical.outcome) : result.failed ? 'failed' : 'succeeded',
          result_seq: eventSeq(result.event),
          result_summary: summary(inspectionOutput(callId, canonical?.errorSummary || result.text)),
        }),
      }
    })
  const failures = boundedEvidence(activity.filter(item => item.outcome === 'failed'), item => triggerRelated(item.call_id), MAX_FAILURES)
    .map(item => ({
      tool: item.tool,
      arguments_summary: item.arguments_summary,
      error_summary: ('result_summary' in item && item.result_summary) || 'Tool reported an error without text.',
       repeat_count: observed.get(item.call_id)?.repeatCount ?? 1,
      call_id: item.call_id,
    }))
  const validationEvidence = activity.flatMap(item => {
    const call = callById.get(item.call_id)
    const label = call && validationLabel(call.name, call.args)
    if (!label || item.outcome === 'result-not-observed') return []
    return [{
      command_or_tool: label,
      outcome: item.outcome,
      relevant_to_problem: triggerRelated(item.call_id),
      call_id: item.call_id,
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
  const changedPaths = unique(activity.flatMap(item => {
    const call = callById.get(item.call_id)
    return call && item.outcome === 'succeeded' && MUTATION_TOOL.test(call.name) ? collectPaths(call.args) : []
  }))
  const attempts = unique(input.failedAttempts ?? []).map(action => ({
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
      return result.text ? [{ role: 'tool', summary: boundedText(inspectionOutput(result.callId ?? '', result.text), 1800), seq }] : []
    }
    return []
  }).slice(-16)
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
      evidence: unique(input.evidence ?? []),
      failed_attempts: unique(input.failedAttempts ?? []),
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
    tool_activity: activity.slice(-16),
    recent_tail: recentTail,
  }
  const meaningfulDelta = changedPaths.length > 0
    || failures.length > 0
    || validation.length > 0
    || delta.some(event => event.type === 'assistant/message' && materialAssistantConclusion(messageText(event)))
  return {
    // DSH owns token accounting for the complete model request, including its
    // system prompt and tool schemas. Bytes are not a model token limit.
    prompt: JSON.stringify(redactValue(packet)),
    lastSeq,
    meaningful: input.mode === 'continuous' ? meaningfulDelta : true,
  }
}

export function textContent(blocks: readonly unknown[]): string {
  return blockTexts(blocks).join('\n')
}
