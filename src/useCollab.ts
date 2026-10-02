import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import type { Cue, CueKind, Scene, StudioDocument, WarningItem } from './types'
import { computeWarnings, durationOfCue as engineDurationOfCue, durationOfScene as engineDurationOfScene, totalDurationOf } from './engine'
import {
  KEY_MAX,
  KEY_MIN,
  applyOps,
  batchById,
  causalDescendants,
  clone,
  compareHlc,
  eventOrder,
  genId,
  midKey,
  reduce,
  resolveOps,
  reverseOps,
  tickHlc,
  type WorkingDocument
} from './sync/merge'
import type {
  Batch,
  BatchType,
  Conflict,
  FreezeEvent,
  Identity,
  LogEvent,
  Op,
  Role,
  Snapshot,
  SyncPacket
} from './sync/types'

const STORAGE_KEY = 'sologsb-1016-studio-v2'
const IDENTITY_KEY = 'sologsb-1016-identity-v2'
const PACKET_VERSION = 2

export interface PersistShape {
  app: 'sologsb-1016-collab'
  version: number
  events: LogEvent[]
  /** 每个客户端收到过的最后事件 HLC，用于跨包增量合并 */
  vectorClock: Record<string, string>
}

/* ------------------------------------------------------------------ */
/* 身份：每个浏览器窗口一位主创（导演 / 编剧）                          */
/* ------------------------------------------------------------------ */

function randomClientId(): string {
  return `client-${Math.random().toString(36).slice(2, 8)}`
}

function loadIdentity(): Identity {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Identity
      if (parsed.clientId && parsed.role) return parsed
    }
  } catch {
    // 身份损坏时重新分配
  }
  const identity: Identity = {
    clientId: randomClientId(),
    role: 'writer',
    label: '编剧端',
    createdAt: new Date().toISOString()
  }
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
  return identity
}

function loadPersisted(): { events: LogEvent[]; vectorClock: Record<string, string> } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as PersistShape
      if (Array.isArray(parsed.events)) {
        return { events: parsed.events, vectorClock: parsed.vectorClock ?? {} }
      }
    }
  } catch {
    // 日志损坏时回退到初始剧本
  }
  return { events: [], vectorClock: {} }
}

const initial = loadPersisted()
const identity = ref<Identity>(loadIdentity())
const events = ref<LogEvent[]>(initial.events)
const vectorClock = ref<Record<string, string>>(initial.vectorClock)
const online = ref(navigator.onLine)
const saveState = ref<'saved' | 'saving' | 'dirty'>('saved')
let saveTimer: number | undefined

window.addEventListener('online', () => { online.value = true })
window.addEventListener('offline', () => { online.value = false })

/* ------------------------------------------------------------------ */
/* HLC 与向量时钟                                                       */
/* ------------------------------------------------------------------ */

const lastLocalHlc = () => {
  const mine = events.value.filter((e) => e.clientId === identity.value.clientId)
  return mine.length ? mine[mine.length - 1].hlc : undefined
}
const lastRemoteHlc = () => {
  let max: string | undefined
  for (const e of events.value) {
    if (e.clientId === identity.value.clientId) continue
    if (!max || compareHlc(e.hlc, max) > 0) max = e.hlc
  }
  return max
}

function makeHlc(): string {
  return tickHlc(lastLocalHlc(), lastRemoteHlc(), identity.value.clientId)
}

function baseVector(): Record<string, string> {
  // 只记录批次事件（编辑因果），决策/解决事件不构成编辑前置
  const base: Record<string, string> = {}
  for (const [clientId, hlc] of Object.entries(vectorClock.value)) base[clientId] = hlc
  return base
}

function bumpVector(event: LogEvent) {
  const current = vectorClock.value[event.clientId]
  if (!current || compareHlc(event.hlc, current) > 0) {
    vectorClock.value = { ...vectorClock.value, [event.clientId]: event.hlc }
  }
}

/* ------------------------------------------------------------------ */
/* 归约视图                                                              */
/* ------------------------------------------------------------------ */

const reduced = computed(() => reduce(events.value, sampleDocument))
const doc = computed<StudioDocument>(() => reduced.value.document)
const conflicts = computed<Conflict[]>(() => reduced.value.conflicts)
const unresolvedConflicts = computed(() => conflicts.value.filter((conflict) => !conflict.resolution))
const warnings = computed<WarningItem[]>(() => computeWarnings(doc.value))
const totalDuration = computed(() => totalDurationOf(doc.value))

const pendingBatches = computed(() => reduced.value.batches.filter((batch) => batch.status === 'pending'))
const acceptedBatches = computed(() => reduced.value.batches.filter((batch) => batch.status === 'accepted'))
const rejectedBatches = computed(() => reduced.value.batches.filter((batch) => batch.status === 'rejected'))
const frozenEvents = computed<FreezeEvent[]>(() => reduced.value.frozen)

/* ------------------------------------------------------------------ */
/* 持久化：防抖写入，断网时依然逐次落盘                                  */
/* ------------------------------------------------------------------ */

function persist() {
  saveState.value = 'saving'
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const payload: PersistShape = {
      app: 'sologsb-1016-collab',
      version: PACKET_VERSION,
      events: events.value,
      vectorClock: vectorClock.value
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    saveState.value = 'saved'
  }, 160)
}

watch([events, vectorClock], persist, { deep: true })

/* ------------------------------------------------------------------ */
/* 批次构造：把一次 UI 操作翻译成 ops + before 快照                      */
/* ------------------------------------------------------------------ */

function workingSnapshot(): WorkingDocument {
  return clone(doc.value) as WorkingDocument
}

function projectSnapshot(): Snapshot {
  return {
    entity: 'project',
    id: 'project',
    value: {
      title: doc.value.title,
      subtitle: doc.value.subtitle,
      targetDuration: doc.value.targetDuration
    }
  }
}

function sceneSnapshot(doc: WorkingDocument, sceneId: string): Snapshot | undefined {
  const scene = doc.scenes.find((item) => item.id === sceneId)
  if (!scene) return undefined
  const copy = clone(scene)
  const orderKey = copy.__ok
  delete copy.__ok
  for (const cue of copy.cues) delete cue.__ok
  return { entity: 'scene', id: scene.id, value: copy, orderKey }
}

function cueSnapshot(doc: WorkingDocument, cueId: string): Snapshot | undefined {
  for (const scene of doc.scenes) {
    const cue = scene.cues.find((item) => item.id === cueId)
    if (cue) {
      const copy = clone(cue)
      const orderKey = copy.__ok
      delete copy.__ok
      return { entity: 'cue', id: cue.id, sceneId: scene.id, value: copy, orderKey }
    }
  }
  return undefined
}

function recordBatch(label: string, build: (doc: WorkingDocument) => { ops: Op[]; snapshots: Snapshot[] }, batchType: BatchType = 'edit', note = '') {
  const before = workingSnapshot()
  const { ops, snapshots } = build(before)
  if (!ops.length) return
  const hlc = makeHlc()
  const batch: Batch = {
    kind: 'batch',
    id: genId('batch'),
    hlc,
    clientId: identity.value.clientId,
    author: { role: identity.value.role, label: identity.value.label },
    at: new Date().toISOString(),
    batchType,
    label,
    note,
    base: baseVector(),
    ops,
    snapshots
  }
  appendEvent(batch)
}

function appendEvent(event: LogEvent) {
  events.value = [...events.value, event].sort(eventOrder)
  bumpVector(event)
  schedulePeerPush()
}

/** 编辑后做一个极短防抖，把新事件增量推给在线同组窗口；离线时静默跳过 */
let pushTimer: number | undefined
function schedulePeerPush() {
  if (typeof BroadcastChannel === 'undefined' || !online.value || peers.value.size === 0) return
  window.clearTimeout(pushTimer)
  pushTimer = window.setTimeout(() => pushToPeers(), 60)
}

/* ------------------------------------------------------------------ */
/* 文档操作（与旧编辑器功能对齐）                                        */
/* ------------------------------------------------------------------ */

function updateProject(field: 'title' | 'subtitle' | 'targetDuration', value: string | number) {
  recordBatch(`更新项目${field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '目标时长'}`, () => ({
    ops: [{ type: 'set', path: `project/${field}`, value: field === 'targetDuration' ? Number(value) : String(value) }],
    snapshots: [projectSnapshot()]
  }))
}

function updateScene(sceneId: string, field: keyof Scene, value: string | number) {
  const scene = doc.value.scenes.find((item) => item.id === sceneId)
  if (!scene) return
  recordBatch(`更新场次 ${scene.code}`, (before) => ({
    ops: [{ type: 'set', path: `scene/${sceneId}/${field}`, value: field === 'durationLimit' ? Number(value) : String(value) }],
    snapshots: [sceneSnapshot(before, sceneId)].filter(Boolean) as Snapshot[]
  }))
}

function updateCue(cueId: string, field: keyof Cue, value: string | number | undefined) {
  const hit = findCueInDocument(cueId)
  if (!hit) return
  recordBatch(`修改${hit.kind === 'dialogue' ? '台词' : hit.kind === 'sfx' ? '音效提示' : '转场'}`, (before) => {
    const snapshots = [cueSnapshot(before, cueId)].filter(Boolean) as Snapshot[]
    let normalized: unknown = value
    if (field === 'rate') normalized = Number(value)
    else if (field === 'manualDuration') normalized = value === '' || value === undefined ? undefined : Number(value)
    else if (field === 'kind') normalized = value
    else if (field === 'characterId' || field === 'soundEffectId') normalized = value || undefined
    else normalized = value ?? ''
    return { ops: [{ type: 'set', path: `cue/${cueId}/${field}`, value: normalized }], snapshots }
  })
}

function findCueInDocument(cueId: string): Cue | undefined {
  for (const scene of doc.value.scenes) {
    const cue = scene.cues.find((item) => item.id === cueId)
    if (cue) return cue
  }
  return undefined
}

function findSceneCode(sceneId: string): string {
  return doc.value.scenes.find((item) => item.id === sceneId)?.code ?? ''
}

function addScene() {
  const id = genId('scene')
  const number = doc.value.scenes.length + 1
  const scene: Scene = {
    id,
    code: `S${String(number).padStart(2, '0')}`,
    title: '未命名场次',
    location: '待填写',
    timeOfDay: '待填写',
    transition: '淡入',
    durationLimit: 150,
    cues: []
  }
  recordBatch(`新增场次 ${scene.code}`, () => ({ ops: [{ type: 'add-scene', entity: scene }], snapshots: [] }))
  return id
}

function deleteScene(sceneId: string) {
  const code = findSceneCode(sceneId)
  recordBatch(`删除场次 ${code}`, (before) => {
    const snapshot = sceneSnapshot(before, sceneId)
    return {
      ops: [{ type: 'delete-scene', sceneId }],
      snapshots: snapshot ? [snapshot] : []
    }
  })
}

function addCue(kind: CueKind, sceneId: string): string {
  const id = genId('cue')
  const cue: Cue = {
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
  const label = `新增${kind === 'dialogue' ? '台词' : kind === 'sfx' ? '音效' : '转场'}`
  recordBatch(label, () => ({ ops: [{ type: 'add-cue', entity: cue, sceneId }], snapshots: [] }))
  return id
}

function deleteCue(cueId: string) {
  recordBatch('删除提示项', (before) => {
    const snapshot = cueSnapshot(before, cueId)
    return { ops: [{ type: 'delete-cue', cueId }], snapshots: snapshot ? [snapshot] : [] }
  })
}

function moveCue(sceneId: string, cueId: string, targetCueId: string) {
  if (cueId === targetCueId) return
  recordBatch('拖动调整提示项顺序', (before) => {
    const scene = before.scenes.find((item) => item.id === sceneId)
    if (!scene) return { ops: [], snapshots: [] }
    const cue = scene.cues.find((item) => item.id === cueId)
    const target = scene.cues.find((item) => item.id === targetCueId)
    if (!cue || !target) return { ops: [], snapshots: [] }
    // 目标位置：取目标与其前后邻位键的中点
    const targetIndex = scene.cues.findIndex((item) => item.id === targetCueId)
    const fromIndex = scene.cues.findIndex((item) => item.id === cueId)
    const insertAfter = fromIndex < targetIndex
    const neighbor = scene.cues[insertAfter ? targetIndex + 1 : targetIndex - 1]
    const a = insertAfter ? target.__ok ?? KEY_MIN : neighbor?.__ok ?? KEY_MIN
    const b = insertAfter ? neighbor?.__ok ?? KEY_MAX : target.__ok ?? KEY_MAX
    const orderKey = midKey(a, b)
    const beforeSnap: Snapshot = {
      entity: 'cue',
      id: cueId,
      sceneId,
      value: (() => { const copy = clone(cue); delete copy.__ok; return copy })(),
      orderKey: cue.__ok
    }
    return { ops: [{ type: 'move-cue', cueId, sceneId, orderKey }], snapshots: [beforeSnap] }
  })
}

function moveScene(sceneId: string, direction: -1 | 1) {
  recordBatch('调整场次顺序', (before) => {
    const index = before.scenes.findIndex((item) => item.id === sceneId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= before.scenes.length) return { ops: [], snapshots: [] }
    const target = before.scenes[targetIndex]
    const neighbor = before.scenes[targetIndex + (direction === 1 ? 1 : -1)]
    const a = direction === 1 ? target.__ok ?? KEY_MIN : neighbor?.__ok ?? KEY_MIN
    const b = direction === 1 ? neighbor?.__ok ?? KEY_MAX : target.__ok ?? KEY_MAX
    const orderKey = midKey(a, b)
    const snapshot = sceneSnapshot(before, sceneId)
    return { ops: [{ type: 'move-scene', sceneId, orderKey }], snapshots: snapshot ? [snapshot] : [] }
  })
}

/* ------------------------------------------------------------------ */
/* 撤销：本地最后一批的逆向批次（同样进入确认流）                        */
/* ------------------------------------------------------------------ */

function undoLastLocal() {
  const mine = events.value
    .filter((e): e is Batch => e.kind === 'batch' && e.clientId === identity.value.clientId)
    .sort((a, b) => eventOrder(b, a))
  const target = mine.find((batch) => reduced.value.batches.find((view) => view.id === batch.id)?.status === 'pending')
  if (!target) return
  const ops = reverseOps(target)
  if (!ops.length) return
  const batch: Batch = {
    kind: 'batch',
    id: genId('batch'),
    hlc: makeHlc(),
    clientId: identity.value.clientId,
    author: { role: identity.value.role, label: identity.value.label },
    at: new Date().toISOString(),
    batchType: 'undo',
    label: `撤销：${target.label}`,
    base: baseVector(),
    ops,
    snapshots: [],
    revertsBatchId: target.id
  }
  appendEvent(batch)
}

/* ------------------------------------------------------------------ */
/* 导演确认：接受 / 退回（退回会级联同客户端后续未决批次）                */
/* ------------------------------------------------------------------ */

function requireDirector() {
  return identity.value.role === 'director'
}

function decideBatch(batchId: string, action: 'accepted' | 'rejected', note = ''): boolean {
  if (!requireDirector()) return false
  const view = reduced.value.batches.find((item) => item.id === batchId)
  if (!view || view.status !== 'pending') return false
  const revertedBatchIds = action === 'rejected' ? causalDescendants(events.value, batchId) : undefined
  appendEvent({
    kind: 'decision',
    id: genId('decision'),
    hlc: makeHlc(),
    clientId: identity.value.clientId,
    author: { role: identity.value.role, label: identity.value.label },
    at: new Date().toISOString(),
    targetBatchId: batchId,
    action,
    note,
    revertedBatchIds
  })
  return true
}

function acceptBatch(batchId: string) { return decideBatch(batchId, 'accepted') }
function rejectBatch(batchId: string) { return decideBatch(batchId, 'rejected') }

function acceptAllPending() {
  if (!requireDirector()) return
  for (const view of pendingBatches.value) {
    appendEvent({
      kind: 'decision',
      id: genId('decision'),
      hlc: makeHlc(),
      clientId: identity.value.clientId,
      author: { role: identity.value.role, label: identity.value.label },
      at: new Date().toISOString(),
      targetBatchId: view.id,
      action: 'accepted'
    })
  }
}

/* ------------------------------------------------------------------ */
/* 冲突解决：导演在确认区逐字段选择 / 调和，绝不静默丢内容                */
/* ------------------------------------------------------------------ */

function resolveConflict(conflict: Conflict, winner: 'A' | 'B' | 'mixed', manualEdits?: Record<string, unknown>, label?: string): boolean {
  if (!requireDirector()) return false
  if (conflict.resolution) return false
  const work = workingSnapshot()
  const ops = resolveOps(conflict, winner, work, manualEdits)
  const winnerSide = winner === 'A' ? conflict.sideA : winner === 'B' ? conflict.sideB : undefined
  appendEvent({
    kind: 'resolve',
    id: genId('resolve'),
    hlc: makeHlc(),
    clientId: identity.value.clientId,
    author: { role: identity.value.role, label: identity.value.label },
    at: new Date().toISOString(),
    conflictIds: [conflict.id],
    ops,
    winnerBatchId: winnerSide?.batchId,
    label: label ?? `导演裁决：${conflictLabel(conflict)}`
  })
  return true
}

function resolveConflicts(choices: Array<{ conflict: Conflict; winner: 'A' | 'B' }>): boolean {
  if (!requireDirector()) return false
  const open = choices.filter((choice) => !choice.conflict.resolution)
  if (!open.length) return false
  const work = workingSnapshot()
  const ops: Op[] = []
  let winnerBatchId: string | undefined
  for (const choice of open) {
    const step = resolveOps(choice.conflict, choice.winner, work)
    applyOps(work, step)
    ops.push(...step)
    if (!winnerBatchId) winnerBatchId = (choice.winner === 'A' ? choice.conflict.sideA : choice.conflict.sideB).batchId
  }
  appendEvent({
    kind: 'resolve',
    id: genId('resolve'),
    hlc: makeHlc(),
    clientId: identity.value.clientId,
    author: { role: identity.value.role, label: identity.value.label },
    at: new Date().toISOString(),
    conflictIds: open.map((choice) => choice.conflict.id),
    ops,
    winnerBatchId,
    label: `导演批量裁决 ${open.length} 处冲突`
  })
  return true
}

function conflictLabel(conflict: Conflict): string {
  if (conflict.entityType === 'project') return '项目信息'
  if (conflict.entityType === 'scene') {
    return `场次 ${doc.value.scenes.find((scene) => scene.id === conflict.entityId)?.code ?? conflict.entityId}`
  }
  for (const scene of doc.value.scenes) {
    const cue = scene.cues.find((item) => item.id === conflict.entityId)
    if (cue) return `${scene.code} · ${cue.text.slice(0, 10) || '提示项'}`
  }
  return '提示项'
}

/* ------------------------------------------------------------------ */
/* 冻结：只有导演、且没有未决修改与未处理冲突时才能冻结导出               */
/* ------------------------------------------------------------------ */

const exportBlockers = computed<string[]>(() => {
  const blockers: string[] = []
  if (unresolvedConflicts.value.length) blockers.push(`还有 ${unresolvedConflicts.value.length} 处冲突未经导演裁决`)
  if (pendingBatches.value.length) blockers.push(`提示：仍有 ${pendingBatches.value.length} 条修改未接受或退回（仅未裁决冲突会阻止冻结）`)
  return blockers.filter((text) => text.startsWith('还有'))
})
const freezeWarnings = computed(() => {
  const list: string[] = []
  if (pendingBatches.value.length) list.push(`仍有 ${pendingBatches.value.length} 条修改未接受或退回，冻结将只包含当前已合并内容`)
  return list
})
const canFreeze = computed(() => identity.value.role === 'director' && unresolvedConflicts.value.length === 0)

function freeze(name: string): FreezeEvent | undefined {
  if (!canFreeze.value) return undefined
  const event: FreezeEvent = {
    kind: 'freeze',
    id: genId('freeze'),
    hlc: makeHlc(),
    clientId: identity.value.clientId,
    author: { role: identity.value.role, label: identity.value.label },
    at: new Date().toISOString(),
    name: name.trim() || `制作稿 v${frozenEvents.value.length + 1}`,
    document: clone(doc.value),
    totalDuration: totalDuration.value
  }
  appendEvent(event)
  return event
}

/** 从冻结版本还原：生成一批 restore 操作，溯源记录来源冻结版本 */
function restoreFreeze(freezeId: string) {
  const source = frozenEvents.value.find((event) => event.id === freezeId)
  if (!source) return
  const ops = diffToSnapshot(source.document)
  if (!ops.length) return
  const batch: Batch = {
    kind: 'batch',
    id: genId('batch'),
    hlc: makeHlc(),
    clientId: identity.value.clientId,
    author: { role: identity.value.role, label: identity.value.label },
    at: new Date().toISOString(),
    batchType: 'restore',
    label: `还原冻结版本：${source.name}`,
    base: baseVector(),
    ops,
    snapshots: [],
    restoresFreezeId: source.id
  }
  appendEvent(batch)
}

/** 还原一条已接受的确认记录：重新应用该批次的原始操作 */
function restoreBatch(batchId: string) {
  const source = batchById(events.value, batchId)
  if (!source) return
  const batch: Batch = {
    kind: 'batch',
    id: genId('batch'),
    hlc: makeHlc(),
    clientId: identity.value.clientId,
    author: { role: identity.value.role, label: identity.value.label },
    at: new Date().toISOString(),
    batchType: 'restore',
    label: `还原确认记录：${source.label}`,
    base: baseVector(),
    ops: clone(source.ops),
    snapshots: clone(source.snapshots),
    restoresBatchId: source.id
  }
  appendEvent(batch)
}

/** 把当前文档改造成目标快照所需的最小操作集合（删除/新增/字段覆盖/顺序对齐） */
function diffToSnapshot(target: StudioDocument): Op[] {
  return diffDocuments(workingSnapshot(), target)
}

/** 以任意基准文档求到目标快照的差异；顺序按目标的数组下标生成分数键 */
function diffDocuments(base: WorkingDocument, target: StudioDocument): Op[] {
  const ops: Op[] = []
  for (const field of ['title', 'subtitle', 'targetDuration'] as const) {
    if (JSON.stringify(base[field]) !== JSON.stringify(target[field])) {
      ops.push({ type: 'set', path: `project/${field}`, value: clone(target[field]) })
    }
  }
  for (const scene of target.scenes) {
    const sceneIndex = target.scenes.indexOf(scene)
    const existing = base.scenes.find((item) => item.id === scene.id)
    const desiredSceneKey = midKey(KEY_MIN, KEY_MAX) + sceneIndex.toString(36).padStart(2, '0')
    if (!existing) {
      ops.push({ type: 'add-scene', entity: clone(scene) })
      ops.push({ type: 'move-scene', sceneId: scene.id, orderKey: desiredSceneKey })
      scene.cues.forEach((cue, cueIndex) => {
        ops.push({ type: 'move-cue', cueId: cue.id, sceneId: scene.id, orderKey: midKey(KEY_MIN, KEY_MAX) + cueIndex.toString(36).padStart(2, '0') })
      })
      continue
    }
    for (const field of ['code', 'title', 'location', 'timeOfDay', 'transition', 'durationLimit'] as const) {
      if (JSON.stringify(existing[field]) !== JSON.stringify(scene[field])) {
        ops.push({ type: 'set', path: `scene/${scene.id}/${field}`, value: clone(scene[field]) })
      }
    }
    for (const cue of scene.cues) {
      const cueIndex = scene.cues.indexOf(cue)
      const existingCue = existing.cues.find((item) => item.id === cue.id)
      const desiredKey = midKey(KEY_MIN, KEY_MAX) + cueIndex.toString(36).padStart(2, '0')
      if (!existingCue) {
        ops.push({ type: 'add-cue', entity: clone(cue), sceneId: scene.id })
        ops.push({ type: 'move-cue', cueId: cue.id, sceneId: scene.id, orderKey: desiredKey })
        continue
      }
      for (const field of ['kind', 'characterId', 'text', 'emotion', 'rate', 'soundEffectId', 'transition', 'manualDuration'] as const) {
        if (JSON.stringify(existingCue[field]) !== JSON.stringify(cue[field])) {
          ops.push({ type: 'set', path: `cue/${cue.id}/${field}`, value: clone(cue[field]) })
        }
      }
      if (existingCue.__ok !== desiredKey) {
        ops.push({ type: 'move-cue', cueId: cue.id, sceneId: scene.id, orderKey: desiredKey })
      }
    }
    for (const existingCue of existing.cues) {
      if (!scene.cues.some((item) => item.id === existingCue.id)) ops.push({ type: 'delete-cue', cueId: existingCue.id })
    }
    if (existing.__ok !== desiredSceneKey) ops.push({ type: 'move-scene', sceneId: scene.id, orderKey: desiredSceneKey })
  }
  for (const scene of base.scenes) {
    if (!target.scenes.some((item) => item.id === scene.id)) ops.push({ type: 'delete-scene', sceneId: scene.id })
  }
  return ops
}

/* ------------------------------------------------------------------ */
/* 同步：BroadcastChannel 实时合并 + 文件导入导出（断网恢复的载体）       */
/* ------------------------------------------------------------------ */

const channelName = 'sologsb-1016-sync'
let channel: BroadcastChannel | undefined
const peers = ref<Set<string>>(new Set())
/** 每个同组窗口已知的事件 id：只推送对方缺少的增量，避免全量回环 */
const peerKnown = new Map<string, Set<string>>()
const incomingStats = ref<{ added: number; merged: number; at: string } | null>(null)

function exportPacket(): SyncPacket {
  return {
    app: 'sologsb-1016-sync',
    version: PACKET_VERSION,
    exportedAt: new Date().toISOString(),
    identity: clone(identity.value),
    events: clone(events.value),
    queues: {}
  }
}

function mergeIncoming(incoming: LogEvent[], source?: Identity): { added: number; merged: number; maxHlc?: string } {
  const known = new Map(events.value.map((event) => [event.id, event]))
  let added = 0
  let maxHlc: string | undefined
  const next = [...events.value]
  for (const event of incoming) {
    if (!event || !event.id || !event.hlc || !event.kind) continue
    if (known.has(event.id)) continue
    // 拒绝用旧窗口状态整体覆盖：事件只追加、不替换
    known.set(event.id, event)
    next.push(event)
    added += 1
    if (!maxHlc || compareHlc(event.hlc, maxHlc) > 0) maxHlc = event.hlc
    if (source) bumpVector(event)
  }
  if (added) {
    next.sort(eventOrder)
    events.value = next
  }
  incomingStats.value = { added, merged: incoming.length, at: new Date().toISOString() }
  return { added, merged: incoming.length, maxHlc }
}

async function importPacketFile(file: File): Promise<number> {
  const text = await file.text()
  const packet = JSON.parse(text) as SyncPacket
  if (packet.app !== 'sologsb-1016-sync') throw new Error('不是本工作台的同步文件')
  const { added } = mergeIncoming(packet.events, packet.identity)
  return added
}

function downloadPacket() {
  const blob = new Blob([JSON.stringify(exportPacket())], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `声场同步-${identity.value.label}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function setupChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return
  channel = new BroadcastChannel(channelName)
  const announce = () => channel?.postMessage({ type: 'hello', from: identity.value.clientId, identity: identity.value })
  const peerSeenAt = new Map<string, number>()
  channel.onmessage = (message: MessageEvent) => {
    const data = message.data as
      | { type: 'hello'; from: string; identity: Identity }
      | { type: 'welcome'; from: string; identity: Identity; events: LogEvent[] }
      | { type: 'events'; from: string; events: LogEvent[] }
      | { type: 'ping'; from: string }
      | { type: 'pong'; from: string }
    if (!data || data.from === identity.value.clientId) return
    peers.value = new Set(peers.value).add(data.from)
    peerSeenAt.set(data.from, Date.now())
    if (data.type === 'hello') {
      // 已在线的一端把自己的全部事件推给新上线者（仅此一次全量）
      peerKnown.set(data.from, new Set(events.value.map((event) => event.id)))
      channel?.postMessage({ type: 'welcome', from: identity.value.clientId, identity: identity.value, events: events.value })
    } else if (data.type === 'welcome') {
      mergeIncoming(data.events, data.identity)
      // 对方的已知集合就是它刚发来的事件集合
      peerKnown.set(data.from, new Set(data.events.map((event) => event.id)))
      // 新上线者回推对方可能缺少的增量（离线期间的修改）
      sendDelta(data.from)
    } else if (data.type === 'events') {
      mergeIncoming(data.events)
      const known = peerKnown.get(data.from) ?? new Set<string>()
      for (const event of data.events) known.add(event.id)
      peerKnown.set(data.from, known)
    } else if (data.type === 'ping') {
      channel?.postMessage({ type: 'pong', from: identity.value.clientId })
    }
    // pong 仅用于刷新上方的 peerSeenAt 时间戳
  }
  announce()
  window.setTimeout(announce, 400)
  window.setInterval(() => {
    channel?.postMessage({ type: 'ping', from: identity.value.clientId })
    const cutoff = Date.now() - 6000
    let changed = false
    for (const [id, at] of peerSeenAt) {
      if (at < cutoff) {
        peers.value.delete(id)
        peerKnown.delete(id)
        peerSeenAt.delete(id)
        changed = true
      }
    }
    if (changed) peers.value = new Set(peers.value)
  }, 4000)
  window.addEventListener('online', () => { announce(); window.setTimeout(pushToPeers, 300) })
}

/** 只发送某个同组窗口缺少的事件 */
function sendDelta(peerId: string) {
  if (!channel) return
  const known = peerKnown.get(peerId) ?? new Set<string>()
  const delta = events.value.filter((event) => !known.has(event.id))
  if (delta.length) channel.postMessage({ type: 'events', from: identity.value.clientId, events: delta })
  peerKnown.set(peerId, new Set(events.value.map((event) => event.id)))
}

/** 把本端新增记录以增量方式推送给所有同组窗口；连接恢复/手动触发 */
function pushToPeers() {
  if (!channel) return
  for (const peerId of peers.value) sendDelta(peerId)
}

/* ------------------------------------------------------------------ */
/* 身份切换                                                              */
/* ------------------------------------------------------------------ */

function setIdentity(role: Role, label: string) {
  const next: Identity = { ...identity.value, role, label: label.trim() || (role === 'director' ? '导演端' : '编剧端') }
  identity.value = next
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(next))
  // 重新告知同组窗口新的角色/名称，并同步可能积压的记录
  if (channel) {
    channel.postMessage({ type: 'hello', from: identity.value.clientId, identity: next })
    window.setTimeout(pushToPeers, 200)
  }
}

/* ------------------------------------------------------------------ */
/* 溯源视图                                                              */
/* ------------------------------------------------------------------ */

function provenanceOf(key: string) {
  return reduced.value.provenance[key]
}

function cueProvenance(cueId: string) {
  return provenanceOf(`cue:${cueId}`)
}

function sceneProvenance(sceneId: string) {
  return provenanceOf(`scene:${sceneId}`)
}

/* ------------------------------------------------------------------ */
/* 兼容旧版 v1 草稿：一次性迁移                                          */
/* ------------------------------------------------------------------ */

function migrateV1IfNeeded() {
  if (events.value.length) return
  try {
    const raw = localStorage.getItem('sologsb-1016-studio-v1')
    if (!raw) return
    const parsed = JSON.parse(raw) as { document?: StudioDocument }
    if (!parsed.document) return
    const base = clone(sampleDocument) as WorkingDocument
    for (const scene of base.scenes) {
      scene.__ok = midKey(KEY_MIN, KEY_MAX) + base.scenes.indexOf(scene).toString(36).padStart(2, '0')
      scene.cues.forEach((cue, i) => { cue.__ok = midKey(KEY_MIN, KEY_MAX) + i.toString(36).padStart(2, '0') })
    }
    const ops = diffDocuments(base, parsed.document)
    if (!ops.length) return
    const batch: Batch = {
      kind: 'batch',
      id: genId('batch'),
      hlc: makeHlc(),
      clientId: identity.value.clientId,
      author: { role: identity.value.role, label: identity.value.label },
      at: new Date().toISOString(),
      batchType: 'edit',
      label: '从旧版草稿迁移',
      base: {},
      ops,
      snapshots: []
    }
    appendEvent(batch)
  } catch {
    // 迁移失败保持初始剧本
  }
}

migrateV1IfNeeded()

/* ------------------------------------------------------------------ */
/* 工具：时长（供 UI 使用）                                              */
/* ------------------------------------------------------------------ */

function durationOfCue(cue: Cue) { return engineDurationOfCue(doc.value, cue) }
function durationOfScene(scene: Scene) { return engineDurationOfScene(doc.value, scene) }

export function useCollab() {
  return {
    // 状态
    identity,
    online,
    peers,
    saveState,
    incomingStats,
    events,
    // 归约视图
    document: doc,
    reduced,
    conflicts,
    unresolvedConflicts,
    warnings,
    totalDuration,
    pendingBatches,
    acceptedBatches,
    rejectedBatches,
    frozenEvents,
    exportBlockers,
    freezeWarnings,
    canFreeze,
    orderKeys: computed(() => reduced.value.orderKeys),
    // 编辑
    updateProject,
    updateScene,
    updateCue,
    addScene,
    deleteScene,
    addCue,
    deleteCue,
    moveCue,
    moveScene,
    undoLastLocal,
    // 导演确认
    acceptBatch,
    rejectBatch,
    acceptAllPending,
    // 冲突裁决
    resolveConflict,
    resolveConflicts,
    conflictLabel,
    // 冻结 / 还原 / 导出
    freeze,
    restoreFreeze,
    restoreBatch,
    // 同步
    setupChannel,
    pushToPeers,
    exportPacket,
    importPacketFile,
    downloadPacket,
    mergeIncoming,
    setIdentity,
    // 溯源
    provenanceOf,
    cueProvenance,
    sceneProvenance,
    // 工具
    durationOfCue,
    durationOfScene
  }
}
