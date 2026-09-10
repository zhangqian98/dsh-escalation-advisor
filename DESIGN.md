# Advisor execution and permission design

## Advisor is a visible DSH child session

Advisor work is not a hidden auxiliary LLM request. Each consultation starts a session-backed DSH child beneath the **exact requesting agent**, so the user can inspect who asked, the Advisor transcript, tool calls, token use, and outcome.

The implementation deliberately uses a **fresh one-shot child per consultation**. This gives every review a clean evidence boundary and avoids ordinary continuable-child settlement notices waking a parent when a background review finds `severity=none`. Session reuse should only be added behind an explicit strategy whose notification behavior remains correct.

### Verdict channel

The Advisor's review is not read from its prose. The plugin registers its own `advisor_verdict` tool host-wide before any child is composed, includes it in the child's tool allow-list regardless of the configurable tool policy, and treats that tool as the only authoritative verdict source. The tool is registered first because `tools.restrict()` rejects an unknown tool name, so a child composed before registration would fail to start rather than silently lose the channel.

A submission is a **candidate**, not a verdict. It is recorded against a consultation keyed by the host-generated consultation id and indexed by child session, and the calling child is resolved from the live agent rather than from anything the model supplies; the invocation identity is checked against the registry's host-created record. The candidate is published only when the run reports `completed` **and** the child session records a closing turn boundary whose seq is at or after the submission. Inbox acceptance, quiescence and a pre-close boundary are not terminal evidence on their own.

A run that ends without a reconciled verdict raises `no_verdict`. Prose is never promoted into an authoritative review, and no approval-shaped fallback object is manufactured. A conflicting second submission is refused rather than overwriting the first; an identical repeat is a duplicate. A consultation that did not publish is closed on the way out, so a late submission resolves to a refusal instead of reviving it.

`advisor_verdict` is an ordinary tool and does not end the turn, unlike the one-shot `structured_output` runtime it replaces. A consultation therefore costs one additional closing model request.
## Agent-tree coverage

Advisor distinguishes three DSH agent roles:

- `root` — the main/root task agent;
- `local-subagent` — a non-Advisor DSH child participating in the normal Agent/tool lifecycle;
- `advisor` — a host-registered invocation identity, or a descendant of that identity. A random invocation nonce is bound to the exact requester before child publication. Labels are presentation only.

Advisor children are always excluded from every coverage path.

Default coverage:

| Capability | root | local-subagent |
| --- | --- | --- |
| manual consultation | on | on |
| automatic escalation | on | on |
| continuous review | on | off |

The asymmetry is intentional. Automatic escalation addresses “the cheap model is stuck,” which can happen inside a worker just as easily as at root. Continuous review is much more expensive and would otherwise scale roughly with the number of active workers.

Every eligible agent owns its own escalation tracker. Signals from Worker A never add to Root or Worker B.

Advisor results return only to the requesting/triggering agent. A worker Advisor never directly steers the root agent. Ordinary DSH parent/child result flow remains the mechanism by which corrected worker output eventually reaches root.

## Wait semantics for local subagents

Manual consultation always blocks the requesting model step.

For automatic modes:

- root escalation follows the root session's configured `escalationWait`;
- root continuous follows `continuousWait`;
- local-subagent escalation is always blocking;
- local-subagent continuous, when explicitly enabled, is always blocking.

A local one-shot worker may settle immediately after `agent/turn-stopping`. Letting its Advisor run in the background would allow stale output to reach the parent before review completes, so background automatic review is root-only.

Low-severity findings are retained for a naturally occurring next root step. Calling `inject()` inside the real DSH stopping hook can extend the current turn, so the plugin uses its own pending-note queue instead. A note already accepted before new user input is explicitly historical and optional when delivered. A result arriving after new intent is stale and never enters that queue. Only material concern/blocker findings steer a worker into another step.

Escalation has two entry points: `tools/result` records structured evidence and `agent/pre-step` consults before the next weak-model request. `agent/turn-stopping` is the fallback. An in-flight reservation plus delivered-fingerprint accounting prevents duplicate calls across both entry points. Automatic temporary failures retry once with backoff; configuration or pre-dispatch failures do not spend model budget.

## Task-tree budget and concurrency

Input context and output limits belong to the selected DSH model. Advisor adds no total byte/token ceiling, and old `maxInputBytes` / `maxOutputTokens` values are inactive. The spawn request explicitly sets `maxTokens: undefined` because omitting that property would inherit the parent's output cap; DSH then materializes the Advisor model's own configured default or leaves the provider default in control. Evidence remains scoped, summarized, and redacted, while complete plain-text Advisor results are preserved.

All Advisor calls under one live root task share a process-local limiter:

```text
Root task
  maxAdvisorConsultsPerTask = 12
  maxConcurrentAdvisorRuns = 2
        |
        +-- Root Advisor
        +-- Worker A Advisor
        +-- Worker B Advisor
```

The task root is found by walking live `parentSession` links through the DSH Agent registry. Calls above the concurrency cap queue FIFO. A queued call aborted before start returns its reserved budget; a call that actually starts consumes budget even if the model later fails.

Manual consultation also retains a per-agent cap (`maxManualConsultsPerSession`, default 8), preventing one worker from spending the whole task budget through explicit calls.

## Permission model: defaults plus deltas

The permission truth is a per-tool effective state:

```text
effective root policy = (global defaultEnabledTools + root session allowTools) - root session denyTools
```

The shipped global default enables only:

```text
read
read_image
glob
grep
```

Every other tool is default-off, including known mutating tools and every unknown/MCP/plugin tool.

For a local subagent, the root policy is a **ceiling**, not a grant:

```text
Advisor tools = root effective policy ∩ requesting agent visible tools
```

This prevents privilege escalation through Advisor. A root session may allow `bash`, but a worker that cannot itself see `bash` cannot obtain it by consulting Advisor.

A per-root-session `advisor/policy` event stores only user deltas:

```ts
{
  allowTools: string[]
  version: 2
  inheritDefaultTools?: boolean // false for migrated absolute legacy presets
  denyTools: string[]
  escalationWait: 'inherit' | 'block' | 'background'
  continuousWait: 'inherit' | 'block' | 'background'
}
```

Changing global defaults therefore continues to affect tools the root session never explicitly touched.

Persisted payloads are runtime-validated. Unversioned allow/deny deltas migrate to version 2; explicit legacy presets retain absolute semantics. Malformed or unknown versions fall back to conservative defaults.

## UI behavior

Settings configures:

- model/provider;
- mode;
- main-agent vs local-subagent coverage for manual/escalation/continuous;
- global default tool switches;
- root wait behavior;
- per-agent manual budget, task-tree total budget, and task-tree concurrency.

A root conversation gets an **Advisor** header action. It enumerates that root session's actual tool schemas and renders one switch per tool. The resulting allowlist is the ceiling inherited by local descendants. Subagent conversations do not get a separate permission editor in this version.

The panel calls the strict `advisor/snapshot`, `advisor/mutate`, and `advisor/selectModel` Remote endpoints. Snapshot reads never append command or session records. Mutations validate the live root and append policy or model records; resetting all preferences resets both. A versioned `advisor/model` record stores the root tree's Advisor model and reasoning effort, independently of the main agent's model. Local workers use that same root selection. Global settings and the header panel reuse the main composer's native `ModelSelect`, `ModelDirectory`, and model catalog, adapting only the persistence destination. Global selection uses the read-only `advisor/validateModel` endpoint before saving settings; both paths validate capabilities through DSH's LLM resolver. Run records are mirrored to the root for UI audit, but case-packet history filters by requester identity so worker advice does not leak into another agent's model context.

The header uses a compact status dot, with tool permissions collapsed initially. Guidance is inspectable in the panel and contributed both as a system section and a short `advisor:guidance` runtime context entry. Role, coverage, and tool visibility control both forms. Requester runtime snapshots are excluded from the Advisor case packet to avoid copying its own invocation guidance into a child.

Advisor replies also appear as full, labeled bubbles in the main transcript. A client-owned Conversation Definition projects automatic injection events and completed manual reports into the native independent message presentation, outside collapsed process groups. Durable events remain plugin-owned; the UI does not manufacture human input or make another model request. Scoped slot overrides render Advisor bubbles and defer other context/steering messages to their existing renderers. The secondary `advisor/review` read endpoint retrieves exact historical injections or retained reports without writing events.

The main model is instructed to ask proactively at consequential uncertain decisions and the first substantive validation failure before a speculative fix. Automatic scoring remains a fallback, and prompt guidance does not imply a measured or guaranteed consultation probability.

## Enforcement

Prompt text is not the permission boundary.

1. Before creating an Advisor child, the root effective allowlist is intersected with the requesting agent's visible tools and passed as DSH `toolFilter.allow`.
2. A monotonic `tools.guard` recognizes registered Advisor identities and repeats the original ceiling + current root-policy + requester-visibility check at execution time.

The second layer closes the gap where child-scoped tools are not covered by a global-tool restriction. Descendants receive the same global restriction and execution guard, and their pre-step is rejected unless their session ID is the originally budgeted Advisor ID. Known delegation tools, including `toolName` aliases from trusted Cordis plugin runtime configurations, are reserved and cannot be enabled. Additional custom/MCP delegators can be classified through `capabilityAmplifierTools`. `structured_output`, the internal `advisor_verdict` channel, and PTC `run_code` are internal runtime exceptions; the verdict exception is scoped to that one tool name and authorizes nothing else. `consult_advisor` is never exposed to an Advisor child.

## External provider boundary

This feature covers local DSH Agents. External product subagent providers that run their own process/session (for example standalone Codex, Claude Code, or ACP providers) do not automatically receive `consult_advisor`, DSH tool interception, or these lifecycle hooks. Supporting those providers requires a separate product bridge rather than pretending they are local DSH agents.

## Editing while another agent continues

`edit`, `write`, shells, MCP mutation tools, and similar capabilities are default-off. Users can explicitly enable them.

Mutating or unknown Advisor tools force blocking and an exclusive task-tree workspace lease. Read-only Advisors and ordinary mutating tool bodies share the other side of that lease; a pending editing review stops further conflicting tool admissions. Known delegation wrappers and the PTC transport are excluded because their leaf tool calls acquire their own leases. An unknown mutating wrapper held by an ancestor is detected and reported unavailable to avoid a recursive lease deadlock. This coordinates participating DSH tools in the live tree, not unrelated OS processes or external product agents.

## Evidence, stale results and verification

Case packets use explicit section priorities, bounded UTF-8 JSON, credential redaction, runtime outcome classifications, and call/result IDs. They retain capabilities independently from truncatable evidence. Validation, failure and activity evidence is additionally bounded by entry count, because escalation has no review cursor and an uncapped delta-derived list would grow with the task rather than with the problem. What is pinned is narrower than "trigger-related": a check is pinned when its validation key matches a trigger signal, and a failure is pinned only when the tracker classified its command as a validation command, so an ordinary non-zero exit that contributed to the trigger can still fall outside the cap. Because a cap silently destroys the count it removes, validation also reports a pre-cap aggregate (`validation_summary`), so a reviewer can tell a task with two checks from one with two hundred even though both packets retain the same number of rows. Continuous packets track a reviewed sequence and omit old activity. A user's root or requester inbox insertion changes the revision before the new message is admitted, closing the gap where an old background review finishes while new intent is queued.

### Verification obligations

A definite validation failure also opens a verification obligation that is independent of the escalation score, the cooldown and the consultation budgets: exhausting any of them can neither close nor hide it. An item is resolved only by a witness — a later pass of the same validation command, in the same scope, whose dispatch and completion both fall after the latest failure, with no related mutation during execution or after the pass. A failure whose command the tracker never classified as a validation command carries no validation key and so cannot be closed automatically. A correction record cannot close anything on its own, and neither can a disposition (`not-applicable` or `accept-risk`), which is recorded but leaves the item open and listed. Obligations surface as pre-step notes when they change and as at most one reminder per revision under a fixed per-task budget, and are always described as a reminder rather than a block. Storage is runtime-only: a restart keeps no record, and an empty list is reported as "no current-run record", never as an all-clear. A contradicted published claim has no automatic detector, so it is created only through the explicit `advisor_obligation` registration entry point.

The witness rule can only exclude changes the plugin observed as tool calls; an edit made outside the session is never detected, so a pass is not proof that nothing else changed.

Packet activity, failures and conversation tail also have a current user-task sequence floor, independently of the continuous review cursor. A result from a call before that floor is excluded even if it arrives later. Before admitting a new user step, the tracker is cleared again so late old-turn failures cannot trigger a review of the new task. Startup failures that never dispatch remain retryable after bounded exponential backoff; temporary budget reservations are not treated as consumed quota.

Versioned `advisor/run` records expose reservations, actual dispatch, retries, failures, stale outcomes, child IDs and observed token usage. These are operational records, not model context. Currency amounts and failed-request usage are not invented when the provider supplies no usable accounting.

Supported DSH versions are `0.1.2-rc.1`, `0.1.5-alpha.2`, and `0.1.5-rc.1`; the development dependency closure stays locked to `0.1.5-alpha.2`. The integration harness mounts real AgentLoop, spawn, scopes, tools, session invariants and Remote Gateway; its model adapter is scripted. The installed-runtime test configuration can resolve the complete DSH runtime from a local installation. Production Web validation on `0.1.2-rc.1` additionally covers a real model consultation, tool-policy mutation, visible child history, and reopening its JSONL log after restart.

The supported builds lack an external-event envelope option on `Session.append`. A compatibility bridge temporarily recognizes only the plugin's four required event types (`advisor/policy`, `advisor/model`, `advisor/identity`, and `advisor/run`) in the tested runtime catalog, with reference-counted disposal. It retains identity and preferences instead of marking them ignorable; histories containing those required records intentionally need Advisor loaded. Other unknown required events still fail closed. This bridge is limited to the tested runtime implementation and must be revisited when DSH exposes an official required-event extension API.

Case packets omit `consult_advisor` transport calls and results from task evidence. The current consultation is still pending by construction, and presenting it as `result-not-observed` can distract the Advisor into diagnosing its own transport. Previously delivered advice remains available through the dedicated `prior_advice` field.
