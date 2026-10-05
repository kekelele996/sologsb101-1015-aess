/**
 * 养护班组作业单（WorkOrder）
 * 两摊分账后由养护班组自管：记派工号、出勤人次与领用材料用量；
 * 与档案室的复壮措施（Measure）按「措施类型」对账，互不直接改写对方台账。
 */
import type { MeasureType } from './measure'

/** 作业单状态：作业中 / 已交回执 / 回执退回 / 已归档 */
export type WorkOrderState = '作业中' | '已交回执' | '回执退回' | '已归档'

export const WORK_ORDER_STATE_OPTIONS: WorkOrderState[] = ['作业中', '已交回执', '回执退回', '已归档']

export interface WorkOrder {
  id: string
  /** 所属古树 */
  treeId: string
  /** 措施类型（与档案室复壮措施按类型对账） */
  type: MeasureType
  /** 派工号 */
  dispatchNo: string
  /** 作业班组 */
  crew: string
  /** 出勤人次 */
  crewCount: number
  /** 领用材料用量 */
  materialUsed: string
  /** 作业日期 YYYY-MM-DD */
  workDate: string
  /** 作业单状态 */
  state: WorkOrderState
  /** 完工回执提交时间（ISO），空串 = 未交 */
  receiptAt: string
  /** 回执退回原因（材料对不上等），空串 = 无 */
  returnReason: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑作业单的表单草稿（状态由回执流转驱动，不在表单内手改） */
export interface WorkOrderDraft {
  treeId: string
  type: MeasureType
  dispatchNo: string
  crew: string
  crewCount: number
  materialUsed: string
  workDate: string
}

/* ------------------------------ 班组名册 ------------------------------ */

/**
 * 班组名册：班组 → 负责人名单。
 * 旧数据升级时按「负责人班组归属」补派工来源，名册查不到的标成「历史无派工」。
 */
export const CREW_ROSTER: Record<string, string[]> = {
  养护一班: ['王建军', '张勇'],
  养护二班: ['李慧', '赵鹏'],
  养护三班: ['孙晓', '周敏'],
}

export const CREW_OPTIONS: string[] = Object.keys(CREW_ROSTER)

/** 历史数据补来源失败时的标记：认不出班组归属 */
export const LEGACY_NO_DISPATCH = '历史无派工'

/** 按负责人查班组归属；查不到返回 null */
export function crewOfOperator(operator: string): string | null {
  const name = operator.trim()
  if (name === '') return null
  for (const [crew, members] of Object.entries(CREW_ROSTER)) {
    if (members.includes(name)) return crew
  }
  return null
}

/**
 * 旧数据升级时补派工来源：
 * 负责人能认出班组归属 → 「历史派工-班组名」；认不出 → 「历史无派工」。
 */
export function legacyDispatchOf(operator: string): string {
  const crew = crewOfOperator(operator)
  return crew === null ? LEGACY_NO_DISPATCH : `历史派工-${crew}`
}

/* ------------------------------ 材料核对 ------------------------------ */

/** 材料用量规范化：去全部空白后比较，避免「80 kg」与「80kg」误判不符 */
export function normalizeMaterial(text: string): string {
  return text.replace(/\s+/g, '')
}
