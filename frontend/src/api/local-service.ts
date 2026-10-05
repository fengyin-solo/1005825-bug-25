import {
  CURRENT_FIELD,
  FIELD_LIMIT_VERSION,
  FIELD_OVER_AMOUNT,
  FIELD_VERDICT,
  PUMP_CODE_FIELD,
  PUMPRUN_KEY,
  STATUS_FAULT,
  STATUS_PENDING_START,
  STATUS_RUNNING,
  STATUS_STOPPED,
  currentThresholdVersion,
  evaluateCurrent,
  evaluateRow,
  freezeRowVerdict,
  currentLimitFor,
} from '@/domain/pumprun-rules'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
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

/**
 * 读出展示用的记录。泵组运行的超限结论只认 pumprun-rules 这一份口径：
 * 在跑记录按当前阈值实时算，历史记录沿用定格快照，列表/详情/导出全部走这里。
 */
function present(row: EntryRow, key: string): EntryRow {
  if (key !== PUMPRUN_KEY) {
    return row
  }
  const verdict = evaluateRow(row)
  return {
    ...row,
    abnormal: verdict.abnormal,
    [FIELD_VERDICT]: verdict.label,
    [FIELD_LIMIT_VERSION]: verdict.version,
    [FIELD_OVER_AMOUNT]: verdict.amount === null ? '' : verdict.amount,
  }
}

function presentAll(key: string, rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => present(row, key))
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(presentAll(key, listRows(key)), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | null {
  const row = listRows(key).find((item) => Number(item.id) === id)
  return row ? present(row, key) : null
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nowText(): string {
  const d = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function runningCode(rows: EntryRow[], pumpCode: string): EntryRow | undefined {
  return rows.find(
    (row) => String(row[PUMP_CODE_FIELD]) === pumpCode && String(row.status) === STATUS_RUNNING,
  )
}

export type PumprunInput = {
  pumpCode: string
  station: string
  current: string
  flow?: string
  operator: string
}

/** 登记泵组运行记录：同一台泵已在运行时按重复处理，只保留运行中那一条。 */
export function createPumprunRecord(input: PumprunInput): ActionResult {
  const pumpCode = input.pumpCode.trim()
  if (!pumpCode) {
    return { ok: false, message: '泵组编号不能为空' }
  }
  const current = input.current.trim()
  if (current === '' || Number.isNaN(Number(current))) {
    return { ok: false, message: '请填写有效的运行电流（A），超限判定要靠它' }
  }
  const rows = listRows(PUMPRUN_KEY)
  const duplicated = runningCode(rows, pumpCode)
  if (duplicated) {
    return {
      ok: false,
      message: `泵组 ${pumpCode} 已有运行中的记录（${String(duplicated['运行编号'])}），重复开机按重复处理，只落一条`,
    }
  }
  const verdict = evaluateCurrent(pumpCode, current)
  const row: EntryRow = {
    id: nextId(rows),
    status: STATUS_PENDING_START,
    pending: true,
    abnormal: verdict.abnormal,
    运行编号: `YY-${nowText().slice(0, 10).replace(/-/g, '')}-${String(rows.length + 1).padStart(2, '0')}`,
    所属泵站: input.station.trim() || '未填泵站',
    [PUMP_CODE_FIELD]: pumpCode,
    [CURRENT_FIELD]: current,
    出水流量: input.flow?.trim() ?? '',
    值班人: input.operator.trim() || '未填值班人',
    记录时间: nowText(),
    [FIELD_VERDICT]: verdict.label,
    [FIELD_LIMIT_VERSION]: verdict.version,
    [FIELD_OVER_AMOUNT]: verdict.amount === null ? '' : verdict.amount,
    运行状态: STATUS_PENDING_START,
  }
  saveRows(PUMPRUN_KEY, [...rows, row])
  return { ok: true, message: `泵组 ${pumpCode} 的运行记录已登记，当前状态「${STATUS_PENDING_START}」` }
}

function savePumprun(rows: EntryRow[], index: number, row: EntryRow): void {
  const next = [...rows]
  next[index] = row
  saveRows(PUMPRUN_KEY, next)
}

/** 泵组运行专用状态机：重复开机拦截 + 超上限不许确认 + 停机定格口径快照。 */
function runPumprunAction(rows: EntryRow[], index: number, action: string): ActionResult {
  const row = rows[index]
  const status = String(row.status)
  const pumpCode = String(row[PUMP_CODE_FIELD] ?? '')

  if (action === '提交开机') {
    if (status !== STATUS_PENDING_START) {
      return { ok: false, message: `只有「${STATUS_PENDING_START}」的记录才能提交开机，当前是「${status}」` }
    }
    const duplicated = rows.find(
      (item, itemIndex) =>
        itemIndex !== index &&
        String(item[PUMP_CODE_FIELD]) === pumpCode &&
        String(item.status) === STATUS_RUNNING,
    )
    if (duplicated) {
      return {
        ok: false,
        message: `泵组 ${pumpCode} 已有运行中的记录（${String(duplicated['运行编号'])}），重复开机按重复处理，只落一条`,
      }
    }
    const verdict = evaluateCurrent(pumpCode, row[CURRENT_FIELD])
    savePumprun(rows, index, {
      ...row,
      status: STATUS_RUNNING,
      pending: true,
      abnormal: verdict.abnormal,
      [FIELD_VERDICT]: verdict.label,
      [FIELD_LIMIT_VERSION]: verdict.version,
      [FIELD_OVER_AMOUNT]: verdict.amount === null ? '' : verdict.amount,
      运行状态: '运行中（待确认）',
    })
    return {
      ok: true,
      message: `泵组 ${pumpCode} 已提交开机，状态「运行中（待确认）」，超限结论：${verdict.label}`,
    }
  }

  if (action === '确认运行') {
    if (status !== STATUS_RUNNING) {
      return { ok: false, message: `只有「${STATUS_RUNNING}」的记录才能确认，当前是「${status}」` }
    }
    if (!row.pending) {
      return { ok: false, message: '该记录已经确认过，不用重复确认' }
    }
    const verdict = evaluateCurrent(pumpCode, row[CURRENT_FIELD])
    if (verdict.level === 'unconfigured') {
      return { ok: false, message: `泵组 ${pumpCode} 尚未配置运行电流上下限，无法确认，请先补口径` }
    }
    if (verdict.level === 'unmeasured') {
      return { ok: false, message: `泵组 ${pumpCode} 还没有运行电流读数，无法确认，请先补录` }
    }
    if (verdict.overUpper) {
      // 跨过上限一律不许确认：退回待开机，并写清超了多少。
      const returned: EntryRow = {
        ...row,
        status: STATUS_PENDING_START,
        pending: true,
        abnormal: true,
        [FIELD_VERDICT]: verdict.label,
        [FIELD_LIMIT_VERSION]: verdict.version,
        [FIELD_OVER_AMOUNT]: verdict.amount ?? '',
        运行状态: STATUS_PENDING_START,
      }
      savePumprun(rows, index, returned)
      const value = String(row[CURRENT_FIELD])
      return {
        ok: false,
        message:
          `泵组 ${pumpCode} 运行电流 ${value}A，超过上限 ${verdict.limit?.max}A（超出 ${verdict.amount}A），` +
          `不许确认，已退回「${STATUS_PENDING_START}」`,
      }
    }
    const confirmed: EntryRow = {
      ...row,
      status: STATUS_RUNNING,
      pending: false,
      abnormal: verdict.abnormal,
      [FIELD_VERDICT]: verdict.label,
      [FIELD_LIMIT_VERSION]: verdict.version,
      [FIELD_OVER_AMOUNT]: verdict.amount === null ? '' : verdict.amount,
      运行状态: STATUS_RUNNING,
    }
    savePumprun(rows, index, confirmed)
    return {
      ok: true,
      message:
        verdict.level === 'under'
          ? `已确认运行；注意泵组 ${pumpCode} 运行电流低于下限 ${verdict.limit?.min}A（低 ${verdict.amount}A），请现场核查`
          : `泵组 ${pumpCode} 运行电流正常，已确认运行`,
    }
  }

  if (action === '登记停机' || action === '上报故障') {
    if (status !== STATUS_RUNNING) {
      return { ok: false, message: `只有「${STATUS_RUNNING}」的记录才能${action}，当前是「${status}」` }
    }
    const target = action === '登记停机' ? STATUS_STOPPED : STATUS_FAULT
    // 停机定格：按当前口径写快照，以后换口径也不追溯这条历史记录。
    const frozen = freezeRowVerdict({ ...row, status: target, pending: false, 运行状态: target })
    savePumprun(rows, index, frozen)
    return { ok: true, message: `泵组 ${pumpCode} 已${action}，当前状态「${target}」，定格口径 ${frozen[FIELD_LIMIT_VERSION]}` }
  }

  return { ok: false, message: `泵组运行记录没有登记「${action}」这个动作` }
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
  if (key === PUMPRUN_KEY) {
    return runPumprunAction(rows, index, action)
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
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 导出和列表、详情走同一个 present 口径，不另写判定。
  for (const row of presentAll(key, listRows(key))) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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

export { currentLimitFor, currentThresholdVersion }

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = presentAll(meta.key, rows[meta.key] ?? [])
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
