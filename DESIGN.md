# Advisor execution and permission design

## Advisor is a visible DSH child session

Advisor work is not a hidden auxiliary LLM request. Each consultation starts a session-backed DSH child beneath the **exact requesting agent**, so the user can inspect who asked, the Advisor transcript, tool calls, token use, and outcome.

The implementation creates a **fresh continuable child for every new consultation**. A later manual call may explicitly reuse that child by returning the issued `consultation_id`; omitting the id always starts an independent conversation. Automatic escalation and continuous review never choose an earlier conversation implicitly. Continuation authorization is scoped to the exact live requester and root task, and each new turn receives a fresh verdict collector identity.

The child transcript is visible, but the child is **not an open prompt endpoint**: every Advisor turn needs a plugin-created activation (invocation + collector + delivered message + claimed turn, bounded by the attempt deadline). `agent/pre-step` rejects Advisor steps without a live activation, so an idle direct composer prompt or a generic `send_message` into the child is refused before it can spend budget, acquire the workspace lease, or evade `advisor/run` auditing. The guarantee is scoped: between authorization and delivery binding there is a narrow window where admission rests on the unforgeable invocation nonce rather than the exact message (the authorized first step routinely precedes dispatch binding, and rejecting it breaks real consultations — verified by experiment). Closing that remainder needs a host transport that pre-allocates the delivery id; mismatched verdicts are additionally refused at reconciliation, so an unrelated turn can cost model tokens but never publish advice or steer the requester. The delivered message is bound to its activation *before* buffered inbox claims are replayed, so an early claim (one that lands before dispatch resolves) still records its turn instead of being lost; binding without a live reservation fails closed rather than manufacturing authority. Message ids are stable across representations, so once the delivery is bound the gate additionally requires batch purity: every message entering the model step must be the authorized delivery (an empty batch falls back to the turn binding). A foreign message batched into the authorized turn — or tainted onto it by a competing claim — refuses the step before the model sees it. A follow-up reservation names its child and admits no other; a fresh reservation names none, admitting the nonce-bearing child until the delivery binds. That window is load-bearing, not incidental: the authorized first step routinely precedes dispatch resolution in the current runtime, and rejecting it breaks real consultations (rejections are destructive, verified by experiment). Closing it needs a host transport that pre-allocates the delivery id; until then the nonce — host-minted, requester-bound, single-spend, TTL-bounded and revoked at turn close — is the pre-bind authority. A concurrent live activation on the same child refuses the overlapping turn instead of interleaving it. Delivered manual consultations are re-registered from the persisted `advisor/run` log when a root is (re)created, so the same child stays continuable across a restart while authorizations themselves never survive one.

### Verdict channel

The Advisor's review is not read from its prose. The plugin registers its own `advisor_verdict` tool host-wide before any child is composed, includes it in the child's tool allow-list regardless of the configurable tool policy, and treats that tool as the only authoritative verdict source. The tool is registered first because `tools.restrict()` rejects an unknown tool name, so a child composed before registration would fail to start rather than silently lose the channel.

A submission is a **candidate**, not a verdict. It is recorded against a consultation keyed by the host-generated consultation id and indexed by child session, and the calling child is resolved from the live agent rather than from anything the model supplies; the invocation identity is checked against the registry's host-created record. The candidate is published only when the run reports `completed` **and** the child session records a closing turn boundary whose seq is at or after the submission **and** whose turn is the turn that submitted the verdict; when the authorized delivery message is known, the closed turn must have claimed exactly that message. Inbox acceptance, quiescence and a pre-close boundary are not terminal evidence on their own. The turn observer likewise correlates claims by delivered message id once it is known, instead of attributing any claim in the child session to the delivery.

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
  maxAdvisorConsultsPerTask = -1  (no limit)
  maxConcurrentAdvisorRuns = 2
        |
        +-- Root Advisor
        +-- Worker A Advisor
        +-- Worker B Advisor
```

The task root is found by walking live `parentSession` links through the DSH Agent registry. Calls above the concurrency cap queue FIFO. A queued call aborted before start returns its reserved budget; a call that actually starts consumes budget even if the model later fails.

Manual consultation also retains a per-agent cap (`maxManualConsultsPerSession`). Both budgets default to `-1`, which means no limit at all: a negative value is never exhausted, while `0` still means consultations are disabled outright. Set either to a positive number to bound cost; the cap only ever limits how many consultations may start, never what one of them may report.

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
3. An `agent/pre-step` activation gate admits an Advisor step only for a live, unexpired, invocation-matching activation (bound to the delivered message and, once claimed, to its exact turn). Steps without one — direct prompts, generic sends, stale or overlapping turns — are rejected before any model request, so budgets, timeouts, locks, and auditing cannot be bypassed outside `consult_advisor`.

The second layer closes the gap where child-scoped tools are not covered by a global-tool restriction. Descendants receive the same global restriction and execution guard, and their pre-step is rejected unless their session ID is the originally budgeted Advisor ID. Known delegation tools, including `toolName` aliases from trusted Cordis plugin runtime configurations, are reserved and cannot be enabled. Additional custom/MCP delegators can be classified through `capabilityAmplifierTools`. `structured_output`, the internal `advisor_verdict` channel, and PTC `run_code` are internal runtime exceptions; the verdict exception is scoped to that one tool name and authorizes nothing else. Advisor descendants override an inherited PTC presentation with native schemas, removing the large `run_code` SDK while leaving the requester's preset untouched. `consult_advisor` is never exposed to an Advisor child.

## External provider boundary

This feature covers local DSH Agents. External product subagent providers that run their own process/session (for example standalone Codex, Claude Code, or ACP providers) do not automatically receive `consult_advisor`, DSH tool interception, or these lifecycle hooks. Supporting those providers requires a separate product bridge rather than pretending they are local DSH agents.

## Editing while another agent continues

`edit`, `write`, shells, MCP mutation tools, and similar capabilities are default-off. Users can explicitly enable them.

Mutating or unknown Advisor tools force blocking and an exclusive task-tree workspace lease. Read-only Advisors and ordinary mutating tool bodies share the other side of that lease; a pending editing review stops further conflicting tool admissions. Known delegation wrappers and the PTC transport are excluded because their leaf tool calls acquire their own leases. An unknown mutating wrapper held by an ancestor is detected and reported unavailable to avoid a recursive lease deadlock. This coordinates participating DSH tools in the live tree, not unrelated OS processes or external product agents.

## Evidence, stale results and verification

Case packets use explicit section priorities, bounded UTF-8 JSON (48 KB total; at most 8 requester evidence items, 8 failed attempts, 12 success criteria, and 12 recent-tail entries, with omitted counts reported in a `truncation` block instead of silent drops), credential redaction, runtime outcome classifications, and call/result IDs. Delivered verdicts are likewise field-budgeted (summary 1 KB, diagnosis 6 KB, recommended action 2 KB, 512 B per evidence reference, 1 KB per action, 4 KB validation plan) under a 16 KB total; the full transcript stays in the Advisor child while requester/root telemetry keeps only a bounded digest. They retain capabilities independently from truncatable evidence. Trigger relations use either a validation identity or the exact failure fingerprint that raised the escalation. Successful PTC wrappers are suppressed when concrete sub-dispatches exist; failed or unfinished wrappers retain a compact bridge summary. `tool_activity` is the canonical tool-result store; `recent_tail` contains only recent user and assistant framing, failure/validation rows reference activity by `call_id`, and changed paths are derived only from retained activity. Unrelated context is limited to three validation failures, one validation success and four failures. Because a cap silently destroys the count it removes, validation also reports a pre-cap aggregate (`validation_summary`), so a reviewer can tell a task with two checks from one with two hundred even though both packets retain the same number of rows. Continuous packets track a reviewed sequence and omit old activity. A user's root or requester inbox insertion changes the revision before the new message is admitted, closing the gap where an old background review finishes while new intent is queued. Any delivered consultation — manual or automatic — also advances a per-agent review watermark keyed by problem fingerprint: a manual review covers the tracker's live problems at delivery time, so a later automatic trigger on the same problem stays suppressed while any problem the review never saw still re-arms it. A structural workspace change since the review re-arms it as well; a bare repeat through a shell does not. The Advisor's own edits never stale its own review (its verdict reports them, and the exclusive lease admits no concurrent reader that could observe a half-edited workspace); they do invalidate older proofs through the same mirror. A validation execution (a command the tracker recognizes as a check) is evidence, not interference: it moves neither the structural clock nor — by call id — its own proof. Freshness itself is broader: any mutating shell, configured or path-carrying custom tool, and any worker or Advisor edit records an attributed mutation (mirrored into the root scope) that invalidates a proof it outdates, while the Advisor's review traffic (verdict channel, inspection reads, obligation tool) stays fully invisible. Continuous review carries no fingerprint and re-arms on new tool evidence — counted by a monotonic revision that never saturates like the capped 24-entry array — or on a new material assistant conclusion. Separately, every potential workspace mutation (shells and unknown tools included) bumps a conservative per-task epoch captured at dispatch: a read-only background review that raced a same-task file change is recorded stale for audit but never steered.

### Verification obligations

A definite validation failure also opens a verification obligation that is independent of the escalation score, the cooldown and the consultation budgets: exhausting any of them can neither close nor hide it. An item is resolved only by a witness — a later pass of the same validation command, in the same scope, whose dispatch and completion both fall after the latest failure, with no related mutation during execution or after the pass. The pass must also be unmasked: surrounding shell text that can hide the check's own exit (`; true`, post-check invocations, extra pipes, `||` chains, substitution, conditionals) names the target but proves nothing, so compound successes neither witness nor reset failure state. Separators before the check, env prefixes, wrappers, redirects, a trailing `&&` chain ending at the check, one reporting pipe, and quoted exit-echo tails keep attribution — the shapes real sessions use to report results. Tails are shell-aware: a quoted literal reports only in PowerShell (POSIX executes it), and echo-style tails mask in every shell, so `; true`, `; "true"` (bash) and `; echo done` break attribution everywhere while `; "TSC_EXIT=..."` survives only under pwsh. A single reporting pipeline (`| Select-Object`, `| tee`) is accepted deliberately even though the host only reports the aggregate process exit: without pipefail a failing check behind a succeeding consumer still reports 0, and no layer here can recover per-process provenance (verified against the deployed tool runtime). That residual is accepted to keep real reporting sessions working; recurrence reopens on the next genuine failure, and all other masking shapes stay refused. A standalone redirection after a separator (`; > file`) is its own truncating command, never reporting. A single pipeline is tolerated only for pass-through consumers (formatters/pagers such as `Select-Object` or `tee`); `| true`, `| grep` or scripts decide the exit themselves and break attribution, as do additional pipes. Duplication redirections (`2>&1`) are glued before splitting so they never read as backgrounding. A failure whose command the tracker never classified as a validation command carries no validation key and so cannot be closed automatically. A correction record cannot close anything on its own, and neither can a disposition (`not-applicable` or `accept-risk`), which is recorded but leaves the item open and listed. Obligations surface as pre-step notes when they change and as at most one reminder per revision under a fixed per-task budget, and are always described as a reminder rather than a block. Storage is runtime-only: a restart keeps no record, and an empty list is reported as "no current-run record", never as an all-clear. A contradicted published claim has no automatic detector, so it is created only through the explicit `advisor_obligation` registration entry point, which requires `validation_call_id`: the tool call id of an observed validation command in the same task whose validation identity the claim is then bound to. The host resolves the identity from tracker evidence — the model never supplies a validation key — and calls without a known, keyed validation command are refused without creating an entry. A keyless claim can therefore never close (no witness can match it); an existing keyless entry may gain its verified identity by re-registering with a validation call id, after which correction plus a later pass closes it. A claim keeps the first verified identity it was bound to: re-registering it against a different validation is refused as a conflict (the response would otherwise name a key the stored obligation does not close on). Omitting `id` on `correct` resolves the unique open item for the claim id, mirroring the `last` alias philosophy for callers that fumble ids.

The witness rule can only exclude changes the plugin observed as tool calls; an edit made outside the session is never detected, so a pass is not proof that nothing else changed.

Packet activity, failures and conversation tail also have a current user-task sequence floor, independently of the continuous review cursor. A result from a call before that floor is excluded even if it arrives later. Before admitting a new user step, the tracker is cleared again so late old-turn failures cannot trigger a review of the new task. Startup failures that never dispatch remain retryable after bounded exponential backoff; temporary budget reservations are not treated as consumed quota.

Versioned `advisor/run` records expose reservations, actual dispatch, retries, failures, stale outcomes, child IDs and observed token usage. Rows are keyed by consultation turn plus a per-call nonce (attempt numbers restart on every follow-up call), so successive turns never collapse: within a turn, status progression still replaces, but a delivery is never erased by a later miss — which is also what consultation restore reads, restoring the latest delivered turn count rather than the first. Dispatch start boundaries are keyed by a shared tick rather than any one session's numbering, and per-agent entries are dropped on disposal, so a high-sequence session cannot evict a live worker's evidence. A lost boundary (no startedSeq) still closes nothing by design, and a result whose dispatch identity is gone contributes nothing task-specific (no score, no failures, no witnesses) rather than being attributed to the current task — while its observable workspace effects (epoch, structural and obligation mutations, all computed from live session state) are still recorded, so an ancient write cannot certify old proofs as fresh either. Failure paths interrupt only execution the failing attempt itself established — refusing an overlap never stops the legitimate turn it refused to join — but interrupt issuance is not verified termination: the runtime offers no drain guarantee, so post-failure lease exclusivity against still-running tool work remains a stated limitation, not a proven property. These are operational records, not model context. Currency amounts and failed-request usage are not invented when the provider supplies no usable accounting.

Supported DSH versions are `0.1.2-rc.1`, `0.1.5-alpha.2`, and `0.1.5-rc.1`; the development dependency closure stays locked to `0.1.5-alpha.2`. The integration harness mounts real AgentLoop, spawn, scopes, tools, session invariants and Remote Gateway; its model adapter is scripted. The installed-runtime test configuration can resolve the complete DSH runtime from a local installation. Production Web validation on `0.1.2-rc.1` additionally covers a real model consultation, tool-policy mutation, visible child history, and reopening its JSONL log after restart.

The supported builds lack an external-event envelope option on `Session.append`. A compatibility bridge temporarily recognizes only the plugin's four required event types (`advisor/policy`, `advisor/model`, `advisor/identity`, and `advisor/run`) in the tested runtime catalog, with reference-counted disposal. It retains identity and preferences instead of marking them ignorable; histories containing those required records intentionally need Advisor loaded. Other unknown required events still fail closed. This bridge is limited to the tested runtime implementation and must be revisited when DSH exposes an official required-event extension API.

Case packets omit `consult_advisor` transport calls and results from task evidence. The current consultation is still pending by construction, and presenting it as `result-not-observed` can distract the Advisor into diagnosing its own transport. Previously delivered advice remains available through the dedicated `prior_advice` field.