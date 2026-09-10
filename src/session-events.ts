import type { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

const EVENT_TYPES = ['advisor/policy', 'advisor/identity', 'advisor/run', 'advisor/model'] as const
const added = new Set<string>()
let owners = 0

/**
 * Compatibility bridge for the two pinned DSH builds. Their Session.append
 * cannot write the external-event `ignorable` envelope marker. Policy and
 * identity must remain required anyway: dropping them could widen authority.
 * Extend only the owned vocabulary while the plugin can interpret it, and
 * restore the catalog after the final plugin instance has finished cleanup.
 */
export function installAdvisorEventCompatibility(ctx: Context): void {
  // DSH exposes this as ReadonlySet, so fail explicitly if a future build no
  // longer uses the tested Set implementation. Never relax the reader globally.
  const catalog = KNOWN_SESSION_EVENT_TYPES
  if (!(catalog instanceof Set)) throw new Error('This DSH event catalog is unsupported by Advisor; use a tested DSH version.')
  ctx.effect(() => {
    if (owners++ === 0) for (const type of EVENT_TYPES) {
      if (!catalog.has(type)) { catalog.add(type); added.add(type) }
    }
    return () => {
      if (--owners !== 0) return
      for (const type of added) catalog.delete(type)
      added.clear()
    }
  }, 'advisor: required session event compatibility')
}
