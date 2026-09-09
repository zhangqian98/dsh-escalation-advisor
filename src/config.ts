import z from '@deepseek-ai/schemastery'

export const ADVISOR_MODES = ['manual', 'escalate', 'continuous'] as const
export type AdvisorMode = (typeof ADVISOR_MODES)[number]
export const SEVERITIES = ['none', 'nit', 'concern', 'blocker'] as const
export type AdvisorSeverity = (typeof SEVERITIES)[number]
export const TOOL_PRESETS = ['none', 'inspect', 'research', 'edit', 'custom'] as const
export type AdvisorToolPreset = (typeof TOOL_PRESETS)[number]
export const WAIT_MODES = ['block', 'background'] as const
export type AdvisorWaitMode = (typeof WAIT_MODES)[number]

export interface Config {
  enabled: boolean
  mode: AdvisorMode
  provider: string
  model: string
  subagentProvider: string
  defaultToolPreset: AdvisorToolPreset
  defaultCustomTools: string[]
  escalationWait: AdvisorWaitMode
  continuousWait: AdvisorWaitMode
  maxInputBytes: number
  maxOutputTokens: number
  timeoutMs: number
  maxManualConsultsPerSession: number
  scoreThreshold: number
  toolErrorWeight: number
  repeatedFailureWeight: number
  nonZeroExitWeight: number
  repeatedMutationWeight: number
  repeatedMutationCount: number
  maxAutoConsultsPerTurn: number
  maxAutoConsultsPerProblem: number
  cooldownTurns: number
  continuousMinSeverity: AdvisorSeverity
  injectNits: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  mode: z.union([...ADVISOR_MODES]).default('escalate'),
  provider: z.string().default(''),
  model: z.string().default(''),
  subagentProvider: z.string().default('spawn'),
  defaultToolPreset: z.union([...TOOL_PRESETS]).default('inspect'),
  defaultCustomTools: z.array(String).default([]),
  escalationWait: z.union([...WAIT_MODES]).default('block'),
  continuousWait: z.union([...WAIT_MODES]).default('background'),
  maxInputBytes: z.number().step(1).min(4096).max(131072).default(24576),
  maxOutputTokens: z.number().step(1).min(128).max(32768).default(2048),
  timeoutMs: z.number().step(1).min(1000).max(600000).default(120000),
  maxManualConsultsPerSession: z.number().step(1).min(0).max(100).default(8),
  scoreThreshold: z.number().step(1).min(1).max(100).default(4),
  toolErrorWeight: z.number().step(1).min(0).max(20).default(2),
  repeatedFailureWeight: z.number().step(1).min(0).max(20).default(3),
  nonZeroExitWeight: z.number().step(1).min(0).max(20).default(1),
  repeatedMutationWeight: z.number().step(1).min(0).max(20).default(2),
  repeatedMutationCount: z.number().step(1).min(2).max(20).default(3),
  maxAutoConsultsPerTurn: z.number().step(1).min(0).max(10).default(1),
  maxAutoConsultsPerProblem: z.number().step(1).min(0).max(10).default(1),
  cooldownTurns: z.number().step(1).min(0).max(100).default(1),
  continuousMinSeverity: z.union([...SEVERITIES]).default('concern'),
  injectNits: z.boolean().default(true),
})

export function routeConfigured(config: Config): boolean {
  return config.enabled && config.provider.trim().length > 0 && config.model.trim().length > 0
}

export function severityRank(severity: AdvisorSeverity): number {
  return SEVERITIES.indexOf(severity)
}
