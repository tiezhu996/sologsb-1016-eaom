import { sampleDocument } from './sample'
import type {
  ChangeRecord,
  Conflict,
  ConflictSide,
  Cue,
  EditPayload,
  FrozenSource,
  FrozenVersion,
  Op,
  Scene,
  StudioDocument,
  WarningItem
} from './types'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const cloneDoc = clone
const cloneValue = <T,>(value: T): T => clone(value)

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/* ============================== 向量时钟 ============================== */

/** a 因果先于 b：a 知道的每个窗口序号都不超过 b，且至少一项严格更小 */
export function clockBefore(a: Op['clock'], b: Op['clock']): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  let strictly = false
  for (const key of keys) {
    const av = a[key] ?? 0
    const bv = b[key] ?? 0
    if (av > bv) return false
    if (av < bv) strictly = true
  }
  return strictly
}

/** 并发：互不可比（两边都有对方没见过的修改） */
export function concurrent(a: Op['clock'], b: Op['clock']): boolean {
  return !clockBefore(a, b) && !clockBefore(b, a)
}

/** 拓扑排序：因果序优先；并发操作按时间戳、peerId、seq 破平，保证两窗口结果一致 */
export function topoSort(ops: Op[]): Op[] {
  const sorted = [...ops].sort((x, y) => x.ts.localeCompare(y.ts) || x.peerId.localeCompare(y.peerId) || x.seq - y.seq)
  const placed = new Set<string>()
  const result: Op[] = []
  const visit = (op: Op) => {
    if (placed.has(op.id)) return
    const deps = sorted.filter((other) => other.id !== op.id && clockBefore(other.clock, op.clock))
    for (const dep of deps) visit(dep)
    if (!placed.has(op.id)) {
      placed.add(op.id)
      result.push(op)
    }
  }
  for (const op of sorted) visit(op)
  return result
}

/* ============================== 实体定位 ============================== */

type TrackTarget =
  | { kind: 'project' }
  | { kind: 'character'; id: string }
  | { kind: 'sfx'; id: string }
  | { kind: 'scene'; id: string }
  | { kind: 'cue'; id: string; containerId: string }
  | { kind: 'scene-order' }
  | { kind: 'cue-order'; containerId: string }

function targetOf(edit: EditPayload): TrackTarget {
  switch (edit.target) {
    case 'project':
      return { kind: 'project' }
    case 'character':
      return { kind: 'character', id: edit.targetId! }
    case 'sfx':
      return { kind: 'sfx', id: edit.targetId! }
    case 'scene':
      if (edit.edit === 'reorder') return { kind: 'scene-order' }
      return { kind: 'scene', id: edit.targetId! }
    case 'cue':
      if (edit.edit === 'reorder') return { kind: 'cue-order', containerId: edit.containerId! }
      return { kind: 'cue', id: edit.targetId!, containerId: edit.containerId! }
  }
}

function trackKeyOf(edit: EditPayload): string {
  const t = targetOf(edit)
  if (t.kind === 'project') return 'project'
  if (t.kind === 'scene-order') return 'scene-order'
  if (t.kind === 'cue-order') return `cue-order:${t.containerId}`
  if (t.kind === 'cue') return `cue:${t.id}`
  return `${t.kind}:${t.id}`
}

function findEntity(doc: StudioDocument, key: string): unknown {
  if (key === 'project') {
    const { title, subtitle, targetDuration } = doc
    return { title, subtitle, targetDuration }
  }
  if (key === 'scene-order') return doc.scenes.map((s) => s.id)
  if (key.startsWith('cue-order:')) {
    const scene = doc.scenes.find((s) => s.id === key.slice(10))
    return scene ? scene.cues.map((c) => c.id) : []
  }
  if (key.startsWith('cue:')) {
    const id = key.slice(4)
    for (const scene of doc.scenes) {
      const cue = scene.cues.find((c) => c.id === id)
      if (cue) return clone(cue)
    }
    return null
  }
  if (key.startsWith('character:')) return clone(doc.characters.find((c) => c.id === key.slice(10)) ?? null)
  if (key.startsWith('sfx:')) return clone(doc.soundEffects.find((s) => s.id === key.slice(4)) ?? null)
  if (key.startsWith('scene:')) return clone(doc.scenes.find((s) => s.id === key.slice(6)) ?? null)
  return undefined
}

/* ============================== 操作应用 ============================== */

export function applyEdit(doc: StudioDocument, payload: EditPayload): void {
  const { target, edit } = payload
  if (target === 'project') {
    const record = doc as unknown as Record<string, unknown>
    for (const change of payload.changes ?? []) record[change.field] = change.to
    return
  }

  const listOf = (): unknown[] => {
    if (target === 'character') return doc.characters
    if (target === 'sfx') return doc.soundEffects
    return doc.scenes
  }

  if (target === 'cue') {
    const scene = doc.scenes.find((s) => s.id === payload.containerId)
    if (edit === 'add') {
      scene?.cues.push(payload.item as Cue)
    } else if (edit === 'delete') {
      if (scene) scene.cues = scene.cues.filter((c) => c.id !== payload.targetId)
    } else if (edit === 'reorder') {
      if (scene) reorderByIds(scene.cues as { id: string }[], payload.order ?? [])
    } else {
      const cue = scene?.cues.find((c) => c.id === payload.targetId)
      if (cue) patchFields(cue, payload.changes ?? [])
    }
    return
  }

  const list = listOf()
  if (edit === 'add') {
    list.push(payload.item as { id: string })
  } else if (edit === 'delete') {
    if (target === 'scene') {
      doc.scenes = doc.scenes.filter((s) => s.id !== payload.targetId)
    } else if (target === 'character') {
      doc.characters = doc.characters.filter((item) => item.id !== payload.targetId)
    } else {
      doc.soundEffects = doc.soundEffects.filter((item) => item.id !== payload.targetId)
    }
  } else if (edit === 'reorder') {
    reorderByIds(list as { id: string }[], payload.order ?? [])
  } else {
    const item = list.find((entry) => (entry as { id: string }).id === payload.targetId)
    if (item) patchFields(item, payload.changes ?? [])
  }
}

function patchFields(item: unknown, changes: { field: string; to: unknown }[]): void {
  const record = item as Record<string, unknown>
  for (const change of changes) {
    if (change.to === undefined) delete record[change.field]
    else record[change.field] = change.to
  }
}

/** 构造一条编辑操作的补偿操作（语义反转），用于撤销与导演退回 */
export function invertEdit(payload: EditPayload): EditPayload {
  const inverted: EditPayload = {
    target: payload.target,
    targetId: payload.targetId,
    containerId: payload.containerId,
    edit: payload.edit,
    changes: payload.changes?.map((change) => ({ field: change.field, from: change.to, to: change.from })),
    item: payload.item ? cloneDoc(payload.item) : undefined,
    index: payload.index,
    order: payload.fromOrder,
    fromOrder: payload.order
  }
  if (payload.edit === 'add') inverted.edit = 'delete'
  else if (payload.edit === 'delete') inverted.edit = 'add'
  return inverted
}

/** 确定性回退：删除/新增/reorder 均有完整前后快照，update 由 changes.from 恢复，不依赖“旧窗口” */
export function revertEdit(doc: StudioDocument, payload: EditPayload): void {
  applyEdit(doc, invertEdit(payload))
}

function reorderByIds(list: { id: string }[], order: string[]): void {
  const byId = new Map<string, { id: string }>(list.map((item) => [item.id, item]))
  const next: { id: string }[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (item) {
      next.push(item)
      byId.delete(id)
    }
  }
  // 并发新增、不在顺序快照里的项目，确定性地追加到尾部而不是丢弃
  for (const item of byId.values()) next.push(item)
  list.length = 0
  list.push(...next)
}

/* ============================== 归约引擎 ============================== */

interface Branch {
  peerId: string
  tip: Op
  /** 该 peer 在本轨道当前 epoch 中创作的编辑 */
  editIds: string[]
  firstTs: string
}

interface Track {
  key: string
  /** 共同祖先快照（epoch 起点：首次创建或冲突解决/收敛时重置） */
  base: unknown
  /** epoch 起点的“编辑向量时钟”（只统计 edit 操作；裁决/确认/冻结不推进它） */
  epochEditClock: Op['clock']
  branches: Branch[]
  openConflictId?: string
}

/**
 * 每条 edit 操作自带创作时刻的“编辑向量时钟”（editClock），裁决/确认/冻结不推进它。
 * 这里直接取用；缺失时退化为仅含自身序号（兼容旧数据/测试）。
 */
function editClockOf(op: Op): Op['clock'] {
  return op.editClock ?? { [op.peerId]: op.seq }
}

/** 把编辑时钟裁剪到某轨道 epoch 之后 */
function relativeEditClock(clock: Op['clock'], epoch: Op['clock']): Op['clock'] {
  const out: Op['clock'] = {}
  for (const key of new Set([...Object.keys(clock), ...Object.keys(epoch)])) {
    const value = (clock[key] ?? 0) - (epoch[key] ?? 0)
    if (value > 0) out[key] = value
  }
  return out
}

function mergeClock(a: Op['clock'], b: Op['clock']): Op['clock'] {
  const out: Op['clock'] = { ...a }
  for (const [key, value] of Object.entries(b)) out[key] = Math.max(out[key] ?? 0, value)
  return out
}

export interface ReducedState {
  document: StudioDocument
  tracks: Map<string, Track>
  conflicts: Conflict[]
}

function entityLabel(doc: StudioDocument, target: TrackTarget): string {
  switch (target.kind) {
    case 'project':
      return doc.title || '项目信息'
    case 'character':
      return doc.characters.find((c) => c.id === target.id)?.name ?? '角色'
    case 'sfx':
      return doc.soundEffects.find((s) => s.id === target.id)?.name ?? '音效'
    case 'scene':
      return doc.scenes.find((s) => s.id === target.id)?.code ?? '场次'
    case 'cue': {
      for (const scene of doc.scenes) {
        const cue = scene.cues.find((c) => c.id === target.id)
        if (cue) {
          if (cue.kind === 'dialogue') return cue.text.slice(0, 16) || '台词'
          if (cue.kind === 'sfx') return cue.text.slice(0, 16) || '音效提示'
          return cue.text.slice(0, 16) || '转场'
        }
      }
      return '提示项'
    }
    case 'scene-order':
      return '场次顺序'
    case 'cue-order':
      return `${doc.scenes.find((s) => s.id === target.containerId)?.code ?? ''} 提示项顺序`
  }
}

function editSummary(edit: EditPayload): string {
  const verb = edit.edit === 'add' ? '新增' : edit.edit === 'delete' ? '删除' : edit.edit === 'reorder' ? '调整顺序' : '修改'
  const what = edit.target === 'project' ? '项目信息' : edit.target === 'cue' ? '提示项' : edit.target === 'sfx' ? '音效' : edit.target === 'scene' ? '场次' : '角色'
  const fields = (edit.changes ?? []).map((c) => c.field)
  return fields.length ? `${verb}${what} · ${fields.join('、')}` : `${verb}${what}`
}

export function reduceLog(rawOps: Op[]): ReducedState {
  const ops = topoSort(rawOps)
  const opsById = new Map(ops.map((item) => [item.id, item]))
  const document = cloneDoc(sampleDocument)
  const tracks = new Map<string, Track>()
  const conflicts: Conflict[] = []
  let conflictSeq = 0

  for (const op of ops) {
    if (op.type === 'freeze') continue
    if (op.type === 'restore') {
      if (op.restore) {
        const snapshot = cloneDoc(op.restore.snapshot)
        document.title = snapshot.title
        document.subtitle = snapshot.subtitle
        document.targetDuration = snapshot.targetDuration
        document.characters = snapshot.characters
        document.soundEffects = snapshot.soundEffects
        document.scenes = snapshot.scenes
      }
      // 还原后所有未决冲突以“被还原取代”关闭，轨道 epoch 重置
      for (const conflict of conflicts) {
        if (conflict.open) {
          conflict.open = false
          conflict.supersedeReason = '文档已还原为历史版本，此冲突被取代'
          conflict.closedAt = op.ts
        }
      }
      tracks.clear()
      continue
    }
    if (op.type === 'resolve') {
      applyResolution(document, tracks, conflicts, op, opsById)
      continue
    }
    if (op.type === 'confirm') continue

    const payload = op.edit!
    const key = trackKeyOf(payload)
    let track = tracks.get(key)
    if (!track) {
      // 新轨道以“该编辑发出前已见到的编辑向量”为 epoch 起点（扣掉本编辑自身）
      const seen = editClockOf(op)
      const seed: Op['clock'] = { ...seen, [op.peerId]: Math.max((seen[op.peerId] ?? 0) - 1, 0) }
      track = { key, base: findEntity(document, key), epochEditClock: seed, branches: [] }
      tracks.set(key, track)
    }

    // 主文档先应用该操作（“最后写入”工作视图）；冲突时双方内容同时保存在冲突快照里，不会互相吞掉
    applyEdit(document, payload)

    // 该操作的作者分支：分支身份固定为 peer，绝不随快进改名（否则会把两窗口的修改算到同一边）
    let branch = track.branches.find((b) => b.peerId === op.peerId)
    if (!branch) {
      branch = { peerId: op.peerId, tip: op, editIds: [], firstTs: op.ts }
      track.branches.push(branch)
    }
    branch.tip = op
    if (!branch.editIds.includes(op.id)) branch.editIds.push(op.id)

    // 冲突检测只用“编辑时钟”在 epoch 之后的增量：裁决/确认/冻结不推进编辑时钟，
    // 因此裁决后两边各自的新修改会被正确识别为并发，而裁决前已并入的历史不会重复触发冲突
    const relOf = (tip: Op) => relativeEditClock(editClockOf(tip), track!.epochEditClock)
    const relOp = relOf(op)
    const concurrentBranches = track.branches.filter((b) => b !== branch && concurrent(relOf(b.tip), relOp))

    if (concurrentBranches.length > 0 && !track.openConflictId) {
      conflictSeq += 1
      const target = targetOf(payload)
      // 侧边顺序确定：导演优先，其次按首条编辑时间、peerId，保证两窗口左右一致
      const roleRank = (b: Branch) => (b.tip.peerRole === 'director' ? 0 : 1)
      const activeBranches = [branch, ...concurrentBranches].sort(
        (x, y) => roleRank(x) - roleRank(y) || x.firstTs.localeCompare(y.firstTs) || x.peerId.localeCompare(y.peerId)
      )
      const sides: ConflictSide[] = activeBranches.map((b) => {
        const sideOps = b.editIds.map((id) => ops.find((o) => o.id === id)!).filter(Boolean)
        const firstOp = sideOps[0]
        return {
          peerId: b.peerId,
          peerName: firstOp?.peerName ?? b.peerId,
          peerRole: firstOp?.peerRole ?? 'writer',
          editIds: [...b.editIds],
          firstTs: b.firstTs,
          summary: sideOps.map((o) => editSummary(o.edit!)),
          snapshot: branchSnapshot(track!.base, target, sideOps.map((o) => o.edit!))
        }
      })
      const hasDelete = activeBranches.some((b) => b.editIds.some((id) => ops.find((o) => o.id === id)?.edit?.edit === 'delete'))
      const isOrder = target.kind === 'scene-order' || target.kind === 'cue-order'
      const conflict: Conflict = {
        id: `conflict-${String(conflictSeq).padStart(3, '0')}`,
        trackKey: key,
        target: target.kind,
        targetId: 'id' in target ? target.id : undefined,
        containerId: 'containerId' in target ? target.containerId : undefined,
        type: isOrder ? 'order' : hasDelete ? 'delete' : 'update',
        entityLabel: entityLabel(document, target),
        open: true,
        openedAt: op.ts,
        sides
      }
      conflicts.push(conflict)
      track.openConflictId = conflict.id
    } else if (track.openConflictId) {
      // 冲突未决期间任一方继续编辑：刷新对应分支的最新内容，两份始终同时保留
      const conflict = conflicts.find((c) => c.id === track.openConflictId)
      if (conflict) {
        for (const side of conflict.sides) {
          const b = track.branches.find((bb) => bb.peerId === side.peerId)
          if (!b) continue
          const sideOps = b.editIds.map((id) => ops.find((o) => o.id === id)!).filter(Boolean)
          side.editIds = [...b.editIds]
          side.summary = sideOps.map((o) => editSummary(o.edit!))
          side.firstTs = b.firstTs
          side.snapshot = branchSnapshot(track.base, targetOf(payload), sideOps.map((o) => o.edit!))
        }
      }
    }

    if (!track.openConflictId) {
      // 删除已被当前编辑因果包含的旧分支（例如重连后并入对方历史）。
      // 注意：只剩一个分支时也不能把 epoch 推进到它——离线对端可能仍有基于旧状态的并发编辑在途中。
      track.branches = track.branches.filter((b) => b === branch || concurrent(relOf(b.tip), relOp))
    }
  }

  return { document, tracks, conflicts }
}

/** 从共同祖先按某一分支的编辑序列重放出版本快照（顺序轨道取该分支最后一次 order） */
function branchSnapshot(base: unknown, target: TrackTarget, edits: EditPayload[]): unknown {
  if (target.kind === 'project') {
    const result = (base && typeof base === 'object' ? cloneValue(base) : {}) as Record<string, unknown>
    for (const edit of edits) for (const change of edit.changes ?? []) result[change.field] = change.to
    return result
  }
  if (target.kind === 'scene-order' || target.kind === 'cue-order') {
    const last = edits.filter((e) => e.edit === 'reorder').pop()
    if (last) return [...(last.order ?? [])]
    return Array.isArray(base) ? [...(base as string[])] : []
  }
  return replayEntity(base, target, edits)
}


function replayEntity(base: unknown, target: TrackTarget, edits: EditPayload[]): unknown {
  let value: unknown = base === null ? null : cloneValue(base)
  if (target.kind === 'cue') {
    for (const edit of edits) {
      if (edit.edit === 'add') {
        value = cloneValue(edit.item)
      } else if (edit.edit === 'delete') {
        value = null
      } else if (value && edit.edit === 'update') {
        patchFields(value, edit.changes ?? [])
      }
    }
    return value
  }
  for (const edit of edits) {
    if (edit.edit === 'add') value = cloneValue(edit.item)
    else if (edit.edit === 'delete') value = null
    else if (value) patchFields(value, edit.changes ?? [])
  }
  return value
}

function applyResolution(
  document: StudioDocument,
  tracks: Map<string, Track>,
  conflicts: Conflict[],
  op: Op,
  opsById: Map<string, Op>
): void {
  const conflict = conflicts.find((c) => c.id === op.resolve!.conflictId)
  if (!conflict || !conflict.open) return
  const track = tracks.get(conflict.trackKey)
  const choice = op.resolve!.choice
  conflict.open = false
  conflict.closedAt = op.ts
  conflict.resolution = {
    choice,
    winningPeerId: choice === 'keep-both' ? undefined : conflict.sides[choice === 'a' ? 0 : 1]?.peerId,
    by: op.peerId,
    byName: op.peerName,
    at: op.ts
  }
  if (track) track.openConflictId = undefined

  const applyChoice = (): void => {
    if (choice === 'keep-both' && conflict.target === 'cue') {
      // 相同提示项两边都改：两份内容都保留进场次，交导演选用，谁也不覆盖谁
      conflict.sides.forEach((side, sideIndex) => {
        const snap = side.snapshot
        if (!snap || typeof snap !== 'object') return
        const cue = snap as Cue
        const scene = document.scenes.find((s) => s.id === conflict.containerId)
        if (!scene) return
        const existing = scene.cues.find((c) => c.id === cue.id)
        if (sideIndex === 0) {
          if (existing) Object.assign(existing, cloneDoc(cue))
          else scene.cues.push(cloneDoc(cue))
        } else {
          const copy = cloneDoc(cue)
          if (existing) {
            copy.id = `${cue.id}-dup-${side.peerId.slice(0, 4)}`
            copy.text = `${copy.text}（${side.peerName}版）`
          }
          if (!scene.cues.some((c) => c.id === copy.id)) scene.cues.push(copy)
        }
      })
      return
    }

    if (choice === 'keep-both') return

    const side = conflict.sides[choice === 'a' ? 0 : 1]
    if (!side) return
    const snap = side.snapshot

    if (conflict.target === 'project' && snap && typeof snap === 'object') {
      Object.assign(document, snap)
      return
    }
    if (conflict.target === 'character') {
      if (!snap) document.characters = document.characters.filter((c) => c.id !== conflict.targetId)
      else {
        const idx = document.characters.findIndex((c) => c.id === conflict.targetId)
        if (idx >= 0) document.characters[idx] = cloneDoc(snap as never)
        else document.characters.push(cloneDoc(snap as never))
      }
      return
    }
    if (conflict.target === 'sfx') {
      if (!snap) document.soundEffects = document.soundEffects.filter((c) => c.id !== conflict.targetId)
      else {
        const idx = document.soundEffects.findIndex((c) => c.id === conflict.targetId)
        if (idx >= 0) document.soundEffects[idx] = cloneDoc(snap as never)
        else document.soundEffects.push(cloneDoc(snap as never))
      }
      return
    }
    if (conflict.target === 'scene') {
      if (!snap) document.scenes = document.scenes.filter((c) => c.id !== conflict.targetId)
      else {
        const idx = document.scenes.findIndex((c) => c.id === conflict.targetId)
        if (idx >= 0) document.scenes[idx] = cloneDoc(snap as never)
        else document.scenes.push(cloneDoc(snap as never))
      }
      return
    }
    if (conflict.target === 'cue') {
      const scene = document.scenes.find((s) => s.id === conflict.containerId)
      if (!scene) return
      if (!snap) {
        scene.cues = scene.cues.filter((c) => c.id !== conflict.targetId)
      } else {
        const idx = scene.cues.findIndex((c) => c.id === conflict.targetId)
        if (idx >= 0) scene.cues[idx] = cloneDoc(snap as never)
        else scene.cues.push(cloneDoc(snap as never))
      }
      return
    }
    if (conflict.target === 'scene-order') {
      reorderByIds(document.scenes as { id: string }[], (snap as string[]) ?? [])
      return
    }
    if (conflict.target === 'cue-order') {
      const scene = document.scenes.find((s) => s.id === conflict.containerId)
      if (scene) reorderByIds(scene.cues as { id: string }[], (snap as string[]) ?? [])
    }
  }

  applyChoice()

  if (track) {
    // 裁决后该轨道进入新 epoch：以裁决后的实体状态为共同祖先、双方已并入的编辑向量为基线，
    // 清空分支历史；之后两边各自的新修改按编辑时钟重新判定并发，不会复活旧冲突
    let baseline: Op['clock'] = { ...track.epochEditClock }
    // 两边分支已知编辑向量的并集 = 裁决时刻已并入的全部编辑；之后各自的新编辑相对它判定并发
    for (const side of conflict.sides) {
      for (const editId of side.editIds) {
        const sideOp = opsById.get(editId)
        if (sideOp) baseline = mergeClock(baseline, editClockOf(sideOp))
      }
    }
    track.base = findEntity(document, conflict.trackKey)
    track.epochEditClock = baseline
    track.branches = []
  }
}


/* ====================== 确认记录 / 冻结来源派生 ====================== */

export function deriveRecords(ops: Op[], reduced: ReducedState): ChangeRecord[] {
  const edits = ops.filter((o): o is Op => o.type === 'edit')
  const resolvedMap = new Map<string, { conflict: import('./types').Conflict; op: Op }>()
  for (const conflict of reduced.conflicts) {
    const op = ops.find((o) => o.type === 'resolve' && o.resolve?.conflictId === conflict.id)
    if (op) for (const editId of conflict.sides.flatMap((s) => s.editIds)) resolvedMap.set(editId, { conflict, op })
  }
  const confirmByEdit = new Map<string, Op>()
  for (const op of ops.filter((o) => o.type === 'confirm')) {
    for (const id of op.confirm!.editIds) if (!confirmByEdit.has(id)) confirmByEdit.set(id, op)
  }
  // 当前血统起点：最后一次 restore
  let lineageSince = ''
  for (const op of ops) if (op.type === 'restore') lineageSince = op.ts

  const records: ChangeRecord[] = []
  for (const op of edits) {
    const payload = op.edit!
    const resolution = resolvedMap.get(op.id)
    const confirm = confirmByEdit.get(op.id)
    let status: ChangeRecord['status'] = 'pending'
    if (resolution) {
      const { conflict } = resolution
      if (conflict.supersedeReason) status = 'superseded'
      else if (conflict.resolution?.choice === 'keep-both') status = 'accepted'
      else {
        const winner = conflict.sides[conflict.resolution!.choice === 'a' ? 0 : 1]
        status = winner.editIds.includes(op.id) ? 'accepted' : 'superseded'
      }
    } else if (confirm) {
      status = confirm.confirm!.decision
    }
    records.push({
      id: op.id,
      editIds: [op.id],
      label: op.label,
      peerName: op.peerName,
      peerRole: op.peerRole,
      ts: op.ts,
      target: payload.target,
      targetId: payload.targetId,
      containerId: payload.containerId,
      kind: payload.edit,
      status,
      conflictId: resolution?.conflict.id,
      changes: payload.changes,
      decidedByName: confirm?.peerName ?? resolution?.op.peerName,
      decidedAt: confirm?.ts ?? resolution?.op.ts,
      decisionReason: confirm?.confirm?.reason,
      inLineage: !lineageSince || op.ts > lineageSince
    })
  }
  return records
}

export function openConflicts(reduced: ReducedState): import('./types').Conflict[] {
  return reduced.conflicts.filter((c) => c.open)
}

/** 归约一份操作日志并取每个编辑在给定时刻的确认状态（供冻结来源判断，不依赖实时投影） */
export function statusesAt(ops: Op[]): Map<string, ChangeRecord['status']> {
  const reduced = reduceLog(ops)
  return new Map(deriveRecords(ops, reduced).map((r) => [r.id, r.status]))
}

export function deriveFrozenVersions(ops: Op[], computeDuration: (doc: StudioDocument) => number): FrozenVersion[] {
  const versions: FrozenVersion[] = []
  const restores = ops.filter((o) => o.type === 'restore')
  for (const op of ops.filter((o) => o.type === 'freeze')) {
    const payload = op.freeze!
    const lastRestore = restores.filter((r) => r.ts < op.ts).pop()
    // 冻结时的确认状态：只把真正进入制作稿内容的编辑列为来源（已退回 / 冲突未被采用的不计）
    const statusAtFreeze = statusesAt(ops.filter((o) => o.ts <= op.ts))
    const sources: FrozenSource[] = []
    for (const editOp of ops.filter((o) => o.type === 'edit' && o.ts < op.ts)) {
      if (lastRestore && editOp.ts <= lastRestore.ts) continue
      const status = statusAtFreeze.get(editOp.id) ?? 'pending'
      if (status === 'rejected' || status === 'superseded') continue
      sources.push({ editId: editOp.id, label: editOp.label, peerName: editOp.peerName, peerRole: editOp.peerRole, ts: editOp.ts })
    }
    versions.push({
      id: payload.versionId,
      name: payload.name,
      createdAt: op.ts,
      frozenByName: op.peerName,
      frozenByRole: op.peerRole,
      document: cloneDoc(payload.snapshot),
      totalDuration: computeDuration(payload.snapshot),
      sources
    })
  }
  return versions
}

/* ============================== 时长 / 检查 ============================== */

export function durationOfCue(doc: StudioDocument, cue: Cue): number {
  if (cue.manualDuration !== undefined) return cue.manualDuration
  if (cue.kind === 'sfx') return doc.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
  if (cue.kind === 'transition') return 3
  const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
  const effectiveRate = cue.rate || 1
  return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
}

export function durationOfScene(doc: StudioDocument, scene: Scene): number {
  return Number(scene.cues.reduce((total, cue) => total + durationOfCue(doc, cue), 0).toFixed(1))
}

export function totalDuration(doc: StudioDocument): number {
  return Number(doc.scenes.reduce((total, scene) => total + durationOfScene(doc, scene), 0).toFixed(1))
}

export function computeWarnings(doc: StudioDocument): WarningItem[] {
  const result: WarningItem[] = []
  for (const scene of doc.scenes) {
    const actorRoles = new Map<string, string[]>()
    for (const cue of scene.cues) {
      if (cue.kind === 'dialogue' && cue.characterId) {
        const character = doc.characters.find((item) => item.id === cue.characterId)
        if (character) {
          const roles = actorRoles.get(character.voiceActor) ?? []
          roles.push(character.name)
          actorRoles.set(character.voiceActor, roles)
        }
      }
      if (cue.kind === 'sfx' && cue.soundEffectId && !doc.soundEffects.some((effect) => effect.id === cue.soundEffectId)) {
        result.push({
          id: `missing-${cue.id}`,
          type: 'missing-sfx',
          level: 'error',
          sceneId: scene.id,
          cueId: cue.id,
          title: `${scene.code} 音效引用缺失`,
          detail: `“${cue.text}”引用了不存在的音效 ${cue.soundEffectId}。`
        })
      }
    }
    actorRoles.forEach((roles, actor) => {
      const uniqueRoles = [...new Set(roles)]
      if (uniqueRoles.length > 1) {
        result.push({
          id: `collision-${scene.id}-${actor}`,
          type: 'collision',
          level: 'error',
          sceneId: scene.id,
          title: `${scene.code} 角色撞场`,
          detail: `${actor} 同时为 ${uniqueRoles.join('、')} 配音；同场角色需拆分演员或调整台词。`
        })
      }
    })
    const sceneDuration = durationOfScene(doc, scene)
    if (sceneDuration > scene.durationLimit) {
      result.push({
        id: `over-${scene.id}`,
        type: 'over-time',
        level: 'warning',
        sceneId: scene.id,
        title: `${scene.code} 超出场次限额`,
        detail: `预计 ${sceneDuration.toFixed(1)} 秒，限额 ${scene.durationLimit} 秒，超出 ${(sceneDuration - scene.durationLimit).toFixed(1)} 秒。`
      })
    }
  }
  return result
}

/* ============================== 制作稿导出 ============================== */

export function makeScript(document: StudioDocument): string {
  const lines = [
    document.title,
    document.subtitle,
    `目标时长：${document.targetDuration} 秒`,
    '='.repeat(48),
    ''
  ]
  document.scenes.forEach((scene, sceneIndex) => {
    lines.push(`${scene.code}｜${scene.title}`)
    lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
    lines.push(`转场：${scene.transition}`)
    lines.push(`场次限额：${scene.durationLimit} 秒｜预计：${durationOfScene(document, scene)} 秒`)
    lines.push('-'.repeat(34))
    scene.cues.forEach((cue, cueIndex) => {
      const prefix = `${String(cueIndex + 1).padStart(2, '0')} [${durationOfCue(document, cue).toFixed(1)}s]`
      if (cue.kind === 'dialogue') {
        const role = document.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
        lines.push(`${prefix} ${role}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
        lines.push(`    ${cue.text}`)
      } else if (cue.kind === 'sfx') {
        const effect = document.soundEffects.find((item) => item.id === cue.soundEffectId)
        lines.push(`${prefix} 音效｜${cue.text}`)
        lines.push(`    文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
      } else {
        lines.push(`${prefix} 转场｜${cue.transition}｜${cue.text}`)
      }
    })
    if (sceneIndex < document.scenes.length - 1) lines.push('')
  })
  return lines.join('\n')
}
