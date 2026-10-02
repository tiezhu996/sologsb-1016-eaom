<script setup lang="ts">
import { ref, watch } from 'vue'
import { NAlert, NButton, NInput, NModal } from 'naive-ui'
import type { Studio } from '../useStudio'

const props = defineProps<{ studio: Studio; show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const name = ref('')
watch(
  () => props.show,
  (show) => {
    if (show) name.value = `制作稿 v${props.studio.frozenVersions.value.length + 1}`
  }
)

function close() {
  emit('update:show', false)
}

function confirm() {
  const version = props.studio.freeze(name.value)
  if (!version) return
  props.studio.downloadVersion(version)
  close()
}
</script>

<template>
  <n-modal :show="show" @update:show="(v: boolean) => emit('update:show', v)">
    <div class="dialog-card">
      <span class="eyebrow">FREEZE VERSION</span>
      <h2>冻结当前版本</h2>
      <n-alert v-if="!studio.canFreeze()" type="error" title="冲突未处理完">
        还有 {{ studio.conflicts.value.length }} 个冲突等待导演裁决，冲突解决前不能冻结导出制作稿。
      </n-alert>
      <template v-else>
        <p>
          冻结会保存不可变快照、记录每条修改的来源窗口与作者，并立即下载纯文本制作稿。
          冻结之后草稿仍可继续编辑，也可随时还原回该版本。
        </p>
        <n-input v-model:value="name" placeholder="版本名称" @keyup.enter="confirm" />
        <div class="dialog-actions">
          <n-button @click="close">取消</n-button>
          <n-button type="primary" :disabled="!studio.isDirector.value" @click="confirm">冻结并导出</n-button>
        </div>
        <p v-if="!studio.isDirector.value" class="freeze-perm">仅导演窗口可以冻结制作稿。</p>
      </template>
    </div>
  </n-modal>
</template>
