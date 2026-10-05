import { recalcOpenRows, PUMPRUN_KEY, currentThresholdVersion } from '@/domain/pumprun-rules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'drainage-pump:entries'
// 已执行过的超限口径重算版本：换口径后只对在跑记录重算一次。
const MIGRATION_KEY = 'drainage-pump:threshold-version'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = applyThresholdMigration(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = applyThresholdMigration({ ...fallback, ...parsed })
    return merged
  } catch {
    const seeded = applyThresholdMigration(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

/**
 * 口径换版后的一次性重算：只刷在跑的泵组运行记录，已停机/故障停机的历史快照保持原样。
 * 用 localStorage 里的版本号保证只重算一次；之后在跑记录的实时判定由 evaluateRow 兜底。
 */
function applyThresholdMigration(
  data: Record<string, EntryRow[]>,
): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return data
  }
  const version = currentThresholdVersion()
  if (window.localStorage.getItem(MIGRATION_KEY) === version) {
    return data
  }
  const { rows, changed } = recalcOpenRows(data[PUMPRUN_KEY] ?? [])
  const next = changed ? { ...data, [PUMPRUN_KEY]: rows } : data
  if (changed) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  window.localStorage.setItem(MIGRATION_KEY, version)
  return next
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
