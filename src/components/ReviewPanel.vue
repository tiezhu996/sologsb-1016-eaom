<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NEmpty, NTag } from 'naive-ui'
import type { Studio } from '../useStudio'
import type { ChangeRecord } from '../types'

const props = defineProps<{ studio: Studio }>()
const tab = ref<'pending' | 'history'>('pending')

const pending = computed(() => props.studio.pendingRecords.value)
const history = computed(() => [...props.studio.records.value].sort((a, b) => b.ts.localeCompare(a.ts)))

const statusMeta: Record<ChangeRecord['status'], { label: string; type: 'default' | 'success' | 'warning' | 'error' }> = {
  pending: { label: '待确认', type: 'warning' },
  accepted: { label: '已接受', type: 'success' },
  rejected: { label: '已退回', type: 'error' },
  superseded: { label: '未被采用', type: 'default' }
}

function accept(record: ChangeRecord) {
  props.studio.acceptEdit(record.editIds)
}
function reject(record: ChangeRecord) {
  props.studio.rejectEdit(record.editIds)
}
function acceptAll() {
  props.studio.acceptAllPending()
}

const expanded = ref<string | null>(null)
function time(ts: string) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="review-tabs">
    <button class="review-tab" :class="{ active: tab === 'pending' }" @click="tab = 'pending'">
      待确认 <b>{{ pending.length }}</b>
    </button>
    <button class="review-tab" :class="{ active: tab === 'history' }" @click="tab = 'history'">
      确认记录 <b>{{ history.length }}</b>
    </button>
  </div>

  <div v-if="tab === 'pending'" class="review-list">
    <n-alert type="info" :show-icon="false" class="pending-banner">
      每条修改都带有作者与时钟来源。退回会按操作自带的修改前快照确定性回退，不会用旧窗口覆盖新修改。
    </n-alert>
    <div v-for="record in pending" :key="record.id" class="pending-card">
      <div class="pending-meta">
        <strong>{{ record.label }}</strong>
        <span>{{ new Date(record.ts).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
      </div>
      <div class="pending-source">
        <n-tag size="small" :type="record.peerRole === 'director' ? 'warning' : 'info'" :bordered="false">
          {{ record.peerRole === 'director' ? '导演' : '编剧' }} · {{ record.peerName }}
        </n-tag>
        <span class="record-kind">{{ record.kind === 'add' ? '新增' : record.kind === 'delete' ? '删除' : record.kind === 'reorder' ? '排序' : '修改' }}</span>
      </div>
      <div v-if="studio.isDirector.value" class="pending-actions">
        <n-button size="small" type="primary" @click="accept(record)">接受</n-button>
        <n-button size="small" tertiary type="warning" @click="reject(record)">退回</n-button>
      </div>
      <p v-else class="pending-wait">等待导演确认</p>
    </div>
    <n-empty v-if="!pending.length" description="所有修改都已确认" />
    <n-button v-if="pending.length && studio.isDirector.value" block type="primary" secondary style="margin-top: 10px" @click="acceptAll">
      全部接受（{{ pending.length }}）
    </n-button>
  </div>

  <div v-else class="review-list">
    <div v-for="record in history" :key="record.id" class="record-card" :class="{ archived: !record.inLineage }">
      <div class="record-row" @click="expanded = expanded === record.id ? null : record.id">
        <n-tag size="small" :type="statusMeta[record.status].type" :bordered="false">{{ statusMeta[record.status].label }}</n-tag>
        <strong>{{ record.label }}</strong>
        <span class="record-time">{{ time(record.ts) }}</span>
      </div>
      <div v-if="expanded === record.id" class="record-detail">
        <p>来源：{{ record.peerRole === 'director' ? '导演窗口' : '编剧窗口' }} · {{ record.peerName }}</p>
        <p v-if="record.decidedByName">
          确认人：{{ record.decidedByName }} · {{ record.decidedAt ? time(record.decidedAt) : '' }}
          <span v-if="record.decisionReason">（{{ record.decisionReason }}）</span>
        </p>
        <p v-if="record.conflictId" class="conflict-link">来自冲突裁决 {{ record.conflictId }}</p>
        <ul v-if="record.changes?.length">
          <li v-for="change in record.changes" :key="change.field">
            <code>{{ change.field }}</code>：{{ String(change.from ?? '∅') }} → {{ String(change.to ?? '∅') }}
          </li>
        </ul>
        <p v-if="!record.inLineage" class="archived-note">该记录属于已还原版本之前的历史，仅留档，可由冻结版本还原。</p>
      </div>
    </div>
    <n-empty v-if="!history.length" description="还没有任何修改记录" />
  </div>
</template>
