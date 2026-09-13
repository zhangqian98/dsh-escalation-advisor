import { describe, expect, it } from 'vitest';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { advisorScript, advisorVerdictResponse, createIntegrationHarness, textResponse } from './harness.js';
import type { Config } from '../src/config.js';
import { advisorRunHistory } from '../src/telemetry.js';

describe('hang localize', () => {
  it('times verdict vs turn-end vs return', async () => {
    const h = await createIntegrationHarness(
      { weak: [textResponse('done')], advisor: advisorScript(advisorVerdictResponse({ summary: 'x' })) },
      {
        defaultEnabledTools: ['write'],
        advisorProfiles: [{ id: 'debugger', label: 'D', provider: 'mock', model: 'advisor', toolPolicy: 'inspect' }],
      } as unknown as Partial<Config>,
    );
    const t0 = Date.now();
    const stamp = (m: string) => (Date.now() - t0) + 'ms ' + m;
    const marks: string[] = [];
    try {
      const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> };
      const pending = (async () => {
        const out = await tools.execute({ callId: ToolCallId('hang-2'), name: 'consult_advisor', arguments: { question: 'Q?', advisor_profile: 'debugger' }, agent: h.root, signal: new AbortController().signal });
        marks.push(stamp('ask-resolved'));
        return out;
      })();
      let lastAdv = 0;
      let lastRuns = 0;
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const adv = h.adapter.forModel('advisor').length;
        const runs = advisorRunHistory(h.root).length;
        if (adv !== lastAdv || runs !== lastRuns) {
          marks.push(stamp('adv=' + adv + ' runs=' + runs));
          lastAdv = adv;
          lastRuns = runs;
        }
      }
      console.log('MARKS ' + JSON.stringify(marks));
      await pending;
    } finally {
      await h.ctx.fiber.dispose();
    }
  }, 30000);
});
