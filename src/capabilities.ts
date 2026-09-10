/** These tools can create fresh execution scopes and are never Advisor capabilities. */
export const CAPABILITY_AMPLIFIERS = new Set([
  'consult_advisor', 'subagent', 'subagent_fork', 'subagent_control', 'workflow', 'ralph',
])

export function isReservedTool(name: string, extra: readonly string[] = []): boolean {
  return extra.includes(name) || CAPABILITY_AMPLIFIERS.has(name) || /(?:^|__)(?:subagent(?:[_-].*)?|workflow(?:[_-].*)?|ralph)$/.test(name)
}

const DELEGATION_PLUGINS = new Set(['tool-subagent', 'tool-subagent-control', 'tool-subagent-fork', 'tool-workflow', 'tool-ralph'])
/** Trusted Cordis plugin metadata tracks DSH toolName aliases, including live config updates. */
export function isCapabilityAmplifier(ctx: Context, name: string, extra: readonly string[] = []): boolean {
  if (isReservedTool(name, extra)) return true
  for (const runtime of ctx.registry.values()) {
    const pluginName = runtime.name?.replace(/^@deepseek-ai\/dsh-/, '') ?? ''
    if (!DELEGATION_PLUGINS.has(pluginName)) continue
    for (const fiber of runtime.fibers) if (fiber.uid !== null && fiber.config?.toolName === name) return true
  }
  return false
}

const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'])
export type ToolEffect = 'read-only' | 'mutating' | 'unknown'
export function toolEffect(name: string, readOnlyTools: readonly string[] = [], mutatingTools: readonly string[] = []): ToolEffect {
  if (mutatingTools.includes(name) || /^(?:edit|write|apply_patch|replace|delete|move|rename|bash|pwsh|shell|exec_command)$/.test(name)) return 'mutating'
  if (READ_ONLY_TOOLS.has(name) || readOnlyTools.includes(name)) return 'read-only'
  return 'unknown'
}
import type { Context } from '@deepseek-ai/cordis'
