# dsh-escalation-advisor

A DSH-only advisor plugin for running a cheaper primary model most of the time and borrowing a stronger configured DSH model when a second opinion is useful.

The Advisor runs as a **visible DSH child session**, not a hidden LLM request. Users can open the parent session's subagent catalog and inspect the Advisor transcript, tool calls, token use, and final result.

## Modes

- **manual** — exposes `consult_advisor`; no automatic consultations.
- **escalate** — manual consultation plus deterministic stuck/failure scoring. Default.
- **continuous** — manual consultation plus a strong shadow review at natural turn boundaries.

## Install from Git

```bash
dsh plugin --profile web add git+https://github.com/zhangqian98/dsh-escalation-advisor.git
```

Configure the strong model in **Settings → Plugins → DSH Escalation Advisor**. The plugin stores only provider/model route IDs and reuses the authentication already configured in DSH Models.

## Visible Advisor sessions

Each consultation currently creates a fresh one-shot child:

```text
Advisor · manual
Advisor · escalation · turn 4
Advisor · continuous · turn 8
```

DSH Web already exposes session-backed subagent conversations from the parent header's subagent catalog, so users can open the Advisor child and inspect the complete execution record. Fresh children are currently preferred over a reused continuable child because ordinary continuable settlement notices can wake the parent even when a background review finds `severity=none`. See [DESIGN.md](./DESIGN.md).

## Tool permissions: defaults plus per-session toggles

Permissions are modeled as **default on/default off per tool**.

The shipped global defaults enable only:

```text
read
read_image
glob
grep
```

Everything else is default-off, including `edit`, `write`, shell tools, web tools, MCP tools, browser automation, database tools, and arbitrary plugin tools.

In Settings, common tools are shown as global default switches. Unknown/plugin tools can be added by exact name. In an open root session, the **Advisor** control in the conversation header enumerates the tools that session actually has and displays one switch per tool:

- **默认开启** — enabled by global defaults;
- **默认关闭** — disabled unless this session opts in;
- **会话开启** — this session explicitly enabled a default-off tool;
- **会话关闭** — this session explicitly disabled a default-on tool.

Every row can be returned individually to the global default, and the whole session can be reset to inheritance.

The per-session state is stored as two deltas: `allowTools` and `denyTools`. Effective access is:

```text
(global defaultEnabledTools + session allowTools) - session denyTools
```

That means future global-default changes continue to affect tools a session has never explicitly overridden.

### Enforcement

The child receives a DSH `toolFilter.allow` based on its effective permission list. A second `tools/pre-execute` guard also denies Advisor-child tool calls outside the current parent-session policy. This extra guard matters because DSH scoped child tools are not necessarily hidden by a global-tool restriction.

`structured_output` and the PTC transport `run_code` are internal exceptions; `consult_advisor` is never exposed to the Advisor child, preventing recursive consultation.

The requested allowlist is intersected with tools actually visible in the parent session before the child is started, so a default name that is absent from one profile does not make the consultation fail.

## Per-session controls

The Web header panel is the normal control surface. Human slash commands remain as a fallback and do not become model messages:

```text
/advisor
/advisor catalog
/advisor reset
/advisor-tool <tool-name> on|off|inherit
/advisor-escalation-wait inherit|block|background
/advisor-continuous-wait inherit|block|background
```

## When the primary session pauses

Defaults:

| Trigger | Primary behavior |
| --- | --- |
| manual `consult_advisor` | **block** until the child returns |
| automatic escalation | **block** until the child returns |
| continuous review | **background** |

Manual consultation needs its answer immediately. Automatic escalation means the primary model is probably stuck and should normally stop compounding the same mistake. Continuous review is background by default so routine shadow checking does not stall throughput. The two automatic wait policies can be overridden independently per session.

Combining background review with mutating tools is intentionally possible only after the user enables those tools. It can create concurrent edits in the same workspace and should be treated as an advanced configuration.

## Escalation signals

The deterministic gate currently tracks signals including:

- final tool errors;
- repeated normalized copies of the same failure;
- non-zero process exits;
- repeated mutation of the same target without a successful validation command.

Cancellation, approval denial, and permission-style failures are excluded from intelligence scoring. Consultation is deduplicated by problem fingerprint and bounded by per-turn/per-problem budgets and cooldown.

## Advisor result

The child is asked for structured output:

```json
{
  "severity": "none | nit | concern | blocker",
  "summary": "...",
  "diagnosis": "...",
  "next_actions": ["..."],
  "confidence": 0.0
}
```

In blocking automatic modes, a material result is steered into the primary session before it closes. In background mode, a material result later wakes/steers the still-live parent; `none` remains silent.

## Security notes

- DSH owns provider authentication; this plugin stores only model route IDs.
- Evidence is UTF-8 byte bounded and common credential forms are redacted before becoming Advisor prompt text.
- Unknown tools default to off; DSH currently has no universal trusted effect metadata that would let this plugin safely infer arbitrary tools as read-only.
- Tool permission is enforced at execution time, not only described in prompts.

## Development

```bash
npm install
npm run check
npm run build
```

The visible-session and permission rework is currently in draft PR #1.

## License

MIT
