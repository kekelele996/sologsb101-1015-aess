/**
 * 负责人 → 班组归属
 * 升级旧数据时按此回填作业单来源；认不出归属的标成「历史无派工」。
 */

/** 负责人姓名 → 所属班组 */
export const OPERATOR_TEAM: Record<string, string> = {
  王建军: '养护一班',
  李慧: '养护一班',
  张勇: '养护二班',
  赵鹏: '养护二班',
  孙晓: '养护三班',
  周敏: '养护三班',
}

export const TEAM_OPTIONS: string[] = ['养护一班', '养护二班', '养护三班']

/** 按负责人查班组归属，认不出返回「历史无派工」 */
export function teamOfOperator(operator: string): string {
  const name = operator.trim()
  return OPERATOR_TEAM[name] ?? '历史无派工'
}

/** 生成历史补录作业单的派工号（认不出归属时直接用「历史无派工」） */
export function historyDispatchNo(measureId: string, operator: string): string {
  const team = teamOfOperator(operator)
  if (team === '历史无派工') return '历史无派工'
  return `PG-LS-${measureId}`
}
