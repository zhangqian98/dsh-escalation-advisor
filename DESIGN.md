# Advisor execution and permission design

## Advisor is a visible DSH child session

Advisor work should not be a hidden auxiliary LLM request. Each consultation starts a session-backed DSH child so the user can open the parent session's subagent catalog and inspect the Advisor transcript, tool calls, token use, and outcome.

The first implementation deliberately uses a **fresh one-shot child per consultation**. This gives every review a clean evidence boundary and lets the parent choose whether to wait for the result. DSH's standard continuable-child manager automatically delivers a settlement notice to the direct parent when an activation finishes; that is useful for ordinary delegated agents but is undesirable for silent/background reviews because even a `severity=none` review can wake the parent. Session reuse will therefore be added only behind an explicit strategy whose parent-notification behavior remains correct.

## Permission layers

Advisor tool access has two layers:

1. **Global defaults** in the `escalation-advisor` settings namespace.
2. **Per-parent-session override** recorded as a latest-wins log-only `advisor/policy` event.

Changing global defaults never rewrites existing explicit session overrides. `/advisor reset` returns a session to inheritance.

The execution boundary is DSH's child `toolFilter.allow`; prompt text is not the permission mechanism.

### Built-in presets

| Preset | Tools | Intent |
| --- | --- | --- |
| `none` | none | reasoning over supplied case packet only |
| `inspect` | `read`, `read_image`, `glob`, `grep` | default repository inspection |
| `research` | inspect + `web_search`, `web_fetch` | repository + public research |
| `edit` | inspect + `edit`, `write` | explicit workspace mutation |
| `custom` | exact user allowlist | advanced / deployment-specific tools |

DSH currently has no general trusted tool-effects metadata. We therefore do not infer read-only vs mutating behavior from arbitrary tool definitions. `bash`, `pwsh`, MCP tools, database tools, browser automation, etc. enter an Advisor child only through an explicit custom allowlist.

`edit` is intentionally opt-in. An Advisor with `edit`/`write` can modify the same workspace as the primary agent, so concurrent edits are possible when that Advisor runs in the background.

## Per-session human controls

These commands execute in DSH's human command plane and do not become model messages:

```text
/advisor
/advisor reset
/advisor-permission inherit|none|inspect|research|edit|custom
/advisor-tools read,grep,glob,...
/advisor-escalation-wait inherit|block|background
/advisor-continuous-wait inherit|block|background
```

The Web client decorates the permission and wait commands as popup selectors. `advisor-tools` remains an advanced exact-name command because arbitrary deployments can register arbitrary tool names.

## When the primary session waits

| Trigger | Default | Rationale |
| --- | --- | --- |
| manual `consult_advisor` | block | it is an explicit tool call whose result is needed by the current step |
| automatic escalation | block | the gate believes the primary model is stuck/wrong; continuing concurrently usually compounds the mistake |
| continuous review | background | preserve throughput; only a material later finding wakes/steers the primary agent |

A session can override the two automatic cases independently. Background Advisor jobs receive their own cancellation signal; they are not tied to the parent turn's signal, but are aborted when the parent agent or plugin is disposed.

## Editing while the primary continues

Background + mutating Advisor tools is allowed only when the user explicitly combines those settings. It is high risk because both agents can edit the same workspace concurrently. A later version should add a stronger UI warning and optional workspace serialization/lease before making this combination easy to select.
