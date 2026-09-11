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

  constructor(private readonly ctx: Context) {
    for (const agent of ctx.agents.list()) this.attach(agent)
    ctx.on('agent/created', ({ agent }) => this.attach(agent))
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
    for (const [id, identity] of this.identities) if (identity.rootId === rootId) this.identities.delete(id)
    for (const [id, identity] of this.pending) if (identity.rootId === rootId) this.pending.delete(id)
  }
}
