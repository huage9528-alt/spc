import { useCallback, useEffect, useState, type Key } from 'react'
import {
  Table, Button, Modal, Form, Input, Select, Switch, message,
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

interface Customer {
  id: number
  customer_code: string
  customer_name: string
  customer_short?: string | null
  customer_level?: string | null
  industry_type?: string | null
  credit_code?: string | null
  status: number
  create_time: string
  update_time?: string | null
}

interface CustomerStats {
  total: number
  by_level: Record<string, number>
  disabled: number
}

const LEVEL_TAG_CLASS: Record<string, string> = {
  A: 'sc-tag-prod',
  B: 'sc-tag-kit',
  C: 'sc-tag-wait',
}

const renderLevel = (v?: string | null) => {
  if (!v) return <span className="sc-note">—</span>
  return <span className={`sc-tag ${LEVEL_TAG_CLASS[v] || 'sc-tag-wait'}`}>{v} 类</span>
}

const renderStatus = (status: number) =>
  status === 1 ? (
    <span className="sc-tag sc-tag-done"><span className="dot" />启用</span>
  ) : (
    <span className="sc-tag" style={{ color: '#94a3b8', background: '#f1f5f9' }}><span className="dot" />停用</span>
  )

const formatTime = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—')

const DELETE_CONFIRM = '确认删除该客户？删除前系统将校验是否存在关联订单。'

const FORM_NOTE = '提示：来源为 ERP 的客户，编码与名称由 ERP 每日同步维护，此处修改会在下次同步被覆盖；手工创建的客户可自由编辑。删除前系统将校验是否存在关联订单 / 出货记录。'

const CSV_HEADER = ['客户编码', '客户名称', '客户简称', '等级', '所属行业', '统一社会信用代码', '状态']

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const exportCustomersCsv = (rows: Customer[], filename: string) => {
  if (rows.length === 0) return
  const lines = [
    CSV_HEADER,
    ...rows.map((r) => [
      r.customer_code,
      r.customer_name,
      r.customer_short || '',
      r.customer_level || '',
      r.industry_type || '',
      r.credit_code || '',
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

export default function Customers() {
  const [stats, setStats] = useState<CustomerStats>({ total: 0, by_level: {}, disabled: 0 })
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<Customer | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<Customer | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  const [selectedMap, setSelectedMap] = useState<Record<number, Customer>>({})
  const [batchWorking, setBatchWorking] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [form] = Form.useForm()

  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data.customers', 'delete')

  const extraQuery = useCallback((chip: string | number | null): Record<string, any> => {
    if (chip === 'A' || chip === 'B' || chip === 'C') return { customer_level: chip }
    if (chip === 'disabled') return { status: 0 }
    return {}
  }, [])

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<Customer>({ url: '/basicdata/customers', extraQuery, chipInit: 'all' })

  const onSearchChange = (v: string) => {
    setSearchText(v)
    setKeywordInput(v)
  }

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/customers/stats')
      setStats({
        total: res.data?.total || 0,
        by_level: res.data?.by_level || {},
        disabled: res.data?.disabled || 0,
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

  const handleEdit = (item: Customer) => {
    setEditingItem(item)
    form.resetFields()
    form.setFieldsValue({ ...item, status: item.status === 1 })
    setModalVisible(true)
  }

  const openDrawer = (item: Customer) => {
    setDrawerItem(item)
    setDrawerOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/basicdata/customers/${id}`)
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
        await api.put(`/basicdata/customers/${editingItem.id}`, payload)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/customers', payload)
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
    const rows = selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is Customer => r != null)
    if (rows.length === 0) return
    setBatchWorking(true)
    const results = await Promise.allSettled(
      rows.map((r) => api.put(`/basicdata/customers/${r.id}`, { status })),
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
    selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is Customer => r != null)

  const handleExportSelected = () => {
    exportCustomersCsv(getSelectedRows(), `客户主数据_${dayjs().format('YYYY-MM-DD')}.csv`)
  }

  const kpiItems: KpiItem[] = [
    { label: '客户总数', value: stats.total.toLocaleString(), accent: 'brand' },
    { label: 'A 类客户', value: (stats.by_level.A || 0).toLocaleString(), go: '查看 →', accent: 'brand', onClick: () => setChip('A') },
    { label: 'B 类客户', value: (stats.by_level.B || 0).toLocaleString(), go: '查看 →', accent: 'info', onClick: () => setChip('B') },
    { label: 'C 类客户', value: (stats.by_level.C || 0).toLocaleString(), go: '查看 →', accent: 'gray', onClick: () => setChip('C') },
    { label: '已停用', value: stats.disabled.toLocaleString(), go: '查看 →', accent: 'danger', onClick: () => setChip('disabled') },
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    { label: 'A 类', value: 'A', count: stats.by_level.A || 0 },
    { label: 'B 类', value: 'B', count: stats.by_level.B || 0 },
    { label: 'C 类', value: 'C', count: stats.by_level.C || 0 },
    { label: '停用', value: 'disabled', count: stats.disabled, hot: true },
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[], rows: Customer[]) => {
      setSelectedRowKeys(keys)
      const byKey = new Map(rows.map((r) => [r.id, r]))
      setSelectedMap((prev) => {
        const next: Record<number, Customer> = {}
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

  const columns: TableColumnsType<Customer> = [
    {
      title: '客户',
      dataIndex: 'customer_code',
      key: 'customer_code',
      width: 260,
      sorter: true,
      sortOrder: orderOf('customer_code'),
      render: (_: any, record: Customer) => (
        <div>
          <div className="sc-mat-name" style={{ cursor: 'pointer' }} onClick={() => openDrawer(record)}>
            {record.customer_name}
          </div>
          <div className="sc-mat-code">{record.customer_code}</div>
        </div>
      ),
    },
    {
      title: '简称',
      dataIndex: 'customer_short',
      key: 'customer_short',
      width: 130,
      ellipsis: true,
      sorter: true,
      sortOrder: orderOf('customer_short'),
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '等级',
      dataIndex: 'customer_level',
      key: 'customer_level',
      width: 90,
      sorter: true,
      sortOrder: orderOf('customer_level'),
      render: (v: string) => renderLevel(v),
    },
    {
      title: '所属行业',
      dataIndex: 'industry_type',
      key: 'industry_type',
      width: 130,
      ellipsis: true,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '统一社会信用代码',
      dataIndex: 'credit_code',
      key: 'credit_code',
      width: 210,
      className: 'sc-mono',
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      sorter: true,
      sortOrder: orderOf('status'),
      render: (status: number) => renderStatus(status),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: any, record: Customer) => (
        <span className="sc-row-act">
          <Button type="text" size="small" onClick={() => openDrawer(record)}>详情</Button>
          <PermButton permResource="basicdata.data.customers" permAction="update" type="text" size="small" onClick={() => handleEdit(record)}>编辑</PermButton>
          <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
            <PermButton permResource="basicdata.data.customers" permAction="delete" type="text" size="small" danger>删除</PermButton>
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
            placeholder="客户编码 / 名称 / 简称"
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
            onClick={() => exportCustomersCsv(items, `客户主数据_${dayjs().format('YYYY-MM-DD')}.csv`)}
          >
            导出
          </Button>
          <PermButton permResource="basicdata.data.customers" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增客户
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
        <PermButton permResource="basicdata.data.customers" permAction="update" size="small" loading={batchWorking} onClick={() => handleBatchStatus(1)}>批量启用</PermButton>
        <PermButton permResource="basicdata.data.customers" permAction="update" size="small" loading={batchWorking} onClick={() => handleBatchStatus(0)}>批量停用</PermButton>
        <Button size="small" icon={<ExportOutlined />} onClick={handleExportSelected}>导出所选</Button>
      </BatchBar>

      <BdDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={drawerItem?.customer_name}
        code={drawerItem?.customer_code}
        tags={drawerItem && (<>{renderLevel(drawerItem.customer_level)}{renderStatus(drawerItem.status)}</>)}
        actions={drawerItem && (
          <>
            <PermButton permResource="basicdata.data.customers" permAction="update" type="primary" size="small" icon={<EditOutlined />} onClick={() => handleEdit(drawerItem)}>编辑</PermButton>
            <Button size="small" icon={<ExportOutlined />} onClick={() => exportCustomersCsv([drawerItem], `客户档案_${drawerItem.customer_code}_${dayjs().format('YYYY-MM-DD')}.csv`)}>导出档案</Button>
            <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(drawerItem.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
              <PermButton permResource="basicdata.data.customers" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
            </Popconfirm>
          </>
        )}
      >
        {drawerItem && (
          <div style={{ marginTop: 12 }}>
            <DrawerSection title="基本信息">
              <KvGrid
                items={[
                  ['客户简称', drawerItem.customer_short || '—'],
                  ['客户等级', renderLevel(drawerItem.customer_level)],
                  ['所属行业', drawerItem.industry_type || '—'],
                  ['统一社会信用代码', <span className="sc-mono" key="cc">{drawerItem.credit_code || '—'}</span>],
                  ['状态', renderStatus(drawerItem.status)],
                  ['创建时间', <span className="sc-mono" key="ct">{formatTime(drawerItem.create_time)}</span>],
                  ['更新时间', <span className="sc-mono" key="ut">{formatTime(drawerItem.update_time)}</span>],
                ]}
              />
            </DrawerSection>
          </div>
        )}
      </BdDrawer>

      <Modal
        title={editingItem ? '编辑客户' : '新增客户'}
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
              <Form.Item name="customer_code" label="客户编码" rules={[{ required: true }]}>
                <Input placeholder="如 CUS-B-0020（唯一）" disabled={!!editingItem} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="customer_name" label="客户名称" rules={[{ required: true }]}>
                <Input placeholder="如 XX 科技有限公司" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="customer_short" label="客户简称">
                <Input placeholder="用于表格 / 看板展示" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="customer_level" label="客户等级">
                <Select allowClear placeholder="请选择客户等级">
                  <Select.Option value="A">A 类</Select.Option>
                  <Select.Option value="B">B 类</Select.Option>
                  <Select.Option value="C">C 类</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="industry_type" label="所属行业">
                <Input placeholder="选填" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="credit_code" label="统一社会信用代码">
                <Input placeholder="18 位 · 选填" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="status" label="状态" valuePropName="checked" initialValue={true} extra="启用（停用后下单时不可选）">
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
