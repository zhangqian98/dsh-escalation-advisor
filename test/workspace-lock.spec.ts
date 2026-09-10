import { describe, expect, it } from 'vitest'
import { AdvisorWorkspaceLock } from '../src/workspace-lock.js'

describe('Advisor workspace exclusivity', () => {
  it('waits for an existing tool, then prevents another tool or Advisor from overlapping an editing Advisor', async () => {
    const lock = new AdvisorWorkspaceLock(), signal = new AbortController().signal
    const toolGate = Promise.withResolvers<void>(), advisorGate = Promise.withResolvers<void>()
    const order: string[] = []
    const tool = lock.run('root', false, signal, async () => { order.push('tool'); await toolGate.promise })
    await Promise.resolve()
    const advisor = lock.run('root', true, signal, async () => { order.push('advisor'); await advisorGate.promise })
    const nextTool = lock.run('root', false, signal, async () => { order.push('next-tool') })
    await Promise.resolve()
    expect(order).toEqual(['tool'])
    toolGate.resolve(); await tool; await Promise.resolve()
    expect(order).toEqual(['tool', 'advisor'])
    advisorGate.resolve(); await Promise.all([advisor, nextTool])
    expect(order).toEqual(['tool', 'advisor', 'next-tool'])
  })
  it('cancels an exclusive waiter without retaining the queue barrier', async () => {
    const lock = new AdvisorWorkspaceLock(), gate = Promise.withResolvers<void>()
    const first = lock.run('root', false, new AbortController().signal, () => gate.promise)
    const abort = new AbortController()
    const queued = lock.run('root', true, abort.signal, async () => { throw new Error('must not run') })
    abort.abort(new Error('cancelled'))
    await expect(queued).rejects.toThrow('cancelled')
    await expect(lock.run('root', false, new AbortController().signal, async () => 'ok')).resolves.toBe('ok')
    gate.resolve(); await first
  })
})
