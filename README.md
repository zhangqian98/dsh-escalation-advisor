# dsh-escalation-advisor

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Release](https://img.shields.io/github/v/release/zhangqian98/dsh-escalation-advisor?include_prereleases&color=4D6BFE)](https://github.com/zhangqian98/dsh-escalation-advisor/releases)
[![CI](https://github.com/zhangqian98/dsh-escalation-advisor/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangqian98/dsh-escalation-advisor/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-4D6BFE)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-4D6BFE)](LICENSE)

**English** · [简体中文](README.zh-CN.md)

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

## Install

This release supports **DSH `0.1.2-rc.1`, `0.1.5-alpha.2`, and `0.1.5-rc.1`**. All three pass the integration suite; `0.1.2-rc.1` has also been checked in an installed DSH Web profile with real Codex models. Development and CI lock the complete runtime dependency tree to `0.1.5-alpha.2`; other prereleases are not claimed as compatible. CI checks Node 22.19 and 24. DSH `0.1.5-rc.1` migrates supported older session files to V3 while retaining their original files; back up histories before upgrading.

**Existing Advisor histories on DSH `0.1.5-rc.1`:** the released core's frozen migration inventory does not include plugin events. Before opening an older history containing Advisor records, stop DSH, back up the profile and sessions, and run the included maintenance script:

```bash
node scripts/patch-dsh-history.mjs /absolute/path/to/@deepseek-ai/dsh/package.json /absolute/path/to/new-backup-directory
```

This local compatibility patch checks the exact DSH version and original file checksums, backs up two core files, and adds schemas for only `advisor/policy`, `advisor/model`, `advisor/identity`, and `advisor/run`. Their payloads are retained through V0 → V3 migration; other unknown historical types still fail. It also updates the persistence worker's event vocabulary for these four types. Keep Advisor enabled when opening these histories. Reinstalling DSH replaces the local core patch; rerun it for this exact release, and revalidate compatibility before using a different DSH release. The plugin supports both the earlier `tool/code-dispatch*` records and V3's `tool/ptc-dispatch*` records for continuous-review evidence.

Install the exact npm release into the Web profile, then restart DSH:

```bash
dsh plugin --profile web add dsh-escalation-advisor@0.1.0-alpha.26
dsh web
```

The immutable GitHub release tag remains available as a source install:

```bash
dsh plugin --profile web add github:zhangqian98/dsh-escalation-advisor#v0.1.0-alpha.26
```

For a local checkout, build and install the generated tarball rather than linking the source directory:

```bash
npm ci
npm run check
npm pack
dsh plugin --profile web add ./dsh-escalation-advisor-0.1.0-alpha.26.tgz
```

Configure the strong model in **Settings → Plugins → DSH Escalation Advisor**. The plugin stores only provider/model route IDs and reuses authentication already configured in DSH Models.

The header panel's **当前会话模式** chooses **仅主动咨询** (`manual`), **自动升级** (`escalate`), **持续审阅** (`continuous`), or **跟随全局默认** for subsequent reviews in that task tree. All modes retain model-initiated consultation when role coverage permits it. The choice is persisted in the root's `advisor/policy` record, does not change global defaults or other tasks, and is cleared by **全部恢复默认**. Older records without a mode inherit the latest global default.

Mode and its applicable wait policy appear together. Automatic escalation shows its escalation wait setting; continuous review shows its continuous wait setting; manual consultation awaits its tool reply and has no automatic wait selector. Hidden wait preferences are retained when switching modes.

**默认咨询超时（分钟）** in global settings defaults to **10 minutes**. **单次咨询超时（分钟）** in the session panel overrides it for that task tree, or can inherit the global value. The supported range is 1 second to 60 minutes; `timeoutMs` remains the configuration/API unit. This is a total deadline for each attempt, including queueing and generation; retries start a new deadline. Changes apply to subsequently started consultations. Existing explicitly stored global values are retained unless edited, and old session records without a timeout inherit the global default. Resetting the session restores inheritance. Timeout diagnostics identify the consultation's configured limit rather than attributing a local cancellation to the provider.

Both global settings and the conversation-header **Advisor** panel reuse the composer's native `ModelSelect` component, `ModelDirectory` selection interface, and `session.modelCatalog` data for model and reasoning-effort selection. Only the write destination is adapted to Advisor preferences, so the main conversation keeps its own model. Global settings save the default selection; the header panel overrides it for that root task tree. Choosing **Use global defaults** clears the session override. An empty effort follows the selected model's default.

## Visible Advisor sessions

A new consultation creates a fresh continuable child beneath the **exact requesting agent**:

```text
Root
├─ Advisor · manual
└─ Worker A
   └─ Advisor · escalation · turn 3
```

That hierarchy makes it clear who asked the Advisor. Advice is returned only to the agent that triggered the consultation; it never jumps directly from a worker's Advisor to the root agent.

The returned `consultation_id` can be supplied to a later manual `consult_advisor` call to continue the same child conversation with its earlier context. Omitting it starts an independent conversation. The `last` alias resolves only to that requesting agent's most recently delivered manual consultation on the same root task. Automatic escalation and continuous review start fresh consultations rather than silently inheriting an earlier frame. See [DESIGN.md](./DESIGN.md).

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

The Advisor child receives a DSH `toolFilter.allow`. A monotonic `tools.guard` also checks the original tool ceiling, current root policy, and the requester's current visible tools. A host-created invocation nonce identifies the child before its first request; display labels have no authority. Host identity records restore on activation, and descendants inherit the same ceiling.

`subagent`, `subagent_fork`, `subagent_control`, `workflow`, `ralph`, and their reserved variants are always disabled for Advisor. The host also reads trusted Cordis plugin configurations to recognize renamed built-in delegation tools. `capabilityAmplifierTools` adds custom/MCP delegators to the denylist. A child created by an unrecognized local wrapper cannot enter a model step, so it cannot spend unbudgeted model calls. Requester-local tools that do not exist in a fresh spawn scope are reported as unavailable.

`structured_output`, the plugin's own `advisor_verdict` channel, and the PTC transport `run_code` are internal exceptions; the verdict exception covers that single tool name and grants no other permission. `consult_advisor` is never exposed to an Advisor child.

Advisor children present their small allow-list as native tool schemas even when the requesting agent uses PTC. This removes the inherited `run_code` SDK from each Advisor request without changing the requester's presentation mode. The same permission ceiling and execution guard still apply to every call and descendant.

## Model input and output limits

Advisor follows the selected model's DSH configuration and provider defaults. It has no separate input byte cap or output token cap. DSH/provider context limits apply to the full request, including system prompts and tools, and the child explicitly clears any inherited parent output cap before DSH resolves its own model defaults. Legacy `maxInputBytes` and `maxOutputTokens` settings are ignored.

Case packets still select relevant task evidence, summarize individual records, and redact secrets. They are no longer pruned to an independent total byte budget, and generated plain-text output is no longer cut to an Advisor-specific size. Individual evidence sections are bounded by entry count instead: trigger-related evidence is matched by validation identity or failure fingerprint, validation retains at most three unrelated failures and one unrelated success, and the failure list retains four entries. Successful `run_code` wrappers are omitted when their concrete PTC sub-dispatches are present; failed or unfinished wrappers keep only a compact bridge summary. Tool results have one canonical copy in `tool_activity`, while `recent_tail` carries only conversational framing. `failures` and `validation` reference that canonical activity by `call_id` instead of repeating commands and output, and changed paths come only from retained activity. Truncation would hide how much evidence a task actually produced, so the packet also carries a `validation_summary` aggregate (total, retained, omitted, succeeded, failed, other, relevant) describing the pre-cap history. Escalation has no review cursor, so without those caps a long task would resend its whole transcript on every escalation.

Separately, a definite validation failure opens a runtime-only verification obligation. No score reset, cooldown or consultation budget can close or hide it, and a disposition or a correction record does not close it either: only a later pass of the same command in the same scope, after the latest failure and with no related change since, does. Open items are shown as a reminder rather than a block, and the UI reports "no current-run record" after a restart instead of implying everything passed. See DESIGN.md for the closure rules and their limits.

## Task-tree budgets and concurrency

Strong-model usage is bounded at two levels:

- `maxManualConsultsPerSession` — explicit consultation cap per agent/session; default `-1` (no limit).
- `maxAdvisorConsultsPerTask` — shared consultation cap across the live root task tree; default `-1` (no limit).

Both budgets treat a negative value as no limit at all, while `0` means consultations are disabled outright. Set a positive number to bound Advisor spend.
- `maxConcurrentAdvisorRuns` — simultaneous Advisor runs in one root task tree; default `2`.

If multiple workers ask at once, excess consultations queue behind the task-tree concurrency limit. Reservations are refunded if no model request starts, including queued cancellation and authentication configuration failures. A dispatched request consumes budget even when it fails. Automatic transient failures receive at most one delayed retry; only a delivered verdict consumes the problem deduplication allowance.

Each automatic attempt batch retries once. Refunded startup failures remain eligible at later boundaries with exponential backoff capped at 60 seconds, rather than permanently suppressing the problem. Temporarily reserved budget is distinguished from already consumed budget.

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

If any effective Advisor tool is mutating or has unknown effects, its review always blocks and holds an exclusive task-tree workspace lease. Other Advisors and ordinary mutating tool bodies wait for that lease. `readOnlyTools` and `mutatingTools` configure custom tool effects; unknown tools are treated as mutating. A review cannot take an exclusive lease from an ancestor still inside a potentially mutating wrapper; it reports unavailable instead of deadlocking.

## Per-session tool controls

The Web header panel uses a strict DSH Remote API. Opening or refreshing it does not append command/session events. Tool/wait mutations append versioned `advisor/policy` events; model/effort selection appends `advisor/model` version 1. The host validates the selected effort through DSH's model capability API before persisting it. The host rejects child-session policy access, and the client hides the action in children. Tools are collapsed by default. The panel also shows the active usage guidance, trigger, attempt, stale/failure status, task budget, and observed token counts; it reports currency cost as unavailable when no amount is supplied.

Policy version 2 accepts previous unversioned deltas and migrates legacy presets. An old `none` or custom absolute allowlist remains absolute even if global defaults change. Human slash commands remain as an explicit diagnostic fallback and do not become model messages (their command results are logged):

```text
/advisor
/advisor catalog
/advisor reset
/advisor-tool <tool-name> on|off|inherit
```

The root session's tool choices apply as a ceiling to its local descendants.

These DSH builds reject unknown persisted events but do not expose an append option for external-event envelope metadata. A narrowly scoped compatibility bridge adds only `advisor/policy`, `advisor/model`, `advisor/identity`, and `advisor/run` to the tested runtime's event vocabulary while Advisor is loaded. The records remain required, so removing Advisor makes DSH refuse affected histories rather than silently lose permission or identity state. Other unknown events remain rejected. The last Advisor instance restores the original catalog on disposal; future DSH versions require fresh compatibility validation.

## Escalation signals

Each eligible agent gets its **own** escalation tracker. A worker getting stuck does not increase the root agent's score or another worker's score.

Current signals include:

- final tool errors;
- repeated normalized copies of the same failure;
- non-zero process exits;
- repeated mutation of the same target without a successful validation command.

Cancellation, structured permission denials, infrastructure failures, timeouts, and expected negative search/condition exits are excluded from intelligence scoring. Matching validation can clear related failure evidence; unrelated lint/tests cannot clear it or unrelated mutation targets.

`tools/result` only records evidence. In escalate mode the next `agent/pre-step` awaits Advisor before the weak model's next request, with `agent/turn-stopping` retained as a deduplicated fallback. Root background mode remains optional. Manual guidance and the actual tool surface follow current role, coverage, configuration, and tool visibility.

Every run captures the root/requester task revision. Results from an older user request are retained as stale audit records and never steered into the new task.

Usage instructions are contributed to the system prompt under **Strong advisor**. A short **advisor:guidance** runtime-context section also makes availability visible in the conversation's context snapshot. Both follow role, coverage, and actual tool visibility. Advisor children receive their own context rather than copies of the requester's runtime guidance.

Continuous review includes both older PTC `tool/code-dispatch*` records and V3 `tool/ptc-dispatch*` records. It pairs subtools with their observed parent calls, so an internal file write or validation counts as new work even when the outer `run_code` description contains no such keyword. Unrelated dispatch records and nested Advisor consultation transport are excluded.

Advisor injections render directly in the main transcript as full message bubbles labeled **Advisor**, including historical injections and compact transcript mode. This uses DSH's presentation registries: the durable message remains plugin-owned, so rendering it like a chat message does not grant human authority or create another model request. Other plugins retain their native context rendering. The header panel's **咨询记录与回注** section remains a secondary inspection entry and distinguishes model-initiated consultations from automatic failure triggers. New runs also retain their complete reports. Reads do not add session events or invoke the model.

Guidance asks the main model to consult proactively before consequential uncertain decisions, after the first substantive failed validation before a speculative fix, and before completion with unresolved correctness questions. Automatic failure escalation remains a fallback; prompt guidance increases opportunities for model-initiated review but cannot guarantee a particular consultation rate.

## External subagent providers

This coverage applies to **local DSH agents** that participate in the DSH agent/tool lifecycle. External product providers such as standalone Codex/Claude Code/ACP runs are not automatically given `consult_advisor` or these lifecycle hooks; integrating Advisor into those products requires a separate bridge.

## Advisor result

The Advisor child submits its review through the plugin's own `advisor_verdict` tool. That tool is the only authoritative source: a submission is recorded as a candidate and is published only once the run reports `completed` and the child session records a closing turn boundary at or after the submission. A run that never calls it fails explicitly rather than being read from the Advisor's prose. The review includes evidence and any actual changes the Advisor reports:

```json
{
  "severity": "none | nit | concern | blocker",
  "disposition": "revise",
  "summary": "...",
  "diagnosis": "...",
  "next_actions": ["..."],
  "confidence": 0.0,
  "evidence_used": [{ "kind": "file", "reference": "src/example.ts:10" }],
  "assumptions": [],
  "recommended_next_action": "Run the focused validation",
  "validation_plan": ["Run the affected test"],
  "needs_more_evidence": false,
  "changes_made": [{ "paths": ["src/example.ts"], "reason": "...", "validation": ["..."] }]
}
```

A material automatic result is steered only into the requester. `none` does not interrupt; `nit` is held for a naturally occurring next step, without extending a closing turn; concern/blocker findings request verification or correction. A completed child turn whose verdict was never submitted through `advisor_verdict`, or whose closing turn boundary cannot be reconciled with the submission, is a failure rather than a review; prose is never promoted into a verdict. Cancelled, timed-out, or failed turns are not presented as successful reviews.

Nits accepted before new user input are delivered as explicitly historical, optional context on the next normal step. They never instruct the agent to resume the prior task. Background results that arrive after new user intent are rejected by the revision guard.

Reported Advisor changes are always delivered for reconciliation, even if the verdict has no remaining concern. Missing token usage is displayed as unavailable, rather than zero.

Inputs are schema-versioned case packets containing the current task, worker assignment, precise question, hypothesis, paired tool attempts, structured failure evidence, validation, observed changed paths, and the requester's prior advice. Reasoning blocks and `assistant/attempt` text are excluded. Continuous mode includes only activity since the last reviewed sequence and skips an empty delta. Capability policy precedes the packet and is preserved independently of evidence summaries. Changed paths describe observed tool operations, not a fabricated git diff.

Every mode limits automatic log extraction to the current admitted user-task boundary. Late results from earlier calls and unrelated prior-task advice are excluded; an escalation retains only matching current-task advice. Historical optional Advisor notes are not recycled into new case packets.

An active durable DSH goal is resolved from the full goal-event history until explicitly cleared, so user steering does not replace the overarching objective. The evidence boundary still applies to tool outputs and conversation text.

## Security notes

- DSH owns provider authentication; this plugin stores only model route IDs.
- Individual evidence records are summarized and common credential forms are redacted before becoming Advisor prompt text.
- Unknown tools default to off; DSH currently has no universal trusted effect metadata that would let this plugin safely infer arbitrary tools as read-only.
- Tool permission is enforced at execution time, not only described in prompts.
- Local subagents cannot expand the root Advisor permission ceiling or their own visible tool set through Advisor.

## Development

```bash
npm install
npm run check
npm run build
npm run pack:check
```

Tests include real DSH AgentLoop, tool runtime, session invariants, spawn children, and strict Remote Gateway dispatch. Only the model adapter is scripted. These verify lifecycle behavior without requiring provider credentials; live model quality/authentication and a complete production Web deployment remain separate deployment checks.

To run the suite against an existing local installation without changing it (PowerShell):

```powershell
$env:DSH_RUNTIME_PACKAGE_JSON = "$env:APPDATA/npm/node_modules/@deepseek-ai/dsh/package.json"
npx vitest run --config vitest.runtime.config.ts
```

The installed-runtime configuration resolves all DSH imports from that installation. Persistence regressions use each version's actual cold-read validation and check that restored policy, identity, and verdict records survive, while unrelated unknown events still fail.

Release tags use `v<package-version>`. The release workflow checks the tag, runs the suite, builds an npm tarball, attaches it to the GitHub release, and publishes the prerelease under npm's `alpha` dist-tag through npm Trusted Publishing (OIDC). The workflow stores no long-lived npm publishing token.

## License

MIT
