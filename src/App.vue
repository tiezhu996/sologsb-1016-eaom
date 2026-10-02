<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NConfigProvider,
  NEmpty,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NProgress,
  NSelect,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  NTooltip
} from 'naive-ui'
import { useCollab } from './useCollab'
import { makeScript } from './engine'
import type { Cue, CueKind, Rate } from './types'
import type { Conflict } from './sync/types'

const studio = useCollab()
const {
  identity,
  online,
  peers,
  saveState,
  incomingStats,
  document,
  conflicts: allConflicts,
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
  updateProject,
  updateScene,
  updateCue,
  deleteScene,
  deleteCue,
  moveCue,
  moveScene,
  undoLastLocal,
  acceptBatch,
  rejectBatch,
  acceptAllPending,
  resolveConflict,
  resolveConflicts,
  conflictLabel,
  freeze,
  restoreFreeze,
  restoreBatch,
  setupChannel,
  pushToPeers,
  importPacketFile,
  downloadPacket,
  setIdentity,
  cueProvenance,
  sceneProvenance,
  durationOfCue,
  durationOfScene
} = studio

const selectedSceneId = ref(document.value.scenes[0]?.id ?? '')
const selectedScene = computed(() => document.value.scenes.find((scene) => scene.id === selectedSceneId.value) ?? document.value.scenes[0])
const dragCueId = ref('')
const showFreezeModal = ref(false)
const freezeName = ref('')
const showIdentityModal = ref(false)
const identityDraftRole = ref<'director' | 'writer'>('director')
const identityDraftLabel = ref('')
const activeRightTab = ref('conflicts')
const fileInput = ref<HTMLInputElement | null>(null)
const syncMessage = ref('')

const kindOptions = [
  { label: '台词', value: 'dialogue' },
  { label: '音效', value: 'sfx' },
  { label: '转场', value: 'transition' }
]
const rateOptions: Array<{ label: string; value: Rate }> = [
  { label: '慢 0.8×', value: 0.8 },
  { label: '偏慢 0.9×', value: 0.9 },
  { label: '标准 1.0×', value: 1 },
  { label: '偏快 1.1×', value: 1.1 },
  { label: '快 1.2×', value: 1.2 }
]
const characterOptions = computed(() => document.value.characters.map((item) => ({ label: `${item.name} / ${item.voiceActor}`, value: item.id })))
const effectOptions = computed(() => document.value.soundEffects.map((item) => ({ label: `${item.name} (${item.duration}s)`, value: item.id })))
const themeOverrides = {
  common: {
    primaryColor: '#73daca',
    primaryColorHover: '#8de7d9',
    primaryColorPressed: '#52b9aa',
    bodyColor: '#0d111b',
    cardColor: '#151b28',
    modalColor: '#171e2c',
    popoverColor: '#1b2332',
    textColorBase: '#e7edf7',
    borderColor: '#2b3445',
    borderRadius: '8px'
  },
  Input: { color: '#101621', colorFocus: '#101621', border: '1px solid #2b3445' },
  InputNumber: { color: '#101621', border: '1px solid #2b3445' },
  Card: { borderColor: '#252f40' },
  Tab: { tabTextColorActiveLine: '#73daca', barColor: '#73daca' }
}

const isDirector = computed(() => identity.value.role === 'director')
const roleLabel = computed(() => isDirector.value ? `🎬 ${identity.value.label}（导演）` : `✍️ ${identity.value.label}（编剧）`)
const projectMinutes = computed(() => `${Math.floor(totalDuration.value / 60)}:${String(Math.round(totalDuration.value % 60)).padStart(2, '0')}`)
const pendingCount = computed(() => pendingBatches.value.length)
const acceptedCount = computed(() => acceptedBatches.value.length)
const rejectedCount = computed(() => rejectedBatches.value.length)
const warningCount = computed(() => warnings.value.length)
const conflictCount = computed(() => unresolvedConflicts.value.length)
const saveLabel = computed(() => saveState.value === 'saved' ? '已保存到本机' : '正在保存…')
const onlineLabel = computed(() => online.value ? `在线 · ${peers.value.size} 个同组窗口` : '离线编辑中')

function cueName(cue: Cue) {
  if (cue.kind === 'dialogue') return document.value.characters.find((item) => item.id === cue.characterId)?.name ?? '未指定角色'
  if (cue.kind === 'sfx') return document.value.soundEffects.find((item) => item.id === cue.soundEffectId)?.name ?? '缺失音效'
  return '转场'
}

function sceneStatus(sceneId: string) {
  return warnings.value.some((warning) => warning.sceneId === sceneId) ? 'warning' : 'ok'
}

function addScene() {
  selectedSceneId.value = studio.addScene()
}

function dropCue(targetId: string) {
  if (!dragCueId.value || !selectedScene.value) return
  moveCue(selectedScene.value.id, dragCueId.value, targetId)
  dragCueId.value = ''
}

function goToScene(sceneId: string) {
  selectedSceneId.value = sceneId
  window.document.querySelector('.editor-column')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function changeCueKind(cue: Cue, kind: CueKind) {
  updateCue(cue.id, 'kind', kind)
  if (kind === 'dialogue' && !cue.characterId) updateCue(cue.id, 'characterId', document.value.characters[0]?.id)
  if (kind === 'sfx' && !cue.soundEffectId) updateCue(cue.id, 'soundEffectId', document.value.soundEffects[0]?.id)
  if (kind === 'transition') updateCue(cue.id, 'transition', cue.transition || '淡出')
}

function addCue(kind: CueKind) {
  if (!selectedScene.value) return
  studio.addCue(kind, selectedScene.value.id)
}

/* ---------------- 冲突裁决 ---------------- */

function fieldLabel(field: string) {
  const map: Record<string, string> = {
    text: '台词/说明', emotion: '情绪', rate: '语速', characterId: '角色', soundEffectId: '音效',
    transition: '转场', manualDuration: '时长', code: '场次号', title: '标题', location: '空间',
    timeOfDay: '时间', durationLimit: '限额', __deleted: '删除/保留'
  }
  return map[field] ?? field
}

function candidateText(conflict: Conflict, side: 'A' | 'B') {
  const chosen = side === 'A' ? conflict.sideA : conflict.sideB
  if (chosen.deleted) return '（删除）'
  const parts = conflict.fields.map((field) => {
    const value = chosen.fallback[field]
    if (value === undefined) return ''
    return `${fieldLabel(field)}：${formatValue(field, value)}`
  }).filter(Boolean)
  return parts.join('　')
}

function formatValue(field: string, value: unknown) {
  if (field === 'characterId') return document.value.characters.find((c) => c.id === value)?.name ?? value
  if (field === 'soundEffectId') return document.value.soundEffects.find((c) => c.id === value)?.name ?? value
  if (field === 'rate') return `${value}×`
  return String(value)
}

function chooseSide(conflict: Conflict, side: 'A' | 'B') {
  resolveConflict(conflict, side)
}

function acceptAllWithSide(side: 'A' | 'B') {
  resolveConflicts(unresolvedConflicts.value.map((conflict) => ({ conflict, winner: side })))
}

/* ---------------- 冻结导出 ---------------- */

function openFreeze() {
  freezeName.value = `制作稿 v${frozenEvents.value.length + 1}`
  showFreezeModal.value = true
}

function confirmFreeze() {
  const event = freeze(freezeName.value)
  showFreezeModal.value = false
  if (event) downloadText(event.document.title, event.name, makeScript(event.document))
}

function downloadText(title: string, name: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = `${title}-${name}.txt`.replace(/[\\/:*?"<>|]/g, '-')
  anchor.click()
  URL.revokeObjectURL(url)
}

function downloadFrozen(eventId: string) {
  const event = frozenEvents.value.find((item) => item.id === eventId)
  if (event) downloadText(event.document.title, event.name, makeScript(event.document))
}

/* ---------------- 身份与同步 ---------------- */

function openIdentity(role: 'director' | 'writer') {
  identityDraftRole.value = role
  identityDraftLabel.value = role === 'director' ? '导演端' : '编剧端'
  showIdentityModal.value = true
}

function confirmIdentity() {
  setIdentity(identityDraftRole.value, identityDraftLabel.value)
  showIdentityModal.value = false
}

function triggerImport() {
  fileInput.value?.click()
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const added = await importPacketFile(file)
    syncMessage.value = added ? `已合并 ${added} 条来自其他窗口的记录` : '没有新记录，两边已是一致状态'
  } catch (error) {
    syncMessage.value = `导入失败：${(error as Error).message}`
  } finally {
    input.value = ''
    window.setTimeout(() => { syncMessage.value = '' }, 4000)
  }
}

function manualSync() {
  pushToPeers()
  syncMessage.value = '已向同组窗口推送当前全部记录'
  window.setTimeout(() => { syncMessage.value = '' }, 2500)
}

/* ---------------- 批次展示 ---------------- */

function batchClientTag(clientId: string) {
  return clientId === identity.value.clientId ? '本窗口' : `窗口 ${clientId.slice(-4)}`
}

function provenanceText(cueId: string) {
  const prov = cueProvenance(cueId)
  return prov ? `最后来源：${prov.author.label}（${batchClientTag(prov.clientId)}）· ${new Date(prov.at).toLocaleString('zh-CN')}` : '初始剧本内容'
}

function sceneProvText(sceneId: string) {
  const prov = sceneProvenance(sceneId)
  return prov ? `最后来源：${prov.author.label}（${batchClientTag(prov.clientId)}）· ${new Date(prov.at).toLocaleString('zh-CN')}` : '初始剧本内容'
}

function onKeydown(event: KeyboardEvent) {
  const command = event.ctrlKey || event.metaKey
  if (command && event.key.toLowerCase() === 's') {
    event.preventDefault()
    pushToPeers()
  }
  if (command && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    undoLastLocal()
  }
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && selectedScene.value) {
    event.preventDefault()
    moveScene(selectedScene.value.id, event.key === 'ArrowUp' ? -1 : 1)
  }
  if (event.key === '[' || event.key === ']') {
    const index = document.value.scenes.findIndex((scene) => scene.id === selectedScene.value?.id)
    const next = event.key === '[' ? index - 1 : index + 1
    if (document.value.scenes[next]) selectedSceneId.value = document.value.scenes[next].id
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  setupChannel()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">声</div>
          <div>
            <strong>声场制作台</strong>
            <span>RADIO DRAMA STUDIO · 双端协同</span>
          </div>
        </div>
        <div class="project-fields">
          <n-input :value="document.title" aria-label="项目标题" @update:value="updateProject('title', $event)" />
          <n-input :value="document.subtitle" aria-label="项目副标题" @update:value="updateProject('subtitle', $event)" />
        </div>
        <div class="top-actions">
          <n-tag size="small" :bordered="false" :type="online ? 'success' : 'warning'">{{ onlineLabel }}</n-tag>
          <n-tag size="small" :bordered="false" :type="isDirector ? 'info' : 'default'">
            {{ roleLabel }}
          </n-tag>
          <span class="save-state">{{ saveLabel }}</span>
          <n-button quaternary size="small" @click="openIdentity('director')">切换导演</n-button>
          <n-button quaternary size="small" @click="openIdentity('writer')">切换编剧</n-button>
        </div>
      </header>

      <section v-if="conflictCount" class="conflict-banner" @click="activeRightTab = 'conflicts'">
        <span>⚖️ 检测到 {{ conflictCount }} 处双端同时修改，已保留两份内容，等待导演裁决后才能导出制作稿</span>
        <n-button size="tiny" type="primary">前往确认区</n-button>
      </section>

      <section class="summary-strip">
        <div class="metric">
          <span>预计总时长</span>
          <strong>{{ projectMinutes }}</strong>
          <small>{{ totalDuration.toFixed(1) }} / {{ document.targetDuration }} 秒</small>
        </div>
        <div class="target-control">
          <n-progress
            type="line"
            :percentage="Math.min(100, Number(((totalDuration / document.targetDuration) * 100).toFixed(1)))"
            :height="8"
            :show-indicator="false"
            :status="totalDuration > document.targetDuration ? 'error' : 'success'"
          />
          <n-input-number
            :value="document.targetDuration"
            size="small"
            :min="30"
            :step="10"
            @update:value="updateProject('targetDuration', $event ?? 0)"
          >
            <template #suffix>秒目标</template>
          </n-input-number>
        </div>
        <div class="metric compact">
          <span>场次</span><strong>{{ document.scenes.length }}</strong>
        </div>
        <div class="metric compact">
          <span>待确认</span><strong class="accent">{{ pendingCount }}</strong>
        </div>
        <div class="metric compact">
          <span>冲突</span><strong :class="{ danger: conflictCount }">{{ conflictCount }}</strong>
        </div>
      </section>

      <main class="workspace">
        <aside class="scene-sidebar">
          <div class="panel-heading">
            <div>
              <span class="eyebrow">PLAYLIST</span>
              <h2>场次结构</h2>
            </div>
            <n-button circle secondary aria-label="新增场次" @click="addScene">＋</n-button>
          </div>
          <div class="scene-list">
            <button
              v-for="(scene, index) in document.scenes"
              :key="scene.id"
              class="scene-item"
              :class="{ active: scene.id === selectedSceneId, warning: sceneStatus(scene.id) === 'warning' }"
              @click="selectedSceneId = scene.id"
            >
              <span class="scene-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="scene-copy">
                <strong>{{ scene.code }} · {{ scene.title }}</strong>
                <small>{{ scene.location }} / {{ scene.timeOfDay }}</small>
                <small class="prov">{{ sceneProvText(scene.id) }}</small>
              </span>
              <span class="scene-duration">{{ durationOfScene(scene).toFixed(0) }}s</span>
            </button>
          </div>
          <div class="sidebar-tip">
            <strong>离线协同工作流</strong>
            <span>断网可继续编辑，记录留在本窗口</span>
            <span>恢复后自动合并，或用文件手动同步</span>
            <span>[ / ] 切场次 · ⌘Z 撤销 · ⌘S 推送</span>
          </div>
          <n-space vertical :size="6">
            <n-button block secondary @click="manualSync">立即推送给同组窗口</n-button>
            <n-button block quaternary @click="downloadPacket">导出同步文件</n-button>
            <n-button block quaternary @click="triggerImport">导入同步文件</n-button>
            <input ref="fileInput" type="file" accept="application/json" hidden @change="onImportFile" />
          </n-space>
          <p v-if="syncMessage" class="sync-msg">{{ syncMessage }}</p>
          <p v-if="incomingStats" class="sync-msg subtle">最近合并 {{ incomingStats.at.slice(11, 19) }}：{{ incomingStats.added }} 条新记录</p>
        </aside>

        <section v-if="selectedScene" class="editor-column">
          <div class="scene-title-row">
            <div>
              <span class="eyebrow">SCENE {{ selectedScene.code }}</span>
              <input class="title-input" :value="selectedScene.title" aria-label="场次标题" @change="updateScene(selectedScene.id, 'title', ($event.target as HTMLInputElement).value)" />
              <small class="prov-inline">{{ sceneProvText(selectedScene.id) }}</small>
            </div>
            <div class="scene-order-actions">
              <n-button size="small" secondary @click="moveScene(selectedScene.id, -1)">上移</n-button>
              <n-button size="small" secondary @click="moveScene(selectedScene.id, 1)">下移</n-button>
              <n-button size="small" type="error" tertiary @click="deleteScene(selectedScene.id)">删除场次</n-button>
            </div>
          </div>

          <div class="scene-meta-grid">
            <n-form-item label="场次号"><n-input :value="selectedScene.code" @update:value="updateScene(selectedScene.id, 'code', $event)" /></n-form-item>
            <n-form-item label="空间"><n-input :value="selectedScene.location" @update:value="updateScene(selectedScene.id, 'location', $event)" /></n-form-item>
            <n-form-item label="时间"><n-input :value="selectedScene.timeOfDay" @update:value="updateScene(selectedScene.id, 'timeOfDay', $event)" /></n-form-item>
            <n-form-item label="场次限额（秒）"><n-input-number :value="selectedScene.durationLimit" :min="5" :step="5" @update:value="updateScene(selectedScene.id, 'durationLimit', $event ?? 0)" /></n-form-item>
            <n-form-item label="场次转场" class="span-2"><n-input :value="selectedScene.transition" @update:value="updateScene(selectedScene.id, 'transition', $event)" /></n-form-item>
          </div>

          <div class="timeline-heading">
            <div>
              <span class="eyebrow">TIMELINE</span>
              <h3>台词与声音提示</h3>
            </div>
            <div class="add-actions">
              <n-button size="small" type="primary" secondary @click="addCue('dialogue')">＋ 台词</n-button>
              <n-button size="small" secondary @click="addCue('sfx')">＋ 音效</n-button>
              <n-button size="small" secondary @click="addCue('transition')">＋ 转场</n-button>
            </div>
          </div>

          <div class="cue-list">
            <article
              v-for="(cue, index) in selectedScene.cues"
              :key="cue.id"
              class="cue-card"
              :class="[`kind-${cue.kind}`, { dragging: dragCueId === cue.id }]"
              draggable="true"
              @dragstart="dragCueId = cue.id"
              @dragend="dragCueId = ''"
              @dragover.prevent
              @drop="dropCue(cue.id)"
            >
              <div class="cue-grip" title="拖动调整顺序">⋮⋮</div>
              <div class="cue-main">
                <div class="cue-topline">
                  <span class="cue-number">{{ String(index + 1).padStart(2, '0') }}</span>
                  <n-select class="kind-select" size="small" :value="cue.kind" :options="kindOptions" @update:value="changeCueKind(cue, $event)" />
                  <n-tag size="small" :bordered="false">{{ cueName(cue) }}</n-tag>
                  <span class="duration-pill">{{ durationOfCue(cue).toFixed(1) }}s</span>
                  <n-tooltip trigger="hover">
                    <template #trigger>
                      <span class="prov-dot" title="溯源">◎</span>
                    </template>
                    {{ provenanceText(cue.id) }}
                  </n-tooltip>
                  <n-button size="tiny" tertiary type="error" @click="deleteCue(cue.id)">删除</n-button>
                </div>

                <div v-if="cue.kind === 'dialogue'" class="cue-grid">
                  <n-select :value="cue.characterId" :options="characterOptions" placeholder="选择角色" @update:value="updateCue(cue.id, 'characterId', $event)" />
                  <n-input :value="cue.emotion" placeholder="情绪与表演提示" @update:value="updateCue(cue.id, 'emotion', $event)" />
                  <n-select :value="cue.rate" :options="rateOptions" @update:value="updateCue(cue.id, 'rate', $event)" />
                  <n-input-number :value="cue.manualDuration" clearable placeholder="自动" :min="0.5" :step="0.5" @update:value="updateCue(cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>手动秒</template>
                  </n-input-number>
                  <n-input class="span-4" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :value="cue.text" @update:value="updateCue(cue.id, 'text', $event)" />
                </div>

                <div v-else-if="cue.kind === 'sfx'" class="cue-grid">
                  <n-select :value="cue.soundEffectId" :options="effectOptions" filterable placeholder="选择音效" @update:value="updateCue(cue.id, 'soundEffectId', $event)" />
                  <n-input :value="cue.text" placeholder="声音动作说明" @update:value="updateCue(cue.id, 'text', $event)" />
                  <n-input-number :value="cue.manualDuration" clearable placeholder="使用素材时长" :min="0.2" :step="0.5" @update:value="updateCue(cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>覆盖秒数</template>
                  </n-input-number>
                </div>

                <div v-else class="cue-grid">
                  <n-input :value="cue.transition" placeholder="转场方式" @update:value="updateCue(cue.id, 'transition', $event)" />
                  <n-input :value="cue.text" placeholder="转场说明" @update:value="updateCue(cue.id, 'text', $event)" />
                  <n-input-number :value="cue.manualDuration" :min="0" :step="0.5" @update:value="updateCue(cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>秒</template>
                  </n-input-number>
                </div>
              </div>
            </article>
            <n-empty v-if="!selectedScene.cues.length" description="这场还没有声音提示">
              <template #extra><n-button @click="addCue('dialogue')">添加第一条台词</n-button></template>
            </n-empty>
          </div>
        </section>

        <aside class="review-column">
          <div class="review-heading">
            <div>
              <span class="eyebrow">REVIEW DESK</span>
              <h2>导演确认区</h2>
            </div>
            <n-button v-if="isDirector && pendingCount" size="small" type="primary" secondary @click="acceptAllPending">全部接受</n-button>
          </div>

          <n-alert v-if="!isDirector" type="warning" class="role-alert" :show-icon="false">
            当前是编剧身份：可以离线编辑，但接受/退回/裁决/冻结仅导演可操作。
            <n-button size="tiny" quaternary @click="openIdentity('director')">切换为导演</n-button>
          </n-alert>

          <n-tabs v-model:value="activeRightTab" type="line" animated>
            <n-tab-pane name="conflicts" :tab="`冲突 ${conflictCount}`">
              <div class="review-list">
                <div v-if="conflictCount && isDirector" class="bulk-row">
                  <n-button size="tiny" secondary @click="acceptAllWithSide('A')">全部采用 A 侧</n-button>
                  <n-button size="tiny" secondary @click="acceptAllWithSide('B')">全部采用 B 侧</n-button>
                </div>
                <div v-for="conflict in allConflicts" :key="conflict.id" class="conflict-card" :class="{ resolved: conflict.resolution }">
                  <div class="conflict-head">
                    <strong>{{ conflictLabel(conflict) }}</strong>
                    <n-tag size="tiny" :bordered="false" :type="conflict.resolution ? 'success' : 'error'">
                      {{ conflict.resolution ? '已裁决' : '待裁决' }}
                    </n-tag>
                  </div>
                  <div class="conflict-fields">
                    <n-tag v-for="field in conflict.fields" :key="field" size="tiny" :bordered="false">{{ fieldLabel(field) }}</n-tag>
                  </div>
                  <div class="conflict-side" :class="{ chosen: false }">
                    <header>
                      <n-tag size="tiny" type="info" :bordered="false">A · {{ conflict.sideA.author.label }}</n-tag>
                      <span>{{ batchClientTag(conflict.sideA.clientId) }}</span>
                    </header>
                    <p>{{ candidateText(conflict, 'A') }}</p>
                    <n-button v-if="isDirector && !conflict.resolution" size="tiny" type="primary" @click="chooseSide(conflict, 'A')">采用 A</n-button>
                  </div>
                  <div class="conflict-side">
                    <header>
                      <n-tag size="tiny" type="info" :bordered="false">B · {{ conflict.sideB.author.label }}</n-tag>
                      <span>{{ batchClientTag(conflict.sideB.clientId) }}</span>
                    </header>
                    <p>{{ candidateText(conflict, 'B') }}</p>
                    <n-button v-if="isDirector && !conflict.resolution" size="tiny" type="primary" @click="chooseSide(conflict, 'B')">采用 B</n-button>
                  </div>
                  <p v-if="conflict.resolution" class="resolution-note">
                    ✓ {{ conflict.resolution.label }} · {{ new Date(conflict.resolution.at).toLocaleString('zh-CN') }}
                  </p>
                </div>
                <n-empty v-if="!allConflicts.length" description="双端修改已自动合并，没有字段冲突" />
              </div>
            </n-tab-pane>

            <n-tab-pane name="pending" :tab="`待确认 ${pendingCount}`">
              <div class="review-list">
                <n-alert type="info" :show-icon="false">每次编辑都会形成带来源的记录。退回较早记录时，其同窗口后续未决修改会一并退回；其他窗口的并发新修改不受影响。</n-alert>
                <div v-for="batch in pendingBatches" :key="batch.id" class="pending-card" :class="{ stale: batch.rejectedAncestorId }">
                  <div class="pending-meta">
                    <strong>{{ batch.label }}</strong>
                    <span>{{ new Date(batch.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span>
                  </div>
                  <div class="pending-tags">
                    <n-tag size="tiny" :bordered="false" :type="batch.author.role === 'director' ? 'info' : 'default'">{{ batch.author.label }}</n-tag>
                    <n-tag size="tiny" :bordered="false">{{ batchClientTag(batch.clientId) }}</n-tag>
                    <n-tag v-if="batch.batchType === 'undo'" size="tiny" type="warning" :bordered="false">撤销</n-tag>
                    <n-tag v-if="batch.batchType === 'restore'" size="tiny" type="warning" :bordered="false">还原</n-tag>
                    <n-tag v-if="batch.conflictIdsCreated.length" size="tiny" type="error" :bordered="false">涉冲突</n-tag>
                    <n-tag v-if="batch.rejectedAncestorId" size="tiny" type="warning" :bordered="false">旧窗口迟到修改</n-tag>
                  </div>
                  <div class="pending-actions">
                    <n-button size="small" type="primary" :disabled="!isDirector" @click="acceptBatch(batch.id)">接受</n-button>
                    <n-button size="small" tertiary type="warning" :disabled="!isDirector" @click="rejectBatch(batch.id)">退回</n-button>
                  </div>
                </div>
                <n-empty v-if="!pendingCount" description="所有修改都已确认" />
              </div>
            </n-tab-pane>

            <n-tab-pane name="history" :tab="`已确认 ${acceptedCount + rejectedCount}`">
              <div class="review-list history-list">
                <div v-for="batch in [...acceptedBatches, ...rejectedBatches]" :key="batch.id" class="history-card" :class="batch.status">
                  <div class="pending-meta">
                    <strong>{{ batch.label }}</strong>
                    <n-tag size="tiny" :bordered="false" :type="batch.status === 'accepted' ? 'success' : 'error'">
                      {{ batch.status === 'accepted' ? '已接受' : '已退回' }}
                    </n-tag>
                  </div>
                  <p class="history-detail">
                    {{ batch.author.label }}（{{ batchClientTag(batch.clientId) }}）·
                    {{ new Date(batch.at).toLocaleString('zh-CN') }}
                    <template v-if="batch.decisionBy"> · {{ batch.decisionBy.label }}{{ batch.status === 'accepted' ? '接受' : '退回' }}</template>
                  </p>
                  <n-button v-if="isDirector" size="tiny" quaternary @click="restoreBatch(batch.id)">还原此记录内容</n-button>
                </div>
                <n-empty v-if="!acceptedCount && !rejectedCount" description="还没有已确认的记录" />
              </div>
            </n-tab-pane>

            <n-tab-pane name="warnings" :tab="`检查 ${warningCount}`">
              <div class="review-list">
                <div v-for="warning in warnings" :key="warning.id" class="warning-card" :class="warning.level">
                  <div class="warning-title">
                    <n-tag size="small" :type="warning.level === 'error' ? 'error' : 'warning'" :bordered="false">{{ warning.type === 'collision' ? '撞场' : warning.type === 'missing-sfx' ? '引用' : '时长' }}</n-tag>
                    <strong>{{ warning.title }}</strong>
                  </div>
                  <p>{{ warning.detail }}</p>
                  <n-button size="tiny" quaternary @click="goToScene(warning.sceneId)">定位到 {{ document.scenes.find((scene) => scene.id === warning.sceneId)?.code }}</n-button>
                </div>
                <n-empty v-if="!warnings.length" description="当前没有连续性问题" />
              </div>
            </n-tab-pane>

            <n-tab-pane name="versions" :tab="`冻结 ${frozenEvents.length}`">
              <div class="review-list">
                <div class="freeze-block">
                  <n-alert v-if="exportBlockers.length" type="error" :show-icon="false">
                    <div v-for="blocker in exportBlockers" :key="blocker">· {{ blocker }}</div>
                  </n-alert>
                  <n-alert v-else-if="freezeWarnings.length" type="warning" :show-icon="false">
                    <div v-for="line in freezeWarnings" :key="line">· {{ line }}</div>
                  </n-alert>
                  <n-alert v-else type="success" :show-icon="false">冲突已全部裁决，可以冻结导出制作稿。</n-alert>
                  <n-button type="primary" :disabled="!canFreeze" @click="openFreeze">冻结并导出制作稿</n-button>
                </div>
                <div v-for="version in frozenEvents" :key="version.id" class="version-card">
                  <div>
                    <strong>{{ version.name }}</strong>
                    <span>{{ new Date(version.at).toLocaleString('zh-CN') }}</span>
                    <small>{{ version.author.label }}（{{ batchClientTag(version.clientId) }}）冻结 · {{ version.document.scenes.length }} 场 · {{ version.totalDuration.toFixed(1) }} 秒</small>
                  </div>
                  <n-space :size="6">
                    <n-button size="small" type="primary" secondary @click="downloadFrozen(version.id)">导出稿</n-button>
                    <n-button size="small" quaternary @click="restoreFreeze(version.id)">还原到此版本</n-button>
                  </n-space>
                </div>
                <n-empty v-if="!frozenEvents.length" description="冻结后生成只读制作稿，可随时还原到该来源" />
              </div>
            </n-tab-pane>
          </n-tabs>
        </aside>
      </main>
    </div>

    <n-modal v-model:show="showFreezeModal">
      <div class="dialog-card">
        <span class="eyebrow">FREEZE VERSION</span>
        <h2>冻结当前版本</h2>
        <p>冻结会保存一份不可变快照（含来源信息），并立即下载纯文本制作稿。冻结后仍可继续编辑。</p>
        <n-input v-model:value="freezeName" placeholder="版本名称" @keyup.enter="confirmFreeze" />
        <div class="dialog-actions">
          <n-button @click="showFreezeModal = false">取消</n-button>
          <n-button type="primary" @click="confirmFreeze">冻结并导出</n-button>
        </div>
      </div>
    </n-modal>

    <n-modal v-model:show="showIdentityModal">
      <div class="dialog-card">
        <span class="eyebrow">SWITCH ROLE</span>
        <h2>切换当前窗口身份</h2>
        <p>模拟两个浏览器窗口：一个导演端、一个编剧端。身份只保存在本窗口，不会影响其他窗口的数据。</p>
        <n-input v-model:value="identityDraftLabel" placeholder="窗口名称，如 导演端 / 编剧端" />
        <div class="dialog-actions">
          <n-button @click="showIdentityModal = false">取消</n-button>
          <n-button type="primary" @click="confirmIdentity">切换为{{ identityDraftRole === 'director' ? '导演' : '编剧' }}</n-button>
        </div>
      </div>
    </n-modal>
  </n-config-provider>
</template>
