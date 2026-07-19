# claude2codex

一个 MCP 服务器，让 Claude Code 通过结构化契约将实现工作委派给 OpenAI Codex。

*[English](./README.md)*

## 演示

一次真实的契约往返实录：Claude 起草 Goal Contract，`codex_estimate` 预估成本，Codex 在 goal loop 下自主实现（`codex_status` 实时流式进度），最后 Claude 独立复核 handoff。

![c2c 演示 — 完整的 Claude→Codex 契约往返](./demo/demo.gif)

*真实 Codex 运行（13k tokens，50 秒），等待时间已压缩。终端回放：`asciinema play demo/demo.cast`*

## 核心理念

软件开发有不同的角色：**规划**做什么、**动手**写代码、**审查**结果。本项目把这些角色分配给两个 AI 智能体：

- **Claude Code** — 架构师和审查者。制定计划，撰写规格说明，审查产出。
- **OpenAI Codex** — 实现者。接收规格说明，编写代码，运行测试，报告结果。

你（用户）是**指挥官** — 决定做什么并给最终批准。Claude 起草方案，Codex 执行，Claude 核验产出。

```mermaid
flowchart LR
    用户 -->|决定做什么| Claude
    Claude -->|Goal Contract| Codex
    Codex -->|结构化交接| Claude
    Claude -->|审查结论| 用户
    Claude -.->|Delta Contract 修正| Codex
```

## 什么是 Goal Contract（目标契约）？

Goal Contract 是一份结构化规格说明，精确告诉 Codex **要做什么**。它由三部分组成：

| 部分 | 作用 |
|------|------|
| **Goal（目标）** | 任务完成后代码应该达到的状态。 |
| **Constraints（约束）** | 边界条件：该动哪些文件、遵循什么模式、哪些东西*不能*改。 |
| **Success Conditions（成功条件）** | 可验证的标准，证明目标已达成。至少一条必须是可运行的测试或命令。 |

示例：

```markdown
### Goal
添加一个 /health 端点，返回 200 OK 并包含服务器版本号。

### Constraints
- 只修改 src/routes.ts 和 src/routes.test.ts。
- 不修改任何已有端点。
- 遵循现有的路由注册模式。

### Success Conditions
- [ ] GET /health 返回 200，JSON body 为 {"version": "<package.json 版本>"}。
- [ ] `npm test` 通过，包含新端点的测试。
- [ ] 不影响其他路由。
```

**为什么要这样结构化？** Codex 在面对明确、可验证的指令时表现最佳。模糊的请求产生模糊的结果。契约格式强制你想清楚：做什么、不做什么、怎么证明做对了。

更深入的实战指南——合同解剖、验证技巧、审查纪律、校准数字、反模式，全部提炼自"用这座桥构建本仓库自身功能"的真实过程——参见 **[PATTERNS.zh-CN.md](./PATTERNS.zh-CN.md)**。

## 什么是 Delta Contract（差量契约）？

当 Claude 审查 Codex 的产出并发现问题时，不会从头来过 — 而是发送一份 **Delta Contract**（返工指令），只针对*失败的部分*：

| 部分 | 作用 |
|------|------|
| **Findings（发现）** | 什么地方有问题，附文件/行号引用。 |
| **Failed Conditions（失败条件）** | 原始契约中哪些 Success Conditions 没通过。 |

Codex 恢复同一个线程（保留第一次尝试的全部上下文），只修复被指出的问题。

## 完整工作流

```mermaid
flowchart TD
    A[用户决定做什么] --> B[Claude 起草 Goal Contract]
    B --> C{用户批准？}
    C -->|是| D[Codex 实现]
    C -->|否| B
    D --> E[Claude 审查产出]
    E --> F{所有条件通过？}
    F -->|是| G[用户最终批准]
    F -->|否| H[Claude 起草 Delta Contract]
    H --> D
    G --> I[完成 - 更新文档]
```

## 三层 Prompt 架构

claude2codex 向 Codex 发送任务时，prompt 由三层组装而成：

1. **协议层**（内嵌在 MCP 服务器中）— 通用规则：如何自我验证、如何格式化交接报告、如何处理返工。无论什么项目都一样。

2. **项目层**（可选，工作目录中的 `AGENTS.md`）— 项目特定的编码规范、工具链说明、架构约束。存在时自动注入。

3. **任务层**（Goal/Delta Contract 本身）— 这次要做的具体工作。

这种分离意味着：MCP 服务器开箱即用（第 1 层始终存在），有项目上下文时更好（第 2 层），每次任务都有独特的规格说明（第 3 层）。

## 安装

需要 [Codex CLI](https://github.com/openai/codex) 和 Node.js 18+。

```sh
npx claude2codex
```

### MCP 配置

添加到你的 Claude Code MCP 设置中：

```json
{
  "mcpServers": {
    "codex": {
      "command": "npx",
      "args": ["-y", "claude2codex"]
    }
  }
}
```

## 提供的工具

| 工具 | 说明 |
|------|------|
| `codex_implement` | 从 Goal Contract 启动一个 Codex 任务。支持 `context_files`（先读参考文件，校验存在性）和 `depends_on`（前序任务成功后才启动）。立即返回 job ID。 |
| `codex_status` | 查看任务进度：状态、队列位置、依赖、轮次、目标状态、token 用量、距上次活动的时间、活动记录。 |
| `codex_result` | 获取已完成任务的结构化交接报告。 |
| `codex_rework` | 用 Delta Contract 恢复 Codex 线程进行返工（同样支持 `context_files`）。 |
| `codex_estimate` | 只读的任务前成本预估：渲染后的 prompt 规模 + 本机已完成任务的 token 统计。 |
| `codex_config` | 只读查看 Codex 当前模型、版本和配置。 |

任务会持久化（`C2C_STATE_DIR`），因此状态查询、结果获取和返工在 server 重启后依然可用。超出并发上限的任务按 FIFO 排队；停滞看门狗会在运行中的任务失去进展时主动上报。关于如何写出"一次过审"的合同，参见实战指南 [PATTERNS.zh-CN.md](./PATTERNS.zh-CN.md)。

## Goal Loop 的工作原理

底层实现中，每个任务会：

1. 启动一个 `codex app-server` 进程（Codex 的 JSON-RPC 接口）
2. 创建（或恢复）一个持久化线程
3. 设置一个 **thread goal** — 相当于 Codex TUI 中 `/goal` 命令的编程等价物
4. 将完整契约作为输入发送

之后 Codex 进入目标持续循环：每一轮结束后它会检查"目标达成了吗？"如果没有，就继续。任务在目标达到终态（`complete` 或 `budget_limited`）或线程沉默时结束。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_BIN` | `codex` | Codex 可执行文件 |
| `CODEX_ARGS` | `app-server` | Codex 启动参数（空格分隔） |
| `CODEX_CWD` | 当前目录 | 任务默认工作目录 |
| `CODEX_MODEL` | Codex 默认 | 模型覆盖 |
| `CODEX_APPROVAL_POLICY` | `never` | 审批策略（默认自主执行） |
| `CODEX_PERMISSIONS` | 未设置 | 权限配置透传 |
| `CODEX_JOB_TIMEOUT_MS` | `1800000` | 单任务最大时长（30 分钟） |
| `CODEX_QUIET_MS` | `30000` | 判定活跃目标已完成前的静默等待时间 |
| `GOAL_OBJECTIVE_MAX` | `2000` | 目标字符串最大长度 |
| `C2C_STATE_DIR` | `~/.claude2codex/jobs` | 持久化任务注册表（每任务一个原子写入的 JSON 文件） |
| `C2C_LOG_LEVEL` | `info` | stderr 上的结构化 JSON 日志：`silent`、`error`、`info`、`debug` |
| `C2C_RETRIES` | `1` | 首个 turn 开始前的进程故障自动重试次数 |
| `C2C_MAX_CONCURRENT` | `2` | 同时活跃的 Codex 任务上限；超出按 FIFO 排队 |
| `C2C_STALL_WARN_MS` | `120000` | 停滞看门狗阈值；发出 stalled/resumed 事件；`0` 禁用 |

## 开发

```sh
cd mcp
bun install
bun test          # 端到端测试（使用 mock，无需真实 API 调用）
npm run build     # 生成 dist/server.js
```

## 协议

MIT
