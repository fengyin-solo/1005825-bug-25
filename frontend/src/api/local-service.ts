import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  CURRENT_LIMIT_VERSION,
  CURRENT_LIMITS,
  DEFAULT_CURRENT_LIMIT,
  PUMP_EXPORT_FIELDS,
  applyPumpVerdict,
  currentLimit,
  decoratePumpRows,
  evaluatePumpRow,
  findRunningPump,
  pumpStartGuard,
  stampPumpThreshold,
} from '@/data/pump-current'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 泵组运行的读出统一补判定字段：列表页、详情页、导出都从这里取同一份结论。
function present(key: string, rows: EntryRow[]): EntryRow[] {
  return key === 'pumprun' ? decoratePumpRows(rows) : rows
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(present(key, listRows(key)), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | null {
  const row = listRows(key).find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  return present(key, [row])[0]
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (key === 'pumprun') {
    return runPumpAction(rows, index, action, target)
  }

  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runPumpAction(
  rows: EntryRow[],
  index: number,
  action: string,
  target: string,
): ActionResult {
  const row = rows[index]
  const current = String(row.status)

  if (action === '提交开机') {
    if (current === '运行中') {
      return { ok: false, message: '该泵组已经处于运行中，重复提交开机按重复处理，只保留一条运行记录' }
    }
    // 同一台泵已有运行中的记录时，重复提交开机按重复处理，只落一条。
    const running = findRunningPump(rows, String(row['泵组编号'] ?? ''), Number(row.id))
    if (running) {
      return {
        ok: false,
        message: `泵组 ${row['泵组编号'] ?? ''} 已有运行中的记录（运行编号 ${running['运行编号'] ?? running.id}），重复提交开机按重复处理，只落一条`,
      }
    }
    // 跨过上限一律不许确认，退回时写清超了多少。
    const guard = pumpStartGuard(row)
    if (!guard.ok) {
      return { ok: false, message: guard.message }
    }
  }

  // 停机/故障后历史记录按当时阈值保留：固化字段原样带着，只改状态。
  const keepHistory = target === '已停机' || target === '故障停机'
  const stamped: EntryRow =
    action === '提交开机'
      ? applyPumpVerdict(stampPumpThreshold({ ...row, status: '运行中' }))
      : {
          ...row,
          status: target,
          pending: !keepHistory,
          abnormal: keepHistory ? Boolean(row.abnormal) : false,
        }

  const next = [...rows]
  next[index] = applyPumpVerdict(stamped)
  saveRows('pumprun', next)
  return { ok: true, message: `泵组运行记录已${action}，当前状态「${target}」` }
}

export type PumpRunDraft = {
  所属泵站: string
  泵组编号: string
  运行电流: string
  出水流量: string
  值班人: string
  记录时间: string
}

// 登记泵组运行记录：落为「待开机」，判定结论按统一口径随记录给出。
export function createPumpRunEntry(draft: PumpRunDraft): ActionResult & { id?: number } {
  const pumpCode = draft.泵组编号.trim()
  if (!draft.所属泵站.trim()) {
    return { ok: false, message: '请填写所属泵站' }
  }
  if (!pumpCode) {
    return { ok: false, message: '请填写泵组编号' }
  }
  const current = Number(draft.运行电流)
  if (draft.运行电流.trim() === '' || !Number.isFinite(current)) {
    return { ok: false, message: '请填写可判定的运行电流数值（A）' }
  }

  const rows = listRows('pumprun')
  const running = findRunningPump(rows, pumpCode)
  if (running) {
    return {
      ok: false,
      message: `泵组 ${pumpCode} 已有运行中的记录（运行编号 ${running['运行编号'] ?? running.id}），重复开机按重复处理，只落一条`,
    }
  }

  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const serial = `YX-${String(id).padStart(4, '0')}`
  const created: EntryRow = applyPumpVerdict({
    id,
    status: '待开机',
    pending: true,
    abnormal: false,
    运行编号: serial,
    所属泵站: draft.所属泵站.trim(),
    泵组编号: pumpCode,
    运行电流: String(current),
    出水流量: draft.出水流量.trim() || '0',
    值班人: draft.值班人.trim() || '未填写',
    记录时间: draft.记录时间.trim() || new Date().toLocaleString('sv-SE'),
    运行状态: '待开机',
  })
  saveRows('pumprun', [...rows, created])
  const result = evaluatePumpRow(created)
  return {
    ok: true,
    message:
      result.verdict === '正常'
        ? `运行记录 ${serial} 已登记，等待提交开机`
        : `运行记录 ${serial} 已登记，电流判定「${result.verdict}」：${result.detail}`,
    id,
  }
}

export function pumpCurrentOverview() {
  return {
    version: CURRENT_LIMIT_VERSION,
    limits: Object.fromEntries(
      Object.entries(CURRENT_LIMITS).map(([code, limit]) => [code, { ...limit }]),
    ),
    fallback: { ...DEFAULT_CURRENT_LIMIT },
    limitFor(code: string) {
      return currentLimit(code)
    },
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const extraFields = key === 'pumprun' ? PUMP_EXPORT_FIELDS : []
  const header = ['编号', ...meta.fields, ...extraFields, '当前状态']
  const lines = [header.join(',')]
  // 导出与列表/详情走同一个 present 出口，三处结论一致。
  for (const row of present(key, listRows(key))) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), ...extraFields.map((field) => row[field] ?? ''), row.status]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = present(meta.key, rows[meta.key] ?? [])
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
