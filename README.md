# dsh-escalation-advisor

A DSH-only advisor plugin for running cheaper models most of the time and borrowing a stronger DSH model only when a second opinion is useful.

Advisor work runs as a **visible DSH child session**, not a hidden LLM request. Users can open the relevant agent tree and inspect the Advisor transcript, tool calls, token use, and final result.

## Modes and agent coverage

The plugin supports three modes:

- **manual** — exposes `consult_advisor`; no automatic consultation.
- **escalate** — manual consultation plus deterministic stuck/failure scoring. Default.
- **continuous** — manual consultation plus shadow review at natural turn boundaries.

Coverage is configurable independently for the main/root agent and local DSH subagents. Shipped defaults are:

| Capability | Main agent | Local DSH subagents |
| --- | --- | --- |
| Manual `consult_advisor` | on | on |
| Automatic escalation | on | on |
| Continuous review | on | **off** |

Continuous review stays root-only by default so a task with many workers does not multiply strong-model calls by the number of subagents. If local-subagent continuous review is explicitly enabled, it blocks that subagent before settlement so a one-shot worker cannot return stale work before its Advisor finishes.

Advisor children themselves are always excluded from manual consultation, escalation scoring, and continuous review, so consultation cannot recurse.

## Install from Git

```bash
dsh plugin --profile web add git+https://github.com/zhangqian98/dsh-escalation-advisor.git
```

Configure the strong model in **Settings → Plugins → DSH Escalation Advisor**. The plugin stores only provider/model route IDs and reuses authentication already configured in DSH Models.

## Visible Advisor sessions

Each consultation currently creates a fresh one-shot child beneath the **exact requesting agent**:

```text
Root
├─ Advisor · manual
└─ Worker A
   └─ Advisor · escalation · turn 3
```

That hierarchy makes it clear who asked the Advisor. Advice is returned only to the agent that triggered the consultation; it never jumps directly from a worker's Advisor to the root agent.

Fresh children are currently preferred over a reused continuable Advisor because ordinary continuable settlement notices can wake a parent even when a background review finds `severity=none`. See [DESIGN.md](./DESIGN.md).

## Tool permissions: root ceiling plus requester visibility

Permissions are modeled as **default on/default off per tool**.

The shipped global defaults enable only:

```text
read
read_image
glob
grep
```

Everything else is default-off, including `edit`, `write`, shell tools, web tools, MCP tools, browser automation, database tools, and arbitrary plugin tools.

In Settings, common tools are shown as global default switches. Unknown/plugin tools can be added by exact name. In an open root session, the **Advisor** control in the conversation header enumerates the tools that session actually has and displays one switch per tool.

Per-session state is stored as `allowTools` and `denyTools` deltas:

```text
(global defaultEnabledTools + session allowTools) - session denyTools
```

For a local subagent, that root-session policy is only a ceiling. Actual Advisor tools are:

```text
root Advisor allowlist ∩ requesting subagent visible tools
```

A subagent therefore cannot use Advisor as a privilege-escalation path to reach tools the subagent itself could not see.

### Enforcement

The Advisor child receives a DSH `toolFilter.allow`. A second `tools/pre-execute` guard also checks the root task policy and the requesting agent's current visible tool surface.

`structured_output` and the PTC transport `run_code` are internal exceptions. `consult_advisor` is never exposed to an Advisor child.

## Task-tree budgets and concurrency

Strong-model usage is bounded at two levels:

- `maxManualConsultsPerSession` — explicit consultation cap per agent/session; default `8`.
- `maxAdvisorConsultsPerTask` — shared consultation cap across the live root task tree; default `12`.
- `maxConcurrentAdvisorRuns` — simultaneous Advisor runs in one root task tree; default `2`.

If multiple workers ask at once, excess consultations queue behind the task-tree concurrency limit. A queued consultation aborted before it starts does not consume the shared task budget.

## Wait behavior

Defaults:

| Trigger | Main/root agent | Local subagent |
| --- | --- | --- |
| manual `consult_advisor` | block | block |
| automatic escalation | configurable; default block | **block** |
| continuous review | configurable; default background | **block when enabled** |

The forced local-subagent block is intentional: a one-shot worker should not settle and hand old work to its parent while its Advisor is still reviewing it.

Root automatic wait behavior remains configurable per root session:

```text
/advisor-escalation-wait inherit|block|background
/advisor-continuous-wait inherit|block|background
```

## Per-session tool controls

The Web header panel is the normal root-session permission surface. Human slash commands remain as a fallback and do not become model messages:

```text
/advisor
/advisor catalog
/advisor reset
/advisor-tool <tool-name> on|off|inherit
```

The root session's tool choices apply as a ceiling to its local descendants.

## Escalation signals

Each eligible agent gets its **own** escalation tracker. A worker getting stuck does not increase the root agent's score or another worker's score.

Current signals include:

- final tool errors;
- repeated normalized copies of the same failure;
- non-zero process exits;
- repeated mutation of the same target without a successful validation command.

Cancellation, approval denial, and permission-style failures are excluded from intelligence scoring. Consultation is deduplicated by problem fingerprint and bounded by per-turn/per-problem limits and cooldown.

## External subagent providers

This coverage applies to **local DSH agents** that participate in the DSH agent/tool lifecycle. External product providers such as standalone Codex/Claude Code/ACP runs are not automatically given `consult_advisor` or these lifecycle hooks; integrating Advisor into those products requires a separate bridge.

## Advisor result

The Advisor child returns structured output:

```json
{
  "severity": "none | nit | concern | blocker",
  "summary": "...",
  "diagnosis": "...",
  "next_actions": ["..."],
  "confidence": 0.0
}
```

A material automatic result is steered only into the agent whose work triggered the review. Lower-severity continuous notes are injected only for the persistent root agent; ephemeral workers are allowed to finish when the finding is below the configured interruption threshold.

## Security notes

- DSH owns provider authentication; this plugin stores only model route IDs.
- Evidence is UTF-8 byte bounded and common credential forms are redacted before becoming Advisor prompt text.
- Unknown tools default to off; DSH currently has no universal trusted effect metadata that would let this plugin safely infer arbitrary tools as read-only.
- Tool permission is enforced at execution time, not only described in prompts.
- Local subagents cannot expand the root Advisor permission ceiling or their own visible tool set through Advisor.

## Development

```bash
npm install
npm run check
npm run build
```

## License

MIT
