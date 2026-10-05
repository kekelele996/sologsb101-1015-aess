/**
 * 养护班组作业单状态管理（Pinia）
 * 班组这一摊：记派工号、出勤人次与领用材料用量，完工后交回执；
 * 回执被退回时只重填班组侧再交，档案室的措施台账照旧不动。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { MeasureType } from '../types/measure'
import type { WorkOrder, WorkOrderDraft, WorkOrderState } from '../types/workorder'
import {
  db,
  initDatabase,
  putWorkOrder,
  removeWorkOrder,
  submitWorkReceipt,
  type ReceiptResult,
} from '../utils/db'
import { nowIso, today, uuid } from '../utils/id'

/** 作业单筛选条件 */
export interface WorkOrderFilters {
  keyword: string
  treeId: string | 'all'
  type: MeasureType | 'all'
  state: WorkOrderState | 'all'
}

let subscribed = false

export const useWorkOrderStore = defineStore('workOrder', () => {
  const orders = ref<WorkOrder[]>([])
  const ready = ref(false)
  const filters = reactive<WorkOrderFilters>({ keyword: '', treeId: 'all', type: 'all', state: 'all' })
  const lastMessage = ref('')

  /** 已交回执且未归档的「古树|类型」集合：档案室动措施状态前据此放行 */
  const openReceiptKeys = computed<Set<string>>(() => {
    const set = new Set<string>()
    orders.value.forEach((row) => {
      if (row.state === '已交回执') set.add(`${row.treeId}|${row.type}`)
    })
    return set
  })

  async function init(): Promise<void> {
    await initDatabase()
    if (!subscribed) {
      subscribed = true
      liveQuery(() => db.workorders.toArray()).subscribe({
        next: (list) => {
          orders.value = [...list].sort((a, b) => b.workDate.localeCompare(a.workDate))
          ready.value = true
        },
        error: () => {
          ready.value = true
        },
      })
    }
  }

  function setFilters(patch: Partial<WorkOrderFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.treeId = 'all'
    filters.type = 'all'
    filters.state = 'all'
  }

  /** 某条措施（古树 + 类型）是否已有班组交来的完工回执 */
  function hasOpenReceipt(treeId: string, type: MeasureType): boolean {
    return openReceiptKeys.value.has(`${treeId}|${type}`)
  }

  async function createOrder(draft: WorkOrderDraft): Promise<WorkOrder> {
    const stamp = nowIso()
    const row: WorkOrder = {
      id: uuid('order'),
      treeId: draft.treeId,
      type: draft.type,
      dispatchNo: draft.dispatchNo.trim(),
      crew: draft.crew,
      crewCount: Math.max(1, Math.round(draft.crewCount)),
      materialUsed: draft.materialUsed.trim(),
      workDate: draft.workDate,
      state: '作业中',
      receiptAt: '',
      returnReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    }
    await putWorkOrder(row)
    lastMessage.value = `作业单 ${row.dispatchNo} 已开立（${row.crew}，出勤 ${row.crewCount} 人次）`
    return row
  }

  async function updateOrder(orderId: string, draft: WorkOrderDraft): Promise<void> {
    const existing = await db.workorders.get(orderId)
    if (!existing) return
    await putWorkOrder({
      ...existing,
      treeId: draft.treeId,
      type: draft.type,
      dispatchNo: draft.dispatchNo.trim(),
      crew: draft.crew,
      crewCount: Math.max(1, Math.round(draft.crewCount)),
      materialUsed: draft.materialUsed.trim(),
      workDate: draft.workDate,
    })
    lastMessage.value = `作业单 ${draft.dispatchNo.trim()} 已更新`
  }

  async function deleteOrder(orderId: string): Promise<void> {
    await removeWorkOrder(orderId)
  }

  /**
   * 交完工回执：只重试班组这一侧，档案室照旧。
   * 被退回时回执原因写回作业单，班组改完材料后可再次提交。
   */
  async function submitReceipt(orderId: string): Promise<ReceiptResult> {
    const result = await submitWorkReceipt(orderId)
    lastMessage.value = result.message
    return result
  }

  return {
    orders,
    ready,
    filters,
    lastMessage,
    openReceiptKeys,
    init,
    setFilters,
    resetFilters,
    hasOpenReceipt,
    createOrder,
    updateOrder,
    deleteOrder,
    submitReceipt,
  }
})

/** 新建作业单的默认草稿（今天开工、出勤 1 人次） */
export function emptyWorkOrderDraft(treeId: string): WorkOrderDraft {
  return {
    treeId,
    type: '施肥',
    dispatchNo: '',
    crew: '养护一班',
    crewCount: 1,
    materialUsed: '',
    workDate: today(),
  }
}
