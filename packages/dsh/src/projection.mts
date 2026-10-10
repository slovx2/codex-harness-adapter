import { createTwoFilesPatch } from 'diff'

export type Preset = 'read-only' | 'workspace-write' | 'danger-full-access'
export interface DshThread {
  id: string
  cwd: string
  name: string | null
  preview: string
  createdAt: number
  updatedAt: number
  model: string | null
  effort: string | null
  preset: Preset
  parentThreadId: string | null
}
export interface DshTurn {
  id: string
  items: any[]
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  error: { message: string; codexErrorInfo: null; additionalDetails: null } | null
  startedAt: number
  completedAt: number | null
  durationMs: number | null
}
export interface WireEvent {
  type: string
  seq: number
  time: number
  data: any
}
export type Notify = (method: string, params: any) => void

const text = (content: any): string =>
  (Array.isArray(content) ? content : [])
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => part.text)
    .join('\n')
const parse = (json: unknown): any => {
  try {
    return typeof json === 'string' ? JSON.parse(json) : (json ?? {})
  } catch {
    return {}
  }
}

function toolItem(id: string, name: string, args: any, cwd: string): any {
  if (name === 'bash')
    return {
      type: 'commandExecution',
      id,
      command: String(args.command ?? ''),
      cwd: typeof args.workdir === 'string' ? args.workdir : cwd,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
  if (name === 'edit' || name === 'write')
    return { type: 'fileChange', id, status: 'inProgress', changes: [] }
  return {
    type: 'mcpToolCall',
    id,
    server: name.startsWith('mcp__') ? name.split('__')[1] : 'dsh',
    tool: name,
    status: 'inProgress',
    arguments: args,
    result: null,
    error: null,
    durationMs: null,
  }
}

function finishTool(item: any, args: any, message: any, meta: any): void {
  const failed = message?.isError === true
  const output = text(message?.content)
  item.status = failed ? 'failed' : 'completed'
  if (item.type === 'commandExecution') {
    // dsh 把退出码拼在输出文本末尾；非零退出不算工具错误。
    const code = /\[exit code: (\d+)\]\s*$/.exec(output)
    item.aggregatedOutput = output
    item.exitCode = code ? Number(code[1]) : failed ? 1 : 0
    if (item.exitCode !== 0) item.status = 'failed'
  } else if (item.type === 'fileChange') {
    if (failed) return
    const path = String(args.file_path ?? '')
    const diffs: any[] = Array.isArray(meta?.diffs) ? meta.diffs : []
    // 协议 add 承载文件正文，update 承载 unified diff；dsh 的 diff 是带上下文的新旧片段。
    item.changes = diffs.length
      ? diffs.map((diff) => ({
          path,
          kind: { type: 'update', move_path: null },
          diff: createTwoFilesPatch(
            path,
            path,
            `${diff.oldText ?? ''}\n`,
            `${diff.newText ?? ''}\n`,
          ),
        }))
      : [{ path, kind: { type: 'add' }, diff: String(args.content ?? '') }]
  } else {
    item.result = { content: message?.content ?? [], structuredContent: null, _meta: null }
    item.error = failed ? { message: output } : null
  }
}

// 把 dsh 的落盘事件与实时增量归并成 Codex 的回合与条目；历史回放与实时共用同一套归并。
export class Projection {
  readonly thread: DshThread
  readonly turns: DshTurn[] = []
  active: DshTurn | null = null
  turnNumber = 0
  contextWindow: number | null = null
  private expected = false
  private attempt: { turn: number; step: number } | null = null
  private readonly open = new Set<string>()
  // 协议里回合的起止时间是秒，时长是毫秒；毫秒级的开始时间另存一份用来算时长。
  private readonly startedMs = new Map<string, number>()
  private readonly calls = new Map<
    string,
    { item: any; args: any; done: boolean; declined?: boolean }
  >()
  // 审批编号到工具调用的对应；裁决事件只带审批编号。
  private readonly asked = new Map<string, string>()
  private readonly usage = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }

  constructor(thread: DshThread) {
    this.thread = thread
  }

  call(id: string): { item: any; args: any } | undefined {
    return this.calls.get(id)
  }

  // 适配器发出提示词前按下一个回合编号先建好回合，随后的 turn/start 事件与它对上。
  expect(notify: Notify): DshTurn {
    const turn = this.begin(this.turnNumber + 1, Date.now(), notify)
    this.expected = true
    return turn
  }

  apply(event: WireEvent, notify: Notify): void {
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      if (this.expected && this.active) this.turnNumber = Math.max(this.turnNumber, data.turn)
      else this.begin(Number(data.turn), event.time, notify)
      this.expected = false
    } else if (event.type === 'user/message') {
      if (data.source?.kind === 'user') this.userMessage(data, notify)
    } else if (event.type === 'assistant/message') this.assistantMessage(data, notify)
    else if (event.type === 'tool/call') this.toolCall(data, notify)
    else if (event.type === 'tool/result') this.toolResult(data, notify)
    else if (event.type === 'approval/asked') this.asked.set(data.id, data.callId)
    else if (event.type === 'approval/decided') {
      const call = this.calls.get(this.asked.get(data.id) ?? '')
      if (call && data.outcome === 'rejected') call.declined = true
    } else if (event.type === 'turn/end') this.end(data.reason ?? {}, event.time, notify)
    else if (event.type === 'session/title') {
      this.thread.name = typeof data.title === 'string' ? data.title : this.thread.name
      notify('thread/name/updated', { threadName: this.thread.name })
    } else if (event.type === 'model/selection') {
      this.thread.model = `${data.provider}/${data.model}`
      this.thread.effort = data.reasoningEffort ?? this.thread.effort
    } else if (event.type === 'permission/preset') this.thread.preset = data.preset
    this.thread.updatedAt = Math.max(this.thread.updatedAt, Math.floor(event.time / 1000))
  }

  // 实时增量：条目标识由回合、步、块序号组成，与随后落盘的 assistant/message 一致。
  stream(frame: any, notify: Notify): void {
    if (frame.type === 'start') this.attempt = { turn: frame.turn, step: frame.step }
    const turn = this.active
    const chunk = frame.chunk
    if (frame.type !== 'chunk' || !this.attempt || !turn || !chunk?.text) return
    const id = `a:${this.attempt.turn}:${this.attempt.step}:${chunk.index}`
    if (chunk.type === 'text-delta') {
      const item =
        turn.items.find((entry) => entry.id === id) ??
        this.put(turn, this.message(id, '', false), false, notify)
      item.text += chunk.text
      notify('item/agentMessage/delta', { turnId: turn.id, itemId: id, delta: chunk.text })
    } else if (chunk.type === 'reasoning-delta') {
      const item =
        turn.items.find((entry) => entry.id === id) ??
        this.put(turn, { type: 'reasoning', id, summary: [''], content: [] }, false, notify)
      item.summary[0] += chunk.text
      notify('item/reasoning/summaryTextDelta', {
        turnId: turn.id,
        itemId: id,
        summaryIndex: 0,
        delta: chunk.text,
      })
    }
  }

  // 进程中断等异常情况下由适配器直接收尾。
  fail(message: string, notify: Notify): void {
    this.end({ kind: 'error', message }, Date.now(), notify)
  }

  private message(id: string, body: string, commentary: boolean): any {
    return {
      type: 'agentMessage',
      id,
      text: body,
      phase: commentary ? 'commentary' : 'final_answer',
      memoryCitation: null,
    }
  }

  private begin(number: number, time: number, notify: Notify): DshTurn {
    if (this.active) this.end({ kind: 'interrupted' }, time, notify)
    this.turnNumber = Math.max(this.turnNumber, number)
    const turn: DshTurn = {
      id: `turn:${number}`,
      items: [],
      status: 'inProgress',
      error: null,
      startedAt: Math.floor(time / 1000),
      completedAt: null,
      durationMs: null,
    }
    this.startedMs.set(turn.id, time)
    this.turns.push(turn)
    this.active = turn
    notify('turn/started', { turn })
    notify('thread/status/changed', { status: { type: 'active', activeFlags: [] } })
    return turn
  }

  private put(turn: DshTurn, item: any, complete: boolean, notify: Notify): any {
    const index = turn.items.findIndex((entry) => entry.id === item.id)
    if (index < 0) {
      turn.items.push(item)
      this.open.add(item.id)
      notify('item/started', {
        turnId: turn.id,
        item: item.type === 'reasoning' ? { ...item, summary: [], content: [] } : item,
      })
      if (item.type === 'reasoning')
        notify('item/reasoning/summaryPartAdded', {
          turnId: turn.id,
          itemId: item.id,
          summaryIndex: 0,
        })
    } else turn.items[index] = item
    if (complete) {
      this.open.delete(item.id)
      notify('item/completed', { turnId: turn.id, item })
    }
    return item
  }

  private userMessage(message: any, notify: Notify): void {
    const turn = this.active
    if (!turn) return
    const body = text(message.content)
    if (!this.thread.preview) this.thread.preview = body.slice(0, 200)
    this.put(
      turn,
      {
        type: 'userMessage',
        id: `user:${message.id}`,
        content: [{ type: 'text', text: body, text_elements: [] }],
        clientId: message.source?.rpcId ?? null,
      },
      true,
      notify,
    )
  }

  private assistantMessage(data: any, notify: Notify): void {
    const turn = this.active
    if (!turn) return
    const blocks: any[] = data.message?.content ?? []
    const commentary = blocks.some((block) => block.type === 'tool-call')
    blocks.forEach((block, index) => {
      const id = `a:${data.turn}:${data.step}:${index}`
      if (block.type === 'text' && block.text)
        this.put(turn, this.message(id, block.text, commentary), true, notify)
      else if (block.type === 'reasoning' && block.text)
        this.put(turn, { type: 'reasoning', id, summary: [block.text], content: [] }, true, notify)
    })
    const u = data.usage
    if (!u) return
    const last = {
      totalTokens: u.totalTokens ?? 0,
      inputTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
      cachedInputTokens: u.cacheReadTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      reasoningOutputTokens: u.reasoningTokens ?? 0,
    }
    if (!last.totalTokens && !last.inputTokens && !last.outputTokens) return
    for (const key of Object.keys(last) as Array<keyof typeof last>) this.usage[key] += last[key]
    notify('thread/tokenUsage/updated', {
      turnId: turn.id,
      tokenUsage: { total: { ...this.usage }, last, modelContextWindow: this.contextWindow },
    })
  }

  private toolCall(data: any, notify: Notify): void {
    const turn = this.active
    if (!turn || this.calls.has(data.callId)) return
    const args = parse(data.arguments)
    const item = toolItem(data.callId, String(data.name), args, this.thread.cwd)
    this.calls.set(data.callId, { item, args, done: false })
    this.put(turn, item, false, notify)
  }

  private toolResult(data: any, notify: Notify): void {
    const call = this.calls.get(data.message?.toolCallId)
    const turn = this.turns.find((entry) => entry.items.includes(call?.item))
    // dsh 裁剪旧结果时会对同一调用追加替换事件，已完成的调用不再改写。
    if (!call || call.done || !turn) return
    call.done = true
    finishTool(call.item, call.args, data.message, data.meta)
    // 用户拒绝提权的调用按协议标成 declined，而不是普通的执行失败；依据是落盘的裁决事件，回放时同样成立。
    if (call.declined && call.item.type !== 'mcpToolCall') call.item.status = 'declined'
    this.put(turn, call.item, true, notify)
  }

  private end(reason: any, time: number, notify: Notify): void {
    const turn = this.active
    if (!turn) return
    const kind = String(reason.kind ?? 'error')
    turn.status =
      kind === 'completed'
        ? 'completed'
        : kind === 'aborted' || kind === 'interrupted'
          ? 'interrupted'
          : 'failed'
    if (turn.status === 'failed')
      turn.error = {
        message: String(reason.message ?? reason.error?.message ?? `dsh 回合结束：${kind}`),
        codexErrorInfo: null,
        additionalDetails: null,
      }
    for (const item of turn.items) {
      if (!this.open.delete(item.id)) continue
      if (item.status === 'inProgress') item.status = 'failed'
      notify('item/completed', { turnId: turn.id, item })
    }
    turn.completedAt = Math.floor(time / 1000)
    turn.durationMs = Math.max(0, time - (this.startedMs.get(turn.id) ?? time))
    this.active = null
    this.expected = false
    this.attempt = null
    notify('turn/completed', { turn })
    notify('thread/status/changed', { status: { type: 'idle' } })
  }
}
