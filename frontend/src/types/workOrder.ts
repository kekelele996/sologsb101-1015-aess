/**
 * 作业单（WorkOrder）
 * 养护班组管理：与档案室的「复壮措施」分开记账，
 * 记录派工号、出勤人次、领用材料用量与完工回执状态，两边按措施类型对账。
 */
import type { MeasureType } from './measure'

/** 回执状态：未交 / 已交 / 退回（材料对不上时退回班组重填） */
export type ReceiptState = '未交' | '已交' | '退回'

/** 提交状态：成功 / 失败（失败后只重试班组这一侧，档案室不动） */
export type SubmitState = '成功' | '失败'

/** 来源：正常派工 / 历史补录（升级时按负责人班组归属回填） */
export type WorkOrderSource = '正常派工' | '历史补录'

export const RECEIPT_STATE_OPTIONS: ReceiptState[] = ['未交', '已交', '退回']
export const SUBMIT_STATE_OPTIONS: SubmitState[] = ['成功', '失败']

/** 历史无派工标记：旧数据认不出负责人班组归属时使用 */
export const HISTORY_NO_DISPATCH = '历史无派工'

export interface WorkOrder {
  id: string
  /** 派工号 */
  dispatchNo: string
  /** 关联复壮措施 id（档案室那摊） */
  measureId: string
  /** 措施类型（冗余，便于按类型对账） */
  type: MeasureType
  /** 出勤人次 */
  attendance: number
  /** 领用材料用量（班组侧填报） */
  materialUsage: string
  /** 回执状态 */
  receiptState: ReceiptState
  /** 提交状态 */
  submitState: SubmitState
  /** 来源 */
  source: WorkOrderSource
  /** 班组（历史补录时按负责人归属回填，认不出为「历史无派工」） */
  team: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新开作业单的表单草稿 */
export interface WorkOrderDraft {
  measureId: string
  dispatchNo: string
  type: MeasureType
  team: string
}

/** 班组提交完工回执的表单草稿 */
export interface ReceiptDraft {
  attendance: number
  materialUsage: string
}
