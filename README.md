# dsh-escalation-advisor

A DSH-only advisor plugin that lets a cheaper primary model borrow a stronger configured DSH model only when useful.

It implements three modes with one shared advisor runtime:

- **manual** — exposes `ask_advisor`; no automatic model calls.
- **escalate** — exposes `ask_advisor` and automatically consults the advisor when deterministic stuck/failure signals cross a threshold.
- **continuous** — exposes `ask_advisor` and shadow-reviews each natural turn boundary, similar to OMP-style continuous advisors.

The plugin does **not** store a separate API key. `provider` + `model` are passed to DSH's own `ctx.llm.prepareCall()`, so the selected model uses the provider/authentication already configured in DSH.

## Status

`0.1.0-alpha.1` is an implementation preview. The server-side plugin, three trigger modes, DSH model routing, escalation scoring, consultation deduplication, and tests are present. A dedicated Web settings/model-picker card is intentionally deferred until the runtime behavior is exercised against current DSH builds.

## Install from Git

```bash
dsh plugin --profile web add git+https://github.com/zhangqian98/dsh-escalation-advisor.git
```

## Configure

```bash
export DSH_ADVISOR_PROVIDER='your-existing-dsh-provider'
export DSH_ADVISOR_MODEL='your-strong-model-id'
export DSH_ADVISOR_MODE='escalate' # manual | escalate | continuous

dsh web
```

You can also override the plugin row in the profile's composed Cordis configuration. The selected provider/model must already work in DSH. Authentication remains owned by the DSH provider adapter and credential system.

## Modes

### `manual`

Only the model-visible `ask_advisor` tool is active. It accepts `goal`, `question`, optional `attempts`, and optional `context`; a bounded recent DSH transcript/evidence slice is added automatically.

### `escalate` (default)

Manual consultation stays available, plus a deterministic gate observes final DSH tool outcomes. Current alpha signals are tool execution error, non-zero process exit code, the same normalized failure repeating, and repeated mutation of the same target without a successful test/build/lint/typecheck validation command.

Signals add to a score. At the natural `agent/turn-stopping` boundary, a score at or above `scoreThreshold` triggers one strong-model consultation, subject to per-turn/per-problem limits and cooldown. Advice is sent back with `agent.steer()` so the cheaper primary model gets another step instead of incorrectly finishing. A successful validation command resets stuck state.

### `continuous`

At most once per DSH turn, the advisor reviews recent history and returns `none`, `nit`, `concern`, or `blocker`. By default lower-severity review is injected as future context while concern/blocker steers the current turn into another step. This mode intentionally spends more advisor calls and is closest to an OMP-style shadow reviewer.

## Default escalation tuning

```yaml
scoreThreshold: 4
toolErrorWeight: 2
repeatedFailureWeight: 3
nonZeroExitWeight: 1
repeatedMutationWeight: 2
repeatedMutationCount: 3
maxAutoConsultsPerTurn: 1
maxAutoConsultsPerProblem: 1
cooldownTurns: 1
```

Cancellation/permission-style failures are excluded from escalation scoring. The important property is deduplication: a repeated failure does not cause unlimited strong-model calls for the same problem fingerprint.

## Data sent to the advisor

The plugin sends a bounded recent session slice plus the trigger/caller question. It redacts common secret/token patterns and truncates by UTF-8 byte budget. The advisor has no tools or write access in this first version: the strong model is a read-only reasoning consultant, while the primary DSH agent remains the executor.

## Design

```text
cheap primary model
       |
       +-- normal DSH tools --------------------> work
       |
       +-- ask_advisor (manual) -----+
       |                             |
       +-- escalation gate ----------+--> stronger DSH model
       |                             |       |
       +-- continuous review --------+       v
                                      advice only
                                          |
                                          v
                                  primary model continues
```

This is deliberately different from full model failover. A strong model normally diagnoses and recommends; it does not take over the tool loop.

## Development

```bash
npm install
npm run check
npm run build
```

## Prior art

The design is informed by the DSH advisor ecosystem, especially continuous reviewer approaches and on-demand SuperAdvisor patterns. This implementation combines those styles with a deterministic automatic escalation gate and one shared DSH-native model/auth path.

## License

MIT
