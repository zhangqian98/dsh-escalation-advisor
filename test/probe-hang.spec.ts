import { describe, expect, it } from 'vitest';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { advisorScript, advisorVerdictResponse, createIntegrationHarness, textResponse } from './harness.js';
import type { Config } from '../src/config.js';

async function ask(h: Awaited<ReturnType<typeof createIntegrationHarness>>, args: Record<string, unknown>) {
  const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> };
  const out = await tools.execute({ callId: ToolCallId('hx-' + Math.random().toString(36).slice(2)), name: 'consult_advisor', arguments: args, agent: h.root, signal: new AbortController().signal });
  const text = (out.content as readonly { type?: string; text?: string }[]).flatMap(b => (b.type === 'text' ? [String(b.text ?? '')] : [])).join('');
  return JSON.parse(text) as Record<string, unknown>;
}
async function harnessWith(config: Partial<Config>) {
  return createIntegrationHarness(
    { weak: [textResponse('done')], advisor: advisorScript(advisorVerdictResponse({ summary: 'x' })) },
    config,
  );
}

describe('hang bisect', () => {
  it('C: write defaults, profiles configured, legacy consult (no profile arg)', async () => {
    const h = await harnessWith({
      defaultEnabledTools: ['write'],
      advisorProfiles: [{ id: 'debugger', label: 'D', provider: 'mock', model: 'advisor', toolPolicy: 'inspect' }],
    } as unknown as Partial<Config>);
    try {
      const answer = await ask(h, { question: 'Q?' });
      expect(answer.status).toBe('ok');
    } finally {
      await h.ctx.fiber.dispose();
    }
  }, 30000);
  it('D: read defaults, single profile, explicit consult', async () => {
    const h = await harnessWith({
      defaultEnabledTools: ['read'],
      advisorProfiles: [{ id: 'debugger', label: 'D', provider: 'mock', model: 'advisor', toolPolicy: 'inspect' }],
    } as unknown as Partial<Config>);
    try {
      const answer = await ask(h, { question: 'Q?', advisor_profile: 'debugger' });
      expect(answer.status).toBe('ok');
    } finally {
      await h.ctx.fiber.dispose();
    }
  }, 30000);
});
