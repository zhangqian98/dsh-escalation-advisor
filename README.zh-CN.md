# dsh-escalation-advisor

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Release](https://img.shields.io/github/v/release/zhangqian98/dsh-escalation-advisor?include_prereleases&color=4D6BFE)](https://github.com/zhangqian98/dsh-escalation-advisor/releases)
[![CI](https://github.com/zhangqian98/dsh-escalation-advisor/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangqian98/dsh-escalation-advisor/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-4D6BFE)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-4D6BFE)](LICENSE)

[English](README.md) · **简体中文**

一个面向 DeepSeek Harness（DSH）的强模型顾问插件。主 Agent 可以继续使用速度更快、成本更低的模型，在遇到关键设计、连续失败或需要独立复核时，把结构化证据交给另一个 DSH 模型审阅。

Advisor 运行在**可见的 DSH 子会话**中，不是隐藏的 LLM 请求。你可以在任务树中查看它的完整对话、工具调用、token 用量和最终结论；Advisor 的消息也会像普通消息一样显示在主会话中。

## 主要能力

- 主模型可以主动调用 `consult_advisor` 请求独立意见。
- 自动升级模式会在确定性的失败/卡住信号达到阈值后请求 Advisor。
- 持续审阅模式会在自然轮次边界检查新增修改、失败、验证和结论。
- 全局设置和当前会话都可以选择 Advisor 模型及思考等级。
- 当前会话可以单独覆盖模式、等待策略、超时和工具权限。
- Advisor 使用独立的 `advisor_verdict` 工具提交结构化结论。
- 新咨询创建可续接子会话；显式传入 `consultation_id` 可以继续同一段 Advisor 对话。
- 主 Agent、普通本地子 Agent 和 Advisor 的权限边界彼此独立，不允许借 Advisor 提权。

## 安装

### 从 npm 安装（推荐）

把经过验证的精确版本安装到 Web profile，然后启动或重启 DSH：

```bash
dsh plugin --profile web add dsh-escalation-advisor@0.1.0-alpha.27
dsh web
```

如果你使用的 profile 不是 `web`，请替换成实际 profile 名，并在启动时继续使用同一个 profile。

### 从 GitHub 固定版本安装

也可以安装不可变的 GitHub release tag：

```bash
dsh plugin --profile web add github:zhangqian98/dsh-escalation-advisor#v0.1.0-alpha.27
```

不要使用移动的 `alpha` 标签来代替已经验证的精确版本；DSH prerelease 之间可能存在运行时契约变化。

### 从本地源码打包安装

开发版本应先构建、检查并生成 tarball，再让 DSH 安装 tarball。不要把源码目录直接链接进生产 profile。

```bash
npm ci
npm run check
npm pack
dsh plugin --profile web add ./dsh-escalation-advisor-0.1.0-alpha.27.tgz
```

## 兼容性

当前验证过的 DSH 版本：

- `0.1.2-rc.1`
- `0.1.5-alpha.2`
- `0.1.5-rc.1`

开发依赖完整锁定在 `0.1.5-alpha.2`，CI 使用 Node.js `22.19` 和 `24`。本机安装运行时测试还会把所有 DSH import 指向指定的真实安装版本，验证会话、工具、子 Agent 和 Remote 契约。

### DSH 0.1.5-rc.1 的旧会话迁移

`0.1.5-rc.1` 会把旧 Session 格式迁移到 V3，但它的冻结历史事件清单不认识 Advisor 的四种插件事件。打开包含旧 Advisor 记录的会话前，请先停止 DSH 并备份 profile 与 sessions，然后运行包内维护脚本：

```bash
node scripts/patch-dsh-history.mjs /absolute/path/to/@deepseek-ai/dsh/package.json /absolute/path/to/new-backup-directory
```

脚本只支持精确的 DSH `0.1.5-rc.1`，会校验原文件哈希并备份两个 DSH 核心文件，只加入以下四种事件：

- `advisor/policy`
- `advisor/model`
- `advisor/identity`
- `advisor/run`

其他未知历史事件仍会被拒绝。重新安装 DSH 会覆盖这个本地兼容补丁；更换 DSH 版本前必须重新验证，不能把旧补丁直接套到新版本。

## 三种模式

| 模式 | 行为 |
| --- | --- |
| `manual` | 只提供主动咨询工具，不自动调用 |
| `escalate` | 主动咨询 + 失败/卡住信号达到阈值后自动升级；默认模式 |
| `continuous` | 主动咨询 + 在自然轮次边界持续审阅新增工作 |

默认覆盖范围：

| 能力 | 主 Agent | 本地子 Agent |
| --- | --- | --- |
| 主动 `consult_advisor` | 开 | 开 |
| 自动升级 | 开 | 开 |
| 持续审阅 | 开 | **关** |

本地子 Agent 的持续审阅默认关闭，避免一个拥有大量 worker 的任务按 worker 数量放大强模型调用。如果显式开启，本地子 Agent 会等待 Advisor 完成后再结算，防止旧结果先返回父 Agent。

Advisor 子会话自身永远不能再次请求 Advisor，因此不会递归咨询。

## 模型与思考等级

在 **设置 → 插件 → DSH Escalation Advisor** 中选择全局默认 Advisor 模型。会话标题栏的 **Advisor** 面板可以为当前 root 任务树单独覆盖模型与思考等级。

模型选择器复用 DSH 主对话框的原生 `ModelSelect`、模型目录和能力数据。插件只保存 provider/model/effort 路由，不保存模型凭据，也不会修改主会话自己的模型。

选择“使用全局默认”会删除当前会话的模型覆盖；空思考等级使用该模型的默认值。

## 可见且可续接的 Advisor 会话

每个新咨询都会在精确的请求者下面创建一个可见、可续接的子会话：

```text
Root
├─ Advisor · manual
└─ Worker A
   └─ Advisor · escalation · turn 3
```

返回结果包含 `consultation_id`。后续主动咨询可以显式传入这个 ID，在同一个 Advisor 子会话中开始新轮次，从而保留此前上下文；省略 ID 总是创建独立咨询。

`consultation_id: "last"` 只会解析为**当前请求 Agent、当前 root 任务**最近一次已经成功交付的主动咨询。失败、仍在运行或自动触发的咨询不会改变它；兄弟 Agent 也不能借 `last` 访问别人的 Advisor 会话。

自动升级和持续审阅不会偷偷续接旧对话，它们始终创建新的独立咨询。

## 工具权限

出厂默认允许 Advisor 使用：

```text
read
read_image
glob
grep
advisor_verdict
```

其中 `advisor_verdict` 是插件内部强制提供的结果通道，不受可配置工具列表影响。

默认不开放 `edit`、`write`、`bash`、`pwsh`、Web、浏览器、MCP、数据库及其他未知工具。可以在全局设置或当前会话的 Advisor 面板逐项开启；工具列表默认折叠。

当前 root 会话的配置只是上限。实际 Advisor 工具为：

```text
root Advisor allowlist ∩ 请求者实际可见工具
```

因此，本地子 Agent 不能通过 Advisor 获得自己原本看不到的工具。

以下能力永久禁止，不可配置开启：

- `consult_advisor`
- `subagent`
- `subagent_fork`
- `subagent_control`
- `workflow`
- `ralph`
- 可信 Cordis 插件配置中声明的同类重命名工具
- `capabilityAmplifierTools` 中手动标记的自定义/MCP 派生工具

权限有两层执行保障：创建子会话时使用 DSH `toolFilter.allow`，每次真正执行工具时再由单调 `tools.guard` 检查原始权限上限、当前 root 策略和请求者当前可见面。提示词不是权限边界。

### Advisor 使用原生工具 schema

即使主 Agent 使用 PTC，Advisor 子会话也会把自己的小型工具列表切换为原生 schema。主会话仍保持 PTC，但 Advisor 不再携带庞大的 `run_code` SDK，能够直接调用 `read/glob/grep/advisor_verdict`，同时继续受相同权限守卫约束。

## 输入和 token 控制

Advisor 使用所选模型在 DSH 中声明的上下文窗口和输出默认值。插件不再维护独立的 `maxInputBytes` 或 `maxOutputTokens`；旧配置会被忽略。

这不等于把整个主会话发送给 Advisor。case packet 只保留当前任务边界内的结构化证据，并做语义裁剪：

- 触发相关证据通过 validation identity 或 failure fingerprint 精确关联。
- 成功的 `run_code` 外层记录在已有具体 PTC 子调用时删除。
- 失败或未完成的 `run_code` 外层只保留短桥接摘要。
- 工具结果只在 `tool_activity` 保留一份。
- `failures` 与 `validation` 通过 `call_id` 引用活动，不重复命令和输出。
- 无关验证最多保留 3 条失败和 1 条成功。
- 失败列表最多保留 4 条。
- `recent_tail` 只保留最近的用户/助手对话框架，不重复工具结果，也不回填更早内容。
- 变更路径只从最终保留的活动生成。
- `validation_summary` 保存裁剪前的总数、成功数、失败数和相关数，不需要携带全部明细。

系统提示还要求 Advisor 优先检查触发相关 call reference，并在可行时把互不依赖的只读工具调用放在同一个模型步骤中，减少重复请求。

## 等待与超时

默认等待行为：

| 触发方式 | 主 Agent | 本地子 Agent |
| --- | --- | --- |
| 主动咨询 | 等待 | 等待 |
| 自动升级 | 可配置；默认等待 | **强制等待** |
| 持续审阅 | 可配置；默认后台 | **开启后强制等待** |

当前 root 会话可以覆盖自动升级和持续审阅的等待策略：`inherit`、`block`、`background`。面板只显示当前模式真正生效的等待选项。

全局默认咨询超时为 **10 分钟**，当前会话可以单独覆盖。支持范围为 1 秒到 60 分钟；内部配置字段仍使用毫秒。超时覆盖排队和生成的整个单次尝试，重试会获得新的完整时限。

只要 Advisor 启用了写入、执行或未知效果工具，审阅就会强制等待，并获取 root 任务树的独占工作区租约，避免主 Agent、worker 和 Advisor 同时修改同一工作区。

## 预算与并发

- `maxManualConsultsPerSession`：单 Agent 主动咨询上限，默认 `-1`（无限制）。
- `maxAdvisorConsultsPerTask`：整个 root 任务树共享上限，默认 `-1`（无限制）。
- `maxConcurrentAdvisorRuns`：同一 root 任务树并发 Advisor 数，默认 `2`。

负数表示无限制，`0` 表示完全禁止，正数表示明确上限。

排队期间取消、认证配置失败或模型请求尚未开始时会退还预留预算；已经发出模型请求的尝试会计入预算。自动咨询的瞬时失败最多重试一次，只有成功交付的 verdict 才会占用问题去重额度。

## 自动升级信号

每个 Agent 都有独立的升级跟踪器；worker 的失败不会增加 root 或兄弟 worker 的分数。

当前信号包括：

- 最终工具错误；
- 归一化后相同失败重复出现；
- 进程非零退出；
- 同一目标反复修改但没有成功验证。

取消、权限拒绝、基础设施故障、超时，以及搜索/条件判断中预期的非零结果不会计入“模型卡住”分数。匹配的成功验证只能清除对应失败，不能用无关 lint/test 抹掉其他问题。

每个 Advisor 运行都会记录 root/requester 任务 revision。新用户请求到来后，旧任务的后台结果只保留为 stale 审计记录，不会注入新任务。

## 验证义务

明确的验证失败还会创建运行时验证义务。升级分数重置、冷却期、预算耗尽、人工纠正或风险处置都不能关闭它；只有同一 scope 中、晚于最新失败、执行期间和之后没有相关修改的匹配成功验证才能关闭。

验证义务目前只保存在运行内存中。DSH 重启后，面板会显示“没有当前运行记录”，不会把空列表解释成全部通过。

## Advisor 结果

Advisor 必须调用 `advisor_verdict`，普通文本不能代替 verdict。只有当子会话以 `completed` 关闭，并且 verdict 与对应轮次的结束边界一致时，结果才会发布。

结构化结果包含：

```json
{
  "severity": "none | nit | concern | blocker",
  "disposition": "revise",
  "summary": "...",
  "diagnosis": "...",
  "next_actions": ["..."],
  "confidence": 0.9,
  "evidence_used": [{ "kind": "file", "reference": "src/example.ts:10" }],
  "assumptions": [],
  "recommended_next_action": "运行聚焦验证",
  "validation_plan": ["运行受影响测试"],
  "needs_more_evidence": false,
  "changes_made": []
}
```

`none` 不会打断主任务；`nit` 会等待自然的下一步再作为历史可选建议出现；`concern` 和 `blocker` 会要求请求者在完成前核验或修正。取消、超时、失败、缺少 verdict 或无法与结束边界对齐的运行不会伪装成成功审阅。

Advisor 消息会作为完整气泡显示在主对话中。标题栏面板的“咨询记录与回注”仍可查看触发来源、状态、模型、token 和历史报告，读取这些信息不会追加 Session 事件或调用模型。

## 外部子 Agent

本插件自动覆盖参加 DSH Agent/Tool 生命周期的本地 Agent。独立运行的 Codex、Claude Code、ACP 或其他外部 provider 不会自动获得 `consult_advisor` 和这些生命周期 hook；它们需要单独的桥接实现。

## 安全说明

- 模型认证由 DSH 管理，插件只保存模型路由 ID。
- 常见凭据格式会在证据进入 Advisor 提示前脱敏。
- 未知工具默认关闭，并按有修改风险处理。
- 权限在执行期再次检查，不依赖模型遵守提示词。
- Advisor 不能扩展 root 策略或请求者的可见工具面。
- Advisor 子会话不能派生新的执行 scope。

## 开发与打包

```bash
npm ci
npm run check
npm run build
npm run pack:check
```

`npm run pack:check` 会运行 prepack 构建并输出 npm tarball 清单，用于确认 `lib`、Web client、Cordis patch、迁移脚本、双语 README、设计文档和许可证都进入包中。

在 PowerShell 中使用本机已安装 DSH 运行兼容套件：

```powershell
$env:DSH_RUNTIME_PACKAGE_JSON = "$env:APPDATA/npm/node_modules/@deepseek-ai/dsh/package.json"
npx vitest run --config vitest.runtime.config.ts
```

发布 tag 必须为 `v<package-version>`，例如 `v0.1.0-alpha.27`。Release 工作流会校验 tag 与 package version、运行完整检查、生成 npm tarball、上传到 GitHub Release，并通过 npm Trusted Publishing（OIDC）发布到 npm 的 `alpha` dist-tag。工作流不保存长期 npm 发布 token。

## 许可证

[MIT](LICENSE)
