import React, { useState, useEffect, useCallback } from 'react'
import { Table, Button, Space, Input, Select, Switch, Tag, Tooltip, Card, Statistic, Row, Col, DatePicker, message } from 'antd'
import { SearchOutlined, ReloadOutlined, CloudSyncOutlined } from '@ant-design/icons'
import dayjs, { Dayjs } from 'dayjs'
import { productionApi } from '@/services/api'

const { Option } = Select
const { RangePicker } = DatePicker

type RangeValue = [Dayjs | null, Dayjs | null] | null

const UPPH_SOURCE_MAP: Record<string, { label: string; color: string }> = {
  formula: { label: '自动计算', color: 'blue' },
  oa: { label: '沿用OA', color: 'green' },
  manual: { label: '手工覆盖', color: 'gold' },
  none: { label: '待确认', color: 'default' },
}

// 已知车间全集(用于下拉, 默认只勾装配)
const ALL_WORKSHOPS = [
  '装配一线', '装配二线', '精益车间', '喷塑车间', '电源车间', '压铸车间',
  '前加工车间', '光源车间', '生产车间', '光电车间', '结构部样品制作', '工程部样品制作',
]

// 跨月快捷范围预设
const buildRangePresets = () => {
  const now = dayjs()
  return [
    { label: '本月', value: [now.startOf('month'), now.endOf('month')] as [Dayjs, Dayjs] },
    { label: '上月', value: [now.subtract(1, 'month').startOf('month'), now.subtract(1, 'month').endOf('month')] as [Dayjs, Dayjs] },
    { label: '近3个月', value: [now.subtract(2, 'month').startOf('month'), now.endOf('month')] as [Dayjs, Dayjs] },
    { label: '近6个月', value: [now.subtract(5, 'month').startOf('month'), now.endOf('month')] as [Dayjs, Dayjs] },
    { label: '今年', value: [now.startOf('year'), now.endOf('year')] as [Dayjs, Dayjs] },
  ]
}

interface WageStats {
  total: number
  has_wage: number
  no_wage: number
  no_wage_no_bom: number
  no_wage_not_covered: number
  no_wage_zero: number
}

interface TaskStats {
  total: number
  open: number
  closed: number
  by_workshop: Record<string, number>
}

// ==================== 页签一: 订单工价 ====================
const OrderWageTab: React.FC = () => {
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<WageStats>({ total: 0, has_wage: 0, no_wage: 0, no_wage_no_bom: 0, no_wage_not_covered: 0, no_wage_zero: 0 })

  const [searchOrderNo, setSearchOrderNo] = useState('')
  const [searchProductCode, setSearchProductCode] = useState('')
  const [searchBomNo, setSearchBomNo] = useState('')
  const [searchCustomer, setSearchCustomer] = useState('')
  const [searchWageStatus, setSearchWageStatus] = useState<'all' | 'has' | 'no'>('all')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [onlyWithTasks, setOnlyWithTasks] = useState(true)
  const [promisedRange, setPromisedRange] = useState<RangeValue>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [syncLoading, setSyncLoading] = useState(false)

  const handleSyncOA = async () => {
    setSyncLoading(true)
    try {
      const res = await productionApi.syncOrderWageFromOA()
      const d = res.data || {}
      message.success(`OA工价同步完成: 更新 ${d.updated ?? 0} 条, 新增 ${d.created ?? 0} 条`)
      if (page !== 1) {
        setPage(1)
      } else {
        fetchData()
      }
    } catch (error: any) {
      // 错误已由全局拦截器提示
    } finally {
      setSyncLoading(false)
    }
  }

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = {
        page,
        page_size: pageSize,
        order_no: searchOrderNo || undefined,
        product_code: searchProductCode || undefined,
        bom_no: searchBomNo || undefined,
        customer: searchCustomer || undefined,
        wage_status: searchWageStatus === 'all' ? undefined : searchWageStatus,
        include_closed: includeClosed,
        only_with_tasks: onlyWithTasks,
        promised_from: promisedRange?.[0] ? promisedRange[0].format('YYYY-MM-DD') : undefined,
        promised_to: promisedRange?.[1] ? promisedRange[1].format('YYYY-MM-DD') : undefined,
      }
      const res = await productionApi.lookupOrderWage(params)
      setData(res.data.items || [])
      setTotal(res.data.total || 0)
      setStats(res.data.stats || { total: 0, has_wage: 0, no_wage: 0, no_wage_no_bom: 0, no_wage_not_covered: 0, no_wage_zero: 0 })
    } catch (error: any) {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, searchOrderNo, searchProductCode, searchBomNo, searchCustomer, searchWageStatus, includeClosed, onlyWithTasks, promisedRange])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleSearch = () => {
    if (page !== 1) {
      setPage(1)
      return
    }
    fetchData()
  }

  const handleReset = () => {
    setSearchOrderNo('')
    setSearchProductCode('')
    setSearchBomNo('')
    setSearchCustomer('')
    setSearchWageStatus('all')
    setIncludeClosed(false)
    setOnlyWithTasks(true)
    setPromisedRange(null)
    if (page !== 1) {
      setPage(1)
      return
    }
    fetchData()
  }

  const wageStatusTag = (record: any) => {
    if (record.wage_status === 'has_wage') {
      return <Tag color="green">有工价</Tag>
    }
    return (
      <Tooltip title={record.wage_no_reason}>
        <Tag color="red">无工价</Tag>
      </Tooltip>
    )
  }

  const columns: any[] = [
    {
      title: '订单号/行号',
      dataIndex: 'order_no',
      key: 'order_no',
      width: 200,
      render: (_: any, r: any) => (
        <span>
          {r.order_no}
          <span style={{ color: '#999' }}> / {r.line_no || '-'}</span>
        </span>
      ),
    },
    { title: '客户', dataIndex: 'customer', key: 'customer', width: 130, ellipsis: true },
    {
      title: '产品编码',
      dataIndex: 'product_code',
      key: 'product_code',
      width: 200,
      ellipsis: true,
      render: (v: string) => v || '-',
    },
    {
      title: 'BOM编码',
      dataIndex: 'bom_no',
      key: 'bom_no',
      width: 220,
      ellipsis: true,
      render: (v: string) => v || <span style={{ color: '#999' }}>(无)</span>,
    },
    { title: '下单日期', dataIndex: 'order_date', key: 'order_date', width: 110 },
    { title: '交期', dataIndex: 'promised_date', key: 'promised_date', width: 110 },
    { title: '数量', dataIndex: 'order_qty', key: 'order_qty', width: 90, align: 'right' as const },
    {
      title: '工价状态',
      dataIndex: 'wage_status',
      key: 'wage_status',
      width: 100,
      render: (_: any, r: any) => wageStatusTag(r),
    },
    {
      title: '匹配方式',
      dataIndex: 'match_type',
      key: 'match_type',
      width: 110,
      render: (v: string) => {
        if (v === 'bom') return <Tag color="blue">BOM精确</Tag>
        if (v === 'bom_stripped') return <Tag color="geekblue">BOM去前缀</Tag>
        return <Tag>未匹配</Tag>
      },
    },
    {
      title: '工价合计(元)',
      dataIndex: 'wage_total',
      key: 'wage_total',
      width: 110,
      align: 'right' as const,
      render: (v: number) => (v != null ? v.toFixed(4) : '-'),
    },
    {
      title: '工序数',
      key: 'detail_count',
      width: 80,
      align: 'right' as const,
      render: (_: any, r: any) => (r.details || []).length || '-',
    },
    {
      title: '任务单数',
      key: 'task_count',
      width: 90,
      align: 'right' as const,
      render: (_: any, r: any) => {
        const asm = (r.task_orders || []).filter((t: any) => (t.workshop || '').includes('装配')).length
        const all = (r.task_orders || []).length
        if (!all) return <span style={{ color: '#999' }}>0</span>
        return <span>{all}{asm ? <span style={{ color: '#1677ff' }}> (装{asm})</span> : null}</span>
      },
    },
  ]

  const detailColumns: any[] = [
    { title: '工序', dataIndex: 'process_type', key: 'process_type', width: 110 },
    { title: '车间', dataIndex: 'workshop', key: 'workshop', width: 110, render: (v: string) => v || '-' },
    {
      title: '工价来源BOM',
      dataIndex: 'source_bom',
      key: 'source_bom',
      width: 220,
      ellipsis: true,
      render: (v: string) => v || '-',
    },
    {
      title: '工价(元)',
      dataIndex: 'gjje',
      key: 'gjje',
      width: 100,
      align: 'right' as const,
      render: (v: number) => (v != null && v > 0 ? v.toFixed(4) : <span style={{ color: '#999' }}>0</span>),
    },
    { title: 'UPPH', dataIndex: 'upph', key: 'upph', width: 90, align: 'right' as const, render: (v: number) => v ?? '-' },
    {
      title: 'UPPH来源',
      dataIndex: 'upph_source',
      key: 'upph_source',
      width: 100,
      render: (v: string) => {
        const m = UPPH_SOURCE_MAP[v]
        return m ? <Tag color={m.color}>{m.label}</Tag> : <Tag>待确认</Tag>
      },
    },
    { title: 'OA单号', dataIndex: 'oa_main_id', key: 'oa_main_id', width: 100, render: (v: string) => v || '-' },
    {
      title: '工价同步时间',
      dataIndex: 'last_sync_time',
      key: 'last_sync_time',
      width: 170,
      render: (v: string) => (v ? String(v).replace('T', ' ').slice(0, 19) : '-'),
    },
  ]

  const taskBriefColumns: any[] = [
    { title: '任务单号', dataIndex: 'task_no', key: 'task_no', width: 150 },
    {
      title: '车间',
      dataIndex: 'workshop',
      key: 'workshop',
      width: 120,
      render: (v: string) =>
        v === '装配一线' || v === '装配二线' ? <Tag color="geekblue">{v}</Tag> : <Tag>{v}</Tag>,
    },
    { title: '物料代码', dataIndex: 'material_code', key: 'material_code', width: 220, ellipsis: true },
    { title: '任务数量', dataIndex: 'task_qty', key: 'task_qty', width: 100, align: 'right' as const },
    { title: '实做数量', dataIndex: 'actual_qty', key: 'actual_qty', width: 100, align: 'right' as const, render: (v: number) => v ?? '-' },
    { title: '计划开工', dataIndex: 'planned_start_date', key: 'planned_start_date', width: 110 },
    { title: '计划完工', dataIndex: 'planned_end_date', key: 'planned_end_date', width: 110 },
    {
      title: '状态',
      dataIndex: 'is_closed',
      key: 'is_closed',
      width: 90,
      render: (v: number) => (v === 1 ? <Tag>已关闭</Tag> : <Tag color="processing">未关闭</Tag>),
    },
  ]

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap size={[12, 12]}>
          <Input
            placeholder="订单号"
            value={searchOrderNo}
            onChange={(e) => setSearchOrderNo(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 200 }}
            allowClear
          />
          <Input
            placeholder="产品编码"
            value={searchProductCode}
            onChange={(e) => setSearchProductCode(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 180 }}
            allowClear
          />
          <Input
            placeholder="BOM编码"
            value={searchBomNo}
            onChange={(e) => setSearchBomNo(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 180 }}
            allowClear
          />
          <Input
            placeholder="客户"
            value={searchCustomer}
            onChange={(e) => setSearchCustomer(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 140 }}
            allowClear
          />
          <RangePicker
            value={promisedRange}
            onChange={setPromisedRange}
            presets={buildRangePresets()}
            placeholder={['交期起', '交期止']}
          />
          <Select value={searchWageStatus} onChange={(v) => setSearchWageStatus(v)} style={{ width: 120 }}>
            <Option value="all">全部状态</Option>
            <Option value="has">有工价</Option>
            <Option value="no">无工价</Option>
          </Select>
          <Space size={4}>
            <Switch size="small" checked={includeClosed} onChange={setIncludeClosed} />
            <span style={{ fontSize: 13, color: '#666' }}>含已关闭订单</span>
          </Space>
          <Space size={4}>
            <Switch size="small" checked={onlyWithTasks} onChange={setOnlyWithTasks} />
            <span style={{ fontSize: 13, color: '#666' }}>只看有任务单</span>
          </Space>
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
            查询
          </Button>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>
            重置
          </Button>
          <Tooltip title="立即从OA拉取最新工价/UPPH, 免等每小时自动同步">
            <Button icon={<CloudSyncOutlined />} loading={syncLoading} onClick={handleSyncOA}>
              同步OA工价
            </Button>
          </Tooltip>
          <span style={{ fontSize: 12, color: '#999' }}>工价每小时自动同步一次</span>
        </Space>
      </Card>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="订单行" value={stats.total} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="有工价"
              value={stats.has_wage}
              valueStyle={{ color: '#3f8600' }}
              suffix={stats.total ? <span style={{ fontSize: 14 }}> ({Math.round((stats.has_wage / stats.total) * 100)}%)</span> : null}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="无工价"
              value={stats.no_wage}
              valueStyle={{ color: '#cf1322' }}
              suffix={stats.total ? <span style={{ fontSize: 14 }}> ({Math.round((stats.no_wage / stats.total) * 100)}%)</span> : null}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="无工价原因 (无BOM / 未覆盖 / 金额0)"
              value={stats.no_wage}
              formatter={() => (
                <span style={{ fontSize: 18, color: '#666' }}>
                  {stats.no_wage_no_bom} / {stats.no_wage_not_covered} / {stats.no_wage_zero}
                </span>
              )}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Table
          rowKey="line_id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={data}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 行`,
            onChange: (p, ps) => {
              setPage(p)
              setPageSize(ps)
            },
          }}
          expandable={{
            expandedRowRender: (record: any) => (
              <div>
                <div style={{ marginBottom: 4, fontWeight: 600, fontSize: 13 }}>
                  工价明细{record.wage_status === 'has_wage' ? '' : ` — ${record.wage_no_reason}`}
                </div>
                {(record.details || []).length ? (
                  <Table
                    rowKey={(d: any, i: number | undefined) => `${record.line_id}-w-${d.process_type}-${i}`}
                    size="small"
                    columns={detailColumns}
                    dataSource={record.details}
                    pagination={false}
                  />
                ) : (
                  <div style={{ color: '#999', padding: '4px 0 12px' }}>无工价明细</div>
                )}
                <div style={{ margin: '12px 0 4px', fontWeight: 600, fontSize: 13 }}>
                  本行生产任务单(装配一线/精益, 物料=本行产品)
                  {(record.task_orders || []).length ? (
                    <span style={{ fontWeight: 400, color: '#999', marginLeft: 8 }}>共 {record.task_orders.length} 张</span>
                  ) : null}
                </div>
                {(record.task_orders || []).length ? (
                  <Table
                    rowKey={(t: any, i: number | undefined) => `${record.line_id}-t-${t.task_no}-${i}`}
                    size="small"
                    columns={taskBriefColumns}
                    dataSource={record.task_orders}
                    pagination={false}
                  />
                ) : (
                  <span style={{ color: '#999' }}>本行无对应任务单（无成品装配/精益任务单）</span>
                )}
              </div>
            ),
            rowExpandable: () => true,
          }}
        />
      </Card>
    </div>
  )
}

// ==================== 页签二: 装配任务单(K3下查) ====================
const AssemblyTaskOrderTab: React.FC = () => {
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<TaskStats>({ total: 0, open: 0, closed: 0, by_workshop: {} })

  const [searchOrderNo, setSearchOrderNo] = useState('')
  const [searchTaskNo, setSearchTaskNo] = useState('')
  const [searchMaterial, setSearchMaterial] = useState('')
  const [workshops, setWorkshops] = useState<string[]>(['装配一线', '精益车间'])
  const [plannedEndRange, setPlannedEndRange] = useState<RangeValue>(null)
  const [closedFilter, setClosedFilter] = useState<'all' | 'open' | 'closed'>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page,
        page_size: pageSize,
        workshops,
        closed: closedFilter === 'all' ? undefined : closedFilter,
        planned_end_from: plannedEndRange?.[0] ? plannedEndRange[0].format('YYYY-MM-DD') : undefined,
        planned_end_to: plannedEndRange?.[1] ? plannedEndRange[1].format('YYYY-MM-DD') : undefined,
      }
      if (searchOrderNo) params.order_no = searchOrderNo
      if (searchTaskNo) params.task_no = searchTaskNo
      if (searchMaterial) params.material_code = searchMaterial
      const res = await productionApi.lookupAssemblyTaskOrders(params)
      setData(res.data.items || [])
      setTotal(res.data.total || 0)
      setStats(res.data.stats || { total: 0, open: 0, closed: 0, by_workshop: {} })
    } catch (error: any) {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, searchOrderNo, searchTaskNo, searchMaterial, workshops, plannedEndRange, closedFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleSearch = () => {
    if (page !== 1) {
      setPage(1)
      return
    }
    fetchData()
  }

  const handleReset = () => {
    setSearchOrderNo('')
    setSearchTaskNo('')
    setSearchMaterial('')
    setWorkshops(['装配一线', '精益车间'])
    setPlannedEndRange(null)
    setClosedFilter('all')
    if (page !== 1) {
      setPage(1)
      return
    }
    fetchData()
  }

  const columns: any[] = [
    { title: '任务单号', dataIndex: 'task_no', key: 'task_no', width: 150 },
    {
      title: '车间',
      dataIndex: 'workshop',
      key: 'workshop',
      width: 100,
      render: (v: string) => <Tag color={v === '装配一线' ? 'geekblue' : v === '装配二线' ? 'purple' : 'default'}>{v}</Tag>,
    },
    { title: '物料代码', dataIndex: 'material_code', key: 'material_code', width: 210, ellipsis: true },
    { title: '物料名称', dataIndex: 'material_name', key: 'material_name', width: 180, ellipsis: true, render: (v: string) => v || '-' },
    { title: '任务数量', dataIndex: 'task_qty', key: 'task_qty', width: 100, align: 'right' as const },
    { title: '实做数量', dataIndex: 'actual_qty', key: 'actual_qty', width: 100, align: 'right' as const, render: (v: number) => v ?? '-' },
    { title: '计划开工', dataIndex: 'planned_start_date', key: 'planned_start_date', width: 110 },
    { title: '计划完工', dataIndex: 'planned_end_date', key: 'planned_end_date', width: 110 },
    { title: '实际开工', dataIndex: 'actual_start_date', key: 'actual_start_date', width: 110, render: (v: string) => v || '-' },
    { title: '实际完工', dataIndex: 'actual_end_date', key: 'actual_end_date', width: 110, render: (v: string) => v || '-' },
    {
      title: '状态',
      dataIndex: 'is_closed',
      key: 'is_closed',
      width: 90,
      render: (v: number) => (v === 1 ? <Tag>已关闭</Tag> : <Tag color="processing">未关闭</Tag>),
    },
    {
      title: '销售订单号',
      dataIndex: 'order_no',
      key: 'order_no',
      width: 190,
      render: (v: string) => v || <span style={{ color: '#999' }}>(未关联)</span>,
    },
    {
      title: '订单行号',
      dataIndex: 'order_line_no',
      key: 'order_line_no',
      width: 90,
      render: (v: string) =>
        v ? <Tag color="blue">{v}</Tag> : <Tooltip title="部件类任务单，物料不对应订单行产品"><span style={{ color: '#999' }}>-</span></Tooltip>,
    },
    { title: '客户', dataIndex: 'customer', key: 'customer', width: 120, ellipsis: true, render: (v: string) => v || '-' },
    { title: '订单交期', dataIndex: 'promised_date', key: 'promised_date', width: 110, render: (v: string) => v || '-' },
  ]

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap size={[12, 12]}>
          <Input
            placeholder="销售订单号"
            value={searchOrderNo}
            onChange={(e) => setSearchOrderNo(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 190 }}
            allowClear
          />
          <Input
            placeholder="任务单号"
            value={searchTaskNo}
            onChange={(e) => setSearchTaskNo(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 150 }}
            allowClear
          />
          <Input
            placeholder="物料代码"
            value={searchMaterial}
            onChange={(e) => setSearchMaterial(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 180 }}
            allowClear
          />
          <Select
            mode="multiple"
            value={workshops}
            onChange={setWorkshops}
            style={{ minWidth: 260 }}
            placeholder="选择车间(默认装配)"
            maxTagCount="responsive"
            allowClear
          >
            {ALL_WORKSHOPS.map((w) => (
              <Option key={w} value={w}>
                {w}
              </Option>
            ))}
          </Select>
          <RangePicker
            value={plannedEndRange}
            onChange={setPlannedEndRange}
            presets={buildRangePresets()}
            placeholder={['计划完工起', '计划完工止']}
          />
          <Select value={closedFilter} onChange={(v) => setClosedFilter(v)} style={{ width: 110 }}>
            <Option value="all">全部状态</Option>
            <Option value="open">未关闭</Option>
            <Option value="closed">已关闭</Option>
          </Select>
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
            查询
          </Button>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>
            重置
          </Button>
        </Space>
      </Card>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="任务单" value={stats.total} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="未关闭" value={stats.open} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已关闭" value={stats.closed} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="车间分布"
              value={Object.values(stats.by_workshop || {}).reduce((a: number, b: number) => a + b, 0)}
              formatter={() => (
                <span style={{ fontSize: 18, color: '#666' }}>
                  {Object.entries(stats.by_workshop || {})
                    .map(([w, c]) => `${w} ${c}`)
                    .join(' / ') || '-'}
                </span>
              )}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={data}
          scroll={{ x: 1700 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 张任务单`,
            onChange: (p, ps) => {
              setPage(p)
              setPageSize(ps)
            },
          }}
        />
      </Card>
    </div>
  )
}

// ==================== 主页面 ====================
// 「装配任务单」独立页签暂时下线(需求方要求); AssemblyTaskOrderTab 组件与
// task-orders 接口保留, 恢复时把 Tabs items 加回 tasks 项即可。
const OrderWageLookup: React.FC = () => {
  return (
    <div style={{ padding: 24, background: '#f5f5f5', minHeight: '100%' }}>
      <Card size="small">
        <OrderWageTab />
      </Card>
    </div>
  )
}

export default OrderWageLookup
