import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { Config } from './config.js'
import type { EffectiveAdvisorPolicy } from './policy.js'
import { ADVISOR_SYSTEM_PROMPT } from './prompts.js'
import { redactSecrets } from './redact.js'
import { type AdvisorVerdict } from './verdict.js'
import { ADVISOR_VERDICT_TOOL, type AdvisorVerdictCollector } from './verdict-tool.js'
import { isCapabilityAmplifier } from './capabilities.js'
import type { AdvisorRegistry } from './registry.js'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/**
 * The `session/event` payload is structurally typed; only these fields are read,
 * and only as owned leaf data — never as a live runtime object.
 */
interface TurnBoundaryEvent {
  readonly seq?: unknown
  readonly data?: { turn?: unknown; reason?: Record<string, unknown> }
}

/**
 * The request the CONTINUABLE transport accepts. There is deliberately no
 * `outputSchema` on this path — which is exactly why the Stage 1
 * `advisor_verdict` tool owns the verdict contract instead.
 */
export type AdvisorStartRequest = Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>

/**
 * Which conversation the next turn belongs to. A fresh consultation delivers an
 * initial prompt through `startContinuable`; a follow-up delivers new content to
 * the child session the first turn established, so the earlier context, persona
 * and tool policy stay intact.
 */
export type AdvisorContinuation =
  | { readonly kind: 'start'; readonly prompt: string }
  | { readonly kind: 'continue'; readonly childSessionId: string; readonly prompt: string }


/** The measured closure facts for one delivered Advisor turn. */
export interface AdvisorTurnClosure {
  readonly turn: number
  /** Child session seq of the `turn/end` that closed the turn. */
  readonly seq: number
  /** `turn/end` reason kind. Only `completed` is a successful closure. */
  readonly kind: string
}

export interface AdvisorTurnResult {
  readonly childSessionId: string
  /** The inbox message id the transport accepted for this turn. */
  readonly messageId: string
  readonly closure: AdvisorTurnClosure
  /** Present only for a verdict reconciled against this turn's closure. */
  readonly verdict?: AdvisorVerdict
  readonly usage?: { inputTokens: number; outputTokens: number }
}

export class AdvisorUnavailableError extends Error {
  constructor(message: string, readonly code = 'advisor_unavailable', readonly transient = false) { super(redactSecrets(message)); this.name = 'AdvisorUnavailableError' }
}

export interface AdvisorRunResult {
  verdict: AdvisorVerdict
  childSessionId: string
  /**
   * The PUBLIC consultation handle: the exact string a consumer may send back as
   * `consultation_id` to continue this conversation, and the same string every
   * later turn of that conversation reports. It is never the per-turn identity of
   * an internal channel; see `collectorId` below.
   */
  consultationId: string
  /**
   * INTERNAL, never reported: the verdict channel identity of THIS turn. The
   * collector holds one candidate slot per record, so one record cannot carry a
   * second turn's verdict without refusing it as a duplicate or a conflict; a
   * follow-up therefore opens its own record. Keying that record apart from the
   * public handle is also what makes an earlier turn's cleanup unable to clear the
   * live turn's child index.
   */
  collectorId: string
  usage?: { inputTokens: number; outputTokens: number }
  /** Requester sequence at packet construction; the continuous-review cursor. */
  lastSeq: number
}


export function advisorToolSurface(ctx: Context, parent: Agent, policy: EffectiveAdvisorPolicy, amplifierTools: readonly string[] = []) {
  const visible = new Set(ctx.tools.schemas(parent).map(tool => tool.name))
  const global = new Set(ctx.tools.schemas().map(tool => tool.name))
  const requested = policy.allowedTools.filter(name => !isCapabilityAmplifier(ctx, name, amplifierTools))
  return { allowedTools: requested.filter(name => visible.has(name) && global.has(name)), unavailableTools: requested.filter(name => !visible.has(name) || !global.has(name)) }
}

export function advisorPolicyNote(allowedTools: string[], unavailableTools: string[]): string {
  return 'ADVISOR TOOL POLICY:\nExposed: ' + (allowedTools.join(', ') || '(none)') + '\nUnavailable: ' + (unavailableTools.join(', ') || '(none)') + '. Never claim to use unavailable tools. Never delegate or create execution scopes.\n\n'
}

// ---------------------------------------------------------------------------
// Failure branches. Each is a distinct NON-approval with its own code, and none
// of them ever falls back to the Advisor's prose.
// ---------------------------------------------------------------------------

/** The transport refused the delivery outright: nothing was accepted. */
export const START_REJECTED = 'start_rejected'
/** The transport accepted a message no turn of that child session ever claimed. */
export const ACCEPTED_NOT_CLAIMED = 'accepted_not_claimed'
/** A claimed turn whose closing boundary never arrived inside the deadline. */
export const CLOSURE_TIMEOUT = 'closure_timeout'
/** A claimed turn that closed with a reason other than `completed`. */
export const TURN_NOT_COMPLETED = 'turn_not_completed'
/** A turn that closed `completed` whose verdict never reconciled. */
export const NO_VERDICT = 'no_verdict'

// A failure the provider or the transport can recover from by retrying, as
// opposed to a rejection that proves the request itself cannot succeed. The
// authentication cases belong here: a missing or temporarily unavailable
// credential is repaired between attempts, so the consultation retries instead
// of being abandoned.
const TRANSIENT_PATTERN = /timeout|timed out|rate.limit|overload|unavailable|server|network|econn|concurrenc|429|50[0234]|authenticat|credential|unauthori[sz]ed|\b401\b|\b403\b/i

/**
 * A wait bounded by an EXPLICIT deadline. `AbortSignal.timeout` does not expose
 * its deadline, so the instant and the elapsed-versus-cancelled distinction live
 * here instead of being inferred afterwards.
 */
export interface DeadlineSignal {
  readonly signal: AbortSignal
  /** Absolute deadline in epoch milliseconds. */
  readonly deadline: number
  /** The elapsed deadline — not the caller — produced the abort. */
  readonly timedOut: () => boolean
  readonly dispose: () => void
}

/** The abort reason a reached deadline carries, so the two sources stay distinct. */
const DEADLINE_REASON = 'Advisor closure deadline reached.'

/**
 * Create the deadline independently, then combine it with the caller's signal.
 *
 * A caller may hand in a signal that is itself a timeout (`AbortSignal.timeout`
 * or `AbortSignal.any` over one). That reason is indistinguishable from an
 * elapsed deadline by name alone, so the elapsed case is marked at the instant
 * it happens and every other abort is reported as a caller cancellation.
 */
export function deadlineSignal(caller: AbortSignal, timeoutMs: number): DeadlineSignal {
  const bounded = Math.max(0, timeoutMs)
  const controller = new AbortController()
  let elapsed = false
  const timer = setTimeout(() => {
    elapsed = true
    controller.abort(new DOMException(DEADLINE_REASON, 'TimeoutError'))
  }, bounded)
  if (typeof timer.unref === 'function') timer.unref()
  const onAbort = (): void => { if (caller.reason !== undefined && caller.reason?.name === 'TimeoutError') elapsed = true; controller.abort(caller.reason) }
  caller.addEventListener('abort', onAbort, { once: true })
  if (caller.aborted) onAbort()
  return {
    signal: controller.signal,
    deadline: Date.now() + bounded,
    timedOut: () => elapsed,
    dispose: () => { clearTimeout(timer); caller.removeEventListener('abort', onAbort) },
  }
}


/** Bounded, owned facts about a non-`completed` closing reason. */
export function reasonFacts(event: TurnBoundaryEvent | undefined): string {
  const reason = event?.data?.reason
  if (reason === undefined) return 'no closing reason was recorded'
  const facts: Record<string, string> = {}
  const record = (prefix: string, value: unknown): void => {
    if (typeof value === 'string') { facts[prefix] = value; return }
    if (value === null || typeof value !== 'object') return
    const nested = value as Record<string, unknown>
    if (typeof nested.message === 'string') facts[prefix] = nested.message
    else if (typeof nested.code === 'string') facts[prefix] = nested.code
    else if (nested.name !== undefined) facts[prefix] = String(nested.name)
  }
  record('error', reason.error)
  record('reason', reason.reason)
  return Object.keys(facts).length ? JSON.stringify(facts) : 'no further detail was recorded'
}

const kindOf = (event: TurnBoundaryEvent | undefined): string | undefined => {
  const kind = event?.data?.reason?.kind
  return typeof kind === 'string' ? kind : undefined
}

// ---------------------------------------------------------------------------
// Per-turn observability
//
// A host-tier `agent/inbox/claimed` maps the delivered message to the turn that
// claims it, and THAT child session's `turn/end` closes it. Both listeners are
// installed BEFORE the dispatch call: the first turn is claimed before the start
// promise's own continuation resumes, so an observer installed only after the
// `await` misses the claim of its own message.
// ---------------------------------------------------------------------------

export interface TurnClosure {
  /** The `turn/end` that closed the claimed turn, or nothing when it never did. */
  readonly turnEnd?: TurnBoundaryEvent
  /** The claimed message id, or nothing when no turn ever claimed the delivery. */
  readonly messageId?: string
  /**
   * The turn a claim bound to the delivered message, or nothing when the
   * delivery was never claimed. A claim belonging to another session is never
   * counted, so this is the only evidence that a turn existed at all.
   */
  readonly claimedTurn?: number
}

export interface TurnObserver {
  readonly closed: Promise<TurnClosure>
  /**
   * Name the child session this delivery addressed. Called with the child id
   * right after dispatch, but the observers are already live: an inbox claim
   * whose message id is not yet bound is kept as a candidate, so a claim that
   * fires before the start promise resumes is still measured.
   */
  bind(childSessionId: string, deliveredMessageId?: string): void
  dispose(): void
}

/**
 * Measure the closure of ONE delivery into ONE child session.
 *
 * Both listeners are installed before the dispatch call. `agent/inbox/claimed`
 * maps a message to the turn that claimed it and is only delivered to
 * subscribers live at claim time, so an observer installed after the start
 * promise resumes misses the claim of its own message and could never
 * distinguish `accepted but never claimed` from `claimed but never closed`.
 * A claim is therefore bound either by the known child session or by the
 * message id returned from dispatch, and the closure is only reported when the
 * declaring `turn/end` belongs to the session that claimed the message.
 */
export function installTurnObserver(ctx: Context, signal: DeadlineSignal, childSessionId?: string): TurnObserver {
  const claimed = new Map<string, { sessionId: string; turn: number; own: boolean }>()
  let target = childSessionId
  let messageId: string | undefined
  let settled = false
  let resolve!: (value: TurnClosure) => void
  const closed = new Promise<TurnClosure>((done) => { resolve = done })
  /** Whether this claim is known to belong to the delivery being measured. */
  const own = (id: string, sessionId: string): boolean => id === messageId || (target !== undefined && sessionId === target)
  /** The turn that claimed the delivered message, once any claim proves it. */
  let claimedTurn: number | undefined
  // A claim accepted before dispatch resolved is re-evaluated once the child
  // session or the delivered message id is known.
  const rebind = (): void => {
    for (const [id, claim] of claimed) {
      claim.own = own(id, claim.sessionId)
      // A claim that arrived before dispatch resolved becomes ours only now.
      if (claim.own) claimedTurn = claim.turn
    }
  }
  const stopClaim = ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (settled) return
    const sessionId = String(agent.id), id = String(message.id)
    // Before dispatch resolves, any claim in flight is a candidate: the runtime
    // may claim the delivered message before `startContinuable` resolves, and a
    // candidate that turns out not to be ours is discarded by `own` at the
    // boundary. Nothing else in this call can claim an inbox message.
    const isOwn = own(id, sessionId)
    claimed.set(id, { sessionId, turn: Number(turn), own: isOwn })
    if (isOwn) claimedTurn = Number(turn)
  })

  const stopTurn = ctx.on('session/event', (session, event) => {
    if (settled || event.type !== 'turn/end') return
    const boundary = event as unknown as TurnBoundaryEvent
    const turn = Number(boundary.data?.turn)
    if (!Number.isSafeInteger(turn)) return
    const sessionId = String(session.id)
    const claiming = [...claimed.entries()].find(([, claim]) => claim.own && claim.turn === turn && claim.sessionId === sessionId)
    // A turn nobody claimed is a different matter entirely: only the claimed
    // turn of the session that claimed the delivery can close it.
    if (claiming === undefined) return
    settle({ turnEnd: boundary, messageId: claiming[0], claimedTurn: turn })
  })

  // No boundary was established. A claim that names the delivered message is still
  // proof that a turn existed, so it is reported instead of being treated as an
  // unclaimed delivery.
  const stopAbort = (): void => {
    settle(claimedTurn === undefined ? {} : { claimedTurn })
  }
  const timer = setTimeout(stopAbort, Math.max(0, signal.deadline - Date.now()))
  if (typeof timer.unref === 'function') timer.unref()
  const stop = (): void => {
    stopClaim()
    stopTurn()
    clearTimeout(timer)
    signal.signal.removeEventListener('abort', stopAbort)
  }
  function settle(value: TurnClosure): void {
    if (settled) return
    settled = true
    resolve(value)
    stop()
  }
  signal.signal.addEventListener('abort', stopAbort, { once: true })
  if (signal.signal.aborted) stopAbort()
  return {
    closed,
    bind: (child: string, id?: string) => { target ??= child; messageId ??= id; rebind() },
    dispose: () => { settled = true; stop() },
  }
}

/** Ask the runtime to stop an orphaned turn; an absent or closing target is a no-op. */
export interface InterruptRuntime {
  interrupt(target: SessionId, authority: { kind: 'ancestor'; agent: Agent }): void
}

function interrupt(subagents: InterruptRuntime, childSessionId: string, parent: Agent): void {
  try { subagents.interrupt(SessionId(childSessionId), { kind: 'ancestor', agent: parent }) } catch { /* the target is gone or already closing */ }
}

/** Token usage for ONE turn; the child session accumulates every turn of a consultation. */
function usageOfTurn(ctx: Context, childSessionId: string, turn: number): { usage?: { inputTokens: number; outputTokens: number } } {
  const events = ctx.agents.get(SessionId(childSessionId))?.session.snapshotEvents() ?? []
  const usage = { inputTokens: 0, outputTokens: 0 }
  let known = false, missing = false
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const eventTurn = (event.data as { turn?: number }).turn
    if (eventTurn !== turn) continue
    if (event.type === 'assistant/attempt') { missing = true; continue }
    const tokens = (event.data as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    if (typeof tokens?.inputTokens !== 'number' || typeof tokens?.outputTokens !== 'number') { missing = true; continue }
    known = true
    usage.inputTokens += tokens.inputTokens
    usage.outputTokens += tokens.outputTokens
  }
  return known && !missing ? { usage } : {}
}

/** The requester's own last sequence, used as the continuous-review cursor. */
export function requesterSeq(agent: Agent): number {
  return agent.session.snapshotEvents().reduce((last, event) => Math.max(last, typeof event.seq === 'number' ? event.seq : -1), -1)
}

/**
 * Run one visible Advisor turn, with identity attached before its first model
 * request.
 *
 * `continuation` is either a fresh prompt — a new consultation, dispatched
 * through `ctx.subagents.startContinuable` — or the durable id of the child to
 * continue, which is a follow-up turn in the SAME child session delivered
 * through `ctx.subagents.sendMessage`. The sender passed there is the EXACT live
 * requesting Agent, because the runtime rejects a sender that is not the live
 * direct parent with UNAUTHORIZED.
 *
 * A verdict is present only when the turn's own verdict tool submission was
 * reconciled against that turn's closing boundary. Every other exit is an
 * explicit non-approval and never falls back to the Advisor's prose.
 */
export async function callAdvisor(
  ctx: Context, config: Config, parent: Agent, continuation: AdvisorContinuation, signal: AbortSignal,
  policy: EffectiveAdvisorPolicy, label: string,
  /**
   * `publicId` is the stable handle every turn of this conversation reports and
   * accepts; `collectorId` is THIS turn's internal verdict-channel identity.
   * `followUp` marks a user-requested continuation of an existing conversation.
   */
  lifecycle: { registry: AdvisorRegistry; root: Agent; collector: AdvisorVerdictCollector; publicId: string; collectorId: string; followUp?: boolean; onStarted: () => void; onPublished: (id: string) => void },
  /**
   * An issued id can be a collector id that the previous code reported to the
   * caller: `<uuid>#<turn>.<attempt>`. Stripping that suffix is the only way to
   * accept such an id as a continuation handle, and no issued conversation id
   * contains `#`, so the fallback can never name a different conversation.
   */
  normalizeConsultationId = (value: string): string => value.replace(/#.*$/, ''),
): Promise<AdvisorRunResult> {
  if (!config.provider.trim() || !config.model.trim()) throw new AdvisorUnavailableError('Advisor provider/model is not configured.', 'configuration')
  const subagents = parent.ctx.get('subagents') ?? ctx.get('subagents')
  if (!subagents) throw new AdvisorUnavailableError('DSH subagent runtime is unavailable.', 'configuration')
  const { allowedTools, unavailableTools } = advisorToolSurface(ctx, parent, policy, config.capabilityAmplifierTools)
  // The verdict channel is host-owned and is always exposed to the Advisor; it is
  // not part of the configurable tool policy.
  const advisorTools = [...allowedTools, ADVISOR_VERDICT_TOOL]
  const prefix = advisorPolicyNote(advisorTools, unavailableTools)
  const timeoutMessage = 'Advisor consultation timed out (configured per-attempt limit: ' + config.timeoutMs / 1000 + ' seconds).'
  const deadline = deadlineSignal(signal, config.timeoutMs)
  const callSignal = deadline.signal
  const identity = lifecycle.registry.reserve(parent, lifecycle.root, advisorTools)
  lifecycle.collector.open({ id: lifecycle.collectorId, invocationId: identity.invocationId, requesterId: String(parent.id), rootId: String(lifecycle.root.id) })
  const collectorId = lifecycle.collectorId
  // The PUBLIC handle: reported to the caller and accepted verbatim on the next
  // call. It is fixed by the FIRST turn of the conversation and never re-minted,
  // so it keeps addressing the same conversation however many turns follow.
  const consultationId = lifecycle.publicId
  let conversationId = continuation.kind === 'continue' ? continuation.childSessionId : ''
  let observed: TurnObserver | undefined
  // This turn's binding: written only by `bind` below, removed only by this
  // turn's own cleanup, and never by a later, failed or unrelated turn.
  let boundChild = false
  let claimed = false
  let published = false
  let closureCancelled = false
  let started = false

  // The loop prepares authentication before entering this stream. Unlike
  // agent/assistant-stream, this boundary also exists in DSH 0.1.2-rc.1 and
  // counts failures before the first chunk without charging preparation errors.
  const stopObserve = ctx.on('llm/stream', async function* (options, next) {
    if (!started && conversationId !== '' && !options.purpose && String(options.sessionId ?? '') === conversationId) {
      options.signal?.throwIfAborted()
      started = true
      lifecycle.onStarted()
    }
    yield* next()
  })
  try {
    let messageId: string
    const onAbort = (): void => { closureCancelled = !deadline.timedOut(); interrupt(subagents, conversationId, parent) }
    try {
      // A retry of a FRESH consultation starts a new conversation: continuing the
      // failed one would either resend into a child this deployment cannot reach or
      // re-enter the same failure. Only a user-requested follow-up addresses an
      // existing child session, and it keeps the prompt this turn delivers.
      const address = lifecycle.followUp === true && continuation.kind === 'continue' && conversationId !== ''
      // Armed BEFORE dispatch: the runtime may claim the delivered message before
      // `startContinuable` resolves, and that claim is the only evidence that the
      // delivery was accepted into a turn at all.
      observed = installTurnObserver(ctx, deadline, conversationId === '' ? undefined : conversationId)
      callSignal.addEventListener('abort', onAbort)
      if (callSignal.aborted) onAbort()
      if (address) {
        // Authorization is the EXACT live requesting Agent: the runtime rejects a
        // sender that is not the live direct parent of the addressed child.
        messageId = String(await subagents.sendMessage(parent, SessionId(conversationId), [{ type: 'text', text: prefix + continuation.prompt }], { signal: callSignal }))
        observed.bind(conversationId, messageId)
      } else {
        const request: AdvisorStartRequest = {
          prompt: [{ type: 'text', text: prefix + continuation.prompt }], parent,
          // Explicit undefined clears the spawn provider's inherited parent cap;
          // DSH then resolves the selected Advisor model's own output default.
          agentOptions: { provider: config.provider.trim(), model: config.model.trim(), maxTokens: undefined,
            reasoningEffort: config.reasoningEffort.trim() ? ReasoningEffortId(config.reasoningEffort.trim()) : undefined,
            advisorInvocation: identity.invocationId },
          toolFilter: { allow: advisorTools }, persona: ADVISOR_SYSTEM_PROMPT,
        }
        const child = await subagents.startContinuable({
          provider: config.subagentProvider.trim() || 'spawn', label, signal: callSignal, request,
        })
        conversationId = String(child.childId)
        messageId = String(child.messageId)
        observed.bind(conversationId, messageId)
      }
    } catch (error) {
      // An AdvisorUnavailableError raised by dispatch carries its own branch and
      // was already classified; anything else here is a transport refusal.
      if (error instanceof AdvisorUnavailableError) throw error
      if (signal.aborted) throw new AdvisorUnavailableError(signal.reason?.name === 'TimeoutError' ? timeoutMessage : 'Advisor request cancelled.', 'cancelled')
      // A start the runtime rejected is retryable unless the rejection proves the
      // request itself is impossible. Authentication and delivery failures are
      // recovered by retrying, not by giving up on the consultation.
      if (callSignal.aborted) throw new AdvisorUnavailableError(timeoutMessage, 'timeout', true)
      const message = error instanceof Error ? error.message : String(error)
      throw new AdvisorUnavailableError('Unable to deliver the Advisor consultation: ' + message, START_REJECTED, TRANSIENT_PATTERN.test(message))
    }
    lifecycle.onPublished(conversationId)
    // The child keeps the identity of the turn that materialized it, and the
    // delivered turn was admitted under THIS turn's invocation. Re-key it before
    // the turn can reach its verdict tool, so a submission is authorized against
    // the record bound above and not against a previous turn's identity.
    const advisorChild = ctx.agents.get(SessionId(conversationId))
    if (advisorChild) lifecycle.registry.ensureTurnIdentity(advisorChild, identity.invocationId)
    lifecycle.collector.bind(collectorId, conversationId)
    boundChild = true
    try {

      const closed = await observed.closed
      claimed = closed.messageId !== undefined
      const turnEnd = closed.turnEnd
      if (turnEnd === undefined) {
        // A timeout means CLOSURE WAS NOT ESTABLISHED, never "the child stopped".
        if (closureCancelled) throw new AdvisorUnavailableError('Advisor request cancelled before the delivered turn closed.', 'cancelled')
        // A claim is what separates a delivery that was never picked up from a turn
        // that ran and never closed; only the measured claim decides which.
        if (closed.claimedTurn === undefined) throw new AdvisorUnavailableError('The Advisor accepted the consultation but no turn of that child session ever claimed it, so closure was never established.', ACCEPTED_NOT_CLAIMED)
        throw new AdvisorUnavailableError(timeoutMessage + ' The delivered turn was claimed but never closed, so the consultation was not completed.', CLOSURE_TIMEOUT, true)
      }

      const turn = Number(turnEnd.data?.turn)
      const seq = Number(turnEnd.seq)
      const kind = kindOf(turnEnd) ?? 'unknown'
      const closure: AdvisorTurnClosure = { turn: Number.isSafeInteger(turn) ? turn : -1, seq: Number.isSafeInteger(seq) ? seq : -1, kind }
      // The verdict channel is the only authoritative source. Publishing is
      // reconciled against THIS turn's closing boundary, so a verdict submitted
      // in a turn that did not close `completed` is never published.
      const reconciled = lifecycle.collector.reconcile(collectorId, { stopReason: kind, turnEnd: { seq: closure.seq, kind } })
      if (!reconciled.published) {
        if (kind !== 'completed') {
          const facts = reasonFacts(turnEnd)
          throw new AdvisorUnavailableError('Advisor turn ' + closure.turn + ' closed with ' + kind + ' (' + facts + '); it published no verdict.', TURN_NOT_COMPLETED, kind !== 'aborted' && TRANSIENT_PATTERN.test(facts))
        }
        throw new AdvisorUnavailableError('Advisor returned no usable verdict: ' + reconciled.reason, NO_VERDICT)
      }
      published = true
      return { verdict: reconciled.verdict, childSessionId: conversationId, consultationId, collectorId, lastSeq: requesterSeq(parent), ...usageOfTurn(ctx, conversationId, closure.turn) }
    } finally {
      callSignal.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    if (error instanceof AdvisorUnavailableError) throw error
    if (signal.aborted) throw new AdvisorUnavailableError(signal.reason?.name === 'TimeoutError' ? timeoutMessage : 'Advisor request cancelled.', 'cancelled')
    if (callSignal.aborted) throw new AdvisorUnavailableError(timeoutMessage, 'timeout', true)
    const message = error instanceof Error ? error.message : String(error)
    throw new AdvisorUnavailableError('Unable to run Advisor: ' + message, START_REJECTED, TRANSIENT_PATTERN.test(message))
  } finally {
    // Per-turn cleanup on EVERY exit path, including throws: the listeners, the
    // deadline and the abort hook all belong to this turn alone. The child itself
    // is left to the continuation manager, which cold-resumes it on the next
    // delivery — this module never disposes it.
    stopObserve()
    observed?.dispose()
    deadline.dispose()
    identity.release()
    // A turn that did not publish leaves a record a late verdict submission
    // resolves to 'closed' against instead of reviving it. The record is keyed by
    // THIS turn's own collector identity, so releasing it can only drop this
    // turn's child index — never the index of a turn that is still live. A turn
    // that never reached its own `bind` has no index of its own to drop.
    if (!published) lifecycle.collector.invalidate(collectorId, 'Advisor turn ended without publishing a verdict.')
    if (boundChild) lifecycle.collector.release(collectorId)
  }
}
