import type { EntryRow } from '@/data/types'

/**
 * 泵组运行电流超限判定：全站唯一口径。
 * 列表页、详情页、导出都只通过本文件读结论，任何页面不得再自己写一遍判定。
 *
 * 口径按泵组编号给运行电流上下限，并带版本：
 * - 阈值表新版本生效后，「正在跑」的记录（待开机/运行中）按新口径实时重算；
 * - 已经定格的历史记录（已停机/故障停机）保留停机当时快照所引用的版本，不追溯改写。
 */

export const PUMPRUN_KEY = 'pumprun'
export const PUMP_CODE_FIELD = '泵组编号'
export const CURRENT_FIELD = '运行电流'
export const LIMIT_UNIT = 'A'

export const STATUS_PENDING_START = '待开机'
export const STATUS_RUNNING = '运行中'
export const STATUS_STOPPED = '已停机'
export const STATUS_FAULT = '故障停机'

/** 仍在跑、可被新口径重算的状态。 */
export const OPEN_STATUSES = [STATUS_PENDING_START, STATUS_RUNNING]
/** 已定格、只保留当时阈值结论的状态。 */
export const FROZEN_STATUSES = [STATUS_STOPPED, STATUS_FAULT]

export type CurrentLimit = {
  /** 运行电流下限（A），低于即「低于下限」。 */
  min: number
  /** 运行电流上限（A），高于即「超过上限」。 */
  max: number
}

export type ThresholdVersion = {
  version: string
  effectiveFrom: string
  note: string
  limits: Record<string, CurrentLimit>
}

/**
 * 阈值口径表：新版本追加在后面，currentVersionId 指向当前生效版本。
 * 历史版本只增不改，供已停机记录的快照继续引用。
 */
const THRESHOLD_VERSIONS: ThresholdVersion[] = [
  {
    version: 'v2026-09-01',
    effectiveFrom: '2026-09-01',
    note: '初始口径：按泵组额定电流设定上下限',
    limits: {
      '1#': { min: 120, max: 220 },
      '2#': { min: 110, max: 240 },
      '3#': { min: 100, max: 200 },
      '4#': { min: 90, max: 180 },
    },
  },
  {
    version: 'v2026-10-01',
    effectiveFrom: '2026-10-01',
    note: '2#泵组额定电流下调，运行上限收紧到 220A',
    limits: {
      '1#': { min: 120, max: 220 },
      '2#': { min: 110, max: 220 },
      '3#': { min: 100, max: 200 },
      '4#': { min: 90, max: 180 },
    },
  },
]

const CURRENT_VERSION = THRESHOLD_VERSIONS[THRESHOLD_VERSIONS.length - 1].version

// 记录上承载口径快照的字段名（写进 EntryRow）。
export const FIELD_VERDICT = '超限判定'
export const FIELD_LIMIT_VERSION = '判定口径'
export const FIELD_OVER_AMOUNT = '超限幅度'

export type VerdictLevel = 'normal' | 'over' | 'under' | 'unmeasured' | 'unconfigured'

export type Verdict = {
  level: VerdictLevel
  /** 统一结论文案，三处展示与导出都用它。 */
  label: string
  /** 是否超限（超上限或低于下限）。 */
  abnormal: boolean
  /** 是否跨过上限——只有这种记录一律不许确认。 */
  overUpper: boolean
  /** 超限/欠限幅度（A），正常或无法判定时为 null。 */
  amount: number | null
  /** 判定所用阈值版本。 */
  version: string
  /** 该泵组当前适用的上下限；未配置时为 null。 */
  limit: CurrentLimit | null
}

export function currentThresholdVersion(): string {
  return CURRENT_VERSION
}

export function thresholdVersions(): ThresholdVersion[] {
  return THRESHOLD_VERSIONS
}

export function getThresholdVersion(version: string): ThresholdVersion | undefined {
  return THRESHOLD_VERSIONS.find((item) => item.version === version)
}

export function currentLimitFor(pumpCode: string): CurrentLimit | null {
  const version = getThresholdVersion(CURRENT_VERSION)
  return version?.limits[pumpCode] ?? null
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

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 用指定版本的阈值判定一条电流读数；不给版本就用当前口径。 */
export function evaluateCurrent(
  pumpCode: string,
  current: unknown,
  version: string = CURRENT_VERSION,
): Verdict {
  const threshold = getThresholdVersion(version) ?? getThresholdVersion(CURRENT_VERSION)!
  const limit = threshold.limits[pumpCode] ?? null
  const value = toNumber(current)

  if (!limit) {
    return {
      level: 'unconfigured',
      label: '未配置阈值',
      abnormal: false,
      overUpper: false,
      amount: null,
      version: threshold.version,
      limit,
    }
  }
  if (value === null) {
    return {
      level: 'unmeasured',
      label: '未采集电流',
      abnormal: false,
      overUpper: false,
      amount: null,
      version: threshold.version,
      limit,
    }
  }
  if (value > limit.max) {
    return {
      level: 'over',
      label: `超过上限 ${round1(value - limit.max)}${LIMIT_UNIT}`,
      abnormal: true,
      overUpper: true,
      amount: round1(value - limit.max),
      version: threshold.version,
      limit,
    }
  }
  if (value < limit.min) {
    return {
      level: 'under',
      label: `低于下限 ${round1(limit.min - value)}${LIMIT_UNIT}`,
      abnormal: true,
      overUpper: false,
      amount: round1(limit.min - value),
      version: threshold.version,
      limit,
    }
  }
  return {
    level: 'normal',
    label: '正常',
    abnormal: false,
    overUpper: false,
    amount: null,
    version: threshold.version,
    limit,
  }
}

function isOpen(row: EntryRow): boolean {
  return OPEN_STATUSES.includes(String(row.status))
}

/**
 * 读一条记录的统一超限结论：
 * - 在跑记录：始终按当前口径实时判定；
 * - 已定格记录：沿用定格时写入的快照（当时版本 + 结论），快照缺失时退回当前口径但不回写。
 */
export function evaluateRow(row: EntryRow): Verdict {
  const pumpCode = String(row[PUMP_CODE_FIELD] ?? '')
  const current = row[CURRENT_FIELD]
  if (isOpen(row)) {
    return evaluateCurrent(pumpCode, current)
  }
  const snapVersion = String(row[FIELD_LIMIT_VERSION] ?? '')
  if (snapVersion && getThresholdVersion(snapVersion)) {
    return evaluateCurrent(pumpCode, current, snapVersion)
  }
  return evaluateCurrent(pumpCode, current)
}

/** 用当前口径给记录写入超限快照（停机/故障定格时调用）。 */
export function freezeRowVerdict(row: EntryRow): EntryRow {
  const verdict = evaluateRow(row)
  return {
    ...row,
    abnormal: verdict.abnormal,
    [FIELD_VERDICT]: verdict.label,
    [FIELD_LIMIT_VERSION]: verdict.version,
    [FIELD_OVER_AMOUNT]: verdict.amount === null ? '' : verdict.amount,
  }
}

/**
 * 口径变更后的一次性重算：只重算正在跑的记录，刷新其异常标记与口径版本；
 * 已停机/故障停机的历史记录一律不动。返回是否发生过变更。
 */
export function recalcOpenRows(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const next = rows.map((row) => {
    if (!isOpen(row)) {
      return row
    }
    const verdict = evaluateCurrent(
      String(row[PUMP_CODE_FIELD] ?? ''),
      row[CURRENT_FIELD],
    )
    const recalculated: EntryRow = {
      ...row,
      abnormal: verdict.abnormal,
      [FIELD_VERDICT]: verdict.label,
      [FIELD_LIMIT_VERSION]: verdict.version,
      [FIELD_OVER_AMOUNT]: verdict.amount === null ? '' : verdict.amount,
    }
    if (recalculated.abnormal !== row.abnormal || recalculated[FIELD_VERDICT] !== row[FIELD_VERDICT]) {
      changed = true
    }
    return recalculated
  })
  return { rows: next, changed }
}
