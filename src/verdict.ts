import type { AdvisorSeverity } from './config.js'
import { SEVERITIES } from './config.js'
import { redactSecrets } from './redact.js'

export interface AdvisorVerdict {
  severity: AdvisorSeverity
  summary: string
  diagnosis: string
  nextActions: string[]
  confidence?: number
  raw: string
}

function asString(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 8)
}
function findJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  if (fenced?.startsWith('{') && fenced.endsWith('}')) return fenced
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0, quoted = false, escaped = false
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

export function parseVerdict(rawInput: string): AdvisorVerdict {
  const raw = redactSecrets(rawInput).trim()
  const candidate = findJsonObject(raw)
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const severityRaw = asString(parsed.severity).toLowerCase()
      const severity = (SEVERITIES as readonly string[]).includes(severityRaw) ? severityRaw as AdvisorSeverity : 'concern'
      const confidenceRaw = typeof parsed.confidence === 'number' ? parsed.confidence : undefined
      return {
        severity,
        summary: asString(parsed.summary) || asString(parsed.assessment) || 'Advisor review',
        diagnosis: asString(parsed.diagnosis) || asString(parsed.reason) || raw,
        nextActions: asStringArray(parsed.next_actions ?? parsed.nextActions ?? parsed.actions),
        ...(confidenceRaw === undefined ? {} : { confidence: Math.max(0, Math.min(1, confidenceRaw)) }),
        raw,
      }
    } catch {}
  }
  const lower = raw.toLowerCase()
  const severity: AdvisorSeverity = lower.includes('blocker') ? 'blocker' : lower.includes('concern') ? 'concern' : lower.includes('nit') ? 'nit' : raw.length === 0 ? 'none' : 'concern'
  return { severity, summary: severity === 'none' ? 'No issue found' : 'Advisor returned unstructured guidance', diagnosis: raw || 'No advisor text was returned.', nextActions: [], raw }
}
