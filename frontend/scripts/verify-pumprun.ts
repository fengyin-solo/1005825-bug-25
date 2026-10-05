// 手工逻辑校验：node 环境下用内存 localStorage 垫片跑核心规则。
function check(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ ${message}`)
    process.exit(1)
  }
}

const store = new Map<string, string>()
// @ts-expect-error 测试用全局垫片
globalThis.window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
}

async function main() {
  const rules = await import('../src/domain/pumprun-rules.ts')
  const service = await import('../src/api/local-service.ts')

  // 1. 统一口径：2# 在当前版本 v2026-10-01 下上限 220，225A 超上限 5A
  const v225 = rules.evaluateCurrent('2#', 225)
  check(v225.level === 'over' && v225.amount === 5 && v225.overUpper, '2# 225A 应超上限 5A')
  // 历史版本 v2026-09-01 下 2# 上限 240，225A 正常
  const vOld = rules.evaluateCurrent('2#', 225, 'v2026-09-01')
  check(vOld.level === 'normal' && vOld.version === 'v2026-09-01', '旧口径下 225A 应正常')
  // 低于下限也算超限，但不挡确认
  const v82 = rules.evaluateCurrent('4#', 82)
  check(v82.level === 'under' && v82.amount === 8 && !v82.overUpper, '4# 82A 应低于下限 8A')

  // 2. 列表 / 详情 / 导出三处结论一致
  const list = service.listEntries('pumprun', {})
  const id2 = list.items.find((r) => r['泵组编号'] === '2#' && r['运行编号'] === 'YY-20261005-02')!
  check(Boolean(id2), '种子应包含运行中的 2# 记录')
  check(id2['超限判定'] === '超过上限 5A', `列表结论异常: ${id2['超限判定']}`)
  const detail = service.getEntry('pumprun', Number(id2.id))!
  check(detail['超限判定'] === id2['超限判定'], '详情应与列表一致')
  const csv = service.exportEntries('pumprun').content
  check(csv.includes('超过上限 5A'), '导出应包含同一结论')

  // 3. 超上限记录不许确认，退回待开机并写清超多少
  const blocked = service.runAction('pumprun', Number(id2.id), '确认运行')
  check(!blocked.ok && blocked.message.includes('超出 5A'), `应被拦截并写明 5A: ${blocked.message}`)
  const returned = service.getEntry('pumprun', Number(id2.id))!
  check(String(returned.status) === '待开机', '应退回待开机')
  // 退回后可以重新提交开机
  const reopen = service.runAction('pumprun', Number(id2.id), '提交开机')
  check(reopen.ok, `退回后应可重新提交开机: ${reopen.message}`)

  // 4. 同一台泵运行中重复提交开机：登记入口与动作入口都只落一条
  const beforeCount = service.listEntries('pumprun', {}).total
  const dup = service.createPumprunRecord({ pumpCode: '2#', station: '迎宾泵站', current: '200', operator: '测试' })
  check(!dup.ok && dup.message.includes('重复开机'), `重复登记应拦下: ${dup.message}`)
  const dupAction = service.runAction('pumprun', Number(id2.id), '提交开机')
  check(!dupAction.ok && dupAction.message.includes('提交开机'), '运行中再提交开机应被状态机拦下')
  check(service.listEntries('pumprun', {}).total === beforeCount, '重复开机不得新增记录')

  // 5. 正常电流的新记录：登记 → 提交开机 → 确认通过；低于下限给警示但放行
  const created = service.createPumprunRecord({ pumpCode: '1#', station: '迎宾泵站', current: '180', operator: '测试' })
  check(created.ok, `登记 1# 应成功: ${created.message}`)
  const pendingRows = service.listEntries('pumprun', {}).items
    .filter((r) => r['泵组编号'] === '1#' && String(r.status) === '待开机')
  const pendingRow = pendingRows.reduce((a, b) => (Number(a.id) > Number(b.id) ? a : b))
  check(String(pendingRow['运行电流']) === '180', '应选中新登记的 180A 记录')
  const start1 = service.runAction('pumprun', Number(pendingRow.id), '提交开机')
  check(start1.ok, `提交开机应成功: ${start1.message}`)
  const ok1 = service.runAction('pumprun', Number(pendingRow.id), '确认运行')
  check(ok1.ok, `正常电流确认应通过: ${ok1.message}`)

  // 6. 历史记录不按新口径追溯：id4 是旧口径下定格的 2# 225A
  const hist = service.getEntry('pumprun', 4)!
  check(String(hist.status) === '已停机', 'id4 应为已停机')
  check(hist['超限判定'] === '正常' && hist['判定口径'] === 'v2026-09-01', '历史记录应保留旧口径正常结论')
  const csv2 = service.exportEntries('pumprun').content
  check(csv2.includes('v2026-09-01'), '导出应保留历史口径版本')

  // 7. 停机时定格当前口径
  const stop1 = service.runAction('pumprun', Number(pendingRow.id), '登记停机')
  check(stop1.ok, '停机应成功')
  const frozen1 = service.getEntry('pumprun', Number(pendingRow.id))!
  check(
    String(frozen1.status) === '已停机' && frozen1['判定口径'] === rules.currentThresholdVersion(),
    '停机应定格当前口径',
  )

  // 8. 换版重算：在跑记录按新口径刷新，已停机历史记录不动
  const fakeOpen = {
    id: 999, status: '运行中', pending: true, abnormal: false,
    '泵组编号': '2#', '运行电流': '225', '超限判定': '正常', '判定口径': 'v2026-09-01',
  }
  const fakeClosed = {
    id: 998, status: '已停机', pending: false, abnormal: false,
    '泵组编号': '2#', '运行电流': '225', '超限判定': '正常', '判定口径': 'v2026-09-01',
  }
  const { rows, changed } = rules.recalcOpenRows([fakeOpen, fakeClosed])
  check(changed, '在跑记录应被重算')
  check(rows[0].abnormal === true && rows[0]['超限判定'] === '超过上限 5A', '在跑记录应刷新为超限')
  check(rows[1].abnormal === false && rows[1]['超限判定'] === '正常', '历史记录不得改写')

  console.log('全部规则校验通过 ✅')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
