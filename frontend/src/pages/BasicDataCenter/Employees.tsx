import { useCallback, useEffect, useState, type CSSProperties, type Key } from 'react'
import {
  Table, Button, Modal, Form, Input, Select, TreeSelect, Tag, message,
  Popconfirm, Row, Col, Tooltip, type TableColumnsType,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  SearchOutlined, ExportOutlined, UserOutlined,
} from '@ant-design/icons'
import { Link } from 'react-router-dom'
import dayjs from 'dayjs'
import api from '../../services/api'
import PermButton from '../../components/PermButton'
import { useAuthStore } from '../../store/auth'
import { EMPLOYEE_STATUS_OPTIONS, getEmployeeStatusMeta } from '../../constants/employeeStatus'
import KpiBand, { type KpiItem } from './components/KpiBand'
import ChipsFilter, { type ChipOption } from './components/ChipsFilter'
import BatchBar, { batchBarPad } from './components/BatchBar'
import BdDrawer, { DrawerSection, KvGrid } from './components/BdDrawer'
import { useBdTable } from './components/useBdTable'

interface Employee {
  id: number
  emp_code: string
  emp_name: string
  org_id: number
  position_id?: number
  position?: string
  position_name?: string
  oa_user_id?: string
  manager_oa_user_id?: string
  manager_name?: string
  phone?: string
  email?: string
  status: number
  create_time: string
}

interface Position {
  id: number
  position_code: string
  position_name: string
  status: number
}

interface OrgNode {
  id: number
  org_name: string
  org_type?: string | null
  parent_id?: number | null
  oa_org_id?: string | null
  children?: OrgNode[]
}

interface OrgInfo {
  org_name: string
  parentKey: string | null
}

interface OrgTreeSelectNode {
  value: number
  title: string
  children?: OrgTreeSelectNode[]
}

interface EmployeeStats {
  total: number
  by_status: Record<string, number>
}

const AVA_STYLE: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: '50%',
  flexShrink: 0,
  background: 'linear-gradient(135deg,#7a7de6,#8b5cf6)',
  color: '#fff',
  fontSize: 11,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const renderStatusTag = (status?: number | null) => {
  const meta = getEmployeeStatusMeta(status)
  return <Tag color={meta.color}>{meta.label}</Tag>
}

const DELETE_CONFIRM = '该员工名下存在未完结单据与系统账号时需先转移；人事离职建议改用「状态=离职」。确认删除该员工？'

const FORM_NOTE = '状态字典：0 试用 / 1 正式 / 2 临时 / 3 试用延期 / 4 解聘 / 5 离职 / 6 退休 / 7 无效。员工与组织人事数据以 OA 同步为主，手工新增的记录 OA 侧不覆盖。'

const CSV_HEADER = ['员工工号', '员工姓名', '所属组织', '岗位', '上级', '手机号', '邮箱', '状态']

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const flattenOrgTree = (
  nodes: OrgNode[],
  parentKey: string | null,
  byKey: Map<string, OrgInfo>,
  byInternal: Map<number, OrgInfo>,
) => {
  for (const n of nodes) {
    const key = String(n.oa_org_id || n.id)
    const info: OrgInfo = { org_name: n.org_name, parentKey }
    byKey.set(key, info)
    if (!byInternal.has(n.id)) byInternal.set(n.id, info)
    if (n.children?.length) flattenOrgTree(n.children, key, byKey, byInternal)
  }
}

const toOrgTreeData = (nodes: OrgNode[]): OrgTreeSelectNode[] =>
  nodes.map((n) => ({
    value: n.id,
    title: n.org_name,
    children: n.children?.length ? toOrgTreeData(n.children) : undefined,
  }))

export default function Employees() {
  const [stats, setStats] = useState<EmployeeStats>({ total: 0, by_status: {} })
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<Employee | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<Employee | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  const [selectedMap, setSelectedMap] = useState<Record<number, Employee>>({})
  const [batchOrgOpen, setBatchOrgOpen] = useState(false)
  const [batchOrgValue, setBatchOrgValue] = useState<number | null>(null)
  const [batchWorking, setBatchWorking] = useState(false)
  const [positions, setPositions] = useState<Position[]>([])
  const [orgByKey, setOrgByKey] = useState<Map<string, OrgInfo>>(new Map())
  const [orgByInternal, setOrgByInternal] = useState<Map<number, OrgInfo>>(new Map())
  const [orgTreeData, setOrgTreeData] = useState<OrgTreeSelectNode[]>([])
  const [searchText, setSearchText] = useState('')
  const [form] = Form.useForm()

  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data.employees', 'delete')

  const extraQuery = useCallback((chip: string | number | null): Record<string, any> => {
    if (chip === 'formal') return { status: '1' }
    if (chip === 'trial') return { status: '0,3' }
    if (chip === 'temp') return { status: '2' }
    if (chip === 'out') return { status: '4,5,6,7' }
    return {}
  }, [])

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<Employee>({ url: '/basicdata/employees', extraQuery, chipInit: 'all' })

  const onSearchChange = (v: string) => {
    setSearchText(v)
    setKeywordInput(v)
  }

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/employees/stats')
      setStats({ total: res.data?.total || 0, by_status: res.data?.by_status || {} })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  useEffect(() => {
    const fetchOrgTree = async () => {
      try {
        const res: any = await api.get('/basicdata/organizations/tree')
        const roots: OrgNode[] = res.data || []
        const byKey = new Map<string, OrgInfo>()
        const byInternal = new Map<number, OrgInfo>()
        flattenOrgTree(roots, null, byKey, byInternal)
        setOrgByKey(byKey)
        setOrgByInternal(byInternal)
        setOrgTreeData(toOrgTreeData(roots))
      } catch {
        // 错误已由全局拦截器提示
      }
    }
    fetchOrgTree()
  }, [])

  useEffect(() => {
    const fetchPositions = async () => {
      try {
        const res: any = await api.get('/basicdata/positions', { params: { page: 1, page_size: 100, status: '1' } })
        setPositions(res.data?.items || [])
      } catch {
        // 错误已由全局拦截器提示
      }
    }
    fetchPositions()
  }, [])

  const refreshAll = useCallback(() => {
    reload()
    fetchStats()
  }, [reload, fetchStats])

  const clearSelection = () => {
    setSelectedRowKeys([])
    setSelectedMap({})
  }

  const resolveOrg = (orgId?: number | null): OrgInfo | undefined =>
    orgId == null ? undefined : orgByInternal.get(orgId) ?? orgByKey.get(String(orgId))

  const renderOrgPath = (orgId?: number | null) => {
    if (orgId == null) return <span className="sc-note">—</span>
    const info = resolveOrg(orgId)
    if (!info) return <span className="sc-mono">#{orgId}</span>
    const parent = info.parentKey ? orgByKey.get(info.parentKey) : undefined
    return (
      <div>
        {parent && <div style={{ fontSize: 11, color: '#94a3b8' }}>{parent.org_name}</div>}
        <div>{info.org_name}</div>
      </div>
    )
  }

  const buildOrgCrumb = (orgId?: number | null): string[] => {
    if (orgId == null) return []
    const names: string[] = []
    let cur = resolveOrg(orgId)
    let guard = 0
    while (cur && guard < 20) {
      names.unshift(cur.org_name)
      if (!cur.parentKey) break
      const parent = orgByKey.get(cur.parentKey)
      if (!parent) break
      cur = parent
      guard += 1
    }
    return names
  }

  const handleAdd = () => {
    setEditingItem(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (item: Employee) => {
    setEditingItem(item)
    form.resetFields()
    form.setFieldsValue(item)
    setModalVisible(true)
  }

  const openDrawer = (item: Employee) => {
    setDrawerItem(item)
    setDrawerOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/basicdata/employees/${id}`)
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
        await api.put(`/basicdata/employees/${editingItem.id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/employees', values)
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
    selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is Employee => r != null)

  const handleBatchOrg = async () => {
    if (!batchOrgValue) {
      message.warning('请选择目标组织')
      return
    }
    const rows = getSelectedRows()
    if (rows.length === 0) return
    setBatchWorking(true)
    const results = await Promise.allSettled(
      rows.map((r) => api.put(`/basicdata/employees/${r.id}`, { org_id: batchOrgValue })),
    )
    setBatchWorking(false)
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    const failCount = results.length - okCount
    if (failCount === 0) message.success(`已调整 ${okCount} 人`)
    else message.warning(`成功 ${okCount} 项，失败 ${failCount} 项`)
    setBatchOrgOpen(false)
    setBatchOrgValue(null)
    clearSelection()
    refreshAll()
  }

  const exportEmployeesCsv = (rows: Employee[], filename: string) => {
    if (rows.length === 0) return
    const lines = [
      CSV_HEADER,
      ...rows.map((r) => [
        r.emp_code,
        r.emp_name,
        resolveOrg(r.org_id)?.org_name ?? (r.org_id != null ? String(r.org_id) : ''),
        r.position_name || r.position || '',
        r.manager_name || '',
        r.phone || '',
        r.email || '',
        getEmployeeStatusMeta(r.status).label,
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

  const formalCount = stats.by_status['1'] || 0
  const trialCount = (stats.by_status['0'] || 0) + (stats.by_status['3'] || 0)
  const tempCount = stats.by_status['2'] || 0
  const outCount = ['2', '4', '5', '6', '7'].reduce((s, k) => s + (stats.by_status[k] || 0), 0)

  const kpiItems: KpiItem[] = [
    { label: '员工总数', value: stats.total.toLocaleString(), accent: 'brand' },
    { label: '正式', value: formalCount.toLocaleString(), go: '查看 →', accent: 'success', onClick: () => setChip('formal') },
    { label: '试用 / 延期', value: trialCount.toLocaleString(), go: '查看 →', accent: 'warning', onClick: () => setChip('trial') },
    { label: '非在编', value: outCount.toLocaleString(), go: '查看 →', accent: 'gray', onClick: () => setChip('out') },
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    { label: '正式', value: 'formal', count: formalCount },
    { label: '试用·延期', value: 'trial', count: trialCount },
    { label: '临时', value: 'temp', count: tempCount },
    { label: '非在编', value: 'out', count: ['4', '5', '6', '7'].reduce((s, k) => s + (stats.by_status[k] || 0), 0) },
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[], rows: Employee[]) => {
      setSelectedRowKeys(keys)
      const byKey = new Map(rows.map((r) => [r.id, r]))
      setSelectedMap((prev) => {
        const next: Record<number, Employee> = {}
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

  const columns: TableColumnsType<Employee> = [
    {
      title: '员工',
      dataIndex: 'emp_code',
      key: 'emp_code',
      width: 200,
      sorter: true,
      sortOrder: orderOf('emp_code'),
      render: (_: any, record: Employee) => (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={AVA_STYLE}>{(record.emp_name || '?').charAt(0)}</span>
            <span className="sc-mat-name" style={{ cursor: 'pointer' }} onClick={() => openDrawer(record)}>
              {record.emp_name}
            </span>
          </div>
          <div className="sc-mat-code">{record.emp_code}</div>
        </div>
      ),
    },
    {
      title: '组织路径',
      dataIndex: 'org_id',
      key: 'org_id',
      width: 220,
      sorter: true,
      sortOrder: orderOf('org_id'),
      render: (_: any, record: Employee) => renderOrgPath(record.org_id),
    },
    {
      title: '岗位',
      dataIndex: 'position',
      key: 'position',
      width: 150,
      ellipsis: true,
      sorter: true,
      sortOrder: orderOf('position'),
      render: (_: any, record: Employee) => record.position_name || record.position || <span className="sc-note">—</span>,
    },
    {
      title: '上级',
      dataIndex: 'manager_name',
      key: 'manager_name',
      width: 120,
      ellipsis: true,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '手机号',
      dataIndex: 'phone',
      key: 'phone',
      width: 130,
      className: 'sc-mono',
      sorter: true,
      sortOrder: orderOf('phone'),
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      sorter: true,
      sortOrder: orderOf('status'),
      render: (status: number) => renderStatusTag(status),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: any, record: Employee) => (
        <span className="sc-row-act">
          <Button type="text" size="small" onClick={() => openDrawer(record)}>详情</Button>
          <PermButton permResource="basicdata.data.employees" permAction="update" type="text" size="small" onClick={() => handleEdit(record)}>编辑</PermButton>
          <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
            <PermButton permResource="basicdata.data.employees" permAction="delete" type="text" size="small" danger>删除</PermButton>
          </Popconfirm>
        </span>
      ),
    },
  ]

  const drawerCrumb = buildOrgCrumb(drawerItem?.org_id)

  return (
    <div className="sc-page" style={{ paddingBottom: batchBarPad(selectedRowKeys.length) }}>
      <KpiBand items={kpiItems} />

      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="员工姓名 / 工号"
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
            onClick={() => exportEmployeesCsv(items, `员工主数据_${dayjs().format('YYYY-MM-DD')}.csv`)}
          >
            导出
          </Button>
          <PermButton permResource="basicdata.data.employees" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增员工
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
        <PermButton permResource="basicdata.data.employees" permAction="update" size="small" disabled={batchWorking} onClick={() => setBatchOrgOpen(true)}>批量调整组织</PermButton>
        <Button size="small" icon={<ExportOutlined />} onClick={() => exportEmployeesCsv(getSelectedRows(), `员工主数据_${dayjs().format('YYYY-MM-DD')}.csv`)}>导出所选</Button>
      </BatchBar>

      <BdDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={drawerItem?.emp_name}
        code={drawerItem?.emp_code}
        tags={drawerItem && (
          <>
            {renderStatusTag(drawerItem.status)}
            {drawerItem.oa_user_id && (
              <Tag style={{ color: '#64748b', background: '#f1f5f9', borderColor: '#e2e8f0' }}>OA {drawerItem.oa_user_id}</Tag>
            )}
          </>
        )}
        actions={drawerItem && (
          <>
            <PermButton permResource="basicdata.data.employees" permAction="update" type="primary" size="small" icon={<EditOutlined />} onClick={() => handleEdit(drawerItem)}>编辑</PermButton>
            <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(drawerItem.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
              <PermButton permResource="basicdata.data.employees" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
            </Popconfirm>
            <Link to="/users">
              <Button size="small" icon={<UserOutlined />}>关联系统账号</Button>
            </Link>
          </>
        )}
      >
        {drawerItem && (
          <div style={{ marginTop: 12 }}>
            <DrawerSection title="基本信息">
              <KvGrid
                items={[
                  ['手机号', <span className="sc-mono" key="ph">{drawerItem.phone || '—'}</span>],
                  ['邮箱', drawerItem.email || '—'],
                  ['岗位', drawerItem.position_name || drawerItem.position || '—'],
                  ['状态', renderStatusTag(drawerItem.status)],
                ]}
              />
            </DrawerSection>
            <DrawerSection title="组织与汇报">
              <div style={{ marginBottom: 10, fontSize: 13, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                {drawerCrumb.length > 0 ? drawerCrumb.map((name, i) => (
                  <span key={i} style={i === drawerCrumb.length - 1 ? { fontWeight: 600 } : { color: '#64748b' }}>
                    {i > 0 && <span style={{ color: '#cbd5e1', margin: '0 2px' }}>›</span>}
                    {name}
                  </span>
                )) : drawerItem.org_id != null ? <span className="sc-mono">#{drawerItem.org_id}</span> : <span className="sc-note">—</span>}
              </div>
              <KvGrid
                items={[
                  ['直属上级', drawerItem.manager_name || '—'],
                  ['OA 用户 ID', drawerItem.oa_user_id ? <span className="sc-mono" key="oa">{drawerItem.oa_user_id}</span> : '—'],
                ]}
              />
            </DrawerSection>
          </div>
        )}
      </BdDrawer>

      <Modal
        title={editingItem ? '编辑员工' : '新增员工'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={680}
        rootClassName="sc-page"
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="emp_code" label="员工工号" rules={[{ required: true }]}>
                <Input placeholder="如 EMP0520（唯一）" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="emp_name" label="员工姓名" rules={[{ required: true }]}>
                <Input placeholder="如 张三" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="org_id" label="所属组织" rules={[{ required: true }]}>
                <TreeSelect
                  allowClear
                  showSearch
                  treeDefaultExpandAll
                  treeNodeFilterProp="title"
                  treeData={orgTreeData}
                  placeholder="请选择所属组织"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="position_id" label="岗位">
                <Select
                  allowClear
                  showSearch
                  placeholder="请选择岗位"
                  optionFilterProp="label"
                  options={positions.map(position => ({
                    value: position.id,
                    label: `${position.position_name} (${position.position_code})`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="manager_oa_user_id" label="上级人员">
                <Select
                  allowClear
                  showSearch
                  placeholder="请选择上级人员"
                  optionFilterProp="label"
                  options={items
                    .filter(emp => emp.emp_code)
                    .map(emp => ({
                      value: emp.oa_user_id || emp.emp_code,
                      label: `${emp.emp_name} (${emp.emp_code})`,
                    }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="phone" label="手机号">
                <Input placeholder="选填" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="email" label="邮箱">
                <Input placeholder="选填" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="状态" initialValue={1}>
                <Select placeholder="请选择状态">
                  {EMPLOYEE_STATUS_OPTIONS.map(option => (
                    <Select.Option key={option.value} value={option.value}>{option.label}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={24}>
              <div className="f-note">{FORM_NOTE}</div>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title="批量调整组织"
        open={batchOrgOpen}
        onOk={handleBatchOrg}
        onCancel={() => { setBatchOrgOpen(false); setBatchOrgValue(null) }}
        okText="调整"
        cancelText="取消"
        width={420}
        rootClassName="sc-page"
        confirmLoading={batchWorking}
      >
        <div style={{ marginBottom: 8, fontSize: 12, color: '#64748b' }}>将所选 {selectedRowKeys.length} 名员工调整至目标组织</div>
        <TreeSelect
          style={{ width: '100%' }}
          allowClear
          showSearch
          treeDefaultExpandAll
          treeNodeFilterProp="title"
          treeData={orgTreeData}
          value={batchOrgValue ?? undefined}
          onChange={(v) => setBatchOrgValue(v ?? null)}
          placeholder="请选择目标组织"
        />
      </Modal>
    </div>
  )
}
