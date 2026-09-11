import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions { advisorInvocation?: string }
}

export interface AdvisorIdentity {
  version: 1
  invocationId: string
  advisorId: string
  requesterId: string
  rootId: string
  allowedTools: string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'advisor/identity': AdvisorIdentity }
}

/** Host-created identities; presentation labels never convey authority. */
export class AdvisorRegistry {
  private readonly identities = new Map<string, AdvisorIdentity>()
  private readonly pending = new Map<string, Omit<AdvisorIdentity, 'advisorId'>>()
  /**
   * Nonces already spent on one Advisor child. A continuable child is a DURABLE
   * session: `agent.options.advisorInvocation` keeps the nonce of the turn that
   * first materialized it, so a later turn of the same conversation re-attaches
   * with a spent nonce. Without this, that stale nonce would be resolved as this
   * turn's identity and every later turn would carry the FIRST turn's invocation
   * id — which the verdict channel, bound to the live turn, must refuse.
   */
  private readonly consumed = new Set<string>()

  private readonly activations = new Map<string, { invocationId: string; collectorId: string; messageId?: string; turn?: number; expiresAt: number; taintedTurns?: Set<number> }>()
  private readonly pendingByInvocation = new Map<string, { collectorId: string; childSessionId?: string; expiresAt: number }>()

  constructor(private readonly ctx: Context) {
    for (const agent of ctx.agents.list()) this.attach(agent)
    ctx.on('agent/created', ({ agent }) => this.attach(agent))
    ctx.on('agent/disposed', ({ agent }) => {
      const id = String(agent.id)
      if (this.identities.get(id) !== undefined) this.identities.delete(id)
      if (this.activations.get(id) !== undefined) this.activations.delete(id)
    })
  }

  /**
   * Authorize exactly one Advisor turn. Reserve BEFORE dispatch (child may be
   * unknown for a fresh start), then bind the concrete child + delivered
   * message id once the transport resolves. Pre-step admits an Advisor agent
   * only while a matching, unexpired activation exists.
   */
  authorizeTurn(input: { invocationId: string; collectorId: string; childSessionId?: string; ttlMs: number }): void {
    const expiresAt = Date.now() + Math.max(1, input.ttlMs)
    this.pendingByInvocation.set(input.invocationId, { collectorId: input.collectorId, ...(input.childSessionId === undefined ? {} : { childSessionId: input.childSessionId }), expiresAt })
    if (input.childSessionId !== undefined) {
      // Never clobber a live activation of an overlapping turn on the same
      // child: the overlap keeps the older binding and this turn proceeds on
      // its pending reservation until it can bind (see bindTurn/isTurnAuthorized).
      const current = this.activations.get(input.childSessionId)
      if (current !== undefined && current.invocationId !== input.invocationId && current.expiresAt > Date.now()) return
      this.activations.set(input.childSessionId, { invocationId: input.invocationId, collectorId: input.collectorId, expiresAt })
    }
  }

  /** Bind the delivered message to this turn's activation. Fails closed (false)
   * without a live pending reservation instead of manufacturing authority;
   * refuses a child that contradicts the reservation and never clobbers a live
   * foreign binding. Repeating the identical binding preserves the claimed turn. */
  bindTurn(input: { invocationId: string; childSessionId: string; messageId: string }): boolean {
    const pending = this.pendingByInvocation.get(input.invocationId)
    if (pending === undefined || pending.expiresAt <= Date.now()) return false
    if (pending.childSessionId !== undefined && pending.childSessionId !== input.childSessionId) return false
    const current = this.activations.get(input.childSessionId)
    if (current !== undefined && current.invocationId !== input.invocationId && current.expiresAt > Date.now()) return false
    if (current !== undefined && current.invocationId === input.invocationId && current.messageId === input.messageId) return true
    this.activations.set(input.childSessionId, {
      invocationId: input.invocationId,
      collectorId: pending.collectorId,
      messageId: input.messageId,
      expiresAt: pending.expiresAt,
    })
    this.pendingByInvocation.set(input.invocationId, { ...pending, childSessionId: input.childSessionId })
    return true
  }

  /** Mark turns that claimed other messages in this child during the window.
   * A turn that ran on a competing delivery is never this turn, even if it
   * stepped before the authorized binding landed. Taint dies with the activation. */
  noteForeignTurn(childSessionId: string, turn: number): void {
    const current = this.activations.get(childSessionId)
    if (current === undefined) return
    let tainted = current.taintedTurns
    if (tainted === undefined) { tainted = new Set(); current.taintedTurns = tainted }
    tainted.add(turn)
  }

  /** Record the claimed turn once the observer maps the delivered message to a turn. */
  noteClaimedTurn(childSessionId: string, messageId: string, turn: number): void {
    const current = this.activations.get(childSessionId)
    if (current === undefined || current.messageId !== messageId) return
    this.activations.set(childSessionId, { ...current, turn })
  }

  /** The smallest authority the gate ever consults: exact invocation, expiry,
   * claimed-turn binding, foreign-turn taint, and — once the delivery is bound —
   * batch purity (every entering message must be the authorized delivery). */
  static stepAdmits(
    activation: { invocationId: string; messageId?: string; turn?: number; expiresAt: number; taintedTurns?: Set<number> },
    invocationId: string,
    turn: number | undefined,
    messageIds: readonly string[],
  ): boolean {
    if (activation.invocationId !== invocationId) return false
    if (activation.expiresAt <= Date.now()) return false
    if (turn !== undefined && activation.taintedTurns?.has(turn) === true) return false
    if (activation.turn !== undefined && turn !== undefined && activation.turn !== turn) return false
    // Message ids are stable across every representation boundary, so the batch
    // entering the model step must be exactly the authorized delivery once it is
    // known. An empty batch (a step carrying no new input) falls back to the
    // turn binding above instead of failing steps that consume prior context.
    if (activation.messageId !== undefined && messageIds.length > 0) {
      if (!messageIds.every(id => id === activation.messageId)) return false
    }
    // A pre-bind activation admits the nonce-bearing child: the authorized first
    // step routinely precedes dispatch binding in this runtime (measured: making
    // this fail-closed breaks real consultations because rejections are
    // destructive, not retried). Removing the window needs a host transport that
    // pre-allocates the delivery id; until then the nonce — host-minted,
    // requester-bound, single-spend, TTL-bounded — is the pre-bind authority.
    return true
  }

  /** True only for the exact authorized turn: child + invocation + expiry, and turn when known. */
  isTurnAuthorized(childSessionId: string, invocationId: string, turn?: number, messageIds: readonly string[] = []): boolean {
    const current = this.activations.get(childSessionId)
    if (current !== undefined) return AdvisorRegistry.stepAdmits(current, invocationId, turn, messageIds)
    // Pre-bind window of a fresh start: the child exists (its identity carries
    // this turn's unforgeable invocation nonce) but dispatch has not resolved,
    // so bindTurn has not run yet. The pending reservation exists only between
    // reserve and revoke of a genuine callAdvisor turn; a direct prompt never
    // creates one. Descendant steps are still refused by the caller. Once the
    // concrete child is bound, unknown children are no longer admitted through
    // the pending reservation.
    const pending = this.pendingByInvocation.get(invocationId)
    if (pending !== undefined && pending.expiresAt > Date.now()) {
      // A follow-up reservation names its child: only that child is admitted.
      // A fresh reservation names none (the child does not exist yet), so any
      // child presenting this invocation is admitted — safe because the nonce is
      // host-minted, bound to the exact requester, and spendable exactly once:
      // only the genuine child can carry it, and a direct prompt never creates
      // a reservation at all.
      if (pending.childSessionId !== undefined && pending.childSessionId !== childSessionId) return false
      let bound = false
      for (const activation of this.activations.values()) {
        if (activation.invocationId === invocationId) { bound = true; break }
      }
      if (!bound) return true
    }
    return false
  }

  activationFor(childSessionId: string): { invocationId: string; collectorId: string; messageId?: string; turn?: number; expiresAt: number; taintedTurns?: Set<number> } | undefined {
    return this.activations.get(childSessionId)
  }

  revokeTurn(childSessionId: string, invocationId?: string): void {
    const current = this.activations.get(childSessionId)
    if (current === undefined) {
      if (invocationId !== undefined) {
        for (const [child, activation] of [...this.activations]) {
          if (activation.invocationId === invocationId) this.activations.delete(child)
        }
        this.pendingByInvocation.delete(invocationId)
      }
      return
    }
    // A stale cleanup for another invocation must neither clear the live binding
    // nor drop that invocation's own pending reservation (which may be mid-dispatch
    // on a different child); revocation is always scoped by exact invocation match.
    if (invocationId !== undefined && current.invocationId !== invocationId) return
    this.activations.delete(childSessionId)
    this.pendingByInvocation.delete(current.invocationId)
  }

  reserve(requester: Agent, root: Agent, allowedTools: string[]) {
    const invocationId = randomUUID()
    const identity: Omit<AdvisorIdentity, 'advisorId'> = { version: 1, invocationId, requesterId: String(requester.id), rootId: String(root.id), allowedTools: [...allowedTools] }
    this.pending.set(invocationId, identity)
    return { invocationId, release: () => this.pending.delete(invocationId) }
  }

  private attach(agent: Agent): void {
    const parentId = agent.session.header.parentSession
    const nonce = agent.options.advisorInvocation
    // A nonce is spendable exactly once: the second attach of the same child with a
    // nonce already spent falls through to the session log, which holds the
    // identity of the turn that is actually live.
    const pending = nonce === undefined || this.consumed.has(nonce) ? undefined : this.pending.get(nonce)
    let identity = pending?.requesterId === String(parentId) ? { ...pending, advisorId: String(agent.id) } : undefined
    if (identity && nonce) { this.pending.delete(nonce); this.consumed.add(nonce) }
    // A custom tool may create a child outside the known delegation tool names.
    // Such descendants still inherit the original requesting agent's ceiling.
    if (!identity && parentId !== undefined) identity = this.identities.get(String(parentId))
    if (identity) {
      this.identities.set(String(agent.id), identity)
      agent.session.append('advisor/identity', identity)
      this.restrict(agent, identity)
      return
    }
    // Read once on activation/restoration, never scan a log per tool execution.
    // A durable Advisor child keeps the identity of the turn that materialized it,
    // so this is also the state a re-attached child is in until the turn that owns
    // it re-keys it with `ensureTurnIdentity`.
    for (const event of agent.session.snapshotEvents()) {
      if (event.type !== 'advisor/identity') continue
      const data = event.data
      if (data?.version === 1 && typeof data.invocationId === 'string' && typeof data.requesterId === 'string'
        && typeof data.rootId === 'string' && Array.isArray(data.allowedTools) && data.allowedTools.every(name => typeof name === 'string')) {
        this.identities.set(String(agent.id), { ...data, advisorId: typeof data.advisorId === 'string' ? data.advisorId : '' })
      }
    }
    const restored = this.identities.get(String(agent.id))
    if (restored) this.restrict(agent, restored)
  }

  /**
   * Bind the CURRENT turn's invocation to an already materialized Advisor child.
   *
   * A continuable child is durable, so the nonce it was first created with is
   * spent and will not be handed out again: without this the child would keep
   * reporting the identity of its FIRST turn, and the verdict channel — which is
   * bound to the turn that is live — would refuse every later turn's submission as
   * unauthorized. Only the invocation id is replaced; the requester, root and
   * tool ceiling stay the identity of the conversation the child belongs to.
   */
  ensureTurnIdentity(agent: Agent, invocationId: string): void {
    const current = this.identities.get(String(agent.id))
    if (!current || current.invocationId === invocationId) return
    const identity: AdvisorIdentity = { ...current, invocationId }
    this.identities.set(String(agent.id), identity)
    agent.session.append('advisor/identity', identity)
    // The new identity must not be treated as a fresh third-party one.
    this.consumed.add(invocationId)
  }

  private restrict(agent: Agent, identity: AdvisorIdentity): void {
    this.ctx.effect(function* () {
      // Advisor children have a small, explicit tool surface. Native schemas are
      // materially smaller than the inherited PTC SDK and let the model call the
      // same permitted tools without carrying the parent's run_code manual.
      yield agent.ctx.tools.presentAs('native')
      yield agent.ctx.tools.restrict({ allow: identity.allowedTools.filter(name => name !== 'run_code') })
    }, 'advisor: native descendant tool ceiling')
  }

  identity(agent: Agent): AdvisorIdentity | undefined { return this.identities.get(String(agent.id)) }
  requester(agent: Agent): Agent | undefined {
    const identity = this.identity(agent)
    return identity ? this.ctx.agents.get(SessionId(identity.requesterId)) : undefined
  }
  clearRoot(rootId: string): void {
    // Collect root-owned children BEFORE identities are dropped: activations
    // consult identity scope, so the lookup must precede the deletion.
    const owned = new Set<string>()
    for (const [id, identity] of this.identities) if (identity.rootId === rootId) owned.add(id)
    const ownedInvocations = new Set<string>()
    for (const id of owned) {
      const identity = this.identities.get(id)
      if (identity) ownedInvocations.add(identity.invocationId)
    }
    for (const [id, identity] of this.identities) if (identity.rootId === rootId) this.identities.delete(id)
    for (const [id, identity] of this.pending) if (identity.rootId === rootId) this.pending.delete(id)
    for (const [child, activation] of [...this.activations]) {
      if (owned.has(child) || ownedInvocations.has(activation.invocationId)) this.activations.delete(child)
      else if (activation.expiresAt <= Date.now()) this.activations.delete(child)
    }
    for (const [invocation] of [...this.pendingByInvocation]) {
      if (ownedInvocations.has(invocation)) { this.pendingByInvocation.delete(invocation); continue }
      let live = false
      for (const identity of this.identities.values()) if (identity.invocationId === invocation) { live = true; break }
      if (!live) this.pendingByInvocation.delete(invocation)
    }
    this.pruneConsumed()
  }

  /** Drop consumed markers that no longer correspond to a live identity. */
  pruneConsumed(): void {
    const live = new Set([...this.identities.values()].map(identity => identity.invocationId))
    for (const nonce of [...this.consumed]) {
      if (!live.has(nonce) && !this.pending.has(nonce) && !this.pendingByInvocation.has(nonce)) this.consumed.delete(nonce)
    }
  }
}