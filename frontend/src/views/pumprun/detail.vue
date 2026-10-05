<template>
  <section class="page" data-module="pumprun-detail">
    <header class="page-head">
      <div>
        <h2>泵组运行记录详情</h2>
        <p class="page-desc">
          <RouterLink class="link" to="/pumprun">← 返回泵组运行列表</RouterLink>
          ｜ 超限结论与列表、导出同一份口径
        </p>
      </div>
    </header>

    <div v-if="!row" class="data-table empty-state" style="padding: 24px">没有找到这条泵组运行记录</div>

    <template v-else>
      <article class="detail-alert" :class="alertClass">
        <strong>超限告警：{{ row[verdictField] }}</strong>
        <span v-if="verdict.limit">
          泵组 {{ row[pumpField] }} 运行电流区间 {{ verdict.limit.min }}{{ unit }} ~
          {{ verdict.limit.max }}{{ unit }}，当前读数 {{ formatCurrent(row[currentField]) }}
        </span>
        <span v-else>泵组 {{ row[pumpField] }} 暂无适用阈值或电流读数</span>
        <span class="alert-version">判定口径：{{ row[versionField] }}（{{ frozen ? '停机时定格的历史口径' : '当前口径实时判定' }}）</span>
      </article>

      <table class="data-table detail-table">
        <tbody>
          <tr v-for="field in detailFields" :key="field">
            <th>{{ field }}</th>
            <td>
              <template v-if="field === currentField">{{ formatCurrent(row[field]) }}</template>
              <template v-else-if="field === verdictField">
                <span :class="verdictTextClass">{{ row[field] }}</span>
              </template>
              <template v-else>{{ row[field] === '' || row[field] == null ? '—' : row[field] }}</template>
            </td>
          </tr>
          <tr>
            <th>当前状态</th>
            <td>
              {{ row.status }}<span v-if="row.pending && row.status === '运行中'" class="pending-tag">（待确认）</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div class="detail-actions">
        <button
          v-for="action in availableActions(row)"
          :key="action"
          class="btn"
          :class="{ primary: action === '确认运行' }"
          type="button"
          @click="runAction(action)"
        >
          {{ action }}
        </button>
      </div>

      <footer class="page-foot">
        <span v-if="frozen">该记录已{{ row.status }}，超限结论按 {{ row[versionField] }} 口径保留，不按新口径追溯。</span>
        <span v-else>记录仍在跑，口径换版后超限标记会按当前版本（{{ thresholdVersion }}）重算。</span>
        <span v-if="message" :class="messageOk ? '' : 'error-text'">{{ message }}</span>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  currentThresholdVersion,
  getEntry,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  CURRENT_FIELD,
  FIELD_LIMIT_VERSION,
  FIELD_OVER_AMOUNT,
  FIELD_VERDICT,
  FROZEN_STATUSES,
  PUMP_CODE_FIELD,
  STATUS_PENDING_START,
  STATUS_RUNNING,
  evaluateCurrent,
  evaluateRow,
} from '@/domain/pumprun-rules'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pumprun')
const route = useRoute()
const recordId = Number(route.params.id)
const thresholdVersion = currentThresholdVersion()

const verdictField = FIELD_VERDICT
const versionField = FIELD_LIMIT_VERSION
const currentField = CURRENT_FIELD
const pumpField = PUMP_CODE_FIELD
const unit = 'A'

const tick = ref(0)
const message = ref('')
const messageOk = ref(true)

const row = computed<EntryRow | null>(() => {
  void tick.value
  return getEntry(meta.key, recordId)
})

const verdict = computed(() =>
  row.value ? evaluateRow(row.value) : evaluateCurrent('', null),
)
const frozen = computed(() => (row.value ? FROZEN_STATUSES.includes(String(row.value.status)) : false))

const detailFields = [
  '运行编号',
  '所属泵站',
  '泵组编号',
  '运行电流',
  '出水流量',
  '值班人',
  '记录时间',
  FIELD_VERDICT,
  FIELD_OVER_AMOUNT,
  FIELD_LIMIT_VERSION,
]

const alertClass = computed(() => ({
  'alert-over': verdict.value.level === 'over',
  'alert-under': verdict.value.level === 'under',
  'alert-normal': verdict.value.level === 'normal',
  'alert-muted': verdict.value.level === 'unmeasured' || verdict.value.level === 'unconfigured',
}))
const verdictTextClass = computed(() => ({
  'verdict-over': verdict.value.level === 'over',
  'verdict-under': verdict.value.level === 'under',
  'verdict-normal': verdict.value.level === 'normal',
}))

function formatCurrent(value: unknown): string {
  if (value === '' || value === null || value === undefined) {
    return '未采集'
  }
  return `${value} ${unit}`
}

function availableActions(target: EntryRow): string[] {
  const status = String(target.status)
  if (status === STATUS_PENDING_START) {
    return ['提交开机']
  }
  if (status === STATUS_RUNNING) {
    return target.pending ? ['确认运行', '登记停机', '上报故障'] : ['登记停机', '上报故障']
  }
  return []
}

function runAction(action: string) {
  const result = applyAction(meta.key, recordId, action)
  message.value = result.message
  messageOk.value = result.ok
  tick.value += 1
}
</script>
