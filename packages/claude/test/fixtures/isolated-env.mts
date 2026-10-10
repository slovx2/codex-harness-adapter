import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 被测进程不继承个人环境：只保留运行必需的变量，主目录指向空的临时位置。
// 否则本机的用户级 MCP 服务、模型凭据和代理会进入被测进程，结果随机器而变。
// CLAUDE_CONFIG_DIR 不继承也不设置，Claude 配置随主目录落在空目录里；
// 需要用户级配置的用例自行覆盖 HOME。
const root = mkdtempSync(join(tmpdir(), 'codex-harness-adapter-env-'))
process.once('exit', () => rmSync(root, { recursive: true, force: true }))

const inherited = [
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'USER',
  'LOGNAME',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  // 真实 SDK 用例需要的隔离 CLI，由运行测试的人显式指定。
  'CHA_CLAUDE_CLI',
]

export const isolatedEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    inherited.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  ),
  HOME: root,
  USERPROFILE: root,
}
