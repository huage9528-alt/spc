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
import BdDrawer, { DrawerSection, KvGrid } from './components/BdDrawer'
import { useBdTable } from './components/useBdTable'

interface Process {
  id: number
  process_code: string
  process_name: string
  process_group?: string | null
  standard_hour?: number | null
  work_center?: string | null
  is_qc_point: number
  description?: string | null
}

interface ProcessStats {
  total: number
  qc_points: number
  groups: number
  missing_standard_hour: number
  by_group: Record<string, number>
}

const GROUP_TAG_COLORS: Array<[string, string]> = [
  ['#4c4dc2', '#eef0fe'],
  ['#0284c7', '#f0f9ff'],
  ['#8b5cf6', '#f5f3ff'],
  ['#16a34a', '#f0fdf4'],
]

const groupColorIndex = (key: string) =>
  [...key].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % GROUP_TAG_COLORS.length

const renderGroupTag = (v?: string | null) => {
  if (!v) return <span className="sc-note">—</span>
  const [c, bg] = GROUP_TAG_COLORS[groupColorIndex(v)]
  return <span className="sc-tag" style={{ color: c, background: bg }}>{v}</span>
}

const renderQcFlag = (qc: number) =>
  qc === 1 ? (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center',
        color: '#16a34a', background: '#f0fdf4', border: '1px solid #bbf7d0',
        borderRadius: 4, padding: '0 6px', fontSize: 10.5, fontWeight: 700,
        letterSpacing: '.04em', lineHeight: '17px',
      }}
    >QC</span>
  ) : (
    <span className="sc-tag" style={{ color: '#94a3b8', background: '#f1f5f9' }}>—</span>
  )

const renderQcTag = (qc: number) =>
  qc === 1 ? (
    <span className="sc-tag" style={{ color: '#16a34a', background: '#f0fdf4' }}>质检点</span>
  ) : (
    <span className="sc-tag" style={{ color: '#94a3b8', background: '#f1f5f9' }}>非质检点</span>
  )

const renderHour = (v?: number | null) =>
  v === null || v === undefined ? (
    <span style={{ fontSize: 11, fontWeight: 600, color: '#d97706' }}>— 待补</span>
  ) : (
    <span className="sc-mono">{v}</span>
  )

const DELETE_CONFIRM = '确认删除该工序？若被产品工艺路线引用，删除后相关排产将无法计算工时。'

const FORM_NOTE = '未维护标准工时的工序无法参与产能推算与交期承诺计算，排产时将以红色提示。请尽量在工序启用前补全。'

const CSV_HEADER = ['工序编码', '工序名称', '分组', '工作中心', '标准工时', '质检点', '备注']

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const exportProcessesCsv = (rows: Process[], filename: string) => {
  if (rows.length === 0) return
  const lines = [
    CSV_HEADER,
    ...rows.map((r) => [
      r.process_code,
      r.process_name,
      r.process_group || '',
      r.work_center || '',
      r.standard_hour ?? '',
      r.is_qc_point === 1 ? '是' : '否',
      r.description || '',
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

export default function Processes() {
  const [stats, setStats] = useState<ProcessStats>({ total: 0, qc_points: 0, groups: 0, missing_standard_hour: 0, by_group: {} })
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<Process | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<Process | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  const [selectedMap, setSelectedMap] = useState<Record<number, Process>>({})
  const [searchText, setSearchText] = useState('')
  const [form] = Form.useForm()

  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data.processes', 'delete')

  const extraQuery = useCallback((chip: string | number | null): Record<string, any> => {
    if (chip === 'qc') return { is_qc_point: 1 }
    if (typeof chip === 'string' && chip.startsWith('group:')) return { process_group: chip.slice(6) }
    return {}
  }, [])

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<Process>({ url: '/basicdata/processes', extraQuery, chipInit: 'all' })

  const onSearchChange = (v: string) => {
    setSearchText(v)
    setKeywordInput(v)
  }

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/processes/stats')
      setStats({
        total: res.data?.total || 0,
        qc_points: res.data?.qc_points || 0,
        groups: res.data?.groups || 0,
        missing_standard_hour: res.data?.missing_standard_hour || 0,
        by_group: res.data?.by_group || {},
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

  const handleEdit = (item: Process) => {
    setEditingItem(item)
    form.resetFields()
    form.setFieldsValue({ ...item, is_qc_point: item.is_qc_point === 1 })
    setModalVisible(true)
  }

  const openDrawer = (item: Process) => {
    setDrawerItem(item)
    setDrawerOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/basicdata/processes/${id}`)
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
      const payload = { ...values, is_qc_point: values.is_qc_point ? 1 : 0 }
      if (editingItem) {
        await api.put(`/basicdata/processes/${editingItem.id}`, payload)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/processes', payload)
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
    selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is Process => r != null)

  const handleExportSelected = () => {
    exportProcessesCsv(getSelectedRows(), `工序主数据_${dayjs().format('YYYY-MM-DD')}.csv`)
  }

  const kpiItems: KpiItem[] = [
    { label: '工序总数', value: stats.total.toLocaleString(), sub: `质检点 ${stats.qc_points}`, accent: 'brand' },
    { label: '质检点', value: stats.qc_points.toLocaleString(), accent: 'success' },
    { label: '分组数', value: stats.groups.toLocaleString(), accent: 'info' },
    { label: '标准工时缺失', value: stats.missing_standard_hour.toLocaleString(), accent: 'warning' },
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    ...Object.entries(stats.by_group).slice(0, 6).map(([g, c]) => ({
      label: g, value: `group:${g}`, count: c,
    })),
    { label: '质检点', value: 'qc', count: stats.qc_points },
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[], rows: Process[]) => {
      setSelectedRowKeys(keys)
      const byKey = new Map(rows.map((r) => [r.id, r]))
      setSelectedMap((prev) => {
        const next: Record<number, Process> = {}
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

  const columns: TableColumnsType<Process> = [
    {
      title: '工序',
      dataIndex: 'process_code',
      key: 'process_code',
      width: 240,
      sorter: true,
      sortOrder: orderOf('process_code'),
      render: (_: any, record: Process) => (
        <div>
          <div className="sc-mat-name" style={{ cursor: 'pointer' }} onClick={() => openDrawer(record)}>
            {record.process_name}
          </div>
          <div className="sc-mat-code">{record.process_code}</div>
        </div>
      ),
    },
    {
      title: '分组',
      dataIndex: 'process_group',
      key: 'process_group',
      width: 110,
      sorter: true,
      sortOrder: orderOf('process_group'),
      render: (v: string) => renderGroupTag(v),
    },
    {
      title: '工作中心',
      dataIndex: 'work_center',
      key: 'work_center',
      width: 120,
      sorter: true,
      sortOrder: orderOf('work_center'),
      className: 'sc-mono',
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '标准工时 min',
      dataIndex: 'standard_hour',
      key: 'standard_hour',
      width: 120,
      align: 'right',
      render: (v: number | null) => renderHour(v),
    },
    {
      title: '质检点',
      dataIndex: 'is_qc_point',
      key: 'is_qc_point',
      width: 90,
      sorter: true,
      sortOrder: orderOf('is_qc_point'),
      render: (qc: number) => renderQcFlag(qc),
    },
    {
      title: '备注',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: any, record: Process) => (
        <span className="sc-row-act">
          <Button type="text" size="small" onClick={() => openDrawer(record)}>详情</Button>
          <PermButton permResource="basicdata.data.processes" permAction="update" type="text" size="small" onClick={() => handleEdit(record)}>编辑</PermButton>
          <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
            <PermButton permResource="basicdata.data.processes" permAction="delete" type="text" size="small" danger>删除</PermButton>
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
            placeholder="工序编码 / 名称 / 工作中心"
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
            onClick={() => exportProcessesCsv(items, `工序主数据_${dayjs().format('YYYY-MM-DD')}.csv`)}
          >
            导出
          </Button>
          <PermButton permResource="basicdata.data.processes" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增工序
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
          scroll={{ x: 1000 }}
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
        <Button size="small" icon={<ExportOutlined />} onClick={handleExportSelected}>导出所选 CSV</Button>
      </BatchBar>

      <BdDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={drawerItem?.process_name}
        code={drawerItem?.process_code}
        tags={drawerItem && (<>{renderGroupTag(drawerItem.process_group)}{renderQcTag(drawerItem.is_qc_point)}</>)}
        actions={drawerItem && (
          <>
            <PermButton permResource="basicdata.data.processes" permAction="update" type="primary" size="small" icon={<EditOutlined />} onClick={() => handleEdit(drawerItem)}>编辑</PermButton>
            <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(drawerItem.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
              <PermButton permResource="basicdata.data.processes" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
            </Popconfirm>
          </>
        )}
      >
        {drawerItem && (
          <div style={{ marginTop: 12 }}>
            <DrawerSection title="基本信息">
              <KvGrid
                items={[
                  ['分组', renderGroupTag(drawerItem.process_group)],
                  ['工作中心', <span className="sc-mono" key="wc">{drawerItem.work_center || '—'}</span>],
                  ['标准工时', renderHour(drawerItem.standard_hour)],
                  ['质检点', (
                    <span key="qc" style={{ color: drawerItem.is_qc_point === 1 ? '#16a34a' : '#94a3b8', fontWeight: drawerItem.is_qc_point === 1 ? 500 : 400 }}>
                      {drawerItem.is_qc_point === 1 ? '是' : '否'}
                    </span>
                  )],
                  ['描述', drawerItem.description || '—'],
                ]}
              />
            </DrawerSection>
          </div>
        )}
      </BdDrawer>

      <Modal
        title={editingItem ? '编辑工序' : '新增工序'}
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
              <Form.Item name="process_code" label="工序编码" rules={[{ required: true }]}>
                <Input placeholder="如 PR-210（唯一）" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="process_name" label="工序名称" rules={[{ required: true }]}>
                <Input placeholder="如 装箱封箱" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="process_group" label="工序分组">
                <Input placeholder="如 包装组" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="work_center" label="工作中心">
                <Input placeholder="如 PKG-01" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="standard_hour" label="标准工时（min / pcs）">
                <InputNumber style={{ width: '100%' }} step={0.01} min={0} placeholder="0.000" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="is_qc_point" label="质检点" valuePropName="checked" initialValue={false} extra="勾选后进入点检规则池">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="description" label="描述">
                <Input.TextArea placeholder="设备 / 治具 / 作业要求等" rows={3} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <div className="f-note" style={{ background: '#fffbeb', borderColor: '#fde68a', color: '#92400e' }}>{FORM_NOTE}</div>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
