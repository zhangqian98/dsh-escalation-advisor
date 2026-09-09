const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b\s*[:=]\s*([^\s,;]+)/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
]

export function redactSecrets(input: string): string {
  let value = input
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, match => {
      const eq = match.search(/[:=]/)
      return eq >= 0 ? `${match.slice(0, eq + 1)}[REDACTED]` : '[REDACTED]'
    })
  }
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
