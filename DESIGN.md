# Advisor execution and permission design

## Advisor is a visible DSH child session

Advisor work is not a hidden auxiliary LLM request. Each consultation starts a session-backed DSH child beneath the **exact requesting agent**, so the user can inspect who asked, the Advisor transcript, tool calls, token use, and outcome.

The implementation deliberately uses a **fresh one-shot child per consultation**. This gives every review a clean evidence boundary and avoids ordinary continuable-child settlement notices waking a parent when a background review finds `severity=none`. Session reuse should only be added behind an explicit strategy whose notification behavior remains correct.

## Agent-tree coverage

Advisor distinguishes three DSH agent roles:

- `root` — the main/root task agent;
- `local-subagent` — a non-Advisor DSH child participating in the normal Agent/tool lifecycle;
- `advisor` — a one-shot child whose descriptor label starts with `Advisor · `.

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

Low-severity continuous findings are injected only for root. An ephemeral worker that is already allowed to finish may never consume an injected note; only material concern/blocker findings steer a worker into another step.

## Task-tree budget and concurrency

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
  denyTools: string[]
  escalationWait: 'inherit' | 'block' | 'background'
  continuousWait: 'inherit' | 'block' | 'background'
}
```

Changing global defaults therefore continues to affect tools the root session never explicitly touched.

## UI behavior

Settings configures:

- model/provider;
- mode;
- main-agent vs local-subagent coverage for manual/escalation/continuous;
- global default tool switches;
- root wait behavior;
- per-agent manual budget, task-tree total budget, and task-tree concurrency.

A root conversation gets an **Advisor** header action. It enumerates that root session's actual tool schemas and renders one switch per tool. The resulting allowlist is the ceiling inherited by local descendants. Subagent conversations do not get a separate permission editor in this version.

## Enforcement

Prompt text is not the permission boundary.

1. Before creating an Advisor child, the root effective allowlist is intersected with the requesting agent's visible tools and passed as DSH `toolFilter.allow`.
2. A `tools/pre-execute` guard recognizes Advisor children and repeats the root-policy + requester-visibility check at execution time.

The second layer closes the gap where child-scoped tools are not covered by a global-tool restriction. `structured_output` and PTC `run_code` are internal runtime exceptions. `consult_advisor` is never exposed to an Advisor child.

## External provider boundary

This feature covers local DSH Agents. External product subagent providers that run their own process/session (for example standalone Codex, Claude Code, or ACP providers) do not automatically receive `consult_advisor`, DSH tool interception, or these lifecycle hooks. Supporting those providers requires a separate product bridge rather than pretending they are local DSH agents.

## Editing while another agent continues

`edit`, `write`, shells, MCP mutation tools, and similar capabilities are default-off. Users can explicitly enable them.

Background + mutating Advisor access is inherently racy because the root Advisor and primary agent can share a workspace. Local-subagent automatic reviews are forced blocking, which reduces one class of concurrent mutation race. A future version can add workspace leases/serialization if real usage shows that concurrent Advisor edits are desirable.
