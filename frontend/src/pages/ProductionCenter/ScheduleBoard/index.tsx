import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Alert, Button, DatePicker, Descriptions, Drawer, Empty, Input, Segmented, Space, Statistic, Table, Tag, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { BarChartOutlined, CalendarOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs, { Dayjs } from 'dayjs'
import { productionApi } from '../../../services/api'
import { formatDate, formatDateTime } from '../../../utils'

type BoardViewKey = 'week' | 'capacity' | 'progress'
type BucketKey = 'all' | 'lean' | 'assembly' | 'packaging' | 'mixed' | 'pending'

interface PlanItem {
  id: number
  order_no?: string
  line_no?: string
  product_code?: string
  model_code?: string
  bom_no?: string
  quantity?: number
  owner?: string
  plan_date: string
  start_date?: string
  end_date?: string
  priority?: string
  status?: string
  upph?: number
  daily_work_hours?: number
  total_hours?: number
  required_daily_hours?: number
  remark?: string
  schedule_bucket?: string
  schedule_bucket_label?: string
  customer_due_date?: string
  target_ready_date?: string
  capacity_load_status?: string
  capacity_load_status_label?: string
  delivery_status?: string
  needs_reschedule?: boolean
  reschedule_reason?: string
  created_at?: string
}

type DayCell = {
  dateKey: string
  dayLabel: string
  items: PlanItem[]
  totalHours: number
  riskCount: number
  delayedCount: number
}

type LaneRow = {
  bucket: Exclude<BucketKey, 'all'>
  label: string
  color: string
  cells: DayCell[]
  totalHours: number
  totalCount: number
}

const BUCKET_META: Record<Exclude<BucketKey, 'all'>, { label: string; color: string }> = {
  lean: { label: '精益', color: '#1677ff' },
  assembly: { label: '组装', color: '#722ed1' },
  packaging: { label: '包装', color: '#13c2c2' },
  mixed: { label: '组装+包装', color: '#faad14' },
  pending: { label: '待确认', color: '#8c8c8c' },
}

const BUCKET_OPTIONS: Array<{ value: BucketKey; label: string }> = [
  { value: 'all', label: '全部排产段' },
  { value: 'lean', label: '精益' },
  { value: 'assembly', label: '组装' },
  { value: 'packaging', label: '包装' },
  { value: 'mixed', label: '组装+包装' },
  { value: 'pending', label: '待确认' },
]

const VIEW_OPTIONS = [
  { label: '周视图泳道图', value: 'week' as BoardViewKey },
  { label: '产能负荷图', value: 'capacity' as BoardViewKey },
  { label: '执行进度', value: 'progress' as BoardViewKey },
]

const PRIORITY_COLOR_MAP: Record<string, string> = {
  urgent: 'red',
  high: 'orange',
  normal: 'blue',
  low: 'default',
}

const STATUS_COLOR_MAP: Record<string, string> = {
  planned: 'blue',
  in_progress: 'processing',
  completed: 'success',
  delayed: 'error',
  cancelled: 'default',
}

const RISK_CAPACITY_STATUS = new Set(['overtime', 'sunday_production', 'move_earlier'])

const getWeekStart = (value: Dayjs) => value.startOf('day').subtract((value.day() + 6) % 7, 'day')

const getPlanStart = (item: PlanItem) => dayjs(item.start_date || item.plan_date)

const getPlanEnd = (item: PlanItem) => dayjs(item.end_date || item.start_date || item.plan_date)

const getBucketKey = (item: PlanItem): Exclude<BucketKey, 'all'> => {
  const key = (item.schedule_bucket || 'pending') as Exclude<BucketKey, 'all'>
  return BUCKET_META[key] ? key : 'pending'
}

const getDailyHours = (item: PlanItem) => {
  const raw = item.daily_work_hours ?? item.required_daily_hours ?? item.total_hours ?? 0
  return Number(raw || 0)
}

const getDelayFlag = (item: PlanItem) => item.delivery_status === 'delayed'

const getWeekDays = (anchor: Dayjs) => {
  const start = getWeekStart(anchor)
  return Array.from({ length: 7 }, (_, index) => start.add(index, 'day'))
}

const buildPlanBoardLink = (item: PlanItem) => {
  const params = new URLSearchParams()
  params.set('workspace', 'plan_board')
  params.set('scope', 'active')
  params.set('source', 'schedule_board')
  if (item.id) params.set('planId', String(item.id))
  if (item.order_no) params.set('keyword', item.order_no)
  if (item.schedule_bucket) params.set('bucket', item.schedule_bucket)
  const planDate = item.start_date || item.plan_date
  if (planDate) params.set('planDate', planDate)
  return `/schedule-plans?${params.toString()}`
}

export default function ScheduleBoard() {
  const location = useLocation()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<BoardViewKey>('week')
  const [weekAnchor, setWeekAnchor] = useState<Dayjs>(dayjs())
  const [bucketFilter, setBucketFilter] = useState<BucketKey>('all')
  const [keyword, setKeyword] = useState('')
  const [plans, setPlans] = useState<PlanItem[]>([])
  const [total, setTotal] = useState(0)
  const [selectedPlan, setSelectedPlan] = useState<PlanItem | null>(null)
  const [focusedPlanId, setFocusedPlanId] = useState<number | null>(null)

  const weekDays = useMemo(() => getWeekDays(weekAnchor), [weekAnchor])
  const weekStart = weekDays[0]
  const weekEnd = weekDays[6]

  const handlePrevWeek = useCallback(() => {
    setWeekAnchor((current) => current.subtract(7, 'day'))
  }, [])

  const handleNextWeek = useCallback(() => {
    setWeekAnchor((current) => current.add(7, 'day'))
  }, [])

  const handleBackToCurrentWeek = useCallback(() => {
    setWeekAnchor(dayjs())
  }, [])

  const loadBoard = useCallback(async () => {
    setLoading(true)
    try {
      const baseParams: Record<string, any> = {
        page_size: 200,
        is_active: true,
        date_start: weekStart.format('YYYY-MM-DD'),
        date_end: weekEnd.format('YYYY-MM-DD'),
      }
      if (bucketFilter !== 'all') baseParams.schedule_bucket = bucketFilter
      if (keyword.trim()) baseParams.keyword = keyword.trim()

      const firstRes: any = await productionApi.listSchedulePlans({ ...baseParams, page: 1 })
      const firstItems = firstRes.data?.items || []
      const firstTotal = firstRes.data?.total || 0
      const pageSize = 200
      const totalPages = Math.ceil(firstTotal / pageSize)

      let allItems = [...firstItems]
      if (totalPages > 1) {
        const followUps = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, index) =>
            productionApi.listSchedulePlans({ ...baseParams, page: index + 2 }),
          ),
        )
        followUps.forEach((res: any) => {
          allItems = allItems.concat(res.data?.items || [])
        })
      }

      allItems.sort((a: PlanItem, b: PlanItem) => {
        const startDiff = getPlanStart(a).valueOf() - getPlanStart(b).valueOf()
        if (startDiff !== 0) return startDiff
        return (a.order_no || '').localeCompare(b.order_no || '')
      })
      setPlans(allItems)
      setTotal(firstTotal)
    } catch (e: any) {
      message.error(e.message || '加载排产看板失败')
    } finally {
      setLoading(false)
    }
  }, [bucketFilter, keyword, weekEnd, weekStart])

  useEffect(() => {
    loadBoard()
  }, [loadBoard])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const planIdParam = Number(params.get('planId') || 0)
    const planDateParam = params.get('planDate')
    const bucketParam = params.get('bucket')
    const keywordParam = params.get('keyword')
    const viewParam = params.get('view')
    const sourceParam = params.get('source')
    const targetDate = planDateParam ? dayjs(planDateParam) : null

    if (targetDate?.isValid()) {
      setWeekAnchor(targetDate)
    }
    if (bucketParam && BUCKET_OPTIONS.some((item) => item.value === bucketParam)) {
      setBucketFilter(bucketParam as BucketKey)
    }
    if (typeof keywordParam === 'string') {
      setKeyword(keywordParam)
    }
    if (viewParam === 'capacity' || viewParam === 'progress' || viewParam === 'week') {
      setView(viewParam)
    } else if (sourceParam === 'schedule_plans') {
      setView('week')
    }
    if (planIdParam > 0) {
      setFocusedPlanId(planIdParam)
    }
  }, [location.search])

  useEffect(() => {
    if (!focusedPlanId) return
    const timer = window.setTimeout(() => {
      setFocusedPlanId(null)
    }, 12000)
    return () => window.clearTimeout(timer)
  }, [focusedPlanId])

  useEffect(() => {
    if (!focusedPlanId || loading) return
    const targetPlan = plans.find((item) => Number(item.id) === focusedPlanId)
    if (targetPlan) {
      setSelectedPlan(targetPlan)
      message.success('已定位到看板卡片')
      return
    }
    if (plans.length > 0) {
      message.warning('当前周看板中未找到对应计划卡片')
      setFocusedPlanId(null)
    }
  }, [focusedPlanId, loading, plans])

  const laneRows = useMemo<LaneRow[]>(() => {
    const buckets = (bucketFilter === 'all'
      ? (Object.keys(BUCKET_META) as Array<Exclude<BucketKey, 'all'>>)
      : [bucketFilter as Exclude<BucketKey, 'all'>]
    )
    return buckets.map((bucket) => {
      const meta = BUCKET_META[bucket]
      const cells = weekDays.map((day) => {
        const dayStart = day.startOf('day')
        const dayEnd = day.endOf('day')
        const items = plans.filter((item) => {
          if (getBucketKey(item) !== bucket) return false
          const start = getPlanStart(item).startOf('day')
          const end = getPlanEnd(item).endOf('day')
          return start.isBefore(dayEnd) && end.isAfter(dayStart)
        })
        return {
          dateKey: day.format('YYYY-MM-DD'),
          dayLabel: day.format('MM-DD'),
          items,
          totalHours: Number(items.reduce((sum, item) => sum + getDailyHours(item), 0).toFixed(1)),
          riskCount: items.filter((item) => RISK_CAPACITY_STATUS.has(item.capacity_load_status || '') || item.needs_reschedule).length,
          delayedCount: items.filter((item) => getDelayFlag(item)).length,
        }
      })
      return {
        bucket,
        label: meta.label,
        color: meta.color,
        cells,
        totalHours: Number(cells.reduce((sum, cell) => sum + cell.totalHours, 0).toFixed(1)),
        totalCount: cells.reduce((sum, cell) => sum + cell.items.length, 0),
      }
    })
  }, [bucketFilter, plans, weekDays])

  const progressStats = useMemo(() => {
    const statusCount: Record<string, number> = {
      planned: 0,
      in_progress: 0,
      completed: 0,
      delayed: 0,
    }
    plans.forEach((item) => {
      const key = item.status || 'planned'
      if (statusCount[key] !== undefined) statusCount[key] += 1
    })
    return {
      total: plans.length,
      delayed: plans.filter((item) => getDelayFlag(item)).length,
      reschedule: plans.filter((item) => item.needs_reschedule).length,
      ...statusCount,
    }
  }, [plans])

  const progressColumns = useMemo<ColumnsType<PlanItem>>(
    () => [
      {
        title: '订单号',
        dataIndex: 'order_no',
        width: 170,
        fixed: 'left',
        render: (value: string | undefined, row) => (
          <Button type="link" style={{ padding: 0 }} onClick={() => setSelectedPlan(row)}>
            {value || '-'}
          </Button>
        ),
      },
      { title: '行号', dataIndex: 'line_no', width: 90, render: (value) => value || '-' },
      { title: '产品编码', dataIndex: 'product_code', width: 220, render: (value) => value || '-' },
      {
        title: '排产段',
        width: 120,
        render: (_, row) => {
          const bucket = getBucketKey(row)
          return <Tag color={BUCKET_META[bucket].color}>{BUCKET_META[bucket].label}</Tag>
        },
      },
      { title: '开始日期', dataIndex: 'start_date', width: 110, render: (value) => formatDate(value) },
      { title: '结束日期', dataIndex: 'end_date', width: 120, render: (value, row) => formatDate(value || row.plan_date) },
      {
        title: '状态',
        dataIndex: 'status',
        width: 100,
        render: (value: string | undefined) => <Tag color={STATUS_COLOR_MAP[value || 'planned'] || 'default'}>{value || 'planned'}</Tag>,
      },
      {
        title: '延期',
        width: 90,
        render: (_, row) => (getDelayFlag(row) ? <Tag color="red">延期</Tag> : <Tag color="green">正常</Tag>),
      },
      {
        title: '待重排',
        width: 100,
        render: (_, row) => (row.needs_reschedule ? <Tag color="orange">是</Tag> : <span>-</span>),
      },
      { title: '负责人', dataIndex: 'owner', width: 100, render: (value) => value || '-' },
    ],
    [],
  )

  const capacityColumns = useMemo<ColumnsType<Record<string, any>>>(() => {
    const columns: ColumnsType<Record<string, any>> = [
      {
        title: '排产段',
        dataIndex: 'bucket',
        width: 120,
        fixed: 'left',
        render: (value: Exclude<BucketKey, 'all'>) => <Tag color={BUCKET_META[value].color}>{BUCKET_META[value].label}</Tag>,
      },
    ]
    weekDays.forEach((day) => {
      const key = day.format('YYYY-MM-DD')
      columns.push({
        title: `${day.format('MM-DD')} ${'日一二三四五六'[day.day()]}`,
        dataIndex: key,
        width: 150,
        render: (value: DayCell) => {
          if (!value || value.items.length === 0) {
            return <span style={{ color: '#bfbfbf' }}>-</span>
          }
          return (
            <Space direction="vertical" size={2}>
              <span>计划 {value.items.length} 单</span>
              <span>工时 {value.totalHours.toFixed(1)}h</span>
              <span style={{ color: value.riskCount > 0 ? '#d46b08' : '#8c8c8c' }}>风险 {value.riskCount}</span>
            </Space>
          )
        },
      })
    })
    return columns
  }, [weekDays])

  const capacityData = useMemo(
    () =>
      laneRows.map((lane) => {
        const row: Record<string, any> = { key: lane.bucket, bucket: lane.bucket }
        lane.cells.forEach((cell) => {
          row[cell.dateKey] = cell
        })
        return row
      }),
    [laneRows],
  )

  return (
    <div>
      <div className="card-modern" style={{ padding: 16, marginBottom: 16 }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            showIcon
            type="info"
            message="排产看板首版已独立"
            description="首版看板只读复用已排计划数据，不影响现有计划排产、删除补位与重排链路；当前优先提供周视图、负荷概览和执行进度。"
          />
          {focusedPlanId ? (
            <Alert
              showIcon
              type="success"
              message="已进入定位模式"
              description="已按来源计划自动切到对应周并高亮目标卡片；高亮会在一段时间后自动清除。"
            />
          ) : null}
          <Space wrap size={12} style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space wrap size={12}>
              <DatePicker
                allowClear={false}
                value={weekAnchor}
                onChange={(value) => value && setWeekAnchor(value)}
                placeholder="选择所在周日期"
              />
              <Space size={8}>
                <Button onClick={handlePrevWeek}>上一周</Button>
                <Button onClick={handleBackToCurrentWeek}>回到本周</Button>
                <Button onClick={handleNextWeek}>下一周</Button>
              </Space>
              <Input
                allowClear
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索订单 / 产品 / BOM"
                style={{ width: 240 }}
                onPressEnter={loadBoard}
              />
              <Segmented
                value={bucketFilter}
                onChange={(value) => setBucketFilter(value as BucketKey)}
                options={BUCKET_OPTIONS.map((item) => ({ label: item.label, value: item.value }))}
              />
              {focusedPlanId ? <Button onClick={() => setFocusedPlanId(null)}>清除定位高亮</Button> : null}
            </Space>
            <Space>
              <Button onClick={() => navigate('/production-overview')}>回生产总览</Button>
              <Button onClick={() => navigate('/schedule-plans')}>去计划排产</Button>
              <Button type="primary" icon={<ReloadOutlined />} onClick={loadBoard}>
                刷新看板
              </Button>
            </Space>
          </Space>
          <Space wrap size={24}>
            <Statistic title="当前周" value={`${weekStart.format('MM-DD')} ~ ${weekEnd.format('MM-DD')}`} prefix={<CalendarOutlined />} />
            <Statistic title="计划总数" value={total} />
            <Statistic title="当前已加载" value={plans.length} />
            <Statistic title="延期计划" value={progressStats.delayed} valueStyle={{ color: progressStats.delayed > 0 ? '#cf1322' : undefined }} />
            <Statistic title="待重排" value={progressStats.reschedule} valueStyle={{ color: progressStats.reschedule > 0 ? '#d46b08' : undefined }} />
          </Space>
        </Space>
      </div>

      <div className="card-modern" style={{ padding: 16, marginBottom: 16 }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Segmented block options={VIEW_OPTIONS} value={view} onChange={(value) => setView(value as BoardViewKey)} />

          {view === 'week' && (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {laneRows.map((lane) => (
                <div key={lane.bucket} style={{ border: '1px solid #f0f0f0', borderRadius: 12, overflow: 'hidden' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '12px 16px',
                      background: `${lane.color}10`,
                      borderBottom: '1px solid #f0f0f0',
                    }}
                  >
                    <Space>
                      <Tag color={lane.color}>{lane.label}</Tag>
                      <span style={{ color: '#595959' }}>周内 {lane.totalCount} 个卡片</span>
                    </Space>
                    <Space size={16}>
                      <span style={{ color: '#595959' }}>累计工时 {lane.totalHours.toFixed(1)}h</span>
                      <span style={{ color: '#595959' }}>
                        风险 {lane.cells.reduce((sum, cell) => sum + cell.riskCount, 0)} / 延期 {lane.cells.reduce((sum, cell) => sum + cell.delayedCount, 0)}
                      </span>
                    </Space>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
                    {lane.cells.map((cell) => (
                      <div key={cell.dateKey} style={{ borderRight: '1px solid #f5f5f5', minHeight: 220, padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>{cell.dayLabel}</div>
                            <div style={{ color: '#8c8c8c', fontSize: 12 }}>{'周日周一周二周三周四周五周六'.slice(dayjs(cell.dateKey).day() * 2, dayjs(cell.dateKey).day() * 2 + 2)}</div>
                          </div>
                          <div style={{ textAlign: 'right', fontSize: 12, color: '#8c8c8c' }}>
                            <div>{cell.items.length} 单</div>
                            <div>{cell.totalHours.toFixed(1)}h</div>
                          </div>
                        </div>
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          {cell.items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无计划" />}
                          {cell.items.map((item) => (
                            <div
                              key={`${cell.dateKey}-${item.id}`}
                              role="button"
                              tabIndex={0}
                              onClick={() => setSelectedPlan(item)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  setSelectedPlan(item)
                                }
                              }}
                              style={{
                                padding: 10,
                                borderRadius: 10,
                                border: Number(item.id) === focusedPlanId
                                  ? '2px solid #1677ff'
                                  : `1px solid ${getDelayFlag(item) ? '#ffccc7' : '#d9d9d9'}`,
                                background: Number(item.id) === focusedPlanId
                                  ? '#e6f4ff'
                                  : getDelayFlag(item) ? '#fff1f0' : '#fff',
                                boxShadow: Number(item.id) === focusedPlanId ? '0 0 0 2px rgba(22,119,255,0.12)' : undefined,
                                cursor: 'pointer',
                              }}
                            >
                              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                                <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                                  <Tag color={BUCKET_META[getBucketKey(item)].color}>{item.schedule_bucket_label || BUCKET_META[getBucketKey(item)].label}</Tag>
                                  {item.needs_reschedule ? <Tag color="orange">待重排</Tag> : null}
                                </Space>
                                <div style={{ fontWeight: 600, color: '#1f1f1f' }}>{item.order_no || '-'} / {item.line_no || '-'}</div>
                                <div style={{ color: '#595959' }}>{item.product_code || item.model_code || '-'}</div>
                                <Space size={8} wrap>
                                  <span>数量 {item.quantity ?? '-'}</span>
                                  <span>工时 {getDailyHours(item).toFixed(1)}h</span>
                                </Space>
                                <Space size={6} wrap>
                                  {Number(item.id) === focusedPlanId ? <Tag color="blue">当前定位</Tag> : null}
                                  <Tag color={STATUS_COLOR_MAP[item.status || 'planned'] || 'default'}>{item.status || 'planned'}</Tag>
                                  {getDelayFlag(item) ? <Tag color="red">延期</Tag> : null}
                                  {RISK_CAPACITY_STATUS.has(item.capacity_load_status || '') ? <Tag color="gold">{item.capacity_load_status_label || '负荷紧张'}</Tag> : null}
                                </Space>
                              </Space>
                            </div>
                          ))}
                        </Space>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Space>
          )}

          {view === 'capacity' && (
            <Table
              rowKey="key"
              loading={loading}
              columns={capacityColumns}
              dataSource={capacityData}
              pagination={false}
              size="small"
              scroll={{ x: 1200 }}
              locale={{ emptyText: '当前周没有可展示的负荷数据' }}
            />
          )}

          {view === 'progress' && (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Space wrap size={16}>
                <Statistic title="计划总数" value={progressStats.total} />
                <Statistic title="已完成" value={progressStats.completed} valueStyle={{ color: '#389e0d' }} />
                <Statistic title="执行中" value={progressStats.in_progress} valueStyle={{ color: '#1677ff' }} />
                <Statistic title="已计划" value={progressStats.planned} />
                <Statistic title="延期" value={progressStats.delayed} valueStyle={{ color: '#cf1322' }} />
              </Space>
              <Table
                rowKey="id"
                loading={loading}
                columns={progressColumns}
                dataSource={plans}
                size="small"
                scroll={{ x: 1200 }}
                pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (count) => `共 ${count} 条` }}
              />
            </Space>
          )}
        </Space>
      </div>

      <Drawer
        title="计划详情"
        width={560}
        open={!!selectedPlan}
        onClose={() => setSelectedPlan(null)}
        extra={
          <Space>
            {selectedPlan ? (
              <Button type="primary" icon={<EyeOutlined />} onClick={() => navigate(buildPlanBoardLink(selectedPlan))}>
                定位到已排计划
              </Button>
            ) : null}
            <Button onClick={() => navigate('/schedule-plans')}>去计划排产</Button>
          </Space>
        }
      >
        {selectedPlan ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="订单号">{selectedPlan.order_no || '-'}</Descriptions.Item>
            <Descriptions.Item label="行号">{selectedPlan.line_no || '-'}</Descriptions.Item>
            <Descriptions.Item label="产品编码">{selectedPlan.product_code || '-'}</Descriptions.Item>
            <Descriptions.Item label="BOM 编码">{selectedPlan.bom_no || '-'}</Descriptions.Item>
            <Descriptions.Item label="排产段">
              <Tag color={BUCKET_META[getBucketKey(selectedPlan)].color}>{selectedPlan.schedule_bucket_label || BUCKET_META[getBucketKey(selectedPlan)].label}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="数量">{selectedPlan.quantity ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="UPPH">{selectedPlan.upph ? selectedPlan.upph.toFixed(2) : '-'}</Descriptions.Item>
            <Descriptions.Item label="计划日期">{formatDate(selectedPlan.plan_date)}</Descriptions.Item>
            <Descriptions.Item label="开始日期">{formatDate(selectedPlan.start_date)}</Descriptions.Item>
            <Descriptions.Item label="结束日期">{formatDate(selectedPlan.end_date || selectedPlan.plan_date)}</Descriptions.Item>
            <Descriptions.Item label="日工时">{getDailyHours(selectedPlan).toFixed(1)}h</Descriptions.Item>
            <Descriptions.Item label="客户交期">{formatDate(selectedPlan.customer_due_date)}</Descriptions.Item>
            <Descriptions.Item label="备货目标日">{formatDate(selectedPlan.target_ready_date)}</Descriptions.Item>
            <Descriptions.Item label="负责人">{selectedPlan.owner || '-'}</Descriptions.Item>
            <Descriptions.Item label="计划状态">
              <Tag color={STATUS_COLOR_MAP[selectedPlan.status || 'planned'] || 'default'}>{selectedPlan.status || 'planned'}</Tag>
              {getDelayFlag(selectedPlan) ? <Tag color="red">延期</Tag> : null}
              {selectedPlan.needs_reschedule ? <Tag color="orange">待重排</Tag> : null}
            </Descriptions.Item>
            <Descriptions.Item label="负荷提示">{selectedPlan.capacity_load_status_label || '-'}</Descriptions.Item>
            <Descriptions.Item label="重排原因">{selectedPlan.reschedule_reason || '-'}</Descriptions.Item>
            <Descriptions.Item label="备注">{selectedPlan.remark || '-'}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{formatDateTime(selectedPlan.created_at)}</Descriptions.Item>
          </Descriptions>
        ) : null}
      </Drawer>
    </div>
  )
}
