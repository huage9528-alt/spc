import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic, Table, Tabs, Tag, Tooltip, message, notification } from 'antd'
import { ArrowUpOutlined, CheckCircleOutlined, ClockCircleOutlined, DeleteOutlined, EditOutlined, ExclamationCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, ThunderboltOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/api'
import { formatDate, formatDateTime } from '../../../utils'

const DEPARTMENTS = ['计划', '采购', '生产', '品质', '仓储']
const WORKSPACES = [
  { key: 'planner_hub', label: '计划排产工作台' },
  { key: 'plan_board', label: '已排计划' },
  { key: 'schedule_board', label: '排产看板' },
]
const PLANNER_HUB_TABS = [
  { key: 'todo_workbench', label: '待处理' },
  { key: 'change_events', label: '变更事件' },
]
const BUCKET_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'lean', label: '精益' },
  { value: 'assembly', label: '装配-组装' },
  { value: 'packaging', label: '装配-包装' },
  { value: 'mixed', label: '组装+包装' },
  { value: 'pending', label: '待确认' },
]
const PLAN_BUCKET_VIEW_OPTIONS = [
  { key: 'all', label: '全部计划' },
  { key: 'lean', label: '精益页面' },
  { key: 'assembly', label: '组装页面' },
  { key: 'packaging', label: '包装页面' },
]
const WORKSPACE_STORAGE_KEY = 'production_schedule_workspace_v3'
const TODO_FILTER_OPTIONS = [
  { value: 'all', label: '全部待处理' },
  { value: 'reschedule', label: '待重排' },
  { value: 'ready', label: '待排产' },
  { value: 'pending', label: '待确认' },
]
const TODO_BUCKET_WORKSPACE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'lean', label: '精益' },
  { value: 'assembly', label: '组装' },
  { value: 'packaging', label: '包装' },
]
const PLAN_SCOPE_OPTIONS = [
  { value: 'active', label: '当前计划' },
  { value: 'reschedule', label: '待重排' },
  { value: 'history', label: '历史计划' },
]
const EVENT_TYPE_OPTIONS = [
  { value: 'all', label: '全部事件' },
  { value: 'upph_change', label: 'UPPH变化' },
  { value: 'bucket_change', label: '排产段变化' },
  { value: 'due_date_change', label: '交期变化' },
  { value: 'quantity_change', label: '数量变化' },
]

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  planned: { label: '已计划', color: 'blue' },
  in_progress: { label: '执行中', color: 'processing' },
  completed: { label: '已完成', color: 'success' },
  delayed: { label: '延期', color: 'warning' },
  cancelled: { label: '已取消', color: 'default' },
}

const PRIORITY_MAP: Record<string, { label: string; color: string }> = {
  low: { label: '低', color: 'default' },
  normal: { label: '普通', color: 'blue' },
  high: { label: '高', color: 'orange' },
  urgent: { label: '紧急', color: 'red' },
}

const RISK_MAP: Record<string, { label: string; color: string }> = {
  red: { label: '红色', color: 'red' },
  yellow: { label: '黄色', color: 'gold' },
  blue: { label: '蓝色', color: 'blue' },
  green: { label: '绿色', color: 'green' },
}

const IMPACT_MAP: Record<string, { label: string; color: string; priority: number }> = {
  high: { label: '高', color: 'red', priority: 1 },
  medium: { label: '中', color: 'orange', priority: 2 },
  low: { label: '低', color: 'blue', priority: 3 },
}

const EVENT_TYPE_MAP: Record<string, { label: string; color: string }> = {
  upph_change: { label: 'UPPH变化', color: 'purple' },
  bucket_change: { label: '排产段变化', color: 'magenta' },
  due_date_change: { label: '交期变化', color: 'gold' },
  quantity_change: { label: '数量变化', color: 'cyan' },
}

const DELIVERY_STATUS_MAP: Record<string, { label: string; color: string }> = {
  delayed: { label: '已延期', color: 'red' },
  upcoming: { label: '临期', color: 'orange' },
  normal: { label: '正常', color: 'green' },
  early: { label: '提前', color: 'blue' },
  unknown: { label: '待确认', color: 'default' },
}

const BUCKET_COLOR_MAP: Record<string, string> = {
  lean: 'blue',
  assembly: 'purple',
  packaging: 'cyan',
  mixed: 'gold',
  pending: 'default',
}

const ORDER_POOL_STATUS_COLOR_MAP: Record<string, string> = {
  ready: 'success',
  pending: 'warning',
  excluded: 'default',
  scheduled: 'processing',
}

const TODO_STATUS_META: Record<string, { label: string; color: string; priority: number }> = {
  reschedule: { label: '待重排', color: 'error', priority: 0 },
  ready: { label: '待排产', color: 'processing', priority: 1 },
  pending: { label: '待确认', color: 'warning', priority: 2 },
}

const ORDER_STAT_CARD_STYLE_MAP: Record<string, { background: string; border: string }> = {
  ready: { background: '#e6f4ff', border: '#91caff' },
  pending: { background: '#fff7e6', border: '#ffd591' },
  excluded: { background: '#fafafa', border: '#d9d9d9' },
  scheduled: { background: '#f6ffed', border: '#b7eb8f' },
  missing_upph: { background: '#fff1f0', border: '#ffa39e' },
}

const LEAN_CAPACITY_LOAD_MAP: Record<string, { label: string; color: string }> = {
  normal: { label: '正常', color: 'success' },
  overtime: { label: '需加班', color: 'warning' },
  sunday_production: { label: '周日生产', color: 'processing' },
  move_earlier: { label: '需前挪', color: 'error' },
}

const CopyableText = ({ value, label = '内容' }: { value?: string | number | null; label?: string }) => {
  const [copied, setCopied] = useState(false)
  if (value === null || value === undefined || value === '') return '-'

  const handleCopy = async () => {
    const text = String(value).trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      message.success(`已复制${label}`)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      message.error(`复制${label}失败，请手动复制`)
    }
  }

  return (
    <Tooltip title={copied ? `${label}已复制` : `点击复制${label}`}>
      <span
        role="button"
        tabIndex={0}
        onClick={handleCopy}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            handleCopy()
          }
        }}
        style={{
          cursor: 'copy',
          userSelect: 'text',
          color: copied ? '#389e0d' : '#1677ff',
          textDecoration: copied ? 'none' : 'underline',
          textDecorationStyle: 'dotted',
          textUnderlineOffset: 3,
        }}
      >
        {value}
      </span>
    </Tooltip>
  )
}

const renderCopyableText = (value?: string | number | null, label = '内容') => <CopyableText value={value} label={label} />
const normalizePlanBoardBucket = (bucket?: string | null) => (
  bucket && ['lean', 'assembly', 'packaging'].includes(bucket) ? bucket : 'all'
)

const getTaskNo = (row: any) => {
  if (row?.task_no) return row.task_no
  if (!row?.id) return null
  const referenceDate = row?.created_at || row?.plan_date
  const datePart = referenceDate ? dayjs(referenceDate).format('YYYYMMDD') : '00000000'
  const versionPart = row?.plan_version || 1
  return `SC${datePart}-${String(row.id).padStart(6, '0')}-V${versionPart}`
}

const getTargetReadyDateValue = (row: any) => {
  if (row?.target_ready_date) return row.target_ready_date
  if (row?.customer_due_date) return dayjs(row.customer_due_date).subtract(2, 'day').format('YYYY-MM-DD')
  if (row?.source_promised_date) return dayjs(row.source_promised_date).subtract(2, 'day').format('YYYY-MM-DD')
  return null
}

const renderDeliveryStatusTag = (statusValue?: string, row?: any) => {
  const item = DELIVERY_STATUS_MAP[statusValue || 'unknown'] || DELIVERY_STATUS_MAP.unknown
  const targetReadyDate = getTargetReadyDateValue(row)
  if (statusValue === 'delayed') {
    return <Tag color={item.color} icon={<ExclamationCircleOutlined />}>{item.label}</Tag>
  }
  if (statusValue === 'upcoming') {
    return <Tag color={item.color} icon={<ClockCircleOutlined />}>{item.label}</Tag>
  }
  if (statusValue === 'early') {
    const aheadDays = targetReadyDate && row?.end_date
      ? Math.max(dayjs(targetReadyDate).startOf('day').diff(dayjs(row.end_date).startOf('day'), 'day'), 0)
      : 0
    return <Tag color={item.color} icon={<ArrowUpOutlined />}>{aheadDays > 0 ? `${item.label}${aheadDays}天` : item.label}</Tag>
  }
  if (statusValue === 'normal') {
    return <Tag color={item.color} icon={<CheckCircleOutlined />}>{item.label}</Tag>
  }
  return <Tag color={item.color}>{item.label}</Tag>
}

const getDelayDaysDisplay = (row: any) => {
  const targetReadyDate = getTargetReadyDateValue(row)
  if (!targetReadyDate || !row?.end_date) return { text: '-', color: '#999' }
  const diffDays = dayjs(row.end_date).startOf('day').diff(dayjs(targetReadyDate).startOf('day'), 'day')
  if (diffDays > 0) return { text: `+${diffDays}天`, color: '#cf1322' }
  if (diffDays < 0) return { text: `提前${Math.abs(diffDays)}天`, color: '#389e0d' }
  return { text: '0天', color: '#1677ff' }
}

const getProjectedRescheduleEndDate = (row: any) => {
  const targetReadyDate = getTargetReadyDateValue(row)
  if (!targetReadyDate || !row?.current_days_needed) return null
  let startDate = dayjs(targetReadyDate).startOf('day').subtract((row.current_days_needed || 1) - 1, 'day')
  const today = dayjs().startOf('day')
  if (startDate.isBefore(today)) startDate = today
  return startDate.add((row.current_days_needed || 1) - 1, 'day')
}

const getProjectedRescheduleStartDate = (row: any) => {
  const targetReadyDate = getTargetReadyDateValue(row)
  if (!targetReadyDate || !row?.current_days_needed) return null
  let startDate = dayjs(targetReadyDate).startOf('day').subtract((row.current_days_needed || 1) - 1, 'day')
  const today = dayjs().startOf('day')
  if (startDate.isBefore(today)) startDate = today
  return startDate
}

const renderBucketTag = (row: any) => {
  const label = row?.schedule_bucket_label || '未归类'
  const color = BUCKET_COLOR_MAP[row?.schedule_bucket || 'pending'] || 'default'
  return <Tag color={color}>{label}</Tag>
}

const renderSchedulingStatusTag = (row: any) => {
  const label = row?.display_status_label || row?.scheduling_status_label || '待确认'
  const color = ORDER_POOL_STATUS_COLOR_MAP[row?.display_status || row?.scheduling_status || 'pending'] || 'default'
  return <Tag color={color}>{label}</Tag>
}

const getReadableSchedulingReason = (row: any) => {
  const reasonCode = String(row?.scheduling_reason_code || '')
  const status = String(row?.display_status || row?.scheduling_status || '')

  if (reasonCode === 'no_capacity_match') return '未命中产能，请检查 BOM/产品编码'
  if (reasonCode === 'non_schedulable_workshop') return '命中其他车间，当前不参与自动排产'
  if (reasonCode === 'bucket_unclassified') return '工序未识别，暂未归类到精益/组装/包装'
  if (reasonCode === 'lean_missing_upph') return '已命中精益，但缺有效 UPPH'
  if (reasonCode === 'missing_upph') return '已命中产能，但缺有效 UPPH'
  if (reasonCode === 'assembly_rule_pending') {
    return status === 'ready' ? '已命中组装，满足排产条件' : '已命中组装，但组装阶段 UPPH 缺失'
  }
  if (reasonCode === 'packaging_rule_pending') {
    return status === 'ready' ? '已命中包装，满足排产条件' : '已命中包装，但包装阶段 UPPH 缺失'
  }
  if (reasonCode === 'mixed_bucket_pending') {
    return status === 'ready' ? '已识别组装+包装两段，满足排产条件' : '同时命中组装/包装，但阶段 UPPH 仍不完整'
  }
  if (reasonCode === 'zero_quantity') return '订单数量无效，当前不参与自动排产'
  if (reasonCode === 'already_scheduled') return '已存在有效排产计划'
  if (reasonCode === 'lean_ready') return '已命中精益，满足排产条件'
  if (reasonCode === 'ready') return '满足排产条件'
  return row?.scheduling_reason || '-'
}

const renderSchedulingReasonCell = (row: any) => {
  const reason = getReadableSchedulingReason(row)
  const details = Array.isArray(row?.scheduling_reason_details)
    ? row.scheduling_reason_details.filter(Boolean)
    : []
  const detailText = details.join('；')

  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      <span>{reason}</span>
      {detailText ? (
        <Tooltip title={detailText}>
          <span style={{ color: '#8c8c8c', fontSize: 12, cursor: 'help' }}>
            {detailText}
          </span>
        </Tooltip>
      ) : null}
    </Space>
  )
}

const renderWorkhourSuggestionCell = (row: any) => {
  if (!row?.recommended_daily_hours) return <span style={{ color: '#999' }}>待试算</span>
  const status = LEAN_CAPACITY_LOAD_MAP[row.capacity_load_status || 'normal'] || LEAN_CAPACITY_LOAD_MAP.normal
  return (
    <Tooltip title={row.work_hour_summary || undefined}>
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <span style={{ fontWeight: 600 }}>{Number(row.recommended_daily_hours).toFixed(2)} 小时/天</span>
        <Tag color={status.color}>{row.capacity_load_status_label || status.label}</Tag>
      </Space>
    </Tooltip>
  )
}

const renderUpphDeltaTag = (row: any) => {
  const current = Number(row?.upph ?? row?.current_upph ?? 0)
  const source = Number(row?.source_upph ?? 0)
  if (!source || !current) return <Tag>待补快照</Tag>
  const deltaRatio = (current - source) / source
  if (Math.abs(deltaRatio) < 0.01) return <Tag>基本不变</Tag>
  if (deltaRatio > 0) return <Tag color="success">{`+${(deltaRatio * 100).toFixed(1)}%`}</Tag>
  return <Tag color="error">{`${(deltaRatio * 100).toFixed(1)}%`}</Tag>
}

const hasConflictAvoidance = (row: any) => String(row?.remark || '').includes('产能避让')

const renderPlanExplainSummaryCell = (row: any) => {
  const targetReadyDate = formatDate(getTargetReadyDateValue(row))
  const summaryParts = [
    targetReadyDate ? `备货目标日 ${targetReadyDate}` : '',
    row?.capacity_load_status_label || '',
    row?.needs_sunday_work ? '周日生产' : '',
    row?.needs_move_earlier ? `前挪 ${row?.move_earlier_days || 0} 天` : '',
    hasConflictAvoidance(row) ? '已避让冲突' : '',
  ].filter(Boolean)

  const detail = row?.work_hour_summary || row?.remark || getReadableSchedulingReason(row)

  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      <span style={{ fontWeight: 500 }}>{summaryParts.join('；') || '按排产规则自动生成'}</span>
      <span style={{ color: '#8c8c8c', fontSize: 12 }}>{detail}</span>
    </Space>
  )
}

const renderPlanExplainPanel = (row: any, options: { leanStandardHours: number; leanMaxHours: number }) => {
  const targetReadyDate = getTargetReadyDateValue(row)
  const steps = [
    row?.customer_due_date || targetReadyDate
      ? `先看交期：客户交期 ${formatDate(row?.customer_due_date || row?.source_promised_date)}，按交期前 ${row?.ready_offset_days || 2} 天倒推出备货目标日 ${formatDate(targetReadyDate)}。`
      : '',
    row?.schedule_bucket === 'lean' && row?.quantity && row?.upph
      ? `再算产能：数量 ${row.quantity}，UPPH ${Number(row.upph).toFixed(2)}，总工时约 ${row?.total_hours ? Number(row.total_hours).toFixed(2) : '-'} 小时。系统先按 ${options.leanStandardHours} 小时/天试算，必要时加班，最高不超过 ${options.leanMaxHours} 小时。`
      : `当前按 ${row?.schedule_bucket_label || '默认'} 规则计算计划窗口。`,
    row?.recommended_daily_hours
      ? `工时结论：当前采用 ${Number(row.recommended_daily_hours).toFixed(2)} 小时/天，负荷状态为 ${row?.capacity_load_status_label || '正常'}${row?.needs_sunday_work ? '，启用周日生产' : ''}${row?.needs_move_earlier ? `，仍需整体前挪 ${row?.move_earlier_days || 0} 天` : ''}。`
      : '',
    hasConflictAvoidance(row)
      ? `冲突处理：当前单原本会与同段已排计划重叠，所以系统已自动前移避让，详细原因见计划备注。`
      : '',
    row?.remark ? `计划备注：${row.remark}` : '',
    row?.start_date || row?.end_date
      ? `最终结果：计划日 ${formatDate(row?.plan_date)}，生产窗口 ${formatDate(row?.start_date)} 至 ${formatDate(row?.end_date)}。`
      : '',
  ].filter(Boolean)

  return (
    <div style={{ padding: '4px 8px' }}>
      <Alert
        showIcon
        type={row?.delivery_status === 'delayed' || row?.needs_move_earlier ? 'warning' : 'info'}
        message="排产逻辑"
        description={
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {steps.map((item, index) => (
              <div key={`${row?.id || row?.order_no}-step-${index}`} style={{ lineHeight: 1.7 }}>
                {index + 1}. {item}
              </div>
            ))}
          </Space>
        }
      />
    </div>
  )
}

export default function SchedulePlans() {
  const [workspace, setWorkspace] = useState('planner_hub')
  const [plannerHubTab, setPlannerHubTab] = useState('todo_workbench')
  const [loading, setLoading] = useState(false)
  const [workHours, setWorkHours] = useState(8)
  const [workHoursByBucket, setWorkHoursByBucket] = useState<Record<string, number>>({})
  const [readyOffsetDays, setReadyOffsetDays] = useState(2)
  const [leanStandardHours, setLeanStandardHours] = useState(8.5)
  const [leanMaxHours, setLeanMaxHours] = useState(12)

  const [todoData, setTodoData] = useState<any[]>([])
  const [todoTotal, setTodoTotal] = useState(0)
  const [todoStats, setTodoStats] = useState<Record<string, number>>({
    ready: 0,
    pending: 0,
    reschedule: 0,
    missing_upph: 0,
  })
  const [orderPage, setOrderPage] = useState(1)
  const [orderPageSize, setOrderPageSize] = useState(20)
  const [orderKeyword, setOrderKeyword] = useState('')
  const [year, setYear] = useState(dayjs().year())
  const [month, setMonth] = useState(dayjs().month() + 1)
  const [riskLevel, setRiskLevel] = useState<string | undefined>()
  const [todoStatusFilter, setTodoStatusFilter] = useState('all')
  const [orderBucketFilter, setOrderBucketFilter] = useState('all')
  const [selectedOrderKeys, setSelectedOrderKeys] = useState<React.Key[]>([])
  const [selectedOrderRows, setSelectedOrderRows] = useState<any[]>([])
  const [refreshingSnapshots, setRefreshingSnapshots] = useState(false)

  const [planData, setPlanData] = useState<any[]>([])
  const [planTotal, setPlanTotal] = useState(0)
  const [planPage, setPlanPage] = useState(1)
  const [planPageSize, setPlanPageSize] = useState(20)
  const [planKeyword, setPlanKeyword] = useState('')
  const [planStatus, setPlanStatus] = useState<string | undefined>()
  const [planDateRange, setPlanDateRange] = useState<[string, string] | null>(null)
  const [planScope, setPlanScope] = useState('active')
  const [planBucketFilter, setPlanBucketFilter] = useState('all')

  const [alertsTab, setAlertsTab] = useState('reschedule_needed')
  const [alertKeyword, setAlertKeyword] = useState('')
  const [alertPage, setAlertPage] = useState(1)
  const [alertPageSize, setAlertPageSize] = useState(20)
  const [eventData, setEventData] = useState<any[]>([])
  const [eventTotal, setEventTotal] = useState(0)
  const [eventStats, setEventStats] = useState<Record<string, number>>({
    upph_change: 0,
    bucket_change: 0,
    due_date_change: 0,
    quantity_change: 0,
    high: 0,
    pending: 0,
    watching: 0,
    resolved: 0,
  })
  const [impactLevel, setImpactLevel] = useState<string | undefined>()
  const [impactBucketFilter, setImpactBucketFilter] = useState('all')
  const [eventTypeFilter, setEventTypeFilter] = useState('all')
  const [onlyPendingEvents, setOnlyPendingEvents] = useState(false)
  const [selectedImpactKeys, setSelectedImpactKeys] = useState<React.Key[]>([])
  const [selectedBatchPlanIds, setSelectedBatchPlanIds] = useState<number[]>([])
  const [batchPreviewOpen, setBatchPreviewOpen] = useState(false)
  const [missingUpphData, setMissingUpphData] = useState<any[]>([])
  const [missingUpphEmptyState, setMissingUpphEmptyState] = useState<any>(null)
  const [alertCounts, setAlertCounts] = useState<Record<string, number>>({
    reschedule_needed: 0,
    capacity_impact: 0,
    missing_upph: 0,
  })

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<any>(null)
  const [batchScheduleOpen, setBatchScheduleOpen] = useState(false)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deletingPlan, setDeletingPlan] = useState<any>(null)
  const [deleteReason, setDeleteReason] = useState('')
  const [backfillPreview, setBackfillPreview] = useState<any>(null)
  const [backfillPreviewOpen, setBackfillPreviewOpen] = useState(false)
  const [planHistoryOpen, setPlanHistoryOpen] = useState(false)
  const [planHistoryData, setPlanHistoryData] = useState<any[]>([])
  const [planHistoryLoading, setPlanHistoryLoading] = useState(false)
  const [planHistoryTarget, setPlanHistoryTarget] = useState<any>(null)
  const [operationLogOpen, setOperationLogOpen] = useState(false)
  const [operationLogData, setOperationLogData] = useState<any[]>([])
  const [operationLogLoading, setOperationLogLoading] = useState(false)
  const [simulateModalOpen, setSimulateModalOpen] = useState(false)
  const [simulateResult, setSimulateResult] = useState<any>(null)
  const [simulateSubmitting, setSimulateSubmitting] = useState(false)
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)
  const [detailRow, setDetailRow] = useState<any>(null)
  const [detailSource, setDetailSource] = useState<'order_pool' | 'plan_board'>('order_pool')
  const [reschedulePreviewOpen, setReschedulePreviewOpen] = useState(false)
  const [reschedulePreviewRow, setReschedulePreviewRow] = useState<any>(null)
  const [form] = Form.useForm()
  const [scheduleForm] = Form.useForm()
  const [batchScheduleForm] = Form.useForm()
  const [simulateForm] = Form.useForm()

  const openPlanBoardView = useCallback((options?: {
    scope?: 'active' | 'reschedule' | 'history'
    bucket?: string
    keyword?: string
    planDate?: string | null
    status?: string
  }) => {
    setWorkspace('plan_board')
    setPlanScope(options?.scope || 'active')
    setPlanPage(1)
    setPlanStatus(options?.status)
    setPlanBucketFilter(normalizePlanBoardBucket(options?.bucket))
    setPlanKeyword(options?.keyword || '')
    setPlanDateRange(options?.planDate ? [options.planDate, options.planDate] : null)
  }, [])

  const switchToPlanBoard = useCallback((options?: {
    bucket?: string
    keyword?: string
    planDate?: string | null
  }) => {
    openPlanBoardView({
      scope: 'active',
      bucket: normalizePlanBoardBucket(options?.bucket),
      keyword: options?.keyword,
      planDate: options?.planDate,
    })
  }, [openPlanBoardView])

  const openLeanPlanBoard = useCallback(() => {
    openPlanBoardView({ scope: 'active', bucket: 'lean' })
  }, [openPlanBoardView])

  const openLeanRescheduleBoard = useCallback(() => {
    openPlanBoardView({ scope: 'reschedule', bucket: 'lean' })
  }, [openPlanBoardView])

  const openRescheduleBoard = useCallback((bucket: string = 'all') => {
    openPlanBoardView({
      scope: 'reschedule',
      bucket: bucket !== 'pending' ? bucket : 'all',
    })
  }, [openPlanBoardView])

  const openBackfillPreview = useCallback((result?: any) => {
    if (result) {
      setBackfillPreview(result)
      setBackfillPreviewOpen(true)
    }
  }, [])

  const openPostScheduleNotification = useCallback((options: {
    title: string
    description: React.ReactNode
    bucket?: string
    keyword?: string
    planDate?: string | null
    type?: 'success' | 'warning'
  }) => {
    const noticeKey = `post-schedule-${Date.now()}`
    const method = options.type === 'warning' ? notification.warning : notification.success
    method({
      key: noticeKey,
      message: options.title,
      description: options.description,
      duration: 8,
      btn: (
        <Space>
          <Button size="small" onClick={() => notification.destroy(noticeKey)}>继续排产</Button>
          <Button
            size="small"
            type="primary"
            onClick={() => {
              notification.destroy(noticeKey)
              switchToPlanBoard({
                bucket: options.bucket,
                keyword: options.keyword,
                planDate: options.planDate,
              })
            }}
          >
            查看已排计划
          </Button>
        </Space>
      ),
    })
  }, [switchToPlanBoard])

  const loadWorkHours = useCallback(async () => {
    try {
      const res: any = await productionApi.getWorkHoursConfig()
      setWorkHours(res.data?.daily_work_hours || 8)
      setWorkHoursByBucket(res.data?.work_hours_by_bucket || {})
      setReadyOffsetDays(res.data?.ready_offset_days || 2)
      setLeanStandardHours(res.data?.lean_standard_daily_hours || 8.5)
      setLeanMaxHours(res.data?.lean_max_daily_hours || 12)
    } catch (e) {
      console.error('获取工作时间配置失败', e)
    }
  }, [])

  const getRecommendedDailyWorkHours = useCallback((bucket?: string | null) => {
    if (bucket && workHoursByBucket[bucket]) return workHoursByBucket[bucket]
    return workHours
  }, [workHours, workHoursByBucket])

  const loadAlertCounts = useCallback(async () => {
    // 暂时收掉这条自动重请求，避免把连接池拖满
    // 等后面快照化架构落地后再恢复
    setAlertCounts((prev) => ({
      ...prev,
      reschedule_needed: 0,
      missing_upph: 0,
    }))
  }, [])

  const loadTodoWorkbench = useCallback(async (force = false) => {
    console.log("=== loadTodoWorkbench START, force=", force);
    if (!force && !(workspace === 'planner_hub' && plannerHubTab === 'todo_workbench')) {
      console.log("=== loadTodoWorkbench: skip (not todo_workbench)");
      return;
    }
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page: orderPage,
        page_size: orderPageSize,
        year,
        month,
      }
      if (orderKeyword.trim()) params.keyword = orderKeyword.trim()
      if (riskLevel) params.risk_level = riskLevel
      if (orderBucketFilter !== 'all') params.schedule_bucket = orderBucketFilter
      if (todoStatusFilter !== 'all') params.todo_status = todoStatusFilter

      console.log("=== loadTodoWorkbench: calling API with params=", params);
      const res: any = await productionApi.getTodoWorkbench(params)
      console.log("=== loadTodoWorkbench: API response=", res);
      setTodoData(res.data?.items || [])
      setTodoTotal(res.data?.total || 0)
      setTodoStats({
        ready: res.data?.stats?.ready || 0,
        pending: res.data?.stats?.pending || 0,
        reschedule: res.data?.stats?.reschedule || 0,
        missing_upph: res.data?.stats?.missing_upph || 0,
        bucket_counts: res.data?.stats?.bucket_counts || { all: 0, lean: 0, assembly: 0, packaging: 0 },
      })
      console.log("=== loadTodoWorkbench: state updated");
    } catch (e: any) {
      console.error("=== loadTodoWorkbench ERROR:", e);
      message.error(e.message || '获取待处理列表失败')
    } finally {
      console.log("=== loadTodoWorkbench: finally, setting loading false");
      setLoading(false)
    }
  }, [month, orderBucketFilter, orderKeyword, orderPage, orderPageSize, plannerHubTab, riskLevel, todoStatusFilter, workspace, year])

  const loadPlanBoard = useCallback(async (force = false) => {
    if (!force && workspace !== 'plan_board') return
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page: planPage,
        page_size: planPageSize,
        is_active: planScope !== 'history',
      }
      if (planKeyword.trim()) params.keyword = planKeyword.trim()
      if (planStatus) params.status = planStatus
      if (planBucketFilter !== 'all') params.schedule_bucket = planBucketFilter
      if (planDateRange) {
        params.date_start = planDateRange[0]
        params.date_end = planDateRange[1]
      }
      if (planScope === 'active') params.needs_reschedule = false
      if (planScope === 'reschedule') params.needs_reschedule = true

      const res: any = await productionApi.listSchedulePlans(params)
      setPlanData(res.data?.items || [])
      setPlanTotal(res.data?.total || 0)
    } catch (e: any) {
      message.error(e.message || '获取排产结果失败')
    } finally {
      setLoading(false)
    }
  }, [planBucketFilter, planDateRange, planKeyword, planPage, planPageSize, planScope, planStatus, workspace])

  const loadImpactPlans = useCallback(async (force = false) => {
    if (!force && !(workspace === 'planner_hub' && plannerHubTab === 'change_events')) return
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page: alertPage,
        page_size: alertPageSize,
        only_pending: onlyPendingEvents,
      }
      if (alertKeyword.trim()) params.keyword = alertKeyword.trim()
      if (impactLevel) params.impact_level = impactLevel
      if (impactBucketFilter !== 'all') params.schedule_bucket = impactBucketFilter
      if (eventTypeFilter !== 'all') params.event_type = eventTypeFilter
      const res: any = await productionApi.listChangeEvents(params)
      setEventData(res.data?.items || [])
      setEventTotal(res.data?.total || 0)
      setEventStats({
        upph_change: res.data?.stats?.upph_change || 0,
        bucket_change: res.data?.stats?.bucket_change || 0,
        due_date_change: res.data?.stats?.due_date_change || 0,
        quantity_change: res.data?.stats?.quantity_change || 0,
        high: res.data?.stats?.high || 0,
        pending: res.data?.stats?.pending || 0,
        watching: res.data?.stats?.watching || 0,
        resolved: res.data?.stats?.resolved || 0,
      })
    } catch (e: any) {
      message.error(e.message || '获取变更事件失败')
    } finally {
      setLoading(false)
    }
  }, [alertKeyword, alertPage, alertPageSize, eventTypeFilter, impactBucketFilter, impactLevel, onlyPendingEvents, plannerHubTab, workspace])

  const loadMissingUpphProducts = useCallback(async (force = false) => {
    // 暂时收掉这条自动重请求，避免把连接池拖满
    // 等后面快照化架构落地后再恢复
    setMissingUpphData([])
    setMissingUpphEmptyState(null)
  }, [])

  const refreshTodoWorkbenchPanel = useCallback(async (force = false) => {
    await loadTodoWorkbench(force)
  }, [loadTodoWorkbench])

  const handleTodoBucketWorkspaceChange = useCallback((value: string) => {
    setOrderBucketFilter(value)
    setOrderPage(1)
    setSelectedOrderKeys([])
    setSelectedOrderRows([])
  }, [])

  const handlePlannerHubTabChange = useCallback((key: string) => {
    setPlannerHubTab(key)
    setSelectedOrderKeys([])
    setSelectedOrderRows([])
    setSelectedImpactKeys([])
    setOrderPage(1)
    setAlertPage(1)
  }, [])

  const handleRefreshTodoSnapshots = useCallback(async () => {
    try {
      setRefreshingSnapshots(true)
      const res: any = await productionApi.refreshTodoSnapshots({
        year,
        month,
        keyword: orderKeyword.trim() || undefined,
        risk_level: riskLevel,
        limit: 300,
      })
      const result = res.data || {}
      message.success(
        `已扫描 ${result.matched_total || 0} 条，刷新 ${result.refreshed_total || 0} 条快照，原本缺失 ${result.stale_total || 0} 条`
      )
      setSelectedOrderKeys([])
      setSelectedOrderRows([])
      await refreshTodoWorkbenchPanel(true)
    } catch (e: any) {
      message.error(e.message || '刷新待处理快照失败')
    } finally {
      setRefreshingSnapshots(false)
    }
  }, [month, orderKeyword, refreshTodoWorkbenchPanel, riskLevel, year])

  useEffect(() => { loadWorkHours() }, [loadWorkHours])
  useEffect(() => { localStorage.setItem(WORKSPACE_STORAGE_KEY, workspace) }, [workspace])

  useEffect(() => {
    const run = async () => {
      try {
        if (workspace === 'planner_hub') {
          if (plannerHubTab === 'todo_workbench') {
            await refreshTodoWorkbenchPanel();
            return;
          }
          if (plannerHubTab === 'change_events') {
            await loadImpactPlans()
            return;
          }
        }
        if (workspace === 'plan_board') {
          await loadPlanBoard();
          return;
        }
      } catch (e) {
        console.error("workspace load error", e);
      }
    }
    run();
  }, [loadImpactPlans, loadPlanBoard, plannerHubTab, refreshTodoWorkbenchPanel, workspace])

  const openDeleteModal = (row: any) => {
    setDeletingPlan(row)
    setDeleteReason('')
    setDeleteModalOpen(true)
  }

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      department: '生产',
      plan_date: dayjs(),
      priority: 'normal',
      status: 'planned',
      daily_work_hours: getRecommendedDailyWorkHours('lean'),
    })
    setModalOpen(true)
  }

  const openEdit = (row: any) => {
    setEditing(row)
    form.setFieldsValue({
      ...row,
      plan_date: row.plan_date ? dayjs(row.plan_date) : null,
      start_date: row.start_date ? dayjs(row.start_date) : null,
      end_date: row.end_date ? dayjs(row.end_date) : null,
    })
    setModalOpen(true)
  }

  const openSchedule = (row: any) => {
    setSelectedOrder(row)
    scheduleForm.resetFields()
    scheduleForm.setFieldsValue({
      order_no: row.order_no,
      line_no: row.line_no,
      product_code: row.product_code,
      model_code: row.product_model,
      quantity: row.order_qty,
      promised_date: row.promised_date ? dayjs(row.promised_date) : null,
      department: '生产',
      plan_date: null,
      upph: row.upph > 0 ? row.upph : undefined,
      daily_work_hours: row.schedule_bucket === 'lean'
        ? row.recommended_daily_hours
        : getRecommendedDailyWorkHours(row.schedule_bucket),
    })
    setScheduleModalOpen(true)
  }

  const openBatchSchedule = () => {
    const schedulableRows = selectedOrderRows.filter((row) => row.todo_kind === 'ready')
    if (schedulableRows.length === 0) {
      message.warning('请先勾选待排产订单')
      return
    }
    const uniqueBuckets = Array.from(new Set(schedulableRows.map((row) => row.schedule_bucket).filter(Boolean)))
    batchScheduleForm.setFieldsValue({
      department: '生产',
      plan_date: null,
      daily_work_hours: uniqueBuckets.length === 1 && uniqueBuckets[0] !== 'lean'
        ? getRecommendedDailyWorkHours(uniqueBuckets[0])
        : undefined,
    })
    setBatchScheduleOpen(true)
  }

  const openBatchReschedulePreview = () => {
    const rows = selectedOrderRows.filter((row) => row.todo_kind === 'reschedule' && row.id)
    if (rows.length === 0) {
      message.warning('请先勾选待重排行')
      return
    }
    setSelectedBatchPlanIds(Array.from(new Set(rows.map((row) => Number(row.id)).filter(Boolean))))
    setBatchPreviewOpen(true)
  }

  const openSimulate = () => {
    setSimulateResult(null)
    simulateForm.resetFields()
    simulateForm.setFieldsValue({
      department: '生产',
      quantity: 4008,
      upph: 122.47,
      promised_date: dayjs().add(15, 'day'),
      consider_existing_plans: true,
    })
    setSimulateModalOpen(true)
  }

  const openOrderDetail = (row: any, source: 'order_pool' | 'plan_board') => {
    setDetailRow(row)
    setDetailSource(source)
    setDetailDrawerOpen(true)
  }

  const openReschedulePreview = (row: any) => {
    setReschedulePreviewRow(row)
    setReschedulePreviewOpen(true)
  }

  const openPlanHistory = async (row: any) => {
    if (!row?.order_no || !row?.line_no) {
      message.warning('缺少订单号或行号，无法查看历史')
      return
    }
    setPlanHistoryTarget(row)
    setPlanHistoryOpen(true)
    setPlanHistoryLoading(true)
    try {
      const res: any = await productionApi.listSchedulePlanHistory({
        order_no: row.order_no,
        line_no: row.line_no,
      })
      setPlanHistoryData(res.data || [])
    } catch (e: any) {
      message.error(e.message || '获取版本历史失败')
    } finally {
      setPlanHistoryLoading(false)
    }
  }

  const openOperationLogs = async (row?: any) => {
    setOperationLogOpen(true)
    setOperationLogLoading(true)
    try {
      const params: Record<string, any> = { page: 1, page_size: 100 }
      if (row?.order_no) params.order_no = row.order_no
      const res: any = await productionApi.listOperationLogs(params)
      setOperationLogData(res.data?.items || [])
    } catch (e: any) {
      message.error(e.message || '获取操作日志失败')
    } finally {
      setOperationLogLoading(false)
    }
  }

  const closeDetailDrawer = () => {
    setDetailDrawerOpen(false)
    setDetailRow(null)
  }

  const refreshAllViews = async () => {
    if (workspace === 'planner_hub') {
      if (plannerHubTab === 'todo_workbench') {
        await refreshTodoWorkbenchPanel(true)
      } else if (plannerHubTab === 'change_events') {
        await loadImpactPlans(true)
      }
    } else if (workspace === 'plan_board') {
      await loadPlanBoard(true)
    }
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      const payload = {
        ...values,
        plan_date: values.plan_date ? values.plan_date.format('YYYY-MM-DD') : null,
        start_date: values.start_date ? values.start_date.format('YYYY-MM-DD') : null,
        end_date: values.end_date ? values.end_date.format('YYYY-MM-DD') : null,
      }
      if (editing) {
        await productionApi.updateSchedulePlan(editing.id, payload)
        message.success('计划已更新')
      } else {
        await productionApi.createSchedulePlan(payload)
        message.success('计划已创建')
      }
      setModalOpen(false)
      loadPlanBoard()
      loadAlertCounts()
    } catch (e: any) {
      if (!e?.errorFields) message.error(e.message || '保存失败')
    }
  }

  const handleAutoSchedule = async () => {
    try {
      const values = await scheduleForm.validateFields()
      const planDate = values.plan_date ? values.plan_date.format('YYYY-MM-DD') : null
      const payload = {
        order_no: values.order_no,
        line_no: values.line_no,
        department: values.department,
        plan_date: planDate,
        upph: selectedOrder?.schedule_bucket === 'lean' ? values.upph : undefined,
        daily_work_hours: values.daily_work_hours ?? undefined,
        owner: values.owner,
      }
      const res: any = await productionApi.autoSchedule(payload)
      const result = res.data?.calculation_result || {}
      setScheduleModalOpen(false)
      await refreshAllViews()
      openPostScheduleNotification({
        title: '排产成功',
        bucket: selectedOrder?.schedule_bucket,
        keyword: values.order_no,
        planDate,
        description: (
          <div>
            <div>{res.data?.message || '已生成排产计划'}</div>
            {result.schedule_bucket === 'mixed' ? (
              <>
                <div style={{ marginTop: 4 }}>
                  组装窗口 {result.assembly_start_date || '-'} ~ {result.assembly_end_date || '-'}
                </div>
                <div style={{ marginTop: 4 }}>
                  包装窗口 {result.packaging_start_date || '-'} ~ {result.packaging_end_date || '-'}
                </div>
              </>
            ) : res.data?.schedule_plan?.plan_date ? (
              <div style={{ marginTop: 4 }}>计划日 {res.data.schedule_plan.plan_date}</div>
            ) : null}
            {result.target_ready_date ? <div style={{ marginTop: 4 }}>备货目标日 {result.target_ready_date}，按交期前 {result.ready_offset_days || readyOffsetDays} 天倒排</div> : null}
            {result.schedule_bucket === 'mixed' ? (
              <>
                <div style={{ marginTop: 4 }}>组装 UPPH {result.assembly_upph || '-'}，每日 {result.assembly_daily_work_hours || '-'} 小时</div>
                <div style={{ marginTop: 4 }}>包装 UPPH {result.packaging_upph || '-'}，每日 {result.packaging_daily_work_hours || '-'} 小时</div>
              </>
            ) : result.total_hours ? <div style={{ marginTop: 4 }}>总工时 {result.total_hours} 小时，每日 {result.daily_work_hours} 小时，预计 {result.days_needed} 天</div> : null}
            {result.work_hour_summary ? <div style={{ marginTop: 4 }}>{result.work_hour_summary}</div> : null}
          </div>
        ),
      })
    } catch (e: any) {
      message.error(e.message || '排产失败')
    }
  }

  const handleBatchSchedule = async () => {
    try {
      const values = await batchScheduleForm.validateFields()
      setLoading(true)
      const planDate = values.plan_date ? values.plan_date.format('YYYY-MM-DD') : null
      const schedulableRows = selectedOrderRows.filter((row) => row.todo_kind === 'ready')
      const res: any = await productionApi.batchAutoSchedule({
        department: values.department,
        plan_date: planDate,
        daily_work_hours: values.daily_work_hours ?? undefined,
        owner: values.owner,
        items: schedulableRows.map((row) => ({
          order_no: row.order_no,
          line_no: row.line_no,
          upph: row.schedule_bucket === 'lean' ? row.upph : undefined,
        })),
      })
      const result = res.data || {}
      const failedItems = Array.isArray(result.items) ? result.items.filter((item: any) => !item.success) : []
      const successItems = Array.isArray(result.items) ? result.items.filter((item: any) => item.success) : []
      const successKeyword = successItems.length === 1 ? successItems[0].order_no : ''
      const successBuckets = Array.from(new Set(
        schedulableRows
          .filter((row) => successItems.some((item: any) => item.order_no === row.order_no && item.line_no === row.line_no))
          .map((row) => row.schedule_bucket)
          .filter(Boolean),
      ))
      const targetBucket = successBuckets.length === 1 ? successBuckets[0] : 'all'

      openPostScheduleNotification({
        title: '批量排产完成',
        type: result.failed_count > 0 ? 'warning' : 'success',
        bucket: targetBucket,
        keyword: successKeyword,
        planDate,
        description: (
          <div>
              <div>成功 {result.success_count || 0} 条</div>
            <div>失败 {result.failed_count || 0} 条</div>
              {!planDate && successItems.length > 0 && <div>计划日未手填时，系统已按倒排开始日自动落计划</div>}
            {(result.delay_warning_count || 0) > 0 && <div>新增延期预警 {result.delay_warning_count} 条</div>}
            {failedItems.slice(0, 5).map((item: any) => (
              <div key={`${item.order_no}-${item.line_no}`} style={{ marginTop: 4 }}>
                {item.order_no}/{item.line_no}: {item.message}
              </div>
            ))}
          </div>
        ),
      })

      setBatchScheduleOpen(false)
      setSelectedOrderKeys([])
      setSelectedOrderRows([])
      await refreshAllViews()
    } catch (e: any) {
      if (!e?.errorFields) message.error(e.message || '批量排产失败')
    } finally {
      setLoading(false)
    }
  }

  const handleSimulate = async () => {
    try {
      const values = await simulateForm.validateFields()
      setSimulateSubmitting(true)
      const res: any = await productionApi.simulateLeanSchedule({
        department: values.department,
        quantity: values.quantity,
        upph: values.upph,
        promised_date: values.promised_date.format('YYYY-MM-DD'),
        consider_existing_plans: values.consider_existing_plans,
      })
      setSimulateResult(res.data || null)
    } catch (e: any) {
      if (!e?.errorFields) message.error(e.message || '试算失败')
    } finally {
      setSimulateSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deletingPlan?.id) return
    try {
      setLoading(true)
      const res: any = await productionApi.getDeleteSchedulePlanPreview(deletingPlan.id, {
        reason: deleteReason?.trim() || undefined,
      })
      const result = res.data || {}
      setDeleteModalOpen(false)
      openBackfillPreview(result)
      message.info(result.affected_count > 0 ? `已生成删除预览，并识别出 ${result.affected_count} 条候选补位计划` : '已生成删除预览，当前没有可补位计划')
    } catch (e: any) {
      message.error(e.message || '获取删除预览失败')
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmDelete = async (executeBackfill: boolean) => {
    if (!deletingPlan?.id) return
    setLoading(true)
    try {
      const res: any = await productionApi.confirmDeleteSchedulePlan(deletingPlan.id, {
        reason: backfillPreview?.reason || deleteReason?.trim() || '计划员手动删除计划',
        execute_backfill: executeBackfill,
      })
      const result = res.data || {}
      const summary = executeBackfill
        ? `已删除计划，并完成 ${result.backfill_success_count || 0} 条补位前滚`
        : '已删除计划，未执行补位'
      message.success(summary)
      setBackfillPreviewOpen(false)
      setBackfillPreview(null)
      setDeletingPlan(null)
      setDeleteReason('')
      await refreshAllViews()
      openPlanBoardView({ scope: 'active', bucket: backfillPreview?.release_bucket || 'all' })
    } catch (e: any) {
      message.error(e.message || (executeBackfill ? '删除并补位失败' : '删除失败'))
    } finally {
      setLoading(false)
    }
  }

  const handleDetectChanges = async () => {
    setLoading(true)
    try {
      const res: any = await productionApi.detectScheduleChanges()
      message.info(res.data?.length ? `已检测到 ${res.data.length} 条变更并标记待重排` : '未检测到订单行变更')
      await refreshAllViews()
    } catch (e: any) {
      message.error(e.message || '检测变更失败')
    } finally {
      setLoading(false)
    }
  }

  const handleReschedule = async (id: number) => {
    setLoading(true)
    try {
      await productionApi.reschedulePlan(id)
      message.success('重排成功')
      await refreshAllViews()
    } catch (e: any) {
      message.error(e.message || '重排失败')
    } finally {
      setLoading(false)
    }
  }

  const getPlanRescheduleActionMeta = (row: any) => {
    const bucket = String(row?.schedule_bucket || '')
    if (bucket === 'assembly' || bucket === 'packaging') {
      return {
        label: row?.needs_reschedule ? '重排' : '重新排',
        title: '确认按最新规则重排这条计划？如果当前订单仍为组装+包装双段，系统会一起重算对应分段计划。',
      }
    }
    return {
      label: row?.needs_reschedule ? '重排' : '重新排',
      title: '确认按最新规则重排这条计划？',
    }
  }

  const handleBatchReschedule = async () => {
    if (selectedBatchPlanIds.length === 0) {
      message.warning('请先选择待重排计划')
      return
    }
    setLoading(true)
    try {
      const res: any = await productionApi.batchReschedulePlans({ plan_ids: selectedBatchPlanIds })
      const result = res.data || {}
      notification[result.failed_count ? 'warning' : 'success']({
        message: '批量重排完成',
        description: (
          <div>
            <div>成功 {result.success_count || 0} 条</div>
            <div>失败 {result.failed_count || 0} 条</div>
            {(result.delay_warning_count || 0) > 0 && <div>新增延期预警 {result.delay_warning_count} 条</div>}
          </div>
        ),
        duration: 6,
      })
      setBatchPreviewOpen(false)
      setSelectedImpactKeys([])
      setSelectedBatchPlanIds([])
      await refreshAllViews()
    } catch (e: any) {
      message.error(e.message || '批量重排失败')
    } finally {
      setLoading(false)
    }
  }

  const handleUpdateEventStatus = async (processStatus: 'watching' | 'resolved' | 'pending', targetEventIds?: string[]) => {
    const eventIds = Array.from(new Set((targetEventIds || selectedImpactKeys).map((item) => String(item)).filter(Boolean)))
    if (eventIds.length === 0) {
      message.warning('请先选择需要处理的事件')
      return
    }
    const statusLabelMap: Record<string, string> = {
      watching: '暂不处理',
      resolved: '已处理',
      pending: '恢复待处理',
    }
    setLoading(true)
    try {
      const res: any = await productionApi.updateChangeEventStatus({
        event_ids: eventIds,
        process_status: processStatus,
      })
      const result = res.data || {}
      if ((result.failed_count || 0) > 0) {
        notification.warning({
          message: `${statusLabelMap[processStatus]}完成`,
          description: `成功 ${result.success_count || 0} 条，失败 ${result.failed_count || 0} 条`,
          duration: 5,
        })
      } else {
        message.success(`${statusLabelMap[processStatus]}完成`)
      }
      setSelectedImpactKeys([])
      setSelectedBatchPlanIds([])
      await refreshAllViews()
    } catch (e: any) {
      message.error(e.message || `${statusLabelMap[processStatus]}失败`)
    } finally {
      setLoading(false)
    }
  }

  const handleSelectImpactRows = useCallback((bucket?: string) => {
    const targetKeys = eventData
      .filter((row: any) => (!bucket || row.schedule_bucket === bucket) && row.process_status === 'pending')
      .map((row: any) => row.event_id)
    setSelectedImpactKeys(targetKeys)
    setSelectedBatchPlanIds(
      Array.from(
        new Set(
          eventData
            .filter((row: any) => targetKeys.includes(row.event_id))
            .map((row: any) => Number(row.id))
            .filter(Boolean),
        ),
      ),
    )
    if (targetKeys.length === 0) {
      message.info(bucket === 'lean' ? '当前没有可勾选的精益变更事件' : '当前没有可勾选的变更事件')
      return
    }
    message.success(bucket === 'lean' ? `已勾选 ${targetKeys.length} 条精益变更事件` : `已勾选 ${targetKeys.length} 条变更事件`)
  }, [eventData])

  const selectedImpactPreviewRows = useMemo(() => {
    const planMap = new Map<number, any>()
    eventData
      .filter((row: any) => selectedBatchPlanIds.includes(Number(row.id)))
      .forEach((row: any) => {
        const current = planMap.get(Number(row.id))
        const currentScore = current ? (IMPACT_MAP[current.impact_level]?.priority || 99) : 99
        const nextScore = IMPACT_MAP[row.impact_level]?.priority || 99
        if (!current || nextScore < currentScore) {
          planMap.set(Number(row.id), row)
        }
      })
    return Array.from(planMap.values()).map((row: any) => {
        const projectedEndDate = getProjectedRescheduleEndDate(row)
        const originalEndDate = row.end_date ? dayjs(row.end_date).startOf('day') : null
        const targetReadyDate = getTargetReadyDateValue(row)
        const changeDays = projectedEndDate && originalEndDate ? projectedEndDate.diff(originalEndDate, 'day') : null
        const projectedStatus = projectedEndDate && targetReadyDate
          ? (projectedEndDate.isAfter(dayjs(targetReadyDate).startOf('day'))
            ? 'delayed'
            : (dayjs(targetReadyDate).startOf('day').diff(projectedEndDate, 'day') >= 2 ? 'early' : 'normal'))
          : 'unknown'
        return {
          ...row,
          target_ready_date: targetReadyDate,
          projected_end_date: projectedEndDate ? projectedEndDate.format('YYYY-MM-DD') : null,
          change_days: changeDays,
          projected_status: projectedStatus,
        }
      })
  }, [eventData, selectedBatchPlanIds])

  const reschedulePreviewData = useMemo(() => {
    if (!reschedulePreviewRow) return null
    const targetReadyDate = getTargetReadyDateValue(reschedulePreviewRow)
    const projectedStartDate = getProjectedRescheduleStartDate(reschedulePreviewRow)
    const projectedEndDate = getProjectedRescheduleEndDate(reschedulePreviewRow)
    const originalEndDate = reschedulePreviewRow?.end_date ? dayjs(reschedulePreviewRow.end_date).startOf('day') : null
    const changeDays = projectedEndDate && originalEndDate ? projectedEndDate.diff(originalEndDate, 'day') : null
    const projectedStatus = projectedEndDate && targetReadyDate
      ? (projectedEndDate.isAfter(dayjs(targetReadyDate).startOf('day'))
        ? 'delayed'
        : (dayjs(targetReadyDate).startOf('day').diff(projectedEndDate, 'day') >= 2 ? 'early' : 'normal'))
      : 'unknown'
    return {
      ...reschedulePreviewRow,
      target_ready_date: targetReadyDate,
      projected_start_date: projectedStartDate ? projectedStartDate.format('YYYY-MM-DD') : null,
      projected_end_date: projectedEndDate ? projectedEndDate.format('YYYY-MM-DD') : null,
      change_days: changeDays,
      projected_status: projectedStatus,
    }
  }, [reschedulePreviewRow])

  const todoCounts = useMemo(() => ({
    reschedule: todoStats.reschedule || 0,
    ready: todoStats.ready || 0,
    pending: todoStats.pending || 0,
  }), [todoStats])

  const todoBucketCounts = useMemo(() => ({
    all: todoStats?.bucket_counts?.all || 0,
    lean: todoStats?.bucket_counts?.lean || 0,
    assembly: todoStats?.bucket_counts?.assembly || 0,
    packaging: todoStats?.bucket_counts?.packaging || 0,
  }), [todoStats])

  const filteredTodoItems = useMemo(() => todoData, [todoData])

  const orderSelectableCount = useMemo(
    () => selectedOrderRows.filter((item) => item.todo_kind === 'ready').length,
    [selectedOrderRows],
  )
  const selectedRescheduleRows = useMemo(
    () => selectedOrderRows.filter((item) => item.todo_kind === 'reschedule'),
    [selectedOrderRows],
  )

  const planStats = useMemo(() => {
    const delayed = planData.filter((item) => item.delivery_status === 'delayed').length
    const statsTitle = planScope === 'active'
      ? '当前计划数'
      : (planScope === 'reschedule' ? '待重排计划' : '历史计划数')
    return [
      { label: statsTitle, value: planTotal, color: '#1677ff' },
      { label: '本页延期', value: delayed, color: '#cf1322' },
      { label: '待重排', value: alertCounts.reschedule_needed, color: '#fa8c16' },
      { label: '产能影响', value: alertCounts.capacity_impact, color: '#722ed1' },
    ]
  }, [alertCounts.capacity_impact, alertCounts.reschedule_needed, planData, planScope, planTotal])

  const orderColumns = [
    {
      title: '订单号',
      dataIndex: 'order_no',
      width: 150,
      fixed: 'left' as const,
      render: (v: string, row: any) => (
        <Button type="link" style={{ padding: 0, height: 'auto' }} onClick={() => openOrderDetail(row, 'order_pool')}>
          {v || '-'}
        </Button>
      ),
    },
    { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
    { title: 'BOM编码', dataIndex: 'bom_no', width: 160, ellipsis: true, render: (v: string) => renderCopyableText(v, 'BOM编码') },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: '数量', dataIndex: 'order_qty', width: 90, render: (v: number) => v ?? '-' },
    { title: '交期', dataIndex: 'promised_date', width: 110, render: (v: string) => formatDate(v) },
    {
      title: '排产段',
      width: 110,
      render: (_: any, row: any) => renderBucketTag(row),
    },
    {
      title: 'UPPH',
      dataIndex: 'upph',
      width: 90,
      render: (v: number) => v > 0 ? Number(v).toFixed(2) : <span style={{ color: '#999' }}>未就绪</span>,
    },
    {
      title: '状态',
      width: 100,
      render: (_: any, row: any) => renderSchedulingStatusTag(row),
    },
    {
      title: '原因',
      width: 400,
      render: (_: any, row: any) => renderSchedulingReasonCell(row),
    },
    {
      title: '操作',
      width: 140,
      fixed: 'right' as const,
      render: (_: any, row: any) => {
        if (row.display_status === 'ready') {
          return (
            <Button type="primary" size="small" icon={<ThunderboltOutlined />} onClick={() => openSchedule(row)}>
              排产
            </Button>
          )
        }
        if (row.display_status === 'scheduled') {
          return (
            <Button size="small" onClick={() => openPlanBoardView({ scope: 'active', keyword: row.order_no })}>
              查看计划
            </Button>
          )
        }
        return (
          <Tooltip title={getReadableSchedulingReason(row) || '当前不可自动排产'}>
            <Button size="small" disabled>
              不可排
            </Button>
          </Tooltip>
        )
      },
    },
  ]

  const todoColumns = [
    {
      title: '订单号',
      dataIndex: 'order_no',
      width: 150,
      fixed: 'left' as const,
      render: (v: string, row: any) => (
        <Button
          type="link"
          style={{ padding: 0, height: 'auto' }}
          onClick={() => openOrderDetail(row, row.todo_kind === 'reschedule' ? 'plan_board' : 'order_pool')}
        >
          {v || '-'}
        </Button>
      ),
    },
    { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: 'BOM编码', dataIndex: 'bom_no', width: 160, ellipsis: true, render: (v: string) => renderCopyableText(v, 'BOM编码') },
    { title: '数量', width: 90, render: (_: any, row: any) => row.order_qty ?? row.quantity ?? '-' },
    { title: '交期', width: 110, render: (_: any, row: any) => formatDate(row.promised_date || row.source_promised_date) },
    {
      title: '排产段',
      width: 110,
      render: (_: any, row: any) => renderBucketTag(row),
    },
    {
      title: '状态',
      width: 100,
      render: (_: any, row: any) => {
        const statusMeta = TODO_STATUS_META[row.todo_kind] || TODO_STATUS_META.pending
        return <Tag color={statusMeta.color}>{row.todo_status_label || statusMeta.label}</Tag>
      },
    },
    {
      title: '原因',
      width: 320,
      render: (_: any, row: any) => {
        if (row.todo_kind === 'reschedule') {
          return (
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <span>{row.reschedule_reason || 'UPPH变化后建议重排'}</span>
              <span style={{ color: '#8c8c8c', fontSize: 12 }}>{row.impact_reason || '-'}</span>
            </Space>
          )
        }
        return renderSchedulingReasonCell(row)
      },
    },
    {
      title: '建议动作',
      width: 120,
      render: (_: any, row: any) => <span style={{ color: '#595959' }}>{row.todo_action_label || '-'}</span>,
    },
    {
      title: '操作',
      width: 140,
      fixed: 'right' as const,
      render: (_: any, row: any) => {
        if (row.todo_kind === 'ready') {
          return (
            <Button type="primary" size="small" icon={<ThunderboltOutlined />} onClick={() => openSchedule(row)}>
              {row.schedule_bucket === 'mixed' ? '生成两段' : '排产'}
            </Button>
          )
        }
        if (row.todo_kind === 'reschedule') {
          return (
            <Button size="small" type="primary" onClick={() => openReschedulePreview(row)}>
              预览重排
            </Button>
          )
        }
        return (
          <Button size="small" onClick={() => openOrderDetail(row, 'order_pool')}>
            查看
          </Button>
        )
      },
    },
  ]

  const planColumns = [
    {
      title: '任务号',
      dataIndex: 'task_no',
      width: 180,
      render: (_: string, row: any) => renderCopyableText(getTaskNo(row), '排产任务号'),
    },
    {
      title: '订单号',
      dataIndex: 'order_no',
      width: 160,
      render: (v: string, row: any) => (
        <Button type="link" style={{ padding: 0, height: 'auto' }} onClick={() => openOrderDetail(row, 'plan_board')}>
          {v || '-'}
        </Button>
      ),
    },
    { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '版本', dataIndex: 'plan_version', width: 80, render: (v: number) => `V${v || 1}` },
    { title: 'BOM编码', dataIndex: 'bom_no', width: 180, render: (v: string) => renderCopyableText(v, 'BOM编码') },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: '型号', dataIndex: 'model_code', width: 220, ellipsis: true, render: (v: string) => v || '-' },
    { title: '数量', dataIndex: 'quantity', width: 90, render: (v: number) => v ?? '-' },
    {
      title: '排产段',
      width: 110,
      render: (_: any, row: any) => renderBucketTag(row),
    },
    { title: 'UPPH', dataIndex: 'upph', width: 90, render: (v: number) => v ? Number(v).toFixed(2) : '-' },
    {
      title: 'UPPH差异',
      width: 110,
      render: (_: any, row: any) => renderUpphDeltaTag(row),
    },
    {
      title: '工时建议',
      width: 170,
      render: (_: any, row: any) => renderWorkhourSuggestionCell(row),
    },
    { title: '客户交期', dataIndex: 'customer_due_date', width: 110, render: (v: string, row: any) => formatDate(v || row.source_promised_date) },
    { title: '备货目标日', dataIndex: 'target_ready_date', width: 120, render: (v: string, row: any) => formatDate(v || getTargetReadyDateValue(row)) },
    { title: '开始日期', dataIndex: 'start_date', width: 110, render: (v: string) => <Tag color="blue">{formatDate(v)}</Tag> },
    { title: '预计备货完成', dataIndex: 'end_date', width: 120, render: (v: string, row: any) => <Tag color={row.delivery_status === 'delayed' ? 'red' : 'green'}>{formatDate(v)}</Tag> },
    {
      title: '延期',
      width: 100,
      render: (_: any, row: any) => {
        const delayInfo = getDelayDaysDisplay(row)
        return <span style={{ color: delayInfo.color, fontWeight: 600 }}>{delayInfo.text}</span>
      },
    },
    {
      title: '交付状态',
      dataIndex: 'delivery_status',
      width: 100,
      render: (v: string, row: any) => renderDeliveryStatusTag(v, row),
    },
    {
      title: '计划状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => <Tag color={STATUS_MAP[v]?.color || 'default'}>{STATUS_MAP[v]?.label || v}</Tag>,
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      width: 90,
      render: (v: string) => <Tag color={PRIORITY_MAP[v]?.color || 'default'}>{PRIORITY_MAP[v]?.label || v}</Tag>,
    },
    { title: '负责人', dataIndex: 'owner', width: 100, render: (v: string) => v || '-' },
    { title: '创建时间', dataIndex: 'created_at', width: 160, render: (v: string) => formatDateTime(v) },
    {
      title: '为什么这样排',
      width: 320,
      render: (_: any, row: any) => renderPlanExplainSummaryCell(row),
    },
    {
      title: '操作',
      width: 240,
      fixed: 'right' as const,
      render: (_: any, row: any) => {
        const rescheduleAction = getPlanRescheduleActionMeta(row)
        return (
          <Space size={4}>
          <Button size="small" onClick={() => openPlanHistory(row)}>历史</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => openDeleteModal(row)} />
          {row.needs_reschedule ? (
            <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={() => openReschedulePreview(row)}>
              {rescheduleAction.label}
            </Button>
          ) : (
            <Popconfirm title={rescheduleAction.title} onConfirm={() => handleReschedule(row.id)}>
              <Button size="small" type="default" icon={<ThunderboltOutlined />}>
                {rescheduleAction.label}
              </Button>
            </Popconfirm>
          )}
        </Space>
        )
      },
    },
  ]

  const rescheduleColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 150, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '排产段', width: 110, render: (_: any, row: any) => renderBucketTag(row) },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: '数量', dataIndex: 'quantity', width: 90, render: (v: number) => v ?? '-' },
    { title: '原UPPH', dataIndex: 'source_upph', width: 90, render: (v: number) => v ?? '-' },
    { title: '当前UPPH', dataIndex: 'upph', width: 90, render: (v: number) => v ?? '-' },
    {
      title: '重排原因',
      dataIndex: 'reschedule_reason',
      width: 300,
      ellipsis: true,
      render: (v: string, row: any) => (
        <Space direction="vertical" size={2}>
          <span>{v || '-'}</span>
          <span style={{ color: '#8c8c8c', fontSize: 12 }}>{row.impact_reason || '-'}</span>
        </Space>
      ),
    },
    { title: '交期', dataIndex: 'customer_due_date', width: 110, render: (v: string, row: any) => formatDate(v || row.source_promised_date) },
    { title: '结束日期', dataIndex: 'end_date', width: 110, render: (v: string) => formatDate(v) },
    {
      title: '操作',
      width: 120,
      fixed: 'right' as const,
      render: (_: any, row: any) => (
        <Popconfirm title="确认重排这条计划？" onConfirm={() => handleReschedule(row.id)}>
          <Button size="small" type="primary" icon={<ThunderboltOutlined />}>立即重排</Button>
        </Popconfirm>
      ),
    },
  ]

  const quickRescheduleColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 130, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 80, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '排产段', width: 100, render: (_: any, row: any) => renderBucketTag(row) },
    {
      title: '重排原因',
      dataIndex: 'reschedule_reason',
      width: 260,
      ellipsis: true,
      render: (v: string, row: any) => (
        <Space direction="vertical" size={2}>
          <span>{v || '-'}</span>
          <span style={{ color: '#8c8c8c', fontSize: 12 }}>{row.impact_reason || '-'}</span>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 90,
      render: (_: any, row: any) => (
        <Button size="small" type="link" onClick={() => handleReschedule(row.id)}>
          立即重排
        </Button>
      ),
    },
  ]

  const impactColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 150, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
    {
      title: '排产段',
      width: 110,
      render: (_: any, row: any) => renderBucketTag(row),
    },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: '数量', dataIndex: 'quantity', width: 90, render: (v: number) => v ?? '-' },
    {
      title: '影响程度',
      dataIndex: 'impact_level',
      width: 100,
      render: (v: string) => <Tag color={IMPACT_MAP[v]?.color || 'default'}>{IMPACT_MAP[v]?.label || v}</Tag>,
    },
    { title: '排产UPPH', dataIndex: 'source_upph', width: 90, render: (v: number) => v ?? '-' },
    { title: '当前UPPH', dataIndex: 'current_upph', width: 90, render: (v: number) => v ?? '-' },
    {
      title: '变化幅度',
      dataIndex: 'upph_delta_ratio',
      width: 110,
      render: (v: number) => <span style={{ color: (v || 0) < 0 ? '#cf1322' : '#1677ff', fontWeight: 600 }}>{`${((v || 0) * 100).toFixed(1)}%`}</span>,
    },
    { title: '原预计天数', dataIndex: 'planned_days_needed', width: 110, render: (v: number) => v ?? '-' },
    { title: '现预计天数', dataIndex: 'current_days_needed', width: 110, render: (v: number) => v ?? '-' },
    { title: '交期', dataIndex: 'source_promised_date', width: 110, render: (v: string) => formatDate(v) },
    { title: '说明', dataIndex: 'impact_reason', width: 280, ellipsis: true, render: (v: string) => v || '-' },
  ]

  const changeEventColumns = [
    {
      title: '事件类型',
      width: 110,
      render: (_: any, row: any) => {
        const eventMeta = EVENT_TYPE_MAP[row.event_type] || { label: row.event_type || '变更事件', color: 'default' }
        return <Tag color={eventMeta.color}>{eventMeta.label}</Tag>
      },
    },
    { title: '订单号', dataIndex: 'order_no', width: 150, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '排产段', width: 110, render: (_: any, row: any) => renderBucketTag(row) },
    {
      title: '变更前后值',
      width: 180,
      render: (_: any, row: any) => (
        <Space direction="vertical" size={2}>
          <span>变更前 {row.before_value_text || '-'}</span>
          <span>变更后 {row.after_value_text || '-'}</span>
        </Space>
      ),
    },
    {
      title: '影响说明',
      dataIndex: 'change_summary',
      width: 320,
      render: (v: string, row: any) => (
        <Space direction="vertical" size={2}>
          <span>{v || '-'}</span>
          <span style={{ color: '#8c8c8c', fontSize: 12 }}>{row.impact_reason || '-'}</span>
        </Space>
      ),
    },
    {
      title: '建议动作',
      width: 120,
      render: (_: any, row: any) => <span>{row.needs_reschedule ? '建议重排' : '建议关注'}</span>,
    },
    {
      title: '处理状态',
      width: 150,
      render: (_: any, row: any) => (
        <Space direction="vertical" size={2}>
          <Tag color={row.process_status === 'pending' ? 'red' : row.process_status === 'resolved' ? 'green' : 'default'}>
            {row.process_status_label || (row.process_status === 'pending' ? '待处理' : row.process_status === 'resolved' ? '已处理' : '暂不处理')}
          </Tag>
          {(row.process_operator || row.process_at) && (
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>
              {[row.process_operator || '-', row.process_at ? formatDateTime(row.process_at) : ''].filter(Boolean).join(' / ')}
            </span>
          )}
        </Space>
      ),
    },
    {
      title: '操作',
      width: 280,
      fixed: 'right' as const,
      render: (_: any, row: any) => (
        <Space size={4}>
          <Button size="small" type="primary" disabled={!row.needs_reschedule || row.process_status === 'resolved'} onClick={() => openReschedulePreview(row)}>
            预览重排
          </Button>
          {row.process_status === 'pending' ? (
            <>
              <Button size="small" onClick={() => handleUpdateEventStatus('watching', [row.event_id])}>暂不处理</Button>
              <Button size="small" onClick={() => handleUpdateEventStatus('resolved', [row.event_id])}>已处理</Button>
            </>
          ) : (
            <Button size="small" onClick={() => handleUpdateEventStatus('pending', [row.event_id])}>恢复待处理</Button>
          )}
          <Button size="small" onClick={() => openOrderDetail(row, 'plan_board')}>
            查看
          </Button>
        </Space>
      ),
    },
  ]

  const missingUpphColumns = [
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: '产品型号', dataIndex: 'product_model', width: 220, ellipsis: true, render: (v: string) => v || '-' },
    { title: '订单数', dataIndex: 'order_count', width: 90, render: (v: number) => v ?? '-' },
    { title: '总数量', dataIndex: 'total_quantity', width: 120, render: (v: number) => v ?? '-' },
    { title: '最近交期', dataIndex: 'latest_promised_date', width: 120, render: (v: string) => formatDate(v) },
    { title: '首次出现订单号', dataIndex: 'first_order_no', width: 160, render: (v: string) => v || '-' },
    {
      title: '状态',
      width: 100,
      render: () => <Tag color="red">缺少UPPH</Tag>,
    },
  ]

  const batchPreviewColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 170, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 100, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '原UPPH', dataIndex: 'source_upph', width: 100, render: (v: number) => v ?? '-' },
    { title: '新UPPH', dataIndex: 'current_upph', width: 100, render: (v: number) => v ?? '-' },
    { title: '原结束', dataIndex: 'end_date', width: 110, render: (v: string) => formatDate(v) },
    { title: '新结束', dataIndex: 'projected_end_date', width: 110, render: (v: string) => formatDate(v) || '-' },
    {
      title: '变化',
      dataIndex: 'change_days',
      width: 120,
      render: (v: number | null) => {
        if (v === null || v === undefined) return <Tag color="default">无法预估</Tag>
        if (v > 0) return <Tag color="red">+{v}天</Tag>
        if (v < 0) return <Tag color="green">{v}天</Tag>
        return <Tag color="blue">无变化</Tag>
      },
    },
    {
      title: '预估状态',
      dataIndex: 'projected_status',
      width: 120,
      render: (v: string, row: any) => renderDeliveryStatusTag(v, { target_ready_date: row.target_ready_date, end_date: row.projected_end_date }),
    },
  ]

  const backfillColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 170, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 100, render: (v: string) => renderCopyableText(v, '行号') },
    {
      title: '排产段',
      dataIndex: 'schedule_bucket_label',
      width: 110,
      render: (v: string, row: any) => <Tag color={BUCKET_COLOR_MAP[row?.schedule_bucket || 'pending'] || 'default'}>{v || row?.schedule_bucket || '-'}</Tag>,
    },
    { title: '当前计划日', dataIndex: 'current_plan_date', width: 120, render: (v: string) => formatDate(v) },
    { title: '建议顶到', dataIndex: 'suggested_plan_date', width: 120, render: (v: string) => <Tag color="blue">{formatDate(v)}</Tag> },
    { title: '当前开始', dataIndex: 'current_start_date', width: 120, render: (v: string) => formatDate(v) },
    { title: '当前结束', dataIndex: 'current_end_date', width: 120, render: (v: string) => formatDate(v) },
  ]

  return (
    <div>
      <div className="card-modern" style={{ padding: '12px 20px', marginBottom: 16 }}>
        <Tabs
          activeKey={workspace}
          onChange={(key) => {
            setWorkspace(key)
            setSelectedOrderKeys([])
            setSelectedOrderRows([])
            setSelectedImpactKeys([])
            setOrderPage(1)
            setPlanPage(1)
            setAlertPage(1)
          }}
          items={WORKSPACES.map((item) => ({ key: item.key, label: item.label }))}
        />

        {workspace === 'planner_hub' && (
          <Tabs
            activeKey={plannerHubTab}
            onChange={handlePlannerHubTabChange}
            items={PLANNER_HUB_TABS.map((item) => ({ key: item.key, label: item.label }))}
          />
        )}

        {workspace === 'planner_hub' && plannerHubTab === 'todo_workbench' && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Tabs
              activeKey={orderBucketFilter}
              onChange={handleTodoBucketWorkspaceChange}
              items={TODO_BUCKET_WORKSPACE_OPTIONS.map((item) => ({
                key: item.value,
                label: `${item.label} (${todoBucketCounts[item.value as keyof typeof todoBucketCounts] || 0})`,
              }))}
            />
            <Row gutter={12}>
              {[
                { key: 'reschedule', label: '待重排', value: todoCounts.reschedule, color: '#cf1322' },
                { key: 'ready', label: '待排产', value: todoCounts.ready, color: '#1677ff' },
                { key: 'pending', label: '待确认', value: todoCounts.pending, color: '#fa8c16' },
              ].map((item) => (
                <Col key={item.label} xs={12} md={8}>
                  {(() => {
                    const isActive = todoStatusFilter === item.key
                    return (
                      <div
                        className="card-modern"
                        style={{
                          padding: 16,
                          cursor: 'pointer',
                          background: isActive ? '#f0f5ff' : '#fff',
                          border: isActive ? '1px solid #1677ff' : '1px solid #f0f0f0',
                          boxShadow: isActive ? '0 0 0 2px rgba(22,119,255,0.08)' : 'none',
                        }}
                        onClick={() => {
                          setTodoStatusFilter(item.key)
                          setSelectedOrderKeys([])
                          setSelectedOrderRows([])
                        }}
                      >
                        <Statistic title={item.label} value={item.value} valueStyle={{ color: item.color, fontSize: 24 }} />
                      </div>
                    )
                  })()}
                </Col>
              ))}
            </Row>
            <Row gutter={12} align="middle">
              <Col>
                <Select value={year} onChange={(v) => { setYear(v); setOrderPage(1) }} style={{ width: 110 }} options={Array.from({ length: 7 }, (_, i) => ({ value: dayjs().year() - 3 + i, label: `${dayjs().year() - 3 + i}年` }))} />
              </Col>
              <Col>
                <Select value={month} onChange={(v) => { setMonth(v); setOrderPage(1) }} style={{ width: 90 }} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}月` }))} />
              </Col>
              <Col>
                <Input
                  prefix={<SearchOutlined />}
                  value={orderKeyword}
                  onChange={(e) => { setOrderKeyword(e.target.value); setOrderPage(1) }}
                  placeholder="搜索订单/BOM/产品"
                  allowClear
                  style={{ width: 240 }}
                />
              </Col>
              <Col>
                <Select value={todoStatusFilter} onChange={(v) => { setTodoStatusFilter(v); setSelectedOrderKeys([]); setSelectedOrderRows([]) }} style={{ width: 130 }} options={TODO_FILTER_OPTIONS} />
              </Col>
              <Col flex="auto" />
              <Col>
                <Space>
                  <span style={{ color: '#595959' }}>
                    当前入口 {todoTotal} 条，待排产 {todoCounts.ready} 条，待重排 {todoCounts.reschedule} 条，已选 {selectedOrderRows.length} 条
                  </span>
                  <Button onClick={handleDetectChanges}>检测变更</Button>
                  <Button loading={refreshingSnapshots} onClick={handleRefreshTodoSnapshots}>刷新快照</Button>
                  <Button icon={<ReloadOutlined />} onClick={() => { refreshTodoWorkbenchPanel(true) }}>刷新</Button>
                  <Tooltip title={orderSelectableCount > 0 ? `当前已选中 ${orderSelectableCount} 条待排产订单` : '当前未勾选待排产订单'}>
                    <Button type="primary" icon={<ThunderboltOutlined />} disabled={selectedOrderRows.length === 0} onClick={openBatchSchedule}>
                      批量排产
                    </Button>
                  </Tooltip>
                  <Tooltip title={selectedRescheduleRows.length > 0 ? `当前已选中 ${selectedRescheduleRows.length} 条待重排行` : '当前未勾选待重排行'}>
                    <Button type="primary" ghost icon={<ThunderboltOutlined />} disabled={selectedRescheduleRows.length === 0} onClick={openBatchReschedulePreview}>
                      批量重排
                    </Button>
                  </Tooltip>
                </Space>
              </Col>
            </Row>
          </Space>
        )}

        {workspace === 'plan_board' && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Row gutter={12}>
              {planStats.map((item) => (
                <Col key={item.label} xs={12} md={6}>
                  <div className="card-modern" style={{ padding: 16 }}>
                    <Statistic title={item.label} value={item.value} valueStyle={{ color: item.color, fontSize: 24 }} />
                  </div>
                </Col>
              ))}
            </Row>
            <Row gutter={12} align="middle">
              <Col>
                <Select value={planScope} onChange={(v) => { setPlanScope(v); setPlanPage(1) }} style={{ width: 120 }} options={PLAN_SCOPE_OPTIONS} />
              </Col>
              <Col>
                <Input
                  prefix={<SearchOutlined />}
                  value={planKeyword}
                  onChange={(e) => { setPlanKeyword(e.target.value); setPlanPage(1) }}
                  placeholder="搜索订单/产品/型号"
                  allowClear
                  style={{ width: 240 }}
                />
              </Col>
              <Col>
                <Select allowClear placeholder="计划状态" value={planStatus} onChange={(v) => { setPlanStatus(v); setPlanPage(1) }} style={{ width: 130 }} options={Object.entries(STATUS_MAP).map(([value, item]) => ({ value, label: item.label }))} />
              </Col>
              <Col>
                <DatePicker.RangePicker onChange={(dates) => {
                  setPlanDateRange(dates && dates[0] && dates[1] ? [dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')] : null)
                  setPlanPage(1)
                }} />
              </Col>
              <Col flex="auto" />
              <Col>
                <Space>
                  <Button onClick={openSimulate}>测试试算</Button>
                  <Button onClick={openLeanPlanBoard}>只看精益计划</Button>
                  <Button onClick={openLeanRescheduleBoard}>只看精益待重排</Button>
                  <Button onClick={() => openOperationLogs()}>操作日志</Button>
                  <Button icon={<ReloadOutlined />} onClick={() => { loadPlanBoard(true) }}>刷新</Button>
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增计划</Button>
                </Space>
              </Col>
            </Row>
            <Tabs
              activeKey={planBucketFilter}
              onChange={(key) => {
                setPlanBucketFilter(key)
                setPlanPage(1)
              }}
              items={PLAN_BUCKET_VIEW_OPTIONS.map((item) => ({ key: item.key, label: item.label }))}
            />
          </Space>
        )}

        {workspace === 'planner_hub' && plannerHubTab === 'change_events' && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Row gutter={12} align="middle">
              <Col>
                <Statistic title="待处理事件" value={eventStats.pending} />
              </Col>
              <Col>
                <Statistic title="高影响" value={eventStats.high} />
              </Col>
              <Col>
                <Statistic title="UPPH变化" value={eventStats.upph_change} />
              </Col>
              <Col>
                <Statistic title="排产段变化" value={eventStats.bucket_change} />
              </Col>
              <Col>
                <Statistic title="交期变化" value={eventStats.due_date_change} />
              </Col>
              <Col>
                <Statistic title="数量变化" value={eventStats.quantity_change} />
              </Col>
              <Col>
                <Statistic title="暂不处理" value={eventStats.watching} />
              </Col>
              <Col>
                <Statistic title="已处理" value={eventStats.resolved} />
              </Col>
              <Col flex="auto" />
              <Col>
                <Input
                  prefix={<SearchOutlined />}
                  value={alertKeyword}
                  onChange={(e) => { setAlertKeyword(e.target.value); setAlertPage(1) }}
                  placeholder="搜索订单/产品/负责人"
                  allowClear
                  style={{ width: 220 }}
                />
              </Col>
              <Col>
                <Select value={impactBucketFilter} onChange={(v) => { setImpactBucketFilter(v); setAlertPage(1) }} style={{ width: 130 }} options={BUCKET_OPTIONS} />
              </Col>
              <Col>
                <Select allowClear placeholder="影响等级" value={impactLevel} onChange={(v) => { setImpactLevel(v); setAlertPage(1) }} style={{ width: 120 }} options={Object.entries(IMPACT_MAP).map(([value, item]) => ({ value, label: item.label }))} />
              </Col>
              <Col>
                <Select value={eventTypeFilter} onChange={(v) => { setEventTypeFilter(v); setAlertPage(1) }} style={{ width: 130 }} options={EVENT_TYPE_OPTIONS} />
              </Col>
              <Col>
                <Button type={onlyPendingEvents ? 'primary' : 'default'} onClick={() => { setOnlyPendingEvents((prev) => !prev); setAlertPage(1) }}>
                  {onlyPendingEvents ? '只看待处理' : '全部事件'}
                </Button>
              </Col>
              <Col>
                <Space>
                  <Button onClick={() => handleSelectImpactRows('lean')}>勾选当前精益</Button>
                  <Button disabled={selectedImpactKeys.length === 0} onClick={() => handleUpdateEventStatus('watching')}>批量暂不处理</Button>
                  <Button disabled={selectedImpactKeys.length === 0} onClick={() => handleUpdateEventStatus('resolved')}>批量已处理</Button>
                  <Button icon={<ReloadOutlined />} onClick={() => { loadImpactPlans(true) }}>刷新</Button>
                  <Button type="primary" icon={<ThunderboltOutlined />} disabled={selectedBatchPlanIds.length === 0} onClick={() => setBatchPreviewOpen(true)}>
                    预览并重排
                  </Button>
                </Space>
              </Col>
            </Row>
          </Space>
        )}

        {workspace === 'schedule_board' && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              showIcon
              type="info"
              message="排产看板入口已预留"
              description="这里后续承接甘特图、时间轴、车间泳道、组装包装衔接、产能负荷和拖拽调整。当前先保留工作台和已排计划原功能不变。"
            />
            <Row gutter={12}>
              <Col xs={24} md={8}>
                <div className="card-modern" style={{ padding: 16, minHeight: 120 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>未来放什么</div>
                  <div style={{ color: '#595959', lineHeight: 1.8 }}>按日期看生产节奏、按车间看负荷、按订单看组装与包装衔接。</div>
                </div>
              </Col>
              <Col xs={24} md={8}>
                <div className="card-modern" style={{ padding: 16, minHeight: 120 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>先去哪里处理</div>
                  <div style={{ color: '#595959', lineHeight: 1.8 }}>今天先排什么，回工作台；已经排了什么，去已排计划。</div>
                </div>
              </Col>
              <Col xs={24} md={8}>
                <div className="card-modern" style={{ padding: 16, minHeight: 120 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>后续能力</div>
                  <div style={{ color: '#595959', lineHeight: 1.8 }}>甘特图、泳道图、拖拽调整、冲突高亮、延期预警定位。</div>
                </div>
              </Col>
            </Row>
            <Space>
              <Button type="primary" onClick={() => { setWorkspace('planner_hub'); setPlannerHubTab('todo_workbench') }}>回计划排产工作台</Button>
              <Button onClick={() => setWorkspace('plan_board')}>去已排计划</Button>
            </Space>
          </Space>
        )}
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px', marginBottom: ['planner_hub', 'plan_board', 'schedule_board'].includes(workspace) ? 16 : 0 }}>
        {workspace === 'planner_hub' && plannerHubTab === 'todo_workbench' && (
          <Table
            rowKey={(row: any) => row.id || `${row.order_no}-${row.line_no}-${row.todo_kind}`}
            rowSelection={{
              selectedRowKeys: selectedOrderKeys,
              onChange: (keys, rows) => {
                setSelectedOrderKeys(keys)
                setSelectedOrderRows(rows)
              },
              getCheckboxProps: (row: any) => ({ disabled: row.todo_kind === 'pending' }),
            }}
            columns={todoColumns}
            dataSource={filteredTodoItems}
            loading={loading}
            size="small"
            scroll={{ x: 1680, y: 600 }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="当前筛选下没有待处理事项，可切换筛选或先检测变更。"
                />
              ),
            }}
            pagination={{
              total: todoTotal,
              current: orderPage,
              pageSize: orderPageSize,
              showSizeChanger: false,
              showQuickJumper: false,
              onChange: (page, pageSize) => { 
                console.log("=== todo table pagination change:", page, pageSize);
                setOrderPage(page); 
                setOrderPageSize(pageSize);
              },
              showTotal: (total) => `共 ${total} 条`,
            }}
          />
        )}

        {workspace === 'plan_board' && (
          <Table
            rowKey="id"
            columns={planColumns}
            dataSource={planData}
            loading={loading}
            size="small"
            scroll={{ x: 2350, y: 600 }}
            expandable={{
              expandedRowRender: (row: any) => renderPlanExplainPanel(row, { leanStandardHours, leanMaxHours }),
              rowExpandable: (row: any) => Boolean(
                row?.customer_due_date
                || row?.source_promised_date
                || row?.work_hour_summary
                || row?.remark
                || row?.recommended_daily_hours
              ),
            }}
            pagination={{
              total: planTotal,
              current: planPage,
              pageSize: planPageSize,
              showSizeChanger: true,
              onChange: (page, pageSize) => { setPlanPage(page); setPlanPageSize(pageSize) },
              showTotal: (total) => `共 ${total} 条`,
            }}
          />
        )}

        {workspace === 'planner_hub' && plannerHubTab === 'change_events' && (
          <Table
            rowKey="event_id"
            rowSelection={{
              selectedRowKeys: selectedImpactKeys,
              onChange: (keys, rows) => {
                setSelectedImpactKeys(keys)
                setSelectedBatchPlanIds(Array.from(new Set((rows as any[]).map((row) => Number(row.id)).filter(Boolean))))
              },
              getCheckboxProps: (row: any) => ({ disabled: row.process_status !== 'pending' }),
            }}
            columns={changeEventColumns}
            dataSource={eventData}
            loading={loading}
            size="small"
            pagination={{
              total: eventTotal,
              current: alertPage,
              pageSize: alertPageSize,
              showSizeChanger: true,
              onChange: (page, pageSize) => { setAlertPage(page); setAlertPageSize(pageSize) },
              showTotal: (total) => `共 ${total} 条`,
            }}
            scroll={{ x: 1750 }}
            locale={{ emptyText: <Empty description="当前没有需要处理的变更事件。" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        )}
      </div>

      {workspace === 'planner_hub' && plannerHubTab === 'todo_workbench' && (
        <div className="card-modern" style={{ padding: 16 }}>
          <Space size={8} wrap>
            <Tag color="red">待重排 {todoCounts.reschedule}</Tag>
            <Tag color="blue">待排产 {todoCounts.ready}</Tag>
            <Tag color="orange">待确认 {todoCounts.pending}</Tag>
            <Tag color="red">缺UPPH {todoStats.missing_upph || 0}</Tag>
            <Button size="small" onClick={() => { setWorkspace('planner_hub'); handlePlannerHubTabChange('change_events') }}>查看变更事件</Button>
            <Button
              size="small"
              onClick={() => {
                handleTodoBucketWorkspaceChange('lean')
                setTodoStatusFilter('pending')
              }}
            >
              只看精益待确认
            </Button>
          </Space>
        </div>
      )}

      <Drawer
        title={detailSource === 'order_pool' ? '订单详情' : '排产详情'}
        open={detailDrawerOpen}
        onClose={closeDetailDrawer}
        width={760}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Alert
            showIcon
            type="info"
            message={detailSource === 'order_pool' ? '从待排工作台进入的订单详情' : '从已排计划进入的计划详情'}
            description={detailSource === 'order_pool' ? '先看订单基础信息、状态原因和建议工时，再决定是否排产。' : '这里集中看订单来源、排产任务号、计划窗口和为什么这样排。'}
          />
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="基础信息" span={2}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Descriptions bordered size="small" column={2}>
                  <Descriptions.Item label="订单号">{renderCopyableText(detailRow?.order_no, '订单号')}</Descriptions.Item>
                  <Descriptions.Item label="行号">{renderCopyableText(detailRow?.line_no, '行号')}</Descriptions.Item>
                  <Descriptions.Item label="排产任务号">{renderCopyableText(getTaskNo(detailRow), '排产任务号')}</Descriptions.Item>
                  <Descriptions.Item label="排产段">{renderBucketTag(detailRow)}</Descriptions.Item>
                  <Descriptions.Item label="客户">{detailRow?.customer || '-'}</Descriptions.Item>
                  <Descriptions.Item label="负责人">{detailRow?.owner || '-'}</Descriptions.Item>
                  <Descriptions.Item label="产品编码">{renderCopyableText(detailRow?.product_code || detailRow?.source_product_code, '产品编码')}</Descriptions.Item>
                  <Descriptions.Item label="BOM编码">{renderCopyableText(detailRow?.bom_no, 'BOM编码')}</Descriptions.Item>
                  <Descriptions.Item label="型号">{detailRow?.product_model || detailRow?.model_code || detailRow?.source_product_model || '-'}</Descriptions.Item>
                  <Descriptions.Item label="数量">{detailRow?.order_qty ?? detailRow?.quantity ?? detailRow?.source_order_qty ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="客户交期">{formatDate(detailRow?.promised_date || detailRow?.customer_due_date || detailRow?.source_promised_date)}</Descriptions.Item>
                  <Descriptions.Item label="备货目标日">{formatDate(getTargetReadyDateValue(detailRow))}</Descriptions.Item>
                </Descriptions>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="系统判断" span={2}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Descriptions bordered size="small" column={2}>
                  <Descriptions.Item label="当前UPPH">{detailRow?.upph ? Number(detailRow.upph).toFixed(2) : '-'}</Descriptions.Item>
                  <Descriptions.Item label="建议工时">{detailRow?.recommended_daily_hours ? `${Number(detailRow.recommended_daily_hours).toFixed(2)} 小时/天` : '-'}</Descriptions.Item>
                  <Descriptions.Item label="订单状态">{renderSchedulingStatusTag(detailRow)}</Descriptions.Item>
                  <Descriptions.Item label="计划状态">{detailSource === 'plan_board' ? <Tag color={STATUS_MAP[detailRow?.status]?.color || 'default'}>{STATUS_MAP[detailRow?.status]?.label || detailRow?.status || '-'}</Tag> : '-'}</Descriptions.Item>
                  <Descriptions.Item label="开始日期">{formatDate(detailRow?.start_date)}</Descriptions.Item>
                  <Descriptions.Item label="结束日期">{formatDate(detailRow?.end_date)}</Descriptions.Item>
                </Descriptions>
                <div className="card-modern" style={{ padding: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>状态说明</div>
                  {detailSource === 'order_pool' ? renderSchedulingReasonCell(detailRow) : renderPlanExplainSummaryCell(detailRow)}
                </div>
                {detailSource === 'order_pool' && detailRow?.work_hour_summary ? (
                  <Alert
                    showIcon
                    type={detailRow?.needs_move_earlier ? 'warning' : 'info'}
                    message={`${detailRow?.schedule_bucket_label || '当前阶段'}工时建议`}
                    description={detailRow.work_hour_summary}
                  />
                ) : null}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="当前可做什么" span={2}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space wrap>
                  {detailSource === 'order_pool' && detailRow?.display_status === 'ready' ? (
                    <Button
                      type="primary"
                      icon={<ThunderboltOutlined />}
                      onClick={() => {
                        closeDetailDrawer()
                        openSchedule(detailRow)
                      }}
                    >
                      立即排产
                    </Button>
                  ) : null}
                  {detailSource === 'order_pool' && detailRow?.display_status === 'scheduled' ? (
                    <Button
                      onClick={() => {
                        closeDetailDrawer()
                        openPlanBoardView({ scope: 'active', keyword: detailRow?.order_no })
                      }}
                    >
                      查看已排计划
                    </Button>
                  ) : null}
                  {detailSource === 'plan_board' ? (
                    <Button
                      onClick={() => openPlanHistory(detailRow)}
                    >
                      查看历史
                    </Button>
                  ) : null}
                  {detailSource === 'plan_board' ? (
                    <Button
                      icon={<EditOutlined />}
                      onClick={() => {
                        closeDetailDrawer()
                        openEdit(detailRow)
                      }}
                    >
                      编辑计划
                    </Button>
                  ) : null}
                  {detailSource === 'plan_board' ? (
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => {
                        closeDetailDrawer()
                        openDeleteModal(detailRow)
                      }}
                    >
                      删除并看补位
                    </Button>
                  ) : null}
                  {detailSource === 'plan_board' ? (
                    <Button
                      type={detailRow?.needs_reschedule ? 'primary' : 'default'}
                      icon={<ThunderboltOutlined />}
                      onClick={async () => {
                        closeDetailDrawer()
                        if (detailRow?.needs_reschedule) {
                          openReschedulePreview(detailRow)
                          return
                        }
                        await handleReschedule(detailRow.id)
                      }}
                    >
                      {detailRow?.needs_reschedule ? '立即重排' : '重新排'}
                    </Button>
                  ) : null}
                  {detailSource === 'plan_board' ? (
                    <Button onClick={() => openOperationLogs(detailRow)}>
                      查看日志
                    </Button>
                  ) : null}
                </Space>
                <Alert
                  showIcon
                  type="info"
                  message="建议操作"
                  description={
                    detailSource === 'order_pool'
                      ? (
                        detailRow?.display_status === 'ready'
                          ? '这条订单已满足排产条件，可直接发起单条排产；如果同页还有其他可排订单，也可以回列表走批量排产。'
                          : detailRow?.display_status === 'scheduled'
                            ? '这条订单已经有有效计划，建议先看已排计划窗口；如需调整，再走重排或删除补位。'
                            : '这条订单暂时不能直接排产，先看状态原因和工时建议，补齐 UPPH、拆分规则或归类口径后再处理。'
                      )
                      : (
                        detailRow?.needs_reschedule
                          ? '这条计划已被标记为待重排，建议先确认影响范围，再按最新 UPPH 重排。'
                          : '这条计划目前可继续维护；若客户交期或产能发生变化，可直接编辑、删除补位或返回列表集中处理。'
                      )
                  }
                />
              </Space>
            </Descriptions.Item>
          </Descriptions>
          {detailSource === 'plan_board' ? (
            renderPlanExplainPanel(detailRow, { leanStandardHours, leanMaxHours })
          ) : null}
        </Space>
      </Drawer>

      <Modal
        title={`批量重排预览（${selectedImpactPreviewRows.length} 条）`}
        open={batchPreviewOpen}
        destroyOnHidden
        onCancel={() => setBatchPreviewOpen(false)}
        onOk={handleBatchReschedule}
        okText="确认批量重排"
        cancelText="取消"
        width={1100}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ color: '#666' }}>先预览本次重排对完工日期的影响，确认可接受后再执行。</div>
          <Table rowKey="id" columns={batchPreviewColumns} dataSource={selectedImpactPreviewRows} size="small" pagination={false} scroll={{ x: 1000, y: 360 }} />
        </Space>
      </Modal>

      <Modal
        title={`重排预览${reschedulePreviewData?.order_no ? ` - ${reschedulePreviewData.order_no}` : ''}`}
        open={reschedulePreviewOpen}
        destroyOnHidden
        onCancel={() => {
          setReschedulePreviewOpen(false)
          setReschedulePreviewRow(null)
        }}
        onOk={async () => {
          if (!reschedulePreviewData?.id) return
          setReschedulePreviewOpen(false)
          await handleReschedule(reschedulePreviewData.id)
          setReschedulePreviewRow(null)
        }}
        okText="确认重排"
        cancelText="取消"
        confirmLoading={loading}
        width={820}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            showIcon
            type={(reschedulePreviewData?.change_days || 0) > 0 ? 'warning' : 'info'}
            message="先看影响，再决定是否重排"
            description="这里展示触发重排的变更原因，以及按最新订单快照和当前能力口径预估后的日期影响。"
          />
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="这是什么" span={2}>
              {reschedulePreviewData?.order_no || '-'} / {reschedulePreviewData?.line_no || '-'}，当前版本 V{reschedulePreviewData?.plan_version || 1}
            </Descriptions.Item>
            <Descriptions.Item label="为什么弹出来" span={2}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <span>触发事件：{EVENT_TYPE_MAP[reschedulePreviewData?.event_type || 'upph_change']?.label || '变更事件'}</span>
                <span>变更前：{reschedulePreviewData?.before_value_text || '-'}</span>
                <span>变更后：{reschedulePreviewData?.after_value_text || '-'}</span>
                <span>{reschedulePreviewData?.impact_reason || reschedulePreviewData?.reschedule_reason || 'UPPH 变化后建议重排'}</span>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="如果我做了会怎样" span={2}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <span>旧计划：{formatDate(reschedulePreviewData?.start_date)} 至 {formatDate(reschedulePreviewData?.end_date)}</span>
                <span>新计划：{formatDate(reschedulePreviewData?.projected_start_date)} 至 {formatDate(reschedulePreviewData?.projected_end_date)}</span>
                <span>变化天数：{reschedulePreviewData?.change_days === null || reschedulePreviewData?.change_days === undefined ? '无法预估' : `${reschedulePreviewData.change_days > 0 ? '+' : ''}${reschedulePreviewData.change_days} 天`}</span>
                <span>交期影响：{renderDeliveryStatusTag(reschedulePreviewData?.projected_status, { target_ready_date: reschedulePreviewData?.target_ready_date, end_date: reschedulePreviewData?.projected_end_date })}</span>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="我现在可以做什么" span={2}>
              <span>确认后将按最新订单快照与当前能力重新生成新版本计划，旧版本保留为历史记录。</span>
            </Descriptions.Item>
          </Descriptions>
        </Space>
      </Modal>

      <Modal
        title="删除预览与补位建议"
        open={backfillPreviewOpen}
        destroyOnHidden
        onCancel={() => {
          setBackfillPreviewOpen(false)
          setBackfillPreview(null)
        }}
        footer={[
          <Button key="close" onClick={() => {
            setBackfillPreviewOpen(false)
            setBackfillPreview(null)
          }}>关闭</Button>,
          <Button
            key="delete-only"
            type="primary"
            ghost
            loading={loading}
            onClick={() => handleConfirmDelete(false)}
          >
            只删除不补位
          </Button>,
          <Button
            key="execute-backfill"
            type="primary"
            disabled={(backfillPreview?.items || []).length === 0}
            loading={loading}
            onClick={() => {
              handleConfirmDelete(true)
            }}
          >
            删除并补位
          </Button>,
        ]}
        width={980}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            showIcon
            type="info"
            message="这里先预览删除影响，再决定是否执行补位"
            description="当前还没有真正删除。你可以选择“只删除不补位”，也可以选择“删除并补位”；如果执行补位，系统会为前滚计划生成新版本，并保留旧版本历史。"
          />
          <Row gutter={12}>
            <Col span={8}>
              <div className="card-modern" style={{ padding: 16 }}>
                <Statistic title="释放计划日" value={backfillPreview?.release_plan_date || '-'} />
              </div>
            </Col>
            <Col span={8}>
              <div className="card-modern" style={{ padding: 16 }}>
                <Statistic title="释放排产段" value={backfillPreview?.release_bucket_label || '-'} />
              </div>
            </Col>
            <Col span={8}>
              <div className="card-modern" style={{ padding: 16 }}>
                <Statistic title="候选补位数" value={backfillPreview?.affected_count || 0} />
              </div>
            </Col>
          </Row>
          <Table
            rowKey="plan_id"
            columns={backfillColumns}
            dataSource={backfillPreview?.items || []}
            size="small"
            pagination={false}
            scroll={{ x: 1100, y: 320 }}
            locale={{ emptyText: <Empty description="当前没有可前移的补位计划" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        </Space>
      </Modal>

      <Modal
        title={`版本历史${planHistoryTarget?.order_no ? ` - ${planHistoryTarget.order_no}/${planHistoryTarget.line_no}` : ''}`}
        open={planHistoryOpen}
        destroyOnHidden
        onCancel={() => {
          setPlanHistoryOpen(false)
          setPlanHistoryData([])
          setPlanHistoryTarget(null)
        }}
        footer={<Button onClick={() => setPlanHistoryOpen(false)}>关闭</Button>}
        width={1040}
      >
        <Table
          rowKey="id"
          loading={planHistoryLoading}
          size="small"
          pagination={false}
          scroll={{ x: 980, y: 360 }}
          dataSource={planHistoryData}
          columns={[
            { title: '版本', dataIndex: 'plan_version', width: 80, render: (v: number) => `V${v || 1}` },
            { title: '任务号', width: 180, render: (_: any, row: any) => renderCopyableText(getTaskNo(row), '排产任务号') },
            { title: '计划日', dataIndex: 'plan_date', width: 110, render: (v: string) => formatDate(v) },
            { title: '开始日期', dataIndex: 'start_date', width: 110, render: (v: string) => formatDate(v) },
            { title: '结束日期', dataIndex: 'end_date', width: 110, render: (v: string) => formatDate(v) },
            { title: '排产时UPPH', dataIndex: 'source_upph', width: 100, render: (v: number) => v ?? '-' },
            { title: '当前版本状态', width: 100, render: (_: any, row: any) => <Tag color={row.is_active ? 'success' : 'default'}>{row.is_active ? '当前生效' : '历史版本'}</Tag> },
            { title: '操作人', dataIndex: 'created_by', width: 100, render: (v: string) => v || '-' },
            { title: '操作时间', dataIndex: 'created_at', width: 160, render: (v: string) => formatDateTime(v) },
            { title: '备注', dataIndex: 'remark', width: 260, ellipsis: true, render: (v: string) => v || '-' },
          ]}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前订单暂无版本历史。" /> }}
        />
      </Modal>

      <Modal
        title="操作日志"
        open={operationLogOpen}
        destroyOnHidden
        onCancel={() => {
          setOperationLogOpen(false)
          setOperationLogData([])
        }}
        footer={<Button onClick={() => setOperationLogOpen(false)}>关闭</Button>}
        width={980}
      >
        <Table
          rowKey="id"
          loading={operationLogLoading}
          size="small"
          pagination={false}
          scroll={{ x: 920, y: 360 }}
          dataSource={operationLogData}
          columns={[
            { title: '操作时间', dataIndex: 'operation_at', width: 160, render: (v: string) => formatDateTime(v) },
            { title: '操作人', dataIndex: 'operator', width: 110, render: (v: string) => v || '-' },
            { title: '操作类型', dataIndex: 'operation_type', width: 130, render: (v: string) => <Tag color="blue">{v || '-'}</Tag> },
            { title: '订单号', dataIndex: 'order_no', width: 150, render: (v: string) => v || '-' },
            { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => v || '-' },
            { title: '版本', dataIndex: 'plan_version', width: 80, render: (v: number) => v ? `V${v}` : '-' },
            { title: '影响计划', dataIndex: 'affected_plan_ids', width: 180, ellipsis: true, render: (v: string) => v || '-' },
            { title: '备注', dataIndex: 'remark', width: 260, ellipsis: true, render: (v: string) => v || '-' },
          ]}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有操作日志。" /> }}
        />
      </Modal>

      <Modal
        title="生产侧测试试算"
        open={simulateModalOpen}
        destroyOnHidden
        onOk={handleSimulate}
        onCancel={() => {
          setSimulateModalOpen(false)
          setSimulateResult(null)
        }}
        okText="开始试算"
        cancelText="关闭"
        confirmLoading={simulateSubmitting}
        width={860}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            showIcon
            type="info"
            message="这里只试算生产规则，不写真实订单，也不污染订单池。"
            description={`输入数量、UPPH、交期后，系统会按交期前 ${readyOffsetDays} 天备货完成倒排；精益先试 ${leanStandardHours} 小时，再试 ${leanMaxHours} 小时，必要时启用周日并结合当前已排精益计划做冲突避让。`}
          />
          <Form form={simulateForm} layout="vertical">
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="department" label="部门" rules={[{ required: true }]}>
                  <Select options={DEPARTMENTS.map((item) => ({ value: item, label: item }))} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="promised_date" label="客户交期" rules={[{ required: true, message: '请选择客户交期' }]}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="quantity" label="数量" rules={[{ required: true, type: 'number', min: 0.001 }]}>
                  <InputNumber min={0.001} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="upph" label="UPPH" rules={[{ required: true, type: 'number', min: 0.001 }]}>
                  <InputNumber min={0.001} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="consider_existing_plans" label="是否叠加当前已排精益计划" rules={[{ required: true }]}>
                  <Select
                    options={[
                      { value: true, label: '是，连同当前占用一起试算' },
                      { value: false, label: '否，只看这张单自己的理论排法' },
                    ]}
                  />
                </Form.Item>
              </Col>
            </Row>
          </Form>
          {simulateResult ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Row gutter={12}>
                <Col xs={12} md={6}>
                  <div className="card-modern" style={{ padding: 16 }}>
                    <Statistic title="备货目标日" value={simulateResult.target_ready_date || '-'} />
                  </div>
                </Col>
                <Col xs={12} md={6}>
                  <div className="card-modern" style={{ padding: 16 }}>
                    <Statistic title="开始日期" value={simulateResult.start_date || '-'} />
                  </div>
                </Col>
                <Col xs={12} md={6}>
                  <div className="card-modern" style={{ padding: 16 }}>
                    <Statistic title="结束日期" value={simulateResult.end_date || '-'} />
                  </div>
                </Col>
                <Col xs={12} md={6}>
                  <div className="card-modern" style={{ padding: 16 }}>
                    <Statistic title="建议工时" value={simulateResult.recommended_daily_hours ? Number(simulateResult.recommended_daily_hours).toFixed(2) : '-'} suffix="小时/天" />
                  </div>
                </Col>
              </Row>
              <Alert
                showIcon
                type={simulateResult.needs_move_earlier ? 'warning' : 'success'}
                message={`试算结果：${simulateResult.capacity_load_status_label || '-'}`}
                description={
                  <div>
                    <div>{simulateResult.work_hour_summary || '系统已完成精益试算。'}</div>
                    <div style={{ marginTop: 4 }}>
                      总工时 {simulateResult.total_hours ? Number(simulateResult.total_hours).toFixed(2) : '-'} 小时，
                      预计 {simulateResult.days_needed || '-'} 天，
                      计划日 {simulateResult.plan_date || '-'}。
                    </div>
                    {simulateResult.warning ? <div style={{ marginTop: 4 }}>冲突避让：{simulateResult.warning}</div> : null}
                  </div>
                }
              />
              <div className="card-modern" style={{ padding: 16 }}>
                <div style={{ marginBottom: 10, fontWeight: 600 }}>为什么这样排</div>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {(simulateResult.explanation_steps || []).map((step: string, index: number) => (
                    <div key={`simulate-step-${index}`} style={{ lineHeight: 1.8 }}>
                      {index + 1}. {step}
                    </div>
                  ))}
                </Space>
              </div>
            </Space>
          ) : null}
        </Space>
      </Modal>

      <Modal
        title="删除计划"
        open={deleteModalOpen}
        destroyOnHidden
        onOk={handleDelete}
        onCancel={() => {
          setDeleteModalOpen(false)
          setDeletingPlan(null)
          setDeleteReason('')
        }}
        okText="下一步：预览删除影响"
        cancelText="取消"
        confirmLoading={loading}
        width={560}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            showIcon
            type="warning"
            message="先输入删除原因，再预览删除影响"
            description="本次只允许删除未开始、未投产且未锁定的当前有效计划。下一步会先展示释放窗口和补位候选，再由你决定是只删除，还是删除并补位。"
          />
          <div>
            <div style={{ marginBottom: 8, color: '#595959' }}>当前计划</div>
            <div style={{ lineHeight: 1.8 }}>
              <div>订单：{deletingPlan?.order_no || '-'}/{deletingPlan?.line_no || '-'}</div>
              <div>计划日：{formatDate(deletingPlan?.plan_date)}</div>
              <div>排产段：{deletingPlan?.schedule_bucket_label || '-'}</div>
            </div>
          </div>
          <div>
            <div style={{ marginBottom: 8, color: '#595959' }}>删除原因</div>
            <Input.TextArea
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              rows={4}
              placeholder="例如：客户改交期、客户暂缓、计划调整"
              maxLength={200}
              showCount
            />
          </div>
        </Space>
      </Modal>

      <Modal
        title={editing ? '编辑计划排产' : '新增计划排产'}
        open={modalOpen}
        destroyOnHidden
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        width={780}
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="department" label="部门" rules={[{ required: true }]}>
                <Select options={DEPARTMENTS.map((item) => ({ value: item, label: item }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="plan_date" label="计划日期（留空则按倒排开始日）">
                <DatePicker style={{ width: '100%' }} placeholder="不填则系统自动倒排" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="状态">
                <Select options={Object.entries(STATUS_MAP).map(([value, item]) => ({ value, label: item.label }))} />
              </Form.Item>
            </Col>
            <Col span={8}><Form.Item name="order_no" label="订单号"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="product_code" label="产品编码"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="model_code" label="型号"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="quantity" label="数量"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="upph" label="UPPH"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="daily_work_hours" label="每日工时"><InputNumber min={1} max={24} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="owner" label="负责人"><Input /></Form.Item></Col>
            <Col span={8}>
              <Form.Item name="priority" label="优先级">
                <Select options={Object.entries(PRIORITY_MAP).map(([value, item]) => ({ value, label: item.label }))} />
              </Form.Item>
            </Col>
            <Col span={8}><Form.Item name="start_date" label="开始日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="end_date" label="结束日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={24}><Form.Item name="remark" label="备注"><Input.TextArea rows={3} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title={`单条排产${selectedOrder?.schedule_bucket_label ? ` - ${selectedOrder.schedule_bucket_label}` : ''}`}
        open={scheduleModalOpen}
        destroyOnHidden
        onOk={handleAutoSchedule}
        onCancel={() => setScheduleModalOpen(false)}
        width={640}
      >
        <Alert
          showIcon
          type="info"
          style={{ marginBottom: 12 }}
          message={selectedOrder?.schedule_bucket === 'lean'
            ? `精益会自动试算建议工时：先按 ${leanStandardHours} 小时、必要时加班到 ${leanMaxHours} 小时；当前建议 ${selectedOrder?.recommended_daily_hours ? Number(selectedOrder.recommended_daily_hours).toFixed(2) : '-'} 小时/天。`
            : selectedOrder?.schedule_bucket === 'mixed'
              ? `当前订单会自动拆成“组装 + 包装”两条计划；包装按组装前一日释放量滚动承接，不再手填 UPPH。`
              : selectedOrder?.recommended_daily_hours
                ? `${selectedOrder?.schedule_bucket_label || '当前阶段'}会自动试算建议工时；当前建议 ${Number(selectedOrder.recommended_daily_hours).toFixed(2)} 小时/天，当前负荷为 ${selectedOrder?.capacity_load_status_label || '正常'}${selectedOrder?.needs_sunday_work ? '，已启用周日生产' : ''}。`
                : `系统默认按交期前 ${readyOffsetDays} 天备货完成倒排；当前排产段默认工时 ${getRecommendedDailyWorkHours(selectedOrder?.schedule_bucket)} 小时/天，UPPH按明细单价汇总自动计算。`}
        />
        <Form form={scheduleForm} layout="vertical">
          <Row gutter={16}>
            <Col span={12}><Form.Item name="order_no" label="订单号"><Input disabled /></Form.Item></Col>
            <Col span={12}><Form.Item name="line_no" label="行号"><Input disabled /></Form.Item></Col>
            <Col span={12}><Form.Item name="product_code" label="产品编码"><Input disabled /></Form.Item></Col>
            <Col span={12}><Form.Item name="model_code" label="型号"><Input disabled /></Form.Item></Col>
            <Col span={12}><Form.Item name="quantity" label="数量"><InputNumber disabled style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="promised_date" label="交期"><DatePicker disabled style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}>
              <Form.Item name="department" label="部门" rules={[{ required: true }]}>
                <Select options={DEPARTMENTS.map((item) => ({ value: item, label: item }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="plan_date" label="计划日期（留空则按倒排开始日）">
                  <DatePicker style={{ width: '100%' }} placeholder="不填则系统自动倒排" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="upph"
                label="UPPH"
                rules={selectedOrder?.schedule_bucket === 'lean' ? [{ required: true, type: 'number', min: 0.001 }] : []}
              >
                <InputNumber min={0.001} disabled={selectedOrder?.schedule_bucket !== 'lean'} style={{ width: '100%' }} placeholder={selectedOrder?.schedule_bucket === 'lean' ? '' : '装配由系统自动计算'} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="daily_work_hours" label="每日工时（可留空自动）">
                <InputNumber min={1} max={24} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24}><Form.Item name="owner" label="负责人"><Input /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title={`批量排产（${selectedOrderRows.length} 条）`}
        open={batchScheduleOpen}
        destroyOnHidden
        onOk={handleBatchSchedule}
        onCancel={() => setBatchScheduleOpen(false)}
        width={720}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert showIcon type="info" message={`仅勾选“可排产”的订单会执行批量排产，后端会统一处理并返回失败原因；精益默认自动试算工时，先按 ${leanStandardHours} 小时、必要时加班到 ${leanMaxHours} 小时。`} />
          <Form form={batchScheduleForm} layout="vertical">
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item name="department" label="部门" rules={[{ required: true }]}>
                  <Select options={DEPARTMENTS.map((item) => ({ value: item, label: item }))} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="plan_date" label="计划日期（留空则按倒排开始日）">
                  <DatePicker style={{ width: '100%' }} placeholder="不填则系统自动倒排" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="daily_work_hours" label="每日工时（留空则按订单自动试算）">
                  <InputNumber min={1} max={24} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={24}><Form.Item name="owner" label="负责人"><Input placeholder="可选，批量写入负责人" /></Form.Item></Col>
            </Row>
          </Form>
          <Table
            rowKey={(row: any) => `${row.order_no}-${row.line_no}`}
            size="small"
            pagination={false}
            dataSource={selectedOrderRows}
            columns={[
              { title: '订单号', dataIndex: 'order_no', width: 150, render: (v: string) => renderCopyableText(v, '订单号') },
              { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
              { title: '排产段', width: 110, render: (_: any, row: any) => renderBucketTag(row) },
              { title: 'BOM编码', dataIndex: 'bom_no', width: 180, render: (v: string) => renderCopyableText(v, 'BOM编码') },
              { title: '数量', dataIndex: 'order_qty', width: 90, render: (v: number) => v ?? '-' },
              { title: 'UPPH', dataIndex: 'upph', width: 90, render: (v: number) => v ? Number(v).toFixed(2) : '-' },
            ]}
            scroll={{ x: 900, y: 280 }}
          />
        </Space>
      </Modal>
    </div>
  )
}
