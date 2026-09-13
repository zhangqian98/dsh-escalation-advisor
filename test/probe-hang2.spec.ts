import { describe, expect, it } from 'vitest';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { advisorScript, advisorVerdictResponse, createIntegrationHarness, textResponse } from './harness.js';
import type { Config } from '../src/config.js';
import { advisorRunHistory } from '../src/telemetry.js';

describe('hang sampler', () => {
  it('samples advisor activity while the pinned consult pends', async () => {
    const h = await createIntegrationHarness(
      { weak: [textResponse('done')], advisor: advisorScript(advisorVerdictResponse({ summary: 'x' })) },
      {
        defaultEnabledTools: ['write'],
        advisorProfiles: [{ id: 'debugger', label: 'D', provider: 'mock', model: 'advisor', toolPolicy: 'inspect' }],
      } as unknown as Partial<Config>,
    );
    try {
      const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> };
      const pending = tools.execute({ callId: ToolCallId('hang-1'), name: 'consult_advisor', arguments: { question: 'Q?', advisor_profile: 'debugger' }, agent: h.root, signal: new AbortController().signal });
      const samples: string[] = [];
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        samples.push('t' + i + ' advReqs=' + h.adapter.forModel('advisor').length + ' runs=' + advisorRunHistory(h.root).length);
      }
      console.log('SAMPLES ' + JSON.stringify(samples));
      const out = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('ask still pending after sampling')), 1000))]);
      console.log('ASK-SETTLED ' + JSON.stringify(out).slice(0, 200));
    } finally {
      await h.ctx.fiber.dispose();
    }
  }, 30000);
});
