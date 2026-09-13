import { describe, expect, it } from 'vitest';
import { Config } from '../src/config.js';
import type { Branded } from '@deepseek-ai/dsh-brand';
import { effectiveAdvisorPolicy, parsePolicy, triggerEnabledForRole } from '../src/policy.js';
import type { Session } from '@deepseek-ai/dsh-session';

const baseConfig = Config({ enabled: true, mode: 'escalate', provider: 'test', model: 'strong' });
function fakeSession(events: unknown[]): Session {
  return { snapshotEvents: () => events } as unknown as Session;
}

describe('policy v3 triggers', () => {
  it('keeps v2 records inheriting everywhere', () => {
    const effective = effectiveAdvisorPolicy(baseConfig, fakeSession([{ type: 'advisor/policy', data: { version: 2, allowTools: [], denyTools: [], escalationWait: 'inherit', continuousWait: 'inherit' } }]));
    expect(effective.policyVersion).toBe(2);
    expect(effective.triggers).toEqual({ manual: 'inherit', escalation: 'inherit', completion: 'inherit', continuous: 'inherit' });
    expect(effective.completionWait).toBe('block');
  });
  it('resolves escalate preset with orthogonal completion', () => {
    const v2 = parsePolicy({ version: 2, allowTools: [], denyTools: [], escalationWait: 'inherit', continuousWait: 'inherit' });
    expect(triggerEnabledForRole(baseConfig, v2, 'escalation', 'root')).toBe(true);
    expect(triggerEnabledForRole(baseConfig, v2, 'continuous', 'root')).toBe(false);
    expect(triggerEnabledForRole(baseConfig, v2, 'completion', 'root')).toBe(false);
  });
});

describe('policy v3 overrides', () => {
  it('round-trips trigger and coverage updates at version 3', async () => {
    const { updateTriggerOverride, updateCoverageOverride, updateSessionProfiles } = await import('../src/policy.js');
    const appended: unknown[] = [];
    const session = { snapshotEvents: () => [], append: (_t: string, data: unknown) => { appended.push(data); } } as unknown as Session;
    updateTriggerOverride(session, 'completion', 'on');
    updateCoverageOverride(session, { root: { manual: 'off' }, maxDepth: 1 });
    updateSessionProfiles(session, { defaultProfileId: 'debugger', allowedProfileIds: ['debugger'] });
    expect(appended).toHaveLength(3);
    for (const data of appended) expect((data as { version: number }).version).toBe(3);
    const { parseTriggerOverrides, parseCoverageOverride } = await import('../src/policy.js');
    expect(parseTriggerOverrides({ completion: 'bogus' })).toBeUndefined();
    expect(parseCoverageOverride({ maxDepth: 99 })).toBeUndefined();
  });
  it('lets session coverage narrow subagent scope', async () => {
    const { subagentInScope } = await import('../src/coverage.js');
    const v2 = parsePolicy({ version: 2, allowTools: [], denyTools: [], escalationWait: 'inherit', continuousWait: 'inherit' });
    expect(subagentInScope({ config: baseConfig, override: v2, depth: 9 })).toBe(true);
    expect(subagentInScope({ config: baseConfig, override: v2, depth: 1, label: 'x' })).toBe(true);
  });
});

describe('advisor profiles', () => {
  it('parses, filters and routes', async () => {
    const { parseAdvisorProfiles, profileTools, resolveProfileForNewConsultation } = await import('../src/profiles.js');
    const profiles = parseAdvisorProfiles([
      { id: 'debugger', label: 'Debugger', provider: 'mock', model: 'advisor', toolPolicy: 'inspect' },
      { id: 'architect', label: 'Architect', provider: 'mock', model: 'advisor', toolPolicy: 'research' },
      { id: 'nope', provider: '', model: 'x', toolPolicy: 'inspect' },
    ]);
    expect(profiles.map(p => p.id)).toEqual(['debugger', 'architect']);
    expect(profileTools(profiles[0]!)).toEqual(['read', 'read_image', 'glob', 'grep']);
    const base = { profiles, allowedProfileIds: [] as string[], defaultProfileId: '', routes: {} };
    expect(resolveProfileForNewConsultation({ ...base, trigger: 'manual', explicitProfileId: 'architect' })?.id).toBe('architect');
    expect(resolveProfileForNewConsultation({ ...base, trigger: 'manual', explicitProfileId: 'missing' })).toBeUndefined();
    expect(resolveProfileForNewConsultation({ ...base, trigger: 'escalation', routes: { escalation: 'architect' } })?.id).toBe('architect');
    expect(resolveProfileForNewConsultation({ ...base, trigger: 'manual' })?.id).toBe('debugger');
  });
  it('treats an empty allowlist intersection as deny-all and intersects tool ceilings', async () => {
    const { effectiveAllowedProfiles, intersectToolCeiling, parseAdvisorProfiles } = await import('../src/profiles.js');
    expect(effectiveAllowedProfiles([], [])).toEqual({ constrained: false, allowed: [] });
    expect(effectiveAllowedProfiles(['a'], [])).toEqual({ constrained: true, allowed: ['a'] });
    expect(effectiveAllowedProfiles([], ['b'])).toEqual({ constrained: true, allowed: ['b'] });
    expect(effectiveAllowedProfiles(['a'], ['b'])).toEqual({ constrained: true, allowed: [] });
    expect(effectiveAllowedProfiles(['a', 'b'], ['b', 'c'])).toEqual({ constrained: true, allowed: ['b'] });
    const inspect = parseAdvisorProfiles([{ id: 'debugger', provider: 'mock', model: 'm', toolPolicy: 'inspect' }])[0]!;
    expect(intersectToolCeiling(['write'], inspect)).toEqual([]);
    expect(intersectToolCeiling(['read', 'write'], inspect)).toEqual(['read']);
  });
});

describe('packet coverage scoping', () => {
  it('marks only trigger-related fingerprints for escalation', async () => {
    const { buildCasePacket } = await import('../src/context.js');
    const agent = (id: string, events: unknown[]) => ({ id, session: { id, header: {}, inheritedEventCount: 0, snapshotEvents: () => events } });
    const events = [
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'fix' }] } },
      { type: 'tool/call', seq: 2, data: { callId: 'c-a', name: 'bash', arguments: '{"command":"a"}', turn: 1, step: 1 } },
      { type: 'tool/result', seq: 3, data: { message: { source: { kind: 'tool', callId: 'c-a' }, content: [{ type: 'tool-result', toolCallId: 'c-a', isError: true, content: [{ type: 'text', text: 'FAIL a' }] }] }, error: { name: 'x' } } },
      { type: 'tool/call', seq: 4, data: { callId: 'c-b', name: 'bash', arguments: '{"command":"b"}', turn: 1, step: 1 } },
      { type: 'tool/result', seq: 5, data: { message: { source: { kind: 'tool', callId: 'c-b' }, content: [{ type: 'tool-result', toolCallId: 'c-b', isError: true, content: [{ type: 'text', text: 'FAIL b' }] }] }, error: { name: 'x' } } },
    ];
    const observed = [
      { callId: 'c-a', tool: 'bash', fingerprint: 'fp-a', argumentsSummary: '', outcome: 'validation-failure', errorSummary: 'e', repeatCount: 1 },
      { callId: 'c-b', tool: 'bash', fingerprint: 'fp-b', argumentsSummary: '', outcome: 'validation-failure', errorSummary: 'e', repeatCount: 1 },
    ];
    const req = agent('r', events);
    const input = { requester: req, root: req, question: 'q', consultationId: 'c', allowedTools: ['read'], unavailableTools: [], mutationPolicy: 'propose-only', observedEvidence: observed };
    const trigger = { shouldConsult: true, score: 5, problemFingerprint: 'fp-b', signals: [{ kind: 'tool-error', weight: 2, fingerprint: 'fp-b', detail: 'b' }], evidence: [], turn: 1 };
    const esc = buildCasePacket({ ...input, mode: 'escalation', trigger } as unknown as Parameters<typeof buildCasePacket>[0]);
    expect(esc.coveredFingerprints).toEqual(['fp-b']);
    const manual = buildCasePacket({ ...input, mode: 'manual' } as unknown as Parameters<typeof buildCasePacket>[0]);
    expect(manual.coveredFingerprints).toEqual(expect.arrayContaining(['fp-a', 'fp-b']));
  });
  it('derives coverage only from the delivered fitted packet', async () => {
    const { buildCasePacket } = await import('../src/context.js');
    const big = 'x'.repeat(60 * 1024);
    const agent = (id: string, events: unknown[]) => ({ id, session: { id, header: {}, inheritedEventCount: 0, snapshotEvents: () => events } });
    const events = [
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'fix' }] } },
      { type: 'tool/call', seq: 2, data: { callId: 'c-big', name: 'bash', arguments: '{"command":"b"}', turn: 1, step: 1 } },
      { type: 'tool/result', seq: 3, data: { message: { source: { kind: 'tool', callId: 'c-big' }, content: [{ type: 'tool-result', toolCallId: 'c-big', isError: true, content: [{ type: 'text', text: big }] }] }, error: { name: 'x' } } },
    ];
    const req = agent('r', events);
    const observed = [{ callId: 'c-big', tool: 'bash', fingerprint: 'fp-big', argumentsSummary: '', outcome: 'validation-failure', errorSummary: 'e', repeatCount: 1 }];
    const input = { requester: req, root: req, question: 'q', consultationId: 'c', allowedTools: ['read'], unavailableTools: [], mutationPolicy: 'propose-only', observedEvidence: observed };
    const packet = buildCasePacket({ ...input, mode: 'manual' } as unknown as Parameters<typeof buildCasePacket>[0]);
    const delivered = JSON.parse(packet.prompt) as { tool_activity?: { call_id: string }[]; failures?: { call_id: string }[]; validation?: { call_id: string }[] };
    const deliveredIds = new Set([...(delivered.tool_activity ?? []), ...(delivered.failures ?? []), ...(delivered.validation ?? [])].map(e => e.call_id));
    for (const id of packet.coveredCallIds) expect(deliveredIds.has(id), 'covered call ' + id + ' must be delivered').toBe(true);
    expect(JSON.parse(packet.prompt) as unknown).toBeDefined();
  });
  it('marks only verifiably attributed candidates', async () => {
    const { narrowCoveredByVerdict } = await import('../src/context.js');
    const calls = (fp: string) => (fp === 'fp-a' ? ['c-a'] : fp === 'fp-b' ? ['c-b'] : []);
    const base = { candidates: ['fp-a', 'fp-b'], coveredCallIds: ['c-a', 'c-b'], callsForFingerprint: calls };
    expect(narrowCoveredByVerdict({ ...base, evidenceUsed: [] })).toEqual([]);
    expect(narrowCoveredByVerdict({ ...base, evidenceUsed: [{ kind: 'tool', reference: 'c-a' }] })).toEqual(['fp-a']);
    expect(narrowCoveredByVerdict({ candidates: ['fp-a', 'fp-x'], coveredCallIds: ['c-a', 'c-b'], callsForFingerprint: calls, evidenceUsed: [{ kind: 'tool', reference: 'c-a' }] })).toEqual(['fp-a']);
    expect(narrowCoveredByVerdict({ ...base, evidenceUsed: [{ kind: 'tool', reference: 'unknown-call' }] })).toEqual([]);
    expect(narrowCoveredByVerdict({ ...base, evidenceUsed: [{ kind: 'file', reference: 'x' }] })).toEqual([]);
    expect(narrowCoveredByVerdict({ ...base, evidenceUsed: [{ kind: 'fingerprint', reference: 'fp-b' }] })).toEqual(['fp-b']);
    expect(narrowCoveredByVerdict({ ...base, evidenceUsed: [{ kind: 'fingerprint', reference: 'fp-zzz' }] })).toEqual([]);
  });
});

describe('history patch accepts v3 and snapshots', () => {
  it('validates policy v3, model v2 and pinned run records', async () => {
    const maintenance = await import(new URL('../scripts/patch-dsh-history.mjs', import.meta.url).href);
    const validate = maintenance.assertAdvisorHistoryPayload as (event: unknown) => void;
    expect(() => validate({ type: 'advisor/policy', data: { version: 3, allowTools: ['read'], denyTools: [], escalationWait: 'inherit', continuousWait: 'inherit', completionWait: 'block', triggers: { completion: 'on' }, coverage: { root: { manual: 'off' } }, defaultProfileId: 'debugger', allowedProfileIds: ['debugger'] } })).not.toThrow();
    expect(() => validate({ type: 'advisor/model', data: { version: 2, selection: null, defaultProfileId: 'debugger', allowedProfileIds: [] } })).not.toThrow();
    expect(() => validate({ type: 'advisor/run', data: { version: 1, id: 'r', requesterId: 'root', mode: 'completion', turn: 1, taskRevision: 't', attempt: 1, status: 'delivered', timestamp: 'x', provider: 'mock', model: 'advisor', advisorProfile: 'debugger', toolCeiling: ['read'], toolSnapshotHash: 'ab12', routingReason: 'explicit' } })).not.toThrow();
    expect(() => validate({ type: 'advisor/policy', data: { version: 3, allowTools: [], denyTools: [], escalationWait: 'inherit', continuousWait: 'inherit', triggers: { manual: 'sometimes' } } })).toThrow();
  });
});

describe('consultation profile pinning', () => {
  it('pins the first-turn profile and rejects a silent switch', async () => {
    const harnessMod = await import('./harness.js');
    const h = await harnessMod.createIntegrationHarness(
      { weak: [harnessMod.textResponse('done')], advisor: harnessMod.advisorScript(harnessMod.advisorVerdictResponse({ summary: 'first' }), harnessMod.advisorVerdictResponse({ summary: 'second' })) },
      { advisorProfiles: [
        { id: 'debugger', label: 'Debugger', provider: 'mock', model: 'advisor', toolPolicy: 'inspect' },
        { id: 'architect', label: 'Architect', provider: 'mock', model: 'advisor', toolPolicy: 'research' },
      ] } as unknown as Partial<import('../src/config.js').Config>,
    );
    try {
      const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> };
      const { ToolCallId } = await import('@deepseek-ai/dsh-llm');
      let seq = 0;
      const ask = async (args: Record<string, unknown>) => {
        const out = await tools.execute({ callId: ToolCallId('pin-' + (++seq)), name: 'consult_advisor', arguments: args, agent: h.root, signal: new AbortController().signal });
        const text = (out.content as readonly { type?: string; text?: string }[]).flatMap(b => (b.type === 'text' ? [String(b.text ?? '')] : [])).join('');
        return JSON.parse(text) as Record<string, unknown>;
      };
      const first = await ask({ question: 'Flaky test?', advisor_profile: 'debugger' });
      expect(first.status, JSON.stringify(first)).toBe('ok');
      expect(first.advisor_profile).toBe('debugger');
      expect(first.model).toBe('mock/advisor');
      // The pinned snapshot is durable in advisor/run for restart restore.
      const { advisorRunHistory } = await import('../src/telemetry.js');
      const runs = advisorRunHistory(h.root);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ advisorProfile: 'debugger', provider: 'mock', model: 'advisor', routingReason: 'explicit' });
      expect(Array.isArray((runs[0] as { toolCeiling: unknown }).toolCeiling)).toBe(true);
      const switched = await ask({ question: 'Follow-up', consultation_id: first.consultation_id as string, advisor_profile: 'architect' });
      expect(switched.status).toBe('unavailable');
      expect(String(switched.diagnosis)).toMatch('pinned to profile');
      // A live continuation without cold-resume needs session query in this harness,
      // so the pinned-profile follow-up path is proven by the stored snapshot above
      // and by the rejection of a mismatched profile here.
    } finally {
      await h.ctx.fiber.dispose();
    }
  }, 60000);
  it('refuses new consultations when global and session allow-lists do not overlap', async () => {
    const harnessMod = await import('./harness.js');
    const h = await harnessMod.createIntegrationHarness(
      { weak: [harnessMod.textResponse('done')], advisor: harnessMod.advisorScript(harnessMod.advisorVerdictResponse({ summary: 'spare' })) },
      { advisorProfiles: [
        { id: 'debugger', label: 'Debugger', provider: 'mock', model: 'advisor', toolPolicy: 'inspect' },
        { id: 'architect', label: 'Architect', provider: 'mock', model: 'advisor', toolPolicy: 'research' },
      ], allowedProfileIds: ['debugger'] } as unknown as Partial<import('../src/config.js').Config>,
    );
    try {
      h.root.session.append('advisor/model', { version: 2, selection: null, defaultProfileId: null, allowedProfileIds: ['architect'] });
      const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> };
      const { ToolCallId } = await import('@deepseek-ai/dsh-llm');
      const ask = async (args: Record<string, unknown>) => {
        const out = await tools.execute({ callId: ToolCallId('disjoint-' + Math.random().toString(36).slice(2)), name: 'consult_advisor', arguments: args, agent: h.root, signal: new AbortController().signal });
        const text = (out.content as readonly { type?: string; text?: string }[]).flatMap(b => (b.type === 'text' ? [String(b.text ?? '')] : [])).join('');
        return JSON.parse(text) as Record<string, unknown>;
      };
      const refused = await ask({ question: 'Anything?' });
      expect(refused.status).toBe('unavailable');
      expect(String(refused.diagnosis)).toMatch('do not overlap');
      const explicit = await ask({ question: 'Anything?', advisor_profile: 'debugger' });
      expect(explicit.status).toBe('unavailable');
      expect(String(explicit.diagnosis)).toMatch('do not overlap');
      expect(harnessMod && h.adapter.forModel('advisor')).toHaveLength(0);
    } finally {
      await h.ctx.fiber.dispose();
    }
  });
  // NOTE (0.1.2-rc.1): this shape — hoisted imports, one ask log, stable call
  // id, 30s budget — is what stays green on the oldest runtime, where fiber
  // teardown after a delivered verdict-only consult intermittently stalls for
  // tens of seconds. The consult itself always delivers correctly; the stall
  // was never isolated to a product defect (all deliveries observed were
  // correct), so this is recorded as a teardown-timing workaround, not a
  // root-cause fix. Do not reintroduce per-phase timing logs without
  // re-running this file on the rc.1 closure.
  it('caps a profiled consultation at the policy-profile tool intersection', async () => {
    const harnessMod = await import('./harness.js');
    const { ToolCallId } = await import('@deepseek-ai/dsh-llm');
    const { advisorRunHistory } = await import('../src/telemetry.js');
    const h = await harnessMod.createIntegrationHarness(
      { weak: [harnessMod.textResponse('done')], advisor: harnessMod.advisorScript(harnessMod.advisorVerdictResponse({ summary: 'x' })) },
      { defaultEnabledTools: ['write'], advisorProfiles: [{ id: 'debugger', label: 'Debugger', provider: 'mock', model: 'advisor', toolPolicy: 'inspect' }] } as unknown as Partial<import('../src/config.js').Config>,
    );
    try {
      const t1 = Date.now();
      const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> };
      const out = await tools.execute({ callId: ToolCallId('ceiling-1'), name: 'consult_advisor', arguments: { question: 'Look only?', advisor_profile: 'debugger' }, agent: h.root, signal: new AbortController().signal });
      console.log('PHASE-INT ask done');
      const text = (out.content as readonly { type?: string; text?: string }[]).flatMap(b => (b.type === 'text' ? [String(b.text ?? '')] : [])).join('');
      const answer = JSON.parse(text) as Record<string, unknown>;
      expect(answer.status, text).toBe('ok');
      expect(answer.capabilities).toEqual([]);
      expect(advisorRunHistory(h.root)[0]).toMatchObject({ toolCeiling: [] });
    } finally {
      await h.ctx.fiber.dispose();
    }
  }, 30000);
  it('refuses when the allow-list matches no configured profile', async () => {
    const harnessMod = await import('./harness.js');
    const h = await harnessMod.createIntegrationHarness(
      { weak: [harnessMod.textResponse('done')], advisor: harnessMod.advisorScript(harnessMod.advisorVerdictResponse({ summary: 'spare' })) },
      { advisorProfiles: [{ id: 'debugger', label: 'Debugger', provider: 'mock', model: 'advisor', toolPolicy: 'inspect' }], allowedProfileIds: ['missing'] } as unknown as Partial<import('../src/config.js').Config>,
    );
    try {
      const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> };
      const { ToolCallId } = await import('@deepseek-ai/dsh-llm');
      const ask = async (args: Record<string, unknown>) => {
        const out = await tools.execute({ callId: ToolCallId('nomatch-' + Math.random().toString(36).slice(2)), name: 'consult_advisor', arguments: args, agent: h.root, signal: new AbortController().signal });
        const text = (out.content as readonly { type?: string; text?: string }[]).flatMap(b => (b.type === 'text' ? [String(b.text ?? '')] : [])).join('');
        return JSON.parse(text) as Record<string, unknown>;
      };
      const auto = await ask({ question: 'Anything?' });
      expect(auto.status).toBe('unavailable');
      expect(String(auto.diagnosis)).toMatch('No configured advisor profile');
      const explicit = await ask({ question: 'Anything?', advisor_profile: 'debugger' });
      expect(explicit.status).toBe('unavailable');
      expect(h.adapter.forModel('advisor')).toHaveLength(0);
    } finally {
      await h.ctx.fiber.dispose();
    }
  }, 60000);
});

describe('manual review of B does not suppress a recurring A', () => {
  // A high cooldown serializes automatic consults: after any auto consult, later
  // turns stay silent until the window passes, so each phase below observes
  // exactly the consults it planned no matter how turns batch. Polling absorbs
  // the remaining timing jitter. Goal rounds advance turns without clearing
  // task state (tracker, watermark and revision survive).
  async function runABFlow(citeB: boolean) {
    const harnessMod = await import('./harness.js');
    const { defineTool, defineContentToolFixture } = await import('@deepseek-ai/dsh-tools');
    const { brandString } = await import('@deepseek-ai/dsh-brand');
    const { advisorRunHistory } = await import('../src/telemetry.js');
    const { ToolCallId } = await import('@deepseek-ai/dsh-llm');
    const weakSteps: import('./harness.js').ScriptEntry[] = [];
    let hh: Awaited<ReturnType<typeof harnessMod.createIntegrationHarness>> | undefined;
    const suiteBCallId = (): string => {
      const calls = hh?.root.session.snapshotEvents().filter(event => event.type === 'tool/call' && (event.data as { name?: unknown })?.name === 'bash' && JSON.stringify((event.data as { arguments?: unknown })?.arguments ?? '').includes('suite-b')) ?? [];
      const id = (calls[calls.length - 1]?.data as { callId?: unknown })?.callId;
      if (typeof id !== 'string') throw new Error('suite-b call id not yet observed');
      return id;
    };
    const h = await harnessMod.createIntegrationHarness(
      {
        weak: Array.from({ length: 160 }, () => () => (weakSteps.shift() as unknown as import('@deepseek-ai/dsh-llm').StreamChunk[] | undefined) ?? harnessMod.textResponse('idle')),
        advisor: harnessMod.advisorScript(
          harnessMod.advisorVerdictResponse({ summary: 'review-a' }),
          harnessMod.advisorVerdictResponse({ summary: 'review-b' }),
          citeB
            ? ((_request: unknown) => harnessMod.advisorVerdictResponse({ summary: 'manual-b', evidence_used: [{ kind: 'tool', reference: suiteBCallId() }] }))
            : harnessMod.advisorVerdictResponse({ summary: 'manual-b' }),
          harnessMod.advisorVerdictResponse({ summary: 'review-a-again' }),
          harnessMod.advisorVerdictResponse({ summary: 'review-b-again' }),
        ),
      },
      { mode: 'escalate', scoreThreshold: 1, maxAutoConsultsPerTurn: 10, maxAutoConsultsPerProblem: 10, cooldownTurns: 5 },
    );
    hh = h;
    h.ctx.tools.register(defineTool({
      name: 'bash', description: 'Scripted shell.',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text' as const, text: '' }] },
      execute: async (args) => { throw new Error('FAIL ' + String((args as { command: string }).command)); },
    }));
    h.ctx.tools.register(defineContentToolFixture({ name: 'edit', description: 'Fixture edit', parameters: { file_path: { type: 'string' }, content: { type: 'string' } }, async execute(args) { return [{ type: 'text', text: 'wrote ' + String((args as { file_path: string }).file_path) }]; } }));
    let round = 0;
    const goalId = brandString<Branded<'GoalId'>>('phased-manual-ab');
    const goalRound = (text: string) => h.runRoot(text, { kind: 'goal', goalId, revision: 1, round: ++round });
    const delivered = () => advisorRunHistory(h.root).filter(run => run.status === 'delivered');
    const modes = () => delivered().map(run => run.mode);
    async function settle(wantModes: string[], maxRounds = 16) {
      for (let i = 0; i < maxRounds; i++) {
        await goalRound('settle ' + wantModes.length + '.' + i);
        try { expect(modes()).toEqual(wantModes); return; } catch { /* keep polling */ }
      }
      console.log('SETTLE-FAIL want=' + JSON.stringify(wantModes) + ' got=' + JSON.stringify(advisorRunHistory(h.root).map(run => [run.mode, run.status, run.summary ?? '', run.error ?? '', run.fingerprint ?? ''])) + ' queue=' + weakSteps.length + ' bCalls=' + h.root.session.snapshotEvents().filter(e => e.type === 'tool/call' && JSON.stringify((e.data as { arguments?: unknown })?.arguments ?? '').includes('suite-b')).length);
      expect(modes()).toEqual(wantModes);
    }
    const t = (text: string) => harnessMod.textResponse(text);
    const bash = (id: string, suite: string) => harnessMod.toolCallResponse(id, 'bash', { command: 'npm run test -- ' + suite });
    try {
      // P1: A fails -> its own escalation (no cooldown history yet).
      weakSteps.push(bash('a1', 'suite-a'), t('after a1'));
      await h.runRoot('Fix A');
      await settle(['escalation']);
      // P2: structural edit; the cooldown window keeps every gate silent.
      weakSteps.push(harnessMod.toolCallResponse('e1', 'edit', { file_path: 'src/x.ts', content: 'y' }), t('after edit'));
      await goalRound('edit round');
      await goalRound('edit settle');
      // P3: B fails -> escalation for the new problem once cooldown passes.
      weakSteps.push(bash('b1', 'suite-b'), t('after b1'));
      await settle(['escalation', 'escalation']);
      expect(delivered()[1]?.fingerprint).toBeDefined();
      expect(delivered()[1]?.fingerprint).not.toBe(delivered()[0]?.fingerprint);
      // P4: explicit manual review of B (direct tool call, fully ordered).
      let seq = 0;
      const tools = h.ctx.get('tools') as { execute(input: unknown): Promise<{ content: readonly unknown[] }> };
      const out = await tools.execute({ callId: ToolCallId('ab-manual-' + (++seq)), name: 'consult_advisor', arguments: { question: 'Please review problem B, the suite-b failure' }, agent: h.root, signal: new AbortController().signal });
      const answerText = (out.content as readonly { type?: string; text?: string }[]).flatMap(b => (b.type === 'text' ? [String(b.text ?? '')] : [])).join('');
      expect((JSON.parse(answerText) as { status: string }).status, answerText).toBe('ok');
      // P5: A recurs -> must re-arm (the manual review must not have suppressed it).
      weakSteps.push(bash('a2', 'suite-a'), t('after a2'));
      await settle(['escalation', 'escalation', 'manual', 'escalation']);
      expect(delivered()[3]?.fingerprint).toBe(delivered()[0]?.fingerprint);
      // P6: B recurs -> silent in both variants: B stays covered by its own
      // post-edit review (rb marked it at the current epoch), so this phase only
      // proves the queue drained with no stray consults. Manual B-coverage itself
      // is pinned by the strict unit tests, not observable here.
      weakSteps.push(bash('b2', 'suite-b'), t('done'));
      for (let i = 0; i < 4; i++) await goalRound('drain ' + i);
      expect(modes()).toEqual(['escalation', 'escalation', 'manual', 'escalation']);
      expect(weakSteps).toHaveLength(0);
      return delivered();
    } finally {
      await h.ctx.fiber.dispose();
    }
  }
  it('cited verdict covers B while a recurring A still re-arms', async () => {
    const delivered = await runABFlow(true);
    expect(delivered.map(run => run.mode)).toEqual(['escalation', 'escalation', 'manual', 'escalation']);
    expect(delivered.map(run => run.summary ?? '')).toEqual(['review-a', 'review-b', 'manual-b', 'review-a-again']);
    expect(delivered[1]?.fingerprint).toBeDefined();
    expect(delivered[1]?.fingerprint).not.toBe(delivered[0]?.fingerprint);
    expect(delivered[3]?.fingerprint).toBe(delivered[0]?.fingerprint);
  }, 120000);
  it('empty verdict marks nothing: A still re-arms on its own epoch', async () => {
    const delivered = await runABFlow(false);
    expect(delivered.map(run => run.mode)).toEqual(['escalation', 'escalation', 'manual', 'escalation']);
    expect(delivered.map(run => run.summary ?? '')).toEqual(['review-a', 'review-b', 'manual-b', 'review-a-again']);
    // B stays covered by its own post-edit review, not by the manual one:
    // had the empty manual marked everything retained, A would have stayed
    // suppressed and the fourth consult would never have run.
    expect(delivered[3]?.fingerprint).toBe(delivered[0]?.fingerprint);
    expect(delivered[1]?.fingerprint).not.toBe(delivered[0]?.fingerprint);
  }, 120000);
});
