import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliCommand } from '../../shared/src/host-cli.mjs'
import { type RemoteHandlers, WebRemote } from './remote.mjs'
import { compatibilityHint, detectHostDsh, type HostDsh } from './versions.mjs'

// 关闭 dsh 默认随模型请求上传的会话日志；CHA_DSH_SESSION_LOG=1 时保留 dsh 默认行为。
const SESSION_LOG_OFF = '- id: session-log-deepseek\n  config:\n    enabled: false\n'
const redact = (text: string) => text.replace(/token=[\w-]+/g, 'token=<已隐去>')

// 看护一个长驻的 `dsh --profile web` 子进程，所有线程共用；进程退出后下次使用时重新拉起。
// dsh 是用户自己安装的可执行文件，每次拉起前重新定位并核对版本下限。
export class DshRuntime {
  // 最近一次拉起时检测到的 dsh；尚未拉起过时为 null。
  host: HostDsh | null = null
  private readonly home: string
  private readonly handlers: RemoteHandlers
  private child: ChildProcess | null = null
  private starting: Promise<WebRemote> | null = null
  private closing = false

  constructor(home: string, handlers: RemoteHandlers) {
    this.home = home
    this.handlers = handlers
    process.once('exit', () => this.child?.kill('SIGKILL'))
  }

  remote(): Promise<WebRemote> {
    if (this.closing) return Promise.reject(new Error('适配器正在关闭'))
    this.starting ??= this.start().catch((error) => {
      this.starting = null
      throw error
    })
    return this.starting
  }

  private async start(): Promise<WebRemote> {
    const nativeHome = join(this.home, 'dsh-home')
    const workdir = join(this.home, 'dsh-runtime')
    for (const directory of [nativeHome, workdir])
      mkdirSync(directory, { recursive: true, mode: 0o700 })
    const host = detectHostDsh()
    this.host = host
    if (!host.verified)
      console.error(`[dsh] 这个版本的 dsh 尚未验证，如遇异常：${compatibilityHint(host.version)}`)
    // 启动器选项（--patch）必须写在 profile 自己的选项之前。
    const args = ['--profile', 'web']
    if (process.env.CHA_DSH_SESSION_LOG !== '1') {
      const patch = join(this.home, 'dsh.patch.yml')
      writeFileSync(patch, SESSION_LOG_OFF, { mode: 0o600 })
      args.push('--patch', patch)
    }
    args.push('--no-open', '--port', '0')
    const [command, ...commandArgs] = cliCommand(host.cli, args)
    const child = spawn(command as string, commandArgs, {
      cwd: workdir,
      env: {
        ...process.env,
        DSH_HOME: nativeHome,
        DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
      process.stderr.write(redact(chunk.toString()))
    })
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.starting = null
    })
    // 就绪行带一次性令牌：只在内存里解析，标准输出一律不转写到日志。
    const launchUrl = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(
        () =>
          reject(
            new Error(`dsh 启动后没有给出 Web 入口地址（${compatibilityHint(host.version)}）`),
          ),
        60000,
      )
      child.stdout.on('data', (chunk: Buffer) => {
        if (output.length > 65536) return
        output += chunk.toString()
        const url = /dsh web: (http:\/\/\S+)/.exec(output)?.[1]
        if (!url) return
        clearTimeout(timer)
        resolve(url)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`无法启动 dsh: ${error.message}`))
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`dsh 提前退出（${code}）: ${redact(stderr).trim().slice(-600)}`))
      })
    }).catch((error) => {
      child.kill('SIGKILL')
      throw error
    })
    return WebRemote.connect(launchUrl, host.version, {
      waterfall: this.handlers.waterfall,
      emit: this.handlers.emit,
      closed: (error) => {
        if (this.child === child) {
          this.child = null
          this.starting = null
          child.kill('SIGTERM')
        }
        if (!this.closing) this.handlers.closed(error)
      },
    })
  }

  async close(): Promise<void> {
    this.closing = true
    const remote = await this.starting?.catch(() => null)
    remote?.close()
    const child = this.child
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await exited
    clearTimeout(timer)
  }
}
