// Named Advisor profiles: human-approved model routes the weak model may select.
// The plugin stores only route IDs; auth stays with the DSH provider system.

export const ADVISOR_TOOL_POLICIES = ['inspect', 'research', 'edit', 'custom'] as const;
export type AdvisorToolPolicy = (typeof ADVISOR_TOOL_POLICIES)[number];

export interface AdvisorProfile {
  id: string;
  label: string;
  description?: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  toolPolicy: AdvisorToolPolicy;
  /** Only used when toolPolicy === 'custom'. */
  allowedTools?: string[];
}

export const PROFILE_TOOL_PRESETS: Record<Exclude<AdvisorToolPolicy, 'custom'>, string[]> = {
  inspect: ['read', 'read_image', 'glob', 'grep'],
  research: ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'],
  edit: ['read', 'read_image', 'glob', 'grep', 'edit', 'write'],
};

export function profileTools(profile: AdvisorProfile): string[] {
  if (profile.toolPolicy === 'custom') return [...(profile.allowedTools ?? [])];
  return [...(PROFILE_TOOL_PRESETS[profile.toolPolicy] ?? PROFILE_TOOL_PRESETS.inspect)];
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim().slice(0, 64);
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return undefined;
  return id;
}

function cleanRoute(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().slice(0, 256);
  return text ? text : undefined;
}

export function parseAdvisorProfile(value: unknown): AdvisorProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const id = cleanId(data.id);
  const provider = cleanRoute(data.provider);
  const model = cleanRoute(data.model);
  if (!id || !provider || !model) return undefined;
  const label = typeof data.label === 'string' && data.label.trim() ? data.label.trim().slice(0, 120) : id;
  const description = typeof data.description === 'string' ? data.description.trim().slice(0, 500) : undefined;
  const toolPolicy: AdvisorToolPolicy = (ADVISOR_TOOL_POLICIES as readonly string[]).includes(typeof data.toolPolicy === 'string' ? data.toolPolicy : '')
    ? (data.toolPolicy as AdvisorToolPolicy)
    : 'inspect';
  const reasoningEffort = typeof data.reasoningEffort === 'string' && data.reasoningEffort.trim()
    ? data.reasoningEffort.trim().slice(0, 64)
    : undefined;
  let allowedTools: string[] | undefined;
  if (toolPolicy === 'custom' && Array.isArray(data.allowedTools)) {
    const seen = new Set<string>();
    allowedTools = [];
    for (const raw of data.allowedTools) {
      if (typeof raw !== 'string') continue;
      const name = raw.trim().slice(0, 160);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      allowedTools.push(name);
      if (allowedTools.length >= 64) break;
    }
  }
  return {
    id, label, provider, model, toolPolicy,
    ...(description ? { description } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  };
}

export function parseAdvisorProfiles(value: unknown): AdvisorProfile[] {
  if (!Array.isArray(value)) return [];
  const out: AdvisorProfile[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, 32)) {
    const profile = parseAdvisorProfile(entry);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    out.push(profile);
  }
  return out;
}

export function profileById(profiles: readonly AdvisorProfile[], id: string): AdvisorProfile | undefined {
  return profiles.find(profile => profile.id === id);
}

/** Profiles the current root task may use. Empty allow-list means every configured profile. */
export function allowedProfilesForTask(profiles: readonly AdvisorProfile[], allowedProfileIds: readonly string[]): AdvisorProfile[] {
  if (allowedProfileIds.length === 0) return [...profiles];
  const allowed = new Set(allowedProfileIds);
  return profiles.filter(profile => allowed.has(profile.id));
}

export type AdvisorTriggerKind = 'manual' | 'escalation' | 'completion' | 'continuous';

/**
 * Combine the global and session profile allow-lists. Empty on both sides means
 * unconstrained (every profile). A non-empty intersection of two non-empty lists
 * that is itself empty means NO profile is available — this must refuse routing,
 * never fall back to "allow all" (allowedProfilesForTask interprets [] as all).
 */
export function effectiveAllowedProfiles(globalAllowed: readonly string[], sessionAllowed: readonly string[]): { constrained: boolean; allowed: string[] } {
  const global = [...new Set(globalAllowed)]
  const session = [...new Set(sessionAllowed)]
  if (global.length === 0 && session.length === 0) return { constrained: false, allowed: [] }
  if (global.length === 0) return { constrained: true, allowed: session }
  if (session.length === 0) return { constrained: true, allowed: global }
  return { constrained: true, allowed: global.filter(id => session.includes(id)) }
}

/** Tool ceiling for a profiled consultation: always the intersection. Empty means verdict-only. */
export function intersectToolCeiling(policyAllowedTools: readonly string[], profile: AdvisorProfile): string[] {
  const tools = new Set(profileTools(profile))
  return [...new Set(policyAllowedTools.filter(tool => tools.has(tool)))]
}
export interface ProfileRouteTable {
  manual?: string;
  escalation?: string;
  completion?: string;
  continuous?: string;
}

export function parseProfileRoutes(value: unknown): ProfileRouteTable {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const data = value as Record<string, unknown>;
  const out: ProfileRouteTable = {};
  for (const key of ['manual', 'escalation', 'completion', 'continuous'] as const) {
    const id = cleanId(data[key]);
    if (id) out[key] = id;
  }
  return out;
}

/** Resolve the profile for a NEW consultation only. Continuations reuse their snapshot. */
export function resolveProfileForNewConsultation(args: {
  profiles: readonly AdvisorProfile[];
  allowedProfileIds: readonly string[];
  defaultProfileId: string;
  routes: ProfileRouteTable;
  explicitProfileId?: string;
  trigger: AdvisorTriggerKind;
}): AdvisorProfile | undefined {
  const allowed = allowedProfilesForTask(args.profiles, args.allowedProfileIds);
  if (allowed.length === 0) return undefined;
  if (args.explicitProfileId) return allowed.find(profile => profile.id === args.explicitProfileId);
  const routed = args.routes[args.trigger];
  if (routed) {
    const match = allowed.find(profile => profile.id === routed);
    if (match) return match;
  }
  if (args.defaultProfileId) {
    const match = allowed.find(profile => profile.id === args.defaultProfileId);
    if (match) return match;
  }
  return allowed[0];
}

export function describeProfilesForPrompt(profiles: readonly AdvisorProfile[]): string {
  if (profiles.length === 0) return '';
  const lines = ['Available advisors:'];
  for (const profile of profiles.slice(0, 16)) {
    lines.push('');
    lines.push(profile.id);
    lines.push(profile.description || profile.label);
  }
  return lines.join('\n');
}
