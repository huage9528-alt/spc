import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Col, Input, Row, Select, Space, Statistic, Table, Tag, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { productionApi } from '../../../services/api'
import { formatDate, formatDateTime } from '../../../utils'
import { BUCKET_OPTIONS, EVENT_TYPE_OPTIONS, EVENT_TYPE_MAP, IMPACT_MAP } from '../SchedulePlans/constants'
import { renderBucketTag, renderCopyableText } from '../SchedulePlans/helpers'
import RescheduleModal from '../components/RescheduleModal'
import CollapsibleStats from '../components/CollapsibleStats'

interface ChangeEventRow {
  event_id: string
  event_type: string
  order_no: string
  line_no: string | null
  product_code: string | null
  schedule_bucket: string | null
  schedule_bucket_label: string | null
  before_value_text: string | null
  after_value_text: string | null
  change_summary: string | null
  impact_reason: string | null
  impact_level: string | null
  needs_reschedule: boolean
  process_status: 'pending' | 'watching' | 'resolved'
  process_status_label: string | null
  process_operator: string | null
  process_at: string | null
  id: number
  source_upph: number | null
  current_upph: number | null
}

export default function ChangeEvents() {
  const navigate = useNavigate()
  const [rescheduleModalOpen, setRescheduleModalOpen] = useState(false)
  const [reschedulePlanData, setReschedulePlanData] = useState<any>(null)
  const [activeStat, setActiveStat] = useState<string | null>(null)

  const openReschedulePreview = (row: any) => {
    setReschedulePlanData(row)
    setRescheduleModalOpen(true)
  }
  const [data, setData] = useState<ChangeEventRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [impactLevel, setImpactLevel] = useState<string | undefined>()
  const [bucketFilter, setBucketFilter] = useState('all')
  const [eventTypeFilter, setEventTypeFilter] = useState('all')
  const [onlyPending, setOnlyPending] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])
  const [selectedPlanIds, setSelectedPlanIds] = useState<number[]>([])
  const [stats, setStats] = useState<{ upph_change: number; bucket_change: number; due_date_change: number; quantity_change: number; high: number; pending: number; watching: number; resolved: number }>({
    upph_change: 0, bucket_change: 0, due_date_change: 0, quantity_change: 0,
    high: 0, pending: 0, watching: 0, resolved: 0,
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page,
        page_size: pageSize,
        only_pending: onlyPending,
      }
      if (keyword.trim()) params.keyword = keyword.trim()
      if (impactLevel) params.impact_level = impactLevel
      if (bucketFilter !== 'all') params.schedule_bucket = bucketFilter
      if (eventTypeFilter !== 'all') params.event_type = eventTypeFilter

      const res: any = await productionApi.listChangeEvents(params)
      setData(res.data?.items || [])
      setTotal(res.data?.total || 0)
      setStats({
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
  }, [page, pageSize, keyword, impactLevel, bucketFilter, eventTypeFilter, onlyPending])

  useEffect(() => { load() }, [load])

  const handleUpdateStatus = async (processStatus: 'watching' | 'resolved' | 'pending', targetEventIds?: string[]) => {
    const eventIds = Array.from(new Set((targetEventIds || selectedKeys).map((item) => String(item)).filter(Boolean)))
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
        message.warning(`${statusLabelMap[processStatus]}完成：成功 ${result.success_count || 0} 条，失败 ${result.failed_count || 0} 条`)
      } else {
        message.success(`${statusLabelMap[processStatus]}完成`)
      }
      setSelectedKeys([])
      setSelectedPlanIds([])
      await load()
    } catch (e: any) {
      message.error(e.message || `${statusLabelMap[processStatus]}失败`)
    } finally {
      setLoading(false)
    }
  }

  const columns: ColumnsType<ChangeEventRow> = useMemo(() => [
    {
      title: '事件类型',
      width: 110,
      render: (_: any, row: ChangeEventRow) => {
        const eventMeta = EVENT_TYPE_MAP[row.event_type] || { label: row.event_type || '变更事件', color: 'default' }
        return <Tag color={eventMeta.color}>{eventMeta.label}</Tag>
      },
    },
    { title: '订单号', dataIndex: 'order_no', width: 150, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '排产段', width: 110, render: (_: any, row: ChangeEventRow) => renderBucketTag(row) },
    {
      title: '变更前后值',
      width: 180,
      render: (_: any, row: ChangeEventRow) => (
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
      render: (v: string, row: ChangeEventRow) => (
        <Space direction="vertical" size={2}>
          <span>{v || '-'}</span>
          <span style={{ color: '#8c8c8c', fontSize: 12 }}>{row.impact_reason || '-'}</span>
        </Space>
      ),
    },
    {
      title: '影响程度',
      dataIndex: 'impact_level',
      width: 100,
      render: (v: string) => <Tag color={IMPACT_MAP[v]?.color || 'default'}>{IMPACT_MAP[v]?.label || v}</Tag>,
    },
    {
      title: '建议动作',
      width: 120,
      render: (_: any, row: ChangeEventRow) => <span>{row.needs_reschedule ? '建议重排' : '建议关注'}</span>,
    },
    {
      title: '处理状态',
      width: 150,
      render: (_: any, row: ChangeEventRow) => (
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
      fixed: 'right',
      render: (_: any, row: ChangeEventRow) => (
        <Space size={4}>
          <Button
            size="small"
            type="primary"
            disabled={!row.needs_reschedule || row.process_status === 'resolved'}
            onClick={() => openReschedulePreview(row)}
          >
            预览重排
          </Button>
          {row.process_status === 'pending' ? (
            <>
              <Button size="small" onClick={() => handleUpdateStatus('watching', [row.event_id])}>暂不处理</Button>
              <Button size="small" onClick={() => handleUpdateStatus('resolved', [row.event_id])}>已处理</Button>
            </>
          ) : (
            <Button size="small" onClick={() => handleUpdateStatus('pending', [row.event_id])}>恢复待处理</Button>
          )}
        </Space>
      ),
    },
  ], [navigate, handleUpdateStatus])

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row align="middle" justify="space-between">
          <Col>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>变更事件中心</div>
            <div style={{ color: '#64748b', fontSize: 12 }}>
              全部变更事件集中处理 · 接口真实数据
            </div>
          </Col>
          <Col>
            <Space>
              <Button size="small" onClick={() => navigate('/todo-workbench')}>📋 待排工作台</Button>
              <Button size="small" onClick={() => navigate('/schedule-plans')}>📊 排产台账</Button>
              <Button size="small" onClick={() => navigate('/production-dashboard')}>🏠 驾驶舱</Button>
            </Space>
          </Col>
        </Row>

        {/* 统计卡（可折叠） */}
        <CollapsibleStats title="变更统计" storageKey="change_events" summary={`待处理 ${stats.pending} · 高影响 ${stats.high} · UPPH变化 ${stats.upph_change}`}>
        <Row gutter={12} style={{ marginBottom: 12 }}>
          {[
            { key: 'pending', label: '待处理事件', value: stats.pending, color: '#cf1322', filter: { only_pending: true } },
            { key: 'high', label: '高影响', value: stats.high, color: '#cf1322', filter: { impact_level: 'high' } },
            { key: 'upph_change', label: 'UPPH变化', value: stats.upph_change, color: '#722ed1', filter: { event_type: 'upph_change' } },
            { key: 'bucket_change', label: '排产段变化', value: stats.bucket_change, color: '#eb2f96', filter: { event_type: 'bucket_change' } },
            { key: 'due_date_change', label: '交期变化', value: stats.due_date_change, color: '#fa8c16', filter: { event_type: 'due_date_change' } },
            { key: 'quantity_change', label: '数量变化', value: stats.quantity_change, color: '#13c2c2', filter: { event_type: 'quantity_change' } },
            { key: 'watching', label: '暂不处理', value: stats.watching, color: '#8c8c8c', filter: { process_status: 'watching' } },
            { key: 'resolved', label: '已处理', value: stats.resolved, color: '#52c41a', filter: { process_status: 'resolved' } },
          ].map((item) => {
            const active = activeStat === item.key
            return (
              <Col key={item.key} xs={12} md={6} lg={3}>
                <div
                  className="card-modern"
                  style={{
                    padding: 12,
                    cursor: 'pointer',
                    background: active ? '#f0f5ff' : '#fff',
                    border: active ? '2px solid #1677ff' : '1px solid #f0f0f0',
                  }}
                  onClick={() => {
                    if (active) {
                      // 再点一次取消筛选
                      setActiveStat(null)
                      setOnlyPending(false)
                      setImpactLevel(undefined)
                      setEventTypeFilter('all')
                    } else {
                      setActiveStat(item.key)
                      const f = item.filter
                      setOnlyPending(f.only_pending || false)
                      setImpactLevel(f.impact_level)
                      setEventTypeFilter(f.event_type || 'all')
                    }
                    setPage(1)
                  }}
                >
                  <Statistic
                    title={item.label}
                    value={item.value}
                    valueStyle={{ color: item.color, fontSize: 22 }}
                  />
                </div>
              </Col>
            )
          })}
        </Row>
        </CollapsibleStats>

        {/* 工具栏 */}
        <Row gutter={12} align="middle">
          <Col>
            <Input
              prefix={<SearchOutlined />}
              value={keyword}
              onChange={(e) => { setKeyword(e.target.value); setPage(1) }}
              placeholder="搜索订单/产品/负责人"
              allowClear
              style={{ width: 220 }}
            />
          </Col>
          <Col>
            <Select value={bucketFilter} onChange={(v) => { setBucketFilter(v); setPage(1) }} style={{ width: 130 }} options={BUCKET_OPTIONS} />
          </Col>
          <Col>
            <Select allowClear placeholder="影响等级" value={impactLevel} onChange={(v) => { setImpactLevel(v); setPage(1) }} style={{ width: 120 }} options={Object.entries(IMPACT_MAP).map(([value, item]) => ({ value, label: item.label }))} />
          </Col>
          <Col>
            <Select value={eventTypeFilter} onChange={(v) => { setEventTypeFilter(v); setPage(1) }} style={{ width: 130 }} options={EVENT_TYPE_OPTIONS} />
          </Col>
          <Col>
            <Button type={onlyPending ? 'primary' : 'default'} onClick={() => { setOnlyPending((prev) => !prev); setPage(1) }}>
              {onlyPending ? '只看待处理' : '全部事件'}
            </Button>
          </Col>
          <Col flex="auto" />
          <Col>
            <Space>
              <span style={{ color: '#595959' }}>共 {total} 条</span>
              <Button disabled={selectedKeys.length === 0} onClick={() => handleUpdateStatus('watching')}>批量暂不处理</Button>
              <Button disabled={selectedKeys.length === 0} onClick={() => handleUpdateStatus('resolved')}>批量已处理</Button>
              <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            </Space>
          </Col>
        </Row>
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table<ChangeEventRow>
          rowKey="event_id"
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: (keys) => setSelectedKeys(keys),
            getCheckboxProps: (row) => ({ disabled: row.process_status !== 'pending' }),
          }}
          dataSource={data}
          columns={columns}
          loading={loading}
          size="small"
          scroll={{ x: 1750 }}
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
        变更事件中心 · 真实数据来自 listChangeEvents 接口 · 预览重排直接弹 Modal
      </div>

      <RescheduleModal
        open={rescheduleModalOpen}
        planData={reschedulePlanData}
        onClose={() => { setRescheduleModalOpen(false); setReschedulePlanData(null) }}
        onSuccess={() => load()}
      />
    </div>
  )
}
