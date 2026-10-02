import { assert } from 'node:console'
import { clockBefore, concurrent, deriveFrozenVersions, deriveRecords, openConflicts, reduceLog, totalDuration, uid } from '../src/model'
import { sampleDocument } from '../src/sample'
import type { EditPayload, Identity, Op, StudioDocument } from '../src/types'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

const director: Identity = { peerId: 'peer-dir', name: '李导', role: 'director' }
const writer: Identity = { peerId: 'peer-wri', name: '王编', role: 'writer' }

function makeOp(
  who: Identity,
  seq: number,
  clock: Op['clock'],
  type: Op['type'],
  label: string,
  extra: Partial<Op>,
  ts: string,
  editClock?: Op['clock']
): Op {
  return {
    id: uid('op'),
    peerId: who.peerId,
    peerName: who.name,
    peerRole: who.role,
    seq,
    clock,
    editClock: editClock ?? clock,
    ts,
    type,
    label,
    ...extra
  } as Op
}

function editOp(who: Identity, seq: number, clock: Op['clock'], label: string, edit: EditPayload, ts: string, editCount?: number): Op {
  // 编辑操作的编辑向量：自己已发出的编辑数 + 时钟里已并入的对端编辑
  const editClock = { ...clock, [who.peerId]: editCount ?? seq }
  return makeOp(who, seq, clock, 'edit', label, { edit }, ts, editClock)
}

const cueId = sampleDocument.scenes[0].cues[1].id // cue-1-2 顾闻台词
const sceneId = sampleDocument.scenes[0].id

function textUpdate(value: string): EditPayload {
  return { target: 'cue', targetId: cueId, containerId: sceneId, edit: 'update', changes: [{ field: 'text', from: '旧', to: value }] }
}

/* ---------------- 1. 时钟基本性质 ---------------- */
console.log('clock math')
check('{} < {a:1}', clockBefore({}, { a: 1 }))
check('{a:1} 与 {b:1} 并发', concurrent({ a: 1 }, { b: 1 }))
check('{a:1} 与 {a:2} 不并发', !concurrent({ a: 1 }, { a: 2 }))
check('{a:1,b:1} 与 {a:2,b:1} 不并发', !concurrent({ a: 1, b: 1 }, { a: 2, b: 1 }))

/* ---------------- 2. 两边同改一项 → 冲突且两份保留 ---------------- */
console.log('\nconcurrent edit conflict')
{
  const ops = [
    editOp(director, 1, { 'peer-dir': 0 }, '导演改台词', textUpdate('导演版本'), '2026-10-02T10:00:01Z'),
    editOp(writer, 1, { 'peer-wri': 0 }, '编剧改台词', textUpdate('编剧版本'), '2026-10-02T10:00:02Z')
  ]
  const reduced = reduceLog(ops)
  const open = openConflicts(reduced)
  check('产生 1 个冲突', open.length === 1, `got ${open.length}`)
  const c = open[0]
  check('冲突有两个分支', c.sides.length === 2)
  check('保留导演版本内容', JSON.stringify(c.sides.some((s) => JSON.stringify(s.snapshot).includes('导演版本'))))
  check('保留编剧版本内容', JSON.stringify(c.sides.some((s) => JSON.stringify(s.snapshot).includes('编剧版本'))))
  check('存在未决冲突时禁止冻结', openConflicts(reduced).length > 0)
}

/* ---------------- 3. 离线重连：任一方先到结果一致 ---------------- */
console.log('\noffline reconnect ordering invariance')
{
  const a = editOp(director, 1, { 'peer-dir': 0 }, '导演改台词', textUpdate('导演离线版'), '2026-10-02T11:00:01Z')
  const b = editOp(writer, 1, { 'peer-wri': 0 }, '编剧改台词', textUpdate('编剧在线版'), '2026-10-02T11:00:05Z')
  const r1 = openConflicts(reduceLog([a, b]))
  const r2 = openConflicts(reduceLog([b, a]))
  check('两种到达顺序都检出冲突', r1.length === 1 && r2.length === 1)
  check('冲突 id 一致（确定性归约）', r1[0].id === r2[0].id, r1[0]?.id + ' vs ' + r2[0]?.id)
}

/* ---------------- 4. 旧窗口不能覆盖新修改（因果序） ---------------- */
console.log('\nstale window must not overwrite newer edit')
{
  // 编剧先改（b:1），导演窗口同步看到后再改（时钟包含 b:1）；离线旧副本迟到
  const writerFirst = editOp(writer, 1, { 'peer-wri': 0 }, '编剧新改', textUpdate('新内容'), '2026-10-02T12:00:00Z')
  const directorAfter = editOp(director, 1, { 'peer-dir': 0, 'peer-wri': 1 }, '导演基于新内容', textUpdate('导演再改'), '2026-10-02T12:00:10Z')
  const reduced = reduceLog([writerFirst, directorAfter])
  check('因果序编辑不产生冲突', openConflicts(reduced).length === 0)
  const cue = reduced.document.scenes[0].cues.find((c) => c.id === cueId)
  check('最终是更新的导演再改内容', cue?.text === '导演再改', cue?.text ?? '')
}

/* ---------------- 5. 裁决采用某一方 / 两边都保留 ---------------- */
console.log('\nresolution')
{
  const a = editOp(director, 1, { 'peer-dir': 0 }, '导演改', textUpdate('采用我'), '2026-10-02T13:00:01Z')
  const b = editOp(writer, 1, { 'peer-wri': 0 }, '编剧改', textUpdate('另一版'), '2026-10-02T13:00:02Z')
  let reduced = reduceLog([a, b])
  const conflictId = openConflicts(reduced)[0].id
  const resolve = makeOp(director, 2, { 'peer-dir': 1, 'peer-wri': 1 }, 'resolve', '导演裁决采用左版', {
    resolve: { conflictId, choice: 'a' }
  }, '2026-10-02T13:00:05Z')
  reduced = reduceLog([a, b, resolve])
  check('裁决后无未决冲突', openConflicts(reduced).length === 0)
  const cue = reduced.document.scenes[0].cues.find((c) => c.id === cueId)
  check('采用了左版（导演版）', cue?.text === '采用我', cue?.text ?? '')
  // 裁决之后两边又各自产生新的并发编辑：应当是“新冲突”，不会复活旧冲突，也不能漏报
  const a2 = editOp(director, 3, { 'peer-dir': 2, 'peer-wri': 1 }, '导演后续', textUpdate('导演后续'), '2026-10-02T13:01:00Z')
  const b2 = editOp(writer, 2, { 'peer-dir': 1, 'peer-wri': 1 }, '编剧后续', textUpdate('编剧后续'), '2026-10-02T13:01:01Z')
  const reduced2 = reduceLog([a, b, resolve, a2, b2])
  const open2 = openConflicts(reduced2)
  check('裁决后新分叉是独立新冲突', open2.length === 1, `got ${open2.length}`)
  check('新冲突保留两边后续内容', JSON.stringify(open2[0]?.sides ?? []).includes('导演后续') && JSON.stringify(open2[0]?.sides ?? []).includes('编剧后续'))
}
{
  const a = editOp(director, 1, { 'peer-dir': 0 }, '导演改', textUpdate('导演双留'), '2026-10-02T14:00:01Z')
  const b = editOp(writer, 1, { 'peer-wri': 0 }, '编剧改', textUpdate('编剧双留'), '2026-10-02T14:00:02Z')
  let reduced = reduceLog([a, b])
  const conflictId = openConflicts(reduced)[0].id
  const resolve = makeOp(director, 2, { 'peer-dir': 1, 'peer-wri': 1 }, 'resolve', '两边都留', {
    resolve: { conflictId, choice: 'keep-both' }
  }, '2026-10-02T14:00:05Z')
  reduced = reduceLog([a, b, resolve])
  const texts = reduced.document.scenes[0].cues.map((c) => c.text)
  check('两份内容都在场次里', texts.some((t) => t.includes('导演双留')) && texts.some((t) => t.includes('编剧双留')), JSON.stringify(texts))
  check('裁决后可冻结', openConflicts(reduced).length === 0)
}

/* ---------------- 6. 顺序冲突 ---------------- */
console.log('\nscene order conflict')
{
  const ids = sampleDocument.scenes.map((s) => s.id)
  const orderA = [ids[0], ids[2], ids[1]]
  const orderB = [ids[1], ids[0], ids[2]]
  const a = editOp(director, 1, { 'peer-dir': 0 }, '导演排顺序', { target: 'scene', edit: 'reorder', order: orderA, fromOrder: ids }, '2026-10-02T15:00:01Z')
  const b = editOp(writer, 1, { 'peer-wri': 0 }, '编剧排顺序', { target: 'scene', edit: 'reorder', order: orderB, fromOrder: ids }, '2026-10-02T15:00:02Z')
  const reduced = reduceLog([a, b])
  const open = openConflicts(reduced)
  check('排序并发产生顺序冲突', open.length === 1 && open[0].type === 'order')
}

/* ---------------- 7. 冻结来源与还原 ---------------- */
console.log('\nfreeze provenance & restore')
{
  const e1 = editOp(writer, 1, { 'peer-wri': 0 }, '编剧修改一', textUpdate('冻结前内容'), '2026-10-02T16:00:00Z')
  const reduced0 = reduceLog([e1])
  const snapshot: StudioDocument = JSON.parse(JSON.stringify(reduced0.document))
  const freeze = makeOp(director, 1, { 'peer-dir': 0, 'peer-wri': 1 }, 'freeze', '冻结 v1', {
    freeze: { versionId: 'ver-1', name: 'v1', snapshot }
  }, '2026-10-02T16:00:05Z')
  const e2 = editOp(writer, 2, { 'peer-dir': 1, 'peer-wri': 1 }, '编剧修改二', textUpdate('冻结后又改'), '2026-10-02T16:00:10Z')
  const ops = [e1, freeze, e2]
  const versions = deriveFrozenVersions(ops, totalDuration)
  check('冻结版本含来源编辑', versions.length === 1 && versions[0].sources.some((s) => s.editId === e1.id))
  check('冻结来源不包含冻结之后的修改', !versions[0].sources.some((s) => s.editId === e2.id))
  check('冻结快照记录冻结人角色', versions[0].frozenByRole === 'director')

  const restore = makeOp(director, 2, { 'peer-dir': 1, 'peer-wri': 2 }, 'restore', '还原 v1', {
    restore: { snapshot, sourceVersionId: 'ver-1' }
  }, '2026-10-02T16:00:20Z')
  const restored = reduceLog([...ops, restore])
  const cue = restored.document.scenes[0].cues.find((c) => c.id === cueId)
  check('还原后文档回到冻结快照内容', cue?.text === '冻结前内容', cue?.text ?? '')

  const records = deriveRecords([...ops, restore], restored)
  check('还原前的编辑被标记为不在当前血统', records.find((r) => r.id === e1.id)?.inLineage === false)
}

/* ---------------- 8. 退回（导演 reject）补偿 ---------------- */
console.log('\nreject compensation')
{
  const e = editOp(writer, 1, { 'peer-wri': 0 }, '编剧改了', textUpdate('待退回'), '2026-10-02T17:00:00Z')
  const undo: EditPayload = { ...e.edit!, changes: e.edit!.changes!.map((c) => ({ field: c.field, from: c.to, to: c.from })) }
  const comp = editOp(director, 1, { 'peer-dir': 0, 'peer-wri': 1 }, '退回：编剧改了', undo, '2026-10-02T17:00:05Z')
  const reject = makeOp(director, 2, { 'peer-dir': 1, 'peer-wri': 1 }, 'confirm', '导演退回', {
    confirm: { editIds: [e.id], decision: 'rejected' as const }
  }, '2026-10-02T17:00:06Z')
  const reduced = reduceLog([e, comp, reject])
  const cue = reduced.document.scenes[0].cues.find((c) => c.id === cueId)
  check('补偿编辑把内容确定性还原', cue?.text === '旧', cue?.text ?? '')
  const records = deriveRecords([e, comp, reject], reduced)
  check('原编辑记录状态为已退回', records.find((r) => r.id === e.id)?.status === 'rejected')
}

/* ---------------- 9. 真离线：两边各自连续改，重连后合并 ---------------- */
console.log('\noffline sequential edits then reconnect')
{
  const cueX = sampleDocument.scenes[0].cues[2].id // cue-1-3
  const tuX = (v: string): EditPayload => ({ target: 'cue', targetId: cueX, containerId: sceneId, edit: 'update', changes: [{ field: 'text', from: 'x', to: v }] })
  // 两边都从同一基线 {d:1,w:1} 离线，导演连改两条、编剧连改两条（编辑向量只反映自己的编辑）
  const d1 = editOp(director, 3, { 'peer-dir': 1, 'peer-wri': 1 }, '导演离线改1', tuX('导演A'), '2026-10-02T18:00:01Z', 2)
  const d2 = editOp(director, 4, { 'peer-dir': 1, 'peer-wri': 1 }, '导演离线改2', tuX('导演B'), '2026-10-02T18:00:02Z', 3)
  const w1 = editOp(writer, 3, { 'peer-dir': 1, 'peer-wri': 1 }, '编剧离线改1', tuX('编剧A'), '2026-10-02T18:00:03Z', 2)
  const w2 = editOp(writer, 4, { 'peer-dir': 1, 'peer-wri': 1 }, '编剧离线改2', tuX('编剧B'), '2026-10-02T18:00:04Z', 3)
  const reduced = reduceLog([d1, d2, w1, w2])
  const open = openConflicts(reduced)
  check('离线各自连改同一提示项 → 一个冲突', open.length === 1, `got ${open.length}`)
  const dirSide = open[0]?.sides.find((s) => s.peerRole === 'director')
  const wriSide = open[0]?.sides.find((s) => s.peerRole === 'writer')
  check('导演侧快照是其最后版本', JSON.stringify(dirSide?.snapshot).includes('导演B'))
  check('编剧侧快照是其最后版本', JSON.stringify(wriSide?.snapshot).includes('编剧B'))
}

/* ---------------- 10. 两边改不同提示项 → 干净合并，无冲突 ---------------- */
console.log('\ndifferent cues merge cleanly')
{
  const otherCue = sampleDocument.scenes[0].cues[2].id
  const upA = textUpdate('改第一条')
  const upB: EditPayload = { target: 'cue', targetId: otherCue, containerId: sceneId, edit: 'update', changes: [{ field: 'text', from: 'y', to: '改第二条' }] }
  const a = editOp(director, 1, { 'peer-dir': 0 }, '导演改', upA, '2026-10-02T19:00:01Z')
  const b = editOp(writer, 1, { 'peer-wri': 0 }, '编剧改', upB, '2026-10-02T19:00:02Z')
  const reduced = reduceLog([a, b])
  check('不同提示项不产生冲突', openConflicts(reduced).length === 0)
  check('两处修改都在合并文档里', reduced.document.scenes[0].cues.find((c) => c.id === cueId)?.text === '改第一条' &&
    reduced.document.scenes[0].cues.find((c) => c.id === otherCue)?.text === '改第二条')
}

/* ---------------- 11. 冻结来源排除已退回编辑 ---------------- */
console.log('\nfreeze sources exclude rejected edits')
{
  const kept = editOp(writer, 1, { 'peer-wri': 0 }, '保留的修改', textUpdate('保留内容'), '2026-10-02T20:00:00Z')
  const dropped = editOp(writer, 2, { 'peer-wri': 1 }, '将被退回', textUpdate('退回内容'), '2026-10-02T20:00:05Z')
  const droppedUndo: EditPayload = { ...dropped.edit!, changes: dropped.edit!.changes!.map((c) => ({ field: c.field, from: c.to, to: c.from })) }
  const comp = editOp(director, 1, { 'peer-dir': 0, 'peer-wri': 2 }, '退回补偿', droppedUndo, '2026-10-02T20:00:10Z')
  const reject = makeOp(director, 2, { 'peer-dir': 1, 'peer-wri': 2 }, 'confirm', '导演退回', {
    confirm: { editIds: [dropped.id], decision: 'rejected' as const }
  }, '2026-10-02T20:00:11Z')
  const reduced0 = reduceLog([kept, dropped, comp, reject])
  const freeze = makeOp(director, 3, { 'peer-dir': 2, 'peer-wri': 2 }, 'freeze', '冻结', {
    freeze: { versionId: 'ver-x', name: 'vx', snapshot: reduced0.document }
  }, '2026-10-02T20:00:20Z')
  const versions = deriveFrozenVersions([kept, dropped, comp, reject, freeze], totalDuration)
  const ids = versions[0].sources.map((s) => s.editId)
  check('保留的修改在来源中', ids.includes(kept.id))
  check('退回的修改不在来源中', !ids.includes(dropped.id))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个失败`)
process.exit(failures === 0 ? 0 : 1)