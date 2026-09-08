import { useCallback, useEffect, useState, type Key } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Table, Button, Modal, Form, Input, Select, InputNumber, Switch, message,
  Popconfirm, Row, Col, Tooltip, type TableColumnsType,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  SearchOutlined, ExportOutlined, NodeIndexOutlined,
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

interface Warehouse {
  id: number
  wh_code: string
  wh_name: string
  wh_type?: string | null
  address?: string | null
  manager_id?: number | null
  is_enabled: number
  create_time: string
}

interface WarehouseStats {
  total: number
  by_type: Record<string, number>
  disabled: number
  location_count: number
}

const WH_TYPES = ['原料仓', '成品仓', '包材仓', '线边仓']

const TYPE_META: Record<string, { color: string; bg: string }> = {
  原料仓: { color: '#0284c7', bg: '#f0f9ff' },
  成品仓: { color: '#16a34a', bg: '#f0fdf4' },
  包材仓: { color: '#8b5cf6', bg: '#f5f3ff' },
  线边仓: { color: '#d97706', bg: '#fffbeb' },
}

const renderType = (v?: string | null) => {
  if (!v) return <span className="sc-note">—</span>
  const m = TYPE_META[v]
  if (!m) return <span className="sc-tag" style={{ color: '#64748b', background: '#f1f5f9' }}>{v}</span>
  return <span className="sc-tag" style={{ color: m.color, background: m.bg }}>{v}</span>
}

const renderStatus = (status: number) =>
  status === 1 ? (
    <span className="sc-tag sc-tag-done"><span className="dot" />启用</span>
  ) : (
    <span className="sc-tag" style={{ color: '#94a3b8', background: '#f1f5f9' }}><span className="dot" />停用</span>
  )

const renderManager = (v?: number | null) =>
  v != null ? <span className="sc-mono">EMP-{v}</span> : <span className="sc-note">—</span>

const formatTime = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—')

const DELETE_CONFIRM = '确认删除该仓库？该仓库下存在库位与库存记录时，需先清空库存并迁移库位。'

const FORM_NOTE = '提示：仓库建立后需到「库位」页维护库位树（仓区 → 巷道 → 货架 → 库位），盘点与库存查询均按库位粒度执行。'

const CSV_HEADER = ['仓库编码', '仓库名称', '仓库类型', '仓库地址', '管理员ID', '状态']

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const exportWarehousesCsv = (rows: Warehouse[], filename: string) => {
  if (rows.length === 0) return
  const lines = [
    CSV_HEADER,
    ...rows.map((r) => [
      r.wh_code,
      r.wh_name,
      r.wh_type || '',
      r.address || '',
      r.manager_id != null ? `EMP-${r.manager_id}` : '',
      r.is_enabled === 1 ? '启用' : '停用',
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

export default function Warehouses() {
  const navigate = useNavigate()
  const [stats, setStats] = useState<WarehouseStats>({ total: 0, by_type: {}, disabled: 0, location_count: 0 })
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<Warehouse | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<Warehouse | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  const [selectedMap, setSelectedMap] = useState<Record<number, Warehouse>>({})
  const [batchWorking, setBatchWorking] = useState(false)
  const [switchLoading, setSwitchLoading] = useState<Record<number, boolean>>({})
  const [searchText, setSearchText] = useState('')
  const [form] = Form.useForm()

  const hasPermission = useAuthStore(s => s.hasPermission)
  const canUpdate = hasPermission('basicdata.data.warehouses', 'update')
  const canDelete = hasPermission('basicdata.data.warehouses', 'delete')

  const extraQuery = useCallback((chip: string | number | null): Record<string, any> => {
    if (chip && chip !== 'all') return { wh_type: chip }
    return {}
  }, [])

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<Warehouse>({ url: '/basicdata/warehouses', extraQuery, chipInit: 'all' })

  const onSearchChange = (v: string) => {
    setSearchText(v)
    setKeywordInput(v)
  }

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/warehouses/stats')
      setStats({
        total: res.data?.total || 0,
        by_type: res.data?.by_type || {},
        disabled: res.data?.disabled || 0,
        location_count: res.data?.location_count || 0,
      })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

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

  const handleEdit = (item: Warehouse) => {
    setEditingItem(item)
    form.resetFields()
    form.setFieldsValue({ ...item, is_enabled: item.is_enabled === 1 })
    setModalVisible(true)
  }

  const openDrawer = (item: Warehouse) => {
    setDrawerItem(item)
    setDrawerOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/basicdata/warehouses/${id}`)
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
      const payload = { ...values, is_enabled: values.is_enabled ? 1 : 0 }
      if (editingItem) {
        await api.put(`/basicdata/warehouses/${editingItem.id}`, payload)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/warehouses', payload)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const handleToggle = async (record: Warehouse, checked: boolean) => {
    const next = checked ? 1 : 0
    setSwitchLoading((p) => ({ ...p, [record.id]: true }))
    try {
      await api.put(`/basicdata/warehouses/${record.id}`, { is_enabled: next })
      message.success(next === 1 ? '已启用' : '已停用')
      refreshAll()
    } catch {
      reload()
    } finally {
      setSwitchLoading((p) => ({ ...p, [record.id]: false }))
    }
  }

  const handleBatchStatus = async (status: 0 | 1) => {
    const rows = selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is Warehouse => r != null)
    if (rows.length === 0) return
    setBatchWorking(true)
    const results = await Promise.allSettled(
      rows.map((r) => api.put(`/basicdata/warehouses/${r.id}`, { is_enabled: status })),
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
    selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is Warehouse => r != null)

  const handleExportSelected = () => {
    exportWarehousesCsv(getSelectedRows(), `仓库主数据_${dayjs().format('YYYY-MM-DD')}.csv`)
  }

  const kpiItems: KpiItem[] = [
    { label: '仓库总数', value: stats.total.toLocaleString(), sub: `启用 ${stats.total - stats.disabled} · 停用 ${stats.disabled}`, accent: 'brand' },
    { label: '库位总数', value: stats.location_count.toLocaleString(), go: '进入库位树 →', accent: 'info', onClick: () => navigate('/basicdata/locations') },
    { label: '类型数', value: Object.keys(stats.by_type).filter((k) => k).length.toLocaleString(), accent: 'purple' },
    { label: '停用', value: stats.disabled.toLocaleString(), accent: 'gray' },
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    ...WH_TYPES
      .map((t) => ({ label: t, value: t, count: stats.by_type[t] || 0 }))
      .filter((o) => o.count > 0),
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[], rows: Warehouse[]) => {
      setSelectedRowKeys(keys)
      const byKey = new Map(rows.map((r) => [r.id, r]))
      setSelectedMap((prev) => {
        const next: Record<number, Warehouse> = {}
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

  const columns: TableColumnsType<Warehouse> = [
    {
      title: '仓库',
      dataIndex: 'wh_code',
      key: 'wh_code',
      width: 230,
      sorter: true,
      sortOrder: orderOf('wh_code'),
      render: (_: any, record: Warehouse) => (
        <div>
          <div
            className="sc-mat-name"
            style={{ cursor: 'pointer', ...(record.is_enabled === 0 ? { color: '#94a3b8' } : {}) }}
            onClick={() => openDrawer(record)}
          >
            {record.wh_name}
          </div>
          <div className="sc-mat-code">{record.wh_code}</div>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'wh_type',
      key: 'wh_type',
      width: 100,
      sorter: true,
      sortOrder: orderOf('wh_type'),
      render: (v: string) => renderType(v),
    },
    {
      title: '地址',
      dataIndex: 'address',
      key: 'address',
      ellipsis: true,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '管理员',
      dataIndex: 'manager_id',
      key: 'manager_id',
      width: 120,
      render: (v?: number | null) => renderManager(v),
    },
    {
      title: '启用',
      dataIndex: 'is_enabled',
      key: 'is_enabled',
      width: 80,
      sorter: true,
      sortOrder: orderOf('is_enabled'),
      render: (v: number, record: Warehouse) => (
        <Switch
          size="small"
          checked={v === 1}
          loading={!!switchLoading[record.id]}
          disabled={!canUpdate}
          onChange={(checked) => handleToggle(record, checked)}
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: any, record: Warehouse) => (
        <span className="sc-row-act">
          <Button type="text" size="small" onClick={() => openDrawer(record)}>详情</Button>
          <PermButton permResource="basicdata.data.warehouses" permAction="update" type="text" size="small" onClick={() => handleEdit(record)}>编辑</PermButton>
          <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
            <PermButton permResource="basicdata.data.warehouses" permAction="delete" type="text" size="small" danger>删除</PermButton>
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
            placeholder="仓库编码 / 名称 / 地址"
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
            onClick={() => exportWarehousesCsv(items, `仓库主数据_${dayjs().format('YYYY-MM-DD')}.csv`)}
          >
            导出
          </Button>
          <PermButton permResource="basicdata.data.warehouses" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增仓库
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
          scroll={{ x: 900 }}
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
        <PermButton permResource="basicdata.data.warehouses" permAction="update" size="small" loading={batchWorking} onClick={() => handleBatchStatus(1)}>批量启用</PermButton>
        <PermButton permResource="basicdata.data.warehouses" permAction="update" size="small" loading={batchWorking} onClick={() => handleBatchStatus(0)}>批量停用</PermButton>
        <Button size="small" icon={<ExportOutlined />} onClick={handleExportSelected}>导出所选</Button>
      </BatchBar>

      <BdDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={drawerItem?.wh_name}
        code={drawerItem?.wh_code}
        tags={drawerItem && (<>{renderType(drawerItem.wh_type)}{renderStatus(drawerItem.is_enabled)}</>)}
        actions={drawerItem && (
          <>
            <PermButton permResource="basicdata.data.warehouses" permAction="update" type="primary" size="small" icon={<EditOutlined />} onClick={() => handleEdit(drawerItem)}>编辑</PermButton>
            <Button size="small" icon={<NodeIndexOutlined />} onClick={() => navigate('/basicdata/locations')}>库位树</Button>
            <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(drawerItem.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
              <PermButton permResource="basicdata.data.warehouses" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
            </Popconfirm>
          </>
        )}
      >
        {drawerItem && (
          <div style={{ marginTop: 12 }}>
            <DrawerSection title="基本信息">
              <KvGrid
                items={[
                  ['仓库地址', drawerItem.address || '—'],
                  ['管理员ID', drawerItem.manager_id != null ? <span className="sc-mono" key="mg">EMP-{drawerItem.manager_id}</span> : '—'],
                  ['状态', renderStatus(drawerItem.is_enabled)],
                  ['创建时间', <span className="sc-mono" key="ct">{formatTime(drawerItem.create_time)}</span>],
                ]}
              />
            </DrawerSection>
          </div>
        )}
      </BdDrawer>

      <Modal
        title={editingItem ? '编辑仓库' : '新增仓库'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={600}
        rootClassName="sc-page"
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="wh_code" label="仓库编码" rules={[{ required: true }]}>
                <Input placeholder="如 WH-07（唯一）" disabled={!!editingItem} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="wh_name" label="仓库名称" rules={[{ required: true }]}>
                <Input placeholder="如 原料三号仓" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="wh_type" label="仓库类型" rules={[{ required: true }]}>
                <Select placeholder="请选择仓库类型">
                  {WH_TYPES.map((t) => (
                    <Select.Option key={t} value={t}>{t}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="manager_id" label="管理员ID">
                <InputNumber style={{ width: '100%' }} placeholder="人员 ID · 选填" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="address" label="仓库地址">
                <Input placeholder="省 / 市 / 区 / 详细地址" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="is_enabled" label="状态" valuePropName="checked" initialValue={true} extra="启用（停用后出入库单据不可再选该仓）">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={24}>
              <div className="f-note">{FORM_NOTE}</div>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
