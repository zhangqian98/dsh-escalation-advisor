import { describe, expect, it } from 'vitest'
import { AdvisorTaskLimiter, AdvisorTaskLimitError } from '../src/task-limiter.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('AdvisorTaskLimiter', () => {
  it('caps the total consultations for one task tree', async () => {
    const limiter = new AdvisorTaskLimiter()
    const signal = new AbortController().signal
    await limiter.run('root', { maxTotal: 2, maxConcurrent: 1 }, signal, async () => 1)
    await limiter.run('root', { maxTotal: 2, maxConcurrent: 1 }, signal, async () => 2)
    await expect(limiter.run('root', { maxTotal: 2, maxConcurrent: 1 }, signal, async () => 3))
      .rejects.toMatchObject({ code: 'task_budget_exhausted' })
  })

  it('queues excess concurrent advisor work instead of starting it', async () => {
    const limiter = new AdvisorTaskLimiter()
    const firstGate = deferred<void>()
    const signal = new AbortController().signal
    const order: string[] = []
    const first = limiter.run('root', { maxTotal: 4, maxConcurrent: 1 }, signal, async () => {
      order.push('first-start')
      await firstGate.promise
      order.push('first-end')
    })
    await Promise.resolve()
    const second = limiter.run('root', { maxTotal: 4, maxConcurrent: 1 }, signal, async () => {
      order.push('second-start')
    })
    await Promise.resolve()
    expect(limiter.snapshot('root')).toEqual({ used: 2, active: 1, queued: 1 })
    expect(order).toEqual(['first-start'])
    firstGate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })

  it('does not spend task budget when a queued consultation is aborted before start', async () => {
    const limiter = new AdvisorTaskLimiter()
    const firstGate = deferred<void>()
    const firstSignal = new AbortController().signal
    const first = limiter.run('root', { maxTotal: 2, maxConcurrent: 1 }, firstSignal, async () => { await firstGate.promise })
    await Promise.resolve()
    const queuedController = new AbortController()
    const queued = limiter.run('root', { maxTotal: 2, maxConcurrent: 1 }, queuedController.signal, async () => undefined)
    await Promise.resolve()
    queuedController.abort(new AdvisorTaskLimitError('cancelled', 'task_queue_aborted'))
    await expect(queued).rejects.toBeInstanceOf(AdvisorTaskLimitError)
    expect(limiter.snapshot('root').used).toBe(1)
    firstGate.resolve()
    await first
    await expect(limiter.run('root', { maxTotal: 2, maxConcurrent: 1 }, firstSignal, async () => 'ok')).resolves.toBe('ok')
  })
})
