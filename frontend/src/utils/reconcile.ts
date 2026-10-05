/**
 * 两摊对账：养护班组作业单 vs 档案室复壮措施，按「措施类型」逐类核对。
 * 纯函数，不触碰 IndexedDB，供班组页与档案室页共用的 <ReconcilePanel> 消费。
 */
import { MEASURE_TYPE_OPTIONS, type Measure, type MeasureType } from '../types/measure'
import { normalizeMaterial, type WorkOrder } from '../types/workorder'

/** 单个措施类型的对账结果 */
export interface ReconcileRow {
  type: MeasureType
  /** 档案室措施数 / 其中已完成数 */
  measureTotal: number
  measureDone: number
  /** 班组作业单数，按状态细分 */
  orderTotal: number
  working: number
  submitted: number
  returned: number
  archived: number
  /** 材料核对：两边都有账时比较最新登记；一边无账为 null */
  materialMatch: boolean | null
  /** 对账差异描述（空数组 = 账实相符） */
  issues: string[]
}

/** 按措施类型对账：只返回至少有一侧有账的类型 */
export function reconcileByType(measures: Measure[], orders: WorkOrder[]): ReconcileRow[] {
  return MEASURE_TYPE_OPTIONS.map((type) => {
    const ms = measures.filter((row) => row.type === type)
    const os = orders.filter((row) => row.type === type)
    const row: ReconcileRow = {
      type,
      measureTotal: ms.length,
      measureDone: ms.filter((item) => item.state === '已完成').length,
      orderTotal: os.length,
      working: os.filter((item) => item.state === '作业中').length,
      submitted: os.filter((item) => item.state === '已交回执').length,
      returned: os.filter((item) => item.state === '回执退回').length,
      archived: os.filter((item) => item.state === '已归档').length,
      materialMatch: null,
      issues: [],
    }
    if (row.measureTotal === 0 && row.orderTotal === 0) return row

    if (row.measureTotal > 0 && row.orderTotal === 0) {
      row.issues.push(`档案室 ${row.measureTotal} 条措施，班组无作业单`)
    }
    if (row.orderTotal > 0 && row.measureTotal === 0) {
      row.issues.push(`班组 ${row.orderTotal} 张作业单，档案室未登记措施`)
    }
    if (row.returned > 0) {
      row.issues.push(`${row.returned} 张回执被退回，待班组重填再交`)
    }
    if (row.submitted > 0) {
      row.issues.push(`${row.submitted} 张回执待档案室动措施状态`)
    }
    // 材料核对：两边都有账时，以各自最新一条登记互相对账，对不上以档案室登记为准
    if (row.measureTotal > 0 && row.orderTotal > 0) {
      const latestMeasure = [...ms].sort((a, b) => b.date.localeCompare(a.date))[0]
      const latestOrder = [...os].sort((a, b) => b.workDate.localeCompare(a.workDate))[0]
      row.materialMatch = normalizeMaterial(latestMeasure.material) === normalizeMaterial(latestOrder.materialUsed)
      if (!row.materialMatch) {
        row.issues.push('材料用量对不上，以档案室登记为准')
      }
    }
    return row
  }).filter((row) => row.measureTotal > 0 || row.orderTotal > 0)
}

/** 汇总差异条数，用于对账面板顶部提示 */
export function reconcileIssueCount(rows: ReconcileRow[]): number {
  return rows.reduce((sum, row) => sum + row.issues.length, 0)
}
