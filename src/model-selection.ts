import { SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type { Config } from './config.js'

export interface AdvisorModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'advisor/model': { version: 1; selection: AdvisorModelSelection | null }
  }
}

const selections = new WeakMap<Session, { offset: number; selection: AdvisorModelSelection | null }>()

export function parseModelSelection(value: unknown): AdvisorModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Advisor model selection')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('Unknown Advisor model field')
  const text = (key: string) => {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error(`Invalid Advisor ${key}`)
    return value.trim()
  }
  return { provider: text('provider'), model: text('model'), ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: text('reasoningEffort') }) }
}

export function sessionModelSelection(session: Session): AdvisorModelSelection | null {
  const cached = selections.get(session) ?? { offset: 0, selection: null }
  for (const event of session.snapshotEvents(SessionLogOffset(cached.offset))) {
    if (event.type !== 'advisor/model' || event.data?.version !== 1) continue
    if (event.data.selection === null) cached.selection = null
    else {
      try { cached.selection = parseModelSelection(event.data.selection) } catch { /* Retain the last valid selection. */ }
    }
  }
  cached.offset = session.seq
  selections.set(session, cached)
  return cached.selection
}

export function configuredModel(config: Config): AdvisorModelSelection {
  return { provider: config.provider.trim(), model: config.model.trim(), ...(config.reasoningEffort.trim() ? { reasoningEffort: config.reasoningEffort.trim() } : {}) }
}

export function advisorModelConfig(config: Config, root: Session): Config {
  const selection = sessionModelSelection(root) ?? configuredModel(config)
  return { ...config, ...selection, reasoningEffort: selection.reasoningEffort ?? '' }
}

export function updateModelSelection(session: Session, selection: AdvisorModelSelection | null): void {
  session.append('advisor/model', { version: 1, selection: selection === null ? null : parseModelSelection(selection) })
}
