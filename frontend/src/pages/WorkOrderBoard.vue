<script setup lang="ts">
/**
 * /workorders 养护班组作业单
 * 养护班组这一摊：开立作业单、填出勤人次与领用材料用量、提交完工回执；
 * 材料对不上时回执退回班组重填，提交失败后只重试班组这一侧。
 * 与档案室的复壮措施按措施类型对账。
 * 消费模型：WorkOrder、Measure、Tree；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTreeStore } from '@/stores/treeStore'
import { useWorkOrderStore, materialMatches } from '@/stores/workOrderStore'
import { MEASURE_TYPE_OPTIONS, type MeasureType } from '@/types/measure'
import {
  RECEIPT_STATE_OPTIONS,
  SUBMIT_STATE_OPTIONS,
  type ReceiptDraft,
  type ReceiptState,
  type SubmitState,
  type WorkOrder,
  type WorkOrderDraft,
  type WorkOrderSource,
} from '@/types/workOrder'
import { TEAM_OPTIONS } from '@/utils/team'

const treeStore = useTreeStore()
const workOrderStore = useWorkOrderStore()

const createVisible = ref(false)
const receiptVisible = ref(false)
const submitting = ref(false)
const createFormRef = ref<FormInstance>()
const receiptFormRef = ref<FormInstance>()

const createForm = reactive<WorkOrderDraft>({
  measureId: '',
  dispatchNo: '',
  type: '施肥',
  team: '养护一班',
})

const receiptForm = reactive<ReceiptDraft>({
  attendance: 1,
  materialUsage: '',
})

/** 当前正在提交回执的作业单 */
const currentWorkOrder = ref<WorkOrder | null>(null)

const createRules: FormRules<WorkOrderDraft> = {
  measureId: [{ required: true, message: '请选择关联措施', trigger: 'change' }],
  dispatchNo: [{ required: true, message: '请填写派工号', trigger: 'blur' }],
  type: [{ required: true, message: '请选择措施类型', trigger: 'change' }],
  team: [{ required: true, message: '请填写班组', trigger: 'change' }],
}

const receiptRules: FormRules<ReceiptDraft> = {
  attendance: [{ required: true, message: '请填写出勤人次', trigger: 'blur' }],
  materialUsage: [{ required: true, message: '请填写领用材料用量', trigger: 'blur' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

/** 措施 id → 展示标签 */
const measureLabel = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const m of treeStore.measures) {
    map[m.id] = `${m.type} · ${m.date} · ${treeLabel.value[m.treeId] ?? '（古树已删除）'}`
  }
  return map
})

/** 尚可开立作业单的措施（尚无作业单的措施） */
const availableMeasures = computed(() => {
  const hasWo = new Set(workOrderStore.workOrders.map((wo) => wo.measureId))
  return treeStore.measures.filter((m) => !hasWo.has(m.id))
})

const filtered = computed<WorkOrder[]>(() => {
  const keyword = workOrderStore.filters.keyword.trim().toLowerCase()
  return workOrderStore.workOrders
    .filter((wo) => {
      if (workOrderStore.filters.type !== 'all' && wo.type !== workOrderStore.filters.type) return false
      if (workOrderStore.filters.receiptState !== 'all' && wo.receiptState !== workOrderStore.filters.receiptState)
        return false
      if (workOrderStore.filters.submitState !== 'all' && wo.submitState !== workOrderStore.filters.submitState)
        return false
      if (workOrderStore.filters.source !== 'all' && wo.source !== workOrderStore.filters.source) return false
      if (keyword === '') return true
      return (
        wo.dispatchNo.toLowerCase().includes(keyword) ||
        wo.team.toLowerCase().includes(keyword) ||
        (measureLabel.value[wo.measureId] ?? '').toLowerCase().includes(keyword)
      )
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
})

const stats = computed(() => {
  const total = workOrderStore.workOrders.length
  const submitted = workOrderStore.workOrders.filter((wo) => wo.receiptState === '已交').length
  const returned = workOrderStore.workOrders.filter((wo) => wo.receiptState === '退回').length
  const failed = workOrderStore.workOrders.filter((wo) => wo.submitState === '失败').length
  return { total, submitted, returned, failed }
})

/** 按措施类型对账：档案室措施数 vs 班组作业单数 */
const reconciliation = computed(() => {
  const measureCount = new Map<MeasureType, number>()
  for (const m of treeStore.measures) {
    measureCount.set(m.type, (measureCount.get(m.type) ?? 0) + 1)
  }
  const woMap = new Map<MeasureType, { total: number; submitted: number; returned: number; failed: number }>()
  for (const wo of workOrderStore.workOrders) {
    const entry = woMap.get(wo.type) ?? { total: 0, submitted: 0, returned: 0, failed: 0 }
    entry.total += 1
    if (wo.receiptState === '已交') entry.submitted += 1
    if (wo.receiptState === '退回') entry.returned += 1
    if (wo.submitState === '失败') entry.failed += 1
    woMap.set(wo.type, entry)
  }
  const types = new Set<MeasureType>([...measureCount.keys(), ...woMap.keys()])
  return Array.from(types)
    .map((type) => ({
      type,
      measureCount: measureCount.get(type) ?? 0,
      ...(woMap.get(type) ?? { total: 0, submitted: 0, returned: 0, failed: 0 }),
    }))
    .sort((a, b) => a.type.localeCompare(b.type, 'zh-Hans-CN'))
})

onMounted(() => {
  void treeStore.loadAll()
  void workOrderStore.init()
})

function openCreate(): void {
  if (availableMeasures.value.length === 0) {
    ElMessage.info('所有措施都已开立作业单')
    return
  }
  Object.assign(createForm, {
    measureId: availableMeasures.value[0]?.id ?? '',
    dispatchNo: '',
    type: availableMeasures.value[0]?.type ?? '施肥',
    team: '养护一班',
  })
  createVisible.value = true
}

async function handleCreate(): Promise<void> {
  if (createFormRef.value === undefined) return
  const valid = await createFormRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    await workOrderStore.createWorkOrder({ ...createForm })
    ElMessage.success('作业单已开立')
    createVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '开立失败')
  } finally {
    submitting.value = false
  }
}

function openReceipt(wo: WorkOrder): void {
  currentWorkOrder.value = wo
  Object.assign(receiptForm, { attendance: wo.attendance || 1, materialUsage: wo.materialUsage })
  receiptVisible.value = true
}

async function handleSubmitReceipt(): Promise<void> {
  if (receiptFormRef.value === undefined || currentWorkOrder.value === null) return
  const valid = await receiptFormRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    await workOrderStore.submitReceipt(currentWorkOrder.value.id, { ...receiptForm })
    ElMessage.success(workOrderStore.lastMessage || '回执已提交')
    receiptVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '提交失败')
  } finally {
    submitting.value = false
  }
}

async function handleRetry(wo: WorkOrder): Promise<void> {
  await workOrderStore.retrySubmit(wo.id)
  ElMessage.success(workOrderStore.lastMessage || '已重试')
}

async function handleMarkFailed(wo: WorkOrder): Promise<void> {
  await workOrderStore.markSubmitFailed(wo.id)
  ElMessage.warning(workOrderStore.lastMessage || '已模拟失败')
}

async function handleDelete(wo: WorkOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除作业单「${wo.dispatchNo}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await workOrderStore.deleteWorkOrder(wo.id)
  ElMessage.success('作业单已删除')
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'type') workOrderStore.setFilters({ type: value as MeasureType | 'all' })
  if (key === 'receiptState') workOrderStore.setFilters({ receiptState: value as ReceiptState | 'all' })
  if (key === 'submitState') workOrderStore.setFilters({ submitState: value as SubmitState | 'all' })
  if (key === 'source') workOrderStore.setFilters({ source: value as WorkOrderSource | 'all' })
}

/** 档案室登记材料（供回执弹窗对照） */
function archiveMaterial(wo: WorkOrder): string {
  return treeStore.measures.find((m) => m.id === wo.measureId)?.material ?? '—'
}

/** 班组填报材料与档案室登记是否对得上 */
function materialOk(wo: WorkOrder): boolean {
  if (wo.materialUsage.trim() === '') return true
  return materialMatches(wo.materialUsage, archiveMaterial(wo))
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="作业单总数" :value="stats.total" suffix="项" tone="primary" icon="Tickets" />
      <StatBadge label="已交回执" :value="stats.submitted" suffix="项" tone="success" icon="CircleCheck" />
      <StatBadge label="退回重填" :value="stats.returned" suffix="项" tone="warning" icon="RefreshLeft" />
      <StatBadge label="提交失败" :value="stats.failed" suffix="项" tone="danger" icon="Warning" />
    </div>

    <el-card shadow="never" class="reconcile-card">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">按措施类型对账（档案室措施 vs 班组作业单）</span>
        </div>
      </template>
      <div class="reconcile-grid">
        <div v-for="row in reconciliation" :key="row.type" class="reconcile-item">
          <div class="reconcile-item__type">
            <el-tag type="success" effect="light">{{ row.type }}</el-tag>
          </div>
          <div class="reconcile-item__nums">
            <span>档案室措施 <b>{{ row.measureCount }}</b> 项</span>
            <span>作业单 <b>{{ row.total }}</b> 项</span>
            <span class="ok">已交 {{ row.submitted }}</span>
            <span v-if="row.returned > 0" class="warn">退回 {{ row.returned }}</span>
            <span v-if="row.failed > 0" class="fail">失败 {{ row.failed }}</span>
          </div>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">养护班组作业单</span>
          <el-button type="primary" @click="openCreate" :disabled="availableMeasures.length === 0">
            <el-icon><Plus /></el-icon>
            <span>开立作业单</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="workOrderStore.filters.keyword"
        :fields="[
          { key: 'type', label: '措施类型', options: MEASURE_TYPE_OPTIONS as unknown as string[] },
          { key: 'receiptState', label: '回执状态', options: RECEIPT_STATE_OPTIONS as unknown as string[] },
          { key: 'submitState', label: '提交状态', options: SUBMIT_STATE_OPTIONS as unknown as string[] },
          { key: 'source', label: '来源', options: ['正常派工', '历史补录'] },
        ]"
        :values="{
          type: workOrderStore.filters.type,
          receiptState: workOrderStore.filters.receiptState,
          submitState: workOrderStore.filters.submitState,
          source: workOrderStore.filters.source,
        }"
        :result-text="`命中 ${filtered.length} / ${workOrderStore.workOrders.length} 项`"
        @update:keyword="(value: string) => workOrderStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="workOrderStore.resetFilters()"
      />

      <el-tag v-if="workOrderStore.lastMessage" type="success" effect="plain" class="last-msg">
        {{ workOrderStore.lastMessage }}
      </el-tag>

      <EmptyPanel
        v-if="workOrderStore.workOrders.length === 0 && !workOrderStore.loading"
        title="还没有作业单"
        description="为复壮措施开立作业单，记录派工号、出勤人次与领用材料用量，完工后提交回执。"
        action-text="开立第一条作业单"
        @action="openCreate"
      />

      <el-table
        v-else
        v-loading="workOrderStore.loading"
        :data="filtered"
        row-key="id"
        stripe
      >
        <el-table-column label="派工号" width="170">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.dispatchNo }}</span>
              <span class="cell-sub">{{ row.source }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="关联措施" min-width="240">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ measureLabel[row.measureId] ?? '（措施已删除）' }}</span>
              <span class="cell-sub">班组：{{ row.team }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="出勤人次" width="90" align="center">
          <template #default="{ row }">{{ row.attendance || '—' }}</template>
        </el-table-column>
        <el-table-column label="领用材料用量" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ row.materialUsage || '—' }}</span>
              <span
                v-if="row.materialUsage && row.receiptState !== '已交'"
                class="cell-sub"
                :class="materialOk(row) ? 'ok' : 'fail'"
              >
                {{ materialOk(row) ? '与档案室登记一致' : '与档案室登记不符' }}（档案室：{{ archiveMaterial(row) }}）
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="回执状态" width="100">
          <template #default="{ row }">
            <el-tag
              :type="row.receiptState === '已交' ? 'success' : row.receiptState === '退回' ? 'warning' : 'info'"
              effect="dark"
            >
              {{ row.receiptState }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="提交状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.submitState === '成功' ? 'success' : 'danger'" effect="plain">
              {{ row.submitState }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              :disabled="row.receiptState === '已交'"
              @click="openReceipt(row)"
            >
              {{ row.receiptState === '退回' ? '重填回执' : '提交回执' }}
            </el-button>
            <el-button
              v-if="row.submitState === '失败'"
              link
              type="warning"
              size="small"
              @click="handleRetry(row)"
            >
              重试班组侧
            </el-button>
            <el-button
              v-if="row.receiptState !== '已交' && row.submitState !== '失败'"
              link
              type="info"
              size="small"
              @click="handleMarkFailed(row)"
            >
              模拟失败
            </el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 开立作业单 -->
    <el-dialog v-model="createVisible" title="开立作业单" width="560px">
      <el-form ref="createFormRef" :model="createForm" :rules="createRules" label-width="100px">
        <el-form-item label="关联措施" prop="measureId">
          <el-select
            v-model="createForm.measureId"
            filterable
            style="width: 100%"
            @change="(value: string) => {
              const m = treeStore.measures.find((x) => x.id === value)
              if (m) createForm.type = m.type
            }"
          >
            <el-option
              v-for="m in availableMeasures"
              :key="m.id"
              :value="m.id"
              :label="`${m.type} · ${m.date} · ${treeLabel[m.treeId] ?? ''}`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="派工号" prop="dispatchNo">
          <el-input v-model="createForm.dispatchNo" placeholder="如：PG-2026-001" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="措施类型" prop="type">
              <el-select v-model="createForm.type" style="width: 100%">
                <el-option v-for="item in MEASURE_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="班组" prop="team">
              <el-select v-model="createForm.team" style="width: 100%">
                <el-option v-for="item in TEAM_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleCreate">开立</el-button>
      </template>
    </el-dialog>

    <!-- 提交完工回执 -->
    <el-dialog v-model="receiptVisible" title="提交完工回执" width="560px">
      <el-form ref="receiptFormRef" :model="receiptForm" :rules="receiptRules" label-width="130px">
        <el-form-item label="出勤人次" prop="attendance">
          <el-input-number v-model="receiptForm.attendance" :min="0" :max="9999" style="width: 100%" />
        </el-form-item>
        <el-form-item label="领用材料用量" prop="materialUsage">
          <el-input
            v-model="receiptForm.materialUsage"
            type="textarea"
            :rows="2"
            placeholder="如：基质土 6 m³ + 草炭土 2 m³"
          />
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          :title="`档案室登记材料：${currentWorkOrder ? archiveMaterial(currentWorkOrder) : '—'}。材料用量以档案室登记为准，对不上将退回重填。`"
        />
      </el-form>
      <template #footer>
        <el-button @click="receiptVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmitReceipt">提交回执</el-button>
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

.reconcile-card {
  margin-bottom: 14px;
}

.reconcile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}

.reconcile-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid #ebe5d8;
  border-radius: 8px;
  background: #faf7f0;
}

.reconcile-item__type {
  flex-shrink: 0;
}

.reconcile-item__nums {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 13px;
  color: #6b6257;
}

.reconcile-item__nums b {
  color: #2f2a24;
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

.last-msg {
  margin-bottom: 10px;
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

.cell-sub.ok {
  color: #67c23a;
}

.cell-sub.fail,
.warn {
  color: #e6a23c;
}

.fail {
  color: #f56c6c;
}

.ok {
  color: #67c23a;
}
</style>
