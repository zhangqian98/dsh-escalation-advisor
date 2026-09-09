import type { Agent } from '@deepseek-ai/dsh-agent'
import { redactSecrets, truncateUtf8 } from './redact.js'

const RELEVANT_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'tool/ptc-dispatch', 'step/end'])
function compactJson(value: unknown, maxBytes: number): string {
  let text: string
  try { text = JSON.stringify(value, (_key, item) => typeof item === 'string' && item.length > 6000 ? `${item.slice(0, 6000)}…[field truncated]` : item) }
  catch { text = String(value) }
  return truncateUtf8(redactSecrets(text), maxBytes)
}
export function recentSessionContext(agent: Agent, maxBytes: number): string {
  const events = agent.session.snapshotEvents(), pieces: string[] = []
  let used = 0
  const perEvent = Math.min(5000, Math.max(1000, Math.floor(maxBytes / 4)))
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as { type?: unknown; data?: unknown }
    if (typeof event.type !== 'string' || !RELEVANT_EVENT_TYPES.has(event.type)) continue
    const line = `[${event.type}] ${compactJson(event.data, perEvent)}`, bytes = Buffer.byteLength(line) + 1
    if (pieces.length > 0 && used + bytes > maxBytes) break
    pieces.push(line); used += bytes
    if (pieces.length >= 80) break
  }
  return pieces.reverse().join('\n')
}
export function textContent(blocks: readonly unknown[]): string {
  const out: string[] = []
  for (const block of blocks) if (block && typeof block === 'object' && 'type' in block && (block as { type?: unknown }).type === 'text') { const text = (block as { text?: unknown }).text; if (typeof text === 'string') out.push(text) }
  return redactSecrets(out.join('\n'))
}
