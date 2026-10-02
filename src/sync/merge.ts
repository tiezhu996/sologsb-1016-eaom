import type { Cue, Scene, StudioDocument } from '../types'
import type {
  Batch,
  BatchView,
  Conflict,
  ConflictCandidate,
  DecisionEvent,
  FreezeEvent,
  LogEvent,
  Op,
  Provenance,
  ReduceResult,
  ResolveEvent,
  Snapshot
} from './types'

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export const genId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/* ------------------------------------------------------------------ */
/* HLC：混合逻辑时钟，物理时间 + 跳动计数 + 客户端编号，全序可比较       */
/* ------------------------------------------------------------------ */

export function compareHlc(a: string, b: string): number {
  const [pa = '0', ca = '0'] = a.split('-')
  const [pb = '0', cb = '0'] = b.split('-')
  const ta = parseInt(pa, 36)
  const tb = parseInt(pb, 36)
  if (ta !== tb) return ta - tb
  const cc = parseInt(ca, 36) - parseInt(cb, 36)
  return cc
}

/** 事件全序：HLC 优先，id 兜底，保证不同客户端归约结果一致 */
export function eventOrder(a: LogEvent, b: LogEvent): number {
  return compareHlc(a.hlc, b.hlc) || a.id.localeCompare(b.id)
}

export function tickHlc(last: string | undefined, remote: string | undefined, clientId: string): string {
  const now = Date.now().toString(36)
  const lastPhys = last ? parseInt(last.split('-')[0], 36) : 0
  const remotePhys = remote ? parseInt(remote.split('-')[0], 36) : 0
  const physMs = Math.max(Date.now(), lastPhys, remotePhys)
  const phys = physMs.toString(36)
  const lastCounter = last && parseInt(last.split('-')[0], 36) === physMs ? parseInt(last.split('-')[1], 36) : -1
  const remoteCounter = remote && remotePhys === physMs ? parseInt(remote.split('-')[1], 36) : -1
  let counter = 0
  if (phys === now) counter = Math.max(0, lastCounter + 1, remoteCounter + 1)
  else counter = Math.max(lastCounter, remoteCounter) + 1
  void clientId
  return `${phys}-${counter.toString(36).padStart(4, '0')}`
}

/* ------------------------------------------------------------------ */
/* 工作文档：内部用 __ok 保存分数排序键，导出时剥离                      */
/* ------------------------------------------------------------------ */

export interface WorkingCue extends Cue { __ok?: string }
export interface WorkingScene extends Scene { __ok?: string; cues: WorkingCue[] }
export interface WorkingDocument extends StudioDocument { scenes: WorkingScene[] }

const KEY_MIN = '0'
const KEY_MAX = 'zzzzzzzzzzzz'

function midKey(a: string, b: string): string {
  if (a >= b) return a + 'm'
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  const ca = i < a.length ? a.charCodeAt(i) : 96
  const cb = i < b.length ? b.charCodeAt(i) : 123
  const mid = Math.floor((ca + cb) / 2)
  if (mid <= ca) return a + 'm'
  if (mid >= cb) return a.slice(0, i) + String.fromCharCode(cb - 1) + 'm'
  return a.slice(0, i) + String.fromCharCode(mid)
}

function sortScenes(doc: WorkingDocument) {
  doc.scenes.sort((a, b) => ((a.__ok ?? KEY_MAX) < (b.__ok ?? KEY_MAX) ? -1 : 1))
  for (const scene of doc.scenes) scene.cues.sort((a, b) => ((a.__ok ?? KEY_MAX) < (b.__ok ?? KEY_MAX) ? -1 : 1))
}

export function toPublicDocument(doc: WorkingDocument): StudioDocument {
  const clean = clone(doc) as WorkingDocument
  for (const scene of clean.scenes) {
    delete scene.__ok
    for (const cue of scene.cues) delete cue.__ok
  }
  return clean as StudioDocument
}

export function findCue(doc: WorkingDocument, cueId: string): { scene: WorkingScene; cue: WorkingCue } | undefined {
  for (const scene of doc.scenes) {
    const cue = scene.cues.find((item) => item.id === cueId)
    if (cue) return { scene, cue }
  }
  return undefined
}

function lastCueKey(doc: WorkingDocument, sceneId: string): string {
  const scene = doc.scenes.find((item) => item.id === sceneId)
  return scene?.cues[scene.cues.length - 1]?.__ok ?? KEY_MIN
}

function lastSceneKey(doc: WorkingDocument): string {
  return doc.scenes[doc.scenes.length - 1]?.__ok ?? KEY_MIN
}

/** 在工作文档上重放操作；返回受影响的溯源键 */
export function applyOps(doc: WorkingDocument, ops: Op[]): string[] {
  const provKeys: string[] = []
  const touch = (key: string) => {
    if (!provKeys.includes(key)) provKeys.push(key)
  }
  for (const op of ops) {
    if (op.type === 'set') {
      const [entity, id, field] = op.path.split('/')
      if (entity === 'project') {
        ;(doc as unknown as Record<string, unknown>)[id] = op.value
        touch(`project:${id}`)
      } else if (entity === 'scene') {
        const scene = doc.scenes.find((item) => item.id === id)
        if (scene) {
          ;(scene as unknown as Record<string, unknown>)[field] = op.value
          touch(`scene:${id}`)
        }
      } else if (entity === 'cue') {
        const hit = findCue(doc, id)
        if (hit) {
          ;(hit.cue as unknown as Record<string, unknown>)[field] = op.value
          touch(`cue:${id}`)
        }
      } else if (entity === 'char') {
        const ch = doc.characters.find((item) => item.id === id)
        if (ch) {
          ;(ch as unknown as Record<string, unknown>)[field] = op.value
          touch(`char:${id}`)
        }
      } else if (entity === 'fx') {
        const fx = doc.soundEffects.find((item) => item.id === id)
        if (fx) {
          ;(fx as unknown as Record<string, unknown>)[field] = op.value
          touch(`fx:${id}`)
        }
      }
    } else if (op.type === 'add-char') {
      if (!doc.characters.some((item) => item.id === op.entity.id)) doc.characters.push(clone(op.entity))
      touch(`char:${op.entity.id}`)
    } else if (op.type === 'add-fx') {
      if (!doc.soundEffects.some((item) => item.id === op.entity.id)) doc.soundEffects.push(clone(op.entity))
      touch(`fx:${op.entity.id}`)
    } else if (op.type === 'add-scene') {
      if (!doc.scenes.some((item) => item.id === op.entity.id)) {
        const scene = clone(op.entity) as WorkingScene
        const baseKey = lastSceneKey(doc)
        scene.__ok = midKey(baseKey, KEY_MAX)
        scene.cues.forEach((cue, index) => {
          ;(cue as WorkingCue).__ok = midKey(KEY_MIN, KEY_MAX) + index.toString(36).padStart(2, '0')
        })
        doc.scenes.push(scene)
      }
      touch(`scene:${op.entity.id}`)
    } else if (op.type === 'add-cue') {
      const scene = doc.scenes.find((item) => item.id === op.sceneId)
      if (scene && !findCue(doc, op.entity.id)) {
        const cue = clone(op.entity) as WorkingCue
        cue.__ok = midKey(lastCueKey(doc, op.sceneId), KEY_MAX)
        scene.cues.push(cue)
      }
      touch(`cue:${op.entity.id}`)
    } else if (op.type === 'delete-scene') {
      doc.scenes = doc.scenes.filter((item) => item.id !== op.sceneId)
      touch(`scene:${op.sceneId}`)
    } else if (op.type === 'delete-cue') {
      for (const scene of doc.scenes) scene.cues = scene.cues.filter((item) => item.id !== op.cueId)
      touch(`cue:${op.cueId}`)
    } else if (op.type === 'move-cue') {
      const hit = findCue(doc, op.cueId)
      if (hit) hit.cue.__ok = op.orderKey
      touch(`cue:${op.cueId}:order`)
    } else if (op.type === 'move-scene') {
      const scene = doc.scenes.find((item) => item.id === op.sceneId)
      if (scene) scene.__ok = op.orderKey
      touch(`scene:${op.sceneId}:order`)
    }
  }
  sortScenes(doc)
  return provKeys
}

/* ------------------------------------------------------------------ */
/* 批次快照 → 候选视图                                                  */
/* ------------------------------------------------------------------ */

const SCENE_FIELDS = ['code', 'title', 'location', 'timeOfDay', 'transition', 'durationLimit'] as const
const CUE_FIELDS = ['kind', 'characterId', 'text', 'emotion', 'rate', 'soundEffectId', 'transition', 'manualDuration'] as const

export function snapshotFieldMap(snapshot: Snapshot): Record<string, unknown> {
  if (snapshot.entity === 'project') return { ...(snapshot.value as Record<string, unknown>) }
  if (snapshot.entity === 'scene') {
    const value = (snapshot.value ?? {}) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const f of SCENE_FIELDS) out[f] = value[f]
    return out
  }
  if (snapshot.entity === 'cue') {
    const value = (snapshot.value ?? {}) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const f of CUE_FIELDS) out[f] = value[f]
    return out
  }
  return {}
}

interface ChangeTouch {
  entityType: 'project' | 'scene' | 'cue'
  entityId: string
  sceneId?: string
  fields: Set<string>
}

/** 从操作推导批次实际改了哪些字段（顺序与删除也算字段） */
function changedTouches(batch: Batch): Map<string, ChangeTouch> {
  const map = new Map<string, ChangeTouch>()
  const ensure = (entityType: 'project' | 'scene' | 'cue', entityId: string, sceneId?: string): ChangeTouch => {
    const key = `${entityType}:${entityId}`
    let touch = map.get(key)
    if (!touch) {
      touch = { entityType, entityId, sceneId, fields: new Set() }
      map.set(key, touch)
    }
    return touch
  }
  for (const op of batch.ops) {
    if (op.type === 'set') {
      const [entity, id, field] = op.path.split('/')
      if (entity === 'project') ensure('project', 'project').fields.add(field)
      if (entity === 'scene') ensure('scene', id).fields.add(field)
      if (entity === 'cue') {
        const snap = batch.snapshots.find((s) => s.entity === 'cue' && s.id === id)
        ensure('cue', id, snap?.sceneId).fields.add(field)
      }
    } else if (op.type === 'add-scene') {
      ensure('scene', op.entity.id).fields.add('__created')
    } else if (op.type === 'add-cue') {
      ensure('cue', op.entity.id, op.sceneId).fields.add('__created')
    } else if (op.type === 'delete-scene') {
      ensure('scene', op.sceneId).fields.add('__deleted')
    } else if (op.type === 'delete-cue') {
      const snap = batch.snapshots.find((s) => s.entity === 'cue' && s.id === op.cueId)
      ensure('cue', op.cueId, snap?.sceneId).fields.add('__deleted')
    } else if (op.type === 'move-cue') {
      const snap = batch.snapshots.find((s) => s.entity === 'cue' && s.id === op.cueId)
      ensure('cue', op.cueId, snap?.sceneId).fields.add('__order')
    } else if (op.type === 'move-scene') {
      ensure('scene', op.sceneId).fields.add('__order')
    }
  }
  return map
}

/* ------------------------------------------------------------------ */
/* 冲突检测：并发关系图 → 连通分量 → 每个实体一条冲突，候选为各端最终内容   */
/* ------------------------------------------------------------------ */

interface EntityNode {
  key: string
  entityType: 'project' | 'scene' | 'cue'
  entityId: string
  sceneId?: string
  batch: Batch
}

interface CrossNode {
  cueId: string
  sceneId: string
  batch: Batch
  kind: 'edit' | 'delete'
}

function classUnionFind<T extends string>() {
  const parent = new Map<T, T>()
  const find = (x: T): T => {
    let root = x
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!
    let cur = x
    while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next }
    parent.set(x, root)
    return root
  }
  const add = (x: T) => { if (!parent.has(x)) parent.set(x, x) }
  const union = (a: T, b: T) => {
    add(a); add(b)
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  const groups = (): Map<T, T[]> => {
    const out = new Map<T, T[]>()
    for (const x of parent.keys()) {
      const root = find(x)
      const list = out.get(root) ?? []
      list.push(x)
      out.set(root, list)
    }
    return out
  }
  return { add, union, groups, find }
}

/** 批次对某个实体写入后的字段值（直接取操作里的新值） */
function writtenFields(batch: Batch): Map<string, Map<string, { field: string; value: unknown; deleted: boolean }>> {
  const byEntity = new Map<string, Map<string, { field: string; value: unknown; deleted: boolean }>>()
  const put = (entityKey: string, field: string, value: unknown, deleted = false) => {
    const map = byEntity.get(entityKey) ?? new Map()
    map.set(field, { field, value, deleted })
    byEntity.set(entityKey, map)
  }
  for (const op of batch.ops) {
    if (op.type === 'set') {
      const [entity, id, field] = op.path.split('/')
      if (['project', 'scene', 'cue', 'char', 'fx'].includes(entity)) put(`${entity}:${id}`, field, op.value)
    } else if (op.type === 'delete-scene') {
      put(`scene:${op.sceneId}`, '__deleted', true, true)
    } else if (op.type === 'delete-cue') {
      const snap = batch.snapshots.find((s) => s.entity === 'cue' && s.id === op.cueId)
      put(`cue:${op.cueId}`, '__deleted', true, true)
      void snap
    } else if (op.type === 'add-scene') {
      put(`scene:${op.entity.id}`, '__created', true)
    } else if (op.type === 'add-cue') {
      put(`cue:${op.entity.id}`, '__created', true)
    }
  }
  return byEntity
}

/** 某一端在分量内、对一个实体的最终状态：从最早批次的修改前快照播种，再依次叠加该端新值 */
function clientFinalState(batches: Batch[], entityType: 'project' | 'scene' | 'cue', entityId: string): {
  fields: Record<string, unknown>
  fullValue?: unknown
  deleted: boolean
  latest: Batch
  sceneId?: string
} {
  const ordered = [...batches].sort((a, b) => compareHlc(a.hlc, b.hlc))
  const latest = ordered[ordered.length - 1]
  let seed: Snapshot | undefined
  for (const batch of ordered) {
    const snap = batch.snapshots.find((s) => s.entity === entityType && s.id === entityId)
    if (snap) { seed = snap; break }
  }
  const full: Record<string, unknown> = seed ? { ...(seed.value as Record<string, unknown> | undefined) } : {}
  const fields: Record<string, unknown> = {}
  let deleted = seed?.deleted === true
  let sceneId = seed?.sceneId
  for (const batch of ordered) {
    const writes = writtenFields(batch).get(`${entityType}:${entityId}`)
    if (!writes) continue
    for (const [field, write] of writes) {
      if (field === '__deleted') { deleted = true; fields.__deleted = true; continue }
      deleted = false
      fields[field] = write.value
      full[field] = write.value
      if (field === '__created') deleted = false
    }
    const cueSnap = batch.snapshots.find((s) => s.entity === 'cue' && s.id === entityId)
    if (cueSnap?.sceneId) sceneId = cueSnap.sceneId
    if (entityType === 'cue') {
      const addCue = batch.ops.find((op): op is Extract<Op, { type: 'add-cue' }> => op.type === 'add-cue' && op.entity.id === entityId)
      if (addCue) { Object.assign(full, addCue.entity as unknown as Record<string, unknown>); sceneId = addCue.sceneId }
    }
    if (entityType === 'scene') {
      const addScene = batch.ops.find((op): op is Extract<Op, { type: 'add-scene' }> => op.type === 'add-scene' && op.entity.id === entityId)
      if (addScene) Object.assign(full, addScene.entity as unknown as Record<string, unknown>)
    }
  }
  return { fields, fullValue: seed || Object.keys(full).length ? full : undefined, deleted, latest, sceneId }
}

function makeCandidate(clientId: string, state: { fields: Record<string, unknown>; fullValue?: unknown; deleted: boolean; latest: Batch; sceneId?: string }, entityType: 'project' | 'scene' | 'cue', entityId: string): ConflictCandidate {
  const fallback: Record<string, unknown> = { ...state.fields }
  if (state.deleted) fallback.__deleted = true
  const snapshot: Snapshot | undefined = state.fullValue !== undefined
    ? { entity: entityType, id: entityId, value: state.fullValue, deleted: state.deleted, sceneId: state.sceneId }
    : undefined
  return {
    clientId,
    batchId: state.latest.id,
    hlc: state.latest.hlc,
    label: state.latest.label,
    author: state.latest.author,
    deleted: state.deleted,
    snapshot,
    fallback
  }
}

export interface DetectionResult {
  conflicts: Conflict[]
  conflictsByBatch: Map<string, Set<string>>
  /** 冲突 id → 分量内全部批次（用于裁决后再次分歧时重新打开） */
  conflictBatches: Map<string, Batch[]>
}

export function detectConflicts(batches: Batch[], concurrent: (a: Batch, b: Batch) => boolean): DetectionResult {
  const conflicts: Conflict[] = []
  const conflictsByBatch = new Map<string, Set<string>>()
  const conflictBatches = new Map<string, Batch[]>()
  const touchesCache = new Map<string, Map<string, ChangeTouch>>()
  const touchesOf = (batch: Batch) => {
    let map = touchesCache.get(batch.id)
    if (!map) { map = changedTouches(batch); touchesCache.set(batch.id, map) }
    return map
  }

  const tagBatches = (conflictId: string, members: Batch[]) => {
    conflictBatches.set(conflictId, members)
    for (const batch of members) {
      const set = conflictsByBatch.get(batch.id) ?? new Set<string>()
      set.add(conflictId)
      conflictsByBatch.set(batch.id, set)
    }
  }

  /* ---- 同实体并发：DSU 以「实体键 + 批次」为节点 ---- */
  const sameEntityDsu = classUnionFind<string>()
  const nodeMeta = new Map<string, EntityNode>()
  const nodeKey = (entityKey: string, batchId: string) => `${entityKey}::${batchId}`
  for (const batch of batches) {
    for (const touch of touchesOf(batch).values()) {
      if (touch.fields.has('__order')) continue
      const key = nodeKey(`${touch.entityType}:${touch.entityId}`, batch.id)
      sameEntityDsu.add(key)
      nodeMeta.set(key, { key: `${touch.entityType}:${touch.entityId}`, entityType: touch.entityType, entityId: touch.entityId, sceneId: touch.sceneId, batch })
    }
  }
  for (let i = 0; i < batches.length; i += 1) {
    for (let j = i + 1; j < batches.length; j += 1) {
      const a = batches[i]; const b = batches[j]
      if (!concurrent(a, b)) continue
      for (const key of new Set([...touchesOf(a).keys()].filter((k) => touchesOf(b).has(k)))) {
        const touchA = touchesOf(a).get(key)!
        if (touchA.fields.has('__order') && touchA.fields.size === 1) continue
        sameEntityDsu.union(nodeKey(key, a.id), nodeKey(key, b.id))
      }
    }
  }

  for (const nodes of sameEntityDsu.groups().values()) {
    if (nodes.length < 2) continue
    const metas = nodes.map((n) => nodeMeta.get(n)!).filter(Boolean)
    const first = metas[0]
    const sameEntity = metas.filter((m) => m.key === first.key)
    if (sameEntity.length < 2) continue
    const members = [...new Set(sameEntity.map((m) => m.batch))]
    const byClient = new Map<string, Batch[]>()
    for (const batch of members) {
      const list = byClient.get(batch.clientId) ?? []
      list.push(batch)
      byClient.set(batch.clientId, list)
    }
    if (byClient.size < 2) continue

    const states = new Map<string, ReturnType<typeof clientFinalState>>()
    for (const [clientId, clientBatches] of byClient) {
      states.set(clientId, clientFinalState(clientBatches, first.entityType, first.entityId))
    }
    // 求差异字段
    const writtenUnion = new Set<string>()
    for (const state of states.values()) {
      for (const field of Object.keys(state.fields)) writtenUnion.add(field)
      if (state.deleted) writtenUnion.add('__deleted')
    }
    const differing = new Set<string>()
    for (const field of writtenUnion) {
      if (field === '__created' || field === '__order') continue
      const values = [...states.values()].map((state) =>
        field === '__deleted' ? Boolean(state.deleted) : state.fields[field] ?? null)
      const writers = [...states.values()].filter((state) => field === '__deleted' ? true : Object.prototype.hasOwnProperty.call(state.fields, field))
      if (field === '__deleted') {
        const delVals = [...states.values()].map((state) => state.deleted)
        if (new Set(delVals).size > 1) differing.add('__deleted')
        continue
      }
      if (writers.length >= 2 && new Set(values.map((v) => JSON.stringify(v))).size > 1) differing.add(field)
    }
    if (!differing.size) continue

    // 稳定冲突 id：实体 + 涉及的端；顺序按 clientId 定向两侧
    const clientIds = [...byClient.keys()].sort()
    const conflictId = `${first.key}::${clientIds.join('~')}`
    const sideStates = clientIds.slice(0, 2).map((cid) => ({ cid, state: states.get(cid)! }))
    const conflict: Conflict = {
      id: conflictId,
      entityType: first.entityType,
      entityId: first.entityId,
      sceneId: sideStates[0].state.sceneId ?? sideStates[1].state.sceneId ?? first.sceneId,
      fields: [...differing].sort(),
      sideA: makeCandidate(sideStates[0].cid, sideStates[0].state, first.entityType, first.entityId),
      sideB: makeCandidate(sideStates[1].cid, sideStates[1].state, first.entityType, first.entityId)
    }
    conflicts.push(conflict)
    tagBatches(conflictId, members)
  }

  /* ---- 跨实体：一端删场次，另一端在并发地改场中提示项 ---- */
  const crossDsu = classUnionFind<string>()
  const crossMeta = new Map<string, CrossNode>()
  const crossNodeKey = (cueId: string, batchId: string) => `cross::${cueId}::${batchId}`
  for (let i = 0; i < batches.length; i += 1) {
    for (let j = i + 1; j < batches.length; j += 1) {
      const a = batches[i]; const b = batches[j]
      if (!concurrent(a, b)) continue
      registerCross(a, b)
      registerCross(b, a)
    }
  }
  function registerCross(editBatch: Batch, delBatch: Batch) {
    const delTouches = touchesOf(delBatch)
    const deletedScenes = [...delTouches.values()].filter((t) => t.entityType === 'scene' && t.fields.has('__deleted'))
    if (!deletedScenes.length) return
    for (const touch of touchesOf(editBatch).values()) {
      if (touch.entityType !== 'cue') continue
      const scene = deletedScenes.find((t) => t.entityId === touch.sceneId)
      if (!scene) continue
      const editKey = crossNodeKey(touch.entityId, editBatch.id)
      const delKey = crossNodeKey(touch.entityId, delBatch.id)
      crossDsu.add(editKey); crossDsu.add(delKey)
      crossDsu.union(editKey, delKey)
      crossMeta.set(editKey, { cueId: touch.entityId, sceneId: scene.entityId, batch: editBatch, kind: 'edit' })
      crossMeta.set(delKey, { cueId: touch.entityId, sceneId: scene.entityId, batch: delBatch, kind: 'delete' })
    }
  }
  for (const nodes of crossDsu.groups().values()) {
    if (nodes.length < 2) continue
    const metas = nodes.map((n) => crossMeta.get(n)!).filter(Boolean)
    const cueId = metas[0].cueId
    const sceneId = metas[0].sceneId
    const editBatches = [...new Set(metas.filter((m) => m.kind === 'edit').map((m) => m.batch))]
    const deleteBatches = [...new Set(metas.filter((m) => m.kind === 'delete').map((m) => m.batch))]
    if (!editBatches.length || !deleteBatches.length) continue
    const editClients = [...new Set(editBatches.map((b) => b.clientId))].sort()
    const delClients = [...new Set(deleteBatches.map((b) => b.clientId))].filter((cid) => !editClients.includes(cid))
    if (!delClients.length) continue
    const editState = clientFinalState(editBatches, 'cue', cueId)
    const latestDelete = [...deleteBatches].sort((a, b) => compareHlc(b.hlc, a.hlc))[0]
    const sceneSnap = latestDelete.snapshots.find((s) => s.entity === 'scene' && s.id === sceneId)
    const editCandidate = makeCandidate(editClients[0], editState, 'cue', cueId)
    const delCandidate: ConflictCandidate = {
      clientId: latestDelete.clientId,
      batchId: latestDelete.id,
      hlc: latestDelete.hlc,
      label: latestDelete.label,
      author: latestDelete.author,
      deleted: true,
      snapshot: undefined,
      fallback: { __deleted: true }
    }
    // 按 clientId 稳定定向
    const pair = [editCandidate, delCandidate].sort((x, y) => x.clientId.localeCompare(y.clientId))
    const conflictId = `cue:${cueId}:del::${[...editClients, ...delClients].sort().join('~')}`
    const conflict: Conflict = {
      id: conflictId,
      entityType: 'cue',
      entityId: cueId,
      sceneId,
      fields: ['__deleted'],
      sideA: pair[0],
      sideB: pair[1],
      restoredScene: sceneSnap ? clone(sceneSnap) : undefined
    }
    conflicts.push(conflict)
    tagBatches(conflictId, [...editBatches, ...deleteBatches])
  }

  return { conflicts, conflictsByBatch, conflictBatches }
}

/* ------------------------------------------------------------------ */
/* 冲突解决 → 操作                                                      */
/* ------------------------------------------------------------------ */

function editsOf(conflict: Conflict, side: 'A' | 'B'): Record<string, unknown> {
  const chosen = side === 'A' ? conflict.sideA : conflict.sideB
  const edits = chosen.snapshot ? snapshotFieldMap(chosen.snapshot) : {}
  if (chosen.deleted) edits.__deleted = true
  if (chosen.snapshot?.entity === 'cue' && chosen.snapshot.sceneId) edits.__sceneId = chosen.snapshot.sceneId
  return edits
}

/** 由导演的选择生成最终操作；manualEdits 为逐字段调和（字段名以 # 前缀表示手动值） */
export function resolveOps(
  conflict: Conflict,
  winner: 'A' | 'B' | 'mixed',
  current: WorkingDocument,
  manualEdits?: Record<string, unknown>
): Op[] {
  const merged = winner === 'A' ? editsOf(conflict, 'A') : winner === 'B' ? editsOf(conflict, 'B') : { ...editsOf(conflict, 'A'), ...editsOf(conflict, 'B'), ...(manualEdits ?? {}) }
  const ops: Op[] = []

  if (conflict.entityType === 'project') {
    for (const [field, value] of Object.entries(merged)) {
      if (field.startsWith('__')) continue
      ops.push({ type: 'set', path: `project/${field}`, value })
    }
    return ops
  }

  if (conflict.entityType === 'scene') {
    const liveScene = current.scenes.find((s) => s.id === conflict.entityId)
    if (merged.__deleted) {
      ops.push({ type: 'delete-scene', sceneId: conflict.entityId })
      return ops
    }
    if (!liveScene) {
      const snap = (winner === 'B' ? conflict.sideB.snapshot : conflict.sideA.snapshot) ?? conflict.sideA.snapshot
      if (snap?.value) ops.push({ type: 'add-scene', entity: clone(snap.value) as Scene })
    }
    for (const [field, value] of Object.entries(merged)) {
      if (field.startsWith('__')) continue
      ops.push({ type: 'set', path: `scene/${conflict.entityId}/${field}`, value })
    }
    return ops
  }

  // cue
  const hit = findCue(current, conflict.entityId)
  if (merged.__deleted) {
    ops.push({ type: 'delete-cue', cueId: conflict.entityId })
    return ops
  }
  const winnerSnap = (winner === 'B' ? conflict.sideB.snapshot : conflict.sideA.snapshot) ?? conflict.sideA.snapshot
  let sceneId = typeof merged.__sceneId === 'string' ? merged.__sceneId : conflict.sceneId ?? winnerSnap?.sceneId
  if (!hit) {
    const sceneExists = sceneId ? current.scenes.some((s) => s.id === sceneId) : false
    if (!sceneExists && conflict.restoredScene?.value) {
      const restored = clone(conflict.restoredScene.value) as Scene
      ops.push({ type: 'add-scene', entity: restored })
      sceneId = conflict.restoredScene.id
    }
    if (winnerSnap?.value && sceneId) {
      ops.push({ type: 'add-cue', entity: clone(winnerSnap.value) as Cue, sceneId })
    }
  } else if (sceneId && hit.scene.id !== sceneId && current.scenes.some((s) => s.id === sceneId)) {
    // 跨场移动不在当前编辑操作范围内：保留原场次，字段照常合并
  }
  for (const [field, value] of Object.entries(merged)) {
    if (field.startsWith('__')) continue
    ops.push({ type: 'set', path: `cue/${conflict.entityId}/${field}`, value })
  }
  return ops
}

/* ------------------------------------------------------------------ */
/* 逆向操作：撤销 / 退回                                                 */
/* ------------------------------------------------------------------ */

function snapshotBefore(batch: Batch, entity: Snapshot['entity'], id: string): Snapshot | undefined {
  return batch.snapshots.find((s) => s.entity === entity && s.id === id && !s.deleted) ??
    batch.snapshots.find((s) => s.entity === entity && s.id === id)
}

export function reverseOps(batch: Batch): Op[] {
  const ops: Op[] = []
  for (const op of batch.ops) {
    if (op.type === 'set') {
      const [entity, id, field] = op.path.split('/')
      if (entity === 'project') {
        const snap = batch.snapshots.find((s) => s.entity === 'project')
        if (snap) ops.push({ type: 'set', path: op.path, value: (snap.value as Record<string, unknown>)[field] })
      } else if (entity === 'scene') {
        const snap = snapshotBefore(batch, 'scene', id)
        if (snap?.value) ops.push({ type: 'set', path: op.path, value: (snap.value as Record<string, unknown>)[field] })
      } else if (entity === 'cue') {
        const snap = snapshotBefore(batch, 'cue', id)
        if (snap?.value) ops.push({ type: 'set', path: op.path, value: (snap.value as Record<string, unknown>)[field] })
      }
    } else if (op.type === 'add-scene') {
      ops.push({ type: 'delete-scene', sceneId: op.entity.id })
    } else if (op.type === 'add-cue') {
      ops.push({ type: 'delete-cue', cueId: op.entity.id })
    } else if (op.type === 'delete-scene') {
      const snap = batch.snapshots.find((s) => s.entity === 'scene' && s.id === op.sceneId)
      if (snap?.value) ops.push({ type: 'add-scene', entity: clone(snap.value) as Scene })
    } else if (op.type === 'delete-cue') {
      const snap = batch.snapshots.find((s) => s.entity === 'cue' && s.id === op.cueId)
      if (snap?.value && snap.sceneId) {
        ops.push({ type: 'add-cue', entity: clone(snap.value) as Cue, sceneId: snap.sceneId })
        if (snap.orderKey) ops.push({ type: 'move-cue', cueId: snap.id, sceneId: snap.sceneId, orderKey: snap.orderKey })
      }
    } else if (op.type === 'move-cue') {
      const snap = batch.snapshots.find((s) => s.entity === 'cue' && s.id === op.cueId)
      if (snap?.orderKey) ops.push({ type: 'move-cue', cueId: op.cueId, sceneId: op.sceneId, orderKey: snap.orderKey })
    } else if (op.type === 'move-scene') {
      const snap = batch.snapshots.find((s) => s.entity === 'scene' && s.id === op.sceneId)
      if (snap?.orderKey) ops.push({ type: 'move-scene', sceneId: op.sceneId, orderKey: snap.orderKey })
    }
  }
  return ops
}

/* ------------------------------------------------------------------ */
/* happens-before：base 向量的传递闭包                                   */
/* ------------------------------------------------------------------ */

function happensBeforeMap(batches: Batch[]): Map<string, Set<string>> {
  const byClient = new Map<string, Batch[]>()
  for (const b of batches) {
    const list = byClient.get(b.clientId) ?? []
    list.push(b)
    byClient.set(b.clientId, list)
  }
  const ancestors = new Map<string, Set<string>>()
  const sorted = [...batches].sort((x, y) => compareHlc(x.hlc, y.hlc))
  for (const b of sorted) {
    const set = new Set<string>()
    for (const [clientId, hlc] of Object.entries(b.base)) {
      const known = (byClient.get(clientId) ?? []).filter((x) => compareHlc(x.hlc, hlc) <= 0)
      for (const ancestor of known) {
        set.add(ancestor.id)
        for (const a of ancestors.get(ancestor.id) ?? []) set.add(a)
      }
    }
    // 同客户端严格有序
    const sameClient = (byClient.get(b.clientId) ?? []).filter((x) => compareHlc(x.hlc, b.hlc) < 0)
    for (const ancestor of sameClient) {
      set.add(ancestor.id)
      for (const a of ancestors.get(ancestor.id) ?? []) set.add(a)
    }
    ancestors.set(b.id, set)
  }
  return ancestors
}

/* ------------------------------------------------------------------ */
/* 因果拓扑排序：在 happens-before 约束内保持 HLC 稳定序                 */
/* ------------------------------------------------------------------ */

function topoOrder(hlcSorted: LogEvent[], ancestors: Map<string, Set<string>>): LogEvent[] {
  const byId = new Map(hlcSorted.map((event) => [event.id, event]))
  const mustPrecede = (a: LogEvent, b: LogEvent): boolean => {
    // a 必须排在 b 之前：b 是批次且因果依赖 a
    if (a.kind === 'batch' && b.kind === 'batch' && ancestors.get(b.id)?.has(a.id)) return true
    // 决策/裁决/冻结归约时需要它所引用的批次已经完成冲突检测与应用：
    // HLC 不晚于它的批次一律在前
    if (a.kind === 'batch' && b.kind !== 'batch' && compareHlc(a.hlc, b.hlc) <= 0) return true
    // 同客户端严格按 HLC 先后
    if (a.clientId === b.clientId && compareHlc(a.hlc, b.hlc) < 0) return true
    return false
  }
  const visited = new Set<string>()
  const output: LogEvent[] = []
  const visit = (event: LogEvent, stack: Set<string>) => {
    if (visited.has(event.id)) return
    if (stack.has(event.id)) return // 防御环
    stack.add(event.id)
    for (const candidate of hlcSorted) {
      if (candidate.id !== event.id && mustPrecede(candidate, event)) visit(candidate, stack)
    }
    stack.delete(event.id)
    visited.add(event.id)
    output.push(event)
  }
  for (const event of hlcSorted) visit(event, new Set())
  void byId
  return output
}

/* ------------------------------------------------------------------ */
/* 主归约：事件日志 → 工作文档 / 冲突 / 溯源 / 批次视图 / 冻结            */
/* ------------------------------------------------------------------ */

export function reduce(events: LogEvent[], genesis: StudioDocument): ReduceResult {
  const doc = clone(genesis) as WorkingDocument
  for (const scene of doc.scenes) {
    scene.__ok = midKey(KEY_MIN, KEY_MAX) + doc.scenes.indexOf(scene).toString(36).padStart(2, '0')
    scene.cues.forEach((cue, i) => {
      cue.__ok = midKey(KEY_MIN, KEY_MAX) + i.toString(36).padStart(2, '0')
    })
  }

  const hlcSorted = [...events].sort(eventOrder)
  const batchesAll = hlcSorted.filter((e): e is Batch => e.kind === 'batch')
  const ancestors = happensBeforeMap(batchesAll)
  // 用因果关系做拓扑排序：HLC 同毫秒时不能让随机 id 破坏 happens-before
  const sorted = topoOrder(hlcSorted, ancestors)

  const batches = sorted.filter((e): e is Batch => e.kind === 'batch')
  const concurrent = (x: Batch, y: Batch) => x.id !== y.id && !ancestors.get(x.id)?.has(y.id) && !ancestors.get(y.id)?.has(x.id)

  const provenance = new Map<string, Provenance>()
  const provStack = new Map<string, Provenance[]>()
  const frozen: FreezeEvent[] = []

  /* ---- 预扫描：导演决策决定哪些批次被退回 ---- */
  const decisionOf = new Map<string, DecisionEvent>()
  const rejectedBatches = new Set<string>()
  const rejectedBy = new Map<string, DecisionEvent>()
  for (const event of sorted) {
    if (event.kind !== 'decision') continue
    decisionOf.set(event.targetBatchId, event)
    if (event.action === 'rejected') {
      rejectedBatches.add(event.targetBatchId)
      rejectedBy.set(event.targetBatchId, event)
      for (const id of event.revertedBatchIds ?? []) {
        rejectedBatches.add(id)
        rejectedBy.set(id, event)
      }
    }
  }

  const provOf = (e: LogEvent): Provenance => ({
    clientId: e.clientId,
    batchId: e.id,
    hlc: e.hlc,
    label: e.kind === 'batch' ? e.label : e.kind === 'resolve' ? e.label : '导演确认',
    author: e.author,
    at: e.at
  })

  const applyEventOps = (e: Batch | ResolveEvent, ops: Op[]) => {
    const keys = applyOps(doc, ops)
    for (const key of keys) {
      provenance.set(key, provOf(e))
      const stack = provStack.get(key) ?? []
      stack.push(provOf(e))
      provStack.set(key, stack)
    }
  }

  /* ---- 冲突检测：在全部批次（含被退回）之间做并发分量归并，退回自动关闭在后面处理 ---- */
  const detection = detectConflicts(batches, concurrent)
  const conflicts = new Map<string, Conflict>(detection.conflicts.map((conflict) => [conflict.id, conflict]))
  const conflictsByBatch = detection.conflictsByBatch
  const conflictBatches = detection.conflictBatches

  /* ---- 主折叠：退回批次的操作整体不参与归约（而非用旧状态逆操作覆盖） ---- */
  const priorResolutions = new Map<string, ResolveEvent>()
  for (const event of sorted) {
    if (event.kind === 'batch') {
      if (rejectedBatches.has(event.id)) continue
      applyEventOps(event, event.ops)
    } else if (event.kind === 'resolve') {
      for (const id of event.conflictIds) priorResolutions.set(id, event)
      applyEventOps(event, event.ops)
    } else if (event.kind === 'freeze') {
      frozen.push(event)
    }
  }

  /* ---- 套用导演裁决；若裁决之后又出现任何一端都没看到裁决的并发分歧，重新打开 ---- */
  for (const [conflictId, conflict] of conflicts) {
    const resolve = priorResolutions.get(conflictId)
    if (!resolve) continue
    const members = conflictBatches.get(conflictId) ?? []
    const reopened = members.some((b) => {
      if (rejectedBatches.has(b.id)) return false
      // 发起批次时已看到该裁决（base 中该导演端时钟不早于裁决）→ 裁决后的新编辑，不重开
      const resolverClock = b.base[resolve.clientId]
      if (resolverClock && compareHlc(resolverClock, resolve.hlc) >= 0) return false
      // 否则批次晚于裁决：裁决尚未传播到时离线产生的修改，旧冲突保持打开
      return compareHlc(b.hlc, resolve.hlc) > 0
    })
    if (reopened) continue
    conflict.resolution = {
      eventId: resolve.id,
      by: resolve.author,
      clientId: resolve.clientId,
      at: resolve.at,
      label: resolve.label,
      winnerBatchId: resolve.winnerBatchId
    }
  }

  /* ---- 退回自动关闭冲突：恰有一侧被退回时，另一侧已在归约中生效，自动采纳 ---- */
  for (const [, conflict] of conflicts) {
    if (conflict.resolution) continue
    const sideARejected = rejectedBatches.has(conflict.sideA.batchId)
    const sideBRejected = rejectedBatches.has(conflict.sideB.batchId)
    if (sideARejected === sideBRejected) continue
    const rejectedId = sideARejected ? conflict.sideA.batchId : conflict.sideB.batchId
    const otherId = sideARejected ? conflict.sideB.batchId : conflict.sideA.batchId
    const decision = rejectedBy.get(rejectedId)
    const rejectedBatch = batches.find((b) => b.id === rejectedId)
    conflict.resolution = {
      eventId: decision!.id,
      by: decision!.author,
      clientId: decision!.clientId,
      at: decision!.at,
      label: `随「${rejectedBatch?.label ?? '修改'}」退回自动关闭`,
      winnerBatchId: otherId,
      auto: 'rejected-side'
    }
  }

  frozen.sort((a, b) => eventOrder(b, a))

  const batchViews: BatchView[] = batches
    .slice()
    .sort((a, b) => eventOrder(b, a))
    .map((b) => {
      const decision = decisionOf.get(b.id)
      const cascadedBy = rejectedBy.get(b.id)
      const status: BatchView['status'] = decision?.action === 'accepted'
        ? 'accepted'
        : rejectedBatches.has(b.id)
          ? 'rejected'
          : 'pending'
      const decider = decision ?? cascadedBy
      // 已退回批次之后、同窗口离线继续做出的修改：保持待确认，防止旧窗口覆盖新修改
      const rejectedAncestorId = status === 'pending'
        ? [...(ancestors.get(b.id) ?? [])].find((id) => rejectedBatches.has(id))
        : undefined
      return {
        id: b.id,
        label: b.label,
        note: b.note,
        batchType: b.batchType,
        hlc: b.hlc,
        at: b.at,
        clientId: b.clientId,
        author: b.author,
        status,
        decisionBy: decider ? decider.author : undefined,
        decisionAt: decider?.at,
        revertsBatchId: b.revertsBatchId,
        restoresBatchId: b.restoresBatchId,
        restoresFreezeId: b.restoresFreezeId,
        conflictIdsCreated: [...(conflictsByBatch.get(b.id) ?? [])].sort(),
        rejectedAncestorId
      }
    })

  return {
    document: toPublicDocument(doc),
    orderKeys: {
      scenes: Object.fromEntries(doc.scenes.map((scene) => [scene.id, scene.__ok ?? ''])),
      cues: Object.fromEntries(doc.scenes.flatMap((scene) => scene.cues.map((cue) => [cue.id, cue.__ok ?? ''])))
    },
    conflicts: [...conflicts.values()].sort((a, b) => a.id.localeCompare(b.id)),
    provenance: Object.fromEntries(provenance),
    batches: batchViews,
    frozen
  }
}


/* ------------------------------------------------------------------ */
/* 因果后代：退回某个批次时，需要一并回滚的、同客户端后续未决批次          */
/* ------------------------------------------------------------------ */

export function causalDescendants(events: LogEvent[], targetBatchId: string): string[] {
  const batches = events.filter((e): e is Batch => e.kind === 'batch')
  const ancestors = happensBeforeMap(batches)
  const target = batches.find((b) => b.id === targetBatchId)
  if (!target) return []
  const decisionTargets = new Set(
    events.filter((e): e is DecisionEvent => e.kind === 'decision').map((e) => e.targetBatchId)
  )
  return batches
    .filter((b) => b.clientId === target.clientId && b.id !== target.id)
    .filter((b) => ancestors.get(b.id)?.has(target.id))
    .filter((b) => !decisionTargets.has(b.id))
    .sort((a, b) => compareHlc(a.hlc, b.hlc))
    .map((b) => b.id)
}

export function batchById(events: LogEvent[], id: string): Batch | undefined {
  return events.find((e): e is Batch => e.kind === 'batch' && e.id === id)
}

export { midKey, KEY_MIN, KEY_MAX }
