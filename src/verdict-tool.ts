import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { redactSecrets } from './redact.js'
import { verdictFromStructured, type AdvisorVerdict } from './verdict.js'
import type { AdvisorRegistry } from './registry.js'

/**
 * The Advisor's own verdict channel.
 *
 * The continuable subagent path has no structured-output feature: `outputSchema`
 * is excluded from `ContinuableStartSpec.request` at the type level, and the
 * structured runtime is attached only by the one-shot driver. A plugin that owns
 * a multi-turn Advisor must therefore own the verdict contract as well.
 *
 * This module is that contract. The tool is registered host-wide (so the child
 * inherits it) BEFORE any child is started or resumed, because `tools.restrict()`
 * throws on an unknown tool name and the child's allow-list names this tool.
 *
 * A submission through this tool is a CANDIDATE verdict, never a final one. It is
 * published to consumers only after reconciliation with a verified successful
 * terminal outcome for the turn it was submitted in.
 */
export const ADVISOR_VERDICT_TOOL = 'advisor_verdict'

/** Implicit-open parameter root; requiredness is a per-property annotation. */
export const VERDICT_TOOL_PARAMETERS = {
  severity: { type: 'string', required: true, enum: ['none', 'nit', 'concern', 'blocker'] },
  disposition: { type: 'string', required: true },
  summary: { type: 'string', required: true },
  diagnosis: { type: 'string', required: true },
  next_actions: { type: 'array', required: true, items: { type: 'string' } },
  evidence_used: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', required: true }, reference: { type: 'string', required: true } },
    },
  },
  assumptions: { type: 'array', required: true, items: { type: 'string' } },
  recommended_next_action: { type: 'string', required: true },
  validation_plan: { type: 'array', required: true, items: { type: 'string' } },
  needs_more_evidence: { type: 'boolean', required: true },
  confidence: { type: 'number', required: true },
  changes_made: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: { type: 'array', required: true, items: { type: 'string' } },
        reason: { type: 'string', required: true },
        validation: { type: 'array', required: true, items: { type: 'string' } },
      },
    },
  },
} as const

export interface VerdictCandidate {
  readonly verdict: AdvisorVerdict
  /** Advisor turn the submission was made in. */
  readonly turn: number
  /** Child session seq at submission; reconciliation requires a later terminal event. */
  readonly seq: number
  readonly at: number
}

export type ConsultationState = 'open' | 'candidate' | 'published' | 'invalidated'

export interface Consultation {
  readonly id: string
  readonly invocationId: string
  readonly requesterId: string
  readonly rootId: string
  readonly openedAt: number
  childSessionId?: string
  state: ConsultationState
  candidate?: VerdictCandidate
  /** Trusted reason a submission was refused, kept for diagnostics. */
  refusal?: string
}

export type SubmitOutcome = 'accepted' | 'duplicate' | 'conflicting' | 'unmatched' | 'closed' | 'unauthorized'

export interface TerminalEvidence {
  /** Run stop reason reported by the transport. */
  readonly stopReason: string
  /** The child's closing turn boundary, if the session recorded one. */
  readonly turnEnd?: { readonly seq: number; readonly kind: string }
  /** The turn the delivered message was claimed in; must match the candidate turn. */
  readonly turn?: number
  /** The claimed inbox message id for this delivery. */
  readonly messageId?: string
  /** The authorized delivery message id; when both are known they must match. */
  readonly authorizedMessageId?: string
}

export type ReconcileOutcome =
  | { readonly published: true; readonly verdict: AdvisorVerdict; readonly candidate: VerdictCandidate }
  | { readonly published: false; readonly reason: string }

function turnOf(agent: Agent): number {
  const ending = agent.session.snapshotEvents().findLast(event => event.type === 'step/start')
  return ending?.type === 'step/start' ? ending.data.turn : 0
}

/**
 * Consultation records for the verdict channel, keyed by host-generated
 * consultation id and indexed by child session.
 *
 * Correlation is never taken from the model: the child session is resolved from
 * the live calling agent, and the invocation identity is checked against the
 * registry's host-created record.
 */
export class AdvisorVerdictCollector {
  private readonly consultations = new Map<string, Consultation>()
  private readonly byChild = new Map<string, string>()

  constructor(private readonly clock: () => number = () => Date.now()) {}

  open(input: { id: string; invocationId: string; requesterId: string; rootId: string }): Consultation {
    this.prune(this.clock())
    const consultation: Consultation = { ...input, openedAt: this.clock(), state: 'open' }
    this.consultations.set(consultation.id, consultation)
    return consultation
  }

  /** Attach the child session once the transport has established it. */
  bind(id: string, childSessionId: string): void {
    const consultation = this.consultations.get(id)
    if (!consultation) return
    consultation.childSessionId = childSessionId
    this.byChild.set(childSessionId, id)
  }

  get(id: string): Consultation | undefined {
    return this.consultations.get(id)
  }

  forChild(childSessionId: string): Consultation | undefined {
    const id = this.byChild.get(childSessionId)
    return id === undefined ? undefined : this.consultations.get(id)
  }

  list(): Consultation[] {
    return [...this.consultations.values()]
  }

  /**
   * Record a candidate verdict from an Advisor child.
   *
   * Refuses submissions that do not belong to an open consultation, and refuses a
   * second submission that conflicts with the first rather than overwriting it.
   */
  submit(
    agent: Agent,
    identity: { invocationId: string; requesterId: string },
    verdict: AdvisorVerdict,
  ): SubmitOutcome {
    const consultation = this.forChild(String(agent.id))
    if (!consultation) return 'unmatched'
    if (consultation.invocationId !== identity.invocationId || consultation.requesterId !== identity.requesterId) return 'unauthorized'
    if (consultation.state === 'published' || consultation.state === 'invalidated') return 'closed'
    const candidate: VerdictCandidate = { verdict, turn: turnOf(agent), seq: agent.session.seq, at: Date.now() }
    const existing = consultation.candidate
    if (existing) {
      const same = JSON.stringify(existing.verdict) === JSON.stringify(candidate.verdict) && existing.turn === candidate.turn
      if (same) return 'duplicate'
      consultation.refusal = 'Conflicting second verdict for the same consultation.'
      return 'conflicting'
    }
    consultation.candidate = candidate
    consultation.state = 'candidate'
    return 'accepted'
  }

  /**
   * Publish the candidate only against a verified successful terminal outcome that
   * post-dates the submission. Inbox acceptance, quiescence and a pre-close
   * boundary are not terminal evidence on their own.
   */
  reconcile(id: string, evidence: TerminalEvidence): ReconcileOutcome {
    const consultation = this.consultations.get(id)
    if (!consultation) return { published: false, reason: 'Unknown consultation.' }
    if (consultation.state === 'published') return { published: false, reason: 'Consultation already published.' }
    const candidate = consultation.candidate
    if (!candidate) return { published: false, reason: 'The Advisor returned no verdict tool call.' }
    if (evidence.stopReason !== 'completed') return { published: false, reason: 'Advisor run ended with ' + evidence.stopReason + '.' }
    const ending = evidence.turnEnd
    if (!ending) return { published: false, reason: 'The Advisor session recorded no closing turn boundary.' }
    if (ending.seq < candidate.seq) return { published: false, reason: 'The closing turn boundary predates the submitted verdict.' }
    if (ending.kind !== 'completed') return { published: false, reason: 'The Advisor turn closed with ' + ending.kind + '.' }
    if (evidence.turn !== undefined && evidence.turn !== candidate.turn) return { published: false, reason: 'The closing turn does not match the turn that submitted the verdict.' }
    if (evidence.messageId !== undefined && evidence.authorizedMessageId !== undefined && evidence.messageId !== evidence.authorizedMessageId) return { published: false, reason: 'The closed turn did not claim the authorized delivery.' }
    consultation.state = 'published'
    return { published: true, verdict: candidate.verdict, candidate }
  }

  /** Mark a consultation unusable so a later late submission cannot be published. */
  invalidate(id: string, reason: string): void {
    const consultation = this.consultations.get(id)
    if (!consultation || consultation.state === 'published') return
    consultation.state = 'invalidated'
    consultation.refusal = reason
  }

  /**
   * Drop ONE record and the child index it created.
   *
   * A turn's record is its own: the index is removed only when it still points to
   * the record being released, so releasing a finished turn — or a turn that never
   * bound anything — can never clear the index of a turn that is live. Successive
   * turns of one durable child therefore each resolve to their own record, and the
   * consultation id stays single-use per turn.
   */
  release(id: string): void {
    const consultation = this.consultations.get(id)
    if (consultation?.childSessionId !== undefined && this.byChild.get(consultation.childSessionId) === id) this.byChild.delete(consultation.childSessionId)
    this.consultations.delete(id)
  }

  /**
   * Bound record growth. Consultations awaiting reconciliation are never pruned.
   */
  private prune(now: number): void {
    if (this.consultations.size < 64) return
    for (const [id, consultation] of [...this.consultations]) {
      if (consultation.state === 'open' || consultation.state === 'candidate') continue
      if (now - consultation.openedAt < 600_000) continue
      this.release(id)
    }
  }
}

export interface VerdictToolDeps {
  readonly registry: AdvisorRegistry
  readonly collector: AdvisorVerdictCollector
}

/**
 * Register the verdict channel host-wide.
 *
 * Must run before any Advisor child is composed, because the child's allow-list
 * names this tool and `tools.restrict()` rejects unknown names.
 */
export function registerAdvisorVerdictTool(ctx: Context, deps: VerdictToolDeps): void {
  ctx.tools.register(defineTool({
    name: ADVISOR_VERDICT_TOOL,
    description: 'Submit the Advisor verdict for the active consultation. Call this exactly once per turn, after the review is complete. Arguments are validated before this handler runs; an accepted submission is a candidate verdict and is published only once the turn closes successfully.',
    parameters: VERDICT_TOOL_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true }, message: { type: 'string', required: true } },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(raw: unknown, exec: ToolRunContext) {
      const agent = exec.agent
      if (!agent) return { accepted: false, message: 'The Advisor verdict channel is not available outside an agent scope.' }
      const identity = deps.registry.identity(agent)
      if (!identity) return { accepted: false, message: 'The Advisor verdict channel is available to Advisor sessions only.' }
      const verdict = verdictFromStructured(raw, JSON.stringify(raw ?? {}))
      const outcome = deps.collector.submit(agent, identity, verdict)
      const message = outcome === 'accepted'
        ? 'Verdict recorded as a candidate; it is published only if this turn closes successfully.'
        : outcome === 'duplicate'
          ? 'Verdict already recorded for this consultation; the first submission stands.'
          : outcome === 'conflicting'
            ? 'A verdict was already recorded for this consultation; a conflicting second submission is refused.'
            : outcome === 'closed'
              ? 'The consultation is closed; the verdict was not recorded.'
              : outcome === 'unauthorized'
                ? 'The verdict does not match the active consultation identity.'
                : 'No active consultation is bound to this session.'
      return { accepted: outcome === 'accepted' || outcome === 'duplicate', message: redactSecrets(message) }
    },
  }))
}
