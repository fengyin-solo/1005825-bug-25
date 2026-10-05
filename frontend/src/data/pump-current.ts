import type { EntryRow } from './types'

// 泵组运行电流超限判定的唯一口径：
// 列表页、详情页、导出都只读本文件，任何一处不得再各写一份判定。
// 按泵组编号定运行电流上下限；未登记的泵组走默认档位。
export type CurrentVerdict = '正常' | '超上限' | '低于下限' | '电流缺失' | '历史异常'

export type CurrentLimit = {
  min: number
  max: number
}

// 调整阈值后抬升版本号：正在跑（运行中/待开机）的记录会按新口径重算一次。
// 已停机的历史记录按当时随记录固化的阈值保留，不追溯改写。
export const CURRENT_LIMIT_VERSION = 2

export const DEFAULT_CURRENT_LIMIT: CurrentLimit = { min: 60, max: 160 }

export const CURRENT_LIMITS: Record<string, CurrentLimit> = {
  'P-01': { min: 80, max: 150 },
  'P-02': { min: 70, max: 140 },
  'P-03': { min: 60, max: 120 },
  'P-04': { min: 50, max: 100 },
}

export const PUMP_CODE_FIELD = '泵组编号'
export const CURRENT_FIELD = '运行电流'

// 历史记录固化阈值用的内部字段，不参与页面列定义。
const LIMIT_VERSION_SNAPSHOT = '电流阈值版本'
const LIMIT_MIN_SNAPSHOT = '电流下限快照'
const LIMIT_MAX_SNAPSHOT = '电流上限快照'
const LIMIT_BASIS_SNAPSHOT = '判定口径快照'

export function currentLimit(pumpCode: string): CurrentLimit {
  return CURRENT_LIMITS[pumpCode] ?? DEFAULT_CURRENT_LIMIT
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function formatAmpere(value: number): string {
  return `${Math.round(value * 10) / 10}A`
}

// 原始判定：给定电流与档位，给出结论和超差量。
function evaluate(value: number | null, limit: CurrentLimit) {
  if (value === null) {
    return {
      verdict: '电流缺失' as CurrentVerdict,
      overAmount: null,
      underAmount: null,
    }
  }
  if (value > limit.max) {
    return { verdict: '超上限' as CurrentVerdict, overAmount: value - limit.max, underAmount: null }
  }
  if (value < limit.min) {
    return { verdict: '低于下限' as CurrentVerdict, overAmount: null, underAmount: limit.min - value }
  }
  return { verdict: '正常' as CurrentVerdict, overAmount: null, underAmount: null }
}

// 历史结论：已停机的记录按当时固化在记录上的阈值判，查不到固化值时保留旧结论。
function frozenVerdict(row: EntryRow): {
  verdict: CurrentVerdict
  limit: CurrentLimit | null
  version: number | null
  basis: string | null
  overAmount: number | null
  underAmount: number | null
} {
  const min = toNumber(row[LIMIT_MIN_SNAPSHOT])
  const max = toNumber(row[LIMIT_MAX_SNAPSHOT])
  const version = toNumber(row[LIMIT_VERSION_SNAPSHOT])
  const basis = typeof row[LIMIT_BASIS_SNAPSHOT] === 'string' ? row[LIMIT_BASIS_SNAPSHOT] : null
  if (min === null || max === null) {
    return { verdict: oldVerdict(row), limit: null, version, basis, overAmount: null, underAmount: null }
  }
  const result = evaluate(toNumber(row[CURRENT_FIELD]), { min, max })
  return { ...result, limit: { min, max }, version, basis }
}

// 旧数据没有固化阈值：结论沿用记录上已有的异常标记，保证历史不被新口径改写。
// 有异常标记的记为「历史异常」，避免与按阈值算出的「超上限」混成同一份口径。
function oldVerdict(row: EntryRow): CurrentVerdict {
  if (row.abnormal) {
    return '历史异常'
  }
  const current = toNumber(row[CURRENT_FIELD])
  return current === null ? '电流缺失' : '正常'
}

export type PumpCurrentEvaluation = {
  verdict: CurrentVerdict
  overAmount: number | null
  underAmount: number | null
  limit: CurrentLimit | null
  version: number | null
  basis: string
  detail: string
  historical: boolean
}

// 唯一判定入口：运行中/待开机按当前口径判；已停机/故障停机按历史固化口径判。
export function evaluatePumpRow(row: EntryRow): PumpCurrentEvaluation {
  const status = String(row.status)
  if (status === '已停机' || status === '故障停机') {
    const frozen = frozenVerdict(row)
    const basis =
      frozen.basis ?? (frozen.version === null ? '历史记录（保留当时结论）' : `历史阈值 v${frozen.version}`)
    return {
      verdict: frozen.verdict,
      overAmount: frozen.overAmount,
      underAmount: frozen.underAmount,
      limit: frozen.limit,
      version: frozen.version,
      basis,
      detail: buildDetail(frozen.verdict, frozen.overAmount, frozen.underAmount),
      historical: true,
    }
  }

  const limit = currentLimit(String(row[PUMP_CODE_FIELD] ?? ''))
  const result = evaluate(toNumber(row[CURRENT_FIELD]), limit)
  return {
    verdict: result.verdict,
    overAmount: result.overAmount,
    underAmount: result.underAmount,
    limit,
    version: CURRENT_LIMIT_VERSION,
    basis: `当前阈值 v${CURRENT_LIMIT_VERSION}`,
    detail: buildDetail(result.verdict, result.overAmount, result.underAmount),
    historical: false,
  }
}

function buildDetail(
  verdict: CurrentVerdict,
  overAmount: number | null,
  underAmount: number | null,
): string {
  if (verdict === '超上限' && overAmount !== null) {
    return `运行电流超过上限 ${formatAmpere(overAmount)}，不许确认`
  }
  if (verdict === '低于下限' && underAmount !== null) {
    return `运行电流低于下限 ${formatAmpere(underAmount)}`
  }
  if (verdict === '电流缺失') {
    return '未登记运行电流，无法判定'
  }
  if (verdict === '历史异常') {
    return '历史记录：当时口径下标记为异常，按当时结论保留'
  }
  return '运行电流处于上下限之间'
}

// 跨上限一律拦截，退回时写清超了多少；低限与缺电流不拦截确认。
export function pumpStartGuard(row: EntryRow): { ok: boolean; message: string } {
  const result = evaluatePumpRow(row)
  if (result.verdict === '超上限') {
    return {
      ok: false,
      message: `${metaPrefix(row)}运行电流 ${formatAmpere(
        toNumber(row[CURRENT_FIELD]) as number,
      )}，超过上限 ${formatAmpere(result.limit?.max ?? 0)}，超限 ${formatAmpere(
        result.overAmount ?? 0,
      )}，不许确认开机`,
    }
  }
  return { ok: true, message: '' }
}

function metaPrefix(row: EntryRow): string {
  const code = String(row[PUMP_CODE_FIELD] ?? '').trim()
  return code ? `泵组 ${code} ` : ''
}

// 同一台泵已有运行中的记录时，重复提交开机按重复处理，只落一条。
export function findRunningPump(rows: EntryRow[], pumpCode: string, excludeId?: number): EntryRow | undefined {
  const code = pumpCode.trim()
  return rows.find(
    (row) =>
      Number(row.id) !== excludeId &&
      String(row.status) === '运行中' &&
      String(row[PUMP_CODE_FIELD] ?? '').trim() === code,
  )
}

// 确认开机时把当时的阈值固化到记录上，停机后即按历史阈值保留。
export function stampPumpThreshold(row: EntryRow): EntryRow {
  const limit = currentLimit(String(row[PUMP_CODE_FIELD] ?? ''))
  return {
    ...row,
    [LIMIT_VERSION_SNAPSHOT]: CURRENT_LIMIT_VERSION,
    [LIMIT_MIN_SNAPSHOT]: limit.min,
    [LIMIT_MAX_SNAPSHOT]: limit.max,
    [LIMIT_BASIS_SNAPSHOT]: `当前阈值 v${CURRENT_LIMIT_VERSION}`,
  }
}

// 正在跑的记录回到当前口径：清掉旧固化值，按新阈值重算异常标记。
function toLiveRow(row: EntryRow): EntryRow {
  const clone = { ...row }
  delete clone[LIMIT_VERSION_SNAPSHOT]
  delete clone[LIMIT_MIN_SNAPSHOT]
  delete clone[LIMIT_MAX_SNAPSHOT]
  delete clone[LIMIT_BASIS_SNAPSHOT]
  return applyPumpVerdict(clone)
}

// 按统一口径把结论写进对外字段，列表页、详情页、导出读到的就是同一份。
export function applyPumpVerdict(row: EntryRow): EntryRow {
  const result = evaluatePumpRow(row)
  // 在跑：abnormal 只承载跨上限；历史：按当时阈值结论保留（含无固化阈值的历史异常）。
  // 低限与缺电流给告警，但不进看板「异常量」。
  const abnormal = result.historical
    ? result.verdict === '超上限' || result.verdict === '历史异常'
    : result.verdict === '超上限'
  return {
    ...row,
    abnormal,
    '超限判定': result.verdict,
    '判定说明': result.detail,
    '判定口径': result.basis,
  }
}

export function decoratePumpRows(rows: EntryRow[]): EntryRow[] {
  return rows.map(applyPumpVerdict)
}

// 阈值口径改动后执行一次：正在跑的记录按新口径重算，历史记录原样保留。
// 返回 true 表示有记录被重算并需要落库。
export function migratePumpRows(
  rows: EntryRow[],
  appliedVersion: number | null,
): { rows: EntryRow[]; changed: boolean } {
  if (appliedVersion === CURRENT_LIMIT_VERSION) {
    return { rows, changed: false }
  }
  let changed = false
  const next = rows.map((row) => {
    const status = String(row.status)
    if (status === '已停机' || status === '故障停机') {
      return row
    }
    changed = true
    return toLiveRow(row)
  })
  return { rows: next, changed }
}

export const PUMP_EXPORT_FIELDS = ['超限判定', '判定说明', '判定口径']
