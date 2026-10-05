/**
 * 复壮措施状态管理（Pinia，档案室这一摊）
 * 档案室管实施日期、负责人与措施状态；班组交完工回执后才动措施状态（进入「已完成」），
 * 完成即回写古树最近复壮日期并把对应回执归档。
 */
import { reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Measure, MeasureDraft, MeasureState, MeasureType } from '../types/measure'
import {
  batchSetMeasureState,
  db,
  findOpenReceipt,
  initDatabase,
  putMeasure,
  removeMeasure,
} from '../utils/db'
import { nowIso, uuid } from '../utils/id'
import { useTreeStore } from './treeStore'

/** 复壮措施筛选条件 */
export interface MeasureFilters {
  keyword: string
  treeId: string | 'all'
  type: MeasureType | 'all'
  state: MeasureState | 'all'
}

/** 进入「已完成」的前置校验：同树同类型须有班组已交且未归档的完工回执 */
async function receiptReady(treeId: string, type: MeasureType): Promise<boolean> {
  return (await findOpenReceipt(treeId, type)) !== undefined
}

const NO_RECEIPT_MESSAGE = '班组尚未提交完工回执，不能动措施状态'

export const useMeasureStore = defineStore('measure', () => {
  const filters = reactive<MeasureFilters>({ keyword: '', treeId: 'all', type: 'all', state: 'all' })
  /** 每行的行内编辑草稿，key = measure id */
  const drafts = ref<Record<string, Partial<MeasureDraft>>>({})
  const selectedIds = ref<string[]>([])
  /** 批量操作选中的目标状态 */
  const stateDraft = ref<MeasureState>('已完成')
  const lastMessage = ref('')
  const revision = ref(0)

  async function init(): Promise<void> {
    await initDatabase()
    revision.value += 1
  }

  function setFilters(patch: Partial<MeasureFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.treeId = 'all'
    filters.type = 'all'
    filters.state = 'all'
    selectedIds.value = []
  }

  function setSelectedIds(ids: string[]): void {
    selectedIds.value = [...ids]
  }

  function setStateDraft(state: MeasureState): void {
    stateDraft.value = state
  }

  function setDraft(measureId: string, patch: Partial<MeasureDraft>): void {
    drafts.value = { ...drafts.value, [measureId]: { ...drafts.value[measureId], ...patch } }
  }

  function clearDraft(measureId: string): void {
    const next = { ...drafts.value }
    delete next[measureId]
    drafts.value = next
  }

  function hasDraft(measureId: string): boolean {
    return drafts.value[measureId] !== undefined
  }

  async function saveDraft(measureId: string): Promise<void> {
    const draft = drafts.value[measureId]
    if (draft === undefined) return
    const existing = await db.measures.get(measureId)
    if (!existing) return
    await putMeasure({ ...existing, ...draft } as Measure)
    clearDraft(measureId)
    revision.value += 1
    lastMessage.value = '措施草稿已保存'
  }

  async function createMeasure(draft: MeasureDraft): Promise<Measure> {
    if (draft.state === '已完成' && !(await receiptReady(draft.treeId, draft.type))) {
      throw new Error(NO_RECEIPT_MESSAGE)
    }
    const stamp = nowIso()
    const row: Measure = {
      id: uuid('measure'),
      treeId: draft.treeId,
      type: draft.type,
      date: draft.date,
      material: draft.material.trim(),
      operator: draft.operator.trim(),
      state: draft.state,
      // 档案室不填派工号；旧数据的派工来源由升级迁移补登
      dispatchNo: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    }
    await putMeasure(row)
    revision.value += 1
    if (row.state === '已完成') {
      lastMessage.value = '措施已登记为「已完成」，古树最近复壮日期已回写，班组回执已归档'
    }
    return row
  }

  async function updateMeasure(measureId: string, draft: MeasureDraft): Promise<void> {
    const existing = await db.measures.get(measureId)
    if (!existing) return
    if (draft.state === '已完成' && existing.state !== '已完成') {
      if (!(await receiptReady(draft.treeId, draft.type))) {
        throw new Error(NO_RECEIPT_MESSAGE)
      }
    }
    await putMeasure({
      ...existing,
      treeId: draft.treeId,
      type: draft.type,
      date: draft.date,
      material: draft.material.trim(),
      operator: draft.operator.trim(),
      state: draft.state,
    })
    revision.value += 1
  }

  async function deleteMeasure(measureId: string): Promise<void> {
    await removeMeasure(measureId)
    clearDraft(measureId)
    selectedIds.value = selectedIds.value.filter((id) => id !== measureId)
    revision.value += 1
  }

  /** 推进到下一状态：计划 → 实施中 → 已完成（进「已完成」须班组先交完工回执） */
  async function advance(measureId: string): Promise<MeasureState | null> {
    const existing = await db.measures.get(measureId)
    if (!existing) return null
    const flow: MeasureState[] = ['计划', '实施中', '已完成']
    const index = flow.indexOf(existing.state)
    if (index < 0 || index >= flow.length - 1) {
      lastMessage.value = '该措施已处于「已完成」状态'
      return null
    }
    const next = flow[index + 1]
    if (next === '已完成' && !(await receiptReady(existing.treeId, existing.type))) {
      lastMessage.value = NO_RECEIPT_MESSAGE
      return null
    }
    await putMeasure({ ...existing, state: next })
    revision.value += 1
    lastMessage.value =
      next === '已完成' ? '措施已完成，古树最近复壮日期已回写，班组回执已归档' : `措施状态已推进为「${next}」`
    return next
  }

  /** 批量修改实施状态；改「已完成」时跳过班组未交回执的措施 */
  async function batchSetState(state: MeasureState): Promise<number> {
    let ids = selectedIds.value
    let skipped = 0
    if (state === '已完成') {
      const checks = await Promise.all(
        ids.map(async (id) => {
          const row = await db.measures.get(id)
          if (!row || row.state === '已完成') return id
          return (await receiptReady(row.treeId, row.type)) ? id : null
        }),
      )
      skipped = checks.filter((id) => id === null).length
      ids = checks.filter((id): id is string => id !== null)
    }
    const count = await batchSetMeasureState(ids, state)
    selectedIds.value = []
    revision.value += 1
    lastMessage.value =
      skipped > 0
        ? `已把 ${count} 条措施状态改为「${state}」；${skipped} 条因班组未交完工回执被跳过`
        : `已把 ${count} 条措施状态改为「${state}」`
    // 回写古树日期后，同步刷新古树统计
    await useTreeStore().refreshCounts()
    return count
  }

  return {
    filters,
    drafts,
    selectedIds,
    stateDraft,
    lastMessage,
    revision,
    init,
    setFilters,
    resetFilters,
    setSelectedIds,
    setStateDraft,
    setDraft,
    clearDraft,
    hasDraft,
    saveDraft,
    createMeasure,
    updateMeasure,
    deleteMeasure,
    advance,
    batchSetState,
  }
})
