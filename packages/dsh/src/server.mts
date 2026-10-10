import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { FilesystemRpc } from '../../shared/src/filesystem-rpc.mjs'
import { FuzzyFileSearch, FuzzySearchSessions } from '../../shared/src/fuzzy-session.mjs'
import { ProcessRpc } from '../../shared/src/process-rpc.mjs'
import { ProjectStore } from '../../shared/src/project-store.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { QueueStore } from '../../shared/src/queue-store.mjs'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { sleep } from '../../shared/src/util.mjs'
import { approve } from './approvals.mjs'
import { type DshThread, type DshTurn, type Preset, Projection } from './projection.mjs'
import { dispatch } from './protocol.mjs'
import type { Waterfall, WaterfallOutcome, WebRemote } from './remote.mjs'
import { DshRuntime } from './runtime.mjs'
import { DshStore } from './store.mjs'
import { promptContent } from './turn.mjs'
import { compatibilityHint } from './versions.mjs'

// 调试用：CHA_DSH_TRACE 指向文件时逐行记录与客户端往来的协议消息，默认关闭。
const tracePath = process.env.CHA_DSH_TRACE
const trace = (direction: 'in' | 'out', message: unknown) => {
  if (tracePath) appendFileSync(tracePath, `${JSON.stringify({ direction, message })}\n`)
}

export interface LiveThread {
  projection: Projection
  cancel: () => void
  // 桌面为线程选定的权限预设；与 dsh 当前预设不同时在下一回合前切换。
  preset: Preset | null
  // 本进程内已受理的提交标识；用户消息落盘前的重复提交据此返回同一回合。
  submitted: Map<string, DshTurn>
}

export class DshServer {
  readonly store: DshStore
  readonly projects: ProjectStore
  readonly queue: QueueStore
  readonly files = new FilesystemRpc()
  readonly processes = new ProcessRpc((command) => command)
  readonly search = new FuzzyFileSearch()
  readonly searches = new FuzzySearchSessions((peer, message) => peer.send(message))
  readonly peers = new Map<string, RpcPeer>()
  readonly subscriptions = new Map<string, Set<string>>()
  readonly live = new Map<string, LiveThread>()
  readonly runtime: DshRuntime
  private readonly loading = new Map<string, Promise<LiveThread>>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly pending = new Map<
    string,
    {
      peer: string
      threadId: string
      resolve: (value: any) => void
      reject: (error: Error) => void
      clear: () => void
    }
  >()

  constructor(home: string) {
    this.store = new DshStore(home)
    this.projects = new ProjectStore(this.store.db)
    this.queue = new QueueStore(this.store.db)
    this.runtime = new DshRuntime(home, {
      waterfall: (frame, signal) => this.waterfall(frame, signal),
      emit: () => {},
      closed: (error) => this.runtimeClosed(error),
    })
  }

  remote(): Promise<WebRemote> {
    return this.runtime.remote()
  }

  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if (tracePath && !this.peers.has(peer.id)) {
      const send = peer.send.bind(peer)
      peer.send = (outgoing) => {
        trace('out', outgoing)
        send(outgoing)
      }
    }
    trace('in', message)
    this.peers.set(peer.id, peer)
    if (!('method' in message)) {
      const pending = this.pending.get(String(message.id))
      if (pending?.peer === peer.id) {
        this.pending.delete(String(message.id))
        pending.clear()
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        this.notify(pending.threadId, 'serverRequest/resolved', { requestId: message.id })
      }
      return
    }
    if (!('id' in message)) return
    try {
      const params =
        message.params && typeof message.params === 'object' ? (message.params as any) : {}
      const work = () => dispatch(this, peer, message.method, params)
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      const result = threadId ? await this.serial(threadId, work) : await work()
      peer.send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : -32603
      const text = error instanceof Error ? error.message : String(error)
      // 打样阶段靠这行日志找出桌面端用到而尚未实现的方法。
      console.error(`[dsh] ${message.method} 失败（${code}）: ${text}`)
      peer.send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
    }
  }

  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.locks.set(id, next)
    try {
      return await next
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }
  }

  subscribe(peer: RpcPeer, id: string): void {
    const ids = this.subscriptions.get(id) ?? new Set<string>()
    ids.add(peer.id)
    this.subscriptions.set(id, ids)
  }

  notify(threadId: string | null, method: string, params: any): void {
    if (method === 'item/started') params = { startedAtMs: Date.now(), ...params }
    if (method === 'item/completed')
      params = { startedAtMs: null, completedAtMs: Date.now(), ...params }
    for (const peer of this.peers.values())
      if (threadId === null || this.subscriptions.get(threadId)?.has(peer.id))
        peer.send({ method, params: threadId ? { threadId, ...params } : params })
  }

  // 向已订阅该线程的客户端发起反向请求（审批等），signal 中止时撤回。
  call(threadId: string, method: string, params: any, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error('已取消'))
    const target = [...(this.subscriptions.get(threadId) ?? [])]
      .map((id) => this.peers.get(id))
      .find(Boolean)
    if (!target) return Promise.reject(new Error('没有可处理交互的已连接客户端'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', cancel)
        this.notify(threadId, 'serverRequest/resolved', { requestId: id })
        reject(new Error('已取消'))
      }
      this.pending.set(id, {
        peer: target.id,
        threadId,
        resolve,
        reject,
        clear: () => signal?.removeEventListener('abort', cancel),
      })
      signal?.addEventListener('abort', cancel, { once: true })
      target.send({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          threadId,
          turnId: this.live.get(threadId)?.projection.active?.id ?? '',
          itemId: id,
          ...params,
        },
      })
    })
  }

  // 打开会话的跟随流：先用快照回放历史，之后的落盘事件与实时增量转成协议通知。
  load(id: string): Promise<LiveThread> {
    const loaded = this.live.get(id)
    if (loaded) return Promise.resolve(loaded)
    const loading =
      this.loading.get(id) ??
      this.open(id).finally(() => {
        this.loading.delete(id)
      })
    this.loading.set(id, loading)
    return loading
  }

  private async open(id: string): Promise<LiveThread> {
    const remote = await this.remote()
    const notify = (method: string, params: any) => this.notify(id, method, params)
    return new Promise<LiveThread>((resolve, reject) => {
      let live: LiveThread | null = null
      // 首帧必须是带记录数组的快照；不是或迟迟不来都按接口不兼容报错，不让调用方一直挂着。
      const mismatch = (detail: string) => {
        clearTimeout(timer)
        cancel()
        reject(new ProtocolError(-32603, `${detail}。${compatibilityHint(remote.version)}`))
      }
      const timer = setTimeout(() => mismatch('dsh 的 session/follow 没有返回会话快照'), 15000)
      const cancel = remote.open(
        'session/follow',
        { request: { address: { kind: 'session', sessionId: id }, assistantStream: true } },
        (value) => {
          if (value?.type === 'snapshot' && Array.isArray(value.records)) {
            clearTimeout(timer)
            live = {
              projection: replay(id, value),
              cancel: () => cancel(),
              preset: null,
              submitted: new Map(),
            }
            this.live.set(id, live)
            resolve(live)
          } else if (!live) mismatch('dsh 的 session/follow 首帧不是适配器认识的会话快照')
          else if (value.type === 'event') live.projection.apply(value.event, notify)
          else if (value.type === 'assistant-stream') live.projection.stream(value.frame, notify)
        },
        (error) => {
          clearTimeout(timer)
          if (this.live.get(id) === live) this.live.delete(id)
          live?.projection.fail('dsh 会话流已中断', notify)
          reject(new ProtocolError(-32602, error?.message ?? '未知 dsh 会话'))
        },
      )
    })
  }

  start(peer: RpcPeer, live: LiveThread, params: any): DshTurn {
    const { projection } = live
    const clientId = params.clientUserMessageId ?? params.clientMessageId ?? null
    const submitted = clientId
      ? (live.submitted.get(clientId) ??
        projection.turns.find((turn) =>
          turn.items.some((item) => item.type === 'userMessage' && item.clientId === clientId),
        ))
      : undefined
    if (submitted) return submitted
    if (params.outputSchema != null)
      throw new ProtocolError(-32602, 'dsh 入口暂不支持严格结构化输出')
    if (projection.active) throw new ProtocolError(-32009, '会话已有活动回合')
    const threadId = projection.thread.id
    const notify = (method: string, value: any) => this.notify(threadId, method, value)
    this.subscribe(peer, threadId)
    const turn = projection.expect(notify)
    if (clientId) live.submitted.set(clientId, turn)
    setImmediate(async () => {
      try {
        const content = await promptContent(params.input ?? [])
        const remote = await this.remote()
        await this.applySettings(remote, live, params)
        // 提交标识落在 dsh 用户消息的 source.rpcId 上，回放时还原为条目的 clientId。
        await remote.rpc('session/prompt', {
          request: {
            requestId: clientId ?? randomUUID(),
            sessionId: threadId,
            mode: 'queue',
            content,
          },
        })
      } catch (error) {
        if (projection.active === turn)
          projection.fail(error instanceof Error ? error.message : String(error), notify)
      }
    })
    return turn
  }

  async applySettings(remote: WebRemote, live: LiveThread, params: any): Promise<void> {
    const { thread } = live.projection
    const preset = presetFromParams(params) ?? live.preset
    if (preset) live.preset = preset
    if (preset && preset !== thread.preset)
      await remote.rpc('commands/execute', {
        agentId: thread.id,
        line: `/permission ${preset}`,
        submittedAttachments: [],
      })
    const model = typeof params.model === 'string' && params.model ? params.model : null
    const effort = typeof params.effort === 'string' && params.effort ? params.effort : null
    if ((!model || model === thread.model) && (!effort || effort === thread.effort)) return
    const selected = model ?? thread.model
    const slash = selected?.indexOf('/') ?? -1
    if (!selected || slash < 1) throw new ProtocolError(-32602, '模型格式必须为 provider/model')
    await remote.rpc('session/selectModel', {
      request: {
        sessionId: thread.id,
        provider: selected.slice(0, slash),
        model: selected.slice(slash + 1),
        ...((effort ?? thread.effort) ? { reasoningEffort: effort ?? thread.effort } : {}),
      },
    })
    // 选择结果随后也会经落盘事件到达，这里先更新以便立即回报新设置。
    thread.model = selected
    thread.effort = effort ?? thread.effort
  }

  async interrupt(id: string): Promise<void> {
    const live = this.live.get(id)
    const turn = live?.projection.active
    if (!live || !turn) return
    this.rejectPending((entry) => entry.threadId === id, '回合已停止')
    const remote = await this.remote()
    await remote.rpc('session/cancel', { request: { sessionId: id } })
    for (let waited = 0; waited < 10000 && live.projection.active === turn; waited += 50)
      await sleep(50)
    // dsh 没有回报结束（例如提示词尚未送达）时由适配器收尾。
    if (live.projection.active === turn)
      live.projection.apply(
        { type: 'turn/end', seq: -1, time: Date.now(), data: { reason: { kind: 'interrupted' } } },
        (method, params) => this.notify(id, method, params),
      )
  }

  private async waterfall(frame: Waterfall, signal: AbortSignal): Promise<WaterfallOutcome> {
    const live = this.live.get(frame.agentId)
    // 提问与计划评审不在本期范围：交回 dsh，由它按"无应答方"处理。
    if (!live || frame.event !== 'approval/request') return { kind: 'next' }
    return approve(this, live, frame.request ?? {}, signal)
  }

  private runtimeClosed(error: Error): void {
    for (const [id, live] of this.live)
      live.projection.fail(`dsh 进程已退出：${error.message}`, (method, params) =>
        this.notify(id, method, params),
      )
    this.live.clear()
  }

  private rejectPending(
    match: (entry: { peer: string; threadId: string }) => boolean,
    message: string,
  ): void {
    for (const [id, entry] of this.pending)
      if (match(entry)) {
        entry.clear()
        entry.reject(new Error(message))
        this.pending.delete(id)
        this.notify(entry.threadId, 'serverRequest/resolved', { requestId: id })
      }
  }

  closePeer(peer: RpcPeer): void {
    this.peers.delete(peer.id)
    this.files.closePeer(peer.id)
    this.processes.closePeer(peer.id)
    for (const ids of this.subscriptions.values()) ids.delete(peer.id)
    this.rejectPending((entry) => entry.peer === peer.id, '客户端已断开')
  }

  async close(): Promise<void> {
    this.rejectPending(() => true, '适配器正在关闭')
    await this.runtime.close()
    this.files.close()
    await this.processes.close()
    this.store.close()
  }
}

export function presetFromParams(params: any): Preset | null {
  const profiles: Record<string, Preset> = {
    ':read-only': 'read-only',
    ':workspace': 'workspace-write',
    ':danger-full-access': 'danger-full-access',
    readOnly: 'read-only',
    workspaceWrite: 'workspace-write',
    dangerFullAccess: 'danger-full-access',
    'read-only': 'read-only',
    'workspace-write': 'workspace-write',
    'danger-full-access': 'danger-full-access',
  }
  for (const value of [
    params.permissions,
    params.activePermissionProfile?.id,
    params.sandboxPolicy?.type,
    params.sandbox,
  ])
    if (typeof value === 'string' && profiles[value]) return profiles[value]
  return null
}

function replay(id: string, snapshot: any): Projection {
  const values = snapshot.projections?.values ?? {}
  const selection = values.modelSelection?.next ?? values.modelSelection?.lastUsed ?? null
  const createdAt = Math.floor(Number(snapshot.header?.createdAt ?? Date.now()) / 1000)
  const thread: DshThread = {
    id,
    cwd: snapshot.header?.cwd ?? '',
    name: null,
    preview: '',
    createdAt,
    updatedAt: createdAt,
    model: selection ? `${selection.provider}/${selection.model}` : null,
    effort: selection?.reasoningEffort ?? null,
    preset: values.permissions?.currentValue ?? 'workspace-write',
    parentThreadId: snapshot.header?.parentSession ?? null,
  }
  const projection = new Projection(thread)
  projection.contextWindow = values.contextPressure?.contextWindow ?? null
  let time = createdAt * 1000
  for (const record of snapshot.records ?? [])
    if (record.type === 'event') {
      projection.apply(record.event, () => {})
      time = record.event.time
    }
  // 回放结束仍未收尾的回合属于上一个已退出的 dsh 进程。
  if (projection.active)
    projection.apply(
      { type: 'turn/end', seq: -1, time, data: { reason: { kind: 'interrupted' } } },
      () => {},
    )
  return projection
}
