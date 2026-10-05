<script setup lang="ts">
/**
 * /workorders 养护班组作业单
 * 班组这一摊：开作业单记派工号、出勤人次与领用材料用量，完工后交回执；
 * 回执被退回时按档案室登记重填再交（只重试班组侧，档案室照旧）。
 * 消费模型：WorkOrder、Measure（对账）、Tree；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>、<ReconcilePanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import ReconcilePanel from '@/components/common/ReconcilePanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { emptyWorkOrderDraft, useWorkOrderStore } from '@/stores/workOrderStore'
import { useTreeStore } from '@/stores/treeStore'
import { MEASURE_TYPE_OPTIONS, type MeasureType } from '@/types/measure'
import {
  CREW_OPTIONS,
  WORK_ORDER_STATE_OPTIONS,
  type WorkOrder,
  type WorkOrderDraft,
  type WorkOrderState,
} from '@/types/workorder'

const treeStore = useTreeStore()
const workOrderStore = useWorkOrderStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<WorkOrderDraft>(emptyWorkOrderDraft(''))

const rules: FormRules<WorkOrderDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择措施类型', trigger: 'change' }],
  dispatchNo: [{ required: true, message: '请填写派工号', trigger: 'blur' }],
  crew: [{ required: true, message: '请选择作业班组', trigger: 'change' }],
  crewCount: [{ required: true, message: '请填写出勤人次', trigger: 'blur' }],
  materialUsed: [{ required: true, message: '请填写领用材料用量', trigger: 'blur' }],
  workDate: [{ required: true, message: '请选择作业日期', trigger: 'change' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const filtered = computed<WorkOrder[]>(() => {
  const keyword = workOrderStore.filters.keyword.trim().toLowerCase()
  return workOrderStore.orders.filter((row) => {
    if (workOrderStore.filters.treeId !== 'all' && row.treeId !== workOrderStore.filters.treeId) return false
    if (workOrderStore.filters.type !== 'all' && row.type !== workOrderStore.filters.type) return false
    if (workOrderStore.filters.state !== 'all' && row.state !== workOrderStore.filters.state) return false
    if (keyword === '') return true
    return (
      (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(keyword) ||
      row.dispatchNo.toLowerCase().includes(keyword) ||
      row.crew.toLowerCase().includes(keyword) ||
      row.materialUsed.toLowerCase().includes(keyword)
    )
  })
})

const stats = computed(() => {
  const list = workOrderStore.orders
  const countOf = (state: WorkOrderState): number => list.filter((row) => row.state === state).length
  return {
    total: list.length,
    working: countOf('作业中'),
    submitted: countOf('已交回执'),
    returned: countOf('回执退回'),
    archived: countOf('已归档'),
  }
})

onMounted(() => {
  void treeStore.loadAll()
  void workOrderStore.init()
})

function openCreate(): void {
  const treeId =
    workOrderStore.filters.treeId !== 'all'
      ? workOrderStore.filters.treeId
      : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')
  editingId.value = null
  Object.assign(form, emptyWorkOrderDraft(treeId))
  dialogVisible.value = true
}

function openEdit(row: WorkOrder): void {
  editingId.value = row.id
  Object.assign(form, {
    treeId: row.treeId,
    type: row.type,
    dispatchNo: row.dispatchNo,
    crew: row.crew,
    crewCount: row.crewCount,
    materialUsed: row.materialUsed,
    workDate: row.workDate,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      await workOrderStore.createOrder({ ...form })
      ElMessage.success('作业单已开立')
    } else {
      await workOrderStore.updateOrder(editingId.value, { ...form })
      ElMessage.success('作业单已更新')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: WorkOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除作业单「${row.dispatchNo}」（${row.type}，${row.workDate}）？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await workOrderStore.deleteOrder(row.id)
  ElMessage.success('作业单已删除')
}

/** 交完工回执：失败只重试班组这一侧，档案室照旧 */
async function handleReceipt(row: WorkOrder): Promise<void> {
  const result = await workOrderStore.submitReceipt(row.id)
  if (result.ok) {
    ElMessage.success(result.message)
  } else {
    ElMessage.warning(result.message)
  }
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'treeId') workOrderStore.setFilters({ treeId: value })
  if (key === 'type') workOrderStore.setFilters({ type: value as MeasureType | 'all' })
  if (key === 'state') workOrderStore.setFilters({ state: value as WorkOrderState | 'all' })
}

function stateTagType(state: WorkOrderState): 'info' | 'warning' | 'danger' | 'success' {
  if (state === '已交回执') return 'warning'
  if (state === '回执退回') return 'danger'
  if (state === '已归档') return 'success'
  return 'info'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="作业单总数" :value="stats.total" suffix="张" tone="primary" icon="Histogram" />
      <StatBadge label="作业中" :value="stats.working" suffix="张" tone="info" icon="DataLine" />
      <StatBadge label="已交回执" :value="stats.submitted" suffix="张" tone="warning" icon="TrendCharts" />
      <StatBadge
        label="回执退回"
        :value="stats.returned"
        suffix="张"
        tone="danger"
        icon="Warning"
        hint="材料用量与档案室登记对不上，按档案室登记重填后再交"
      />
      <StatBadge label="已归档" :value="stats.archived" suffix="张" tone="success" icon="PieChart" size="small" />
    </div>

    <ReconcilePanel :measures="treeStore.measures" :orders="workOrderStore.orders" />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">养护班组作业单</span>
          <el-button type="primary" :disabled="treeStore.trees.length === 0" @click="openCreate">
            <el-icon><Plus /></el-icon>
            <span>新开作业单</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="workOrderStore.filters.keyword"
        :fields="[
          {
            key: 'treeId',
            label: '古树',
            options: treeStore.trees.map((tree) => tree.id),
            optionLabels: treeLabel,
          },
          { key: 'type', label: '措施类型', options: MEASURE_TYPE_OPTIONS as unknown as string[] },
          { key: 'state', label: '作业单状态', options: WORK_ORDER_STATE_OPTIONS as unknown as string[] },
        ]"
        :values="{
          treeId: workOrderStore.filters.treeId,
          type: workOrderStore.filters.type,
          state: workOrderStore.filters.state,
        }"
        :result-text="`命中 ${filtered.length} / ${workOrderStore.orders.length} 张`"
        @update:keyword="(value: string) => workOrderStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="workOrderStore.resetFilters()"
      />

      <div v-if="workOrderStore.lastMessage" class="message-row">
        <el-tag type="success" effect="plain">{{ workOrderStore.lastMessage }}</el-tag>
      </div>

      <EmptyPanel
        v-if="workOrderStore.orders.length === 0 && workOrderStore.ready"
        title="还没有作业单"
        description="班组按派工号开作业单，记出勤人次与领用材料用量；完工后交回执，档案室核对后才动措施状态。"
        action-text="新开第一张作业单"
        @action="openCreate"
      />

      <el-table v-else :data="filtered" row-key="id" stripe>
        <el-table-column label="古树" min-width="170">
          <template #default="{ row }">
            {{ treeLabel[row.treeId] ?? '（古树已删除）' }}
          </template>
        </el-table-column>
        <el-table-column label="措施类型" width="110">
          <template #default="{ row }">
            <el-tag type="success" effect="light">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="派工号" width="130">
          <template #default="{ row }">
            <span class="dispatch-no">{{ row.dispatchNo }}</span>
          </template>
        </el-table-column>
        <el-table-column label="班组" width="100">
          <template #default="{ row }">{{ row.crew }}</template>
        </el-table-column>
        <el-table-column label="出勤人次" width="90" align="right">
          <template #default="{ row }">{{ row.crewCount }}</template>
        </el-table-column>
        <el-table-column label="领用材料用量" min-width="200">
          <template #default="{ row }">{{ row.materialUsed }}</template>
        </el-table-column>
        <el-table-column label="作业日期" width="110">
          <template #default="{ row }">{{ row.workDate }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="stateTagType(row.state)" effect="dark">{{ row.state }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="回执" min-width="220">
          <template #default="{ row }">
            <div v-if="row.state === '回执退回'" class="cell-stack">
              <el-tooltip :content="row.returnReason" placement="top" :show-after="200">
                <span class="return-reason">{{ row.returnReason }}</span>
              </el-tooltip>
            </div>
            <span v-else-if="row.receiptAt !== ''" class="cell-sub">
              {{ row.receiptAt.slice(0, 10) }} 已交{{ row.state === '已归档' ? ' · 已归档' : '' }}
            </span>
            <span v-else class="cell-sub">未交</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.state === '作业中' || row.state === '回执退回'"
              link
              type="primary"
              size="small"
              @click="handleReceipt(row)"
            >
              {{ row.state === '回执退回' ? '重填再交' : '交完工回执' }}
            </el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '新开作业单' : '编辑作业单'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.location}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="措施类型" prop="type">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="item in MEASURE_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="派工号" prop="dispatchNo">
              <el-input v-model="form.dispatchNo" placeholder="如：PG-2026-0072" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="作业班组" prop="crew">
              <el-select v-model="form.crew" style="width: 100%">
                <el-option v-for="item in CREW_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="出勤人次" prop="crewCount">
              <el-input-number v-model="form.crewCount" :min="1" :max="99" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="领用材料" prop="materialUsed">
          <el-input
            v-model="form.materialUsed"
            type="textarea"
            :rows="2"
            placeholder="按实际领用填写，如：有机肥 80 kg + 复合肥 15 kg；与档案室登记对不上会被退回"
          />
        </el-form-item>
        <el-form-item label="作业日期" prop="workDate">
          <el-date-picker v-model="form.workDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="完工后在列表点「交完工回执」；材料用量与档案室登记对不上会被退回，按档案室登记重填后再交即可。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.message-row {
  margin-bottom: 12px;
}

.dispatch-no {
  font-family: 'Courier New', monospace;
  font-size: 13px;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.return-reason {
  font-size: 12px;
  color: #c0392b;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
