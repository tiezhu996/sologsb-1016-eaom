<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NEmpty, NModal, NTag } from 'naive-ui'
import type { Studio } from '../useStudio'
import type { FrozenVersion } from '../types'

const props = defineProps<{ studio: Studio }>()
const detailVersion = ref<FrozenVersion | null>(null)
const restoreTarget = ref<FrozenVersion | null>(null)

function time(ts: string) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function confirmRestore() {
  if (restoreTarget.value) props.studio.restoreVersion(restoreTarget.value)
  restoreTarget.value = null
}
</script>

<template>
  <div class="review-list">
    <div v-if="!studio.canFreeze()" class="freeze-blocked">
      <n-tag size="small" type="error" :bordered="false">无法导出</n-tag>
      <span>还有 {{ studio.conflicts.value.length }} 个冲突没有处理完，导演裁决后才能冻结制作稿。</span>
    </div>

    <div v-for="version in studio.frozenVersions.value" :key="version.id" class="version-card">
      <div class="version-main">
        <strong>{{ version.name }}</strong>
        <span>{{ time(version.createdAt) }}</span>
        <small>
          冻结人：{{ version.frozenByRole === 'director' ? '导演' : '编剧' }} · {{ version.frozenByName }}
          · {{ version.document.scenes.length }} 场 · {{ version.totalDuration.toFixed(1) }} 秒
        </small>
      </div>
      <div class="version-actions">
        <n-button size="small" secondary @click="detailVersion = version">来源 {{ version.sources.length }}</n-button>
        <n-button
          size="small"
          secondary
          type="warning"
          :disabled="!studio.isDirector.value"
          @click="restoreTarget = version"
        >
          还原
        </n-button>
        <n-button size="small" type="primary" @click="studio.downloadVersion(version)">导出稿</n-button>
      </div>
    </div>
    <n-empty v-if="!studio.frozenVersions.value.length" description="冻结后生成只读制作稿，并记录每条内容的来源窗口" />
  </div>

  <n-modal :show="detailVersion !== null" @update:show="(v: boolean) => !v && (detailVersion = null)">
    <div v-if="detailVersion" class="dialog-card sources-dialog">
      <span class="eyebrow">VERSION PROVENANCE</span>
      <h2>{{ detailVersion.name }} 的来源</h2>
      <p class="sources-sub">冻结快照可还原；以下记录构成该制作稿的全部修改来源。</p>
      <div class="sources-list">
        <div v-for="source in detailVersion.sources" :key="source.editId" class="source-row">
          <n-tag size="small" :type="source.peerRole === 'director' ? 'warning' : 'info'" :bordered="false">
            {{ source.peerRole === 'director' ? '导演' : '编剧' }}
          </n-tag>
          <strong>{{ source.label }}</strong>
          <span>{{ source.peerName }} · {{ time(source.ts) }}</span>
        </div>
        <p v-if="!detailVersion.sources.length" class="no-sources">该版本与上一个还原点之间没有新的修改。</p>
      </div>
      <div class="dialog-actions">
        <n-button @click="detailVersion = null">关闭</n-button>
      </div>
    </div>
  </n-modal>

  <n-modal :show="restoreTarget !== null" @update:show="(v: boolean) => !v && (restoreTarget = null)">
    <div class="dialog-card">
      <span class="eyebrow">RESTORE</span>
      <h2>还原到冻结版本？</h2>
      <p>
        将当前文档还原为“{{ restoreTarget?.name }}”的快照。该操作本身也会进入操作日志，两窗口一致生效；
        未决冲突将被标记为已取代，之后仍可再次还原到更新的版本。
      </p>
      <div class="dialog-actions">
        <n-button @click="restoreTarget = null">取消</n-button>
        <n-button type="warning" @click="confirmRestore">确认还原</n-button>
      </div>
    </div>
  </n-modal>
</template>
