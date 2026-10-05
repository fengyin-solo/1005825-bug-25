<template>
  <section class="page" data-module="pumprun-detail">
    <header class="page-head">
      <div>
        <h2>泵组运行记录详情</h2>
        <p class="page-desc">运行编号 {{ row?.['运行编号'] ?? '—' }}，电流超限结论与列表页、导出清单读同一份判定口径。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/pumprun">返回列表</RouterLink>
      </div>
    </header>

    <p v-if="!row" class="error-text">没有找到这条泵组运行记录，可能已被重置或删除。</p>

    <template v-else-if="verdict">
      <!-- 告警区：与列表标红、导出判定列同源，跨上限必现告警。 -->
      <div
        v-if="verdict.verdict !== '正常'"
        :class="['alert-banner', verdict.verdict === '超上限' ? 'alert-danger' : 'alert-warn']"
        role="alert"
      >
        <strong>{{ verdict.verdict }}告警</strong>
        <span>{{ verdict.detail }}</span>
        <span v-if="verdict.limit" class="alert-meta">
          泵组 {{ row['泵组编号'] }} 允许区间 {{ verdict.limit.min }}A～{{ verdict.limit.max }}A，
          当前读数 {{ row['运行电流'] }}A
        </span>
        <span class="alert-meta">判定口径：{{ verdict.basis }}{{ verdict.historical ? '（历史记录按当时阈值保留）' : '' }}</span>
      </div>
      <div v-else class="alert-banner alert-ok">
        <strong>运行电流正常</strong>
        <span>{{ verdict.detail }}</span>
        <span class="alert-meta">
          泵组 {{ row['泵组编号'] }} 允许区间 {{ verdict.limit?.min }}A～{{ verdict.limit?.max }}A，
          当前读数 {{ row['运行电流'] }}A
        </span>
      </div>

      <table class="data-table detail-table">
        <tbody>
          <tr v-for="field in fields" :key="field">
            <th>{{ field }}</th>
            <td>
              <span v-if="field === '运行电流'">{{ row[field] }} A</span>
              <template v-else>{{ row[field] ?? '—' }}</template>
            </td>
          </tr>
          <tr>
            <th>超限判定</th>
            <td>
              <span :class="verdictClass(verdict.verdict)">{{ verdict.verdict }}</span>
            </td>
          </tr>
          <tr>
            <th>判定说明</th>
            <td>{{ verdict.detail }}</td>
          </tr>
          <tr>
            <th>判定口径</th>
            <td>{{ verdict.basis }}{{ verdict.historical ? '（历史记录，不按新口径追溯）' : '' }}</td>
          </tr>
          <tr>
            <th>当前状态</th>
            <td>{{ row.status }}</td>
          </tr>
        </tbody>
      </table>

      <div class="detail-actions">
        <button
          v-for="action in availableActions"
          :key="action"
          class="btn"
          :class="{ primary: action === '提交开机' }"
          type="button"
          @click="runAction(action)"
        >
          {{ action }}
        </button>
      </div>
      <p v-if="actionMessage" :class="actionOk ? 'ok-text' : 'error-text'">{{ actionMessage }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import { getEntry, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { evaluatePumpRow } from '@/data/pump-current'
import type { EntryRow } from '@/data/types'

const route = useRoute()
const meta = moduleMeta('pumprun')

const row = ref<EntryRow | null>(getEntry(meta.key, Number(route.params.id)))
const verdict = computed(() =>
  row.value ? evaluatePumpRow(row.value) : null,
)
const actionMessage = ref('')
const actionOk = ref(false)

const fields = meta.fields

// 只给当前状态还能走得通的动作放行；跨上限时「提交开机」按钮本身就不再出现。
const availableActions = computed(() => {
  if (!row.value) {
    return [] as string[]
  }
  const status = String(row.value.status)
  if (status === '待开机') {
    return verdict.value?.verdict === '超上限' ? [] : ['提交开机']
  }
  if (status === '运行中') {
    return ['登记停机', '上报故障']
  }
  return []
})

function verdictClass(value: string): string {
  if (value === '超上限') {
    return 'verdict-danger'
  }
  if (value === '正常') {
    return 'verdict-ok'
  }
  return 'verdict-warn'
}

function runAction(action: string) {
  actionMessage.value = ''
  if (!row.value) {
    return
  }
  const result = applyAction(meta.key, Number(row.value.id), action)
  actionOk.value = result.ok
  actionMessage.value = result.message
  if (result.ok) {
    row.value = getEntry(meta.key, Number(row.value.id))
  }
}
</script>
