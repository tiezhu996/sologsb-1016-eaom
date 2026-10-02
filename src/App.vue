<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NButton,
  NConfigProvider,
  NEmpty,
  NFormItem,
  NInput,
  NInputNumber,
  NProgress,
  NSelect,
  NTabPane,
  NTabs,
  NTag
} from 'naive-ui'
import { useStudio } from './useStudio'
import { loadIdentity } from './sync'
import type { Identity } from './types'
import type { Cue, CueKind, Rate } from './types'
import RoleGate from './components/RoleGate.vue'
import ConnectionBar from './components/ConnectionBar.vue'
import ConflictPanel from './components/ConflictPanel.vue'
import ReviewPanel from './components/ReviewPanel.vue'
import VersionsPanel from './components/VersionsPanel.vue'
import FreezeModal from './components/FreezeModal.vue'

const studio = useStudio()
const bootIdentity = ref<Identity | null>(loadIdentity())
const booted = ref(false)

function onChosen(identity: Identity) {
  bootIdentity.value = identity
  studio.init(identity)
}

function switchRole() {
  studio.leaveWindow()
  bootIdentity.value = null
}

onMounted(() => {
  if (bootIdentity.value) studio.init(bootIdentity.value)
  booted.value = true
})

const {
  isDirector,
  online,
  saveState,
  outboxCount,
  document: doc,
  conflicts,
  warnings,
  pendingRecords,
  totalDuration: total,
  durationOfCue,
  durationOfScene,
  updateProject,
  updateScene,
  addScene,
  deleteScene,
  addCue,
  updateCue,
  deleteCue,
  reorderCues,
  moveScene,
  reorderScenes,
  changeCueKind,
  undoMyLastEdit,
  resetSample
} = studio

const selectedSceneId = ref('')
const selectedScene = computed(
  () => doc.value.scenes.find((scene) => scene.id === selectedSceneId.value) ?? doc.value.scenes[0]
)
const dragCueId = ref('')
const dragSceneId = ref('')
const showFreezeModal = ref(false)
const activeRightTab = ref('conflicts')

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
const characterOptions = computed(() => doc.value.characters.map((item) => ({ label: `${item.name} / ${item.voiceActor}`, value: item.id })))
const effectOptions = computed(() => doc.value.soundEffects.map((item) => ({ label: `${item.name} (${item.duration}s)`, value: item.id })))
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

const projectMinutes = computed(() => `${Math.floor(total.value / 60)}:${String(Math.round(total.value % 60)).padStart(2, '0')}`)
const pendingCount = computed(() => pendingRecords.value.length)
const warningCount = computed(() => warnings.value.length)
const conflictCount = computed(() => conflicts.value.length)
const saveLabel = computed(() => {
  if (!online.value) return `离线 · ${outboxCount.value} 条排队中`
  return saveState.value === 'saved' ? '已同步共享日志' : '正在同步…'
})

function cueName(cue: Cue) {
  if (cue.kind === 'dialogue') return doc.value.characters.find((item) => item.id === cue.characterId)?.name ?? '未指定角色'
  if (cue.kind === 'sfx') return doc.value.soundEffects.find((item) => item.id === cue.soundEffectId)?.name ?? '缺失音效'
  return '转场'
}
function sceneStatus(sceneId: string) {
  return warnings.value.some((warning) => warning.sceneId === sceneId) ? 'warning' : 'ok'
}

function addCueToSelected(kind: CueKind) {
  if (!selectedScene.value) return
  const id = addCue(kind, selectedScene.value.id)
  selectedSceneId.value = selectedScene.value.id
  void id
}

function dropCue(targetId: string) {
  if (!dragCueId.value || !selectedScene.value) return
  const ids = selectedScene.value.cues.map((c) => c.id)
  const from = ids.indexOf(dragCueId.value)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0) return
  const order = [...ids]
  order.splice(to, 0, ...order.splice(from, 1))
  reorderCues(selectedScene.value.id, order)
  dragCueId.value = ''
}

function dropScene(targetId: string) {
  if (!dragSceneId.value || dragSceneId.value === targetId) return
  const ids = doc.value.scenes.map((s) => s.id)
  const from = ids.indexOf(dragSceneId.value)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0) return
  const order = [...ids]
  order.splice(to, 0, ...order.splice(from, 1))
  reorderScenes(order)
  dragSceneId.value = ''
}

function goToScene(sceneId: string) {
  selectedSceneId.value = sceneId
  document.querySelector('.editor-column')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function onKindChange(cue: Cue, kind: CueKind) {
  if (!selectedScene.value) return
  changeCueKind(selectedScene.value.id, cue.id, kind)
}

function onKeydown(event: KeyboardEvent) {
  const command = event.ctrlKey || event.metaKey
  if (command && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    undoMyLastEdit()
  }
  if (event.key === '[' || event.key === ']' && selectedScene.value) {
    const index = doc.value.scenes.findIndex((scene) => scene.id === selectedScene.value?.id)
    const next = event.key === '[' ? index - 1 : index + 1
    if (doc.value.scenes[next]) selectedSceneId.value = doc.value.scenes[next].id
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <n-config-provider v-if="!booted || !bootIdentity" :theme-overrides="themeOverrides">
    <RoleGate @chosen="onChosen" />
  </n-config-provider>

  <n-config-provider v-else :theme-overrides="themeOverrides">
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">声</div>
          <div>
            <strong>声场制作台</strong>
            <span>RADIO DRAMA STUDIO · 协作</span>
          </div>
        </div>
        <div class="project-fields">
          <n-input :value="doc.title" aria-label="项目标题" @update:value="updateProject('title', $event)" />
          <n-input :value="doc.subtitle" aria-label="项目副标题" @update:value="updateProject('subtitle', $event)" />
        </div>
        <div class="top-actions">
          <span class="save-state">{{ saveLabel }}</span>
          <n-button quaternary @click="undoMyLastEdit">撤销本窗 ⌘Z</n-button>
          <n-button quaternary size="small" @click="switchRole">切换窗口身份</n-button>
          <n-button type="primary" :disabled="!isDirector || conflictCount > 0" @click="showFreezeModal = true">
            冻结并导出
          </n-button>
        </div>
      </header>

      <ConnectionBar :studio="studio" />

      <section v-if="conflictCount" class="conflict-banner" @click="activeRightTab = 'conflicts'">
        <n-tag size="small" type="error" :bordered="false">冲突 {{ conflictCount }}</n-tag>
        <span>相同内容被两边同时修改，两份版本均已保留，等待导演裁决后才能导出制作稿。</span>
      </section>

      <section class="summary-strip">
        <div class="metric">
          <span>预计总时长</span>
          <strong>{{ projectMinutes }}</strong>
          <small>{{ total.toFixed(1) }} / {{ doc.targetDuration }} 秒</small>
        </div>
        <div class="target-control">
          <n-progress
            type="line"
            :percentage="Math.min(100, Number(((total / doc.targetDuration) * 100).toFixed(1)))"
            :height="8"
            :show-indicator="false"
            :status="total > doc.targetDuration ? 'error' : 'success'"
          />
          <n-input-number
            :value="doc.targetDuration"
            size="small"
            :min="30"
            :step="10"
            @update:value="updateProject('targetDuration', $event ?? 0)"
          >
            <template #suffix>秒目标</template>
          </n-input-number>
        </div>
        <div class="metric compact"><span>场次</span><strong>{{ doc.scenes.length }}</strong></div>
        <div class="metric compact"><span>待确认</span><strong class="accent">{{ pendingCount }}</strong></div>
        <div class="metric compact">
          <span>冲突</span><strong :class="{ danger: conflictCount }">{{ conflictCount }}</strong>
        </div>
        <div class="metric compact">
          <span>检查项</span><strong :class="{ danger: warningCount }">{{ warningCount }}</strong>
        </div>
      </section>

      <main class="workspace">
        <aside class="scene-sidebar">
          <div class="panel-heading">
            <div>
              <span class="eyebrow">PLAYLIST</span>
              <h2>场次结构</h2>
            </div>
            <n-button circle secondary aria-label="新增场次" @click="(selectedSceneId = addScene())">＋</n-button>
          </div>
          <div class="scene-list">
            <button
              v-for="(scene, index) in doc.scenes"
              :key="scene.id"
              class="scene-item"
              :class="{ active: scene.id === selectedScene?.id, warning: sceneStatus(scene.id) === 'warning', dragging: dragSceneId === scene.id }"
              draggable="true"
              @dragstart="dragSceneId = scene.id"
              @dragend="dragSceneId = ''"
              @dragover.prevent
              @drop="dropScene(scene.id)"
              @click="selectedSceneId = scene.id"
            >
              <span class="scene-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="scene-copy">
                <strong>{{ scene.code }} · {{ scene.title }}</strong>
                <small>{{ scene.location }} / {{ scene.timeOfDay }}</small>
              </span>
              <span class="scene-duration">{{ durationOfScene(scene).toFixed(0) }}s</span>
            </button>
          </div>
          <div class="sidebar-tip">
            <strong>离线协作工作流</strong>
            <span>两个窗口可同时编辑</span>
            <span>断网修改自动排队，重连合并</span>
            <span>两边同改一项 → 导演裁决</span>
          </div>
          <n-button block quaternary :disabled="!isDirector" @click="resetSample">恢复示例数据</n-button>
        </aside>

        <section v-if="selectedScene" class="editor-column">
          <div class="scene-title-row">
            <div>
              <span class="eyebrow">SCENE {{ selectedScene.code }}</span>
              <input
                class="title-input"
                :key="selectedScene.id + selectedScene.title"
                :default-value="selectedScene.title"
                aria-label="场次标题"
                @change="updateScene(selectedScene.id, 'title', ($event.target as HTMLInputElement).value)"
              />
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
            <n-form-item label="场次限额（秒）">
              <n-input-number :value="selectedScene.durationLimit" :min="5" :step="5" @update:value="updateScene(selectedScene.id, 'durationLimit', $event ?? 0)" />
            </n-form-item>
            <n-form-item label="场次转场" class="span-2">
              <n-input :value="selectedScene.transition" @update:value="updateScene(selectedScene.id, 'transition', $event)" />
            </n-form-item>
          </div>

          <div class="timeline-heading">
            <div>
              <span class="eyebrow">TIMELINE</span>
              <h3>台词与声音提示</h3>
            </div>
            <div class="add-actions">
              <n-button size="small" type="primary" secondary @click="addCueToSelected('dialogue')">＋ 台词</n-button>
              <n-button size="small" secondary @click="addCueToSelected('sfx')">＋ 音效</n-button>
              <n-button size="small" secondary @click="addCueToSelected('transition')">＋ 转场</n-button>
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
                  <n-select class="kind-select" size="small" :value="cue.kind" :options="kindOptions" @update:value="onKindChange(cue, $event)" />
                  <n-tag size="small" :bordered="false">{{ cueName(cue) }}</n-tag>
                  <span class="duration-pill">{{ durationOfCue(cue).toFixed(1) }}s</span>
                  <n-button size="tiny" tertiary type="error" @click="deleteCue(selectedScene.id, cue.id)">删除</n-button>
                </div>

                <div v-if="cue.kind === 'dialogue'" class="cue-grid">
                  <n-select :value="cue.characterId" :options="characterOptions" placeholder="选择角色" @update:value="updateCue(selectedScene.id, cue.id, 'characterId', $event)" />
                  <n-input :value="cue.emotion" placeholder="情绪与表演提示" @update:value="updateCue(selectedScene.id, cue.id, 'emotion', $event)" />
                  <n-select :value="cue.rate" :options="rateOptions" @update:value="updateCue(selectedScene.id, cue.id, 'rate', $event)" />
                  <n-input-number :value="cue.manualDuration" clearable placeholder="自动" :min="0.5" :step="0.5" @update:value="updateCue(selectedScene.id, cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>手动秒</template>
                  </n-input-number>
                  <n-input class="span-4" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :value="cue.text" @update:value="updateCue(selectedScene.id, cue.id, 'text', $event)" />
                </div>

                <div v-else-if="cue.kind === 'sfx'" class="cue-grid">
                  <n-select :value="cue.soundEffectId" :options="effectOptions" filterable placeholder="选择音效" @update:value="updateCue(selectedScene.id, cue.id, 'soundEffectId', $event)" />
                  <n-input :value="cue.text" placeholder="声音动作说明" @update:value="updateCue(selectedScene.id, cue.id, 'text', $event)" />
                  <n-input-number :value="cue.manualDuration" clearable placeholder="使用素材时长" :min="0.2" :step="0.5" @update:value="updateCue(selectedScene.id, cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>覆盖秒数</template>
                  </n-input-number>
                </div>

                <div v-else class="cue-grid">
                  <n-input :value="cue.transition" placeholder="转场方式" @update:value="updateCue(selectedScene.id, cue.id, 'transition', $event)" />
                  <n-input :value="cue.text" placeholder="转场说明" @update:value="updateCue(selectedScene.id, cue.id, 'text', $event)" />
                  <n-input-number :value="cue.manualDuration" :min="0" :step="0.5" @update:value="updateCue(selectedScene.id, cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>秒</template>
                  </n-input-number>
                </div>
              </div>
            </article>
            <n-empty v-if="!selectedScene.cues.length" description="这场还没有声音提示">
              <template #extra><n-button @click="addCueToSelected('dialogue')">添加第一条台词</n-button></template>
            </n-empty>
          </div>
        </section>

        <aside class="review-column">
          <div class="review-heading">
            <div>
              <span class="eyebrow">REVIEW DESK</span>
              <h2>导演确认区</h2>
            </div>
          </div>
          <n-tabs v-model:value="activeRightTab" type="line" animated>
            <n-tab-pane name="conflicts" :tab="`冲突 ${conflictCount}`">
              <ConflictPanel :studio="studio" />
            </n-tab-pane>
            <n-tab-pane name="warnings" :tab="`检查 ${warningCount}`">
              <div class="review-list">
                <div v-for="warning in warnings" :key="warning.id" class="warning-card" :class="warning.level">
                  <div class="warning-title">
                    <n-tag size="small" :type="warning.level === 'error' ? 'error' : 'warning'" :bordered="false">
                      {{ warning.type === 'collision' ? '撞场' : warning.type === 'missing-sfx' ? '引用' : '时长' }}
                    </n-tag>
                    <strong>{{ warning.title }}</strong>
                  </div>
                  <p>{{ warning.detail }}</p>
                  <n-button size="tiny" quaternary @click="goToScene(warning.sceneId)">
                    定位到 {{ doc.scenes.find((scene) => scene.id === warning.sceneId)?.code }}
                  </n-button>
                </div>
                <n-empty v-if="!warnings.length" description="当前没有连续性问题" />
              </div>
            </n-tab-pane>
            <n-tab-pane name="review" :tab="`确认 ${pendingCount}`">
              <ReviewPanel :studio="studio" />
            </n-tab-pane>
            <n-tab-pane name="versions" :tab="`冻结 ${studio.frozenVersions.value.length}`">
              <VersionsPanel :studio="studio" />
            </n-tab-pane>
          </n-tabs>
        </aside>
      </main>
    </div>

    <FreezeModal :studio="studio" v-model:show="showFreezeModal" />
  </n-config-provider>
</template>
