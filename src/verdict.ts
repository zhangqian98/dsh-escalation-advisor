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

// The enforced JSON-schema subset supports no maxItems/maxLength keywords —
// limits travel as descriptions and are enforced by the budgets below.
export const VERDICT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['none', 'nit', 'concern', 'blocker'] },
    disposition: { type: 'string' },
    summary: { type: 'string', description: 'One line, at most 1 KB.' },
    diagnosis: { type: 'string', description: 'At most 6 KB.' },
    next_actions: { type: 'array', description: 'At most 8 items, 1 KB each.', items: { type: 'string' } },
    evidence_used: {
      type: 'array',
      description: 'At most 16 items; reference at most 512 bytes.',
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
    assumptions: { type: 'array', description: 'At most 12 items, 512 bytes each.', items: { type: 'string' } },
    recommended_next_action: { type: 'string', description: 'At most 2 KB.' },
    validation_plan: { type: 'array', description: 'At most 12 items, 1 KB each.', items: { type: 'string' } },
    needs_more_evidence: { type: 'boolean' },
    confidence: { type: 'number' },
    changes_made: {
      type: 'array',
      description: 'At most 12 items; reason at most 1 KB, validation 12 items of 1 KB each.',
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

/** Largest prefix of `text` whose JSON serialization stays within `bytes`. */
function fitStringToJsonBytes(text: string, bytes: number): string {
  if (bytes <= 0) return ''
  // The escaped length of a prefix is not linear in characters, so measure the
  // serialized form — marker included — instead of trusting byte arithmetic.
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = mid === text.length ? text : text.slice(0, mid) + '…'
    if (Buffer.byteLength(JSON.stringify(candidate)) <= bytes) low = mid
    else high = mid - 1
  }
  return low === text.length ? text : text.slice(0, low) + '…'
}

/**
 * Fit the WHOLE structured verdict under the delivered budget, degrading in a
 * fixed order: the redundant raw transcript first, then bounded arrays, and
 * finally the diagnosis to whatever room the remaining skeleton leaves. The
 * result always serializes within the budget — a fixed-round loop cannot
 * promise that, because trimming by the overage count does not account for
 * JSON escaping or the per-field suffix markers.
 */
export function fitVerdictToBudget(verdict: AdvisorVerdict): AdvisorVerdict {
  const within = (value: AdvisorVerdict) => Buffer.byteLength(JSON.stringify(value)) <= VERDICT_FIELD_BUDGETS.totalDelivered
  if (within(verdict)) return verdict
  const fitted: AdvisorVerdict = { ...verdict, raw: '' }
  const shrinkItems = (items: string[] | undefined, keep: number, maxBytes: number): string[] | undefined =>
    items === undefined ? undefined : items.slice(0, keep).map(item => truncateUtf8(item, maxBytes))
  fitted.assumptions = shrinkItems(fitted.assumptions, 4, 256)
  fitted.validationPlan = shrinkItems(fitted.validationPlan, 4, 512)
  fitted.nextActions = shrinkItems(fitted.nextActions, 4, 512) ?? []
  if (fitted.evidenceUsed !== undefined) fitted.evidenceUsed = fitted.evidenceUsed.slice(0, 8).map(item => ({ kind: truncateUtf8(item.kind, 64), reference: truncateUtf8(item.reference, 256) }))
  if (fitted.changesMade !== undefined) fitted.changesMade = fitted.changesMade.slice(0, 6).map(change => ({ paths: change.paths.slice(0, 6), reason: truncateUtf8(change.reason, 512), validation: change.validation.slice(0, 4) }))
  if (fitted.recommendedNextAction !== undefined) fitted.recommendedNextAction = truncateUtf8(fitted.recommendedNextAction, 1024)
  if (within(fitted)) return fitted
  // Second pass: the bounded arrays to their floor before long text is cut.
  delete fitted.assumptions
  fitted.evidenceUsed = fitted.evidenceUsed?.slice(0, 4)
  fitted.validationPlan = fitted.validationPlan?.slice(0, 2)
  fitted.nextActions = fitted.nextActions.slice(0, 2)
  fitted.changesMade = fitted.changesMade?.slice(0, 2)
  if (within(fitted)) return fitted
  // The diagnosis takes exactly the room the remaining skeleton leaves — this
  // branch always fits, because the skeleton alone stays far under the cap.
  const skeleton: AdvisorVerdict = { severity: fitted.severity, summary: fitted.summary, diagnosis: '', nextActions: fitted.nextActions, raw: '' }
  const room = VERDICT_FIELD_BUDGETS.totalDelivered - Buffer.byteLength(JSON.stringify(skeleton))
  return { severity: fitted.severity, summary: fitted.summary, diagnosis: fitStringToJsonBytes(fitted.diagnosis, Math.max(0, room)), nextActions: fitted.nextActions, raw: '' }
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
  return fitVerdictToBudget({
    severity,
    summary,
    diagnosis,
    nextActions,
    ...(confidenceRaw === undefined ? {} : { confidence: Math.max(0, Math.min(1, confidenceRaw)) }),
    ...(disposition ? { disposition } : {}),
    ...(evidenceUsed.length ? { evidenceUsed } : {}),
    ...(assumptions.length ? { assumptions } : {}),
    ...(recommendedNextAction ? { recommendedNextAction } : {}),
    ...(validationPlan.length ? { validationPlan } : {}),
    ...(needsMoreEvidence === undefined ? {} : { needsMoreEvidence }),
    ...(changesMade.length ? { changesMade } : {}),
    raw,
  })
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
  return fitVerdictToBudget({
    severity,
    summary: severity === 'none' ? 'No issue found' : 'Advisor returned unstructured guidance',
    diagnosis: raw || 'No advisor text was returned.',
    nextActions: [],
    raw,
  })
}
