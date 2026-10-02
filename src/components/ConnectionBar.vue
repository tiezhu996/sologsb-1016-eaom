<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTag, NTooltip } from 'naive-ui'
import type { Studio } from '../useStudio'

const props = defineProps<{ studio: Studio }>()

const online = computed(() => props.studio.online.value)
const peers = computed(() => props.studio.peers.value)
const outbox = computed(() => props.studio.outboxCount.value)
const identity = computed(() => props.studio.identity.value)

function toggle() {
  props.studio.setOnline(!online.value)
}
function flush() {
  props.studio.flushOutbox()
}
</script>

<template>
  <div class="connection-bar">
    <button class="conn-toggle" :class="{ offline: !online }" @click="toggle">
      <span class="conn-dot" />
      {{ online ? '在线 · 自动合并' : '离线 · 本机排队' }}
    </button>

    <n-tag size="small" :type="identity.role === 'director' ? 'warning' : 'info'" :bordered="false">
      {{ identity.role === 'director' ? '导演窗口' : '编剧窗口' }} · {{ identity.name }}
    </n-tag>

    <span class="conn-peers">
      协作窗口：{{ peers.length ? peers.map((p) => `${p.role === 'director' ? '导演' : '编剧'}·${p.name}`).join('、') : '未发现' }}
      <em v-if="online && !peers.length">（请在另一个浏览器窗口打开本页并选择另一角色）</em>
    </span>

    <div class="conn-right">
      <template v-if="!online">
        <span class="outbox-pill">{{ outbox }} 条修改待同步</span>
        <n-button size="tiny" type="primary" @click="flush">恢复连接并合并</n-button>
      </template>
      <n-tooltip v-else>
        <template #trigger>
          <span class="conn-hint">storage + BroadcastChannel 实时合并</span>
        </template>
        所有修改写入共享操作日志；离线窗口重连后排入的修改与对端修改按向量时钟合并
      </n-tooltip>
    </div>
  </div>
</template>
