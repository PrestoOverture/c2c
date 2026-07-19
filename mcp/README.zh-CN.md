# c2c-codex — Claude↔Codex 契约桥接器（MCP 服务器）

*[English](./README.md)*

Claude Code 是**架构师/审查者**（见 `../CLAUDE.md`）；Codex 是**实现者**（见 `../AGENTS.md`）。这个 MCP 服务器是两者之间的信使：它把 Goal/Delta Contract（目标/差量契约）转化为 Codex 的运行任务，并把结构化的交接结果返回给 Claude 审查。它**与具体语言无关**——所有验证命令都来自契约中的 Success Conditions（成功条件），而不是这个服务器本身。

## 工作原理

每个任务都会启动一个 `codex app-server`（Codex 的 JSON-RPC 接口，基于 stdio/JSONL）并驱动它：

```
initialize
→ thread/start            （或 rework 时用 thread/resume）
→ thread/goal/set         objective = 提炼后的 Goal Contract  ← 相当于 /goal
→ turn/start               input = 完整渲染后的契约内容
→ ... Codex 的目标持续循环会不断运行 turn，直到目标达成 ...
→ 当目标状态终止（complete / budget_limited），
  或线程在某次 turn 后陷入沉默但目标仍处于 active 状态时，任务结束
```

设置线程目标（thread goal）在编程层面等价于 Codex TUI 里的 `/goal` 斜杠命令：Codex 会在每次 turn 之后对照目标自我审核（"Goal achieved" / "Goal unmet"），并持续运行直到通过审核或达到 token 预算上限。

## 工具列表

| 工具 | 用途 |
|---|---|
| `codex_implement` | 依据 Goal Contract（`goal`、`constraints[]`、`success_conditions[]`，可选 `token_budget`、`cwd`）启动一个任务，立即返回 `job_id`。 |
| `codex_status` | 查询任务状态：state、thread id、goal 状态/token 消耗、turn 计数、transcript 尾部内容。 |
| `codex_result` | 获取已完成任务的结果：最终消息 + 解析出的交接内容（Changed Files / Validation / Success Conditions / Risks & Deviations）。缺失任何一部分 ⇒ `handoff.valid: false`——依据 CLAUDE.md，这本身就算审查失败。 |
| `codex_rework` | 用 Delta Contract（`findings[]`、`failed_conditions[]`）恢复同一个 Codex 线程。原有的线程目标会重新生效。 |

## 配置（环境变量）

| 变量 | 默认值 | 含义 |
|---|---|---|
| `CODEX_BIN` | `codex` | Codex 可执行文件 |
| `CODEX_ARGS` | `app-server` | 参数（空格分隔） |
| `CODEX_CWD` | 服务器自身 cwd | 任务的默认工作目录 |
| `CODEX_MODEL` | （Codex 默认值） | 传给 `thread/start` 的模型覆盖项 |
| `CODEX_APPROVAL_POLICY` | `never` | Codex 审批策略（自主执行模式） |
| `CODEX_PERMISSIONS` | （未设置） | Codex 权限配置透传 |
| `CODEX_JOB_TIMEOUT_MS` | `1800000` | 单个任务的硬性超时上限（30 分钟） |
| `CODEX_QUIET_MS` | `30000` | 一次 turn 结束后、判定"目标仍处于 active 但已完成"之前的静默等待时间 |
| `GOAL_OBJECTIVE_MAX` | `2000` | `thread/goal/set` objective 字符串的最大长度 |

## 运行 / 测试

```sh
bun install
bun test          # 针对 test/mock-codex.ts 做端到端测试（不需要真实 Codex）
bunx tsc --noEmit # 类型检查
```

已在 `../.mcp.json` 中为 Claude Code 注册。服务器本身运行在 Bun 上（Node ≥ 22.18 也可以——TS 代码只使用可擦除语法）。

## 状态 / 注意事项

- **已通过真实环境验证**：针对 `codex` 0.144.6（2026-07-19）——`test/live-smoke.ts` 驱动了一个真实契约走完整个 MCP 服务器流程：`thread/goal/set` 被接受，目标追踪了 `tokensUsed` 并经历 `active → complete`，Codex 自我验证了成功条件，交接内容解析有效。同时也被 `bun test`（基于 `test/mock-codex.ts`）覆盖，无需真实 Codex 或模型开销。
- 需要较新版本的 Codex CLI（`npm i -g @openai/codex@latest`）。注意：macOS 更新后，过旧的安装可能会立即 `zsh: killed`，重新安装即可解决。
- 如果某个构建版本中 Codex 的 goals 功能不可用（"goals feature is disabled"），`thread/goal/set` 失败会优雅降级为单轮（single-turn）模式，并在 transcript 中记录说明。
- Goals 功能依赖持久化的线程；使用 `thread/start` 的默认设置（不使用临时线程）。
- 服务器→客户端的请求（审批类）会被自动拒绝——任务以 `approvalPolicy: never` 运行；如果 Codex 需要更宽松的沙箱权限，可调整 `CODEX_PERMISSIONS`。
