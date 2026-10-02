import assert from 'node:assert/strict'
import { sampleDocument } from '../src/sample'
import {
  applyOps,
  batchById,
  causalDescendants,
  clone,
  compareHlc,
  genId,
  KEY_MAX,
  KEY_MIN,
  midKey,
  reduce,
  resolveOps,
  reverseOps,
  tickHlc,
  type WorkingDocument
} from '../src/sync/merge'
import type { Batch, LogEvent, Op, Snapshot } from '../src/sync/types'

/* ---- 测试用事件构造器 ---- */
function makeBatch(opts: {
  clientId: string
  role: 'director' | 'writer'
  label: string
  ops: Op[]
  snapshots?: Snapshot[]
  base?: Record<string, string>
  hlc?: string
  batchType?: Batch['batchType']
}, clock: { perClient: Map<string, string> }, allEvents: LogEvent[]): Batch {
  const last = clock.perClient.get(opts.clientId)
  let remote: string | undefined
  for (const e of allEvents) {
    if (e.clientId !== opts.clientId && (!remote || compareHlc(e.hlc, remote) > 0)) remote = e.hlc
  }
  const hlc = opts.hlc ?? tickHlc(last, remote, opts.clientId)
  clock.perClient.set(opts.clientId, hlc)
  return {
    kind: 'batch',
    id: genId('batch'),
    hlc,
    clientId: opts.clientId,
    author: { role: opts.role, label: opts.role === 'director' ? '导演端' : `编剧 ${opts.clientId}` },
    at: new Date().toISOString(),
    batchType: opts.batchType ?? 'edit',
    label: opts.label,
    base: opts.base ?? {},
    ops: opts.ops,
    snapshots: opts.snapshots ?? []
  }
}

const clock = { perClient: new Map<string, string>() }
let events: LogEvent[] = []
const W1 = 'client-w1'
const W2 = 'client-w2'
const DIR = 'client-dir'
const cueId = sampleDocument.scenes[0].cues[1].id // cue-1-2 顾闻... 实际第二条 dialogue
const scene1 = sampleDocument.scenes[0].id
const scene2 = sampleDocument.scenes[1].id

function setCue(cue: string, field: string, value: unknown, before?: WorkingDocument['scenes'][number]['cues'][number]): Op[] {
  void before
  return [{ type: 'set', path: `cue/${cue}/${field}`, value }]
}

function cueSnap(cueId2: string, value: unknown, sceneId?: string): Snapshot {
  return { entity: 'cue', id: cueId2, sceneId, value }
}

/* 场景 1：同一提示项两边离线改不同字段 → 无冲突自动合并 */
{
  events = []
  clock.perClient.clear()
  const b1 = makeBatch({ clientId: W1, role: 'writer', label: '改情绪', ops: setCue(cueId, 'emotion', '愤怒') }, clock, events); events.push(b1)
  // W2 离线：base 为空，与 b1 并发
  const b2 = makeBatch({ clientId: W2, role: 'writer', label: '改台词', ops: setCue(cueId, 'text', '新台词内容'), base: {} }, clock, events); events.push(b2)
  const r = reduce(events, sampleDocument)
  const cue = r.document.scenes[0].cues.find((c) => c.id === cueId)!
  assert.equal(cue.emotion, '愤怒')
  assert.equal(cue.text, '新台词内容')
  assert.equal(r.conflicts.length, 0, '不同字段不应产生冲突')
  console.log('✓ 场景1：离线不同字段自动合并')
}

/* 场景 2：同一字段两边离线改 → 冲突，保留两份，未解决前不能冻结 */
{
  events = []
  clock.perClient.clear()
  const b1 = makeBatch({
    clientId: W1, role: 'writer', label: 'W1改台词',
    ops: setCue(cueId, 'text', 'W1的版本'),
    snapshots: [cueSnap(cueId, { id: cueId, text: 'W1的版本' }, scene1)]
  }, clock, events); events.push(b1)
  const b2 = makeBatch({
    clientId: W2, role: 'writer', label: 'W2改台词', base: {},
    ops: setCue(cueId, 'text', 'W2的版本'),
    snapshots: [cueSnap(cueId, { id: cueId, text: 'W2的版本' }, scene1)]
  }, clock, events); events.push(b2)
  const r = reduce(events, sampleDocument)
  assert.equal(r.conflicts.length, 1)
  const conflict = r.conflicts[0]
  assert.ok(conflict.fields.includes('text'))
  const clientIds = [conflict.sideA.clientId, conflict.sideB.clientId]
  assert.deepEqual(clientIds.sort(), [W1, W2].sort())
  const texts = [conflict.sideA.fallback.text, conflict.sideB.fallback.text]
  assert.ok(texts.includes('W1的版本') && texts.includes('W2的版本'), '两份内容都保留')
  assert.ok(!conflict.resolution)
  // 待确认批次为 2
  assert.equal(r.batches.filter((b) => b.status === 'pending').length, 2)

  // 导演裁决采用 W2：先恢复场次顺序无关，直接 resolve
  const work = clone(r.document) as WorkingDocument
  const winnerSide = conflict.sideA.fallback.text === 'W2的版本' ? 'A' : 'B'
  const ops = resolveOps(conflict, winnerSide, work)
  const resolve: LogEvent = {
    kind: 'resolve', id: genId('resolve'), hlc: tickHlc(undefined, r.batches[0].hlc, DIR),
    clientId: DIR, author: { role: 'director', label: '导演端' }, at: new Date().toISOString(),
    conflictIds: [conflict.id], ops, winnerBatchId: winnerSide === 'A' ? conflict.sideA.batchId : conflict.sideB.batchId,
    label: '导演采用W2'
  }
  events.push(resolve)
  const r2 = reduce(events, sampleDocument)
  const cue = r2.document.scenes[0].cues.find((c) => c.id === cueId)!
  assert.equal(cue.text, 'W2的版本')
  assert.equal(r2.conflicts[0].resolution?.winnerBatchId, b2.id)
  console.log('✓ 场景2：同字段冲突双份保留，导演裁决后生效且记录来源')
}

/* 场景 3：一边删场次，另一边离线改场中提示项 → 冲突；保留方恢复场次 */
{
  events = []
  clock.perClient.clear()
  const deletedScene = clone(sampleDocument.scenes[1])
  const bDel = makeBatch({
    clientId: W1, role: 'writer', label: '删除S02',
    ops: [{ type: 'delete-scene', sceneId: scene2 }],
    snapshots: [{ entity: 'scene', id: scene2, value: deletedScene }]
  }, clock, events); events.push(bDel)
  const cueInS2 = sampleDocument.scenes[1].cues[1].id
  const bEdit = makeBatch({
    clientId: W2, role: 'writer', label: '改S02台词', base: {},
    ops: setCue(cueInS2, 'text', '离线改的台词'),
    snapshots: [cueSnap(cueInS2, { id: cueInS2, text: '离线改的台词' }, scene2)]
  }, clock, events); events.push(bEdit)
  const r = reduce(events, sampleDocument)
  assert.ok(r.conflicts.length >= 1, '应检测到跨实体冲突')
  const conflict = r.conflicts.find((c) => c.entityType === 'cue' && c.fields.includes('__deleted'))!
  assert.ok(conflict, '存在 cue __deleted 冲突')
  assert.ok(conflict.restoredScene, '带有被删场次快照')
  // 导演选择保留提示项（编辑方）
  const editSide = conflict.sideA.deleted === false ? 'A' : 'B'
  const work = clone(r.document) as WorkingDocument
  const ops = resolveOps(conflict, editSide, work)
  events.push({
    kind: 'resolve', id: genId('resolve'), hlc: tickHlc(undefined, undefined, DIR),
    clientId: DIR, author: { role: 'director', label: '导演端' }, at: new Date().toISOString(),
    conflictIds: [conflict.id], ops, label: '导演保留台词并恢复场次'
  })
  const r2 = reduce(events, sampleDocument)
  assert.ok(r2.document.scenes.some((s) => s.id === scene2), '场次被恢复')
  const cue = r2.document.scenes.find((s) => s.id === scene2)!.cues.find((c) => c.id === cueInS2)!
  assert.equal(cue.text, '离线改的台词')
  console.log('✓ 场景3：删场 vs 改词冲突，保留方恢复场次与内容')
}

/* 场景 4：退回不会拿旧状态覆盖并发新修改 */
{
  events = []
  clock.perClient.clear()
  // 共同基线：b0
  const b0 = makeBatch({ clientId: W1, role: 'writer', label: '初始改情绪', ops: setCue(cueId, 'emotion', '低沉') }, clock, events); events.push(b0)
  // W2 基于 b0 并发改台词
  const b1 = makeBatch({ clientId: W2, role: 'writer', label: '并发改台词', base: { [W1]: b0.hlc }, ops: setCue(cueId, 'text', '并发新台词') }, clock, events); events.push(b1)
  // 导演退回 b0（W1 的情绪修改）；b1 不是 b0 的因果后代（不同客户端），不应被级联
  const reject: LogEvent = {
    kind: 'decision', id: genId('decision'), hlc: tickHlc(undefined, b1.hlc, DIR),
    clientId: DIR, author: { role: 'director', label: '导演端' }, at: new Date().toISOString(),
    targetBatchId: b0.id, action: 'rejected'
  }
  events.push(reject)
  const r = reduce(events, sampleDocument)
  const cue = r.document.scenes[0].cues.find((c) => c.id === cueId)!
  assert.equal(cue.text, '并发新台词', '并发新修改必须保留')
  assert.equal(cue.emotion, sampleDocument.scenes[0].cues.find((c) => c.id === cueId)!.emotion, '退回的情绪修改还原为基线值')
  const viewB1 = r.batches.find((b) => b.id === b1.id)!
  assert.equal(viewB1.status, 'pending', '并发批次不被级联退回')
  console.log('✓ 场景4：退回不覆盖并发新修改')
}

/* 场景 5：同窗口离线后续修改是退回批次的因果后代 → 级联；更晚的离线后代保持待确认 */
{
  events = []
  clock.perClient.clear()
  const b1 = makeBatch({ clientId: W1, role: 'writer', label: 'W1-1', ops: setCue(cueId, 'emotion', 'A') }, clock, events); events.push(b1)
  // W1 离线继续，base 包含自己的 b1
  const b2 = makeBatch({ clientId: W1, role: 'writer', label: 'W1-2', base: { [W1]: b1.hlc }, ops: setCue(cueId, 'text', 'B') }, clock, events); events.push(b2)
  const descendants = causalDescendants(events, b1.id)
  assert.deepEqual(descendants, [b2.id])
  const reject: LogEvent = {
    kind: 'decision', id: genId('decision'), hlc: tickHlc(undefined, b2.hlc, DIR),
    clientId: DIR, author: { role: 'director', label: '导演端' }, at: new Date().toISOString(),
    targetBatchId: b1.id, action: 'rejected', revertedBatchIds: descendants
  }
  events.push(reject)
  // b3：退回决策之后，W1 仍离线，又基于 b2 改了语速（旧窗口不知道已被退回）
  const b3 = makeBatch({ clientId: W1, role: 'writer', label: 'W1-3离线迟到', base: { [W1]: b2.hlc }, ops: setCue(cueId, 'rate', 0.8) }, clock, events); events.push(b3)
  const r = reduce(events, sampleDocument)
  const cue = r.document.scenes[0].cues.find((c) => c.id === cueId)!
  assert.equal(cue.rate, 0.8, '迟到的离线修改仍然生效（不能被旧窗口/退回吞掉）')
  assert.equal(cue.emotion, sampleDocument.scenes[0].cues.find((c) => c.id === cueId)!.emotion)
  assert.equal(cue.text, sampleDocument.scenes[0].cues.find((c) => c.id === cueId)!.text)
  const v3 = r.batches.find((b) => b.id === b3.id)!
  assert.equal(v3.status, 'pending', '迟到批次进入待确认')
  assert.ok(v3.rejectedAncestorId, '标记其祖先已被退回')
  console.log('✓ 场景5：离线迟到修改不被旧窗口覆盖，进入待确认并标记退回祖先')
}

/* 场景 6：顺序并发调整用分数键自动合并 */
{
  events = []
  clock.perClient.clear()
  const s = clone(sampleDocument) as WorkingDocument
  for (const sc of s.scenes) {
    sc.__ok = midKey(KEY_MIN, KEY_MAX) + s.scenes.indexOf(sc).toString(36).padStart(2, '0')
    sc.cues.forEach((c, i) => { ;(c as WorkingDocument['scenes'][number]['cues'][number]).__ok = midKey(KEY_MIN, KEY_MAX) + i.toString(36).padStart(2, '0') })
  }
  // W1 把 S03 移到 S01 前；W2 离线把 S02 移到 S03 后
  const ids = s.scenes.map((x) => x.id)
  const keyS01 = s.scenes[0].__ok!
  const keyS02 = s.scenes[1].__ok!
  const keyS03 = s.scenes[2].__ok!
  const b1 = makeBatch({ clientId: W1, role: 'writer', label: 'S03置顶', base: {}, ops: [{ type: 'move-scene', sceneId: ids[2], orderKey: midKey(KEY_MIN, keyS01) }] }, clock, events); events.push(b1)
  const b2 = makeBatch({ clientId: W2, role: 'writer', label: 'S02置底', base: {}, ops: [{ type: 'move-scene', sceneId: ids[1], orderKey: midKey(keyS03, KEY_MAX) }] }, clock, events); events.push(b2)
  const r = reduce(events, sampleDocument)
  const order = r.document.scenes.map((x) => x.id)
  assert.equal(order[0], ids[2], 'S03 在最前')
  assert.equal(order[2], ids[1], 'S02 在最后')
  assert.equal(r.conflicts.length, 0, '两个不同对象的排序不冲突')
  console.log('✓ 场景6：并发场次拖动自动合并')
}

/* 场景 7：撤销/退回的逆向操作在单客户端链上正确 */
{
  events = []
  clock.perClient.clear()
  const before = clone(sampleDocument.scenes[0].cues.find((c) => c.id === cueId)!)
  const b1 = makeBatch({
    clientId: W1, role: 'writer', label: '改情绪',
    ops: setCue(cueId, 'emotion', '狂喜'),
    snapshots: [{ entity: 'cue', id: cueId, sceneId: scene1, value: before }]
  }, clock, events); events.push(b1)
  const ops = reverseOps(b1)
  const bUndo = makeBatch({ clientId: W1, role: 'writer', label: '撤销', ops, batchType: 'undo', base: { [W1]: b1.hlc } }, clock, events); events.push(bUndo)
  const work = clone(sampleDocument) as WorkingDocument
  applyOps(work, b1.ops)
  applyOps(work, bUndo.ops)
  const cue = work.scenes[0].cues.find((c) => c.id === cueId)!
  assert.equal(cue.emotion, before.emotion)
  console.log('✓ 场景7：逆向批次正确还原字段')
}

/* 场景 8：冻结版本必须在无未决/无冲突时才可发生；冻结文档可溯源还原 */
{
  events = []
  clock.perClient.clear()
  const b1 = makeBatch({ clientId: W1, role: 'writer', label: '改情绪', ops: setCue(cueId, 'emotion', '狂喜') }, clock, events); events.push(b1)
  const beforeAccept = reduce(events, sampleDocument)
  assert.equal(beforeAccept.batches.filter((x) => x.status === 'pending').length, 1, '有未决批次')

  // 导演接受后再冻结
  events.push({
    kind: 'decision', id: genId('decision'), hlc: tickHlc(undefined, b1.hlc, DIR),
    clientId: DIR, author: { role: 'director', label: '导演端' }, at: new Date().toISOString(),
    targetBatchId: b1.id, action: 'accepted'
  })
  const accepted = reduce(events, sampleDocument)
  assert.equal(accepted.batches.filter((x) => x.status === 'pending').length, 0)
  const frozenDoc = clone(accepted.document)
  const freezeEvent: LogEvent = {
    kind: 'freeze', id: genId('freeze'), hlc: tickHlc(undefined, undefined, DIR),
    clientId: DIR, author: { role: 'director', label: '导演端' }, at: new Date().toISOString(),
    name: '制作稿 v1', document: frozenDoc, totalDuration: 42
  }
  events.push(freezeEvent)
  // 冻结之后又改了情绪（基于已接受的 b1，是因果后续修改）
  const b2 = makeBatch({ clientId: W2, role: 'writer', label: '再改情绪', base: { [W1]: b1.hlc }, ops: setCue(cueId, 'emotion', '平静') }, clock, events); events.push(b2)
  let r = reduce(events, sampleDocument)
  assert.equal(r.document.scenes[0].cues.find((c) => c.id === cueId)!.emotion, '平静')
  assert.equal(r.frozen[0].name, '制作稿 v1')
  assert.equal(r.frozen[0].document.scenes[0].cues.find((c) => c.id === cueId)!.emotion, '狂喜', '冻结快照不可变')

  // 还原已接受的确认记录：重新应用 b1 的原始操作（溯源到来源批次）
  const source = batchById(events, b1.id)!
  events.push(makeBatch({
    clientId: DIR, role: 'director', label: '还原确认记录',
    base: { [W1]: b1.hlc, [W2]: b2.hlc },
    ops: clone(source.ops), snapshots: clone(source.snapshots), batchType: 'restore'
  }, clock, events))
  r = reduce(events, sampleDocument)
  assert.equal(r.document.scenes[0].cues.find((c) => c.id === cueId)!.emotion, '狂喜', '还原后内容回到来源批次')
  console.log('✓ 场景8：冻结快照不可变，确认记录可还原到来源')
}

/* 场景 9：冲突未处理完不得导出；一侧被退回时冲突自动关闭并采纳另一侧 */
{
  events = []
  clock.perClient.clear()
  const b1 = makeBatch({
    clientId: W1, role: 'writer', label: 'W1改台词',
    ops: setCue(cueId, 'text', 'W1版'),
    snapshots: [cueSnap(cueId, { id: cueId, text: 'W1版' }, scene1)]
  }, clock, events); events.push(b1)
  const b2 = makeBatch({
    clientId: W2, role: 'writer', label: 'W2改台词', base: {},
    ops: setCue(cueId, 'text', 'W2版'),
    snapshots: [cueSnap(cueId, { id: cueId, text: 'W2版' }, scene1)]
  }, clock, events); events.push(b2)
  let r = reduce(events, sampleDocument)
  assert.equal(r.conflicts.length, 1)
  assert.ok(!r.conflicts[0].resolution, '未处理冲突保持打开')

  // 导演退回 W1 一侧：冲突应自动关闭，文档采纳 W2
  events.push({
    kind: 'decision', id: genId('decision'), hlc: tickHlc(undefined, b2.hlc, DIR),
    clientId: DIR, author: { role: 'director', label: '导演端' }, at: new Date().toISOString(),
    targetBatchId: b1.id, action: 'rejected'
  })
  r = reduce(events, sampleDocument)
  assert.equal(r.conflicts[0].resolution?.auto, 'rejected-side')
  assert.equal(r.conflicts[0].resolution?.winnerBatchId, b2.id)
  const cue = r.document.scenes[0].cues.find((c) => c.id === cueId)!
  assert.equal(cue.text, 'W2版', '未退回一侧内容生效')
  console.log('✓ 场景9：一侧退回自动关闭冲突并采纳另一侧')
}

/* 场景 10：离线连续打字产生多个批次 vs 远端一次修改 → 只有一条冲突，且候选是各端最终值 */
{
  events = []
  clock.perClient.clear()
  const remote = makeBatch({
    clientId: W2, role: 'writer', label: '远端整句替换', base: {},
    ops: setCue(cueId, 'text', '远端完整句子'),
    snapshots: [cueSnap(cueId, { id: cueId, text: '远端完整句子' }, scene1)]
  }, clock, events); events.push(remote)
  // 本端离线逐字改三次（每次快照的是修改前），均与 remote 并发
  let lastBase = '船晚点了。楼下有人说，这几天一直有人在找你。'
  const steps = ['船，晚点了', '船晚点了。', '船晚点了，别急。']
  for (let i = 0; i < steps.length; i += 1) {
    const b = makeBatch({
      clientId: W1, role: 'writer', label: `打字 ${i + 1}`, base: {},
      ops: setCue(cueId, 'text', steps[i]),
      snapshots: [cueSnap(cueId, { id: cueId, text: i === 0 ? lastBase : steps[i - 1] }, scene1)]
    }, clock, events)
    events.push(b)
    lastBase = steps[i]
  }
  const r = reduce(events, sampleDocument)
  const cueConflicts = r.conflicts.filter((c) => c.entityId === cueId && c.fields.includes('text'))
  assert.equal(cueConflicts.length, 1, `连续打字只能产生一条冲突，实际 ${cueConflicts.length}`)
  const conflict = cueConflicts[0]
  const texts = [conflict.sideA.fallback.text, conflict.sideB.fallback.text]
  assert.ok(texts.includes('船晚点了，别急。'), '本端候选必须是最终值而非中间快照')
  assert.ok(texts.includes('远端完整句子'), '远端候选必须是最终值')

  // 裁决采用本端最终值（resolve 的 HLC 高于全部冲突批次）
  const side = conflict.sideA.fallback.text === '船晚点了，别急。' ? 'A' : 'B'
  const work = clone(r.document) as WorkingDocument
  const maxConflictHlc = [conflict.sideA.hlc, conflict.sideB.hlc].sort(compareHlc)[1]
  const resolve: LogEvent = {
    kind: 'resolve', id: genId('resolve'), hlc: tickHlc(undefined, maxConflictHlc, DIR),
    clientId: DIR, author: { role: 'director', label: '导演端' }, at: new Date().toISOString(),
    conflictIds: [conflict.id], ops: resolveOps(conflict, side, work),
    winnerBatchId: side === 'A' ? conflict.sideA.batchId : conflict.sideB.batchId,
    label: '导演采用本端终稿'
  }
  events.push(resolve)
  const r2 = reduce(events, sampleDocument)
  const cue = r2.document.scenes[0].cues.find((c) => c.id === cueId)!
  assert.equal(cue.text, '船晚点了，别急。')
  assert.equal(r2.conflicts.find((c) => c.id === conflict.id)!.resolution?.label, '导演采用本端终稿')
  console.log('✓ 场景10：打字风暴合并为一条冲突，候选内容为各端最终值')
}

void applyOps
void reverseOps
void genId
void midKey
void KEY_MAX
void KEY_MIN
void resolveOps
console.log('\n全部合并核心测试通过')
