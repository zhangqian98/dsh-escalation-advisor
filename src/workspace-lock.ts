interface Waiter { exclusive: boolean; owner?: string; signal: AbortSignal; resolve: (release: () => void) => void; reject: (reason: unknown) => void; abort: () => void }
interface Lock { shared: number; owners: Map<string, number>; exclusive: boolean; queue: Waiter[] }

/** Tool bodies and read-only Advisors share; an editing Advisor is exclusive. */
export class AdvisorWorkspaceLock {
  private readonly locks = new Map<string, Lock>()
  hasSharedOwner(key: string, owners: readonly string[]): boolean { return owners.some(owner => (this.locks.get(key)?.owners.get(owner) ?? 0) > 0) }

  private drain(key: string, lock: Lock): void {
    while (!lock.exclusive && lock.queue.length) {
      const waiter = lock.queue[0]!
      if (waiter.exclusive && lock.shared > 0) return
      lock.queue.shift()
      waiter.signal.removeEventListener('abort', waiter.abort)
      if (waiter.exclusive) lock.exclusive = true
      else { lock.shared++; if (waiter.owner) lock.owners.set(waiter.owner, (lock.owners.get(waiter.owner) ?? 0) + 1) }
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        if (waiter.exclusive) lock.exclusive = false
        else { lock.shared--; if (waiter.owner) lock.owners.set(waiter.owner, (lock.owners.get(waiter.owner) ?? 1) - 1) }
        this.drain(key, lock)
      })
    }
    if (!lock.exclusive && lock.shared === 0 && lock.queue.length === 0) this.locks.delete(key)
  }

  async run<T>(key: string, exclusive: boolean, signal: AbortSignal, task: () => Promise<T>, owner?: string): Promise<T> {
    signal.throwIfAborted()
    let lock = this.locks.get(key)
    if (!lock) { lock = { shared: 0, owners: new Map(), exclusive: false, queue: [] }; this.locks.set(key, lock) }
    const current = lock
    const release = await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { exclusive, owner, signal, resolve, reject, abort: () => {} }
      waiter.abort = () => {
        const index = current.queue.indexOf(waiter)
        if (index < 0) return
        current.queue.splice(index, 1)
        reject(signal.reason)
        this.drain(key, current)
      }
      signal.addEventListener('abort', waiter.abort, { once: true })
      current.queue.push(waiter)
      this.drain(key, current)
    })
    try { signal.throwIfAborted(); return await task() }
    finally { release() }
  }
}
