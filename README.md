# c2c-mcp

`c2c-mcp` is a Model Context Protocol server that lets an MCP client delegate Goal and Delta Contracts to the Codex CLI and retrieve structured implementation handoffs.

## Installation

Install the [Codex CLI](https://github.com/openai/codex), then start the server directly from npm (Node.js 18 or newer is required):

```sh
npx c2c-mcp
```

## Configuration

Add the server to your MCP client's configuration:

```json
{
  "mcpServers": {
    "c2c": {
      "command": "npx",
      "args": ["-y", "c2c-mcp"]
    }
  }
}
```

The server communicates over standard input/output and exposes tools for starting an implementation, checking its status, retrieving its result, and requesting rework.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | Codex executable to launch. |
| `CODEX_ARGS` | `app-server` | Space-separated Codex arguments. |
| `CODEX_CWD` | Current directory | Default working directory for jobs. |
| `CODEX_MODEL` | Codex default | Model override. |
| `CODEX_APPROVAL_POLICY` | `never` | Approval policy used for Codex jobs. |
| `CODEX_PERMISSIONS` | Unset | Permissions profile passed to Codex. |
| `CODEX_JOB_TIMEOUT_MS` | `1800000` | Maximum job duration in milliseconds. |
| `CODEX_QUIET_MS` | `30000` | Quiet period before an active job is considered finished. |
| `GOAL_OBJECTIVE_MAX` | `2000` | Maximum generated goal-objective length. |
