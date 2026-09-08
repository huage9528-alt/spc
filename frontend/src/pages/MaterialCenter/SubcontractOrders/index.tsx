import { useEffect, useState, useCallback } from 'react'
import {
  Table, Tag, Input, Select, Button, Space, message, Modal, Form, DatePicker, InputNumber,
  Upload, Popconfirm, Tooltip, Card, Row, Col,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  SearchOutlined, ReloadOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  UploadOutlined, DownloadOutlined, FileTextOutlined, CheckCircleOutlined,
  ClockCircleOutlined, StopOutlined, FilterOutlined,
} from '@ant-design/icons'
import dayjs, { Dayjs } from 'dayjs'
import { materialApi } from '../../../services/api'
import { formatDate } from '../../../utils'

interface DetailRow {
  id: number
  detail_id?: number
  line_no?: number
  material_id?: number
  material_code?: string | null
  material_name?: string | null
  qty?: number | null
  delivery_qty?: number | null
  received_qty?: number | null
  returned_qty?: number | null
  price?: number | null
  amount?: number | null
  sale_order_no?: string | null
  data_source?: string | null
}

interface HeadRow {
  id: number
  bill_no: string
  bill_date?: string | null
  bill_type?: string | null
  supplier_id?: number | null
  supplier_name?: string | null
  status?: string | null
  remark?: string | null
  data_source?: string | null
  voided_flag?: number | null
  closed_flag?: number | null
  detail_count?: number
  total_qty?: number | null
}

interface Stats {
  total: number
  audited: number
  pending: number
  closed: number
  voided: number
}

interface HeadFilters {
  supplier_name?: string
  status?: string[]
  data_source?: string[]
  bill_date?: [Dayjs, Dayjs] | null
}

interface DetailFilters {
  material_code?: string
  material_name?: string
  sale_order_no?: string
  data_source?: string[]
  mrp_closed?: boolean | null
  qty?: [number, number] | null
  delivery_qty?: [number, number] | null
  received_qty?: [number, number] | null
}

const STATUS_COLOR: Record<string, string> = {
  '0': 'default',
  '1': 'success',
  '2': 'processing',
  '3': 'error',
}
const STATUS_LABEL: Record<string, string> = {
  '0': '未审核',
  '1': '已审核',
  '2': '审核中',
  '3': '已关闭',
}

const STATUS_FILTER_OPTIONS = [
  { text: '未审核', value: '0' },
  { text: '已审核', value: '1' },
  { text: '审核中', value: '2' },
  { text: '已关闭', value: '3' },
]

const DATA_SOURCE_FILTER_OPTIONS = [
  { text: 'ERP', value: 'erp' },
  { text: '手工', value: 'manual' },
]

const STAT_CARDS = [
  { key: 'total', title: '委外订单总数', icon: <FileTextOutlined />, color: '#6366f1' },
  { key: 'audited', title: '已审核', icon: <CheckCircleOutlined />, color: '#059669' },
  { key: 'pending', title: '待审核', icon: <ClockCircleOutlined />, color: '#d97706' },
  { key: 'voided', title: '已作废', icon: <StopOutlined />, color: '#e11d48' },
] as const

function NumberRangeFilter({ onConfirm, confirm, clearFilters }: { onConfirm: (min?: number, max?: number) => void; confirm?: () => void; clearFilters?: () => void }) {
  const [min, setMin] = useState<number | null>(null)
  const [max, setMax] = useState<number | null>(null)
  const apply = () => {
    onConfirm(min ?? undefined, max ?? undefined)
    confirm?.()
  }
  return (
    <div style={{ padding: 8, width: 220 }} onClick={e => e.stopPropagation()}>
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        <InputNumber
          placeholder="最小值"
          value={min}
          onChange={v => setMin(v as number | null)}
          style={{ width: '100%' }}
          onPressEnter={apply}
        />
        <InputNumber
          placeholder="最大值"
          value={max}
          onChange={v => setMax(v as number | null)}
          style={{ width: '100%' }}
          onPressEnter={apply}
        />
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button size="small" onClick={() => { setMin(null); setMax(null); onConfirm(undefined, undefined); clearFilters?.() }}>
            重置
          </Button>
          <Button size="small" type="primary" onClick={apply}>
            确定
          </Button>
        </Space>
      </Space>
    </div>
  )
}

function TextContainsFilter({ onConfirm, confirm, clearFilters, placeholder = '包含...' }: { onConfirm: (v?: string) => void; confirm?: () => void; clearFilters?: () => void; placeholder?: string }) {
  const [v, setV] = useState('')
  const apply = () => {
    onConfirm(v || undefined)
    confirm?.()
  }
  return (
    <div style={{ padding: 8, width: 200 }} onClick={e => e.stopPropagation()}>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          placeholder={placeholder}
          value={v}
          onChange={e => setV(e.target.value)}
          onPressEnter={apply}
          allowClear
        />
        <Button type="primary" onClick={apply}>确定</Button>
      </Space.Compact>
      <Button size="small" style={{ marginTop: 4 }} onClick={() => { setV(''); onConfirm(undefined); clearFilters?.() }}>重置</Button>
    </div>
  )
}

function DateRangeFilter({ onConfirm, confirm, clearFilters }: { onConfirm: (start?: string, end?: string) => void; confirm?: () => void; clearFilters?: () => void }) {
  const [v, setV] = useState<[Dayjs, Dayjs] | null>(null)
  const apply = () => {
    onConfirm(v?.[0]?.format('YYYY-MM-DD'), v?.[1]?.format('YYYY-MM-DD'))
    confirm?.()
  }
  return (
    <div style={{ padding: 8, width: 260 }} onClick={e => e.stopPropagation()}>
      <DatePicker.RangePicker
        value={v}
        onChange={val => setV(val as [Dayjs, Dayjs] | null)}
        style={{ width: '100%' }}
      />
      <Space style={{ marginTop: 4, width: '100%', justifyContent: 'flex-end' }}>
        <Button size="small" onClick={() => { setV(null); onConfirm(undefined, undefined); clearFilters?.() }}>重置</Button>
        <Button size="small" type="primary" onClick={apply}>确定</Button>
      </Space>
    </div>
  )
}

function BoolTriFilter({ onConfirm, confirm }: { onConfirm: (v?: boolean) => void; confirm?: () => void }) {
  const apply = (v?: boolean) => {
    onConfirm(v)
    confirm?.()
  }
  return (
    <div style={{ padding: 8, width: 120 }} onClick={e => e.stopPropagation()}>
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Button size="small" block onClick={() => apply(true)}>已关闭</Button>
        <Button size="small" block onClick={() => apply(false)}>未关闭</Button>
        <Button size="small" block type="link" onClick={() => apply(undefined)}>全部</Button>
      </Space>
    </div>
  )
}

export default function SubcontractOrders() {
  const [data, setData] = useState<HeadRow[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<Stats>({ total: 0, audited: 0, pending: 0, closed: 0, voided: 0 })
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [includeVoided, setIncludeVoided] = useState(false)
  const [sortBy, setSortBy] = useState('')
  const [sortOrder, setSortOrder] = useState('')
  const [filters, setFilters] = useState<HeadFilters>({})
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchForm] = Form.useForm()
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<HeadRow | null>(null)
  const [headForm] = Form.useForm()

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page, page_size: pageSize,
        keyword: keyword || undefined,
        include_voided: includeVoided,
        sort_by: sortBy || undefined,
        sort_order: sortOrder || undefined,
      }
      if (filters.supplier_name) params.supplier_name = filters.supplier_name
      if (filters.status?.length) params.status = filters.status.join(',')
      if (filters.data_source?.length) params.data_source = filters.data_source.join(',')
      if (filters.bill_date?.[0]) params.bill_date_start = filters.bill_date[0].format('YYYY-MM-DD')
      if (filters.bill_date?.[1]) params.bill_date_end = filters.bill_date[1].format('YYYY-MM-DD')
      const res: any = await materialApi.listSubcontractOrders(params)
      const d = res?.data
      setData(d?.items || [])
      setTotal(d?.total || 0)
      if (d?.stats) setStats(d.stats)
    } catch (e: any) {
      message.error(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, keyword, includeVoided, sortBy, sortOrder, filters])

  useEffect(() => { fetchData() }, [fetchData])

  const openCreate = () => {
    setEditing(null)
    headForm.resetFields()
    setEditOpen(true)
  }
  const openEdit = (row: HeadRow) => {
    setEditing(row)
    headForm.setFieldsValue({
      bill_no: row.bill_no,
      bill_date: row.bill_date ? dayjs(row.bill_date) : undefined,
      bill_type: row.bill_type,
      supplier_id: row.supplier_id,
      status: row.status,
      remark: row.remark,
    })
    setEditOpen(true)
  }

  const submitHead = async (values: any) => {
    const payload: any = { ...values }
    if (payload.bill_date) payload.bill_date = dayjs(payload.bill_date).format('YYYY-MM-DD')
    try {
      if (editing) {
        await materialApi.updateSubcontractOrder(editing.id, payload)
        message.success('已更新')
      } else {
        await materialApi.createSubcontractOrder(payload)
        message.success('已创建')
      }
      setEditOpen(false)
      fetchData()
    } catch (e: any) {
      message.error(e?.message || '保存失败')
    }
  }

  const remove = async (id: number) => {
    try {
      await materialApi.deleteSubcontractOrder(id)
      message.success('已删除')
      fetchData()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '删除失败')
    }
  }

  const submitBatch = async () => {
    const v = await batchForm.validateFields()
    setBatchLoading(true)
    try {
      const res: any = await materialApi.batchUpdateSubcontractOrders({
        ids: selectedIds,
        status: v.status || undefined,
        remark: v.remark || undefined,
      })
      message.success(`已更新 ${res?.data?.updated ?? 0} 条`)
      setBatchOpen(false)
      batchForm.resetFields()
      setSelectedIds([])
      fetchData()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '批量更新失败')
    } finally {
      setBatchLoading(false)
    }
  }

  const onImport = async (file: File) => {
    try {
      const res: any = await materialApi.importSubcontractOrders(file)
      message.success(`导入完成: ${JSON.stringify(res?.data)}`)
      fetchData()
    } catch (e: any) {
      message.error(e?.message || '导入失败')
    }
    return false
  }

  const onExport = async () => {
    try {
      const params: Record<string, any> = {
        keyword: keyword || undefined,
        include_voided: includeVoided,
        format: 'xlsx',
      }
      if (filters.supplier_name) params.supplier_name = filters.supplier_name
      if (filters.status?.length) params.status = filters.status.join(',')
      if (filters.data_source?.length) params.data_source = filters.data_source.join(',')
      if (filters.bill_date?.[0]) params.bill_date_start = filters.bill_date[0].format('YYYY-MM-DD')
      if (filters.bill_date?.[1]) params.bill_date_end = filters.bill_date[1].format('YYYY-MM-DD')
      const res: any = await materialApi.exportSubcontractOrders(params)
      const url = window.URL.createObjectURL(new Blob([res]))
      const a = document.createElement('a')
      a.href = url
      a.download = 'subcontract_orders.xlsx'
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (e: any) {
      message.error(e?.message || '导出失败')
    }
  }

  const columns: ColumnsType<HeadRow> = [
    { title: '单据编号', dataIndex: 'bill_no', width: 180, fixed: 'left', sorter: true },
    { title: '日期', dataIndex: 'bill_date', width: 130, sorter: true,
      render: (v: string) => formatDate(v),
      filterDropdown: ({ confirm, clearFilters }) => (
        <DateRangeFilter
          confirm={confirm}
          clearFilters={clearFilters}
          onConfirm={(s, e) => { setFilters(f => ({ ...f, bill_date: s && e ? [dayjs(s), dayjs(e)] : null })); setPage(1) }}
        />
      ),
    },
    { title: '供应商名称', dataIndex: 'supplier_name', width: 200, sorter: true, ellipsis: true,
      filterDropdown: ({ confirm, clearFilters }) => (
        <TextContainsFilter
          confirm={confirm}
          clearFilters={clearFilters}
          placeholder="搜索供应商名称"
          onConfirm={v => { setFilters(f => ({ ...f, supplier_name: v })); setPage(1) }}
        />
      ),
    },
    {
      title: '状态', dataIndex: 'status', width: 100, sorter: true,
      filters: STATUS_FILTER_OPTIONS,
      filteredValue: filters.status || null,
      onFilter: () => true,
      render: (v: string) => v ? <Tag color={STATUS_COLOR[v] || 'default'}>{STATUS_LABEL[v] || v}</Tag> : null,
    },
    { title: '明细数', dataIndex: 'detail_count', width: 90, align: 'right', sorter: true },
    { title: '总数量', dataIndex: 'total_qty', width: 110, align: 'right', sorter: true,
      render: (v: any) => v != null ? Number(v).toFixed(2) : '-' },
    {
      title: '来源', dataIndex: 'data_source', width: 90, sorter: true,
      filters: DATA_SOURCE_FILTER_OPTIONS,
      filteredValue: filters.data_source || null,
      onFilter: () => true,
      render: (v: string) => v === 'erp' ? <Tag color="blue">ERP</Tag> : (v ? <Tag>{v}</Tag> : null),
    },
    { title: '摘要', dataIndex: 'remark', width: 200, ellipsis: true, sorter: true },
    {
      title: '操作', key: 'op', width: 140, fixed: 'right',
      render: (_: any, r: HeadRow) => (
        <Space>
          <Tooltip title={r.data_source === 'erp' ? 'ERP 数据请在 ERP 系统修改' : '编辑'}>
            <Button size="small" icon={<EditOutlined />}
              disabled={r.data_source === 'erp'} onClick={() => openEdit(r)} />
          </Tooltip>
          <Tooltip title={r.data_source === 'erp' ? 'ERP 数据不可删除' : '删除'}>
            <Popconfirm title="确认删除？" onConfirm={() => remove(r.id)} disabled={r.data_source === 'erp'}>
              <Button size="small" danger icon={<DeleteOutlined />} disabled={r.data_source === 'erp'} />
            </Popconfirm>
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        {STAT_CARDS.map((card, i) => {
          const value = (stats as any)[card.key] ?? 0
          return (
            <Col span={6} key={i}>
              <Card size="small" className="card-modern" style={{ padding: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: 10,
                    background: `${card.color}15`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 'calc(1.25rem * var(--font-size-scale))', color: card.color,
                  }}>
                    {card.icon}
                  </div>
                  <div>
                    <div style={{ fontSize: 'calc(1.375rem * var(--font-size-scale))', fontWeight: 700, color: '#1e293b' }}>
                      {value}
                    </div>
                    <div style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', color: '#64748b' }}>
                      {card.title}
                    </div>
                  </div>
                </div>
              </Card>
            </Col>
          )
        })}
      </Row>

      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col>
            <Input
              prefix={<SearchOutlined />}
              placeholder="搜索单据编号/供应商/摘要"
              value={keyword}
              onChange={e => { setKeyword(e.target.value); setPage(1) }}
              style={{ width: 260 }}
              allowClear
            />
          </Col>
          <Col>
            <Select
              value={includeVoided ? 'yes' : 'no'}
              onChange={v => { setIncludeVoided(v === 'yes'); setPage(1) }}
              style={{ width: 130 }}
            >
              <Select.Option value="no">隐藏作废</Select.Option>
              <Select.Option value="yes">包含作废</Select.Option>
            </Select>
          </Col>
          {(filters.supplier_name ||
            filters.status?.length || filters.data_source?.length || filters.bill_date) && (
            <Col>
              <Button
                icon={<FilterOutlined />}
                onClick={() => { setFilters({}); setPage(1) }}
              >
                清除筛选
              </Button>
            </Col>
          )}
          <Col flex="auto" />
          <Col>
            <Space>
              <Button icon={<ReloadOutlined />} onClick={fetchData}>刷新</Button>
              <Button icon={<DownloadOutlined />} onClick={onExport}>导出</Button>
              <Upload beforeUpload={onImport} showUploadList={false} accept=".csv">
                <Button icon={<UploadOutlined />}>导入 CSV</Button>
              </Upload>
              <Button
                disabled={selectedIds.length === 0}
                onClick={() => setBatchOpen(true)}
              >
                批量更新 {selectedIds.length > 0 ? `(${selectedIds.length})` : ''}
              </Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增</Button>
            </Space>
          </Col>
        </Row>
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table<HeadRow>
          rowKey="id"
          dataSource={data}
          columns={columns}
          loading={loading}
          scroll={{ x: 1500 }}
          size="small"
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: keys => setSelectedIds(keys as number[]),
          }}
          pagination={{
            total, current: page, pageSize,
            showSizeChanger: true, showTotal: t => `共 ${t} 条`,
          }}
          onChange={(pagination, tableFilters, sorter: any) => {
            setPage(pagination.current || 1)
            setPageSize(pagination.pageSize || 20)
            const f = sorter?.field as string | undefined
            setSortBy(f || '')
            setSortOrder(sorter?.order === 'ascend' ? 'asc' : sorter?.order === 'descend' ? 'desc' : '')
            setFilters(prev => ({
              ...prev,
              status: (tableFilters.status as string[] | undefined) ?? prev.status,
              data_source: (tableFilters.data_source as string[] | undefined) ?? prev.data_source,
            }))
          }}
          expandable={{
            rowExpandable: r => (r.detail_count ?? 0) > 0,
            expandedRowRender: r => <SubcontractDetailInline head={r} onChanged={fetchData} />,
          }}
        />
      </div>

      <Modal
        title={`批量更新 ${selectedIds.length} 条`}
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        onOk={submitBatch}
        confirmLoading={batchLoading}
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical">
          <Form.Item name="status" label="状态">
            <Input placeholder="如 0/1/2/3（留空不改）" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} placeholder="留空不改" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editing ? `编辑 ${editing.bill_no}` : '新建委外订单'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => headForm.submit()}
        width={640}
        destroyOnClose
      >
        <Form form={headForm} layout="vertical" onFinish={submitHead}>
          <Form.Item name="bill_no" label="单据编号" rules={[{ required: true }]}>
            <Input disabled={!!editing} />
          </Form.Item>
          <Form.Item name="bill_date" label="日期"><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="bill_type" label="类型"><Input /></Form.Item>
          <Form.Item name="supplier_id" label="供应商ID"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="status" label="状态">
            <Select allowClear placeholder="0=未审核 1=已审核 2=审核中 3=已关闭">
              <Select.Option value="0">未审核</Select.Option>
              <Select.Option value="1">已审核</Select.Option>
              <Select.Option value="2">审核中</Select.Option>
              <Select.Option value="3">已关闭</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="remark" label="摘要"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

function SubcontractDetailInline({ head, onChanged }: { head: HeadRow; onChanged: () => void }) {
  const [items, setItems] = useState<DetailRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addForm] = Form.useForm()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sortBy, setSortBy] = useState('')
  const [sortOrder, setSortOrder] = useState('')
  const [filters, setFilters] = useState<DetailFilters>({})
  const isErp = head.data_source === 'erp'

  const fetchDetails = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = { page, page_size: pageSize }
      if (filters.material_code) params.material_code = filters.material_code
      if (filters.material_name) params.material_name = filters.material_name
      if (filters.sale_order_no) params.sale_order_no = filters.sale_order_no
      if (filters.data_source?.length) params.data_source = filters.data_source.join(',')
      if (filters.mrp_closed != null) params.mrp_closed = filters.mrp_closed
      if (filters.qty?.[0] != null) params.qty_min = filters.qty[0]
      if (filters.qty?.[1] != null) params.qty_max = filters.qty[1]
      if (filters.delivery_qty?.[0] != null) params.delivery_qty_min = filters.delivery_qty[0]
      if (filters.delivery_qty?.[1] != null) params.delivery_qty_max = filters.delivery_qty[1]
      if (filters.received_qty?.[0] != null) params.received_qty_min = filters.received_qty[0]
      if (filters.received_qty?.[1] != null) params.received_qty_max = filters.received_qty[1]
      if (sortBy) params.sort_by = sortBy
      if (sortOrder) params.sort_order = sortOrder
      const res: any = await materialApi.getSubcontractOrderDetails(head.id, params)
      setItems(res?.data?.items || [])
      setTotal(res?.data?.total || 0)
    } catch (e: any) {
      message.error(e?.message || '加载明细失败')
    } finally {
      setLoading(false)
    }
  }, [head.id, page, pageSize, sortBy, sortOrder, filters])

  useEffect(() => { fetchDetails() }, [fetchDetails])

  const reload = fetchDetails

  const handleAdd = async (values: any) => {
    try {
      await materialApi.addSubcontractOrderDetail(head.id, values)
      message.success('已添加明细')
      addForm.resetFields()
      setAddOpen(false)
      reload()
      onChanged()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '添加失败')
    }
  }

  const handleDelete = async (detailId: number) => {
    try {
      await materialApi.deleteSubcontractOrderDetail(head.id, detailId)
      message.success('已删除')
      reload()
      onChanged()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '删除失败')
    }
  }

  const columns: ColumnsType<DetailRow> = [
    { title: '行号', dataIndex: 'line_no', width: 70, sorter: true },
    { title: '物料编码', dataIndex: 'material_code', width: 140, sorter: true,
      filterDropdown: ({ confirm, clearFilters }) => (
        <TextContainsFilter
          confirm={confirm}
          clearFilters={clearFilters}
          placeholder="搜索物料编码"
          onConfirm={v => { setFilters(f => ({ ...f, material_code: v })); setPage(1) }}
        />
      ),
    },
    { title: '物料名称', dataIndex: 'material_name', width: 180, sorter: true, ellipsis: true,
      filterDropdown: ({ confirm, clearFilters }) => (
        <TextContainsFilter
          confirm={confirm}
          clearFilters={clearFilters}
          placeholder="搜索物料名称"
          onConfirm={v => { setFilters(f => ({ ...f, material_name: v })); setPage(1) }}
        />
      ),
    },
    { title: '数量', dataIndex: 'qty', width: 100, align: 'right', sorter: true,
      render: (v: any) => v != null ? Number(v).toFixed(2) : '-',
      filterDropdown: ({ confirm, clearFilters }) => (
        <NumberRangeFilter
          confirm={confirm}
          clearFilters={clearFilters}
          onConfirm={(min, max) => { setFilters(f => ({ ...f, qty: min != null && max != null ? [min, max] : null })); setPage(1) }}
        />
      ),
    },
    { title: '交货数', dataIndex: 'delivery_qty', width: 100, align: 'right', sorter: true,
      render: (v: any) => v != null ? Number(v).toFixed(2) : '-',
      filterDropdown: ({ confirm, clearFilters }) => (
        <NumberRangeFilter
          confirm={confirm}
          clearFilters={clearFilters}
          onConfirm={(min, max) => { setFilters(f => ({ ...f, delivery_qty: min != null && max != null ? [min, max] : null })); setPage(1) }}
        />
      ),
    },
    { title: '已收', dataIndex: 'received_qty', width: 100, align: 'right', sorter: true,
      render: (v: any) => v != null ? Number(v).toFixed(2) : '-',
      filterDropdown: ({ confirm, clearFilters }) => (
        <NumberRangeFilter
          confirm={confirm}
          clearFilters={clearFilters}
          onConfirm={(min, max) => { setFilters(f => ({ ...f, received_qty: min != null && max != null ? [min, max] : null })); setPage(1) }}
        />
      ),
    },
    { title: '单价', dataIndex: 'price', width: 100, align: 'right', sorter: true,
      render: (v: any) => v != null ? Number(v).toFixed(4) : '-',
    },
    { title: '金额', dataIndex: 'amount', width: 110, align: 'right', sorter: true,
      render: (v: any) => v != null ? Number(v).toFixed(2) : '-',
    },
    { title: '销售订单号', dataIndex: 'sale_order_no', width: 150, sorter: true,
      filterDropdown: ({ confirm, clearFilters }) => (
        <TextContainsFilter
          confirm={confirm}
          clearFilters={clearFilters}
          placeholder="搜索销售订单号"
          onConfirm={v => { setFilters(f => ({ ...f, sale_order_no: v })); setPage(1) }}
        />
      ),
    },
    {
      title: 'MRP关闭', dataIndex: 'mrp_closed_flag', width: 90, sorter: true,
      render: (v: any) => v == 1 ? <Tag color="default">已关闭</Tag> : <Tag color="processing">未关闭</Tag>,
      filterDropdown: ({ confirm }) => (
        <BoolTriFilter
          confirm={confirm}
          onConfirm={v => { setFilters(f => ({ ...f, mrp_closed: v ?? null })); setPage(1) }}
        />
      ),
    },
    {
      title: '来源', dataIndex: 'data_source', width: 90,
      filters: DATA_SOURCE_FILTER_OPTIONS,
      filteredValue: filters.data_source || null,
      onFilter: () => true,
      render: (v: string) => v === 'erp' ? <Tag color="blue">ERP</Tag> : (v ? <Tag>{v}</Tag> : null),
    },
    {
      title: '操作', key: 'op', width: 80, fixed: 'right',
      render: (_: any, r: DetailRow) => (
        <Tooltip title={r.data_source === 'erp' ? 'ERP 同步明细不可删除' : '删除'}>
          <Popconfirm title="删除该明细？" onConfirm={() => handleDelete(r.id)} disabled={r.data_source === 'erp'}>
            <Button size="small" danger icon={<DeleteOutlined />} disabled={r.data_source === 'erp'} />
          </Popconfirm>
        </Tooltip>
      ),
    },
  ]

  return (
    <div style={{ padding: '8px 16px 12px', background: 'rgba(248,250,252,.6)' }}>
      {!isErp && (
        <div style={{ marginBottom: 8 }}>
          <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            添加明细
          </Button>
        </div>
      )}
      <Table<DetailRow>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        columns={columns}
        scroll={{ x: 1400 }}
        pagination={{
          total, current: page, pageSize,
          showSizeChanger: true, size: 'small',
          showTotal: t => `共 ${t} 条`,
        }}
        onChange={(pagination, tableFilters, sorter: any) => {
          setPage(pagination.current || 1)
          setPageSize(pagination.pageSize || 50)
          const f = sorter?.field as string | undefined
          setSortBy(f || '')
          setSortOrder(sorter?.order === 'ascend' ? 'asc' : sorter?.order === 'descend' ? 'desc' : '')
          setFilters(prev => ({
            ...prev,
            data_source: (tableFilters.data_source as string[] | undefined) ?? prev.data_source,
          }))
        }}
      />
      <Modal
        title={`为 ${head.bill_no} 添加明细`}
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={() => addForm.submit()}
        destroyOnClose
      >
        <Form form={addForm} layout="vertical" onFinish={handleAdd}>
          <Form.Item name="material_id" label="物料ID"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="qty" label="数量"><InputNumber style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="price" label="单价"><InputNumber style={{ width: '100%' }} precision={4} /></Form.Item>
          <Form.Item name="amount" label="金额"><InputNumber style={{ width: '100%' }} precision={2} /></Form.Item>
          <Form.Item name="sale_order_no" label="销售订单号"><Input /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
