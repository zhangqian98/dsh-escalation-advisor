import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm/message'
import { Config as ConfigSchema, type Config } from './config.js'

// Legacy source records remain readable; V4 writers use the producer-owned kind.
declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    plugin: { kind: 'plugin'; plugin: string } & ContextFormed
    'plugin:dsh-escalation-advisor': { kind: 'plugin:dsh-escalation-advisor' } & ContextFormed
  }
}

export const modernRuntime = Number(SESSION_FORMAT_VERSION) >= 4
export const PluginConfigSchema = modernRuntime ? ConfigSchema.volatile() : ConfigSchema
export type PluginConfigInput = Config | { get(): Readonly<Config> }

export function advisorMessageSource(summary: string): MessageSource {
  return modernRuntime
    ? { kind: 'plugin:dsh-escalation-advisor', form: 'notice', summary }
    : { kind: 'plugin', plugin: 'dsh-escalation-advisor', form: 'notice', summary }
}

export function isAdvisorSource(source: MessageSource): boolean {
  return source.kind === 'plugin:dsh-escalation-advisor'
    || (source.kind === 'plugin' && source.plugin === 'dsh-escalation-advisor')
}

/** Keep the live Config reference on V4; retain the legacy settings document API. */
export function advisorConfigReader(ctx: Context, input: PluginConfigInput): () => Config {
  if (modernRuntime) return () => 'get' in input ? structuredClone(input.get()) : input
  const settings = ctx.get('settings') as { register(ns: string, schema: typeof ConfigSchema, options: { base: Config }): { get(): Config } } | undefined
  if (!settings) throw new Error('Legacy DSH requires its settings service for Advisor')
  const reader = settings.register('escalation-advisor', ConfigSchema, { base: input as Config })
  return () => reader.get()
}

/** Both release families notify after their live configuration has committed. */
export function onAdvisorConfigChange(ctx: Context, refresh: () => void): void {
  // The legacy event is absent from V4 declarations; only these two fixed
  // version-specific names cross this adapter, never a caller-provided name.
  const listen = ctx.on.bind(ctx) as (name: string, listener: (...args: any[]) => void) => () => void
  if (modernRuntime) {
    listen('loader/volatile-update', refresh)
  } else {
    listen('settings/updated', (namespace: string) => { if (namespace === 'escalation-advisor') refresh() })
  }
}
