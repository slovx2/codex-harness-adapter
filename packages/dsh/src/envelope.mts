import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import type { DshThread, DshTurn, Preset } from './projection.mjs'
import type { DshServer, LiveThread } from './server.mjs'
import { versions } from './versions.mjs'

const PROFILE: Record<Preset, string> = {
  'read-only': ':read-only',
  'workspace-write': ':workspace',
  'danger-full-access': ':danger-full-access',
}

// dsh 的沙箱只约束文件写入，不限制网络，这里如实回报 networkAccess。
function sandbox(preset: Preset, cwd: string): any {
  if (preset === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (preset === 'read-only') return { type: 'readOnly', networkAccess: true }
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

// session/list 的一项转成线程摘要；已加载的线程以跟随流里的状态为准。
export function summary(item: any): DshThread {
  const values = item.projections?.values ?? {}
  const selection = values.modelSelection?.next ?? values.modelSelection?.lastUsed ?? null
  const updatedAt = Math.floor(Number(item.updatedAt ?? Date.now()) / 1000)
  return {
    id: item.sessionId,
    cwd: item.cwd ?? '',
    name: typeof values.title === 'string' ? values.title : null,
    preview: String(values.turnOutline?.[0]?.prompt ?? values.title ?? '').slice(0, 200),
    createdAt: updatedAt,
    updatedAt,
    model: selection ? `${selection.provider}/${selection.model}` : null,
    effort: selection?.reasoningEffort ?? null,
    preset: values.permissions?.currentValue ?? 'workspace-write',
    parentThreadId: item.parentSessionId ?? null,
  }
}

export function envelope(s: DshServer, thread: DshThread, turns: DshTurn[] = []): any {
  const metadata = s.store.getMeta('thread', thread.id) ?? {}
  const live = s.live.get(thread.id)
  return {
    id: thread.id,
    sessionId: thread.id,
    forkedFromId: null,
    preview: thread.preview,
    name: thread.name,
    modelProvider: thread.model?.split('/')[0] ?? 'dsh',
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.updatedAt,
    historyMode: 'legacy',
    threadSource: thread.parentThreadId ? 'subagent' : 'user',
    section:
      metadata.sectionId === PINNED_SECTION_ID
        ? PINNED_SECTION
        : metadata.sectionId
          ? (s.store.getMeta('section', metadata.sectionId) ?? null)
          : null,
    sectionEnteredAt: metadata.sectionEnteredAt ?? null,
    isPinned: metadata.sectionId === PINNED_SECTION_ID,
    canAcceptDirectInput: true,
    activePermissionProfile: PROFILE[live?.preset ?? thread.preset],
    status: live?.projection.active ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    // dsh 的会话文件不是 Codex rollout，不交给桌面读取。
    path: null,
    cwd: thread.cwd,
    cliVersion: s.runtime.host?.version ?? versions.dshMinimum,
    source: thread.parentThreadId
      ? { subAgent: { thread_spawn: { parent_thread_id: thread.parentThreadId, depth: 1 } } }
      : 'appServer',
    parentThreadId: thread.parentThreadId,
    ephemeral: false,
    gitInfo: null,
    agentNickname: null,
    agentRole: null,
    turns,
    projectId: s.projects.projectId(thread.id),
    ...metadata,
  }
}

export function settings(s: DshServer, live: LiveThread): any {
  const { thread, turns } = live.projection
  const preset = live.preset ?? thread.preset
  return {
    thread: envelope(s, thread, turns),
    model: thread.model ?? '',
    modelProvider: thread.model?.split('/')[0] ?? 'dsh',
    cwd: thread.cwd,
    approvalPolicy: preset === 'danger-full-access' ? 'never' : 'on-request',
    approvalsReviewer: 'user',
    sandbox: sandbox(preset, thread.cwd),
    sandboxPolicy: sandbox(preset, thread.cwd),
    activePermissionProfile: { id: PROFILE[preset], extends: null },
    permissions: PROFILE[preset],
    reasoningEffort: thread.effort,
    collaborationMode: {
      mode: 'default',
      settings: {
        model: thread.model ?? '',
        reasoning_effort: thread.effort,
        developer_instructions: null,
      },
    },
  }
}
