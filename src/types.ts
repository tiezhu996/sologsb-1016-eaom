export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2

export interface Character {
  id: string
  name: string
  voiceActor: string
  color: string
}

export interface SoundEffect {
  id: string
  name: string
  duration: number
  source: string
  note: string
}

export interface Cue {
  id: string
  kind: CueKind
  characterId?: string
  text: string
  emotion: string
  rate: Rate
  soundEffectId?: string
  transition: string
  manualDuration?: number
}

export interface Scene {
  id: string
  code: string
  title: string
  location: string
  timeOfDay: string
  transition: string
  durationLimit: number
  cues: Cue[]
}

export interface StudioDocument {
  title: string
  subtitle: string
  targetDuration: number
  characters: Character[]
  soundEffects: SoundEffect[]
  scenes: Scene[]
}

/* ------------------------------------------------------------------ */
/* 协作模型：两个浏览器窗口（导演 / 编剧）基于操作日志合并               */
/* ------------------------------------------------------------------ */

export type Role = 'director' | 'writer'

/** 向量时钟：peerId -> 该窗口已见的最新序号 */
export type Clock = Record<string, number>

export type TargetKind = 'project' | 'character' | 'sfx' | 'scene' | 'cue'
export type EditKind = 'add' | 'update' | 'delete' | 'reorder'
export type ChangeStatus = 'pending' | 'accepted' | 'rejected' | 'superseded'

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}

/** 一条文档编辑操作的载荷。add/delete 携带完整 item 快照，reorder 携带新旧顺序，保证可确定性重放/回退。 */
export interface EditPayload {
  target: TargetKind
  /** 被编辑实体 id（project 无；cue 编辑时为 cue id） */
  targetId?: string
  /** cue 所属场次 id */
  containerId?: string
  edit: EditKind
  changes?: FieldChange[]
  /** add/delete 时的完整实体快照（scene 删除时含全部 cues） */
  item?: unknown
  index?: number
  /** reorder 目标顺序与原顺序（id 列表） */
  order?: string[]
  fromOrder?: string[]
}

export interface ConfirmPayload {
  editIds: string[]
  decision: Extract<ChangeStatus, 'accepted' | 'rejected'>
  reason?: string
}

export interface ResolvePayload {
  conflictId: string
  choice: 'a' | 'b' | 'keep-both'
}

export interface FreezePayload {
  versionId: string
  name: string
  snapshot: StudioDocument
}

export interface RestorePayload {
  snapshot: StudioDocument
  /** 冻结版本 id，或 'sample' */
  sourceVersionId?: string
  reason?: string
}

export type OpType = 'edit' | 'confirm' | 'resolve' | 'freeze' | 'restore'

export interface Op {
  id: string
  peerId: string
  peerName: string
  peerRole: Role
  seq: number
  clock: Clock
  /**
   * 创作该操作时的“编辑向量时钟”：每个窗口已发出的 edit 操作数量。
   * 与 clock 分离——裁决/确认/冻结不推进它，因此冲突解决后两边各自的新编辑仍能被正确判为并发。
   */
  editClock: Clock
  ts: string
  type: OpType
  label: string
  edit?: EditPayload
  confirm?: ConfirmPayload
  resolve?: ResolvePayload
  freeze?: FreezePayload
  restore?: RestorePayload
}

export interface Identity {
  peerId: string
  name: string
  role: Role
}

/* ------------------------- 冲突 ------------------------- */

export interface ConflictSide {
  peerId: string
  peerName: string
  peerRole: Role
  editIds: string[]
  firstTs: string
  /** 该分支上各编辑操作的摘要 */
  summary: string[]
  /** 从共同祖先重放该分支全部操作后得到的实体快照（order 类为 string[]） */
  snapshot: unknown
}

export type ConflictType = 'update' | 'delete' | 'order'

export interface Conflict {
  id: string
  trackKey: string
  target: TargetKind | 'scene-order' | 'cue-order'
  targetId?: string
  containerId?: string
  type: ConflictType
  entityLabel: string
  open: boolean
  openedAt: string
  sides: ConflictSide[]
  closedAt?: string
  resolution?: {
    choice: 'a' | 'b' | 'keep-both'
    winningPeerId?: string
    by: string
    byName: string
    at: string
  }
  supersedeReason?: string
}

/* --------------------- 导演确认记录 --------------------- */

export interface ChangeRecord {
  id: string
  editIds: string[]
  label: string
  peerName: string
  peerRole: Role
  ts: string
  target: TargetKind
  targetId?: string
  containerId?: string
  kind: EditKind
  status: ChangeStatus
  conflictId?: string
  changes?: FieldChange[]
  decidedByName?: string
  decidedAt?: string
  decisionReason?: string
  /** 该编辑是否属于当前文档血统（最近一次 restore 之后） */
  inLineage: boolean
}

/* ------------------------- 冻结 ------------------------- */

export interface FrozenSource {
  editId: string
  label: string
  peerName: string
  peerRole: Role
  ts: string
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  frozenByName: string
  frozenByRole: Role
  document: StudioDocument
  totalDuration: number
  sources: FrozenSource[]
}

export interface WarningItem {
  id: string
  type: 'collision' | 'missing-sfx' | 'over-time'
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
}
