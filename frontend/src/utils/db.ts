/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3 起两摊分账：养护班组作业单（workorders）与档案室复壮措施（measures）分表管理
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState, MeasureType } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import { legacyDispatchOf, normalizeMaterial, type WorkOrder } from '../types/workorder'
import { nowIso, today } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>
  workorders!: Table<WorkOrder, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：加固件补齐「最近检查日期」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：两摊分账，新增班组作业单表，旧措施补派工来源 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
        // 养护班组作业单：记派工号、出勤人次、领用材料用量，与措施按类型对账
        workorders: 'id, treeId, type, state, dispatchNo, workDate',
      })
      .upgrade(async (tx) => {
        // 旧数据没记派工号：按负责人班组归属补来源，认不出归属的标成「历史无派工」
        await tx.table('measures').toCollection().modify((row: Record<string, unknown>) => {
          row.revision = ROW_REVISION
          if (typeof row.dispatchNo !== 'string') {
            row.dispatchNo = legacyDispatchOf(String(row.operator ?? ''))
          }
        })
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除古树并级联清理其检查、措施、作业单、加固与复评记录 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.workorders], async () => {
    await db.surveys.where('treeId').equals(id).delete()
    await db.measures.where('treeId').equals(id).delete()
    await db.workorders.where('treeId').equals(id).delete()
    await db.supports.where('treeId').equals(id).delete()
    await db.reviews.where('treeId').equals(id).delete()
    await db.trees.delete(id)
  })
}

/* ------------------------------ 树体检查 ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
}

/* ------------------------------ 复壮措施（档案室） ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施（档案室侧）。
 * 措施状态为「已完成」时：
 * 1. 回写古树的最近复壮日期（仅当本次日期更新时）；
 * 2. 同树同类型已交回执的班组作业单一并归档（回执闭环）。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.trees, db.measures, db.workorders, async () => {
    await db.measures.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (tree && tree.lastMeasureDate < row.date) {
      await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
    }
    const stamp = nowIso()
    const orders = await db.workorders.where('treeId').equals(row.treeId).toArray()
    for (const order of orders) {
      if (order.type === row.type && order.state === '已交回执') {
        await db.workorders.update(order.id, { state: '已归档', updatedAt: stamp })
      }
    }
  })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期并归档回执 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/* ---------------------------- 班组作业单（养护班组） ---------------------------- */

export async function listWorkOrders(): Promise<WorkOrder[]> {
  const rows = await db.workorders.toArray()
  return rows.sort((a, b) => b.workDate.localeCompare(a.workDate))
}

export async function listWorkOrdersByTree(treeId: string): Promise<WorkOrder[]> {
  const rows = await db.workorders.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.workDate.localeCompare(a.workDate))
}

export async function putWorkOrder(row: WorkOrder): Promise<void> {
  await db.workorders.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeWorkOrder(id: string): Promise<void> {
  await db.workorders.delete(id)
}

/**
 * 查询某古树某类型是否已有班组提交、尚未归档的完工回执。
 * 档案室动措施状态（改为「已完成」）前必须能查到这样的回执。
 */
export async function findOpenReceipt(treeId: string, type: MeasureType): Promise<WorkOrder | undefined> {
  const rows = await db.workorders.where('treeId').equals(treeId).toArray()
  return rows.find((row) => row.type === type && row.state === '已交回执')
}

/** 完工回执处理结果 */
export type ReceiptOutcome = 'accepted' | 'returned' | 'late-archived'

export interface ReceiptResult {
  /** 回执是否被收下（退回重填为 false） */
  ok: boolean
  outcome: ReceiptOutcome
  message: string
}

/**
 * 班组提交完工回执。只写作业单（班组侧），绝不动档案室的措施台账：
 * 提交失败（被退回）时只需班组这一侧重填再交，档案室照旧。
 * 规则：
 * 1. 档案室已先标「已完成」的同类型措施 → 晚到回执仅登记归档，措施状态不回退；
 * 2. 领用材料用量与档案室登记对不上 → 以档案室登记为准，回执退回班组重填；
 * 3. 其余情况 → 回执收下（已交回执），等档案室动措施状态。
 */
export async function submitWorkReceipt(orderId: string): Promise<ReceiptResult> {
  const order = await db.workorders.get(orderId)
  if (!order) {
    return { ok: false, outcome: 'returned', message: '作业单不存在或已被删除' }
  }
  if (order.state === '已交回执' || order.state === '已归档') {
    return { ok: false, outcome: 'accepted', message: '该作业单回执已提交，请勿重复提交' }
  }
  // 档案室对账基准：同树同类型最新一条措施
  const measures = await db.measures.where('treeId').equals(order.treeId).toArray()
  const target = measures
    .filter((row) => row.type === order.type)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  const stamp = nowIso()
  if (target !== undefined && target.state === '已完成') {
    await db.workorders.update(orderId, { state: '已归档', receiptAt: stamp, returnReason: '', updatedAt: stamp })
    return {
      ok: true,
      outcome: 'late-archived',
      message: '档案室已先行完成该措施，晚到回执仅登记归档，措施状态不回退',
    }
  }
  if (target !== undefined && normalizeMaterial(target.material) !== normalizeMaterial(order.materialUsed)) {
    await db.workorders.update(orderId, {
      state: '回执退回',
      returnReason: `领用材料用量与档案室登记对不上（档案室登记：${target.material}），以档案室登记为准，请重填后再交`,
      updatedAt: stamp,
    })
    return {
      ok: false,
      outcome: 'returned',
      message: '材料用量与档案室登记对不上，回执已退回，请按档案室登记重填后再交',
    }
  }
  await db.workorders.update(orderId, { state: '已交回执', receiptAt: stamp, returnReason: '', updatedAt: stamp })
  return { ok: true, outcome: 'accepted', message: '完工回执已提交，待档案室核对后动措施状态' }
}

/* ------------------------------ 加固件 ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSupport(id: string): Promise<void> {
  await db.supports.delete(id)
}

/** 登记本次检查：把最近检查日期置为给定日期（默认今天） */
export async function markSupportChecked(id: string, date = today()): Promise<void> {
  await db.supports.update(id, { lastCheckDate: date, updatedAt: nowIso() })
}

/* ------------------------------ 长势复评 ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
  /** v3 新增：旧存档可能没有该字段，导入时按空数组兜底 */
  workorders?: WorkOrder[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, workorders] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
    db.workorders.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    trees,
    surveys,
    measures,
    supports,
    reviews,
    workorders,
  }
}

/** 用快照覆盖整库（导入存档）；旧存档缺派工来源的措施按负责人班组归属补登 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.workorders], async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
      db.workorders.clear(),
    ])
    await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.measures.bulkPut(
      snapshot.measures.map((row) => ({
        ...row,
        dispatchNo: typeof row.dispatchNo === 'string' ? row.dispatchNo : legacyDispatchOf(row.operator),
        revision: ROW_REVISION,
      })),
    )
    await db.supports.bulkPut(snapshot.supports.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.workorders.bulkPut((snapshot.workorders ?? []).map((row) => ({ ...row, revision: ROW_REVISION })))
  })
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.workorders], async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
      db.workorders.clear(),
    ])
  })
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, workorders] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.reviews.count(),
    db.workorders.count(),
  ])
  return { trees, surveys, measures, supports, reviews, workorders }
}
