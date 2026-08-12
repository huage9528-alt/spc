import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Table, Tag, Input, Button, Space, Row, Col, DatePicker, Alert, Tabs, Popconfirm, message,
} from 'antd'
import { SearchOutlined, ReloadOutlined, PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/api'
import { useAuthStore } from '../../../store/auth'

/* ---------------- ERP 同步台账（原列表） ---------------- */

interface DailyReportRow {
  id: number | null
  oa_id: string | null
  oa_detail_id: number | null
  report_date: string | null
  sale_order_no: string | null
  production_order_no: string | null
  specification: string | null
  bom_no: string | null
  material_code: string | null
  process: string | null
  color: string | null
  completed_qty: number | null
  workshop: string | null
  work_hours: number | null
  total_wages: number | null
  data_source: string | null
  erp_updated_at: string | null
}

function ErpLedger() {
  const [data, setData] = useState<DailyReportRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [workshop, setWorkshop] = useState('')
  const [keyword, setKeyword] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = { page, page_size: pageSize }
      if (dateRange && dateRange[0]) params.report_date_from = dateRange[0].format('YYYY-MM-DD')
      if (dateRange && dateRange[1]) params.report_date_to = dateRange[1].format('YYYY-MM-DD')
      if (workshop) params.workshop = workshop
      if (keyword) params.keyword = keyword
      const res: any = await productionApi.listDailyReports(params)
      setData(res.data.items || [])
      setTotal(res.data.total || 0)
    } catch (e: any) {
      setData([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, dateRange, workshop, keyword])

  useEffect(() => { load() }, [load])

  const columns = [
    {
      title: '日期', dataIndex: 'report_date', width: 100,
      render: (v: string | null) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    { title: '车间', dataIndex: 'workshop', width: 90, render: (v: string | null) => v || '-' },
    { title: '生产订单号', dataIndex: 'production_order_no', width: 120 },
    { title: '销售订单号', dataIndex: 'sale_order_no', width: 120 },
    { title: '物料编码', dataIndex: 'material_code', width: 120 },
    { title: '明细ID', dataIndex: 'oa_detail_id', width: 120, render: (v: number | null) => v ?? '-' },
    { title: '规格', dataIndex: 'specification', width: 160, ellipsis: true },
    { title: 'BOM', dataIndex: 'bom_no', width: 100 },
    { title: '工序', dataIndex: 'process', width: 80, render: (v: string | null) => v || '-' },
    { title: '颜色', dataIndex: 'color', width: 80, render: (v: string | null) => v || '-' },
    {
      title: '完成数', dataIndex: 'completed_qty', width: 90, align: 'right' as const,
      render: (v: number | null) => v != null ? Number(v).toLocaleString() : '-',
    },
    {
      title: '工时', dataIndex: 'work_hours', width: 80, align: 'right' as const,
      render: (v: number | null) => v != null ? `${Number(v).toFixed(1)}h` : '-',
    },
    {
      title: '工资', dataIndex: 'total_wages', width: 90, align: 'right' as const,
      render: (v: number | null) => v != null ? Number(v).toFixed(2) : '-',
    },
    {
      title: '来源', dataIndex: 'data_source', width: 80,
      render: (v: string | null) => v ? <Tag color={v === 'erp' ? 'blue' : 'default'}>{v}</Tag> : '-',
    },
  ]

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col>
            <DatePicker.RangePicker
              value={dateRange as any}
              onChange={(range) => { setDateRange(range as [Dayjs | null, Dayjs | null] | null); setPage(1) }}
              placeholder={['开始日期', '结束日期']}
              style={{ width: 240 }}
            />
          </Col>
          <Col>
            <Input
              placeholder="车间"
              value={workshop || undefined}
              onChange={e => { setWorkshop(e.target.value); setPage(1) }}
              allowClear
              style={{ width: 130 }}
            />
          </Col>
          <Col>
            <Input
              prefix={<SearchOutlined />}
              placeholder="生产单/销售单/物料"
              value={keyword || undefined}
              onChange={e => { setKeyword(e.target.value); setPage(1) }}
              allowClear
              style={{ width: 220 }}
            />
          </Col>
          <Col flex="auto" />
          <Col>
            <Space>
              <Button onClick={() => { setDateRange(null); setWorkshop(''); setKeyword(''); setPage(1) }}>重置</Button>
              <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            </Space>
          </Col>
        </Row>
      </div>

      {total === 0 && !loading && (
        <Alert
          type="info" showIcon
          message="暂无 ERP 同步数据"
          description="该台账由 ERP/OA 自动同步（来源=erp）。请前往「数据集成」配置 production_daily_reports 的同步 SQL 后再触发同步。"
          style={{ marginBottom: 16 }}
        />
      )}

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey={(r) => String(r.id ?? r.oa_id ?? Math.random())}
          dataSource={data}
          columns={columns}
          loading={loading}
          scroll={{ x: 1600 }}
          size="small"
          pagination={{
            total, current: page, pageSize,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            showSizeChanger: true,
            showTotal: t => `共 ${t} 条`,
          }}
        />
      </div>
    </div>
  )
}

/* ---------------- 车间日报表单据（新建） ---------------- */

interface WsdrRow {
  id: number
  report_no: string
  report_date: string
  report_type: string | null
  department: string | null
  group_name: string | null
  workshop: string | null
  reporter: string | null
  attendance_count: number | null
  attendance_actual: number | null
  leave_count: number | null
  completed_qty: number | null
  work_wages_total: number | null
  grand_total_wages: number | null
  temp_amount: number | null
  data_source: string | null
}

function WorkshopReportList() {
  const navigate = useNavigate()
  const [data, setData] = useState<WsdrRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [workshop, setWorkshop] = useState('')
  const [keyword, setKeyword] = useState('')

  const hasPermission = useAuthStore((s) => s.hasPermission)
  const canCreate = hasPermission('production.daily_report', 'create')
  const canUpdate = hasPermission('production.daily_report', 'update')
  const canDelete = hasPermission('production.daily_report', 'delete')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = { page, page_size: pageSize }
      if (dateRange && dateRange[0]) params.report_date_from = dateRange[0].format('YYYY-MM-DD')
      if (dateRange && dateRange[1]) params.report_date_to = dateRange[1].format('YYYY-MM-DD')
      if (workshop) params.workshop = workshop
      if (keyword) params.keyword = keyword
      const res: any = await productionApi.listWorkshopDailyReports(params)
      setData(res.data.items || [])
      setTotal(res.data.total || 0)
    } catch (e: any) {
      setData([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, dateRange, workshop, keyword])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: number) => {
    try {
      await productionApi.deleteWorkshopDailyReport(id)
      message.success('删除成功')
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '删除失败')
    }
  }

  const columns = [
    { title: '流程编号', dataIndex: 'report_no', width: 150, render: (v: string) => v || '-' },
    {
      title: '日期', dataIndex: 'report_date', width: 110,
      render: (v: string | null) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    { title: '类型', dataIndex: 'report_type', width: 70, render: (v: string | null) => v || '-' },
    { title: '部门', dataIndex: 'department', width: 140, render: (v: string | null) => v || '-' },
    { title: '组别', dataIndex: 'group_name', width: 100, render: (v: string | null) => v || '-' },
    { title: '车间', dataIndex: 'workshop', width: 100, render: (v: string | null) => v || '-' },
    { title: '填报人', dataIndex: 'reporter', width: 90, render: (v: string | null) => v || '-' },
    {
      title: '出勤', dataIndex: 'attendance_count', width: 70, align: 'right' as const,
      render: (v: number | null) => v ?? '-',
    },
    {
      title: '请假', dataIndex: 'leave_count', width: 70, align: 'right' as const,
      render: (v: number | null) => v ?? '-',
    },
    {
      title: '完成数', dataIndex: 'completed_qty', width: 90, align: 'right' as const,
      render: (v: number | null) => v != null ? Number(v).toLocaleString() : '-',
    },
    {
      title: '当日工资', dataIndex: 'work_wages_total', width: 100, align: 'right' as const,
      render: (v: number | null) => v != null ? Number(v).toFixed(2) : '-',
    },
    {
      title: '总工资', dataIndex: 'grand_total_wages', width: 100, align: 'right' as const,
      render: (v: number | null) => v != null ? Number(v).toFixed(2) : '-',
    },
    {
      title: '来源', dataIndex: 'data_source', width: 80,
      render: (v: string | null) => v ? <Tag color={v === 'manual' ? 'green' : 'blue'}>{v === 'manual' ? '手工' : v}</Tag> : '-',
    },
    {
      title: '操作', key: 'action', width: 150, fixed: 'right' as const,
      render: (_: any, r: WsdrRow) => (
        <Space size={0}>
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => navigate(`/daily-reports/${r.id}/view`)}>查看</Button>
          {canUpdate && (
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => navigate(`/daily-reports/${r.id}/edit`)}>编辑</Button>
          )}
          {canDelete && (
            <Popconfirm title="确认删除该车间日报表？" onConfirm={() => handleDelete(r.id)}>
              <Button size="small" type="link" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col>
            <DatePicker.RangePicker
              value={dateRange as any}
              onChange={(range) => { setDateRange(range as [Dayjs | null, Dayjs | null] | null); setPage(1) }}
              placeholder={['开始日期', '结束日期']}
              style={{ width: 240 }}
            />
          </Col>
          <Col>
            <Input
              placeholder="车间"
              value={workshop || undefined}
              onChange={e => { setWorkshop(e.target.value); setPage(1) }}
              allowClear
              style={{ width: 130 }}
            />
          </Col>
          <Col>
            <Input
              prefix={<SearchOutlined />}
              placeholder="流程编号/组别"
              value={keyword || undefined}
              onChange={e => { setKeyword(e.target.value); setPage(1) }}
              allowClear
              style={{ width: 200 }}
            />
          </Col>
          <Col flex="auto" />
          <Col>
            <Space>
              {canCreate && (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/daily-reports/new')}>新建车间日报表</Button>
              )}
              <Button onClick={() => { setDateRange(null); setWorkshop(''); setKeyword(''); setPage(1) }}>重置</Button>
              <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            </Space>
          </Col>
        </Row>
      </div>

      {total === 0 && !loading && (
        <Alert
          type="info" showIcon
          message="暂无车间日报表"
          description="点击「新建车间日报表」按泛微 OA 样式填报当天产量、出勤、请假与 K3 任务单信息。"
          style={{ marginBottom: 16 }}
        />
      )}

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey={(r) => String(r.id)}
          dataSource={data}
          columns={columns}
          loading={loading}
          scroll={{ x: 1400 }}
          size="small"
          pagination={{
            total, current: page, pageSize,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            showSizeChanger: true,
            showTotal: t => `共 ${t} 条`,
          }}
        />
      </div>
    </div>
  )
}

/* ---------------- 页面容器：双 Tab ---------------- */

export default function DailyReports() {
  return (
    <Tabs
      defaultActiveKey="wsdr"
      items={[
        { key: 'wsdr', label: '车间日报表', children: <WorkshopReportList /> },
        { key: 'erp', label: 'ERP 同步台账', children: <ErpLedger /> },
      ]}
    />
  )
}
