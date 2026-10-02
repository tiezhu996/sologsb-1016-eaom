<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NEmpty, NTag } from 'naive-ui'
import type { Studio } from '../useStudio'
import type { Conflict, Cue, Scene } from '../types'

const props = defineProps<{ studio: Studio }>()

const open = computed(() => props.studio.conflicts.value)

function targetScene(conflict: Conflict): Scene | undefined {
  const doc = props.studio.document.value
  if (conflict.containerId) return doc.scenes.find((s) => s.id === conflict.containerId)
  if (conflict.target === 'scene') return doc.scenes.find((s) => s.id === conflict.targetId)
  return undefined
}

function describe(conflict: Conflict, snapshot: unknown): string[] {
  if (conflict.target === 'project' && snapshot && typeof snapshot === 'object') {
    const p = snapshot as { title?: string; subtitle?: string; targetDuration?: number }
    return [`标题：${p.title ?? ''}`, `副标题：${p.subtitle ?? ''}`, `目标时长：${p.targetDuration ?? ''} 秒`]
  }
  if (snapshot === null) return ['（该方删除了此项）']
  if (Array.isArray(snapshot)) {
    const doc = props.studio.document.value
    if (conflict.target === 'scene-order') {
      return snapshot.map((id, i) => `${i + 1}. ${doc.scenes.find((s) => s.id === id)?.code ?? id}`)
    }
    const scene = targetScene(conflict)
    return snapshot.map((id, i) => `${i + 1}. ${scene?.cues.find((c) => c.id === id)?.text.slice(0, 18) ?? id}`)
  }
  if (snapshot && typeof snapshot === 'object') {
    const obj = snapshot as Record<string, unknown>
    if ('cues' in obj) {
      const scene = obj as unknown as Scene
      return [`场次号：${scene.code}`, `标题：${scene.title}`, `地点：${scene.location}`, `提示项：${scene.cues.length} 条`]
    }
    if ('kind' in obj) {
      const cue = obj as unknown as Cue
      return [
        `类型：${cue.kind === 'dialogue' ? '台词' : cue.kind === 'sfx' ? '音效' : '转场'}`,
        `内容：${cue.text}`,
        cue.emotion ? `情绪：${cue.emotion}` : '',
        cue.transition ? `转场：${cue.transition}` : ''
      ].filter(Boolean)
    }
    if ('voiceActor' in obj) return [`角色：${String(obj.name ?? '')}`, `配音：${String(obj.voiceActor ?? '')}`]
    if ('source' in obj) return [`音效：${String(obj.name ?? '')}`, `素材：${String(obj.source ?? '')}`, `时长：${String(obj.duration ?? '')} 秒`]
  }
  return [String(snapshot ?? '')]
}

const typeLabel: Record<Conflict['type'], string> = {
  update: '内容冲突',
  delete: '删除冲突',
  order: '顺序冲突'
}

function choose(conflictId: string, choice: 'a' | 'b' | 'keep-both') {
  props.studio.resolveConflict(conflictId, choice)
}
</script>

<template>
  <div class="review-list conflict-list">
    <div v-for="conflict in open" :key="conflict.id" class="conflict-card">
      <div class="conflict-head">
        <div>
          <n-tag size="small" type="error" :bordered="false">{{ typeLabel[conflict.type] }}</n-tag>
          <strong>{{ conflict.entityLabel }}</strong>
        </div>
        <span class="conflict-id">{{ conflict.id }}</span>
      </div>
      <p v-if="targetScene(conflict)" class="conflict-scene">位于 {{ targetScene(conflict)?.code }}</p>

      <div class="conflict-sides">
        <div v-for="(side, index) in conflict.sides" :key="side.peerId" class="conflict-side" :class="side.peerRole">
          <div class="side-meta">
            <n-tag size="small" :type="side.peerRole === 'director' ? 'warning' : 'info'" :bordered="false">
              {{ side.peerRole === 'director' ? '导演' : '编剧' }} · {{ side.peerName }}
            </n-tag>
            <span>{{ new Date(side.firstTs).toLocaleTimeString('zh-CN') }}</span>
          </div>
          <ul>
            <li v-for="(line, lineIndex) in describe(conflict, side.snapshot)" :key="lineIndex">{{ line }}</li>
          </ul>
          <div class="side-summary">
            <span v-for="(item, i) in side.summary" :key="i" class="summary-chip">{{ item }}</span>
          </div>
          <n-button
            size="small"
            type="primary"
            :disabled="!studio.isDirector.value"
            @click="choose(conflict.id, index === 0 ? 'a' : 'b')"
          >
            采用{{ index === 0 ? '左' : '右' }}版
          </n-button>
        </div>
      </div>

      <n-button
        v-if="conflict.target === 'cue' && conflict.type === 'update'"
        size="small"
        secondary
        block
        class="keep-both-btn"
        :disabled="!studio.isDirector.value"
        @click="choose(conflict.id, 'keep-both')"
      >
        两份都保留（复制进场次，稍后再取舍）
      </n-button>
      <p v-if="!studio.isDirector.value" class="conflict-hint">冲突只能由导演裁决，编剧窗口可继续编辑其它内容。</p>
    </div>
    <n-empty v-if="!open.length" description="没有未决冲突，两边修改已自动合并">
      <template #extra>
        <span class="conflict-ok-hint">相同提示项被两边同时改过时会在此保留两份版本</span>
      </template>
    </n-empty>
  </div>
</template>
