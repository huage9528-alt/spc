import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Alert, Badge, Button, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic, Table, Tabs, Tag, Tooltip, message, notification } from 'antd'
import { ArrowUpOutlined, CheckCircleOutlined, ClockCircleOutlined, DeleteOutlined, EditOutlined, ExclamationCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, ThunderboltOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/api'
import { formatDate, formatDateTime } from '../../../utils'
import {
  DEPARTMENTS,
  BUCKET_OPTIONS,
  PLAN_BUCKET_VIEW_OPTIONS,
  TODO_FILTER_OPTIONS,
  TODO_BUCKET_WORKSPACE_OPTIONS,
  PLAN_SCOPE_OPTIONS,
  EVENT_TYPE_OPTIONS,
  STATUS_MAP,
  PRIORITY_MAP,
  RISK_MAP,
  IMPACT_MAP,
  EVENT_TYPE_MAP,
  DELIVERY_STATUS_MAP,
  BUCKET_COLOR_MAP,
  ORDER_POOL_STATUS_COLOR_MAP,
  TODO_STATUS_META,
  ORDER_STAT_CARD_STYLE_MAP,
  LEAN_CAPACITY_LOAD_MAP,
  PAGE_CACHE_TTL_MS,
} from './constants'
import {
  CopyableText,
  renderCopyableText,
  normalizePlanBoardBucket,
  buildScheduleBoardLink,
  getTaskNo,
  getTargetReadyDateValue,
  renderDeliveryStatusTag,
  getDelayDaysDisplay,
  getProjectedRescheduleEndDate,
  getProjectedRescheduleStartDate,
  renderBucketTag,
  renderSchedulingStatusTag,
  getReadableSchedulingReason,
  renderSchedulingReasonCell,
  renderWorkhourSuggestionCell,
  renderUpphDeltaTag,
  hasConflictAvoidance,
  renderPlanExplainSummaryCell,
  renderPlanExplainPanel,
} from './helpers'
import ScheduleModal from '../components/ScheduleModal'
import DeleteModal from '../components/DeleteModal'
import BatchScheduleModal from '../components/BatchScheduleModal'
import RescheduleModal from '../components/RescheduleModal'

const PERF_DEBUG = false

type TodoWorkbenchStats = {
  ready: number
  pending: number
  reschedule: number
  missing_upph: number
  bucket_counts?: {
    all: number
    lean: number
    assembly: number
    packaging: number
  }
  dependency_timings_ms?: Record<string, any>
  timings_ms?: Record<string, any>
  synced_scheduled_snapshots?: number
}

type PlanBoardCacheEntry = {
  ts: number
  items: any[]
  total: number
  backendTimingsMs?: Record<string, any>
  dependencyTimingsMs?: Record<string, any>
}

type PlanBoardInflightResult = {
  items: any[]
  total: number
  apiMs: number
  backendTimingsMs?: Record<string, any>
  dependencyTimingsMs?: Record<string, any>
}

const logSchedulePlansPerf = (event: string, payload: Record<string, any>) => {
  if (!PERF_DEBUG) return
  console.info(`[SchedulePlans:${event}]`, payload)
}

const stringifyPerfPayload = (value: any) => {
  if (!value) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

export default function SchedulePlans() {
  const location = useLocation()
  const navigate = useNavigate()
  const workspace: string = 'plan_board'
  const plannerHubTab: string = 'todo_workbench'
  const [loading, setLoading] = useState(false)
  const [workHours, setWorkHours] = useState(8)
  const [workHoursByBucket, setWorkHoursByBucket] = useState<Record<string, number>>({})
  const [readyOffsetDays, setReadyOffsetDays] = useState(2)
  const [leanStandardHours, setLeanStandardHours] = useState(8.5)
  const [leanMaxHours, setLeanMaxHours] = useState(12)

  const [todoData, setTodoData] = useState<any[]>([])
  const [todoTotal, setTodoTotal] = useState(0)
  const [todoStats, setTodoStats] = useState<TodoWorkbenchStats>({
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
  const [pendingPlanFocusId, setPendingPlanFocusId] = useState<number | null>(null)
  const [highlightPlanId, setHighlightPlanId] = useState<number | null>(null)

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
  const todoWorkbenchCacheRef = useRef<Record<string, { ts: number; items: any[]; total: number; stats: TodoWorkbenchStats }>>({})
  const planBoardCacheRef = useRef<Record<string, PlanBoardCacheEntry>>({})
  const impactPlansCacheRef = useRef<Record<string, { ts: number; items: any[]; total: number; stats: any }>>({})
  const todoWorkbenchInflightRef = useRef<Record<string, Promise<{ items: any[]; total: number; stats: any; apiMs: number }>>>({})
  const planBoardInflightRef = useRef<Record<string, Promise<PlanBoardInflightResult>>>({})
  const impactPlansInflightRef = useRef<Record<string, Promise<{ items: any[]; total: number; stats: any; apiMs: number }>>>({})
  const todoWorkbenchSkipSnapshotReconcileRef = useRef(false)
  const invalidatePageCaches = useCallback(() => {
    todoWorkbenchCacheRef.current = {}
    planBoardCacheRef.current = {}
    impactPlansCacheRef.current = {}
    todoWorkbenchInflightRef.current = {}
    planBoardInflightRef.current = {}
    impactPlansInflightRef.current = {}
  }, [])
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
  const [breakFrozenReason, setBreakFrozenReason] = useState('')
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
    const requestStartedAt = performance.now()
    if (!force && !(workspace === 'planner_hub' && plannerHubTab === 'todo_workbench')) {
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
      const skipSnapshotReconcile = todoWorkbenchSkipSnapshotReconcileRef.current
      if (orderKeyword.trim()) params.keyword = orderKeyword.trim()
      if (riskLevel) params.risk_level = riskLevel
      if (orderBucketFilter !== 'all') params.schedule_bucket = orderBucketFilter
      if (todoStatusFilter !== 'all') params.todo_status = todoStatusFilter
      if (skipSnapshotReconcile) params.skip_snapshot_reconcile = true

      const cacheKey = JSON.stringify(params)
      const cached = todoWorkbenchCacheRef.current[cacheKey]
      if (!force && cached && (Date.now() - cached.ts) < PAGE_CACHE_TTL_MS) {
        setTodoData(cached.items || [])
        setTodoTotal(cached.total || 0)
        setTodoStats(cached.stats || {
          ready: 0,
          pending: 0,
          reschedule: 0,
          missing_upph: 0,
          bucket_counts: { all: 0, lean: 0, assembly: 0, packaging: 0 },
        })
        setLoading(false)
        logSchedulePlansPerf('todo-workbench-cache-hit', {
          total: cached.total || 0,
          cacheAgeMs: Date.now() - cached.ts,
          backendTimingsMs: cached.stats?.timings_ms,
          backendTimingsMsText: stringifyPerfPayload(cached.stats?.timings_ms),
          totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
          params,
        })
        return
      }

      let requestPromise = !force ? todoWorkbenchInflightRef.current[cacheKey] : undefined
      if (!requestPromise) {
        const apiStartedAt = performance.now()
        requestPromise = productionApi.getTodoWorkbench(params).then((res: any) => {
          const apiMs = performance.now() - apiStartedAt
          return {
            items: res.data?.items || [],
            total: res.data?.total || 0,
            stats: {
              ready: res.data?.stats?.ready || 0,
              pending: res.data?.stats?.pending || 0,
              reschedule: res.data?.stats?.reschedule || 0,
              missing_upph: res.data?.stats?.missing_upph || 0,
              bucket_counts: res.data?.stats?.bucket_counts || { all: 0, lean: 0, assembly: 0, packaging: 0 },
              dependency_timings_ms: res.data?.stats?.dependency_timings_ms || undefined,
              timings_ms: res.data?.stats?.timings_ms || undefined,
              synced_scheduled_snapshots: res.data?.stats?.synced_scheduled_snapshots || 0,
            },
            apiMs,
          }
        }).finally(() => {
          delete todoWorkbenchInflightRef.current[cacheKey]
        })
        if (!force) {
          todoWorkbenchInflightRef.current[cacheKey] = requestPromise
        }
      } else {
        logSchedulePlansPerf('todo-workbench-inflight-hit', {
          params,
        })
      }

      const { items, total, stats, apiMs } = await requestPromise
      todoWorkbenchSkipSnapshotReconcileRef.current = false
      todoWorkbenchCacheRef.current[cacheKey] = { ts: Date.now(), items, total, stats }
      setTodoData(items)
      setTodoTotal(total)
      setTodoStats(stats)
      requestAnimationFrame(() => {
        logSchedulePlansPerf('todo-workbench-loaded', {
          total,
          apiMs: Number(apiMs.toFixed(2)),
          dependencyTimingsMs: stats?.dependency_timings_ms,
          dependencyTimingsMsText: stringifyPerfPayload(stats?.dependency_timings_ms),
          backendTimingsMs: stats?.timings_ms,
          backendTimingsMsText: stringifyPerfPayload(stats?.timings_ms),
          syncedScheduledSnapshots: stats?.synced_scheduled_snapshots || 0,
          backendStatsSummary: stringifyPerfPayload({
            ready: stats?.ready,
            pending: stats?.pending,
            reschedule: stats?.reschedule,
            missing_upph: stats?.missing_upph,
            bucket_counts: stats?.bucket_counts,
          }),
          totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
          params,
        })
      })
    } catch (e: any) {
      todoWorkbenchSkipSnapshotReconcileRef.current = false
      logSchedulePlansPerf('todo-workbench-error', {
        totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
        params: {
          page: orderPage,
          page_size: orderPageSize,
          year,
          month,
          keyword: orderKeyword.trim() || undefined,
          risk_level: riskLevel || undefined,
          schedule_bucket: orderBucketFilter !== 'all' ? orderBucketFilter : undefined,
          todo_status: todoStatusFilter !== 'all' ? todoStatusFilter : undefined,
        },
        message: e?.message,
      })
      message.error(e.message || '获取待处理列表失败')
    } finally {
      setLoading(false)
    }
  }, [month, orderBucketFilter, orderKeyword, orderPage, orderPageSize, plannerHubTab, riskLevel, todoStatusFilter, workspace, year])

  const loadPlanBoard = useCallback(async (force = false) => {
    if (!force && workspace !== 'plan_board') return
    const requestStartedAt = performance.now()
    const monthStart = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month').format('YYYY-MM-DD')
    const monthEnd = dayjs(monthStart).endOf('month').format('YYYY-MM-DD')
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
      } else {
        params.date_start = monthStart
        params.date_end = monthEnd
      }
      if (planScope === 'active') params.needs_reschedule = false
      if (planScope === 'reschedule') params.needs_reschedule = true

      const cacheKey = JSON.stringify(params)
      const cached = planBoardCacheRef.current[cacheKey]
      if (!force && cached && (Date.now() - cached.ts) < PAGE_CACHE_TTL_MS) {
        setPlanData(cached.items || [])
        setPlanTotal(cached.total || 0)
        setLoading(false)
        logSchedulePlansPerf('plan-board-cache-hit', {
          total: cached.total || 0,
          cacheAgeMs: Date.now() - cached.ts,
          backendTimingsMs: cached.backendTimingsMs,
          backendTimingsMsText: stringifyPerfPayload(cached.backendTimingsMs),
          totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
          params,
        })
        return
      }

      let requestPromise = !force ? planBoardInflightRef.current[cacheKey] : undefined
      if (!requestPromise) {
        const apiStartedAt = performance.now()
        requestPromise = productionApi.listSchedulePlans(params).then((res: any) => ({
          items: res.data?.items || [],
          total: res.data?.total || 0,
          dependencyTimingsMs: res.data?.stats?.dependency_timings_ms || undefined,
          backendTimingsMs: res.data?.stats?.timings_ms || undefined,
          apiMs: performance.now() - apiStartedAt,
        })).finally(() => {
          delete planBoardInflightRef.current[cacheKey]
        })
        if (!force) {
          planBoardInflightRef.current[cacheKey] = requestPromise
        }
      } else {
        logSchedulePlansPerf('plan-board-inflight-hit', {
          params,
        })
      }

      const { items, total, apiMs, backendTimingsMs, dependencyTimingsMs } = await requestPromise
      planBoardCacheRef.current[cacheKey] = { ts: Date.now(), items, total, backendTimingsMs, dependencyTimingsMs }
      setPlanData(items)
      setPlanTotal(total)
      requestAnimationFrame(() => {
        logSchedulePlansPerf('plan-board-loaded', {
          total,
          apiMs: Number(apiMs.toFixed(2)),
          dependencyTimingsMs,
          dependencyTimingsMsText: stringifyPerfPayload(dependencyTimingsMs),
          backendTimingsMs,
          backendTimingsMsText: stringifyPerfPayload(backendTimingsMs),
          totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
          params,
        })
      })
    } catch (e: any) {
      logSchedulePlansPerf('plan-board-error', {
        totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
        params: {
          page: planPage,
          page_size: planPageSize,
          is_active: planScope !== 'history',
          keyword: planKeyword.trim() || undefined,
          status: planStatus || undefined,
          schedule_bucket: planBucketFilter !== 'all' ? planBucketFilter : undefined,
          date_start: planDateRange?.[0] || monthStart,
          date_end: planDateRange?.[1] || monthEnd,
          needs_reschedule: planScope === 'active' ? false : planScope === 'reschedule' ? true : undefined,
        },
        message: e?.message,
      })
      message.error(e.message || '获取排产结果失败')
    } finally {
      setLoading(false)
    }
  }, [month, planBucketFilter, planDateRange, planKeyword, planPage, planPageSize, planScope, planStatus, workspace, year])

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

      const cacheKey = JSON.stringify(params)
      const cached = impactPlansCacheRef.current[cacheKey]
      if (!force && cached && (Date.now() - cached.ts) < PAGE_CACHE_TTL_MS) {
        setEventData(cached.items || [])
        setEventTotal(cached.total || 0)
        setEventStats(cached.stats || {
          upph_change: 0,
          bucket_change: 0,
          due_date_change: 0,
          quantity_change: 0,
          high: 0,
          pending: 0,
          watching: 0,
          resolved: 0,
        })
        setLoading(false)
        return
      }

      const res: any = await productionApi.listChangeEvents(params)
      const items = res.data?.items || []
      const total = res.data?.total || 0
      const stats = {
        upph_change: res.data?.stats?.upph_change || 0,
        bucket_change: res.data?.stats?.bucket_change || 0,
        due_date_change: res.data?.stats?.due_date_change || 0,
        quantity_change: res.data?.stats?.quantity_change || 0,
        high: res.data?.stats?.high || 0,
        pending: res.data?.stats?.pending || 0,
        watching: res.data?.stats?.watching || 0,
        resolved: res.data?.stats?.resolved || 0,
      }
      impactPlansCacheRef.current[cacheKey] = { ts: Date.now(), items, total, stats }
      setEventData(items)
      setEventTotal(total)
      setEventStats(stats)
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
      invalidatePageCaches()
      setSelectedOrderKeys([])
      setSelectedOrderRows([])
      await refreshTodoWorkbenchPanel(true)
    } catch (e: any) {
      message.error(e.message || '刷新待处理快照失败')
    } finally {
      setRefreshingSnapshots(false)
    }
  }, [invalidatePageCaches, month, orderKeyword, refreshTodoWorkbenchPanel, riskLevel, year])

  useEffect(() => { loadWorkHours() }, [loadWorkHours])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const planIdParam = Number(params.get('planId') || 0)
    const planDateParam = params.get('planDate')
    const keywordParam = params.get('keyword') || ''
    const bucketParam = params.get('bucket')
    const scopeParam = params.get('scope')
    const hasPlanBoardContext = Boolean(
      planIdParam > 0 ||
      planDateParam ||
      keywordParam ||
      bucketParam ||
      scopeParam
    )
    if (!hasPlanBoardContext) return
    const targetDate = planDateParam ? dayjs(planDateParam) : null

    setPlanScope(scopeParam === 'history' || scopeParam === 'reschedule' ? scopeParam : 'active')
    setPlanPage(1)
    setPlanPageSize(100)
    setPlanKeyword(keywordParam)
    setPlanBucketFilter(normalizePlanBoardBucket(bucketParam))
    setPlanDateRange(planDateParam ? [planDateParam, planDateParam] : null)
    if (targetDate?.isValid()) {
      setYear(targetDate.year())
      setMonth(targetDate.month() + 1)
    }
    if (planIdParam > 0) {
      setPendingPlanFocusId(planIdParam)
      setHighlightPlanId(planIdParam)
    }
  }, [location.search])

  useEffect(() => {
    const run = async () => {
      try {
        if (workspace === 'planner_hub') {
          if (plannerHubTab === 'todo_workbench') {
            // #region debug-point delete-only-refresh-flow
            logSchedulePlansPerf('workspace-auto-load', {
              workspace,
              plannerHubTab,
              target: 'todo_workbench',
            })
            // #endregion
            await refreshTodoWorkbenchPanel();
            return;
          }
          if (plannerHubTab === 'change_events') {
            // #region debug-point delete-only-refresh-flow
            logSchedulePlansPerf('workspace-auto-load', {
              workspace,
              plannerHubTab,
              target: 'change_events',
            })
            // #endregion
            await loadImpactPlans()
            return;
          }
        }
        if (workspace === 'plan_board') {
          // #region debug-point delete-only-refresh-flow
          logSchedulePlansPerf('workspace-auto-load', {
            workspace,
            plannerHubTab,
            target: 'plan_board',
          })
          // #endregion
          await loadPlanBoard();
          return;
        }
      } catch (e) {
        console.error("workspace load error", e);
      }
    }
    run();
  }, [loadImpactPlans, loadPlanBoard, plannerHubTab, refreshTodoWorkbenchPanel, workspace])

  useEffect(() => {
    if (workspace !== 'plan_board' || !pendingPlanFocusId) return
    const targetRow = planData.find((item) => Number(item.id) === pendingPlanFocusId)
    if (targetRow) {
      setHighlightPlanId(pendingPlanFocusId)
      openOrderDetail(targetRow, 'plan_board')
      setPendingPlanFocusId(null)
      message.success('已定位到对应计划')
      return
    }
    if (!loading) {
      setPendingPlanFocusId(null)
      message.warning('当前筛选结果中未定位到对应计划，请检查月份或筛选条件')
    }
  }, [loading, openOrderDetail, pendingPlanFocusId, planData, workspace])

  const openDeleteModal = (row: any) => {
    setDeletingPlan(row)
    setDeleteReason('')
    setBreakFrozenReason('')
    setDeleteModalOpen(true)
  }

  // v2 阶段 2：判断计划是否在冷冻区（plan_date 在 today+1 ~ today+3）
  const isPlanInFrozenZone = (planDateStr?: string | null): boolean => {
    if (!planDateStr) return false
    const today = dayjs().startOf('day')
    const planDate = dayjs(planDateStr).startOf('day')
    if (!planDate.isValid()) return false
    const diff = planDate.diff(today, 'day')
    return diff >= 1 && diff <= 3
  }
  const deletingInFrozen = isPlanInFrozenZone(deletingPlan?.plan_date)

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

  function openOrderDetail(row: any, source: 'order_pool' | 'plan_board') {
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
    // #region debug-point delete-only-refresh-flow
    logSchedulePlansPerf('refresh-all-views-start', {
      workspace,
      plannerHubTab,
    })
    // #endregion
    if (workspace === 'planner_hub') {
      if (plannerHubTab === 'todo_workbench') {
        // #region debug-point delete-only-refresh-flow
        logSchedulePlansPerf('refresh-all-views-dispatch', {
          target: 'todo_workbench',
          workspace,
          plannerHubTab,
        })
        // #endregion
        await refreshTodoWorkbenchPanel(true)
      } else if (plannerHubTab === 'change_events') {
        // #region debug-point delete-only-refresh-flow
        logSchedulePlansPerf('refresh-all-views-dispatch', {
          target: 'change_events',
          workspace,
          plannerHubTab,
        })
        // #endregion
        await loadImpactPlans(true)
      }
    } else if (workspace === 'plan_board') {
      // #region debug-point delete-only-refresh-flow
      logSchedulePlansPerf('refresh-all-views-dispatch', {
        target: 'plan_board',
        workspace,
        plannerHubTab,
      })
      // #endregion
      await loadPlanBoard(true)
    }
    // #region debug-point delete-only-refresh-flow
    logSchedulePlansPerf('refresh-all-views-done', {
      workspace,
      plannerHubTab,
    })
    // #endregion
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
      invalidatePageCaches()
      setModalOpen(false)
      loadPlanBoard()
      loadAlertCounts()
    } catch (e: any) {
      if (!e?.errorFields) message.error(e.message || '保存失败')
    }
  }

  const handleAutoSchedule = async (confirmRisky: boolean = false) => {
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
        confirm_risky: confirmRisky,
      }
      const res: any = await productionApi.autoSchedule(payload)

      // v2 阶段 4：周日生产/前挪强制人工确认
      if (res.data?.needs_confirm && !confirmRisky) {
        const calcResult = res.data?.calculation_result || {}
        const warningText = res.data?.message || '此排产需要人工确认'
        Modal.confirm({
          title: '⚠ 排产风险确认',
          content: (
            <div>
              <p style={{ color: '#cf1322', fontWeight: 600 }}>{warningText}</p>
              {calcResult.work_hour_summary && <p>{calcResult.work_hour_summary}</p>}
              <p style={{ color: '#595959' }}>确认后将按此方案落库。取消则不排产。</p>
            </div>
          ),
          okText: '确认排产',
          cancelText: '取消',
          okButtonProps: { danger: true },
          onOk: () => handleAutoSchedule(true),
        })
        return
      }

      const result = res.data?.calculation_result || {}
      invalidatePageCaches()
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
      invalidatePageCaches()
      try {
        await refreshAllViews()
      } catch (refreshError: any) {
        message.warning(refreshError?.message ? `批量排产已完成，但刷新列表失败：${refreshError.message}` : '批量排产已完成，但刷新列表失败，请手动刷新页面')
      }
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
    // v2 阶段 2：冷冻区操作必须填破冻理由
    if (isPlanInFrozenZone(deletingPlan?.plan_date) && !breakFrozenReason.trim()) {
      message.warning('该计划在冷冻区（1-3 天内开工），必须填写破冻理由')
      return
    }
    const requestStartedAt = performance.now()
    try {
      setLoading(true)
      const apiStartedAt = performance.now()
      const res: any = await productionApi.getDeleteSchedulePlanPreview(deletingPlan.id, {
        reason: deleteReason?.trim() || undefined,
        break_frozen_reason: breakFrozenReason?.trim() || undefined,
      })
      const apiMs = performance.now() - apiStartedAt
      const result = res.data || {}
      setDeleteModalOpen(false)
      openBackfillPreview(result)
      logSchedulePlansPerf('delete-preview-loaded', {
        planId: deletingPlan.id,
        affectedCount: result.affected_count || 0,
        apiMs: Number(apiMs.toFixed(2)),
        totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
      })
      message.info(result.affected_count > 0 ? `已生成删除预览，并识别出 ${result.affected_count} 条候选补位计划` : '已生成删除预览，当前没有可补位计划')
    } catch (e: any) {
      logSchedulePlansPerf('delete-preview-error', {
        planId: deletingPlan.id,
        totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
        message: e?.message,
      })
      message.error(e.message || '获取删除预览失败')
    } finally {
      setLoading(false)
    }
  }

  const handleConfirmDelete = async (executeBackfill: boolean) => {
    if (!deletingPlan?.id) return
    const requestStartedAt = performance.now()
    let phase: 'api' | 'refresh' | 'post_refresh' = 'api'
    setLoading(true)
    try {
      const deleteTarget = deletingPlan
      const preview = backfillPreview
      const apiStartedAt = performance.now()
      const res: any = await productionApi.confirmDeleteSchedulePlan(deletingPlan.id, {
        reason: backfillPreview?.reason || deleteReason?.trim() || '计划员手动删除计划',
        execute_backfill: executeBackfill,
        break_frozen_reason: breakFrozenReason?.trim() || undefined,
      })
      const apiMs = performance.now() - apiStartedAt
      const result = res.data || {}
      const targetTodoKeyword = deleteTarget?.order_no || ''
      const targetTodoBucket = preview?.release_bucket && preview.release_bucket !== 'pending' ? preview.release_bucket : 'all'
      const summary = executeBackfill
        ? `已删除计划，并完成 ${result.backfill_success_count || 0} 条补位前滚`
        : '已删除计划，已回到待处理工作台'
      message.success(summary)
      invalidatePageCaches()
      setBackfillPreviewOpen(false)
      setBackfillPreview(null)
      setDeletingPlan(null)
      setDeleteReason('')
      let refreshMs = 0
      if (executeBackfill) {
        phase = 'refresh'
        const refreshStartedAt = performance.now()
        await refreshAllViews()
        refreshMs = performance.now() - refreshStartedAt
      } else {
        const alreadyAtTargetTodoView = (
          workspace === 'planner_hub' &&
          plannerHubTab === 'todo_workbench' &&
          orderPage === 1 &&
          todoStatusFilter === 'all' &&
          orderKeyword === targetTodoKeyword &&
          orderBucketFilter === targetTodoBucket
        )
        // #region debug-point delete-only-refresh-flow
        logSchedulePlansPerf('delete-confirm-delete-only-strategy', {
          alreadyAtTargetTodoView,
          currentWorkspace: workspace,
          currentPlannerHubTab: plannerHubTab,
          currentOrderPage: orderPage,
          currentTodoStatusFilter: todoStatusFilter,
          currentOrderKeyword: orderKeyword,
          currentOrderBucketFilter: orderBucketFilter,
          targetTodoKeyword,
          targetTodoBucket,
        })
        // #endregion
        if (alreadyAtTargetTodoView) {
          todoWorkbenchSkipSnapshotReconcileRef.current = true
          phase = 'refresh'
          const refreshStartedAt = performance.now()
          await refreshTodoWorkbenchPanel(true)
          refreshMs = performance.now() - refreshStartedAt
        }
      }
      logSchedulePlansPerf('delete-confirm-loaded', {
        planId: deleteTarget?.id,
        executeBackfill,
        affectedCount: result.affected_count || 0,
        apiMs: Number(apiMs.toFixed(2)),
        refreshMs: Number(refreshMs.toFixed(2)),
        totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
        backendTimingsMs: result.timings_ms,
      })
      phase = 'post_refresh'
      if (executeBackfill) {
        openPlanBoardView({ scope: 'active', bucket: preview?.release_bucket || 'all' })
      } else {
        navigate('/todo-workbench')
      }
    } catch (e: any) {
      logSchedulePlansPerf('delete-confirm-error', {
        planId: deletingPlan?.id,
        executeBackfill,
        phase,
        totalMs: Number((performance.now() - requestStartedAt).toFixed(2)),
        message: e?.message,
      })
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
      invalidatePageCaches()
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
      invalidatePageCaches()
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
      invalidatePageCaches()
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
      invalidatePageCaches()
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
    { title: 'BOM编码', dataIndex: 'bom_no', width: 180, render: (v: string) => renderCopyableText(v, 'BOM编码') },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
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
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Row align="middle" justify="space-between">
            <Col>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>排产台账</div>
              <div style={{ color: '#64748b', fontSize: 12 }}>
                面向计划与管理的后台操作页，聚焦计划查询、调整、删除、重排、历史与日志
              </div>
            </Col>
            <Col>
              <Space>
                <Button size="small" onClick={() => navigate('/todo-workbench')}>📋 待排工作台</Button>
                <Button size="small" onClick={() => navigate('/change-events')}>🔄 变更事件中心</Button>
                <Button size="small" onClick={() => navigate('/schedule-board')}>📅 排产看板</Button>
                <Button size="small" onClick={() => navigate('/production-dashboard')}>🏠 驾驶舱</Button>
              </Space>
            </Col>
          </Row>
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
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px', marginBottom: 16 }}>
        <Table
          rowKey="id"
          columns={planColumns}
          dataSource={planData}
          loading={loading}
          size="small"
          scroll={{ x: 2350, y: 600 }}
          onRow={(row: any) => ({
            style: Number(row.id) === highlightPlanId ? { backgroundColor: '#fffbe6' } : undefined,
          })}
          pagination={{
            total: planTotal,
            current: planPage,
            pageSize: planPageSize,
            showSizeChanger: true,
            onChange: (page, pageSize) => { setPlanPage(page); setPlanPageSize(pageSize) },
            showTotal: (total) => `共 ${total} 条`,
          }}
        />
      </div>

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
                      type="primary"
                      onClick={() => navigate(buildScheduleBoardLink(detailRow))}
                    >
                      回看板定位
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
            renderPlanExplainPanel(detailRow)
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

      <RescheduleModal
        open={reschedulePreviewOpen}
        planData={reschedulePreviewRow}
        onClose={() => { setReschedulePreviewOpen(false); setReschedulePreviewRow(null) }}
        onSuccess={async () => { invalidatePageCaches(); await refreshAllViews() }}
      />


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
            { title: '破冻', dataIndex: 'is_frozen_break', width: 80, render: (v: boolean) => v ? <Tag color="red">破冻</Tag> : '-' },
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

      <DeleteModal
        open={deleteModalOpen}
        planData={deletingPlan}
        onClose={() => { setDeleteModalOpen(false); setDeletingPlan(null) }}
        onSuccess={async () => { invalidatePageCaches(); await refreshAllViews() }}
      />

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

      <ScheduleModal
        open={scheduleModalOpen}
        orderData={selectedOrder}
        onClose={() => setScheduleModalOpen(false)}
        onSuccess={async () => {
          invalidatePageCaches()
          await refreshAllViews()
        }}
      />

      <BatchScheduleModal
        open={batchScheduleOpen}
        orderRows={selectedOrderRows}
        onClose={() => setBatchScheduleOpen(false)}
        onSuccess={async () => {
          setSelectedOrderKeys([])
          setSelectedOrderRows([])
          invalidatePageCaches()
          await refreshAllViews()
        }}
      />
    </div>
  )
}
