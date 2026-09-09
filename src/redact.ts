const RAW_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
]

// Matches both ordinary assignments (`api_key=...`) and JSON-like fields
// (`"api_key":"..."`). The value alternative understands quoted strings well
// enough to preserve the surrounding JSON shape while replacing the secret.
const SECRET_ASSIGNMENT = /((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|password|passwd|secret|token|cookie|set-cookie)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi

export function redactSecrets(input: string): string {
  let value = input
  for (const pattern of RAW_SECRET_PATTERNS) value = value.replace(pattern, '[REDACTED]')
  value = value.replace(SECRET_ASSIGNMENT, (_match, prefix: string) => `${prefix}"[REDACTED]"`)
  return value
}

export function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(input) <= maxBytes) return input
  const suffix = '\n…[truncated]'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix))
  let low = 0
  let high = input.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(input.slice(0, mid)) <= budget) low = mid
    else high = mid - 1
  }
  return input.slice(0, low) + suffix
}
