import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 由测试命令用 --import 预加载：测试进程自身也不读取个人配置。
// 进程内构造服务对象的用例会经 homedir() 读到本机用户级的 MCP、技能与设置。
const home = mkdtempSync(join(tmpdir(), 'codex-harness-adapter-home-'))
process.once('exit', () => rmSync(home, { recursive: true, force: true }))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.CLAUDE_CONFIG_DIR
