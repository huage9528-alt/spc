import { useEffect, useState, useCallback, useMemo } from 'react'
import { Table, Input, Button, message, Row, Col, Card, DatePicker, Dropdown } from 'antd'
import {
  SearchOutlined, ReloadOutlined, AccountBookOutlined,
  DollarOutlined, ExclamationCircleOutlined,
  LeftOutlined, RightOutlined,
  DownloadOutlined, DownOutlined, UpOutlined, CalendarOutlined,
  BarChartOutlined,
} from '@ant-design/icons'
import { Pie } from '@ant-design/charts'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import zhCN from 'antd/locale/zh_CN'
import { materialApi } from '../../../services/api'
import { useExport } from '../../../hooks/useExport'
import { useAuthStore } from '../../../store/auth'

dayjs.locale('zh-cn')

interface InvoiceDetail {
  invoice_no: string
  line_no: string
  invoice_date: string | null
  payment_term: string
  settlement_method: string
  invoice_amount: number
  remain_payable: number
  paid_amount: number
}

interface SupplierPaymentRow {
  supplier_code: string
  supplier_name: string | null
  invoice_date: string | null
  schedule_month: string | null
  payment_term: string | null
  payment_method: string | null
  total_payable: number | null
  monthly_due: number | null
  payment_month: string | null
  invoices: InvoiceDetail[]
}

interface Summary {
  total_payable: number
  total_monthly_due: number
  supplier_count: number
  overdue_amount: number
  not_due_amount: number
}

const fmt = (v: number | null) => {
  if (v == null) return <span style={{ color: '#cbd5e1' }}>-</span>
  return <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
}

export default function SupplierPayment() {
  const isSupplierUser = useAuthStore((s) => s.isSupplierUser)
  const supplierReadOnly = isSupplierUser()
  const [data, setData] = useState<SupplierPaymentRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [supplier, setSupplier] = useState('')
  const [monthFilter, setMonthFilter] = useState<dayjs.Dayjs | null>(dayjs())
  const [invoiceDateRange, setInvoiceDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null)
  const [sortBy, setSortBy] = useState<string>('')
  const [sortOrder, setSortOrder] = useState<string>('')
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [showCharts, setShowCharts] = useState(false)
  const { exporting, exportData } = useExport()

  const handleExport = (format: 'xlsx' | 'csv') => {
    const month = (monthFilter || dayjs()).format('YYYY-MM')
    const params: Record<string, any> = { format }
    if (month) params.payment_month = month
    if (supplier) params.supplier_name = supplier
    if (invoiceDateRange?.[0]) params.invoice_date_start = invoiceDateRange[0].format('YYYY-MM-DD')
    if (invoiceDateRange?.[1]) params.invoice_date_end = invoiceDateRange[1].format('YYYY-MM-DD')
    if (sortBy) { params.sort_by = sortBy; params.sort_order = sortOrder || 'asc' }
    const ext = format === 'csv' ? 'csv' : 'xlsx'
    exportData('/api/v1/materials/supplier-payment/export', params, `供应商付款排程.${ext}`)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const month = (monthFilter || dayjs()).format('YYYY-MM')
      const listParams: Record<string, any> = { page, page_size: pageSize }
      if (month) listParams.payment_month = month
      if (supplier) listParams.supplier_name = supplier
      if (invoiceDateRange?.[0]) listParams.invoice_date_start = invoiceDateRange[0].format('YYYY-MM-DD')
      if (invoiceDateRange?.[1]) listParams.invoice_date_end = invoiceDateRange[1].format('YYYY-MM-DD')
      if (sortBy) { listParams.sort_by = sortBy; listParams.sort_order = sortOrder || 'asc' }

      const sumParams: Record<string, any> = {}
      if (month) sumParams.payment_month = month
      if (supplier) sumParams.supplier_name = supplier
      if (invoiceDateRange?.[0]) sumParams.invoice_date_start = invoiceDateRange[0].format('YYYY-MM-DD')
      if (invoiceDateRange?.[1]) sumParams.invoice_date_end = invoiceDateRange[1].format('YYYY-MM-DD')

      const [listRes, sumRes]: any[] = await Promise.all([
        materialApi.listSupplierPayment(listParams),
        materialApi.getSupplierPaymentSummary(sumParams),
      ])
      setData(listRes.data?.items || [])
      setTotal(listRes.data?.total || 0)
      setSummary(sumRes.data)
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, supplier, monthFilter, invoiceDateRange, sortBy, sortOrder])

  useEffect(() => { load() }, [load])

  const columns = useMemo(() => {
    const getSortOrder = (dataIndex: string) => {
      if (sortBy !== dataIndex) return undefined
      return sortOrder === 'asc' ? ('ascend' as const) : sortOrder === 'desc' ? ('descend' as const) : undefined
    }
    return [
      {
        title: '供应商编码', dataIndex: 'supplier_code', width: 140, fixed: 'left' as const,
        sorter: true, sortOrder: getSortOrder('supplier_code'),
        render: (v: string) => <span style={{ fontFamily: 'monospace' }}>{v}</span>,
      },
      {
        title: '供应商', dataIndex: 'supplier_name', width: 240, ellipsis: true, fixed: 'left' as const,
        sorter: true, sortOrder: getSortOrder('supplier_name'),
        render: (v: string | null) => v ? <strong>{v}</strong> : <span style={{ color: '#cbd5e1' }}>-</span>,
      },
      {
        title: '到票日期', dataIndex: 'invoice_date', width: 120,
        sorter: true, sortOrder: getSortOrder('invoice_date'),
        render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>-</span>,
      },
      {
        title: '账期', dataIndex: 'payment_term', width: 120,
        sorter: true, sortOrder: getSortOrder('payment_term'),
        render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>-</span>,
      },
      {
        title: '付款方式', dataIndex: 'payment_method', width: 140,
        sorter: true, sortOrder: getSortOrder('payment_method'),
        render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>-</span>,
      },
      {
        title: '排款月', dataIndex: 'payment_month', width: 120,
        sorter: true, sortOrder: getSortOrder('payment_month'),
        render: (v: string | null) => {
          if (!v) return <span style={{ color: '#cbd5e1' }}>-</span>
          const d = dayjs(v)
          return d.isValid() ? d.format('YYYY年M月') : v
        },
      },
      {
        title: '总应付金额', dataIndex: 'total_payable', width: 140, align: 'right' as const,
        sorter: true, sortOrder: getSortOrder('total_payable'),
        render: fmt,
      },
      {
        title: '月到期应付金额', dataIndex: 'monthly_due', width: 160, align: 'right' as const,
        sorter: true, sortOrder: getSortOrder('monthly_due'),
        render: (v: number | null) => {
          if (v == null) return <span style={{ color: '#cbd5e1' }}>-</span>
          const color = v > 0 ? '#e11d48' : '#16a34a'
          return <span style={{ fontFamily: 'monospace', fontWeight: 500, color }}>{v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        },
      },
    ]
  }, [sortBy, sortOrder])

  return (
    <div>
      {/* 统计卡 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        {[
          { title: '供应商数', value: summary?.supplier_count ?? '-', icon: <AccountBookOutlined />, color: '#6366f1' },
          { title: '总应付金额', value: summary?.total_payable != null ? `¥${summary.total_payable.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}` : '-', icon: <DollarOutlined />, color: '#e11d48' },
          { title: '月到期应付金额', value: summary?.total_monthly_due != null ? `¥${summary.total_monthly_due.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}` : '-', icon: <CalendarOutlined />, color: '#f59e0b' },
          { title: '到期未付', value: summary?.overdue_amount != null ? `¥${summary.overdue_amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}` : '-', icon: <ExclamationCircleOutlined />, color: '#dc2626' },
        ].map((card, i) => (
          <Col flex={1} key={i}>
            <Card size="small" className="card-modern" style={{ padding: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: `${card.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(1.25rem * var(--font-size-scale))', color: card.color }}>
                  {card.icon}
                </div>
                <div>
                  <div style={{ fontSize: 'calc(1.375rem * var(--font-size-scale))', fontWeight: 700, color: '#1e293b' }}>{card.value}</div>
                  <div style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', color: '#64748b' }}>{card.title}</div>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* 图表 */}
      {showCharts && (
        <div className="card-modern" style={{ padding: '20px 24px', marginBottom: 16 }}>
          <Row gutter={24}>
            <Col span={12}>
              <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#475569', marginBottom: 16 }}>应付金额分布</h3>
              {summary && (summary.overdue_amount > 0 || summary.not_due_amount > 0) ? (
                <Pie
                  data={[
                    { name: '到期未付', value: summary.overdue_amount },
                    { name: '未到期', value: summary.not_due_amount },
                  ]}
                  angleField="value"
                  colorField="name"
                  radius={0.8}
                  innerRadius={0.55}
                  color={['#dc2626', '#16a34a']}
                  label={{
                    text: (d: { name: string; value: number }) => `${d.name}\n¥${d.value.toLocaleString('zh-CN', { minimumFractionDigits: 0 })}`,
                    style: { fontSize: 11, fontWeight: 500 },
                  }}
                  legend={{
                    color: { position: 'bottom' as const, layout: { justifyContent: 'center' } },
                  }}
                  statistic={{
                    title: { content: '总应付', style: { fontSize: '12px', color: '#94a3b8' } },
                    content: {
                      content: `¥${((summary.overdue_amount + summary.not_due_amount) / 10000).toFixed(0)}万`,
                      style: { fontSize: '22px', fontWeight: 700, color: '#1e293b' },
                    },
                  }}
                  interaction={{ elementHighlight: true }}
                  height={260}
                />
              ) : (
                <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>暂无数据</div>
              )}
            </Col>
            <Col span={12}>
              <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#475569', marginBottom: 16 }}>供应商应付 TOP10</h3>
              {data.length > 0 ? (
                <Pie
                  data={[...data]
                    .sort((a, b) => (b.total_payable || 0) - (a.total_payable || 0))
                    .slice(0, 10)
                    .map((d) => ({ name: d.supplier_name || d.supplier_code, value: d.total_payable || 0 }))}
                  angleField="value"
                  colorField="name"
                  radius={0.8}
                  innerRadius={0.3}
                  label={{
                    text: (d: { name: string; value: number }) => `${d.name}`,
                    style: { fontSize: 10, fontWeight: 400 },
                  }}
                  legend={false}
                  interaction={{ elementHighlight: true }}
                  height={260}
                />
              ) : (
                <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>暂无数据</div>
              )}
            </Col>
          </Row>
        </div>
      )}

      {/* 筛选栏 */}
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          {!supplierReadOnly && <Col>
            <Input
              prefix={<SearchOutlined />}
              placeholder="搜索供应商"
              value={supplier}
              onChange={e => { setSupplier(e.target.value); setPage(1) }}
              style={{ width: 200 }}
              allowClear
            />
          </Col>}
          {/* <Col>
            <DatePicker.RangePicker
              placeholder={['到票开始日期', '到票结束日期']}
              value={invoiceDateRange}
              onChange={v => { setInvoiceDateRange(v); setPage(1) }}
              style={{ width: 260 }}
              allowClear
              locale={zhCN.DatePicker}
              format="YYYY-MM-DD"
            />
          </Col> */}
          <Col>
            <Button.Group>
              <Button
                icon={<LeftOutlined />}
                onClick={() => { setMonthFilter((monthFilter || dayjs()).subtract(1, 'month')); setPage(1) }}
                title="上一月"
              />
              <DatePicker
                picker="month"
                placeholder="排款月份"
                value={monthFilter}
                onChange={v => { setMonthFilter(v || dayjs()); setPage(1) }}
                style={{ width: 140 }}
                allowClear={false}
                locale={zhCN.DatePicker}
                format="YYYY年MM月"
              />
              <Button
                icon={<RightOutlined />}
                onClick={() => { setMonthFilter((monthFilter || dayjs()).add(1, 'month')); setPage(1) }}
                title="下一月"
              />
              <Button
                onClick={() => { setMonthFilter(dayjs()); setPage(1) }}
                disabled={!!monthFilter && monthFilter.isSame(dayjs(), 'month')}
              >本月</Button>
            </Button.Group>
          </Col>
          <Col flex="auto" />
          <Col>
            <Button
              icon={<BarChartOutlined />}
              onClick={() => setShowCharts(!showCharts)}
            >
              {showCharts ? '隐藏图表' : '显示图表'}
            </Button>
          </Col>
          <Col>
            <Dropdown
              menu={{
                items: [
                  { key: 'xlsx', label: '导出 Excel', icon: <DownloadOutlined /> },
                  { key: 'csv', label: '导出 CSV', icon: <DownloadOutlined /> },
                ],
                onClick: ({ key }) => handleExport(key as 'xlsx' | 'csv'),
              }}
            >
              <Button icon={<DownloadOutlined />} loading={exporting}>导出 <DownOutlined /></Button>
            </Dropdown>
          </Col>
          <Col>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          </Col>
        </Row>
      </div>

      {/* 表格 */}
      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="supplier_code"
          dataSource={data}
          columns={columns}
          loading={loading}
          size="small"
          scroll={{ x: 1000 }}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys: React.Key[]) => setSelectedRowKeys(keys as string[]),
            preserveSelectedRowKeys: true,
          }}
          expandable={{
            expandedRowRender: (record: SupplierPaymentRow) => {
              if (!record.invoices?.length) return <div style={{ padding: '8px 16px', color: '#94a3b8' }}>暂无发票明细</div>
              const invCols = [
                { title: '发票号码', dataIndex: 'invoice_no', width: 120 },
                { title: '行号', dataIndex: 'line_no', width: 80 },
                { title: '到票日期', dataIndex: 'invoice_date', width: 110 },
                { title: '账期', dataIndex: 'payment_term', width: 100 },
                { title: '结算方式', dataIndex: 'settlement_method', width: 110 },
                { title: '开票金额', dataIndex: 'invoice_amount', width: 120, align: 'right' as const,
                  render: (v: number) => v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
                { title: '剩余应付', dataIndex: 'remain_payable', width: 120, align: 'right' as const,
                  render: (v: number) => <span style={{ color: v > 0 ? '#e11d48' : '#16a34a' }}>{v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> },
                { title: '已付款金额', dataIndex: 'paid_amount', width: 120, align: 'right' as const,
                  render: (v: number) => v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
              ]
              return (
                <Table
                  rowKey={(r: InvoiceDetail) => `${r.invoice_no}-${r.line_no}`}
                  dataSource={record.invoices}
                  columns={invCols}
                  size="small"
                  pagination={false}
                  style={{ margin: '8px 0' }}
                />
              )
            },
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showTotal: t => `共 ${t} 条`,
            showSizeChanger: true,
          }}
          onChange={(pagination, _tableFilters, sorter: any) => {
            setPage(pagination.current || 1)
            setPageSize(pagination.pageSize || 20)
            const sortField = sorter.field as string | undefined
            const sortDir = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : ''
            setSortBy(sortField || '')
            setSortOrder(sortDir)
          }}
        />
      </div>
    </div>
  )
}
