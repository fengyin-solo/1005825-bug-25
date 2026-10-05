<template>
  <section class="page" data-module="pumprun">
    <header class="page-head">
      <div>
        <h2>泵组运行管理</h2>
        <p class="page-desc">
          维护泵组运行记录。运行电流超限按泵组编号的统一上下限口径判定，列表、详情、导出同一结论；
          当前口径版本：<strong>{{ thresholdVersion }}</strong>。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showCreate = true">登记泵组运行记录</button>
        <button class="btn" type="button" @click="exportRows">导出泵组运行清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-warn">超限：{{ abnormalCount }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-over': row.abnormal }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '运行编号'">
              <RouterLink class="link" :to="`/pumprun/${row.id}`">{{ row[column] ?? '—' }}</RouterLink>
            </template>
            <template v-else-if="column === '运行电流'">{{ formatCurrent(row[column]) }}</template>
            <template v-else-if="column === verdictField">
              <span :class="verdictClass(row)">{{ row[column] ?? '—' }}</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            {{ row.status }}<span v-if="row.pending && row.status === '运行中'" class="pending-tag">（待确认）</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <RouterLink class="link" :to="`/pumprun/${row.id}`">详情</RouterLink>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无泵组运行数据，可先登记泵组运行记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条泵组运行记录 · 历史记录保留停机当时的阈值口径，不随新口径改写</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <form class="modal-card" @submit.prevent="submitCreate">
        <h3>登记泵组运行记录</h3>
        <label class="form-item">
          <span>泵组编号 *</span>
          <input v-model="form.pumpCode" list="pump-code-options" placeholder="如 1#" />
          <datalist id="pump-code-options">
            <option v-for="code in knownPumpCodes" :key="code" :value="code" />
          </datalist>
        </label>
        <label class="form-item">
          <span>所属泵站</span>
          <input v-model="form.station" placeholder="如 迎宾泵站" />
        </label>
        <label class="form-item">
          <span>运行电流（A）*</span>
          <input v-model="form.current" inputmode="decimal" placeholder="按实际读数填写" required />
          <small v-if="form.pumpCode && limitOf(form.pumpCode)">
            该泵组当前上下限：{{ limitOf(form.pumpCode)?.min }}A ~ {{ limitOf(form.pumpCode)?.max }}A
          </small>
        </label>
        <label class="form-item">
          <span>出水流量（m³/h）</span>
          <input v-model="form.flow" inputmode="decimal" />
        </label>
        <label class="form-item">
          <span>值班人</span>
          <input v-model="form.operator" />
        </label>
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="showCreate = false">取消</button>
          <button class="btn primary" type="submit">登记</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createPumprunRecord,
  currentLimitFor,
  currentThresholdVersion,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  CURRENT_FIELD,
  FIELD_VERDICT,
  STATUS_PENDING_START,
  STATUS_RUNNING,
} from '@/domain/pumprun-rules'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pumprun')
// 列里含「超限判定」，三处展示都来自同一口径；不展示给业务表的判定口径/幅度走详情页。
const columns = ['运行编号', '所属泵站', '泵组编号', '运行电流', '出水流量', '值班人', '记录时间', FIELD_VERDICT]
const verdictField = FIELD_VERDICT
const statuses = ['待开机', '运行中', '已停机', '故障停机']
const thresholdVersion = currentThresholdVersion()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const showCreate = ref(false)
const createError = ref('')
const form = reactive({ pumpCode: '', station: '', current: '', flow: '', operator: '' })

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const abnormalCount = computed(() => rows.value.filter((row) => row.abnormal).length)
const stats = computed(() => [
  { label: '运行中泵组', value: rows.value.filter((row) => String(row.status) === STATUS_RUNNING).length },
  { label: '待开机泵组', value: rows.value.filter((row) => String(row.status) === STATUS_PENDING_START).length },
  { label: '已停机泵组', value: rows.value.filter((row) => String(row.status) === '已停机').length },
  { label: '超限记录', value: abnormalCount.value },
])
const knownPumpCodes = computed(() => {
  const codes = new Set<string>()
  rows.value.forEach((row) => {
    const code = String(row['泵组编号'] ?? '').trim()
    if (code) {
      codes.add(code)
    }
  })
  return [...codes]
})

function limitOf(code: string) {
  return currentLimitFor(code.trim())
}

function formatCurrent(value: unknown): string {
  if (value === '' || value === null || value === undefined) {
    return '—'
  }
  return `${value} A`
}

function verdictClass(row: EntryRow): Record<string, boolean> {
  const label = String(row[FIELD_VERDICT] ?? '')
  return {
    'verdict-over': label.startsWith('超过上限'),
    'verdict-under': label.startsWith('低于下限'),
    'verdict-normal': label === '正常',
  }
}

/** 状态机驱动的可执行动作，避免对已停机记录再开一遍机。 */
function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === STATUS_PENDING_START) {
    return ['提交开机']
  }
  if (status === STATUS_RUNNING) {
    return row.pending ? ['确认运行', '登记停机', '上报故障'] : ['登记停机', '上报故障']
  }
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitCreate() {
  createError.value = ''
  const result = createPumprunRecord({
    pumpCode: form.pumpCode,
    station: form.station,
    current: form.current,
    flow: form.flow,
    operator: form.operator,
  })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  showCreate.value = false
  Object.assign(form, { pumpCode: '', station: '', current: '', flow: '', operator: '' })
  errorMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  } else {
    errorMessage.value = result.message
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '泵组运行列表读取失败'
  }
}

onMounted(reload)
</script>
