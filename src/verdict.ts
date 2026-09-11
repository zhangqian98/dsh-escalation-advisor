import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { AdvisorSeverity } from './config.js'
import { SEVERITIES } from './config.js'
import { redactSecrets, truncateUtf8 } from './redact.js'

export interface AdvisorEvidence {
  kind: string
  reference: string
}

export interface AdvisorChange {
  paths: string[]
  reason: string
  validation: string[]
}

export interface AdvisorVerdict {
  severity: AdvisorSeverity
  summary: string
  diagnosis: string
  nextActions: string[]
  confidence?: number
  disposition?: string
  evidenceUsed?: AdvisorEvidence[]
  assumptions?: string[]
  recommendedNextAction?: string
  validationPlan?: string[]
  needsMoreEvidence?: boolean
  changesMade?: AdvisorChange[]
  raw: string
}

export const VERDICT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['none', 'nit', 'concern', 'blocker'] },
    disposition: { type: 'string' },
    summary: { type: 'string' },
    diagnosis: { type: 'string' },
    next_actions: { type: 'array', items: { type: 'string' } },
    evidence_used: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          reference: { type: 'string' },
        },
        required: ['kind', 'reference'],
        additionalProperties: false,
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    recommended_next_action: { type: 'string' },
    validation_plan: { type: 'array', items: { type: 'string' } },
    needs_more_evidence: { type: 'boolean' },
    confidence: { type: 'number' },
    changes_made: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          validation: { type: 'array', items: { type: 'string' } },
        },
        required: ['paths', 'reason', 'validation'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'severity',
    'disposition',
    'summary',
    'diagnosis',
    'next_actions',
    'evidence_used',
    'assumptions',
    'recommended_next_action',
    'validation_plan',
    'needs_more_evidence',
    'confidence',
    'changes_made',
  ],
  additionalProperties: false,
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export const VERDICT_FIELD_BUDGETS = {
  summary: 1024,
  diagnosis: 6144,
  recommendedNextAction: 2048,
  evidenceReference: 512,
  action: 1024,
  validationPlanTotal: 4096,
  totalDelivered: 16384,
} as const

function asString(value: unknown, maxBytes = 8192): string {
  if (typeof value !== 'string') return ''
  return truncateUtf8(redactSecrets(value).trim(), maxBytes)
}

function asStringArray(value: unknown, limit = 12, maxBytes = 1024): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => asString(item, maxBytes))
    .filter(Boolean)
    .slice(0, limit)
}

function evidenceFrom(value: unknown, maxBytes = VERDICT_FIELD_BUDGETS.evidenceReference): AdvisorEvidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const evidence = asRecord(item)
    const kind = asString(evidence?.kind, 128)
    const reference = asString(evidence?.reference, maxBytes)
    return kind && reference ? [{ kind, reference }] : []
  }).slice(0, 16)
}

function changesFrom(value: unknown): AdvisorChange[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const change = asRecord(item)
    if (!change) return []
    const paths = asStringArray(change.paths)
    const path = asString(change.path)
    if (path && !paths.includes(path)) paths.push(path)
    const reason = asString(change.reason)
    const validationValue = change.validation ?? change.validation_result
    const validation = typeof validationValue === 'string'
      ? [asString(validationValue)].filter(Boolean)
      : asStringArray(validationValue)
    if (paths.length === 0 && !reason && validation.length === 0) return []
    return [{ paths, reason, validation }]
  }).slice(0, 12)
}

function findJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  if (fenced?.startsWith('{') && fenced.endsWith('}')) return fenced
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

export function verdictFromStructured(value: unknown, rawInput = ''): AdvisorVerdict {
  const parsed = asRecord(value) ?? {}
  const severityRaw = asString(parsed.severity).toLowerCase()
  const severity = (SEVERITIES as readonly string[]).includes(severityRaw)
    ? severityRaw as AdvisorSeverity
    : 'concern'
  const confidenceRaw = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? parsed.confidence
    : undefined
  const raw = asString(rawInput, VERDICT_FIELD_BUDGETS.totalDelivered)
  const disposition = asString(parsed.disposition, 512)
  const evidenceUsed = evidenceFrom(parsed.evidence_used ?? parsed.evidenceUsed)
  const assumptions = asStringArray(parsed.assumptions, 12, 512)
  const recommendedNextAction = asString(parsed.recommended_next_action ?? parsed.recommendedNextAction, VERDICT_FIELD_BUDGETS.recommendedNextAction)
  const validationPlan = asStringArray(parsed.validation_plan ?? parsed.validationPlan, 12, 1024)
  const needsMoreEvidenceValue = parsed.needs_more_evidence ?? parsed.needsMoreEvidence
  const needsMoreEvidence = typeof needsMoreEvidenceValue === 'boolean' ? needsMoreEvidenceValue : undefined
  const changesMade = changesFrom(parsed.changes_made ?? parsed.changesMade)
  const summary = asString(parsed.summary, VERDICT_FIELD_BUDGETS.summary) || 'Advisor review'
  const diagnosis = asString(parsed.diagnosis, VERDICT_FIELD_BUDGETS.diagnosis) || raw.slice(0, VERDICT_FIELD_BUDGETS.diagnosis) || 'No diagnosis returned.'
  const nextActions = asStringArray(parsed.next_actions ?? parsed.nextActions ?? parsed.actions, 8, VERDICT_FIELD_BUDGETS.action)
  // Enforce a total delivered budget: fields above are individually capped but
  // their sum can still exceed the telemetry/context budget. The raw transcript
  // excerpt is trimmed first (it duplicates the structured fields), then the
  // diagnosis, so the published verdict always fits the budget.
  let trimmedRaw = raw
  let trimmedDiagnosis = diagnosis
  for (let round = 0; round < 3; round++) {
    let totalBytes = 0
    try { totalBytes = Buffer.byteLength(JSON.stringify({ summary, diagnosis: trimmedDiagnosis, nextActions, evidenceUsed, assumptions, recommendedNextAction, validationPlan, changesMade, raw: trimmedRaw })) } catch { break }
    const over = totalBytes - VERDICT_FIELD_BUDGETS.totalDelivered
    if (over <= 0) break
    if (trimmedRaw.length > 0) trimmedRaw = truncateUtf8(trimmedRaw, Math.max(0, Buffer.byteLength(trimmedRaw) - over))
    else trimmedDiagnosis = truncateUtf8(trimmedDiagnosis, Math.max(0, Buffer.byteLength(trimmedDiagnosis) - over))
  }
  return {
    severity,
    summary,
    diagnosis: trimmedDiagnosis,
    nextActions,
    ...(confidenceRaw === undefined ? {} : { confidence: Math.max(0, Math.min(1, confidenceRaw)) }),
    ...(disposition ? { disposition } : {}),
    ...(evidenceUsed.length ? { evidenceUsed } : {}),
    ...(assumptions.length ? { assumptions } : {}),
    ...(recommendedNextAction ? { recommendedNextAction } : {}),
    ...(validationPlan.length ? { validationPlan } : {}),
    ...(needsMoreEvidence === undefined ? {} : { needsMoreEvidence }),
    ...(changesMade.length ? { changesMade } : {}),
    raw: trimmedRaw,
  }
}

function fallbackSeverity(raw: string): AdvisorSeverity {
  if (!raw) return 'none'
  const explicit = raw.match(/^\s*(?:severity\s*[:=-]\s*)?(none|nit|concern|blocker)\b/im)?.[1]?.toLowerCase()
  if (explicit && (SEVERITIES as readonly string[]).includes(explicit)) return explicit as AdvisorSeverity
  if (/^\s*no (?:meaningful )?(?:issues?|concerns?)(?: found)?[.!]?\s*$/i.test(raw)) return 'none'
  return 'concern'
}

export function parseVerdict(rawInput: string): AdvisorVerdict {
  const raw = asString(rawInput, VERDICT_FIELD_BUDGETS.totalDelivered)
  const candidate = findJsonObject(raw)
  if (candidate) {
    try { return verdictFromStructured(JSON.parse(candidate), raw) } catch {}
  }
  const severity = fallbackSeverity(raw)
  return {
    severity,
    summary: severity === 'none' ? 'No issue found' : 'Advisor returned unstructured guidance',
    diagnosis: raw || 'No advisor text was returned.',
    nextActions: [],
    raw,
  }
}
