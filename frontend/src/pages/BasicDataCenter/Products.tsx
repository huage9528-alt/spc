import { useCallback, useEffect, useMemo, useState, type Key } from 'react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Select, message,
  Popconfirm, Row, Col, Tooltip, type TableColumnsType,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  SearchOutlined, ExportOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../../services/api'
import PermButton from '../../components/PermButton'
import { useAuthStore } from '../../store/auth'
import KpiBand, { type KpiItem } from './components/KpiBand'
import ChipsFilter, { type ChipOption } from './components/ChipsFilter'
import BatchBar, { batchBarPad } from './components/BatchBar'
import BdDrawer, { DrawerSection, KvGrid } from './components/BdDrawer'
import { useBdTable } from './components/useBdTable'

interface Product {
  id: number
  product_code: string
  product_line?: string | null
  tech_version?: string | null
  bom_version?: string | null
  default_warehouse?: string | null
  warranty_days?: number | null
  create_time: string
  update_time?: string | null
}

interface ProductStats {
  total: number
  by_product_line: Record<string, number>
  missing_default_warehouse: number
}

interface WarehouseOpt {
  id: number
  wh_code: string
  wh_name: string
}

const LINE_COLORS: Array<[string, string]> = [
  ['#4c4dc2', '#eef0fe'],
  ['#0284c7', '#f0f9ff'],
  ['#8b5cf6', '#f5f3ff'],
  ['#0e7490', '#ecfeff'],
]

const formatTime = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD') : '—')

const DELETE_CONFIRM = '确认删除该产品？删除前系统将校验是否存在关联 BOM 与 SKU。'

const FORM_NOTE = '提示：默认仓库用于完工入库自动归仓；未配置的产品完工后将落入「待归仓」区，由仓库管理员手工归位。'

const CSV_HEADER = ['产品编码', '产品线', '技术版本', 'BOM 版本', '默认仓库', '质保天数', '更新时间']

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const exportProductsCsv = (rows: Product[], filename: string) => {
  if (rows.length === 0) return
  const lines = [
    CSV_HEADER,
    ...rows.map((r) => [
      r.product_code,
      r.product_line || '',
      r.tech_version || '',
      r.bom_version || '',
      r.default_warehouse || '',
      r.warranty_days != null ? r.warranty_days : '',
      formatTime(r.update_time || r.create_time),
    ]),
  ]
  const csv = '\ufeff' + lines.map((l) => l.map(csvEscape).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const renderNoWh = () => (
  <span style={{ fontSize: 10.5, fontWeight: 600, color: '#94a3b8', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 999, padding: '0 7px', lineHeight: '16px', whiteSpace: 'nowrap', display: 'inline-block' }}>未配置</span>
)

export default function Products() {
  const [stats, setStats] = useState<ProductStats>({ total: 0, by_product_line: {}, missing_default_warehouse: 0 })
  const [warehouseOpts, setWarehouseOpts] = useState<WarehouseOpt[]>([])
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<Product | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<Product | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  const [selectedMap, setSelectedMap] = useState<Record<number, Product>>({})
  const [batchWorking, setBatchWorking] = useState(false)
  const [whModalOpen, setWhModalOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [form] = Form.useForm()
  const [batchForm] = Form.useForm()

  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data.products', 'delete')

  const extraQuery = useCallback((c: string | number | null): Record<string, any> => {
    if (c == null || c === 'all') return {}
    return { product_line: String(c) }
  }, [])

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<Product>({ url: '/basicdata/products', extraQuery, chipInit: 'all' })

  const onSearchChange = (v: string) => {
    setSearchText(v)
    setKeywordInput(v)
  }

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/products/stats')
      setStats({
        total: res.data?.total || 0,
        by_product_line: res.data?.by_product_line || {},
        missing_default_warehouse: res.data?.missing_default_warehouse || 0,
      })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  useEffect(() => {
    fetchStats()
    api.get('/basicdata/warehouses', { params: { is_enabled: 1, page_size: 100 } })
      .then((res: any) => { setWarehouseOpts(res.data?.items || []) })
      .catch(() => {
        // 错误已由全局拦截器提示
      })
  }, [fetchStats])

  const refreshAll = useCallback(() => {
    reload()
    fetchStats()
  }, [reload, fetchStats])

  const lineEntries = useMemo(
    () => Object.entries(stats.by_product_line).filter(([k]) => k !== '').sort((a, b) => b[1] - a[1]),
    [stats.by_product_line],
  )

  const lineIdx = useCallback((key: string) => {
    const i = lineEntries.findIndex(([k]) => k === key)
    if (i >= 0) return i
    let h = 0
    for (let j = 0; j < key.length; j++) h = (h * 31 + key.charCodeAt(j)) | 0
    return Math.abs(h)
  }, [lineEntries])

  const renderLineTag = (v?: string | null) => {
    if (!v) return <span className="sc-note">—</span>
    const [c, bg] = LINE_COLORS[lineIdx(v) % LINE_COLORS.length]
    return <span className="sc-tag" style={{ color: c, background: bg }}>{v}</span>
  }

  const whLabel = useCallback((code?: string | null) => {
    if (!code) return null
    const wh = warehouseOpts.find((w) => w.wh_code === code)
    return wh ? `${wh.wh_code} ${wh.wh_name}` : null
  }, [warehouseOpts])

  const warehouseOptions = useMemo(
    () => warehouseOpts.map((w) => ({ value: w.wh_code, label: `${w.wh_code} ${w.wh_name}` })),
    [warehouseOpts],
  )

  const clearSelection = () => {
    setSelectedRowKeys([])
    setSelectedMap({})
  }

  const handleAdd = () => {
    setEditingItem(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (item: Product) => {
    setEditingItem(item)
    form.resetFields()
    form.setFieldsValue(item)
    setModalVisible(true)
  }

  const openDrawer = (item: Product) => {
    setDrawerItem(item)
    setDrawerOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/basicdata/products/${id}`)
      message.success('删除成功')
      if (drawerOpen && drawerItem?.id === id) setDrawerOpen(false)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      if (editingItem) {
        await api.put(`/basicdata/products/${editingItem.id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/products', values)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const getSelectedRows = () =>
    selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is Product => r != null)

  const handleBatchWarehouse = async () => {
    try {
      const values = await batchForm.validateFields()
      const rows = getSelectedRows()
      if (rows.length === 0) return
      setBatchWorking(true)
      const results = await Promise.allSettled(
        rows.map((r) => api.put(`/basicdata/products/${r.id}`, { default_warehouse: values.default_warehouse })),
      )
      setBatchWorking(false)
      const okCount = results.filter((r) => r.status === 'fulfilled').length
      const failCount = results.length - okCount
      if (failCount === 0) message.success(`已设置默认仓 ${okCount} 项`)
      else message.warning(`成功 ${okCount} 项，失败 ${failCount} 项`)
      setWhModalOpen(false)
      batchForm.resetFields()
      clearSelection()
      refreshAll()
    } catch {
      // 表单校验失败
    }
  }

  const handleExportSelected = () => {
    exportProductsCsv(getSelectedRows(), `产品主数据_${dayjs().format('YYYY-MM-DD')}.csv`)
  }

  const topLine = lineEntries[0]
  const lineNames = lineEntries.map(([k]) => k)
  const lineSub = lineNames.length ? lineNames.slice(0, 5).join(' / ') + (lineNames.length > 5 ? ' …' : '') : undefined
  const topLineKpi: KpiItem = topLine
    ? { label: '最大产品线', value: topLine[1].toLocaleString(), go: topLine[0], accent: 'purple', onClick: () => setChip(topLine[0]) }
    : { label: '最大产品线', value: '0', accent: 'purple' }

  const kpiItems: KpiItem[] = [
    { label: '产品总数', value: stats.total.toLocaleString(), accent: 'brand' },
    { label: '产品线', value: lineEntries.length.toLocaleString(), sub: lineSub, accent: 'info' },
    { label: '默认仓未配置', value: stats.missing_default_warehouse.toLocaleString(), sub: '完工入库将落入「待归仓」区', accent: 'warning' },
    topLineKpi,
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    ...lineEntries.slice(0, 5).map(([k, n]): ChipOption => ({ label: k, value: k, count: n })),
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[], rows: Product[]) => {
      setSelectedRowKeys(keys)
      const byKey = new Map(rows.map((r) => [r.id, r]))
      setSelectedMap((prev) => {
        const next: Record<number, Product> = {}
        for (const k of keys) {
          const m = byKey.get(Number(k)) ?? prev[Number(k)]
          if (m) next[Number(k)] = m
        }
        return next
      })
    },
  }

  const orderOf = (field: string): 'ascend' | 'descend' | null =>
    sortBy === field ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null

  const columns: TableColumnsType<Product> = [
    {
      title: '产品',
      dataIndex: 'product_code',
      key: 'product_code',
      width: 220,
      sorter: true,
      sortOrder: orderOf('product_code'),
      render: (_: any, record: Product) => (
        <div>
          <div className="sc-mat-name" style={{ cursor: 'pointer' }} onClick={() => openDrawer(record)}>
            {record.product_code}
          </div>
          <div className="sc-mat-code">{record.product_line || '未分类产品线'}</div>
        </div>
      ),
    },
    {
      title: '产品线',
      dataIndex: 'product_line',
      key: 'product_line',
      width: 120,
      sorter: true,
      sortOrder: orderOf('product_line'),
      render: (v: string) => renderLineTag(v),
    },
    {
      title: '技术版本',
      dataIndex: 'tech_version',
      key: 'tech_version',
      width: 110,
      sorter: true,
      sortOrder: orderOf('tech_version'),
      className: 'sc-mono',
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: 'BOM 版本',
      dataIndex: 'bom_version',
      key: 'bom_version',
      width: 110,
      sorter: true,
      sortOrder: orderOf('bom_version'),
      className: 'sc-mono',
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '默认仓库',
      dataIndex: 'default_warehouse',
      key: 'default_warehouse',
      width: 160,
      render: (v: string) => (v ? (whLabel(v) ?? v) : renderNoWh()),
    },
    {
      title: '质保天数',
      dataIndex: 'warranty_days',
      key: 'warranty_days',
      width: 100,
      align: 'right',
      className: 'sc-mono',
      render: (v: number) => (v != null ? v.toLocaleString() : <span className="sc-note">—</span>),
    },
    {
      title: '更新时间',
      dataIndex: 'update_time',
      key: 'update_time',
      width: 110,
      className: 'sc-mono',
      render: (_: any, record: Product) => formatTime(record.update_time || record.create_time),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: any, record: Product) => (
        <span className="sc-row-act">
          <Button type="text" size="small" onClick={() => openDrawer(record)}>详情</Button>
          <PermButton permResource="basicdata.data.products" permAction="update" type="text" size="small" onClick={() => handleEdit(record)}>编辑</PermButton>
          <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
            <PermButton permResource="basicdata.data.products" permAction="delete" type="text" size="small" danger>删除</PermButton>
          </Popconfirm>
        </span>
      ),
    },
  ]

  return (
    <div className="sc-page" style={{ paddingBottom: batchBarPad(selectedRowKeys.length) }}>
      <KpiBand items={kpiItems} />

      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="产品编码"
            style={{ width: 240 }}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            onPressEnter={commitKeyword}
          />
        </span>
        <ChipsFilter options={chipOptions} value={chip ?? 'all'} onChange={(v) => setChip(v)} />
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={refreshAll} />
          </Tooltip>
          <span style={{ width: 1, height: 20, background: '#e2e8f0' }} />
          <Button
            icon={<ExportOutlined />}
            onClick={() => exportProductsCsv(items, `产品主数据_${dayjs().format('YYYY-MM-DD')}.csv`)}
          >
            导出
          </Button>
          <PermButton permResource="basicdata.data.products" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增产品
          </PermButton>
        </span>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          size="small"
          rowSelection={rowSelection}
          scroll={{ x: 1100 }}
          onChange={onTableChange}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t: number) => `共 ${t} 条`,
            pageSizeOptions: ['20', '50', '100'],
          }}
        />
      </div>

      <BatchBar count={selectedRowKeys.length} onClear={clearSelection}>
        <PermButton permResource="basicdata.data.products" permAction="update" size="small" loading={batchWorking} onClick={() => { batchForm.resetFields(); setWhModalOpen(true) }}>批量设置默认仓</PermButton>
        <Button size="small" icon={<ExportOutlined />} onClick={handleExportSelected}>导出所选</Button>
      </BatchBar>

      <BdDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={drawerItem?.product_code}
        code={drawerItem && (<>{renderLineTag(drawerItem.product_line)}<span style={{ marginLeft: 6 }}>PDT · {drawerItem.id}</span></>)}
        tags={drawerItem && (
          <>
            {renderLineTag(drawerItem.product_line)}
            {!drawerItem.default_warehouse && <span className="sc-tag sc-tag-warn">默认仓未配置</span>}
          </>
        )}
        actions={drawerItem && (
          <>
            <PermButton permResource="basicdata.data.products" permAction="update" type="primary" size="small" icon={<EditOutlined />} onClick={() => handleEdit(drawerItem)}>编辑</PermButton>
            <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(drawerItem.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
              <PermButton permResource="basicdata.data.products" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
            </Popconfirm>
          </>
        )}
      >
        {drawerItem && (
          <div style={{ marginTop: 12 }}>
            <DrawerSection title="基本信息">
              <KvGrid
                items={[
                  ['技术版本', <span className="sc-mono" key="tv">{drawerItem.tech_version || '—'}</span>],
                  ['BOM 版本', <span className="sc-mono" key="bv">{drawerItem.bom_version || '—'}</span>],
                  ['默认仓库', drawerItem.default_warehouse
                    ? (whLabel(drawerItem.default_warehouse) ?? drawerItem.default_warehouse)
                    : <span style={{ color: '#d97706', fontWeight: 500 }} key="wh">未配置</span>],
                  ['质保天数', <span className="sc-mono" key="wd">{drawerItem.warranty_days != null ? `${drawerItem.warranty_days} 天` : '—'}</span>],
                  ['创建时间', <span className="sc-mono" key="ct">{formatTime(drawerItem.create_time)}</span>],
                  ['更新时间', <span className="sc-mono" key="ut">{formatTime(drawerItem.update_time)}</span>],
                ]}
              />
            </DrawerSection>
          </div>
        )}
      </BdDrawer>

      <Modal
        title={editingItem ? '编辑产品' : '新增产品'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={640}
        rootClassName="sc-page"
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="product_code" label="产品编码" rules={[{ required: true }]}>
                <Input placeholder="如 PDT-FC100（唯一）" disabled={!!editingItem} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="product_line" label="产品线">
                <Input placeholder="如 温控器线" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="tech_version" label="技术版本">
                <Input placeholder="如 V1.0" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="bom_version" label="BOM 版本号">
                <Input placeholder="如 BOM-A" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="default_warehouse" label="默认仓库">
                <Select allowClear showSearch optionFilterProp="label" placeholder="完工入库默认归入仓库" options={warehouseOptions} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="warranty_days" label="质保天数">
                <InputNumber style={{ width: '100%' }} placeholder="如 730" min={0} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <div className="f-note">{FORM_NOTE}</div>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title="批量设置默认仓"
        open={whModalOpen}
        onOk={handleBatchWarehouse}
        onCancel={() => setWhModalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={420}
        rootClassName="sc-page"
      >
        <Form form={batchForm} layout="vertical">
          <Form.Item name="default_warehouse" label="默认仓库" rules={[{ required: true, message: '请选择默认仓库' }]}>
            <Select allowClear showSearch optionFilterProp="label" placeholder="请选择仓库" options={warehouseOptions} />
          </Form.Item>
          <div className="f-note">将把所选 {selectedRowKeys.length} 个产品的默认仓库统一设置为该仓库；用于完工入库自动归仓。</div>
        </Form>
      </Modal>
    </div>
  )
}
