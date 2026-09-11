import { afterEach, describe, expect, it } from 'vitest'
import { createIntegrationHarness, textResponse, type IntegrationHarness } from './harness.js'

/**
 * The reuse decision belongs to the CALLING model: it continues an earlier
 * consultation by passing consultation_id and starts fresh by omitting it. That
 * only works if the rule reaches the model, so these assertions read the
 * registered tool definition rather than the source that declares it.
 */
const opened: IntegrationHarness[] = []
afterEach(async () => { for (const h of opened.splice(0)) await h.ctx.fiber.dispose() })
async function harness(...args: Parameters<typeof createIntegrationHarness>) { const h = await createIntegrationHarness(...args); opened.push(h); return h }

describe('consult_advisor model-facing guidance', () => {
  it('tells the model that a new conversation is the default and consultation_id continues one', async () => {
    const h = await harness({ weak: [textResponse('done')] })
    const definition = (h.ctx.get('tools') as { get(name: string): unknown }).get('consult_advisor') as { description?: unknown; parameters?: unknown }
    expect(definition).toBeTruthy()

    const description = String(definition.description)
    const parameters = JSON.stringify(definition.parameters)

    // Fresh is the documented default, so a caller that forgets the id is not misled.
    expect(description).toContain('NEW Advisor conversation')
    // The parameter itself explains the rule, not just its name.
    expect(parameters).toContain('Continue an earlier Advisor conversation')
    // The rule is usefulness of the earlier context, NOT relatedness: a related
    // question may still warrant a deliberately fresh and independent review.
    expect(parameters).toContain('deliberately independent reassessment')
    // A wrong or foreign id is refused rather than silently restarted as fresh,
    // so a caller can never believe it continued when it did not.
    expect(parameters).toContain('refused rather than silently restarted')
  })
})
