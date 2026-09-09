import { describe, expect, it } from 'vitest'
import { redactSecrets, truncateUtf8 } from '../src/redact.js'

describe('redactSecrets', () => {
  it('redacts JSON-shaped secret fields while preserving the key', () => {
    const input = JSON.stringify({ api_key: 'super-secret-value', nested: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' } })
    const output = redactSecrets(input)
    expect(output).not.toContain('super-secret-value')
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(output).toContain('"api_key":"[REDACTED]"')
    expect(output).toContain('"Authorization":"[REDACTED]"')
  })

  it('redacts common raw credential formats', () => {
    const output = redactSecrets('key sk-1234567890abcdefghijkl token ghp_1234567890abcdefghijklmnop')
    expect(output).not.toContain('sk-1234567890abcdefghijkl')
    expect(output).not.toContain('ghp_1234567890abcdefghijklmnop')
  })

  it('does not redact ordinary prose using the word token', () => {
    expect(redactSecrets('the token budget is 12000')).toBe('the token budget is 12000')
  })
})

describe('truncateUtf8', () => {
  it('respects the byte budget with multibyte text', () => {
    const value = truncateUtf8('你好世界'.repeat(100), 64)
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64)
    expect(value).toContain('[truncated]')
  })
})
