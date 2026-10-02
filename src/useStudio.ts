import { computed, ref, shallowRef } from 'vue'
import { sampleDocument } from './sample'
import {
  cloneDoc,
  computeWarnings,
  deriveFrozenVersions,
  deriveRecords,
  durationOfCue,
  durationOfScene,
  invertEdit,
  makeScript,
  openConflicts,
  reduceLog,
  totalDuration,
  uid
} from './model'
import {
  clearCollabStorage,
  loadIdentity,
  loadLog,
  loadOutbox,
  makePeerId,
  readPresence,
  saveIdentity,
  saveLog,
  saveOutbox,
  SyncBus,
  writePresence,
  type PresenceEntry
} from './sync'
import type {
  Cue,
  CueKind,
  EditPayload,
  FrozenVersion,
  Identity,
  Op,
  Role,
  StudioDocument
} from './types'

type SaveState = 'saved' | 'offline-queued' | 'saving'

interface StudioStore {
  identity: Identity
  online: boolean
  ops: Op[]
  outbox: Op[]
  peers: PresenceEntry[]
  saveState: SaveState
}

const store = shallowRef<StudioStore>({
  identity: loadIdentity() ?? { peerId: '', name: '', role: 'writer' },
  online: true,
  ops: [],
  outbox: [],
  peers: [],
  saveState: 'saved'
})

let bus: SyncBus | null = null
let presenceTimer: number | undefined

function mutate(patch: Partial<StudioStore>): void {
  store.value = { ...store.value, ...patch }
}

function currentClock(): Op['clock'] {
  const clock: Op['clock'] = {}
  for (const op of store.value.ops) {
    clock[op.peerId] = Math.max(clock[op.peerId] ?? 0, op.seq)
    for (const [key, value] of Object.entries(op.clock)) clock[key] = Math.max(clock[key] ?? 0, value)
  }
  for (const op of store.value.outbox) clock[op.peerId] = Math.max(clock[op.peerId] ?? 0, op.seq)
  return clock
}

/** 每个窗口已发出的 edit 操作数量（裁决/确认/冻结不计入），随操作携带用于纯编辑冲突判定 */
function currentEditClock(): Op['clock'] {
  const clock: Op['clock'] = {}
  for (const op of [...store.value.ops, ...store.value.outbox]) {
    for (const [key, value] of Object.entries(op.editClock ?? {})) clock[key] = Math.max(clock[key] ?? 0, value)
  }
  return clock
}

function nextSeq(): number {
  const self = store.value.identity.peerId
  const inLog = store.value.ops.filter((op) => op.peerId === self).reduce((max, op) => Math.max(max, op.seq), 0)
  const inBox = store.value.outbox.filter((op) => op.peerId === self).reduce((max, op) => Math.max(max, op.seq), 0)
  return Math.max(inLog, inBox) + 1
}

type OpBody = Omit<Op, 'id' | 'peerId' | 'peerName' | 'peerRole' | 'seq' | 'clock' | 'editClock' | 'ts'>

function emit(type: Op['type'], parts: Omit<OpBody, 'type'>): Op {
  const { identity } = store.value
  const baseEditClock = currentEditClock()
  const isEdit = type === 'edit'
  const editClock: Op['clock'] = isEdit
    ? { ...baseEditClock, [identity.peerId]: (baseEditClock[identity.peerId] ?? 0) + 1 }
    : baseEditClock
  const op: Op = {
    ...parts,
    type,
    id: uid('op'),
    peerId: identity.peerId,
    peerName: identity.name,
    peerRole: identity.role,
    seq: nextSeq(),
    clock: currentClock(),
    editClock,
    ts: new Date().toISOString()
  }
  if (store.value.online) {
    const ops = [...store.value.ops, op]
    saveLog(ops)
    mutate({ ops, saveState: 'saving' })
    bus?.postOps([op], identity.peerId)
    window.setTimeout(() => mutate({ saveState: 'saved' }), 200)
  } else {
    const outbox = [...store.value.outbox, op]
    saveOutbox(outbox)
    mutate({ outbox, saveState: 'offline-queued' })
  }
  return op
}

function reconcile(incoming: Op[]): void {
  const known = new Map<string, Op>()
  for (const op of store.value.ops) known.set(op.id, op)
  let changed = false
  for (const op of incoming) {
    if (!known.has(op.id)) {
      known.set(op.id, op)
      changed = true
    }
  }
  if (changed) {
    const ops = [...known.values()]
    saveLog(ops)
    mutate({ ops })
  }
}

/* ----------------------------- 身份与连接 ----------------------------- */

function init(identity: Identity): void {
  saveIdentity(identity)
  const ops = loadLog()
  const outbox = loadOutbox()
  mutate({ identity, ops, outbox, online: outbox.length === 0 ? store.value.online : true, saveState: outbox.length ? 'offline-queued' : 'saved' })

  bus = new SyncBus()
  bus.onRemoteOps = (incoming) => reconcile(incoming)
  bus.onSyncRequest = () => bus?.respondSync(store.value.ops, identity.peerId)

  writePresence(identity)
  bus.broadcastPresence(identity)
  bus.requestSync(identity.peerId)
  presenceTimer = window.setInterval(() => {
    writePresence(identity)
    mutate({ peers: readPresence(identity.peerId) })
  }, 4000)
  mutate({ peers: readPresence(identity.peerId) })
}

function setOnline(online: boolean): void {
  mutate({ online })
  if (online) flushOutbox()
}

function flushOutbox(): void {
  const queued = store.value.outbox
  if (!queued.length) return
  const ops = [...store.value.ops]
  // 重新基于共享日志校准向量时钟：离线期间对方的修改并入后，排队操作仍保留其离线时钟，
  // 与对方操作天然“并发”，进入冲突流程而不是被静默覆盖。
  for (const op of queued) if (!ops.some((o) => o.id === op.id)) ops.push(op)
  saveLog(ops)
  saveOutbox([])
  bus?.postOps(queued, store.value.identity.peerId)
  bus?.requestSync(store.value.identity.peerId)
  mutate({ ops, outbox: [], saveState: 'saved' })
}

function leaveWindow(): void {
  const peerId = store.value.identity.peerId
  if (presenceTimer) window.clearInterval(presenceTimer)
  bus?.dispose()
  bus = null
  clearCollabStorage(peerId)
  mutate({ identity: { peerId: '', name: '', role: 'writer' }, ops: loadLog(), outbox: [], peers: [], online: true, saveState: 'saved' })
}

/* ------------------------------- 编辑构造 ------------------------------- */

function projectFieldName(field: string): string {
  return field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '目标时长'
}

function emitEdit(label: string, payload: EditPayload): void {
  emit('edit', { label, edit: payload })
}

/* ============================== 组合式 API ============================== */

export function useStudio() {
  const identity = computed(() => store.value.identity)
  const isDirector = computed(() => store.value.identity.role === 'director')
  const online = computed(() => store.value.online)
  const peers = computed(() => store.value.peers)
  const saveState = computed(() => store.value.saveState)
  const outboxCount = computed(() => store.value.outbox.length)

  // 本窗口投影 = 已同步日志 + 本机离线待发队列，断网时也能立即看到自己排队的修改
  const localOps = computed<Op[]>(() => {
    const byId = new Map<string, Op>()
    for (const op of store.value.ops) byId.set(op.id, op)
    for (const op of store.value.outbox) if (!byId.has(op.id)) byId.set(op.id, op)
    return [...byId.values()]
  })

  const reduced = computed(() => reduceLog(localOps.value))
  const doc = computed<StudioDocument>(() => reduced.value.document)
  const conflicts = computed(() => openConflicts(reduced.value))
  const allConflicts = computed(() => reduced.value.conflicts)
  const records = computed(() => deriveRecords(localOps.value, reduced.value))
  const pendingRecords = computed(() => records.value.filter((r) => r.status === 'pending'))
  const frozenVersions = computed(() => deriveFrozenVersions(localOps.value, totalDuration))
  const warnings = computed(() => computeWarnings(doc.value))
  const total = computed(() => totalDuration(doc.value))

  /* ------------------------------ 项目编辑 ------------------------------ */

  function updateProject(field: 'title' | 'subtitle' | 'targetDuration', value: string | number) {
    const before = doc.value
    const to = field === 'targetDuration' ? Number(value) : String(value)
    emitEdit(`更新项目${projectFieldName(field)}`, {
      target: 'project',
      edit: 'update',
      changes: [{ field, from: before[field], to }]
    })
  }

  /* ------------------------------ 场次编辑 ------------------------------ */

  function addScene() {
    const id = uid('scene')
    const number = doc.value.scenes.length + 1
    const item = {
      id,
      code: `S${String(number).padStart(2, '0')}`,
      title: '未命名场次',
      location: '待填写',
      timeOfDay: '待填写',
      transition: '淡入',
      durationLimit: 150,
      cues: []
    }
    emitEdit(`新增场次 ${item.code}`, { target: 'scene', targetId: id, edit: 'add', item })
    return id
  }

  function updateScene(sceneId: string, field: keyof StudioDocument['scenes'][number], value: string | number) {
    const scene = doc.value.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    const from = (scene as unknown as Record<string, unknown>)[field as string]
    const to = field === 'durationLimit' ? Number(value) : String(value)
    emitEdit(`修改场次 ${scene.code} · ${field}`, {
      target: 'scene',
      targetId: sceneId,
      edit: 'update',
      changes: [{ field: field as string, from, to }]
    })
  }

  function deleteScene(sceneId: string) {
    const scene = doc.value.scenes.find((s) => s.id === sceneId)
    if (!scene || doc.value.scenes.length <= 1) return
    emitEdit(`删除场次 ${scene.code}`, {
      target: 'scene',
      targetId: sceneId,
      edit: 'delete',
      item: cloneDoc(scene)
    })
  }

  function moveScene(sceneId: string, direction: -1 | 1) {
    const ids = doc.value.scenes.map((s) => s.id)
    const index = ids.indexOf(sceneId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    const order = [...ids]
    ;[order[index], order[target]] = [order[target], order[index]]
    emitEdit('调整场次顺序', { target: 'scene', edit: 'reorder', order, fromOrder: ids })
  }

  function reorderScenes(order: string[]) {
    const fromOrder = doc.value.scenes.map((s) => s.id)
    if (JSON.stringify(order) === JSON.stringify(fromOrder)) return
    emitEdit('调整场次顺序', { target: 'scene', edit: 'reorder', order, fromOrder })
  }

  /* ------------------------------ 提示项编辑 ------------------------------ */

  function addCue(kind: CueKind, sceneId: string): string {
    const id = uid('cue')
    const item: Cue = {
      id,
      kind,
      characterId: kind === 'dialogue' ? doc.value.characters[0]?.id : undefined,
      text: kind === 'dialogue' ? '请输入台词' : kind === 'sfx' ? '音效提示' : '转场说明',
      emotion: kind === 'dialogue' ? '自然' : '',
      rate: 1,
      soundEffectId: kind === 'sfx' ? doc.value.soundEffects[0]?.id : undefined,
      transition: kind === 'transition' ? '淡出' : '',
      manualDuration: kind === 'transition' ? 3 : undefined
    }
    emitEdit(`新增${kind === 'dialogue' ? '台词' : kind === 'sfx' ? '音效' : '转场'}`, {
      target: 'cue',
      targetId: id,
      containerId: sceneId,
      edit: 'add',
      item
    })
    return id
  }

  function updateCue(sceneId: string, cueId: string, field: keyof Cue, value: unknown) {
    const cue = doc.value.scenes.find((s) => s.id === sceneId)?.cues.find((c) => c.id === cueId)
    if (!cue) return
    const from = (cue as unknown as Record<string, unknown>)[field as string]
    let to = value
    if (field === 'rate') to = Number(value)
    if (JSON.stringify(from) === JSON.stringify(to)) return
    emitEdit(`修改提示项 · ${field}`, {
      target: 'cue',
      targetId: cueId,
      containerId: sceneId,
      edit: 'update',
      changes: [{ field: field as string, from, to }]
    })
  }

  function deleteCue(sceneId: string, cueId: string) {
    const cue = doc.value.scenes.find((s) => s.id === sceneId)?.cues.find((c) => c.id === cueId)
    if (!cue) return
    emitEdit('删除提示项', { target: 'cue', targetId: cueId, containerId: sceneId, edit: 'delete', item: cloneDoc(cue) })
  }

  function reorderCues(sceneId: string, order: string[]) {
    const scene = doc.value.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    const fromOrder = scene.cues.map((c) => c.id)
    if (JSON.stringify(order) === JSON.stringify(fromOrder)) return
    emitEdit('拖动调整台词与音效顺序', { target: 'cue', containerId: sceneId, edit: 'reorder', order, fromOrder })
  }

  function changeCueKind(sceneId: string, cueId: string, kind: CueKind) {
    const cue = doc.value.scenes.find((s) => s.id === sceneId)?.cues.find((c) => c.id === cueId)
    if (!cue) return
    emitEdit(`切换提示项类型为${kind === 'dialogue' ? '台词' : kind === 'sfx' ? '音效' : '转场'}`, {
      target: 'cue',
      targetId: cueId,
      containerId: sceneId,
      edit: 'update',
      changes: [{ field: 'kind', from: cue.kind, to: kind }]
    })
  }

  /* ------------------------------ 撤销（本窗口最近一次操作） ------------------------------ */

  function undoMyLastEdit() {
    const mine = [...store.value.ops, ...store.value.outbox]
      .filter((op) => op.peerId === store.value.identity.peerId && op.type === 'edit' && !op.label.startsWith('撤销：') && !op.label.startsWith('退回：'))
      .sort((a, b) => b.ts.localeCompare(a.ts))[0]
    if (!mine?.edit) return
    // 撤销即一条确定性补偿操作：用操作载荷反转恢复，不依赖任何窗口的旧状态
    emit('edit', { label: `撤销：${mine.label}`, edit: invertEdit(mine.edit) })
  }

  /* ------------------------------ 导演确认 ------------------------------ */

  function acceptEdit(editIds: string[], reason = '') {
    emit('confirm', { label: `导演接受 ${editIds.length} 项修改`, confirm: { editIds, decision: 'accepted', reason } })
  }

  function rejectEdit(editIds: string[], reason = '') {
    // 退回 = 确定性补偿（按操作自身携带的 before 快照反转）+ 退回确认记录，两窗口一致回放
    const edits = store.value.ops.filter((op) => editIds.includes(op.id) && op.type === 'edit')
    for (const op of edits) {
      emit('edit', { label: `退回：${op.label}`, edit: invertEdit(op.edit!) })
    }
    if (edits.length) emit('confirm', { label: `导演退回 ${edits.length} 项修改`, confirm: { editIds, decision: 'rejected', reason } })
  }

  function acceptAllPending() {
    const ids = pendingRecords.value.map((r) => r.id)
    if (ids.length) acceptEdit(ids)
  }

  /* ------------------------------ 冲突处理 ------------------------------ */

  function resolveConflict(conflictId: string, choice: 'a' | 'b' | 'keep-both') {
    emit('resolve', {
      label: choice === 'keep-both' ? '导演裁决：两边版本都保留' : `导演裁决：采用${choice === 'a' ? '甲方' : '乙方'}版本`,
      resolve: { conflictId, choice }
    })
  }

  /* ------------------------------ 冻结 / 还原 ------------------------------ */

  function canFreeze(): boolean {
    return conflicts.value.length === 0
  }

  function freeze(name: string): FrozenVersion | null {
    if (!canFreeze()) return null
    const versionId = uid('version')
    const snapshot = cloneDoc(doc.value)
    emit('freeze', {
      label: `冻结制作稿 ${name}`,
      freeze: { versionId, name, snapshot }
    })
    return {
      id: versionId,
      name,
      createdAt: new Date().toISOString(),
      frozenByName: store.value.identity.name,
      frozenByRole: store.value.identity.role,
      document: snapshot,
      totalDuration: totalDuration(snapshot),
      sources: []
    }
  }

  function restoreVersion(version: FrozenVersion, reason = '') {
    emit('restore', {
      label: `还原到冻结版本 ${version.name}`,
      restore: { snapshot: cloneDoc(version.document), sourceVersionId: version.id, reason }
    })
  }

  function resetSample() {
    emit('restore', { label: '恢复示例数据', restore: { snapshot: cloneDoc(sampleDocument), reason: 'sample' } })
  }

  function downloadVersion(version: FrozenVersion) {
    const blob = new Blob([makeScript(version.document)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${version.document.title}-${version.name}.txt`.replace(/[\\/:*?"<>|]/g, '-')
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return {
    // 身份 / 连接
    identity,
    isDirector,
    online,
    peers,
    saveState,
    outboxCount,
    init,
    setOnline,
    flushOutbox,
    leaveWindow,
    // 派生数据
    document: doc,
    conflicts,
    allConflicts,
    records,
    pendingRecords,
    frozenVersions,
    warnings,
    totalDuration: total,
    durationOfCue: (cue: Cue) => durationOfCue(doc.value, cue),
    durationOfScene: (scene: StudioDocument['scenes'][number]) => durationOfScene(doc.value, scene),
    canFreeze,
    // 编辑
    updateProject,
    addScene,
    updateScene,
    deleteScene,
    moveScene,
    reorderScenes,
    addCue,
    updateCue,
    deleteCue,
    reorderCues,
    changeCueKind,
    undoMyLastEdit,
    // 导演
    acceptEdit,
    rejectEdit,
    acceptAllPending,
    resolveConflict,
    freeze,
    restoreVersion,
    resetSample,
    downloadVersion,
    makeScript: () => makeScript(doc.value)
  }
}

export type Studio = ReturnType<typeof useStudio>
