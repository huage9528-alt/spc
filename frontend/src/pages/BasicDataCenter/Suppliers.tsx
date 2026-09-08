import { useCallback, useEffect, useState, type Key } from 'react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Switch, message,
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
import BdDrawer, { DrawerSection, KvGrid, RefItem } from './components/BdDrawer'
import { useBdTable } from './components/useBdTable'

interface Supplier {
  id: number
  supplier_code: string
  supplier_name: string
  supplier_short?: string | null
  supplier_type?: string | null
  contact_person?: string | null
  contact_phone?: string | null
  fax?: string | null
  address?: string | null
  erp_supply_id?: number | null
  payment_terms?: string | null
  status: number
  create_time: string
  update_time?: string | null
}

interface SupplierStats {
  total: number
  by_type: Record<string, number>
  no_erp: number
  disabled: number
}

interface SupplierMaterial {
  material_code: string
  material_name: string
  order_unit_price?: number | string | null
}

const typeTagMeta = (v: string): [string, string] => {
  if (v.includes('电子')) return ['#0284c7', '#f0f9ff']
  if (v.includes('五金')) return ['#d97706', '#fffbeb']
  if (v.includes('包材')) return ['#8b5cf6', '#f5f3ff']
  return ['#64748b', '#f1f5f9']
}

const renderType = (v?: string | null) => {
  if (!v) return <span className="sc-note">—</span>
  const [c, bg] = typeTagMeta(v)
  return <span className="sc-tag" style={{ color: c, background: bg }}>{v}</span>
}

const renderStatus = (status: number) =>
  status === 1 ? (
    <span className="sc-tag sc-tag-done"><span className="dot" />启用</span>
  ) : (
    <span className="sc-tag" style={{ color: '#94a3b8', background: '#f1f5f9' }}><span className="dot" />停用</span>
  )

const renderErpId = (v?: number | null) =>
  v != null ? (
    <span className="sc-mono" style={{ fontWeight: 600 }}>{v}</span>
  ) : (
    <span style={{ fontSize: 10.5, fontWeight: 600, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 999, padding: '0 7px', lineHeight: '16px', whiteSpace: 'nowrap' }}>未关联</span>
  )

const formatTime = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—')

const DELETE_CONFIRM = '确认删除该供应商？该供应商名下存在关联物料 / 未完结采购单时需先转移供应关系。'

const FORM_NOTE = '未填写 ERP 供应商 ID 的供应商无法在「供应商物料对照」中反查名下物料，也无法参与 ERP 采购单自动匹配 —— 建议补全后保存。'

const CSV_HEADER = ['供应商编码', '供应商名称', '供应商简称', '供应商类型', '联系人', '联系电话', '传真', 'ERP供应商ID', '付款条款', '地址', '状态']

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const exportSuppliersCsv = (rows: Supplier[], filename: string) => {
  if (rows.length === 0) return
  const lines = [
    CSV_HEADER,
    ...rows.map((r) => [
      r.supplier_code,
      r.supplier_name,
      r.supplier_short || '',
      r.supplier_type || '',
      r.contact_person || '',
      r.contact_phone || '',
      r.fax || '',
      r.erp_supply_id ?? '',
      r.payment_terms || '',
      r.address || '',
      r.status === 1 ? '启用' : '停用',
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

export default function Suppliers() {
  const [stats, setStats] = useState<SupplierStats>({ total: 0, by_type: {}, no_erp: 0, disabled: 0 })
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<Supplier | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<Supplier | null>(null)
  const [matItems, setMatItems] = useState<SupplierMaterial[]>([])
  const [matTotal, setMatTotal] = useState(0)
  const [matLoading, setMatLoading] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  const [selectedMap, setSelectedMap] = useState<Record<number, Supplier>>({})
  const [batchWorking, setBatchWorking] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [form] = Form.useForm()

  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data.suppliers', 'delete')

  const extraQuery = useCallback((chip: string | number | null): Record<string, any> => {
    if (chip === 'no_erp') return { no_erp: true }
    if (chip === 'disabled') return { status: 0 }
    if (typeof chip === 'string' && chip && chip !== 'all') return { supplier_type: chip }
    return {}
  }, [])

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<Supplier>({ url: '/basicdata/suppliers', extraQuery, chipInit: 'all' })

  const onSearchChange = (v: string) => {
    setSearchText(v)
    setKeywordInput(v)
  }

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/suppliers/stats')
      setStats({
        total: res.data?.total || 0,
        by_type: res.data?.by_type || {},
        no_erp: res.data?.no_erp || 0,
        disabled: res.data?.disabled || 0,
      })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  useEffect(() => {
    if (!drawerOpen || !drawerItem?.erp_supply_id) {
      setMatItems([])
      setMatTotal(0)
      return
    }
    let cancelled = false
    setMatLoading(true)
    api
      .get('/basicdata/materials/by-suppliers', { params: { erp_supply_ids: drawerItem.erp_supply_id }, skipErrorToast: true } as any)
      .then((res: any) => {
        if (cancelled) return
        setMatItems(res.data?.items || [])
        setMatTotal(res.data?.total || 0)
      })
      .catch(() => {
        if (cancelled) return
        setMatItems([])
        setMatTotal(0)
      })
      .finally(() => {
        if (!cancelled) setMatLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [drawerOpen, drawerItem])

  const refreshAll = useCallback(() => {
    reload()
    fetchStats()
  }, [reload, fetchStats])

  const clearSelection = () => {
    setSelectedRowKeys([])
    setSelectedMap({})
  }

  const handleAdd = () => {
    setEditingItem(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (item: Supplier) => {
    setEditingItem(item)
    form.resetFields()
    form.setFieldsValue({ ...item, status: item.status === 1 })
    setModalVisible(true)
  }

  const openDrawer = (item: Supplier) => {
    setDrawerItem(item)
    setDrawerOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/basicdata/suppliers/${id}`)
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
      const payload = { ...values, status: values.status ? 1 : 0 }
      if (editingItem) {
        await api.put(`/basicdata/suppliers/${editingItem.id}`, payload)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/suppliers', payload)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const handleBatchStatus = async (status: 0 | 1) => {
    const rows = selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is Supplier => r != null)
    if (rows.length === 0) return
    setBatchWorking(true)
    const results = await Promise.allSettled(
      rows.map((r) => api.put(`/basicdata/suppliers/${r.id}`, { status })),
    )
    setBatchWorking(false)
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    const failCount = results.length - okCount
    if (failCount === 0) message.success(`已${status === 1 ? '启用' : '停用'} ${okCount} 项`)
    else message.warning(`成功 ${okCount} 项，失败 ${failCount} 项`)
    clearSelection()
    refreshAll()
  }

  const getSelectedRows = () =>
    selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is Supplier => r != null)

  const handleExportSelected = () => {
    exportSuppliersCsv(getSelectedRows(), `供应商主数据_${dayjs().format('YYYY-MM-DD')}.csv`)
  }

  const linkedErp = Math.max(stats.total - stats.no_erp, 0)

  const topTypes = Object.entries(stats.by_type)
    .filter(([k]) => k.trim())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)

  const kpiItems: KpiItem[] = [
    { label: '供应商总数', value: stats.total.toLocaleString(), accent: 'brand' },
    { label: '已关联 ERP', value: linkedErp.toLocaleString(), sub: '可在对照页反查名下物料', accent: 'success' },
    { label: '未关联 ERP', value: stats.no_erp.toLocaleString(), go: '点击筛选待维护 →', accent: 'danger', onClick: () => setChip('no_erp') },
    { label: '已停用', value: stats.disabled.toLocaleString(), go: '查看 →', accent: 'gray', onClick: () => setChip('disabled') },
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    ...topTypes.map(([name, count]): ChipOption => ({ label: name, value: name, count })),
    { label: '未关联 ERP', value: 'no_erp', count: stats.no_erp, hot: true },
    { label: '停用', value: 'disabled', count: stats.disabled },
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[], rows: Supplier[]) => {
      setSelectedRowKeys(keys)
      const byKey = new Map(rows.map((r) => [r.id, r]))
      setSelectedMap((prev) => {
        const next: Record<number, Supplier> = {}
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

  const columns: TableColumnsType<Supplier> = [
    {
      title: '供应商',
      dataIndex: 'supplier_code',
      key: 'supplier_code',
      width: 260,
      sorter: true,
      sortOrder: orderOf('supplier_code'),
      render: (_: any, record: Supplier) => (
        <div>
          <div className="sc-mat-name" style={{ cursor: 'pointer' }} onClick={() => openDrawer(record)}>
            {record.supplier_name}
          </div>
          <div className="sc-mat-code">{record.supplier_code}</div>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'supplier_type',
      key: 'supplier_type',
      width: 110,
      render: (v: string) => renderType(v),
    },
    {
      title: '联系人',
      dataIndex: 'contact_person',
      key: 'contact_person',
      width: 100,
      ellipsis: true,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '联系电话',
      dataIndex: 'contact_phone',
      key: 'contact_phone',
      width: 130,
      className: 'sc-mono',
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: 'ERP 供应商 ID',
      dataIndex: 'erp_supply_id',
      key: 'erp_supply_id',
      width: 130,
      render: (v: number | null) => renderErpId(v),
    },
    {
      title: '付款条款',
      dataIndex: 'payment_terms',
      key: 'payment_terms',
      width: 120,
      ellipsis: true,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: number) => renderStatus(status),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: any, record: Supplier) => (
        <span className="sc-row-act">
          <Button type="text" size="small" onClick={() => openDrawer(record)}>详情</Button>
          <PermButton permResource="basicdata.data.suppliers" permAction="update" type="text" size="small" onClick={() => handleEdit(record)}>编辑</PermButton>
          <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
            <PermButton permResource="basicdata.data.suppliers" permAction="delete" type="text" size="small" danger>删除</PermButton>
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
            placeholder="供应商编码 / 名称"
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
            onClick={() => exportSuppliersCsv(items, `供应商主数据_${dayjs().format('YYYY-MM-DD')}.csv`)}
          >
            导出
          </Button>
          <PermButton permResource="basicdata.data.suppliers" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增供应商
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
          scroll={{ x: 1200 }}
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
        <PermButton permResource="basicdata.data.suppliers" permAction="update" size="small" loading={batchWorking} onClick={() => handleBatchStatus(1)}>批量启用</PermButton>
        <PermButton permResource="basicdata.data.suppliers" permAction="update" size="small" loading={batchWorking} onClick={() => handleBatchStatus(0)}>批量停用</PermButton>
        <Button size="small" icon={<ExportOutlined />} onClick={handleExportSelected}>导出所选</Button>
      </BatchBar>

      <BdDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={drawerItem?.supplier_name}
        code={drawerItem?.supplier_code}
        tags={drawerItem && (<>{renderType(drawerItem.supplier_type)}{renderStatus(drawerItem.status)}</>)}
        actions={drawerItem && (
          <>
            <PermButton permResource="basicdata.data.suppliers" permAction="update" type="primary" size="small" icon={<EditOutlined />} onClick={() => handleEdit(drawerItem)}>编辑</PermButton>
            <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(drawerItem.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
              <PermButton permResource="basicdata.data.suppliers" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
            </Popconfirm>
          </>
        )}
      >
        {drawerItem && (
          <div style={{ marginTop: 12 }}>
            <DrawerSection title="基本信息">
              <KvGrid
                items={[
                  ['联系人', drawerItem.contact_person || '—'],
                  ['联系电话', <span className="sc-mono" key="ph">{drawerItem.contact_phone || '—'}</span>],
                  ['传真', drawerItem.fax || '—'],
                  ['类型', renderType(drawerItem.supplier_type)],
                  ['付款条款', drawerItem.payment_terms || '—'],
                  ['地址', drawerItem.address || '—'],
                  ['状态', renderStatus(drawerItem.status)],
                  ['ERP 供应商 ID', renderErpId(drawerItem.erp_supply_id)],
                  ['创建时间', <span className="sc-mono" key="ct">{formatTime(drawerItem.create_time)}</span>],
                  ['更新时间', <span className="sc-mono" key="ut">{formatTime(drawerItem.update_time)}</span>],
                ]}
              />
            </DrawerSection>
            {drawerItem.erp_supply_id != null && (
              <DrawerSection
                title={matTotal > 10 ? `名下物料（10 / ${matTotal}）` : `名下物料（${matTotal}）`}
              >
                {matLoading ? (
                  <div style={{ color: '#94a3b8', fontSize: 12.5 }}>加载中…</div>
                ) : matItems.length === 0 ? (
                  <div style={{ color: '#94a3b8', fontSize: 12.5 }}>该供应商名下暂无物料或未维护归属</div>
                ) : (
                  matItems.slice(0, 10).map((m) => (
                    <RefItem
                      key={m.material_code}
                      main={m.material_name}
                      extra={m.order_unit_price != null ? `¥${m.order_unit_price}` : undefined}
                      right={m.material_code}
                    />
                  ))
                )}
              </DrawerSection>
            )}
          </div>
        )}
      </BdDrawer>

      <Modal
        title={editingItem ? '编辑供应商' : '新增供应商'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={720}
        rootClassName="sc-page"
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="supplier_code" label="供应商编码" rules={[{ required: true }]}>
                <Input placeholder="如 SUP-0023（唯一）" disabled={!!editingItem} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="supplier_name" label="供应商名称" rules={[{ required: true }]}>
                <Input placeholder="如 XX 电子有限公司" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="supplier_short" label="供应商简称">
                <Input placeholder="选填" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="supplier_type" label="供应商类型">
                <Input placeholder="如 电子元件 / 五金结构件 / 包材辅料" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="contact_person" label="联系人">
                <Input placeholder="选填" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="contact_phone" label="联系电话">
                <Input placeholder="选填" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="fax" label="传真">
                <Input placeholder="选填" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="erp_supply_id" label="ERP 供应商 ID">
                <InputNumber style={{ width: '100%' }} placeholder="如 500032 · 选填" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="payment_terms" label="付款条款">
                <Input placeholder="如 月结 30 天" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="address" label="地址">
                <Input placeholder="省 / 市 / 区 / 详细地址" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="status" label="状态" valuePropName="checked" initialValue={true} extra="启用（停用后在采购匹配中不可选）">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={24}>
              <div className="f-note" style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>{FORM_NOTE}</div>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
