import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { gitDiffToRemote } from '../../shared/src/git-diff-remote.mjs'
import { projectRequest } from '../../shared/src/project-rpc.mjs'
import {
  historyHeadCursors,
  ProtocolError,
  pageRecords,
  pageThreadItems,
  requiredString,
} from '../../shared/src/protocol-contract.mjs'
import { codexUserAgent, platformFamily, platformOs } from '../../shared/src/runtime-version.mjs'
import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { envelope, settings, summary } from './envelope.mjs'
import { type DshServer, presetFromParams } from './server.mjs'
import { promptContent } from './turn.mjs'
import { runtimeInfo, versions } from './versions.mjs'

const unsupported = (method: string) =>
  new ProtocolError(-32601, `dsh 入口（打样阶段）不支持 ${method}`)

async function models(s: DshServer): Promise<any[]> {
  const catalog = await (await s.remote()).rpc('session/modelCatalog', {}, (value) =>
    Array.isArray(value?.groups),
  )
  return (catalog.groups ?? []).flatMap((group: any) =>
    (group.models ?? []).map((model: any) => ({
      id: `${group.id}/${model.id}`,
      model: `${group.id}/${model.id}`,
      displayName: model.name ?? model.id,
      description: model.description ?? group.name ?? group.id,
      hidden: false,
      modelSpecialty: null,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: catalog.default?.provider === group.id && catalog.default?.model === model.id,
      supportedReasoningEfforts: (model.reasoning?.efforts ?? []).map((effort: any) => ({
        reasoningEffort: effort.id,
        description: effort.description ?? effort.name ?? effort.id,
      })),
      defaultReasoningEffort: model.reasoning?.defaultEffort ?? 'off',
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      upgrade: null,
      availabilityNux: null,
      upgradeInfo: null,
    })),
  )
}

export async function dispatch(s: DshServer, peer: RpcPeer, method: string, p: any): Promise<any> {
  if (method.startsWith('fs/')) return s.files.call(peer, method, p)
  if (method === 'command/exec' || method === 'process/spawn')
    return s.processes.start(peer, method === 'command/exec' ? 'command' : 'process', p)
  if (
    method.startsWith('command/exec/') ||
    ['process/writeStdin', 'process/resizePty', 'process/kill'].includes(method)
  )
    return s.processes.followup(
      peer,
      method.startsWith('command/') ? 'command' : 'process',
      /write|writeStdin/.test(method) ? 'write' : /resize/.test(method) ? 'resize' : 'kill',
      p,
    )
  if (method.startsWith('project/'))
    return projectRequest(
      s.projects,
      method,
      p,
      (projectId, changeType) => s.notify(null, 'project/changed', { projectId, changeType }),
      (threadId, projectId) => s.notify(threadId, 'thread/project/updated', { projectId }),
    )
  switch (method) {
    case 'initialize':
      return {
        userAgent: codexUserAgent(
          typeof p.clientInfo?.name === 'string' ? p.clientInfo.name : 'codex-app',
          typeof p.clientInfo?.version === 'string' ? p.clientInfo.version : 'unknown',
          versions.protocol,
          'codex-harness-adapter-dsh',
        ),
        codexHome: process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: platformFamily(),
        platformOs: platformOs(),
      }
    case 'runtime/info':
      return runtimeInfo()
    case 'server/diagnostics':
      return { engine: 'dsh', loadedSessions: s.live.size }
    case 'currentTime/read':
      return { currentTime: new Date().toISOString() }
    case 'account/read':
      return { account: null, requiresOpenaiAuth: false }
    case 'getAuthStatus':
      return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
    case 'account/rateLimits/read':
      return { rateLimits: null, rateLimitsByLimitId: null }
    case 'configRequirements/read':
      return { requirements: null }
    case 'modelProvider/capabilities/read':
      return { namespaceTools: false, imageGeneration: false, webSearch: false }
    case 'app/list':
    case 'hooks/list':
    case 'experimentalFeature/list':
      return { data: [], nextCursor: null }
    case 'plugin/list':
      return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
    case 'plugin/share/list':
      return { data: [] }
    case 'externalAgentConfig/detect':
      return { items: [] }
    case 'permissionProfile/list':
      return {
        data: [':read-only', ':workspace', ':danger-full-access'].map((id) => ({
          id,
          description: null,
          allowed: true,
        })),
        nextCursor: null,
      }
    case 'collaborationMode/list':
      return {
        data: [
          {
            name: 'default',
            mode: 'default',
            model: null,
            reasoning_effort: null,
            developer_instructions: null,
          },
        ],
      }
    case 'model/list':
      return { data: await models(s), nextCursor: null }
    case 'config/read': {
      const preferred = (await models(s)).find((model) => model.isDefault)
      const saved = s.store.getMeta('config', 'defaults') ?? {}
      return {
        config: {
          model: saved.model ?? preferred?.id ?? null,
          model_provider: 'dsh',
          model_reasoning_effort:
            saved.model_reasoning_effort ?? preferred?.defaultReasoningEffort ?? null,
          approval_policy: saved.approval_policy ?? 'on-request',
          sandbox_mode: saved.sandbox_mode ?? 'workspace-write',
          features: {},
          model_providers: { dsh: { name: 'DSH', requires_openai_auth: false } },
        },
        origins: {},
        layers: [],
      }
    }
    case 'config/value/write':
    case 'config/batchWrite': {
      // 桌面端改默认模型与权限时写这里；默认值存在适配器元数据里，不动 dsh 原生配置。
      const edits: any[] =
        method === 'config/batchWrite' ? (p.edits ?? []) : [{ keyPath: p.keyPath, value: p.value }]
      const allowed = ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode']
      for (const edit of edits)
        if (!allowed.includes(edit.keyPath))
          throw new ProtocolError(-32602, `dsh 入口（打样阶段）不支持修改 ${edit.keyPath}`)
      const saved = s.store.getMeta('config', 'defaults') ?? {}
      for (const edit of edits) saved[edit.keyPath] = edit.value
      s.store.setMeta('config', 'defaults', saved)
      return { status: 'ok', version: 'dsh', filePath: '', overriddenMetadata: null }
    }
    case 'thread/start': {
      const cwd = p.cwd ?? process.cwd()
      if (typeof cwd !== 'string' || !isAbsolute(cwd))
        throw new ProtocolError(-32602, 'cwd 必须是绝对路径')
      const remote = await s.remote()
      const created = await remote.rpc(
        'session/create',
        { request: { cwd } },
        (value) => typeof value?.sessionId === 'string',
      )
      const live = await s.load(created.sessionId)
      const { thread } = live.projection
      s.subscribe(peer, thread.id)
      live.preset = presetFromParams(p)
      const saved = s.store.getMeta('config', 'defaults') ?? {}
      const selection = {
        model: p.model ?? p.config?.model ?? saved.model,
        effort: p.effort ?? p.config?.model_reasoning_effort ?? saved.model_reasoning_effort,
      }
      // 桌面可能带着别的引擎的模型名新建线程；允许回退时改用 dsh 默认模型。
      await s.applySettings(remote, live, selection).catch((error) => {
        if (!p.allowProviderModelFallback) throw error
      })
      if (p.projectId) s.projects.assignThread(thread.id, p.projectId)
      const started = envelope(s, thread)
      setImmediate(() => s.notify(thread.id, 'thread/started', { thread: started }))
      return settings(s, live)
    }
    case 'thread/list': {
      const { items } = await (await s.remote()).rpc('session/list', { _request: {} }, (value) =>
        Array.isArray(value?.items),
      )
      const rows = (items as any[])
        .filter((item) => !item.blank)
        .map((item) => s.live.get(item.sessionId)?.projection.thread ?? summary(item))
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
        .filter((thread) => {
          const metadata = s.store.getMeta('thread', thread.id) ?? {}
          const subagent = Boolean(thread.parentThreadId)
          return (
            (metadata.archived === true) === (p.archived === true) &&
            (p.parentThreadId ? thread.parentThreadId === p.parentThreadId : true) &&
            (p.sourceKinds?.length
              ? p.sourceKinds.includes(subagent ? 'subAgentThreadSpawn' : 'appServer')
              : p.parentThreadId || !subagent) &&
            (p.cwd == null ||
              (Array.isArray(p.cwd) ? p.cwd.includes(thread.cwd) : thread.cwd === p.cwd)) &&
            (p.projectId === undefined || s.projects.projectId(thread.id) === p.projectId) &&
            (p.sectionId === undefined || (metadata.sectionId ?? null) === p.sectionId) &&
            (typeof p.isPinned !== 'boolean' ||
              (metadata.sectionId === PINNED_SECTION_ID) === p.isPinned) &&
            (!p.searchTerm || `${thread.name ?? ''} ${thread.preview}`.includes(p.searchTerm))
          )
        })
      return pageRecords(
        rows.map((thread) => envelope(s, thread)),
        p,
        `threads:${JSON.stringify([p.archived === true, p.projectId, p.sectionId, p.isPinned, p.cwd, p.parentThreadId, p.sourceKinds, p.searchTerm])}`,
        (thread) => thread.id,
      )
    }
    case 'thread/loaded/list':
      return { data: [...s.live.keys()], nextCursor: null }
    case 'thread/resume':
    case 'thread/read': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const { thread, turns } = live.projection
      s.subscribe(peer, thread.id)
      return method === 'thread/resume'
        ? { ...settings(s, live), ...historyHeadCursors(thread.id, turns) }
        : { thread: envelope(s, thread, p.includeTurns === false ? [] : turns) }
    }
    case 'thread/unsubscribe': {
      const subscribed = s.subscriptions.get(p.threadId)?.delete(peer.id)
      return {
        status: subscribed
          ? 'unsubscribed'
          : s.live.has(p.threadId)
            ? 'notSubscribed'
            : 'notLoaded',
      }
    }
    case 'turn/start':
      return { turn: s.start(peer, await s.load(requiredString(p.threadId, 'threadId')), p) }
    case 'turn/interrupt':
      await s.interrupt(p.threadId)
      return {}
    case 'turn/steer': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const active = live.projection.active
      if (!active || active.id !== p.expectedTurnId)
        throw new ProtocolError(-32009, '指定回合与活动回合不一致')
      // dsh 的插话在当前这一步结束后并入同一回合，不会立即打断模型。
      await (await s.remote()).rpc('session/prompt', {
        request: {
          requestId: p.clientUserMessageId ?? p.clientMessageId ?? randomUUID(),
          sessionId: p.threadId,
          mode: 'steer',
          content: await promptContent(p.input ?? []),
        },
      })
      return { turnId: active.id }
    }
    case 'thread/name/set':
      await (await s.remote()).rpc('session/rename', {
        request: { sessionId: p.threadId, title: requiredString(p.name, 'name') },
      })
      return {}
    case 'thread/settings/update':
    case 'turn/settings/update': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      await s.applySettings(await s.remote(), live, p)
      s.notify(p.threadId, 'thread/settings/updated', { threadSettings: settings(s, live) })
      return method === 'turn/settings/update' ? { status: 'applied' } : {}
    }
    case 'thread/turns/list': {
      const { turns } = (await s.load(p.threadId)).projection
      return pageRecords(turns, p, `turns:${p.threadId}`, (turn) => turn.id)
    }
    case 'thread/turns/items/list':
    case 'thread/items/list':
      return pageThreadItems(p.threadId, (await s.load(p.threadId)).projection.turns, p)
    case 'thread/archive':
    case 'thread/unarchive': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const archived = method === 'thread/archive'
      if (archived) await s.interrupt(p.threadId)
      s.store.setMeta('thread', p.threadId, {
        ...(s.store.getMeta('thread', p.threadId) ?? {}),
        archived,
      })
      s.notify(p.threadId, archived ? 'thread/archived' : 'thread/unarchived', {})
      return archived ? {} : { thread: envelope(s, live.projection.thread) }
    }
    case 'thread/metadata/update':
      return { thread: envelope(s, (await s.load(p.threadId)).projection.thread) }
    case 'threadSection/list':
      return pageRecords([PINNED_SECTION], p, 'sections', (section) => section.id)
    case 'thread/queue/list':
    case 'thread/attachment/list':
      return { data: [], nextCursor: null, backwardsCursor: null }
    case 'thread/backgroundTerminals/list':
      return { data: [], nextCursor: null }
    case 'thread/backgroundTerminals/clean':
    case 'thread/increment_elicitation':
    case 'thread/decrement_elicitation':
      return {}
    case 'skills/list':
      return {
        data: (p.cwds ?? [process.cwd()]).map((cwd: string) => ({ cwd, skills: [], errors: [] })),
      }
    case 'fuzzyFileSearch':
      return s.search.search(p)
    case 'fuzzyFileSearch/sessionStart':
      return s.searches.start(peer, p)
    case 'fuzzyFileSearch/sessionUpdate':
      return s.searches.update(peer, p)
    case 'fuzzyFileSearch/sessionStop':
      return s.searches.stop(p)
    case 'gitDiffToRemote':
      return gitDiffToRemote(p.cwd ?? process.cwd())
    default:
      throw unsupported(method)
  }
}
