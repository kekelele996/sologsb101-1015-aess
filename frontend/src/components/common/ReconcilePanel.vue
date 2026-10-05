<script setup lang="ts">
/**
 * <ReconcilePanel> 两摊对账面板
 * 养护班组作业单 vs 档案室复壮措施，按「措施类型」逐类核对；
 * 被班组作业单页与档案室复壮措施页共同消费，两边看到的是同一本对账单。
 */
import { computed } from 'vue'
import type { Measure } from '@/types/measure'
import type { WorkOrder } from '@/types/workorder'
import { reconcileByType, reconcileIssueCount } from '@/utils/reconcile'

const props = defineProps<{
  measures: Measure[]
  orders: WorkOrder[]
}>()

const rows = computed(() => reconcileByType(props.measures, props.orders))
const issueCount = computed(() => reconcileIssueCount(rows.value))
</script>

<template>
  <el-card shadow="never" class="reconcile-panel">
    <template #header>
      <div class="reconcile-panel__header">
        <span class="reconcile-panel__title">两摊对账（按措施类型）</span>
        <el-tag v-if="issueCount > 0" type="warning" effect="dark">差异 {{ issueCount }} 项</el-tag>
        <el-tag v-else type="success" effect="dark">账实相符</el-tag>
      </div>
    </template>

    <el-alert
      v-if="rows.length === 0"
      type="info"
      show-icon
      :closable="false"
      title="两边都还没有账：档案室先登复壮措施，班组再开作业单，对账自动按措施类型汇总。"
    />

    <el-table v-else :data="rows" row-key="type" stripe size="small">
      <el-table-column label="措施类型" width="120">
        <template #default="{ row }">
          <el-tag type="success" effect="light">{{ row.type }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="档案室措施" width="130">
        <template #default="{ row }">
          <span>{{ row.measureTotal }} 条</span>
          <span class="cell-sub">（完成 {{ row.measureDone }}）</span>
        </template>
      </el-table-column>
      <el-table-column label="班组作业单" width="120">
        <template #default="{ row }">{{ row.orderTotal }} 张</template>
      </el-table-column>
      <el-table-column label="回执情况" min-width="200">
        <template #default="{ row }">
          <template v-if="row.orderTotal > 0">
            <el-tag v-if="row.working > 0" size="small" type="info" effect="plain">作业中 {{ row.working }}</el-tag>
            <el-tag v-if="row.submitted > 0" size="small" type="warning" effect="plain">已交回执 {{ row.submitted }}</el-tag>
            <el-tag v-if="row.returned > 0" size="small" type="danger" effect="plain">退回 {{ row.returned }}</el-tag>
            <el-tag v-if="row.archived > 0" size="small" type="success" effect="plain">已归档 {{ row.archived }}</el-tag>
          </template>
          <span v-else class="cell-sub">无作业单</span>
        </template>
      </el-table-column>
      <el-table-column label="材料核对" width="130">
        <template #default="{ row }">
          <el-tag v-if="row.materialMatch === true" size="small" type="success">一致</el-tag>
          <el-tooltip v-else-if="row.materialMatch === false" content="材料用量对不上，以档案室登记为准" placement="top">
            <el-tag size="small" type="danger">对不上</el-tag>
          </el-tooltip>
          <span v-else class="cell-sub">—</span>
        </template>
      </el-table-column>
      <el-table-column label="对账差异" min-width="260">
        <template #default="{ row }">
          <span v-if="row.issues.length === 0" class="cell-ok">账实相符</span>
          <ul v-else class="issue-list">
            <li v-for="issue in row.issues" :key="issue">{{ issue }}</li>
          </ul>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.reconcile-panel {
  margin-bottom: 14px;
}

.reconcile-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.reconcile-panel__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.cell-ok {
  font-size: 12px;
  color: #1e8449;
}

.issue-list {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  color: #b26a00;
  line-height: 1.7;
}
</style>
