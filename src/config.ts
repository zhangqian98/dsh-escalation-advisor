import z from '@deepseek-ai/schemastery'
import { parseAdvisorProfiles, parseProfileRoutes, type AdvisorProfile, type ProfileRouteTable } from './profiles.js'

export const ADVISOR_MODES = ['manual', 'escalate', 'continuous'] as const
export type AdvisorMode = (typeof ADVISOR_MODES)[number]
export const ADVISOR_TRIGGERS = ['manual', 'escalation', 'completion', 'continuous'] as const
export type AdvisorTrigger = (typeof ADVISOR_TRIGGERS)[number]
export const SEVERITIES = ['none', 'nit', 'concern', 'blocker'] as const
export type AdvisorSeverity = (typeof SEVERITIES)[number]
export const WAIT_MODES = ['block', 'background'] as const
export type AdvisorWaitMode = (typeof WAIT_MODES)[number]
export const DEFAULT_TIMEOUT_MS = 600000
export const MIN_TIMEOUT_MS = 1000
export const MAX_TIMEOUT_MS = 3600000
export function isAdvisorTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS
}

/** Conservative defaults: repository inspection is on; every other tool starts off. */
export const DEFAULT_ENABLED_TOOLS = ['read', 'read_image', 'glob', 'grep'] as const

export interface Config {
  enabled: boolean
  mode: AdvisorMode
  provider: string
  model: string
  /** Empty uses the selected model's own reasoning default. */
  reasoningEffort: string
  subagentProvider: string
  /** Exact tool names enabled by default for sessions that have no per-tool override. */
  defaultEnabledTools: string[]
  /** Unknown effects require exclusive blocking execution. */
  readOnlyTools: string[]
  mutatingTools: string[]
  retryDelayMs: number
  capabilityAmplifierTools: string[]
  /** Whether the root/main agent can explicitly call consult_advisor. */
  manualMainAgent: boolean
  /** Whether local DSH subagents can explicitly call consult_advisor. */
  manualLocalSubagents: boolean
  /** Whether automatic escalation scoring runs for the root/main agent. */
  escalationMainAgent: boolean
  /** Whether automatic escalation scoring runs for local DSH subagents. */
  escalationLocalSubagents: boolean
  /** Whether continuous shadow review runs for the root/main agent. */
  continuousMainAgent: boolean
  /** Whether continuous shadow review runs for local DSH subagents. Off by default to control cost. */
  continuousLocalSubagents: boolean
  escalationWait: AdvisorWaitMode
  continuousWait: AdvisorWaitMode
  timeoutMs: number
  /** Per-agent explicit consultation budget. A negative value means no limit. */
  maxManualConsultsPerSession: number
  /** Shared strong-model consultation budget for the whole live root task tree. A negative value means no limit. */
  maxAdvisorConsultsPerTask: number
  /** Maximum simultaneous Advisor runs within one live root task tree. */
  maxConcurrentAdvisorRuns: number
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
  /** Whether completion (pre-delivery) review runs for the root/main agent. Off by default to preserve existing behavior. */
  completionMainAgent?: boolean
  /** Whether completion review runs for local subagents. Off by default; when on it blocks worker settlement. */
  completionLocalSubagents?: boolean
  /** Wait behavior for completion review. */
  completionWait?: AdvisorWaitMode
  /** Minimum severity that steers/blocks delivery. */
  completionMinSeverity?: AdvisorSeverity
  /** Max completion review cycles per delivery (1 = review once, then allow finish). */
  maxCompletionCycles?: number
  /** Max subagent depth Advisor covers (-1 = all depths). */
  localSubagentMaxDepth?: number
  /** When non-empty, only these subagent labels/personas are covered. */
  includeSubagentLabels?: string[]
  /** Subagent labels/personas never covered. */
  excludeSubagentLabels?: string[]
  /** Named strong-model profiles the requester may select from. */
  advisorProfiles?: AdvisorProfile[]
  /** Default profile id for new consultations (empty = first allowed). */
  defaultProfileId?: string
  /** Allowed profile ids for this task tree (empty = all configured profiles). */
  allowedProfileIds?: string[]
  /** Per-trigger default profile routing for NEW consultations. */
  profileRoutes?: ProfileRouteTable
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  mode: z.union([...ADVISOR_MODES]).default('escalate'),
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  subagentProvider: z.string().default('spawn'),
  defaultEnabledTools: z.array(String).default([...DEFAULT_ENABLED_TOOLS]),
  readOnlyTools: z.array(String).default([]),
  mutatingTools: z.array(String).default(['edit', 'write', 'bash', 'pwsh']),
  retryDelayMs: z.number().step(1).min(0).max(60000).default(1000),
  capabilityAmplifierTools: z.array(String).default([]),
  manualMainAgent: z.boolean().default(true),
  manualLocalSubagents: z.boolean().default(true),
  escalationMainAgent: z.boolean().default(true),
  escalationLocalSubagents: z.boolean().default(true),
  continuousMainAgent: z.boolean().default(true),
  continuousLocalSubagents: z.boolean().default(false),
  escalationWait: z.union([...WAIT_MODES]).default('block'),
  continuousWait: z.union([...WAIT_MODES]).default('background'),
  timeoutMs: z.number().step(1).min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  maxManualConsultsPerSession: z.number().step(1).min(-1).max(100).default(-1),
  maxAdvisorConsultsPerTask: z.number().step(1).min(-1).max(1000).default(-1),
  maxConcurrentAdvisorRuns: z.number().step(1).min(1).max(32).default(2),
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
  completionMainAgent: z.boolean().default(false),
  completionLocalSubagents: z.boolean().default(false),
  completionWait: z.union([...WAIT_MODES]).default('block'),
  completionMinSeverity: z.union([...SEVERITIES]).default('concern'),
  maxCompletionCycles: z.number().step(1).min(1).max(5).default(1),
  localSubagentMaxDepth: z.number().step(1).min(-1).max(32).default(-1),
  includeSubagentLabels: z.array(String).default([]),
  excludeSubagentLabels: z.array(String).default([]),
  advisorProfiles: z.any().default([]),
  defaultProfileId: z.string().default(''),
  allowedProfileIds: z.array(String).default([]),
  profileRoutes: z.any().default({}),
})
export function routeConfigured(config: Config): boolean {
  if (config.enabled !== true) return false;
  if (config.provider.trim().length > 0 && config.model.trim().length > 0) return true;
  try {
    const profiles = parseAdvisorProfiles((config as unknown as Record<string, unknown>).advisorProfiles);
    return profiles.some(profile => profile.provider.trim().length > 0 && profile.model.trim().length > 0);
  } catch { return false; }
}

export function severityRank(severity: AdvisorSeverity): number {
  return SEVERITIES.indexOf(severity)
}
