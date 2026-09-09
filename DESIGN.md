# Advisor execution and permission design

## Advisor is a visible DSH child session

Advisor work should not be a hidden auxiliary LLM request. Each consultation starts a session-backed DSH child so the user can open the parent session's subagent catalog and inspect the Advisor transcript, tool calls, token use, and outcome.

The first implementation deliberately uses a **fresh one-shot child per consultation**. This gives every review a clean evidence boundary and lets the parent choose whether to wait for the result. DSH's standard continuable-child manager automatically delivers a settlement notice to the direct parent when an activation finishes; that is useful for ordinary delegated agents but is undesirable for silent/background reviews because even a `severity=none` review can wake the parent. Session reuse should therefore be added only behind an explicit strategy whose parent-notification behavior remains correct.

## Permission model: defaults plus deltas

The permission truth is not a coarse preset. It is a per-tool effective state:

```text
effective = (global defaultEnabledTools + session allowTools) - session denyTools
```

The shipped global default enables only:

```text
read
read_image
glob
grep
```

Every other tool is default-off. This includes known mutating tools and every unknown/MCP/plugin tool.

A per-parent-session `advisor/policy` event stores only the user's deltas:

```ts
{
  allowTools: string[]
  denyTools: string[]
  escalationWait: 'inherit' | 'block' | 'background'
  continuousWait: 'inherit' | 'block' | 'background'
}
```

This distinction matters. If global defaults later change, a session that never touched a tool inherits the new global value; a session that explicitly toggled that tool keeps its choice.

## UI behavior

### Global settings

Settings shows common tool switches and an exact-name field for additional MCP/plugin tools. It also offers convenience actions such as safe inspection defaults and inspection + web. These actions merely edit `defaultEnabledTools`; they are not a separate permission layer.

### Current session

A root conversation gets an **Advisor** header action. When opened, it asks the Host command plane for the current session's real tool schemas and renders one switch per tool.

Each row has one of four user-visible states:

- default on;
- default off;
- session forced on;
- session forced off.

Toggling a default-off tool on writes it to `allowTools`. Toggling a default-on tool off writes it to `denyTools`. “Default” removes that tool from both override arrays. “Reset all” clears every tool/wait override for the session.

This is how deployment-specific MCP and plugin tools become configurable without hard-coding them in this plugin.

## Enforcement

Prompt text is not the permission boundary.

1. Before creating the child, the effective allowlist is intersected with tools actually visible in the parent session and passed as DSH `toolFilter.allow`.
2. A `tools/pre-execute` guard recognizes Advisor child sessions and denies calls outside the current parent-session allowlist.

The second layer closes the gap where child-scoped tools are not covered by a global-tool restriction. `structured_output` and PTC `run_code` are internal runtime exceptions. `consult_advisor` is intentionally not exposed to an Advisor child.

DSH currently has no universal trusted tool-effects metadata, so this plugin does not infer arbitrary tools as read-only. Unknown tools are simply off until the user enables them.

## When the primary session waits

| Trigger | Default | Rationale |
| --- | --- | --- |
| manual `consult_advisor` | block | the current model step explicitly requested the answer |
| automatic escalation | block | the gate believes the primary model is stuck/wrong; concurrent continuation usually compounds the mistake |
| continuous review | background | preserve throughput; only a material later finding wakes/steers the parent |

The two automatic cases are independently overridable per parent session. Background Advisor jobs have their own cancellation signal and are aborted when the parent agent or plugin is disposed.

## Editing while the primary continues

`edit`, `write`, shells, MCP mutation tools, and similar capabilities are default-off. Users can still enable them globally or for one session.

Background + mutating Advisor access is inherently racy because the Advisor and primary agent share the workspace. The UI should continue to make that combination visibly advanced; a future version can add a workspace lease/serialization option if real usage shows that concurrent Advisor edits are desirable.
