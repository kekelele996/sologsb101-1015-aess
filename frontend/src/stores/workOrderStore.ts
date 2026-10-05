/**
 * 作业单状态管理（Pinia）
 * 养护班组这一摊：维护作业单列表、筛选、完工回执提交与提交失败重试。
 * 与档案室的复壮措施分开记账：
 * - 班组交完工回执后才动措施状态；
 * - 材料用量对不上以档案室登记为准，回执退回班组重填；
 * - 班组提交失败后只重试班组这一侧，档案室照旧；
 * - 档案室先标成已完成的措施，晚到回执也不退回去。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { MeasureType } from '../types/measure'
import type {
  ReceiptDraft,
  ReceiptState,
  SubmitState,
  WorkOrder,
  WorkOrderDraft,
  WorkOrderSource,
} from '../types/workOrder'
import {
  db,
  initDatabase,
  putWorkOrder,
  removeWorkOrder,
} from '../utils/db'
import { nowIso, uuid } from '../utils/id'

/** 作业单筛选条件 */
export interface WorkOrderFilters {
  keyword: string
  type: MeasureType | 'all'
  receiptState: ReceiptState | 'all'
  submitState: SubmitState | 'all'
  source: WorkOrderSource | 'all'
}

/** 材料用量归一化：去除所有空白后比对 */
export function normalizeMaterial(value: string): string {
  return value.replace(/\s+/g, '')
}

/** 班组材料用量与档案室登记是否对得上（以档案室登记为准） */
export function materialMatches(teamUsage: string, archiveMaterial: string): boolean {
  return normalizeMaterial(teamUsage) === normalizeMaterial(archiveMaterial)
}

export const useWorkOrderStore = defineStore('workOrder', () => {
  const workOrders = ref<WorkOrder[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const filters = reactive<WorkOrderFilters>({
    keyword: '',
    type: 'all',
    receiptState: 'all',
    submitState: 'all',
    source: 'all',
  })
  const selectedIds = ref<string[]>([])
  const lastMessage = ref('')
  const revision = ref(0)

  /** 按措施类型分组的对账统计 */
  const reconciliation = computed(() => {
    const map = new Map<
      MeasureType,
      { total: number; submitted: number; returned: number; failed: number; history: number }
    >()
    for (const wo of workOrders.value) {
      const entry = map.get(wo.type) ?? { total: 0, submitted: 0, returned: 0, failed: 0, history: 0 }
      entry.total += 1
      if (wo.receiptState === '已交') entry.submitted += 1
      if (wo.receiptState === '退回') entry.returned += 1
      if (wo.submitState === '失败') entry.failed += 1
      if (wo.source === '历史补录') entry.history += 1
      map.set(wo.type, entry)
    }
    return Array.from(map.entries())
      .map(([type, stat]) => ({ type, ...stat }))
      .sort((a, b) => a.type.localeCompare(b.type, 'zh-Hans-CN'))
  })

  let subscribed = false

  async function init(): Promise<void> {
    await initDatabase()
    if (!subscribed) {
      subscribed = true
      liveQuery(async () => db.workOrders.toArray()).subscribe({
        next: (rows) => {
          workOrders.value = rows
          loading.value = false
          ready.value = true
        },
        error: () => {
          loading.value = false
        },
      })
    }
    revision.value += 1
  }

  function setFilters(patch: Partial<WorkOrderFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.type = 'all'
    filters.receiptState = 'all'
    filters.submitState = 'all'
    filters.source = 'all'
    selectedIds.value = []
  }

  function setSelectedIds(ids: string[]): void {
    selectedIds.value = [...ids]
  }

  /** 开立作业单（养护班组派工） */
  async function createWorkOrder(draft: WorkOrderDraft): Promise<WorkOrder> {
    const stamp = nowIso()
    const row: WorkOrder = {
      id: uuid('workorder'),
      dispatchNo: draft.dispatchNo.trim(),
      measureId: draft.measureId,
      type: draft.type,
      attendance: 0,
      materialUsage: '',
      receiptState: '未交',
      submitState: '成功',
      source: '正常派工',
      team: draft.team.trim() || '养护一班',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 2,
    }
    await putWorkOrder(row)
    revision.value += 1
    lastMessage.value = '作业单已开立'
    return row
  }

  /**
   * 提交完工回执。
   * - 档案室已先标完成：回执留存，不退回；
   * - 材料对不上：回执退回班组重填，档案室登记不动；
   * - 对账通过：回执已交，措施状态推进为「已完成」。
   */
  async function submitReceipt(workOrderId: string, receipt: ReceiptDraft): Promise<void> {
    const wo = await db.workOrders.get(workOrderId)
    if (!wo) return
    const measure = await db.measures.get(wo.measureId)
    if (!measure) return

    if (wo.receiptState === '已交') {
      lastMessage.value = '该作业单回执已提交，无需重复提交'
      return
    }

    const attendance = Math.max(0, Math.floor(Number(receipt.attendance) || 0))
    const materialUsage = receipt.materialUsage.trim()

    // 档案室先标成已完成的措施，晚到回执也不退回去
    if (measure.state === '已完成') {
      await putWorkOrder({
        ...wo,
        attendance,
        materialUsage,
        receiptState: '已交',
        submitState: '成功',
      })
      revision.value += 1
      lastMessage.value = '该措施档案室已先标完成，回执已留存，不退回'
      return
    }

    // 材料用量对账：以档案室登记为准，对不上退回班组重填
    if (!materialMatches(materialUsage, measure.material)) {
      await putWorkOrder({
        ...wo,
        attendance,
        materialUsage,
        receiptState: '退回',
        submitState: '成功',
      })
      revision.value += 1
      lastMessage.value = '材料用量与档案室登记不符，回执已退回班组重填（以档案室登记为准）'
      return
    }

    // 对账通过：回执已交，措施状态推进为「已完成」，并回写古树最近复壮日期
    await db.transaction('rw', [db.workOrders, db.measures, db.trees], async () => {
      await db.workOrders.put({
        ...wo,
        attendance,
        materialUsage,
        receiptState: '已交',
        submitState: '成功',
        updatedAt: nowIso(),
      })
      await db.measures.update(measure.id, { state: '已完成', updatedAt: nowIso() })
      const tree = await db.trees.get(measure.treeId)
      if (tree !== undefined && tree.lastMeasureDate < measure.date) {
        await db.trees.update(tree.id, { lastMeasureDate: measure.date, updatedAt: nowIso() })
      }
    })
    revision.value += 1
    lastMessage.value = '完工回执已提交，措施状态已更新为「已完成」'
  }

  /** 模拟班组侧提交失败（用于演示失败后只重试班组这一侧） */
  async function markSubmitFailed(workOrderId: string): Promise<void> {
    const wo = await db.workOrders.get(workOrderId)
    if (!wo) return
    await putWorkOrder({ ...wo, submitState: '失败' })
    revision.value += 1
    lastMessage.value = '已模拟班组侧提交失败'
  }

  /** 重试提交：只重试班组这一侧（作业单），档案室照旧 */
  async function retrySubmit(workOrderId: string): Promise<void> {
    const wo = await db.workOrders.get(workOrderId)
    if (!wo) return
    await putWorkOrder({ ...wo, submitState: '成功' })
    revision.value += 1
    lastMessage.value = '班组侧已重试成功，档案室状态未变动'
  }

  async function deleteWorkOrder(workOrderId: string): Promise<void> {
    await removeWorkOrder(workOrderId)
    selectedIds.value = selectedIds.value.filter((id) => id !== workOrderId)
    revision.value += 1
  }

  return {
    workOrders,
    loading,
    ready,
    filters,
    selectedIds,
    lastMessage,
    revision,
    reconciliation,
    init,
    setFilters,
    resetFilters,
    setSelectedIds,
    createWorkOrder,
    submitReceipt,
    markSubmitFailed,
    retrySubmit,
    deleteWorkOrder,
  }
})
