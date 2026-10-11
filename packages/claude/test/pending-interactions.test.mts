import assert from 'node:assert/strict'
import test from 'node:test'
import { PendingInteractions } from '../src/pending-interactions.mjs'
import type { RpcPeer, WireMessage } from '../src/types.mjs'

function peer(id: string): RpcPeer & { messages: WireMessage[] } {
  const messages: WireMessage[] = []
  return {
    id,
    messages,
    send: (message) => {
      messages.push(message)
    },
    close: () => {},
  }
}

test('MCP 请求级取消只结束指定交互，迟到回答无效', async () => {
  const pending = new PendingInteractions()
  const owner = peer('owner')
  const abort = new AbortController()
  const cancelled = assert.rejects(
    pending.request(
      () => owner,
      'mcpServer/elicitation/request',
      'cancelled',
      { threadId: 'same-thread' },
      { signal: abort.signal },
    ),
    /已取消/,
  )
  const unaffected = pending.request(() => owner, 'mcpServer/elicitation/request', 'unaffected', {
    threadId: 'same-thread',
  })
  abort.abort()
  pending.resolve(owner, { jsonrpc: '2.0', id: 'cancelled', result: { action: 'accept' } })
  pending.resolve(owner, { jsonrpc: '2.0', id: 'unaffected', result: { action: 'decline' } })
  await cancelled
  assert.deepEqual(await unaffected, { action: 'decline' })
  await assert.rejects(
    pending.request(
      () => owner,
      'mcpServer/elicitation/request',
      'already-cancelled',
      { threadId: 'same-thread' },
      { signal: abort.signal },
    ),
    /已取消/,
  )
  assert.equal(owner.messages.length, 2)
})

test('APPROVAL-001：相同请求 ID 不能由另一个连接回答，首次回答生效', async () => {
  const pending = new PendingInteractions()
  const owner = peer('owner')
  const other = peer('other')
  const result = pending.request(() => owner, 'item/tool/call', 'same-id', { threadId: 'thread' })
  pending.resolve(other, { jsonrpc: '2.0', id: 'same-id', result: 'foreign' })
  pending.resolve(owner, { jsonrpc: '2.0', id: 'same-id', result: 'first' })
  pending.resolve(owner, { jsonrpc: '2.0', id: 'same-id', result: 'duplicate' })
  assert.equal(await result, 'first')
})

test('人工交互等待超过两分钟或一天仍可回答，且只完成一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const elapsedMs of [120_001, 86_400_000]) {
    const pending = new PendingInteractions()
    const owner = peer('owner')
    const abort = new AbortController()
    let finished = 0
    const result = pending.request(
      () => owner,
      'item/tool/call',
      'waiting',
      { threadId: 'thread' },
      {
        signal: abort.signal,
        onFinished: () => {
          finished++
        },
      },
    )
    t.mock.timers.tick(elapsedMs)
    assert.equal(finished, 0)
    pending.resolve(owner, { jsonrpc: '2.0', id: 'waiting', result: 'confirmed' })
    assert.equal(await result, 'confirmed')
    abort.abort()
    pending.close()
    pending.resolve(owner, { jsonrpc: '2.0', id: 'waiting', result: 'duplicate' })
    assert.equal(finished, 1)
  }
})

test('APPROVAL-002：工具调用所在的连接断开、回合中断与关闭使旧请求失效', async () => {
  const pending = new PendingInteractions()
  const owner = peer('owner')
  const disconnect = pending.request(() => owner, 'item/tool/call', 'disconnect', {
    threadId: 'a',
  })
  const disconnected = assert.rejects(disconnect, /连接已关闭/)
  pending.dropPeer(owner.id)
  await disconnected
  const interrupt = pending.request(() => owner, 'item/tool/call', 'interrupt', { threadId: 'a' })
  const interrupted = assert.rejects(interrupt, /中断/)
  const unrelated = pending.request(() => owner, 'item/tool/call', 'unrelated', { threadId: 'b' })
  pending.cancelThread('a')
  pending.resolve(owner, { jsonrpc: '2.0', id: 'unrelated', result: 'ok' })
  await interrupted
  assert.equal(await unrelated, 'ok')
  const stopped = assert.rejects(
    pending.request(() => owner, 'item/tool/call', 'stop', { threadId: 'a' }),
    /停止/,
  )
  pending.close()
  pending.resolve(owner, { jsonrpc: '2.0', id: 'stop', result: 'late' })
  await stopped
})

test('APPROVAL-008：没有客户端在看时请求一直留着，有连接订阅后送达，回答照常生效', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = new PendingInteractions()
  let subscriber: ReturnType<typeof peer> | null = null
  const finishedWith: Array<string | null> = []
  const result = pending.request(
    () => subscriber,
    'item/fileChange/requestApproval',
    'held',
    { threadId: 'thread' },
    { onFinished: (holder) => finishedWith.push(holder?.id ?? null) },
  )
  assert.equal(pending.has('thread'), true)
  assert.deepEqual(pending.unattended(), ['thread'])
  // 不设超时：过多久都还在等。
  t.mock.timers.tick(7 * 86_400_000)
  pending.reroute()
  assert.deepEqual(pending.unattended(), ['thread'])

  const late = peer('late')
  subscriber = late
  pending.reroute()
  assert.deepEqual(late.messages, [
    {
      jsonrpc: '2.0',
      id: 'held',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread' },
    },
  ])
  assert.deepEqual(pending.unattended(), [])
  // 已经在它手里的请求不重复发送。
  pending.reroute()
  assert.equal(late.messages.length, 1)
  pending.resolve(late, { jsonrpc: '2.0', id: 'held', result: { decision: 'accept' } })
  assert.deepEqual(await result, { decision: 'accept' })
  assert.deepEqual(finishedWith, ['late'])
  assert.equal(pending.has('thread'), false)
})

test('APPROVAL-009：拿着请求的连接断开后请求不作废，原样送给下一个订阅者；订阅换了连接则改送并通知原连接', async () => {
  const withdrawn: string[] = []
  const pending = new PendingInteractions((from, threadId, id) =>
    withdrawn.push(`${from.id}:${threadId}:${id}`),
  )
  const first = peer('first')
  const second = peer('second')
  const third = peer('third')
  let subscriber: ReturnType<typeof peer> | null = first
  const result = pending.request(() => subscriber, 'item/tool/requestUserInput', 'kept', {
    threadId: 'thread',
  })
  assert.equal(first.messages.length, 1)

  // 连接断开：请求回到没人可送。
  subscriber = null
  pending.dropPeer(first.id)
  pending.reroute()
  assert.deepEqual(pending.unattended(), ['thread'])
  assert.deepEqual(withdrawn, [], '断开的连接不需要通知')

  subscriber = second
  pending.reroute()
  assert.deepEqual(second.messages, first.messages, '请求 ID 与内容不变')

  // 订阅换成另一条连接，原来那条还连着：改送，并让原连接撤掉卡片。
  subscriber = third
  pending.reroute()
  assert.deepEqual(third.messages, first.messages)
  assert.deepEqual(withdrawn, ['second:thread:kept'])
  pending.resolve(second, { jsonrpc: '2.0', id: 'kept', result: 'stale' })
  pending.resolve(third, { jsonrpc: '2.0', id: 'kept', result: 'current' })
  assert.equal(await result, 'current')
})

test('APPROVAL-010：工具调用没送出去时同样等订阅者；送出之后不换连接、不重发', async () => {
  const withdrawn: string[] = []
  const pending = new PendingInteractions((from) => withdrawn.push(from.id))
  const first = peer('first')
  const second = peer('second')
  let subscriber: ReturnType<typeof peer> | null = null
  const result = pending.request(() => subscriber, 'item/tool/call', 'tool', { threadId: 'thread' })
  assert.deepEqual(pending.unattended(), ['thread'])
  subscriber = first
  pending.reroute()
  assert.equal(first.messages.length, 1)

  // 客户端可能已经执行了这次调用：订阅换了连接也不送第二次。
  subscriber = second
  pending.reroute()
  assert.equal(second.messages.length, 0)
  assert.deepEqual(withdrawn, [])
  pending.resolve(first, { jsonrpc: '2.0', id: 'tool', result: 'done' })
  assert.equal(await result, 'done')
})

test('APPROVAL-011：不属于任何线程的请求只跟发起它的连接走，连接断开即失效', async () => {
  const pending = new PendingInteractions()
  const owner = peer('owner')
  let connected: ReturnType<typeof peer> | null = owner
  const threadless = pending.request(() => connected, 'mcpServer/elicitation/request', 'probe', {
    threadId: null,
  })
  const closed = assert.rejects(threadless, /连接已关闭/)
  connected = null
  pending.dropPeer(owner.id)
  await closed
  assert.deepEqual(pending.unattended(), [])
  // 发起时连接已经不在：没有线程可订阅，等不来别的连接。
  await assert.rejects(
    pending.request(() => null, 'mcpServer/elicitation/request', 'gone', { threadId: null }),
    /连接已关闭/,
  )
})
