# Changelog

All notable public-facing changes for Codex Harness Adapter are summarized here.
The project is still private in `package.json`; this file tracks release notes
for maintainers preparing the next public release and does not change package
versioning or publishing metadata.

## 0.5.0

- Claude 的后台命令（`run_in_background` 的 Bash）跨回合存活：回合结束时还有后台命令在跑，Claude 进程就留下，
  后面的回合接着用同一个进程；桌面的后台终端列表、单个停止和全部清理在没有回合进行时也可用，
  命令条目在命令真正结束时才收尾。
- 后台命令自己结束后，Claude 会自行续跑一轮处理结果，界面上显示为一个没有用户消息的新回合；
  这期间发来的消息并入该回合。没有客户端在看这个会话时回合照常执行并保存；遇到需要用户确认的调用，
  回合停在那里一直等，客户端连上并打开这个会话后收到确认请求，答复后继续。
- Claude 入口需要用户确认或回答的请求（命令与文件审批、权限请求、提问、回合里的 MCP 征询）不再因为客户端断开而失效：
  此前回合进行中客户端掉线，已经送达的请求会被当作拒绝，掉线之后才产生的请求则没有人收得到、回合一直卡住；
  现在请求一直留着（不设超时），会话显示为等待批准，客户端重新连上并打开会话后原样送达。
  打断回合、归档会话或适配器退出才会取消；等待期间不受“全部客户端断开后保留多久”的限制。
- 打断回合不再连带停掉后台命令（还在排队的追加指令一并取消）。改工作目录、MCP、工具或指令配置，以及回退、归档、删除会话会结束 Claude 进程并停掉后台命令
  （有提示说明）；改模型、推理强度、计划模式不会。
- 新增 `CHA_CLAUDE_KEEP_ALIVE_SESSIONS`（同时保留后台命令的会话数上限，默认 8，设为 0 则回合结束即停止后台命令）
  与 `CHA_CLAUDE_KEEP_ALIVE_DETACHED_MINUTES`（全部客户端断开后保留多久，默认 30，0 表示一直保留）。
- 修复 Claude 后台命令变成孤儿进程的问题：此前回合结束、适配器退出或崩溃时，后台命令会脱离管理继续运行。
  现在 Claude 进程无论怎样结束，它名下的后台命令都会被清理。
- Claude 回合结束更快：此前被强制结束的 Claude 进程会留下配置文件锁，之后每个回合收尾要多等一秒左右。
- Pi 入口不再自带 Pi 本体，改为加载用户安装的 Pi（`PATH` 中的 `pi` 或 `PI_CLI`），只要求版本不低于 0.99.1；
  升级 Pi 后重启适配器即可生效。Pi 需用 npm 安装，独立二进制不含可加载的运行时。
- 计划模式、子代理和界面组件插件继续随适配器分发；Homebrew 安装中 Pi 部分的依赖从约 295 MB 降到约 14 MB。
- 找不到 Pi、Pi 不是 npm 安装、版本过低或接口与适配器不兼容时，`doctor` 和启动检测给出对应的处理提示，其他入口不受影响。
- 新增实验性的 DeepSeek Harness 入口（`--harness dsh`，默认端口 7333）：使用用户安装的 `dsh`（`PATH` 或 `CHA_DSH_CLI`，
  不低于 0.2.0-rc.2），支持线程列表、发消息、逐字流式输出、提权审批、中断和历史回放；密钥只读取 `DEEPSEEK_API_KEY`，
  会话日志上传默认关闭。本机装有 dsh 时随默认启动一并带起，没装时不提示；其余能力与限制见配置文档。
- DeepSeek Harness 入口在桌面端的表现：新线程的标题由 dsh 生成后推给桌面，不再停在首条消息原文；边栏不再出现以项目路径
  为标题的空条目，dsh 的会话存储里也不再留下空会话（桌面端生成标题用的临时线程只存在于适配器内存里）。命令条目带执行时长，
  `thread/resume` 支持 `excludeTurns`；桌面端会调用而 dsh 没有对应能力的方法明确答复"不适用"，不再报方法不存在。
- Claude 子代理在后台运行时，主回合等到子代理真正结束再收尾，子代理的结果不再丢失；等待期间主回合的输出照常显示。
- Claude 子代理的正文、思考和工具调用显示在它自己的子线程里；结果不再带 CLI 的内部说明文字。
- 可以在已结束的 Claude 子代理子线程里继续追问：消息经主会话原样转给该子代理，子代理带着此前的上下文作答。
  主任务运行中、工作流子代理不支持；追问进行中主线程不能开始新回合。
- Claude 子代理的子线程不再标成临时线程：在桌面端于子代理运行中打开它的子线程，之后的内容、追问的回答和结束状态
  都能显示出来；此前画面停在打开那一刻，线程摘要里一直显示运行中。
- `thread/list` 对子代理线程的处理与 Codex 一致：普通列表不返回，按来源或按父线程、祖先线程查询才返回；
  同时给出 `parentThreadId` 与 `ancestorThreadId` 时报错。子代理线程的昵称创建后不再变化，各处显示同一个名字。
- 声明 2019-09 或 2020-12 草案的 `outputSchema` 不再让 Claude CLI 启动失败，桌面端给新线程起标题的回合因此恢复正常
  （此前一律以“Claude Code process exited with code 1”失败，标题只能取首条消息）。交给 CLI 前换成 draft-07 的等价写法；
  CLI 无法表达的约束（如 `unevaluatedProperties`）和自定义关键字不会被丢掉，回合直接报出原因。
- 恢复 Claude 的任务清单：固定让 CLI 使用 TodoWrite，`turn/plan/updated` 在新模型下重新出现。
- Claude 入口的 MCP 状态：一个服务启动失败不再让排在它后面的服务没有状态；声明了资源能力但没有实现资源模板目录的服务
  不再被判为失败（此前会让整个 MCP 状态列表报错）。
- 删除从未生效的 `CHA_CLAUDE_ENABLE_FILE_CHECKPOINTING`。
- Claude 包的 Node 要求与其余部分一致，放宽为 24（>= 24.0.0）；此前子包仍写着 24.14.0，低于它的 24.x 安装依赖时会有引擎版本警告。
- Pi 入口 `model/list` 的默认推理强度改为该模型实际生效的值；此前对不支持 medium 的模型也报 medium，
  例如 DeepSeek 模型实际按 high 运行。

## 0.4.4

- `thread/resume` 与回退响应返回真实的 `turnsBackwardsCursor` / `itemsBackwardsCursor` 头部游标（Claude 与 Pi）。
  桌面对 `historyMode: paginated` 的线程要求这两个字段，Pi 此前不返回，恢复对话报
  `itemsBackwardsCursor` / `turnsBackwardsCursor` 缺失；Claude 此前返回 null，桌面会把历史当作空。
- `thread/items/list` 的游标改为线程级：桌面用同一个头部游标逐回合带 `turnId` 取条目，此前会被判为无效游标。

## 0.4.3

- Pi 被打断或失败的模型请求不再上报全零用量，桌面的上下文占用不会被清零；
  `thread/resume` 回放最近一次请求的用量，重连或重新打开线程后上下文占用保持可见。

## 0.4.2

- Pi 支持 `thread/archive` / `thread/unarchive`：归档只改变适配器侧列表状态，不改动 Pi 原生会话文件；
  `thread/list` 按 `archived` 过滤，归档活动会话会先中断当前回合。

## 0.4.1

- CLI 启动时读取 `~/.codex-harness-adapter/env`（每行 `KEY=VALUE`），后台服务也可配置
  `CHA_CLAUDE_*`、`PI_CLI`、代理等；启动进程已有的同名变量优先。
- 文档补充 Homebrew 用法、环境文件与 Claude 登录前提，标注仅适用于远程 shim 部署的内容，删除过时的 `TYRS_HAND.md`。

## 0.4.0

- macOS 可通过 `brew install slovx2/tap/codex-harness-adapter` 安装，并用
  `brew services` 在后台常驻；依赖 Homebrew 的 `node@24`。
- Node 要求放宽为 24（>= 24.0.0）；CLI 检查不满足时直接报错。
- Linux 运行包不再附带 Node，改用宿主 PATH 中的 Node 24。
- CLI 通过符号链接启动时按真实安装位置推导根目录。

## Unreleased

### App-server and protocol compatibility

- Updated the adapter to advertise Codex app-server protocol v2 compatibility at
  the current pinned Codex CLI compatibility version, while keeping a
  `codex-harness-adapter` suffix so hosts can distinguish the adapter from upstream
  Codex.
- Expanded Codex App Remote coverage across thread lifecycle, turn envelopes,
  item streaming, approvals, MCP status, fuzzy file search sessions, Claude
  skills/hooks, and `thread/turns/list` item views.
- Added protocol fixture coverage for `config/read`, including the sanitized
  `config.provider_loop_config` shape, so the Rust fixture drift gate covers
  provider-loop config projection behavior.
- Kept compatibility-only account, plugin, marketplace, realtime, and other
  OpenAI-specific surfaces inert or schema-shaped where Claude Code has no
  equivalent.
- Aligned `process/spawn` and `command/exec` with Codex 0.157.1: 10s default
  timeout with exit code 124, immediate process-group SIGKILL on
  kill/terminate/disconnect/timeout, 1 MiB per-stream output cap with
  `capReached` on the truncating chunk, 2s post-exit output drain, native error
  codes and messages, and the native non-inheritable environment filtering.
  PTY sessions keep running through `scripts/pty-bridge.py` (handshake reports
  spawn success or failure), which the packaged runtime now ships alongside a
  `--pty-self-check` build gate.
- Ported `gitDiffToRemote` from Codex 0.157.1 `git-utils`: the base is the
  closest commit that also exists on a remote (current branch, default branch,
  then remote branches containing HEAD), the diff includes unpushed commits and
  untracked files, and a missing base is a -32600 error.
- Aligned `fuzzyFileSearch` sessions with Codex: the tree is indexed once
  (hidden entries, directories, symlinks followed, gitignore only inside git
  repos), `sessionUpdate` responds before `sessionUpdated` + `sessionCompleted`,
  stale queries are dropped, and `sessionStop` sends no completion. Unlike
  Codex, notifications go to the connection that last started or updated the
  session instead of every connection.
- Implemented `thread/backgroundTerminals/list|terminate|clean` over the live
  turn's background Bash tasks (`background_tasks_changed` / `stopTask`).
  Background shells end with the per-turn CLI, and `processId` matches the Bash
  item (`claude:<toolUseId>`) rather than a numeric OS pid.

### Provider and multi-agent boundaries

- Added the provider and multi-agent loop boundaries RFC to separate runtime
  backends, provider metadata, agent-loop fidelity, credential ownership, and
  subscription/entitlement boundaries.
- Added static provider/agent-loop descriptors with validation for allowed and
  unsupported credential source labels.
- Added sanitized provider-loop projection helpers and exposed the read-only
  `config.provider_loop_config` field through `config/read`.
- Added explicit provider/agent-loop selection for known descriptor ids and loop
  ids. Selection maps only to existing runtime backends, preserves legacy
  runtime environment overrides and `CHA_CLAUDE_MOCK=1` precedence, filters
  raw saved selection keys from public `config/read`, and exposes sanitized
  selection metadata through `config.provider_loop_config.selection`.
- Added tests proving built-in descriptors validate cleanly, unsupported
  credential labels are not projected as allowed, and secret-like descriptor
  text is redacted from public projection results.

### Rust-first protocol groundwork

- Added the Rust-first runtime boundaries RFC, keeping the TypeScript
  app-server adapter as the shipping runtime path while defining incremental
  Rust protocol, transport, store, and launcher boundaries.
- Added an experimental Rust workspace scaffold and protocol crate with
  representative Codex app-server JSON fixtures.
- Added Rust parse/reserialize tests for the covered fixtures.
- Added a pinned fixture drift check against the configured Codex CLI version
  and made it part of CI alongside `cargo test --workspace`.
- Extended fixture coverage to include config projection data without claiming a
  Rust production runtime, transport, store, or provider execution path.

### Release readiness and compliance docs

- Added open-source compliance documentation and release-readiness reference
  material for maintainers and reviewers.
- Clarified the README and documentation homepage around the TypeScript
  production path, Rust-first experimental boundaries, provider/agent-loop
  descriptor and selection boundaries, supported credential ownership models,
  unsupported subscription/session/private endpoint/bypass behavior, and release
  verification expectations.
- Documented provider selection configuration for `CHA_CLAUDE_PROVIDER`,
  `CHA_CLAUDE_AGENT_LOOP`, saved provider-loop config keys, precedence rules,
  and sanitized `config.provider_loop_config.selection` projection.
- Documented the current shippable baseline: TypeScript remains the production
  path; Rust pieces are opt-in protocol boundary work; provider/loop descriptors
  are read-only metadata, not runtime dispatch.
- Documented supported credential ownership models: local user-provided API
  keys, official cloud-provider credential chains, organization-managed
  gateways, and local CLI auth for same-host user-directed execution.
- Documented unsupported credential models, including personal subscription
  sharing, browser cookie/session-token reuse, private provider endpoints,
  bypass guidance, and credential redistribution.

### Validation and release gates

- Default CI runs Biome checks, TypeScript typechecking, the Node test suite,
  Rust workspace tests, and the pinned Rust protocol fixture drift gate.
- Documentation changes should run `npm run docs:build`.
- Credentialed smoke and acceptance checks remain opt-in and must use
  credentials already owned by the local user or organization on the host.

### Still experimental or not yet included

- No Rust production runtime, transport, store, provider execution path, or
  default-on Rust launcher is included.
- No executable new provider loop is included beyond the existing runtime
  backends.
- No broad runtime dispatch rewrite is included.
- No new credential collection model is included.
- No support is included for personal subscription sharing, credential pooling,
  browser cookie/session-token reuse, private provider endpoints, or provider
  bypass behavior.
