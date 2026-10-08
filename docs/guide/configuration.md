# Configuration

本地入口用 `npm start` 或 Homebrew 的 `codex-harness-adapter start` / `brew services` 启动；无需修改登录 shell 或全局 PATH。
默认自动检测 Claude/Pi，`--harness` 可选择单引擎，`--claude-port` / `--pi-port` 可设置两个 SSH 端口，单引擎用 `--port`。
完整命令见[开始使用](/guide/getting-started)，桌面连接见[配置指南](/guide/gui)。

## 环境文件

适配器启动时读取 `~/.codex-harness-adapter/env`（`--home` 改变状态目录时为 `<home>/env`），每行 `KEY=VALUE`，空行和 `#` 开头的行忽略，允许 `export` 前缀和成对引号，值按字面使用、不做变量展开。
后台服务不继承终端环境，下列变量及代理、`PI_CLI` 等都应写在这里；修改后重启服务（`brew services restart codex-harness-adapter`）。

```sh
# ~/.codex-harness-adapter/env
CHA_CLAUDE_DEFAULT_MODEL=opus
HTTPS_PROXY=http://127.0.0.1:7890
```

优先级：适配器固定变量（`CODEX_HOME`、`CHA_CLAUDE_HOME`、`CHA_PI_HOME`、`CHA_CLAUDE_IDLE_EXIT_MS`）> 启动进程已有的同名变量 > 环境文件。
文件里写入密钥时用 `chmod 600` 限制权限，不要提交到任何仓库。

下列高级环境变量主要控制 Claude 适配器（`CHA_CLAUDE_*`）。Pi 使用原生 `PI_CODING_AGENT_DIR` 和 `PI_CLI`。

## Runtime backend

```bash
# Default uses the in-process Claude Agent SDK.
export CHA_CLAUDE_RUNTIME_TYPE="agent-sdk-sidecar"
#   codex      - pass app-server through to the real Codex CLI (shim layer)
#   agent-http - HTTP/SSE bridge for Claude Code Channels / agent-http
#   agentapi   - HTTP/SSE bridge for coder/agentapi
#   claude-p   - one-shot PTY/transcript wrapper via claude-p
#   mock       - local protocol testing
```

See [Backends](/guide/backends) for what each route supports. 本地入口在环境文件中设置 `CHA_CLAUDE_RUNTIME_TYPE` 后重启生效（`codex` 直通依赖 shim，除外）；`codex-harness-adapter-mode` 只用于远程 shim 部署。

## Provider and agent-loop selection

Provider selection is descriptor metadata plus routing to existing runtime
backends. It does not add a new provider runtime, auth flow, subscription model,
gateway, or entitlement.

```bash
# Known provider descriptor ids.
export CHA_CLAUDE_PROVIDER="claude-code" # or "codex"

# Known agent-loop ids.
export CHA_CLAUDE_AGENT_LOOP="native-claude-code-sdk" # or "codex-jsonl-proxy"
```

Current mappings:

| Provider / loop | Existing runtime behavior |
| --- | --- |
| `claude-code` / `native-claude-code-sdk` | `agent-sdk-sidecar` |
| `codex` / `codex-jsonl-proxy` | `codex-proxy` |

Backward compatibility rules:

- `CHA_CLAUDE_RUNTIME_TYPE`, `CHA_CLAUDE_RUNTIME`, and
  `CHA_CLAUDE_BACKEND` still override provider selection when set.
- `CHA_CLAUDE_MOCK=1` still forces the `mock` runtime.
- Saved config can set `provider_loop_provider` and
  `provider_loop_agent_loop` through `config/value/write`.
- Raw saved selection keys are filtered out of public `config/read`; the safe
  projection appears under `config.provider_loop_config.selection`, with
  redacted validation issues when a selection is unknown or mismatched.

Selection must stay within supported credential ownership models. It does not
collect or share credentials, pool personal subscriptions, reuse browser cookies
or session tokens, configure private endpoints, or bypass provider terms.

## Models & effort

```bash
# Defaults for new threads, surfaced through config/read.
export CHA_CLAUDE_DEFAULT_MODEL="sonnet"
export CHA_CLAUDE_DEFAULT_EFFORT="medium"

# Codex App model picker list (comma-separated ids or JSON array of ids/objects).
export CHA_CLAUDE_MODELS="sonnet,opus,fable,haiku,sonnet-1m,opus-plan"

# Map Codex UI ids -> Claude SDK aliases/full names, and effort values.
export CHA_CLAUDE_MODEL_ALIASES='{"my-long-context":"sonnet[1m]"}'
export CHA_CLAUDE_EFFORT_ALIASES='{"xhigh":"max"}'
```

## MCP, tools & directories

```bash
# Passed to ClaudeAgentOptions (JSON object or path to a JSON file).
export CHA_CLAUDE_MCP_SERVERS='{"github":{"type":"stdio","command":"github-mcp"}}'

# Pre-approved tools (others still route through Codex approval) + extra dirs.
export CHA_CLAUDE_ALLOWED_TOOLS="Read,Glob,Grep"
export CHA_CLAUDE_ADD_DIRS="/repo/shared,/repo/docs"
export CHA_CLAUDE_ENABLE_FILE_CHECKPOINTING=1
```

## Worktree isolation

```bash
# Per-thread git worktree isolation (off by default — it creates branches).
export CHA_CLAUDE_AUTO_WORKTREE=1
export CHA_CLAUDE_WORKTREE_ROOT="$HOME/.codex-harness-adapter/worktrees"
```

When enabled, each new Codex thread runs in a dedicated `git worktree`.

## Daemon（仅远程 shim 部署）

以下变量只对[远程主机 shim 部署](/guide/deployment)生效；本地 SSH 入口固定不空闲退出，并通过 `--node` 选择 Node。

```bash
# Idle shutdown grace period in ms (default 15000; 0 = never exit).
export CHA_CLAUDE_IDLE_EXIT_MS="15000"

# Pin a node binary for the shim (e.g. when default node is < 24).
export CHA_CLAUDE_NODE="/absolute/path/to/node"
```

## Reference table

| Setting | Purpose |
| --- | --- |
| `CHA_CLAUDE_ADAPTER` | 仅 shim：`packages/claude/dist/claude/src/adapter.mjs` 路径。 |
| `CHA_CLAUDE_NODE` | 仅 shim：shim 启动的 Node。本地入口用 `--node`。 |
| `CHA_CLAUDE_COMPAT_VERSION` | Codex app-server version advertised (default `0.157.1`); separate from minimum CLI versions. |
| `CHA_CLAUDE_VERSION_SUFFIX` | Tag after the version to distinguish the adapter from real codex (default `codex-harness-adapter`; set `""` to behave exactly like upstream codex). |
| `CODEX_REAL` | 仅 shim：处理非 app-server 命令和 `codex` 直通的真实 Codex CLI。 |
| `CHA_CLAUDE_CLI` | 宿主 Claude Code 可执行文件，默认从 PATH 查找 claude。运行时诊断接受 CLI >= 2.1.282 的稳定版，配置仍由原生 CLAUDE_CONFIG_DIR 提供。 |
| `CHA_CLAUDE_RUNTIME_TYPE` | Active backend route. |
| `CHA_CLAUDE_PROVIDER` | Provider descriptor id (`claude-code` or `codex`) mapped only to existing runtime behavior. |
| `CHA_CLAUDE_AGENT_LOOP` | Agent-loop id (`native-claude-code-sdk` or `codex-jsonl-proxy`) mapped only to existing runtime behavior. |
| `provider_loop_provider` | Saved config key for provider descriptor selection via `config/value/write`. |
| `provider_loop_agent_loop` | Saved config key for agent-loop selection via `config/value/write`. |
| `CHA_CLAUDE_DEFAULT_MODEL` / `_EFFORT` | Defaults for new threads. |
| `CHA_CLAUDE_MODELS` | Codex App model picker list. |
| `CHA_CLAUDE_MODEL_ALIASES` / `_EFFORT_ALIASES` | Id remapping. |
| `CHA_CLAUDE_MCP_SERVERS` | MCP server config (JSON or file path). |
| `CHA_CLAUDE_ALLOWED_TOOLS` | Pre-approved tools. |
| `CHA_CLAUDE_ADD_DIRS` | Extra directories exposed to Claude. |
| `CHA_CLAUDE_ENABLE_FILE_CHECKPOINTING` | Enable SDK file checkpointing. |
| `CHA_CLAUDE_AUTO_WORKTREE` / `_WORKTREE_ROOT` | Per-thread worktree isolation. |
| `CHA_CLAUDE_IDLE_EXIT_MS` | 仅 shim：守护进程空闲退出；本地入口固定为 `0`。 |
| `CHA_CLAUDE_MOCK` | Run the protocol without Claude credentials. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Claude auth / custom endpoint configuration. Keep real values out of git. |
