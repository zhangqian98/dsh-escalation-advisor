export class AdvisorTaskLimitError extends Error {
  constructor(message: string, readonly code: 'task_budget_exhausted' | 'task_queue_aborted') {
    super(message)
    this.name = 'AdvisorTaskLimitError'
  }
}

interface Waiter {
  maxConcurrent: number
  signal: AbortSignal
  resolve: () => void
  reject: (error: unknown) => void
  onAbort: () => void
}

interface TaskState {
  used: number
  active: number
  waiters: Waiter[]
}

/** Process-local limits for one live root task tree. */
export class AdvisorTaskLimiter {
  private readonly tasks = new Map<string, TaskState>()

  private state(taskId: string): TaskState {
    let state = this.tasks.get(taskId)
    if (!state) {
      state = { used: 0, active: 0, waiters: [] }
      this.tasks.set(taskId, state)
    }
    return state
  }

  private abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new AdvisorTaskLimitError('Advisor task queue was aborted.', 'task_queue_aborted')
  }

  private acquire(state: TaskState, maxConcurrent: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(this.abortError(signal))
    if (state.active < maxConcurrent) {
      state.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        maxConcurrent,
        signal,
        resolve: () => { resolve() },
        reject,
        onAbort: () => {},
      }
      waiter.onAbort = () => {
        const index = state.waiters.indexOf(waiter)
        if (index >= 0) state.waiters.splice(index, 1)
        signal.removeEventListener('abort', waiter.onAbort)
        reject(this.abortError(signal))
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      state.waiters.push(waiter)
    })
  }

  private release(state: TaskState): void {
    state.active = Math.max(0, state.active - 1)
    while (state.waiters.length > 0) {
      const waiter = state.waiters[0]!
      if (waiter.signal.aborted) {
        state.waiters.shift()
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.reject(this.abortError(waiter.signal))
        continue
      }
      if (state.active >= waiter.maxConcurrent) return
      state.waiters.shift()
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      state.active += 1
      waiter.resolve()
      return
    }
  }

  async run<T>(
    taskId: string,
    limits: { maxTotal: number; maxConcurrent: number },
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<T> {
    const state = this.state(taskId)
    if (limits.maxTotal <= 0 || state.used >= limits.maxTotal) {
      throw new AdvisorTaskLimitError(`Advisor task budget reached (${limits.maxTotal} consultations for this task tree).`, 'task_budget_exhausted')
    }
    state.used += 1
    let acquired = false
    try {
      await this.acquire(state, Math.max(1, limits.maxConcurrent), signal)
      acquired = true
      return await task()
    } catch (error) {
      // A queued consultation that never started should not consume the task budget.
      if (!acquired) state.used = Math.max(0, state.used - 1)
      throw error
    } finally {
      if (acquired) this.release(state)
    }
  }

  snapshot(taskId: string): { used: number; active: number; queued: number } {
    const state = this.tasks.get(taskId)
    return state ? { used: state.used, active: state.active, queued: state.waiters.length } : { used: 0, active: 0, queued: 0 }
  }

  clear(taskId: string, reason: unknown = new Error('Advisor task tree disposed.')): void {
    const state = this.tasks.get(taskId)
    if (!state) return
    this.tasks.delete(taskId)
    for (const waiter of state.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.reject(reason)
    }
  }
}
