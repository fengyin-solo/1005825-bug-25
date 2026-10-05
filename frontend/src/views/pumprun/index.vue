<template>
  <section class="page" data-module="pumprun">
    <header class="page-head">
      <div>
        <h2>泵组运行管理</h2>
        <p class="page-desc">维护泵组运行记录，运行电流上下限按泵组编号统一判定，列表、详情与导出读同一份口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记泵组运行记录</button>
        <button class="btn" type="button" @click="exportRows">导出泵组运行清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-danger': item.danger }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-limit">
        当前阈值口径 v{{ thresholdVersion }}：
        <template v-for="(limit, code) in limitEntries" :key="code">
          {{ code }} {{ limit.min }}～{{ limit.max }}A；
        </template>
        其他泵组 {{ fallbackLimit.min }}～{{ fallbackLimit.max }}A
      </span>
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
          <th>超限判定</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'row-over-limit': verdictOf(row) === '超上限' }"
        >
          <td v-for="column in columns" :key="column">
            <RouterLink v-if="column === '运行编号'" class="link" :to="`/pumprun/${row.id}`">
              {{ row[column] ?? '—' }}
            </RouterLink>
            <span v-else-if="column === '运行电流'">
              {{ row[column] ?? '—' }}<template v-if="row[column]"> A</template>
            </span>
            <span v-else>{{ row[column] ?? '—' }}</span>
          </td>
          <td>
            <span :class="verdictClass(verdictOf(row))">{{ verdictOf(row) }}</span>
            <div class="cell-tip">{{ verdictDetail(row) }}</div>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-for="action in actionsFor(row)" :key="action.key">
              <button
                v-if="!action.disabled"
                class="link"
                type="button"
                @click="runAction(action.key, row)"
              >
                {{ action.key }}
              </button>
              <span v-else class="link-disabled" :title="action.reason">{{ action.key }}</span>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无泵组运行数据，可先登记泵组运行记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条泵组运行记录；历史记录按当时阈值保留，在跑记录按当前口径 v{{ thresholdVersion }} 判定</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="creating" class="modal-mask" @click.self="closeCreate">
      <form class="modal-card" @submit.prevent="submitCreate">
        <h3>登记泵组运行记录</h3>
        <label class="form-item">
          <span>所属泵站 *</span>
          <input v-model="draft.所属泵站" placeholder="如：城东1号泵站" />
        </label>
        <label class="form-item">
          <span>泵组编号 *</span>
          <input v-model="draft.泵组编号" list="pump-code-options" placeholder="如：P-01" />
          <datalist id="pump-code-options">
            <option v-for="(limit, code) in limitEntries" :key="code" :value="code">
              电流区间 {{ limit.min }}～{{ limit.max }}A
            </option>
          </datalist>
          <small class="form-tip">
            电流上下限按泵组编号取：{{ draftLimit.min }}～{{ draftLimit.max }}A
          </small>
        </label>
        <label class="form-item">
          <span>运行电流（A）*</span>
          <input v-model="draft.运行电流" type="number" step="0.1" placeholder="如：120" />
        </label>
        <div v-if="draftVerdict" class="form-verdict" :class="verdictClass(draftVerdict.verdict)">
          预判定：{{ draftVerdict.verdict }} — {{ draftVerdict.detail }}
        </div>
        <label class="form-item">
          <span>出水流量</span>
          <input v-model="draft.出水流量" type="number" step="1" placeholder="待开机可填 0" />
        </label>
        <label class="form-item">
          <span>值班人</span>
          <input v-model="draft.值班人" />
        </label>
        <label class="form-item">
          <span>记录时间</span>
          <input v-model="draft.记录时间" type="datetime-local" />
        </label>
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="submit">保存登记</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createPumpRunEntry,
  downloadEntries,
  listEntries,
  moduleMeta,
  pumpCurrentOverview,
  runAction as applyAction,
} from '@/api/local-service'
import { evaluatePumpRow } from '@/data/pump-current'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pumprun')
const columns = ["运行编号", "所属泵站", "泵组编号", "运行电流", "出水流量", "值班人", "记录时间", "运行状态"]
const statuses = ["待开机", "运行中", "已停机", "故障停机"]

const thresholdInfo = pumpCurrentOverview()
const thresholdVersion = thresholdInfo.version
const limitEntries = thresholdInfo.limits as Record<string, { min: number; max: number }>
const fallbackLimit = thresholdInfo.fallback

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => {
  const live = rows.value.filter((row) => !evaluatePumpRow(row).historical)
  return [
    {
      label: '运行中泵组',
      value: rows.value.filter((row) => String(row.status) === '运行中').length,
      danger: false,
    },
    {
      label: '在跑超限（不许确认）',
      value: live.filter((row) => evaluatePumpRow(row).verdict === '超上限').length,
      danger: true,
    },
    {
      label: '待开机泵组',
      value: rows.value.filter((row) => String(row.status) === '待开机').length,
      danger: false,
    },
    {
      label: '已停机/故障泵组',
      value: rows.value.filter((row) => ['已停机', '故障停机'].includes(String(row.status))).length,
      danger: false,
    },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function verdictOf(row: EntryRow) {
  return evaluatePumpRow(row).verdict
}

function verdictDetail(row: EntryRow) {
  return evaluatePumpRow(row).detail
}

function verdictClass(verdict: string): string {
  if (verdict === '超上限') {
    return 'verdict-danger'
  }
  if (verdict === '正常') {
    return 'verdict-ok'
  }
  return 'verdict-warn'
}
// 动作可用性与服务端拦截保持一致：跨上限时确认按钮禁用并写明原因。
function actionsFor(row: EntryRow): { key: string; disabled: boolean; reason?: string }[] {
  const status = String(row.status)
  if (status === '待开机') {
    const verdict = evaluatePumpRow(row)
    if (verdict.verdict === '超上限') {
      return [{ key: '提交开机', disabled: true, reason: verdict.detail }]
    }
    return [{ key: '提交开机', disabled: false }]
  }
  if (status === '运行中') {
    return [
      { key: '登记停机', disabled: false },
      { key: '上报故障', disabled: false },
    ]
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

const creating = ref(false)
const createError = ref('')
const emptyDraft = () => ({
  所属泵站: '',
  泵组编号: '',
  运行电流: '',
  出水流量: '0',
  值班人: '',
  记录时间: '',
})
const draft = reactive(emptyDraft())

const draftLimit = computed(() => thresholdInfo.limitFor(draft.泵组编号.trim()))
const draftVerdict = computed(() => {
  if (draft.运行电流.trim() === '') {
    return null
  }
  const value = Number(draft.运行电流)
  if (!Number.isFinite(value)) {
    return null
  }
  return evaluatePumpRow({
    id: 0,
    status: '待开机',
    pending: true,
    abnormal: false,
    泵组编号: draft.泵组编号.trim(),
    运行电流: String(value),
  })
})

function openCreate() {
  Object.assign(draft, emptyDraft())
  createError.value = ''
  creating.value = true
}

function closeCreate() {
  creating.value = false
}

function submitCreate() {
  createError.value = ''
  const result = createPumpRunEntry({ ...draft })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  creating.value = false
  errorMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
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
