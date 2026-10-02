import type { Cue, Scene, StudioDocument, WarningItem } from './types'

export function durationOfCue(doc: StudioDocument, cue: Cue): number {
  if (cue.manualDuration !== undefined) return cue.manualDuration
  if (cue.kind === 'sfx') {
    return doc.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
  }
  if (cue.kind === 'transition') return 3
  const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
  const effectiveRate = cue.rate || 1
  return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
}

export function durationOfScene(doc: StudioDocument, scene: Scene): number {
  return Number(scene.cues.reduce((total, cue) => total + durationOfCue(doc, cue), 0).toFixed(1))
}

export function totalDurationOf(doc: StudioDocument): number {
  return doc.scenes.reduce((total, scene) => total + durationOfScene(doc, scene), 0)
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

export function makeScript(doc: StudioDocument): string {
  const lines = [
    doc.title,
    doc.subtitle,
    `目标时长：${doc.targetDuration} 秒`,
    '='.repeat(48),
    ''
  ]
  doc.scenes.forEach((scene, sceneIndex) => {
    lines.push(`${scene.code}｜${scene.title}`)
    lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
    lines.push(`转场：${scene.transition}`)
    lines.push(`场次限额：${scene.durationLimit} 秒｜预计：${durationOfScene(doc, scene)} 秒`)
    lines.push('-'.repeat(34))
    scene.cues.forEach((cue, cueIndex) => {
      const prefix = `${String(cueIndex + 1).padStart(2, '0')} [${durationOfCue(doc, cue).toFixed(1)}s]`
      if (cue.kind === 'dialogue') {
        const role = doc.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
        lines.push(`${prefix} ${role}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
        lines.push(`    ${cue.text}`)
      } else if (cue.kind === 'sfx') {
        const effect = doc.soundEffects.find((item) => item.id === cue.soundEffectId)
        lines.push(`${prefix} 音效｜${cue.text}`)
        lines.push(`    文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
      } else {
        lines.push(`${prefix} 转场｜${cue.transition}｜${cue.text}`)
      }
    })
    if (sceneIndex < doc.scenes.length - 1) lines.push('')
  })
  return lines.join('\n')
}
