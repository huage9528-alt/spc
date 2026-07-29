import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Col, DatePicker, Input, Row, Select, Space, Statistic, Table, Tag, Tooltip, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ReloadOutlined, SearchOutlined, ThunderboltOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/api'
import { formatDate } from '../../../utils'
import { TODO_FILTER_OPTIONS, TODO_BUCKET_WORKSPACE_OPTIONS, TODO_STATUS_META } from '../SchedulePlans/constants'
import { renderBucketTag, renderCopyableText, renderSchedulingReasonCell, renderSchedulingStatusTag } from '../SchedulePlans/helpers'
import ScheduleModal from '../components/ScheduleModal'
import BatchScheduleModal from '../components/BatchScheduleModal'
import CollapsibleStats from '../components/CollapsibleStats'
import BaseConditionDrawer from '../components/BaseConditionDrawer'

interface TodoRow {
  id: number
  order_no: string
  line_no: string | null
  product_code: string | null
  bom_no: string | null
  order_qty: number | null
  quantity: number | null
  promised_date: string | null
  source_promised_date: string | null
  schedule_bucket: string | null
  schedule_bucket_label: string | null
  todo_kind: string
  todo_status_label: string | null
  todo_action_label: string | null
  reschedule_reason: string | null
  impact_reason: string | null
  display_status: string | null
  scheduling_status: string | null
  display_status_label: string | null
  scheduling_status_label: string | null
  scheduling_reason_code: string | null
  scheduling_reason: string | null
  upph: number | null
}

export default function TodoWorkbench() {
  const navigate = useNavigate()
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [scheduleOrder, setScheduleOrder] = useState<any>(null)
  const [batchScheduleOpen, setBatchScheduleOpen] = useState(false)
  const [baseConditionOpen, setBaseConditionOpen] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [selectedRows, setSelectedRows] = useState<any[]>([])

  const openSchedule = (row: any) => {
    setScheduleOrder(row)
    setScheduleModalOpen(true)
  }

  const openBatchSchedule = () => {
    const schedulableRows = selectedRows.filter((row) => row.todo_kind === 'ready')
    if (schedulableRows.length === 0) {
      message.warning('请先勾选待排产订单')
      return
    }
    setBatchScheduleOpen(true)
  }
  const [data, setData] = useState<TodoRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [year, setYear] = useState(dayjs().year())
  const [month, setMonth] = useState(dayjs().month() + 1)
  const [todoStatusFilter, setTodoStatusFilter] = useState('all')
  const [bucketFilter, setBucketFilter] = useState('all')
  const [stats, setStats] = useState<{ ready: number; pending: number; reschedule: number; missing_upph: number; bucket_counts?: Record<string, number> }>({ ready: 0, pending: 0, reschedule: 0, missing_upph: 0 })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page,
        page_size: pageSize,
        year,
        month,
      }
      if (keyword.trim()) params.keyword = keyword.trim()
      if (todoStatusFilter !== 'all') params.todo_status = todoStatusFilter
      if (bucketFilter !== 'all') params.schedule_bucket = bucketFilter

      const res: any = await productionApi.getTodoWorkbench(params)
      setData(res.data?.items || [])
      setTotal(res.data?.total || 0)
      setStats({
        ready: res.data?.stats?.ready || 0,
        pending: res.data?.stats?.pending || 0,
        reschedule: res.data?.stats?.reschedule || 0,
        missing_upph: res.data?.stats?.missing_upph || 0,
        bucket_counts: res.data?.stats?.bucket_counts,
      })
    } catch (e: any) {
      message.error(e.message || '获取待处理列表失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, keyword, year, month, todoStatusFilter, bucketFilter])

  useEffect(() => { load() }, [load])

  const counts = useMemo(() => ({
    reschedule: stats.reschedule || 0,
    ready: stats.ready || 0,
    pending: stats.pending || 0,
  }), [stats])

  const bucketCounts = useMemo(() => ({
    all: stats.bucket_counts?.all || 0,
    lean: stats.bucket_counts?.lean || 0,
    assembly: stats.bucket_counts?.assembly || 0,
    packaging: stats.bucket_counts?.packaging || 0,
  }), [stats])

  const columns: ColumnsType<TodoRow> = useMemo(() => [
    {
      title: '订单号',
      dataIndex: 'order_no',
      width: 150,
      fixed: 'left',
      render: (v: string) => renderCopyableText(v, '订单号'),
    },
    { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: 'BOM编码', dataIndex: 'bom_no', width: 160, ellipsis: true, render: (v: string) => renderCopyableText(v, 'BOM编码') },
    { title: '数量', width: 90, render: (_: any, row: TodoRow) => row.order_qty ?? row.quantity ?? '-' },
    { title: '出货计划', width: 110, render: (_: any, row: TodoRow) => formatDate(row.promised_date || row.source_promised_date) },
    { title: '排产段', width: 110, render: (_: any, row: TodoRow) => renderBucketTag(row) },
    {
      title: '状态',
      width: 100,
      render: (_: any, row: TodoRow) => {
        const statusMeta = TODO_STATUS_META[row.todo_kind] || TODO_STATUS_META.pending
        return <Tag color={statusMeta.color}>{row.todo_status_label || statusMeta.label}</Tag>
      },
    },
    {
      title: '原因',
      width: 320,
      render: (_: any, row: TodoRow) => {
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
    { title: '建议动作', width: 120, render: (_: any, row: TodoRow) => <span style={{ color: '#595959' }}>{row.todo_action_label || '-'}</span> },
    {
      title: '操作',
      width: 180,
      fixed: 'right',
      render: (_: any, row: TodoRow) => {
        if (row.todo_kind === 'ready') {
          return (
            <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={() => openSchedule(row)}>
              {row.schedule_bucket === 'mixed' ? '生成两段' : '排产'}
            </Button>
          )
        }
        if (row.todo_kind === 'reschedule') {
          return (
            <Button size="small" type="primary" ghost onClick={() => navigate(`/schedule-plans?workspace=plan_board&planId=${row.id}&keyword=${row.order_no}`)}>
              预览重排
            </Button>
          )
        }
        return (
          <Button size="small" type="link" onClick={() => navigate(`/schedule-plans?workspace=plan_board&planId=${row.id}&keyword=${row.order_no}`)}>
            查看
          </Button>
        )
      },
    },
  ], [navigate])

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row align="middle" justify="space-between">
          <Col>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>待排工作台</div>
            <div style={{ color: '#64748b', fontSize: 12 }}>
              待排/待重排/待确认订单集中处理 · 接口真实数据
            </div>
          </Col>
          <Col>
            <Space>
              <Button size="small" onClick={() => navigate('/change-events')}>🔄 变更事件中心</Button>
              <Button size="small" onClick={() => navigate('/schedule-plans')}>📊 排产台账</Button>
              <Button size="small" onClick={() => navigate('/production-dashboard')}>🏠 驾驶舱</Button>
            </Space>
          </Col>
        </Row>

        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {/* bucket 切换 */}
          <Space>
            {TODO_BUCKET_WORKSPACE_OPTIONS.map((item) => (
              <Button
                key={item.value}
                size="small"
                type={bucketFilter === item.value ? 'primary' : 'default'}
                onClick={() => { setBucketFilter(item.value); setPage(1) }}
              >
                {item.label} ({bucketCounts[item.value as keyof typeof bucketCounts] || 0})
              </Button>
            ))}
          </Space>

          {/* 统计卡（可折叠） */}
          <CollapsibleStats title="待排统计" storageKey="todo_workbench" summary={`待排产 ${counts.ready} · 待重排 ${counts.reschedule} · 待确认 ${counts.pending}`}>
          <Row gutter={12}>
            {[
              { key: 'reschedule', label: '待重排', value: counts.reschedule, color: '#cf1322' },
              { key: 'ready', label: '待排产', value: counts.ready, color: '#1677ff' },
              { key: 'pending', label: '待确认', value: counts.pending, color: '#fa8c16' },
            ].map((item) => (
              <Col key={item.label} xs={12} md={8}>
                <div
                  className="card-modern"
                  style={{
                    padding: 16,
                    cursor: 'pointer',
                    background: todoStatusFilter === item.key ? '#f0f5ff' : '#fff',
                    border: todoStatusFilter === item.key ? '1px solid #1677ff' : '1px solid #f0f0f0',
                  }}
                  onClick={() => {
                    setTodoStatusFilter(todoStatusFilter === item.key ? 'all' : item.key)
                    setPage(1)
                  }}
                >
                  <Statistic title={item.label} value={item.value} valueStyle={{ color: item.color, fontSize: 24 }} />
                </div>
              </Col>
            ))}
          </Row>
          </CollapsibleStats>

          {/* 工具栏 */}
          <Row gutter={12} align="middle">
            <Col>
              <Select value={year} onChange={(v) => { setYear(v); setPage(1) }} style={{ width: 110 }} options={Array.from({ length: 7 }, (_, i) => ({ value: dayjs().year() - 3 + i, label: `${dayjs().year() - 3 + i}年` }))} />
            </Col>
            <Col>
              <Select value={month} onChange={(v) => { setMonth(v); setPage(1) }} style={{ width: 90 }} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}月` }))} />
            </Col>
            <Col>
              <Input
                prefix={<SearchOutlined />}
                value={keyword}
                onChange={(e) => { setKeyword(e.target.value); setPage(1) }}
                placeholder="搜索订单/BOM/产品"
                allowClear
                style={{ width: 240 }}
              />
            </Col>
            <Col>
              <Select value={todoStatusFilter} onChange={(v) => { setTodoStatusFilter(v); setPage(1) }} style={{ width: 130 }} options={TODO_FILTER_OPTIONS} />
            </Col>
            <Col flex="auto" />
            <Col>
              <Space>
                <span style={{ color: '#595959' }}>
                  共 {total} 条，已选 {selectedRows.length} 条（其中待排产 {selectedRows.filter(r => r.todo_kind === 'ready').length} 条）
                </span>
                <Button onClick={() => setBaseConditionOpen(true)}>基础条件</Button>
                <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
                <Tooltip title={selectedRows.filter(r => r.todo_kind === 'ready').length > 0 ? `批量排产 ${selectedRows.filter(r => r.todo_kind === 'ready').length} 条` : '请先勾选待排产订单'}>
                  <Button type="primary" icon={<ThunderboltOutlined />} disabled={selectedRows.filter(r => r.todo_kind === 'ready').length === 0} onClick={openBatchSchedule}>
                    批量排产
                  </Button>
                </Tooltip>
              </Space>
            </Col>
          </Row>
        </Space>
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table<TodoRow>
          rowKey={(row) => row.id || `${row.order_no}-${row.line_no}-${row.todo_kind}`}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys, rows) => {
              setSelectedRowKeys(keys)
              setSelectedRows(rows)
            },
            getCheckboxProps: (row) => ({ disabled: row.todo_kind !== 'ready' }),
          }}
          dataSource={data}
          columns={columns}
          loading={loading}
          size="small"
          scroll={{ x: 1680, y: 600 }}
          pagination={{
            total,
            current: page,
            pageSize,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
          }}
        />
      </div>

      <div style={{ color: '#94a3b8', fontSize: 11, textAlign: 'center', padding: '8px 0' }}>
        待排工作台 · 真实数据来自 getTodoWorkbench 接口 · 单条/批量排产直接弹 Modal，重排/查看跳排产台账
      </div>

      <ScheduleModal
        open={scheduleModalOpen}
        orderData={scheduleOrder}
        onClose={() => { setScheduleModalOpen(false); setScheduleOrder(null) }}
        onSuccess={() => {
          load()
          message.success('排产成功，已自动刷新列表', 2)
        }}
      />

      <BatchScheduleModal
        open={batchScheduleOpen}
        orderRows={selectedRows}
        onClose={() => setBatchScheduleOpen(false)}
        onSuccess={() => {
          setSelectedRowKeys([])
          setSelectedRows([])
          // 延迟刷新: 批量排产刚结束, 后端可能还在处理 snapshot 同步等后续工作
          // 立即刷新可能撞上后端忙碌导致超时, 延迟 1 秒给后端喘息
          setTimeout(() => {
            load().catch(() => {
              // 静默失败, 不弹"网络错误"打扰用户 (排产已成功, 刷新失败不影响结果)
            })
          }, 1000)
          message.success('批量排产完成，列表将在后台自动刷新', 2)
        }}
      />

      <BaseConditionDrawer
        open={baseConditionOpen}
        onClose={() => setBaseConditionOpen(false)}
      />
    </div>
  )
}
