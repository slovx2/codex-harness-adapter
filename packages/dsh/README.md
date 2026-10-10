# DeepSeek Harness 适配器（实验性）

把 DeepSeek Harness（dsh）的原生会话映射到 Codex app-server 协议。当前是实验性入口：覆盖线程列表、发消息、逐字流、提权审批（含中断与重启后的历史回放），其余能力见文末。面向用户的说明在[配置文档](../../docs/guide/configuration.md)。

## 接入方式

dsh 本体不随适配器分发：适配器使用用户自己安装的 `dsh`，默认从 PATH 查找，`CHA_DSH_CLI` 可指定路径。它看护一个长驻的 `dsh --profile web --no-open --port 0` 子进程，经 Web Remote 接口（HTTP 一元调用加 WebSocket 流）驱动全部会话：

- 历史只存在 dsh 自己的会话存储里，适配器每次从 `session/follow` 的快照回放，不另存一份；适配器数据库只放归档标记、项目归属等界面元数据。
- 回合、条目标识由 dsh 的回合号、步号、块序号和工具调用号推出，实时增量与落盘消息、重启前后都一致。
- dsh 只在模型申请沙箱提权时询问，裁决只有"允许这一次"和"拒绝"；对应 Codex 的命令审批与文件改动审批。
- 权限三档与 Codex 一一对应（`read-only`、`workspace-write`、`danger-full-access`），切换时向会话执行 `/permission`。

## 版本

对用户安装的 dsh 只设下限（`src/versions.mts` 的 `dshMinimum`，当前 `0.2.0-rc.2`，与 `protocol/versions.json` 的登记一致并有测试核对），不低于它即可。dsh 还没有稳定版，下限落在预发布号上，所以 dsh 入口按 semver 比较预发布标识（共用的下限判断只接受稳定版）。

Web Remote 是 dsh 的私有接口，没有版本协商，高于下限的新版本可能不兼容。实际验证过的版本单独记在 `dshVerified`，不参与放行：遇到方法不存在、参数被网关拒绝或返回结构不符时，报错会带上当前 dsh 版本和这份清单；启动未验证的版本时在运行日志里提示一次。

## 运行

```sh
npm run setup                                         # 根目录的 setup、build、typecheck 已包含本包
bin/codex-harness-adapter doctor --harness dsh
bin/codex-harness-adapter start --harness dsh         # 只启动 dsh 入口
bin/codex-harness-adapter start                       # 全部启动：检测到本机装有 dsh 才带上 dsh 入口
```

默认 SSH 端口 7333（全部启动时用 `--dsh-port` 修改），主机别名 `codex-harness-adapter-dsh`。全部启动时 dsh 是实验阶段的特例：没装 dsh（`PATH` 里没有且未设置 `CHA_DSH_CLI`）就不出现、不告警；装了但版本低于下限或启动失败时与另外两个入口一样只告警。`DEEPSEEK_API_KEY` 只从启动环境继承（或写在 `<home>/env`），适配器不读取 `~/.dsh` 下的登录态；没有密钥时回合以 dsh 的原始报错结束。

| 变量 | 作用 |
| --- | --- |
| `CHA_DSH_CLI` | 用户安装的 dsh 可执行文件；不设置时从 PATH 查找 `dsh` |
| `CHA_DSH_HOME` | 适配器状态目录（CLI 启动时自动设为 `<home>/dsh`）；dsh 的 `DSH_HOME` 固定在其下的 `dsh-home` |
| `CHA_DSH_SESSION_LOG=1` | 保留 dsh 默认的会话日志上传；不设置时适配器启动的 dsh 一律关闭上传 |
| `CHA_DSH_TRACE=<文件>` | 调试用，逐行记录与客户端往来的协议消息 |
| `DSH_TELEMETRY_DISABLED` | 未设置时置为 `1` |

## 验证

```sh
export CHA_DSH_CLI=<本机已安装的 dsh>      # PATH 里有 dsh 时可省略
npm run test:dsh                         # 包级测试：回环 mock 模型，往来消息按协议 schema 校验
npm run test:dsh-ssh                     # 隔离实例经真实 SSH 走一遍四件事后清理退出（macOS）
node scripts/dsh-poc-serve.mjs --gui     # 同一实例常驻，写入 ~/.ssh/config.d/cha-dsh-poc 供桌面端连接
```

测试与隔离实例都使用假密钥、临时目录和回环 mock 模型，不读取个人配置；隔离实例整体运行在只允许回环外连的沙箱里。测试需要本机已安装 dsh，没有时直接失败而不是跳过，因此不并入根目录的 `npm test`；CI 的 `dsh` 任务按 `protocol/versions.json` 的 `dshMinimum` 把 dsh 装到临时前缀后运行。

## 尚未覆盖

历史分页（快照之外更早的记录）、计划与提问、用户消息中的图片回显、分叉与回滚、压缩、子代理展示、MCP 管理、技能列表、`thread/timeline/list`。只在 macOS 上验证过；真实桌面界面与真实 DeepSeek 端点尚未经适配器端到端验证。
