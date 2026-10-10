import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const toolId = () => `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// 父子请求可能交错到达，按请求内容路由而不是按到达顺序。
function subagentRouter(home: string, mode: 'background' | 'foreground', subDelayMs = 0) {
  return async (request: ModelRequest) => {
    const messages = (request.messages ?? []) as Array<Record<string, any>>
    const first = JSON.stringify(messages[0]?.content ?? '')
    const lastAssistant = messages.map((message) => message.role).lastIndexOf('assistant')
    const tail = messages.slice(lastAssistant + 1)
    const tailText = JSON.stringify(tail)
    const tailHasToolResult = tail.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block: any) => block.type === 'tool_result'),
    )
    if (first.includes('SUBAGENT_MAIN')) {
      if (lastAssistant < 0)
        return [
          { type: 'text', text: 'MAIN_BEFORE_AGENT' },
          {
            type: 'tool_use',
            id: toolId(),
            name: 'Agent',
            input: {
              description: '读取探针文件',
              prompt: 'SUBAGENT_CHILD 读取 a.txt 并返回内容',
              subagent_type: 'general-purpose',
              ...(mode === 'foreground' ? { run_in_background: false } : {}),
            },
          },
        ]
      // 追问回合：模型故意写错收件人并改写正文，适配器必须改回用户原文。
      if (tailText.includes('subagent-follow-up') && !tailHasToolResult)
        return [
          {
            type: 'tool_use',
            id: toolId(),
            name: 'SendMessage',
            input: { to: 'someone-else', message: 'PARAPHRASED_BY_MODEL' },
          },
        ]
      if (tailText.includes('task-notification'))
        return [{ type: 'text', text: 'MAIN_AFTER_NOTIFICATION' }]
      if (tailHasToolResult) return [{ type: 'text', text: 'MAIN_AFTER_TOOL_RESULT' }]
      throw new Error('父会话收到未预期的请求')
    }
    if (first.includes('SUBAGENT_CHILD')) {
      if (lastAssistant < 0)
        return [
          { type: 'text', text: 'CHILD_TEXT_BEFORE_TOOL' },
          {
            type: 'tool_use',
            id: toolId(),
            name: 'Read',
            input: { file_path: join(home, 'a.txt') },
          },
        ]
      if (tailText.includes('CHILD_FOLLOWUP')) {
        if (tailText.includes('PARAPHRASED_BY_MODEL')) throw new Error('子代理收到的不是用户原文')
        return [{ type: 'text', text: `CHILD_FOLLOWUP_ANSWER 此前共 ${messages.length} 条消息` }]
      }
      if (subDelayMs) await sleep(subDelayMs)
      return [{ type: 'text', text: 'CHILD_DONE 文件内容是 probe-file-content: 42' }]
    }
    throw new Error('收到无法归属的模型请求')
  }
}

async function childThreads(client: ProtocolClient, parentId: string) {
  const started = client.trace
    .filter((message) => message.method === 'thread/started')
    .map((message) => message.params.thread)
    .filter((thread) => thread.id !== parentId)
  return Promise.all(
    started.map(
      async (thread) =>
        (await client.request('thread/read', { threadId: thread.id, includeTurns: true })).thread,
    ),
  )
}

const agentTexts = (thread: any): string[] =>
  thread.turns.flatMap((turn: any) =>
    turn.items.filter((item: any) => item.type === 'agentMessage').map((item: any) => item.text),
  )

test('SUBAGENT-001：默认后台派出的子代理在父回合内等到真实结果', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-bg-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    // 父 2 次 + 子 2 次 + 后台通知触发的父续跑 1 次。
    for (let index = 0; index < 5; index++) model.enqueue(subagentRouter(home, 'background', 1500))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const [child] = await childThreads(client, thread.id)
    assert.ok(child, '应创建子线程')
    assert.equal(child.turns.at(-1).status, 'completed')
    const texts = agentTexts(child)
    assert.equal(texts.at(-1), 'CHILD_DONE 文件内容是 probe-file-content: 42')
    assert.ok(!texts.join('\n').includes('Async agent launched'), '启动回执不能当作子代理结果')
    // 子线程必须先于父回合结束。
    const childDone = client.trace.findIndex(
      (message) => message.method === 'turn/completed' && message.params.threadId === child.id,
    )
    const parentDone = client.trace.findIndex(
      (message) => message.method === 'turn/completed' && message.params.threadId === thread.id,
    )
    assert.ok(childDone >= 0 && childDone < parentDone)
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    const parentTexts = agentTexts(parent)
    assert.ok(parentTexts.includes('MAIN_AFTER_TOOL_RESULT'))
    assert.ok(parentTexts.includes('MAIN_AFTER_NOTIFICATION'), '后台通知触发的续跑属于同一回合')
    assert.ok(!parentTexts.join('\n').includes('CHILD_'), '子代理文本不能混入父线程')
    const wait = parent.turns[0].items.find(
      (item: any) => item.type === 'collabAgentToolCall' && item.tool === 'wait',
    )
    assert.equal(wait.status, 'completed')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-002：前台子代理结果不带内部包装，过程写入子线程', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-fg-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 4; index++) model.enqueue(subagentRouter(home, 'foreground'))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const [child] = await childThreads(client, thread.id)
    assert.ok(child, '应创建子线程')
    const texts = agentTexts(child)
    assert.equal(texts.at(-1), 'CHILD_DONE 文件内容是 probe-file-content: 42')
    assert.ok(!texts.join('\n').includes('Subagent hand-back'), '内部包装前缀不能出现在子线程')
    assert.deepEqual(
      texts,
      ['CHILD_TEXT_BEFORE_TOOL', 'CHILD_DONE 文件内容是 probe-file-content: 42'],
      '子代理的中间文本与最终结果各出现一次',
    )
    const items = child.turns[0].items
    const readIndex = items.findIndex(
      (item: any) => item.type !== 'userMessage' && item.type !== 'agentMessage',
    )
    assert.ok(readIndex > 0, '子代理的工具调用应投影到子线程')
    assert.equal(items[readIndex].status, 'completed')
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    assert.ok(!agentTexts(parent).join('\n').includes('CHILD_'), '子代理文本不能混入父线程')
    assert.ok(
      !parent.turns[0].items.some(
        (item: any) =>
          item.type !== 'collabAgentToolCall' &&
          item.type !== 'userMessage' &&
          JSON.stringify(item).includes('a.txt'),
      ),
      '子代理的工具调用不能混入父线程',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-003：新旧模型都向 CLI 暴露 TodoWrite 清单工具', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-todo-tools-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    model.enqueue(() => [
      {
        type: 'tool_use',
        id: toolId(),
        name: 'TodoWrite',
        input: {
          todos: [{ content: '第一步', status: 'in_progress', activeForm: '正在做第一步' }],
        },
      },
    ])
    model.enqueue(() => [{ type: 'text', text: 'TODO_DONE' }])
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '列一个任务清单' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const tools = ((model.requests[0]?.tools ?? []) as Array<{ name: string }>).map(
      (tool) => tool.name,
    )
    assert.ok(tools.includes('TodoWrite'), `CLI 应提供 TodoWrite，实际：${tools.join(',')}`)
    assert.ok(!tools.includes('TaskCreate'), '不应同时提供适配器未映射的 TaskCreate')
    const plan = await client.notification(
      'turn/plan/updated',
      (params) => params.turnId === turn.id,
    )
    assert.deepEqual(plan.plan, [{ step: '第一步', status: 'inProgress' }])
    // 工具真实执行成功，而不是被 CLI 以“无此工具”拒绝。
    const followUp = JSON.stringify(model.requests[1]?.messages.at(-1))
    assert.ok(!followUp.includes('No such tool'), followUp.slice(0, 400))
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-004：在子线程追问会带着子代理原有上下文继续', { timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-relay-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 4; index++) model.enqueue(subagentRouter(home, 'foreground'))
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    const [child] = await childThreads(client, thread.id)
    assert.ok(child, '应创建子线程')
    await client.request('thread/resume', { threadId: child.id })
    // 转交、转交后的收尾、子代理作答、子代理结束后父会话的续跑。
    for (let index = 0; index < 4; index++) model.enqueue(subagentRouter(home, 'foreground'))
    const followUp = await client.request('turn/start', {
      threadId: child.id,
      input: [{ type: 'text', text: 'CHILD_FOLLOWUP 刚才读到的数值是多少' }],
    })
    // 追问回合里再追加输入只会到主模型，必须明确拒绝而不是悄悄丢掉。
    const steer = await client.raw(
      'turn/steer',
      {
        threadId: child.id,
        expectedTurnId: followUp.turn.id,
        input: [{ type: 'text', text: '再补一句' }],
      },
      -32009,
    )
    assert.match(steer.error.message, /追问/)
    assert.equal((await client.completed(followUp.turn.id)).status, 'completed')
    const after = (await client.request('thread/read', { threadId: child.id, includeTurns: true }))
      .thread
    assert.equal(after.turns.length, 2)
    const answers = after.turns[1].items
      .filter((item: any) => item.type === 'agentMessage')
      .map((item: any) => item.text)
    assert.equal(answers.length, 1, '子线程只显示子代理自己的回答')
    const seen = /^CHILD_FOLLOWUP_ANSWER 此前共 (\d+) 条消息$/.exec(answers[0])
    assert.ok(seen, answers[0])
    assert.ok(Number(seen[1]) > 3, '子代理应带着此前的上下文被恢复')
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    assert.equal(parent.turns.length, 1, '追问不在父线程里新增回合')
    assert.ok(!JSON.stringify(parent).includes('CHILD_FOLLOWUP'))
    // 父线程随后仍能在同一会话上继续。
    model.enqueue(() => [{ type: 'text', text: 'MAIN_NEXT_TURN' }])
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '继续主任务' }],
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    assert.ok(
      JSON.stringify(model.requests.at(-1)?.messages).includes('CHILD_FOLLOWUP_ANSWER'),
      '父会话应知道子代理追问的结果',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-005：父回合进行中或没有可恢复记录时，子线程拒绝接收输入', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-busy-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    for (let index = 0; index < 5; index++) model.enqueue(subagentRouter(home, 'background', 2500))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    const started = await client.notification(
      'thread/started',
      (params) => params.thread.id !== thread.id,
    )
    // 子代理仍在后台运行，父回合未结束：不能另起一个进程恢复同一个会话。
    await client.raw(
      'turn/start',
      { threadId: started.thread.id, input: [{ type: 'text', text: '插话' }] },
      -32009,
    )
    assert.equal((await client.completed(turn.id)).status, 'completed')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('SUBAGENT-006：后台子代理运行期间中断，父子回合都结束且会话可继续', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-subagent-stop-'))
  await writeFile(join(home, 'a.txt'), 'probe-file-content: 42\n')
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', {
      cwd: home,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    })
    // 父 2 次 + 子 2 次；子代理第二次请求挂起 20 秒，中断发生在它返回之前。
    for (let index = 0; index < 4; index++)
      model.enqueue(subagentRouter(home, 'background', 20_000))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'SUBAGENT_MAIN 请派子代理读取 a.txt' }],
    })
    // 父回合在等后台子代理，这段正文还没有收尾，只能按增量判断它已经出现。
    await client.notification(
      'item/agentMessage/delta',
      (params) => params.threadId === thread.id && params.delta.includes('MAIN_AFTER_TOOL_RESULT'),
    )
    const child = await client.notification(
      'thread/started',
      (params) => params.thread.id !== thread.id,
    )
    await client.notification(
      'item/started',
      (params) => params.threadId === child.thread.id && params.item.type === 'mcpToolCall',
    )
    // 等子代理的第二次模型请求挂起后再中断，四个步骤恰好用完。
    for (let waited = 0; model.requests.length < 4; waited += 20) {
      assert.ok(waited < 15_000, '子代理没有发出第二次模型请求')
      await sleep(20)
    }
    const interruptedAt = Date.now()
    await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    assert.equal((await client.completed(turn.id)).status, 'interrupted')
    assert.ok(Date.now() - interruptedAt < 10_000, '中断不应等后台子代理跑完')
    const [childThread] = await childThreads(client, thread.id)
    assert.notEqual(childThread.turns.at(-1).status, 'inProgress', '子线程回合不能悬着')
    assert.ok(!agentTexts(childThread).join('\n').includes('CHILD_DONE'))
    // 中断后同一会话还能继续。
    model.enqueue(async () => [{ type: 'text', text: 'AFTER_INTERRUPT_OK' }])
    const next = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '继续' }],
    })
    assert.equal((await client.completed(next.turn.id)).status, 'completed')
    const parent = (
      await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    ).thread
    assert.ok(agentTexts(parent).includes('AFTER_INTERRUPT_OK'))
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
