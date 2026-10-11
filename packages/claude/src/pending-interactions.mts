import { ProtocolError } from './protocol-contract.mjs'
import type { JsonRpcResponse, RpcPeer } from './types.mjs'

interface PendingInteraction {
  id: string
  method: string
  params: unknown
  threadId: string
  // 请求现在在哪条连接手里；null 表示没有客户端在看，先留着，等有连接订阅这个线程再送。
  holder: RpcPeer | null
  // 这个线程此刻该由哪条连接来答；没有客户端在看时返回 null。
  target: () => RpcPeer | null
  finish(response?: JsonRpcResponse, error?: Error): void
}

export interface InteractionOptions {
  signal?: AbortSignal
  // 请求结束（回答、取消、失效）时调用，参数是当时拿着这条请求的连接。
  onFinished?: (holder: RpcPeer | null) => void
}

// 拿着请求的连接不在了以后，这条请求能不能再送给别的连接。
// 客户端执行的工具调用一旦送出就可能已经产生副作用，不能再送；不属于任何线程的请求
// （握手后探测 MCP 服务时的征询）只跟发起它的连接走，没有别的连接可以接手。
// 其余请求（审批、提问、回合里的 MCP 征询）只是要一个决定，可以原样再送一次。
function replayable(entry: { method: string; threadId: string }): boolean {
  return entry.threadId !== '' && entry.method !== 'item/tool/call'
}

// 发给客户端并等回答的请求。它们跟着线程的订阅连接走：没有客户端在看时一直留着，
// 有连接订阅了就送过去；拿着请求的连接断开或者订阅换了连接，纯决定类的请求改送新的连接。
// 请求 ID 不变，与原生“恢复线程时重放挂起的服务端请求”一致。
// Hub 仲裁多端答案；适配器只接受当前拿着请求的那条连接的首次有效回答。
export class PendingInteractions {
  private pending = new Map<string, PendingInteraction>()
  // 请求从一条仍然连着的连接手里收回时调用，让它撤掉界面上的卡片。
  private readonly withdrawn: (peer: RpcPeer, threadId: string, id: string) => void

  constructor(withdrawn: (peer: RpcPeer, threadId: string, id: string) => void = () => {}) {
    this.withdrawn = withdrawn
  }

  request(
    target: () => RpcPeer | null,
    method: string,
    id: string,
    params: unknown,
    options: InteractionOptions = {},
  ): Promise<unknown> {
    const { signal, onFinished } = options
    if (signal?.aborted) return Promise.reject(new ProtocolError(-32010, '交互请求已取消'))
    if (this.pending.has(id)) throw new ProtocolError(-32009, '交互请求 ID 冲突')
    const threadId = String((params as Record<string, unknown>).threadId ?? '')
    return new Promise((resolve, reject) => {
      const finish = (response?: JsonRpcResponse, error?: Error) => {
        const entry = this.pending.get(id)
        if (!entry || !this.pending.delete(id)) return
        signal?.removeEventListener('abort', cancelled)
        // 在唤醒等待者前发送结束事件，崩溃和取消也使用同一个完成路径。
        try {
          onFinished?.(entry.holder)
        } catch (notificationError) {
          error ??=
            notificationError instanceof Error
              ? notificationError
              : new Error(String(notificationError))
        }
        if (error) reject(error)
        else if (response?.error)
          reject(new ProtocolError(response.error.code, response.error.message))
        else resolve(response?.result)
      }
      const cancelled = () => finish(undefined, new ProtocolError(-32010, '交互请求已取消'))
      // 人工交互持续等待，直到回答、取消或运行时停止；没有客户端在看也一直等。
      const entry: PendingInteraction = {
        id,
        method,
        params,
        threadId,
        holder: null,
        target,
        finish,
      }
      this.pending.set(id, entry)
      signal?.addEventListener('abort', cancelled, { once: true })
      const first = target()
      // 没有线程可订阅的请求等不来别的连接：发起它的连接不在就直接失败。
      if (!first && !threadId)
        finish(undefined, new ProtocolError(-32010, '交互连接已关闭，结果未确认'))
      else this.deliver(entry, first)
    })
  }

  resolve(peer: RpcPeer, response: JsonRpcResponse): void {
    const entry = this.pending.get(String(response.id))
    if (entry?.holder?.id === peer.id) entry.finish(response)
  }

  // 订阅关系变了之后调用：没送出去的请求送给现在在看这个线程的连接，
  // 订阅换了连接的请求改送新的连接。
  reroute(): void {
    for (const entry of [...this.pending.values()]) {
      const next = entry.target()
      if (next?.id === entry.holder?.id) continue
      // 已经送出的工具调用不换连接；它所在的连接断开时按失败结束。
      if (entry.holder && !replayable(entry)) continue
      const previous = entry.holder
      entry.holder = null
      if (previous) this.withdrawn(previous, entry.threadId, entry.id)
      this.deliver(entry, next)
    }
  }

  // 连接断开：它手里的决定类请求回到“没人可送”，等下一个订阅者；不能再送的按失败结束。
  dropPeer(peerId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.holder?.id !== peerId) continue
      if (replayable(entry)) entry.holder = null
      else entry.finish(undefined, new ProtocolError(-32010, '交互连接已关闭，结果未确认'))
    }
  }

  // 连接断开且之后不会再有别的连接（标准输入输出上的连接就是进程的寿命）：它手里的请求全部失效。
  cancelPeer(peerId: string): void {
    this.cancel((entry) => entry.holder?.id === peerId, '交互连接已关闭，结果未确认')
  }

  cancelThread(threadId: string): void {
    this.cancel((entry) => entry.threadId === threadId, 'Turn 已中断，交互请求失效')
  }

  close(): void {
    this.cancel(() => true, '运行时停止，交互请求失效')
  }

  // 这个线程有没有还在等回答的请求。
  has(threadId: string): boolean {
    for (const entry of this.pending.values()) if (entry.threadId === threadId) return true
    return false
  }

  // 有请求在等、却没有连接可送的线程。
  unattended(): string[] {
    const threads = new Set<string>()
    for (const entry of this.pending.values()) if (!entry.holder) threads.add(entry.threadId)
    return [...threads]
  }

  private deliver(entry: PendingInteraction, peer: RpcPeer | null): void {
    if (!peer) return
    entry.holder = peer
    try {
      peer.send({ jsonrpc: '2.0', id: entry.id, method: entry.method, params: entry.params })
    } catch (error) {
      entry.finish(undefined, error instanceof Error ? error : new Error(String(error)))
    }
  }

  private cancel(predicate: (entry: PendingInteraction) => boolean, message: string): void {
    for (const entry of [...this.pending.values()])
      if (predicate(entry)) entry.finish(undefined, new ProtocolError(-32010, message))
  }
}
