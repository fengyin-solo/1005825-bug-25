import { CURRENT_LIMIT_VERSION, migratePumpRows } from './pump-current'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'drainage-pump:entries'
const META_KEY = 'drainage-pump:meta'

type StoreMeta = {
  pumpCurrentVersion?: number | null
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readMeta(): StoreMeta {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  try {
    const raw = window.localStorage.getItem(META_KEY)
    return raw ? (JSON.parse(raw) as StoreMeta) : {}
  } catch {
    return {}
  }
}

function writeMeta(meta: StoreMeta): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(META_KEY, JSON.stringify(meta))
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

// 口径升级迁移：只重算正在跑（运行中/待开机）的记录，历史记录原样保留。
function applyMigrations(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const meta = readMeta()
  if (meta.pumpCurrentVersion === CURRENT_LIMIT_VERSION) {
    return data
  }
  const result = migratePumpRows(data.pumprun ?? [], meta.pumpCurrentVersion ?? null)
  const next = { ...data, pumprun: result.rows }
  meta.pumpCurrentVersion = CURRENT_LIMIT_VERSION
  writeMeta(meta)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = applyMigrations(readStorage())
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
  const seeded = clone(SEED_ROWS[key] ?? [])
  // 重置出的在跑记录同样按当前口径重算一次，历史记录维持播种时的固化结论。
  const rows =
    key === 'pumprun' ? migratePumpRows(seeded, null).rows : seeded
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
