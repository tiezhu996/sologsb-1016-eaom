<script setup lang="ts">
import { ref } from 'vue'
import { makePeerId, saveIdentity } from '../sync'
import type { Identity, Role } from '../types'

const emit = defineEmits<{ (e: 'chosen', identity: Identity): void }>()
const name = ref('')

function choose(role: Role) {
  const identity: Identity = {
    peerId: makePeerId(),
    name: name.value.trim() || (role === 'director' ? '导演' : '编剧'),
    role
  }
  saveIdentity(identity)
  emit('chosen', identity)
}
</script>

<template>
  <div class="gate-shell">
    <div class="gate-card">
      <div class="brand-mark big">声</div>
      <h1>声场制作台 · 协作模式</h1>
      <p class="gate-sub">
        导演与编剧可以在<strong>两个浏览器窗口</strong>中编辑同一部广播剧。断网时修改在本机排队，
        恢复连接后按向量时钟自动合并；同一提示项两边都改过会<strong>保留两份内容</strong>，由导演裁决。
      </p>
      <input v-model="name" class="gate-name" placeholder="你的署名（可选）" maxlength="16" />
      <div class="gate-roles">
        <button class="gate-role director" @click="choose('director')">
          <strong>导演窗口</strong>
          <span>编辑台词与场次 · 接受/退回修改 · 裁决冲突 · 冻结导出</span>
        </button>
        <button class="gate-role writer" @click="choose('writer')">
          <strong>编剧窗口</strong>
          <span>编辑台词、音效与场次顺序；修改提交后等待导演确认</span>
        </button>
      </div>
      <p class="gate-note">选择只保存在当前浏览器窗口，两个窗口请分别选择导演与编剧。</p>
    </div>
  </div>
</template>
