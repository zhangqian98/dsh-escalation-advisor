import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { Config } from '../src/config.js'
import { advisorModelConfig, parseModelSelection, sessionModelSelection, updateModelSelection } from '../src/model-selection.js'

describe('Advisor model selection', () => {
  it('stores a complete session selection and resets back to current global defaults', () => {
    const session = Session.create(SessionId('model-choice'))
    const defaults = Config({ provider: 'global', model: 'default', reasoningEffort: 'max' })
    expect(advisorModelConfig(defaults, session).model).toBe('default')
    updateModelSelection(session, { provider: 'local', model: 'reviewer' })
    expect(advisorModelConfig(defaults, session)).toMatchObject({ provider: 'local', model: 'reviewer', reasoningEffort: '' })
    updateModelSelection(session, null)
    expect(advisorModelConfig({ ...defaults, model: 'new-default' }, session)).toMatchObject({ model: 'new-default', reasoningEffort: 'max' })
  })

  it('validates fields and retains the last valid restored selection', () => {
    const session = Session.create(SessionId('restored-model-choice'))
    updateModelSelection(session, { provider: 'mock', model: 'reviewer', reasoningEffort: 'high' })
    expect(() => parseModelSelection({ provider: 'mock', model: '', reasoningEffort: 'high' })).toThrow()
    expect(() => parseModelSelection({ provider: 'mock', model: 'reviewer', extra: true })).toThrow()
    session.append('advisor/model', { version: 1, selection: { provider: 'mock', model: '' } })
    const restored = Session.create(session.id, session.snapshotEvents(), session.header)
    expect(sessionModelSelection(restored)).toEqual({ provider: 'mock', model: 'reviewer', reasoningEffort: 'high' })
  })
})
