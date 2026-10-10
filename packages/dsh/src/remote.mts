import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { compatibilityHint } from './versions.mjs'

// dsh Web Remote 的最小客户端：令牌换 cookie、一元调用、WebSocket 多路流、宿主事件应答。
// 协议是 dsh 私有的，没有版本协商；本文件是唯一直接接触线路形状的地方。
// 方法缺失、参数被网关拒绝或返回结构不符时，统一报成 incompatible 并带上当前与已验证的 dsh 版本，不静默失败。

export class RemoteError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface Waterfall {
  event: string
  eventId: string
  agentId: string
  request: any
}
export type WaterfallOutcome = { kind: 'next' } | { kind: 'result'; value?: unknown }

export interface RemoteHandlers {
  // 宿主等待客户端裁决的事件（审批、提问）；signal 在宿主撤回时中止。
  waterfall(frame: Waterfall, signal: AbortSignal): Promise<WaterfallOutcome>
  emit(event: string, args: any[]): void
  closed(error: Error): void
}

type StreamHandler = { item: (value: any) => void; end: (error: Error | null) => void }

export class WebRemote {
  // 对端 dsh 的版本，只用于报错时说明当前版本。
  readonly version: string
  private readonly origin: string
  private readonly cookie: string
  private readonly socket: WebSocket
  private readonly handlers: RemoteHandlers
  private readonly streams = new Map<string, StreamHandler>()
  private readonly waterfalls = new Map<string, AbortController>()
  private clientId: string | null = null
  private closed = false

  private constructor(
    origin: string,
    cookie: string,
    socket: WebSocket,
    version: string,
    handlers: RemoteHandlers,
  ) {
    this.version = version
    this.origin = origin
    this.cookie = cookie
    this.socket = socket
    this.handlers = handlers
  }

  static async connect(
    launchUrl: string,
    version: string,
    handlers: RemoteHandlers,
  ): Promise<WebRemote> {
    const origin = new URL(launchUrl).origin
    // 启动令牌只能换成 cookie 使用；dsh 不接受 Authorization 头。
    const exchange = await fetch(launchUrl, { redirect: 'manual' })
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(';', 1)[0]
    if (exchange.status !== 303 || !cookie)
      throw new RemoteError(
        'incompatible',
        `dsh 的启动令牌没有换到会话 cookie（HTTP ${exchange.status}）。${compatibilityHint(version)}`,
      )
    const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/remote.mux`, {
      headers: { cookie },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', (error) => reject(new RemoteError('socket', String(error))))
    })
    const remote = new WebRemote(origin, cookie, socket, version, handlers)
    socket.on('message', (data) => remote.receive(JSON.parse(data.toString())))
    socket.on('close', () => remote.fail(new RemoteError('socket', 'dsh 连接已断开')))
    socket.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new RemoteError('incompatible', `dsh 的事件流没有就绪。${compatibilityHint(version)}`),
          ),
        10000,
      )
      remote.streams.set('events', {
        item: (value) => {
          if (value?.type === 'ready') {
            remote.clientId = value.clientId
            clearTimeout(timer)
            resolve()
          } else remote.hostEvent(value)
        },
        end: () => {},
      })
      remote.send({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })
    })
    return remote
  }

  private incompatible(detail: string): RemoteError {
    return new RemoteError('incompatible', `${detail}。${compatibilityHint(this.version)}`)
  }

  // dsh 网关层的拒绝（方法不存在、参数名或参数结构对不上）说明接口变了，业务错误原样透出。
  private remoteError(endpoint: string, error: any): RemoteError {
    const code = String(error?.code ?? 'remote')
    const message = String(error?.message ?? '未知错误')
    return code.startsWith('gateway/')
      ? this.incompatible(`dsh 拒绝了 ${endpoint} 调用（${code}: ${message}）`)
      : new RemoteError(code, `${endpoint}: ${message}`)
  }

  // args 的字段名必须等于宿主方法的形参名（例如 session/list 是 _request）。
  // shape 用来核对返回值里适配器依赖的字段，不符时按接口不兼容报错。
  async rpc<T = any>(
    endpoint: string,
    args: Record<string, unknown>,
    shape?: (value: any) => boolean,
  ): Promise<T> {
    const response = await fetch(`${this.origin}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: endpoint,
        payload: { args },
      }),
    })
    if (response.status === 404) throw this.incompatible(`dsh 没有 ${endpoint} 这个方法`)
    const body: any = await response.json().catch(() => null)
    const result = body?.result
    if (!result) throw new RemoteError('http', `${endpoint} 失败（HTTP ${response.status}）`)
    if (!result.ok) throw this.remoteError(endpoint, result.error)
    if (shape && !shape(result.value))
      throw this.incompatible(`dsh 的 ${endpoint} 返回了适配器不认识的结构`)
    return result.value as T
  }

  // 打开一条服务端流，返回取消函数。
  open(
    endpoint: string,
    args: Record<string, unknown>,
    item: (value: any) => void,
    end: (error: Error | null) => void = () => {},
  ): () => void {
    const streamId = randomUUID()
    this.streams.set(streamId, {
      item,
      end: (error) =>
        end(
          error instanceof RemoteError && error.code.startsWith('gateway/')
            ? this.incompatible(`dsh 拒绝了 ${endpoint} 流（${error.code}: ${error.message}）`)
            : error,
        ),
    })
    this.send({ type: 'open', streamId, endpoint, payload: { args } })
    return () => {
      if (!this.streams.delete(streamId) || this.closed) return
      this.send({ type: 'cancel', streamId })
    }
  }

  close(): void {
    this.closed = true
    this.socket.close()
  }

  private send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame))
  }

  private receive(frame: any): void {
    const stream = this.streams.get(frame.streamId)
    if (!stream) return
    if (frame.type === 'item') stream.item(frame.value)
    else {
      this.streams.delete(frame.streamId)
      stream.end(
        frame.type === 'error'
          ? new RemoteError(
              String(frame.error?.code ?? 'stream'),
              String(frame.error?.message ?? '流失败'),
            )
          : null,
      )
    }
  }

  private hostEvent(value: any): void {
    if (value?.type === 'emit') this.handlers.emit(value.event, value.args ?? [])
    else if (value?.type === 'cancel') this.waterfalls.get(value.eventId)?.abort()
    else if (value?.type === 'waterfall') void this.answer(value)
  }

  private async answer(frame: Waterfall): Promise<void> {
    const controller = new AbortController()
    this.waterfalls.set(frame.eventId, controller)
    let outcome: WaterfallOutcome
    try {
      outcome = await this.handlers.waterfall(frame, controller.signal)
    } catch {
      // 无法裁决时交回宿主，由 dsh 按"无应答方"处理。
      outcome = { kind: 'next' }
    }
    this.waterfalls.delete(frame.eventId)
    if (controller.signal.aborted || this.closed) return
    await this.rpc('$events/result', {
      clientId: this.clientId,
      eventId: frame.eventId,
      outcome,
    }).catch(() => {})
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const controller of this.waterfalls.values()) controller.abort()
    for (const stream of this.streams.values()) stream.end(error)
    this.streams.clear()
    this.handlers.closed(error)
  }
}
