import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { DshServer } from '../src/server.mjs'
import { startMockModel } from './mock-model.mjs'
import { assertNotification, assertResponse, assertServerRequest } from './schema.mjs'

// 假客户端：记录通知，按 handler 应答服务端发起的反向请求；往来消息一律按协议 schema 校验。
// schema 违例先收集、最后统一断言：在发送路径上直接抛错会被服务端当成回合失败吞掉。
const violations = new Set<string>()
const checked = (check: () => void) => {
  try {
    check()
  } catch (error) {
    violations.add(String((error as Error).message).slice(0, 600))
  }
}

function client(server: DshServer) {
  const notifications: any[] = []
  const requests: any[] = []
  const waiting = new Map<string, (message: any) => void>()
  let answer: (request: any) => unknown = () => ({})
  const peer: RpcPeer = {
    id: randomUUID(),
    close() {},
    send(message: WireMessage) {
      const wire = message as any
      if (wire.method && wire.id !== undefined) {
        checked(() => assertServerRequest(wire.method, wire.params))
        requests.push(wire)
        void server.handle(peer, { jsonrpc: '2.0', id: wire.id, result: answer(wire) })
      } else if (wire.method) {
        checked(() => assertNotification(wire.method, wire.params))
        notifications.push(wire)
      } else waiting.get(String(wire.id))?.(wire)
    },
  }
  return {
    peer,
    notifications,
    requests,
    onRequest(handler: (request: any) => unknown) {
      answer = handler
    },
    async call(method: string, params: unknown = {}): Promise<any> {
      const id = randomUUID()
      const reply = new Promise<any>((resolve) => waiting.set(id, resolve))
      await server.handle(peer, { jsonrpc: '2.0', id, method, params })
      const message = await reply
      if (message.error) throw new Error(`${method}: ${message.error.message}`)
      checked(() => assertResponse(method, message.result))
      return message.result
    },
    async until(method: string, match: (params: any) => boolean = () => true): Promise<any> {
      for (let waited = 0; waited < 20000; waited += 20) {
        const found = notifications.find((entry) => entry.method === method && match(entry.params))
        if (found) return found.params
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`等待通知超时: ${method}`)
    },
  }
}

test('dsh：线程列表、发消息、逐字流、提权审批、历史回放与中断', { timeout: 120000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-harness-adapter-dsh-')))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await writeFile(join(cwd, 'a.txt'), 'hello\n')
  const model = await startMockModel([
    [
      { type: 'thinking', text: '先读文件。' },
      { type: 'text', chunks: ['逐', '字', '输', '出'], delayMs: 60 },
      { type: 'tool_use', name: 'read', input: { file_path: 'a.txt' } },
    ],
    [
      {
        type: 'tool_use',
        name: 'edit',
        input: { file_path: 'a.txt', old_string: 'hello', new_string: 'world' },
      },
    ],
    [
      {
        type: 'tool_use',
        name: 'bash',
        input: {
          command: 'echo approved',
          description: '需要提权的命令',
          sandbox_permissions: 'danger-full-access',
          justification: '测试提权审批。',
        },
      },
    ],
    [{ type: 'text', chunks: ['第一轮完成。'] }],
    [
      {
        type: 'tool_use',
        name: 'bash',
        input: {
          command: 'echo denied > denied.txt',
          description: '会被拒绝的命令',
          sandbox_permissions: 'danger-full-access',
          justification: '测试拒绝。',
        },
      },
    ],
    [{ type: 'text', chunks: ['已停止提权。'] }],
    [
      {
        type: 'tool_use',
        name: 'bash',
        input: { command: 'echo plain-ok', description: '普通命令' },
      },
    ],
    [{ type: 'tool_use', name: 'bash', input: { command: 'exit 3', description: '失败的命令' } }],
    [{ type: 'text', chunks: ['命令跑完了。'] }],
    [{ type: 'text', chunks: Array.from({ length: 80 }, (_, i) => `慢${i} `), delayMs: 100 }],
  ])
  // 子进程继承这些变量：回环模型、假密钥、隔离的状态目录，不读取个人配置。
  const saved = { ...process.env }
  Object.assign(process.env, {
    DEEPSEEK_BASE_URL: model.url,
    DEEPSEEK_API_KEY: 'mock-not-a-real-key',
    DSH_AGENTS_HOME: join(root, 'agents-home'),
  })
  let server = new DshServer(join(root, 'home'))
  try {
    let desktop = client(server)
    await desktop.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const models = await desktop.call('model/list')
    assert.ok(models.data.some((entry: any) => entry.isDefault))
    assert.deepEqual(
      models.data[0].supportedReasoningEfforts.map((entry: any) => entry.reasoningEffort),
      ['off', 'low', 'high', 'max'],
    )

    const started = await desktop.call('thread/start', { cwd, permissions: ':workspace' })
    const threadId = started.thread.id
    assert.equal(started.cwd, cwd)
    assert.equal(started.permissions, ':workspace')
    assert.deepEqual((await desktop.call('thread/list', {})).data, [], '空白会话不进列表')

    desktop.onRequest((request) => {
      assert.equal(request.method, 'item/commandExecution/requestApproval')
      assert.equal(request.params.command, 'echo approved')
      assert.match(request.params.reason, /danger-full-access/)
      assert.deepEqual(request.params.availableDecisions, ['accept', 'decline', 'cancel'])
      return { decision: 'accept' }
    })
    const clientUserMessageId = randomUUID()
    const { turn } = await desktop.call('turn/start', {
      threadId,
      clientUserMessageId,
      input: [{ type: 'text', text: '按步骤执行。' }],
    })
    assert.equal(turn.id, 'turn:1')
    const again = await desktop.call('turn/start', {
      threadId,
      clientUserMessageId,
      input: [{ type: 'text', text: '按步骤执行。' }],
    })
    assert.equal(again.turn.id, turn.id, '同一提交标识不会开第二个回合')
    const completed = await desktop.until('turn/completed')
    assert.equal(completed.turn.status, 'completed')
    // 协议约定：回合起止时间为秒，时长为毫秒。
    assert.ok(Math.abs(completed.turn.startedAt - Date.now() / 1000) < 120)
    assert.ok(completed.turn.completedAt >= completed.turn.startedAt)
    assert.ok(completed.turn.durationMs > 200 && completed.turn.durationMs < 60000)

    const deltas = desktop.notifications.filter(
      (entry) => entry.method === 'item/agentMessage/delta',
    )
    assert.deepEqual(
      deltas.slice(0, 4).map((entry) => entry.params.delta),
      ['逐', '字', '输', '出'],
      '正文按增量到达',
    )
    const reasoning = desktop.notifications.find(
      (entry) => entry.method === 'item/reasoning/summaryTextDelta',
    )
    assert.equal(reasoning?.params.delta, '先读文件。')
    const items = completed.turn.items
    assert.deepEqual(
      items.map((item: any) => item.type),
      [
        'userMessage',
        'reasoning',
        'agentMessage',
        'mcpToolCall',
        'fileChange',
        'commandExecution',
        'agentMessage',
      ],
    )
    assert.equal(items[0].clientId, clientUserMessageId)
    assert.equal(items[2].text, '逐字输出')
    assert.equal(items[2].id, deltas[0]?.params.itemId, '增量与落盘条目同一标识')
    assert.equal(items[4].changes[0].kind.type, 'update')
    assert.match(items[4].changes[0].diff, /-hello\n\+world/)
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'world\n')
    assert.equal(items[5].status, 'completed')
    assert.equal(items[5].exitCode, 0)
    assert.match(items[5].aggregatedOutput, /approved/)
    assert.equal(desktop.requests.length, 1, '只在提权时询问一次')
    assert.ok(desktop.notifications.some((entry) => entry.method === 'thread/tokenUsage/updated'))
    assert.ok(
      model.requests.every((request) => !('dsh_session_log' in request)),
      '默认不上传会话日志',
    )

    const listed = await desktop.call('thread/list', { cwd })
    assert.deepEqual(
      listed.data.map((thread: any) => thread.id),
      [threadId],
    )
    assert.equal(listed.data[0].preview, '按步骤执行。')

    // 桌面端连接与打开线程时会用到的其余方法：应答都要符合协议 schema（由 call 内的校验收集）。
    const probes: Array<[string, Record<string, unknown>]> = [
      ['runtime/info', {}],
      ['account/read', {}],
      ['getAuthStatus', {}],
      ['account/rateLimits/read', {}],
      ['configRequirements/read', {}],
      ['modelProvider/capabilities/read', {}],
      ['config/read', { cwd }],
      [
        'config/value/write',
        { keyPath: 'model', value: models.data[0].id, mergeStrategy: 'replace' },
      ],
      ['collaborationMode/list', {}],
      ['permissionProfile/list', { cwd }],
      ['experimentalFeature/list', {}],
      ['app/list', {}],
      ['plugin/list', {}],
      ['hooks/list', { cwds: [cwd] }],
      ['skills/list', { cwds: [cwd] }],
      ['externalAgentConfig/detect', {}],
      ['currentTime/read', {}],
      ['threadSection/list', {}],
      ['thread/loaded/list', {}],
      ['thread/read', { threadId, includeTurns: true }],
      ['thread/turns/list', { threadId }],
      ['thread/items/list', { threadId }],
      ['thread/queue/list', { threadId }],
      ['thread/backgroundTerminals/list', { threadId }],
      ['thread/name/set', { threadId, name: '打样线程' }],
      ['thread/settings/update', { threadId, permissions: ':workspace' }],
      ['thread/archive', { threadId }],
      ['thread/unarchive', { threadId }],
    ]
    for (const [method, params] of probes) await desktop.call(method, params)
    assert.equal((await desktop.call('thread/read', { threadId })).thread.name, '打样线程')

    // 拒绝提权：命令不执行，条目按协议标成 declined，模型收到拒绝后继续。
    desktop.onRequest(() => ({ decision: 'decline' }))
    const refused = (await desktop.call('thread/start', { cwd, sandbox: 'workspace-write' })).thread
    await desktop.call('turn/start', {
      threadId: refused.id,
      input: [{ type: 'text', text: '执行会被拒绝的命令。' }],
    })
    const declined = await desktop.until(
      'turn/completed',
      (params) => params.threadId === refused.id,
    )
    assert.equal(declined.turn.status, 'completed')
    assert.equal(
      declined.turn.items.find((item: any) => item.type === 'commandExecution').status,
      'declined',
    )
    assert.equal(declined.turn.items.at(-1).text, '已停止提权。')
    await assert.rejects(readFile(join(cwd, 'denied.txt')), '被拒绝的命令不应执行')

    // 沙箱内的普通命令不询问；非零退出码从输出里解析出来，条目标成 failed。
    const asked = desktop.requests.length
    const plain = (await desktop.call('thread/start', { cwd, sandbox: 'workspace-write' })).thread
    await desktop.call('turn/start', {
      threadId: plain.id,
      input: [{ type: 'text', text: '跑两条普通命令。' }],
    })
    const ran = await desktop.until('turn/completed', (params) => params.threadId === plain.id)
    const commands = ran.turn.items.filter((item: any) => item.type === 'commandExecution')
    assert.equal(ran.turn.status, 'completed')
    assert.equal(desktop.requests.length, asked, '普通命令不触发审批')
    assert.deepEqual(
      commands.map((item: any) => [item.command, item.status, item.exitCode]),
      [
        ['echo plain-ok', 'completed', 0],
        ['exit 3', 'failed', 3],
      ],
    )
    assert.match(commands[0].aggregatedOutput, /plain-ok/)

    // 重启适配器：历史只从 dsh 的会话存储回放，条目标识保持不变。
    await server.close()
    server = new DshServer(join(root, 'home'))
    desktop = client(server)
    const resumed = await desktop.call('thread/resume', { threadId })
    assert.deepEqual(
      resumed.thread.turns[0].items.map((item: any) => item.id),
      items.map((item: any) => item.id),
    )
    assert.equal(resumed.thread.turns[0].status, 'completed')
    assert.ok(resumed.turnsBackwardsCursor)
    const replayed = await desktop.call('thread/read', { threadId: refused.id, includeTurns: true })
    assert.equal(
      replayed.thread.turns[0].items.find((item: any) => item.type === 'commandExecution').status,
      'declined',
      '回放时被拒绝的命令仍是 declined',
    )

    const second = await desktop.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: '慢慢输出。' }],
    })
    assert.equal(second.turn.id, 'turn:2')
    await desktop.until('item/agentMessage/delta', (params) => params.turnId === 'turn:2')
    await desktop.call('turn/interrupt', { threadId, turnId: 'turn:2' })
    const interrupted = await desktop.until(
      'turn/completed',
      (params) => params.turn.id === 'turn:2',
    )
    assert.equal(interrupted.turn.status, 'interrupted')
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await model.close()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await rm(root, { recursive: true, force: true })
  }
})
