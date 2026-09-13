import { SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import type { Config } from './config.js'

export interface AdvisorModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'advisor/model': { version: 1; selection: AdvisorModelSelection | null } | { version: 2; selection: AdvisorModelSelection | null; defaultProfileId?: string | null; allowedProfileIds?: string[] }
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
    if (event.type !== 'advisor/model') continue
    const data = event.data as unknown as Record<string, unknown>
    if (data?.version !== 1 && data?.version !== 2) continue
    const selection = (data as { selection?: unknown }).selection
    if (selection === null) cached.selection = null
    else {
      try { cached.selection = parseModelSelection(selection) } catch { /* Retain the last valid selection. */ }
    }
  }
  cached.offset = session.seq
  selections.set(session, cached)
  return cached.selection
}

export interface AdvisorProfileSelection {
  defaultProfileId: string | null
  allowedProfileIds: string[]
}

export function sessionProfileSelection(session: Session): AdvisorProfileSelection {
  let defaultProfileId: string | null = null
  let allowedProfileIds: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'advisor/model') continue
    const data = event.data as unknown as Record<string, unknown>
    if (data?.version !== 2) continue
    const rawDefault = (data as { defaultProfileId?: unknown }).defaultProfileId
    if (rawDefault === null || rawDefault === undefined) { if (rawDefault === null) defaultProfileId = null }
    else if (typeof rawDefault === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(rawDefault.trim())) defaultProfileId = rawDefault.trim()
    const rawAllowed = (data as { allowedProfileIds?: unknown }).allowedProfileIds
    if (Array.isArray(rawAllowed)) {
      const ids: string[] = []
      for (const raw of rawAllowed.slice(0, 32)) {
        if (typeof raw === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(raw.trim()) && !ids.includes(raw.trim())) ids.push(raw.trim())
      }
      allowedProfileIds = ids
    }
  }
  return { defaultProfileId, allowedProfileIds }
}

export function updateProfileSelection(session: Session, selection: AdvisorProfileSelection): void {
  const current = sessionModelSelection(session)
  session.append('advisor/model', {
    version: 2,
    selection: current,
    defaultProfileId: selection.defaultProfileId,
    allowedProfileIds: [...selection.allowedProfileIds],
  })
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
