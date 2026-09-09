# dsh-escalation-advisor

A DSH-only advisor plugin for running a cheaper primary model most of the time and borrowing a stronger configured DSH model when a second opinion is useful.

The Advisor now runs as a **visible DSH child session**, not a hidden LLM request. Users can open the parent session's subagent catalog and inspect the Advisor's transcript, tool calls, token use, and final result.

## Modes

- **manual** — exposes `consult_advisor`; no automatic consultations.
- **escalate** — manual consultation plus deterministic stuck/failure scoring. Default.
- **continuous** — manual consultation plus a strong shadow review at natural turn boundaries.

## Install from Git

```bash
dsh plugin --profile web add git+https://github.com/zhangqian98/dsh-escalation-advisor.git
```

Configure the strong model either in **Settings → Plugins → DSH Escalation Advisor** or with environment defaults:

```bash
export DSH_ADVISOR_PROVIDER='your-existing-dsh-provider'
export DSH_ADVISOR_MODEL='your-strong-model-id'
export DSH_ADVISOR_MODE='escalate'

dsh web
```

The plugin never stores a separate API key. The Advisor child uses the provider/model already configured in DSH.

## Advisor child sessions

Each consultation currently creates a fresh one-shot DSH child with a label such as:

```text
Advisor · manual
Advisor · escalation · turn 4
Advisor · continuous · turn 8
```

This is deliberate. Fresh children make the permission boundary and evidence packet easy to audit, and one-shot reviews can run in the background without the standard continuable-child settlement notice waking the primary session for a `severity=none` result. See [DESIGN.md](./DESIGN.md) for the reuse decision.

DSH Web already exposes session-backed subagent conversations from the parent header's subagent catalog, so no separate transcript viewer is required.

## Tool permissions

Advisor tool access is enforced by DSH child `toolFilter.allow`.

Global defaults:

| Preset | Exposed tools |
| --- | --- |
| `none` | none |
| `inspect` | `read`, `read_image`, `glob`, `grep` |
| `research` | inspect + `web_search`, `web_fetch` |
| `edit` | inspect + `edit`, `write` |
| `custom` | exact configured allowlist |

`inspect` is the default. Shells, MCP tools, browser control, database tools, and other deployment-specific tools are **not guessed to be read-only**. Add them explicitly through `custom` if desired.

`edit` can modify the same workspace as the primary model. Combining edit permissions with background review can therefore create concurrent edits and should be used deliberately.

## Per-session overrides

Global Settings are defaults. Every parent session can override Advisor permissions and wait behavior without changing other sessions:

```text
/advisor
/advisor reset
/advisor-permission inherit|none|inspect|research|edit|custom
/advisor-tools read,grep,glob,...
/advisor-escalation-wait inherit|block|background
/advisor-continuous-wait inherit|block|background
```

These are DSH human commands: command input/output does not become a model message. The Web client decorates the permission and wait commands with popup selectors; `/advisor-tools` remains the advanced exact-name allowlist path.

Overrides are persisted as latest-wins log-only `advisor/policy` events in that parent session. `/advisor reset` returns the session to global inheritance.

## When the primary session pauses

Defaults:

| Advisor trigger | Primary behavior |
| --- | --- |
| manual `consult_advisor` | **block** until the child returns |
| automatic escalation | **block** until the child returns |
| continuous review | **background** |

Why: an explicit manual tool call needs its answer immediately; escalation means the primary model is probably stuck and should not compound the mistake; continuous review should normally preserve throughput and only wake the primary session if the later review finds a material concern.

Automatic wait behavior is independently overridable per session.

## Escalation signals

The current deterministic gate tracks signals including:

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

In blocking automatic modes, a material result is steered into the primary session before it closes. In background mode, a material result later wakes/steers the still-live parent; `none` remains silent. Lower-severity continuous findings may be injected without waking an idle parent.

## Security notes

- DSH owns provider authentication; this plugin stores only model route IDs.
- Evidence is UTF-8 byte bounded and common credential forms are redacted before becoming Advisor prompt text.
- Tool permissions are an execution-layer allowlist, not prompt-only instructions.
- The Advisor's structured-output tool remains child-scoped and is not granted by the user tool allowlist.
- Arbitrary tools are not auto-classified as read-only because DSH does not yet expose a general trusted effects classification for every tool.

## Development

```bash
npm install
npm run check
npm run build
```

The project is currently alpha. The feature branch `feat/advisor-session-permissions` contains the visible-session / permission rework before it is merged to `main`.

## License

MIT
