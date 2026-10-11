# test/AGENTS.md

Tests run with the built-in `node:test` runner against compiled output. See the
[root AGENTS.md](../AGENTS.md) for project-wide conventions.

## Layout

- `*.test.mts` — sources compiled to `packages/claude/dist/claude/test/*.mjs`.
- `fixtures/` — shared test fixtures.

## Running

```bash
npm test            # builds, then runs node --test packages/claude/dist/claude/test/*.mjs
npm run build       # if you want to compile without running
node --test packages/claude/dist/claude/test/adapter.test.mjs   # a single suite, after a build
```

## Conventions

- Tests import from `dist/` (compiled `.mjs`), so **always build first** —
  `npm test` does this for you; editing a `.mts` and re-running raw
  `node --test` without a rebuild tests stale output.
- Use `CHA_CLAUDE_MOCK=1` to exercise protocol behavior without Claude
  credentials. Credentialed end-to-end checks live in `scripts/acceptance-*`,
  not here.
- Add new suites as `<area>.test.mts`; the `npm test` glob picks them up.
- 测试不继承个人环境。启动被测进程时用 `fixtures/isolated-env.mts` 的 `isolatedEnv` 作为基础环境，
  不要展开 `process.env`：本机的用户级 MCP 服务、模型凭据和代理会让结果随机器而变。
  `npm test` 另用 `--import` 预加载 `fixtures/isolate-process.mts`，测试进程自身的主目录也是空的临时目录；
  直接用 `node --test` 跑单个文件时没有这层预加载。
- 等待被测进程输出必须有超时（`adapter.test.mts` 的读取器默认 60 秒），出问题要失败，不能无限挂起。
- 真实 CLI 用例只用 `CHA_CLAUDE_CLI` 指定的隔离 CLI，规则集中在 `fixtures/claude-cli.mts`。没设置时不跳过，
  也不改用 PATH 里的 `claude`：`ProtocolClient`（非 mock）和 `OAuthDaemonFixture` 立即抛错并说明原因；
  `isolatedEnv` 与 `isolate-process` 把它设成一个不存在的路径，被测进程和进程内解析 CLI 路径的用例会报“未找到”。
  新增会启动适配器的夹具时用 `requiredClaudeCli()` / `configuredClaudeCli()`，不要直接透传 `process.env.CHA_CLAUDE_CLI`。
- 会启动进程或监听端口的夹具要用 `fixtures/reclaim.mts` 的 `reclaimAtEnd` 登记收尾，`close()` 要能重复调用且有时限。
  用例超时或在进入 `try` 之前失败时自己的 `finally` 不会执行，留下的进程和端口会让测试文件一直不退出。
  `npm test` 另带 `--test-force-exit`：用例都结束后先执行上面登记的收尾，再退出进程，用例里自己建的
  监听端口不会再把文件挂住。直接用 `node --test` 跑单个文件时建议也带上（`test-harness.test.mts` 固定了这几种情形）。
