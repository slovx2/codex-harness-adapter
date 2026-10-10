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
