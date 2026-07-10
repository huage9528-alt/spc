import { useEffect, useState, useCallback } from 'react'
import { Button, Card, Col, Empty, Input, Row, Select, Space, Statistic, Table, Tag, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/production'
import { formatDate } from '../../../utils'
import CollapsibleStats from './CollapsibleStats'

interface TrendItem {
  date: string
  order_count: number
  total_qty: number
}

interface TopOrder {
  order_no: string
  line_no: string | null
  product_code: string | null
  model_code: string | null
  qty: number | null
  plan_date: string | null
  start_date: string | null
  end_date: string | null
  status: string
}

interface OverviewData {
  process_type: string
  workshop_label: string
  stats: { total: number; in_progress: number; upcoming: number; completed: number }
  trend: TrendItem[]
  top_orders: TopOrder[]
}

const STATUS_TAG: Record<string, { label: string; color: string }> = {
  planned: { label: '已计划', color: 'blue' },
  in_progress: { label: '执行中', color: 'processing' },
  completed: { label: '已完成', color: 'success' },
  delayed: { label: '延期', color: 'warning' },
}

export default function WorkshopDashboard({ processType, title }: { processType: 'lean' | 'assembly' | 'packaging'; title: string }) {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(false)
  const [orders, setOrders] = useState<any[]>([])
  const [ordersTotal, setOrdersTotal] = useState(0)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [year, setYear] = useState(dayjs().year())
  const [month, setMonth] = useState(dayjs().month() + 1)

  const loadOverview = async () => {
    setLoading(true)
    try {
      const res: any = await productionApi.getWorkshopOverview({ process_type: processType })
      setData(res.data)
    } catch (e: any) {
      message.error(e.message || '获取车间概况失败')
    } finally {
      setLoading(false)
    }
  }

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true)
    try {
      // 默认按当月范围过滤
      const monthStart = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month').format('YYYY-MM-DD')
      const monthEnd = dayjs(monthStart).endOf('month').format('YYYY-MM-DD')
      const params: Record<string, any> = {
        page,
        page_size: pageSize,
        is_active: true,
        schedule_bucket: processType,
        date_start: monthStart,
        date_end: monthEnd,
      }
      if (keyword.trim()) params.keyword = keyword.trim()
      if (statusFilter) params.status = statusFilter
      const res: any = await productionApi.listSchedulePlans(params)
      setOrders(res.data?.items || [])
      setOrdersTotal(res.data?.total || 0)
    } catch (e: any) {
      message.error(e.message || '获取订单列表失败')
    } finally {
      setOrdersLoading(false)
    }
  }, [page, pageSize, keyword, statusFilter, processType, year, month])

  useEffect(() => { loadOverview() }, [processType])
  useEffect(() => { loadOrders() }, [loadOrders])

  if (!data) {
    return (
      <div className="card-modern" style={{ padding: 20, textAlign: 'center', color: '#999' }}>
        {loading ? '加载中...' : '暂无数据'}
      </div>
    )
  }

  const stats = data.stats

  // 趋势柱状图（简单 CSS 实现，不引第三方图表库）
  const maxCount = Math.max(...(data.trend.map((t) => t.order_count) || [1]), 1)

  const topColumns: ColumnsType<TopOrder> = [
    { title: '订单号', dataIndex: 'order_no', width: 140, render: (v: string) => v || '-' },
    { title: '行号', dataIndex: 'line_no', width: 80, render: (v: string) => v || '-' },
    { title: '型号', dataIndex: 'model_code', width: 180, ellipsis: true, render: (v: string) => v || '-' },
    { title: '数量', dataIndex: 'qty', width: 90, render: (v: number) => v ?? '-' },
    { title: '计划日', dataIndex: 'plan_date', width: 110, render: (v: string) => formatDate(v) },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) => {
        const s = STATUS_TAG[v] || { label: v, color: 'default' }
        return <Tag color={s.color}>{s.label}</Tag>
      },
    },
  ]

  return (
    <div>
      {/* 1+2+3：统计卡 + 趋势图 + TOP5，统一折叠 */}
      <CollapsibleStats title={`${data.workshop_label}概况`} storageKey={`workshop_${processType}`} summary={`总单 ${stats.total} · 在产 ${stats.in_progress} · 待产 ${stats.upcoming} · 已完成 ${stats.completed}`}>
        <Row gutter={12} style={{ marginBottom: 12 }}>
          {[
            { label: '总单数', value: stats.total, color: '#6366f1' },
            { label: '在产', value: stats.in_progress, color: '#16a34a' },
            { label: '待产', value: stats.upcoming, color: '#f59e0b' },
            { label: '已完成', value: stats.completed, color: '#94a3b8' },
          ].map((item) => (
            <Col key={item.label} xs={12} md={6}>
              <div className="card-modern" style={{ padding: 16 }}>
                <Statistic title={item.label} value={item.value} valueStyle={{ color: item.color, fontSize: 28 }} />
              </div>
            </Col>
          ))}
        </Row>

        <Row gutter={12}>
          {/* 左：趋势柱状图 */}
          <Col xs={24} md={12}>
            <Card size="small" title="近 10 天计划排产趋势" style={{ height: '100%' }}>
              {data.trend.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近期无排产计划" />
              ) : (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 200, padding: '0 8px' }}>
                  {data.trend.map((item) => {
                    const heightPct = (item.order_count / maxCount) * 100
                    const d = item.date ? item.date.substring(5) : ''
                    return (
                      <div key={item.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 11, color: '#64748b' }}>{item.order_count}</span>
                        <div style={{
                          width: '100%',
                          maxWidth: 40,
                          height: `${heightPct}%`,
                          minHeight: 4,
                          background: processType === 'lean' ? '#3b82f6' : processType === 'assembly' ? '#8b5cf6' : '#06b6d4',
                          borderRadius: '4px 4px 0 0',
                          transition: 'height 0.3s',
                        }} />
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>{d}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          </Col>

          {/* 右：重点订单文字 */}
          <Col xs={24} md={12}>
            <Card size="small" title="重点订单（TOP 5）" style={{ height: '100%' }}>
              {data.top_orders.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无订单" />
              ) : (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {data.top_orders.map((order, i) => {
                    const isInProgress = order.start_date && order.end_date &&
                      new Date(order.start_date) <= new Date() && new Date(order.end_date) >= new Date()
                    return (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 0',
                        borderBottom: i < data.top_orders.length - 1 ? '1px solid #f1f5f9' : 'none',
                      }}>
                        <span style={{
                          width: 20, height: 20, borderRadius: '50%',
                          background: isInProgress ? '#16a34a' : '#e2e8f0',
                          color: isInProgress ? '#fff' : '#64748b',
                          fontSize: 11, fontWeight: 600,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}>{i + 1}</span>
                        <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}>{order.order_no}</span>
                        <span style={{ color: '#64748b', fontSize: 12 }}>{order.qty ?? '-'} 件</span>
                        {isInProgress
                          ? <Tag color="success" style={{ fontSize: 11 }}>在产</Tag>
                          : <span style={{ color: '#94a3b8', fontSize: 11 }}>{formatDate(order.plan_date)}</span>}
                      </div>
                    )
                  })}
                </Space>
              )}
            </Card>
          </Col>
        </Row>
      </CollapsibleStats>

      {/* 4. 完整订单明细表格 */}
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row align="middle" justify="space-between" style={{ marginBottom: 12 }}>
          <Col><span style={{ fontSize: 15, fontWeight: 600 }}>{data.workshop_label}订单明细（{year}年{month}月 · 共 {ordersTotal} 条）</span></Col>
          <Col>
            <Space>
              <Select
                value={year}
                onChange={(v) => { setYear(v); setPage(1) }}
                style={{ width: 90 }}
                options={Array.from({ length: 7 }, (_, i) => ({ value: dayjs().year() - 3 + i, label: `${dayjs().year() - 3 + i}年` }))}
              />
              <Select
                value={month}
                onChange={(v) => { setMonth(v); setPage(1) }}
                style={{ width: 70 }}
                options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}月` }))}
              />
              <Input
                prefix={<SearchOutlined />}
                placeholder="搜索订单/产品/型号"
                value={keyword}
                onChange={(e) => { setKeyword(e.target.value); setPage(1) }}
                allowClear
                style={{ width: 200 }}
              />
              <Select
                allowClear
                placeholder="状态"
                value={statusFilter || undefined}
                onChange={(v) => { setStatusFilter(v || ''); setPage(1) }}
                style={{ width: 120 }}
                options={[
                  { value: 'planned', label: '已计划' },
                  { value: 'in_progress', label: '执行中' },
                  { value: 'completed', label: '已完成' },
                  { value: 'delayed', label: '延期' },
                ]}
              />
              <Button size="small" icon={<ReloadOutlined />} onClick={() => { loadOverview(); loadOrders() }}>刷新</Button>
            </Space>
          </Col>
        </Row>
        <Table
          rowKey={(row: any) => `${row.id}`}
          dataSource={orders}
          loading={ordersLoading}
          size="small"
          scroll={{ x: 1400 }}
          pagination={{
            total: ordersTotal,
            current: page,
            pageSize,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
          }}
          columns={[
            { title: '订单号', dataIndex: 'order_no', width: 150, render: (v: string) => v || '-' },
            { title: '行号', dataIndex: 'line_no', width: 80, render: (v: string) => v || '-' },
            { title: '产品编码', dataIndex: 'product_code', width: 180, ellipsis: true, render: (v: string) => v || '-' },
            { title: '型号', dataIndex: 'model_code', width: 160, ellipsis: true, render: (v: string) => v || '-' },
            { title: '数量', dataIndex: 'quantity', width: 90, render: (v: number) => v ?? '-' },
            { title: '计划日', dataIndex: 'plan_date', width: 110, render: (v: string) => formatDate(v) },
            { title: '开始', dataIndex: 'start_date', width: 110, render: (v: string) => formatDate(v) },
            { title: '结束', dataIndex: 'end_date', width: 110, render: (v: string) => formatDate(v) },
            { title: '负责人', dataIndex: 'owner', width: 100, render: (v: string) => v || '-' },
            {
              title: '状态', dataIndex: 'status', width: 90,
              render: (v: string) => {
                const s = STATUS_TAG[v] || { label: v, color: 'default' }
                return <Tag color={s.color}>{s.label}</Tag>
              },
            },
            { title: 'UPPH', dataIndex: 'upph', width: 80, render: (v: number) => v ? Number(v).toFixed(2) : '-' },
            { title: '每日工时', dataIndex: 'daily_work_hours', width: 90, render: (v: number) => v ? `${Number(v).toFixed(1)}h` : '-' },
          ]}
        />
      </div>
    </div>
  )
}
