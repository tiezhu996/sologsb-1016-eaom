import type { Character, Cue, Scene, SoundEffect, StudioDocument } from '../types'

export type Role = 'director' | 'writer'

export interface Identity {
  clientId: string
  role: Role
  label: string
  createdAt: string
}

/** 内部字段路径：project/<f> · scene/<id>/<f> · cue/<id>/<f> · char/<id> · fx/<id> */
export type Op =
  | { type: 'set'; path: string; value: unknown }
  | { type: 'add-char'; entity: Character }
  | { type: 'add-fx'; entity: SoundEffect }
  | { type: 'add-scene'; entity: Scene }
  | { type: 'add-cue'; entity: Cue; sceneId: string }
  | { type: 'delete-scene'; sceneId: string }
  | { type: 'delete-cue'; cueId: string }
  | { type: 'move-cue'; cueId: string; sceneId: string; orderKey: string }
  | { type: 'move-scene'; sceneId: string; orderKey: string }

export type BatchType = 'genesis' | 'edit' | 'undo' | 'revert' | 'restore'

export interface Snapshot {
  entity: 'project' | 'scene' | 'cue' | 'char' | 'fx'
  id: string
  /** project 为 {title,subtitle,targetDuration}；scene/cue 为修改前的完整实体 */
  value?: unknown
  deleted?: boolean
  sceneId?: string
  /** cue/scene 被修改前的分数排序键 */
  orderKey?: string
}

interface EventBase {
  id: string
  hlc: string
  clientId: string
  author: { role: Role; label: string }
  at: string
}

export interface Batch extends EventBase {
  kind: 'batch'
  batchType: BatchType
  label: string
  note?: string
  /** 发起时看到的各客户端最后批次：用于判定并发关系 */
  base: Record<string, string>
  ops: Op[]
  snapshots: Snapshot[]
  /** revert 批次回退的目标批次 */
  revertsBatchId?: string
  /** restore 批次还原的来源批次 */
  restoresBatchId?: string
  /** 还原的冻结版本 */
  restoresFreezeId?: string
}

export interface ResolveEvent extends EventBase {
  kind: 'resolve'
  conflictIds: string[]
  ops: Op[]
  /** 采用的候选来源批次（混合采用时为空） */
  winnerBatchId?: string
  label: string
}

export interface DecisionEvent extends EventBase {
  kind: 'decision'
  targetBatchId: string
  action: 'accepted' | 'rejected'
  note?: string
  /** 退回较早批次时一并回滚的、因果上更新的未决批次 */
  revertedBatchIds?: string[]
}

export interface FreezeEvent extends EventBase {
  kind: 'freeze'
  name: string
  document: StudioDocument
  totalDuration: number
}

export type LogEvent = Batch | ResolveEvent | DecisionEvent | FreezeEvent

export interface ConflictCandidate {
  clientId: string
  batchId: string
  hlc: string
  label: string
  author: { role: Role; label: string }
  deleted: boolean
  snapshot?: Snapshot
  fallback: Record<string, unknown>
}

export interface ConflictResolution {
  eventId: string
  by: { role: Role; label: string }
  clientId: string
  at: string
  label: string
  winnerBatchId?: string
  /** 非导演显式裁决：其中一方的批次被退回，冲突自动关闭 */
  auto?: 'rejected-side'
}

export interface Conflict {
  id: string
  entityType: 'project' | 'scene' | 'cue'
  entityId: string
  sceneId?: string
  /** 冲突的相对字段名，如 text / __deleted / __order */
  fields: string[]
  sideA: ConflictCandidate
  sideB: ConflictCandidate
  /** 删场次 vs 改提示项冲突中，被删除场次的快照（保留方需要恢复场次） */
  restoredScene?: Snapshot
  resolution?: ConflictResolution
}

export interface Provenance {
  clientId: string
  batchId: string
  hlc: string
  label: string
  author: { role: Role; label: string }
  at: string
}

export type BatchStatus = 'pending' | 'accepted' | 'rejected'

export interface BatchView {
  id: string
  label: string
  note?: string
  batchType: BatchType
  hlc: string
  at: string
  clientId: string
  author: { role: Role; label: string }
  status: BatchStatus
  decisionBy?: { role: Role; label: string }
  decisionAt?: string
  revertsBatchId?: string
  restoresBatchId?: string
  restoresFreezeId?: string
  conflictIdsCreated: string[]
  /** 同窗口有已退回的祖先批次：离线旧窗口里的后续修改需要导演再次确认 */
  rejectedAncestorId?: string
}

export interface ReduceResult {
  document: StudioDocument
  /** 当前归约顺序下各场次/提示项的分数排序键 */
  orderKeys: { scenes: Record<string, string>; cues: Record<string, string> }
  conflicts: Conflict[]
  provenance: Record<string, Provenance>
  batches: BatchView[]
  frozen: FreezeEvent[]
}

export interface SyncPacket {
  app: 'sologsb-1016-sync'
  version: 2
  exportedAt: string
  identity: Identity
  events: LogEvent[]
  queues: Record<string, LogEvent[]>
}
