import { useCallback, useEffect, useMemo, useState, type CSSProperties, type Key } from 'react'
import {
  Tree, Table, Button, Modal, Form, Input, Select, InputNumber, message,
  Popconfirm, Row, Col, Tag, Segmented, Spin, Tooltip, type TableColumnsType,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, UserOutlined,
  SearchOutlined, TeamOutlined,
} from '@ant-design/icons'
import type { DataNode } from 'antd/es/tree'
import api from '../../services/api'
import PermButton from '../../components/PermButton'
import { useAuthStore } from '../../store/auth'
import { EMPLOYEE_STATUS_OPTIONS, getEmployeeStatusMeta } from '../../constants/employeeStatus'
import KpiBand, { type KpiItem } from './components/KpiBand'

interface Organization {
  id: number
  org_code: string
  org_name: string
  org_type: string
  parent_id?: number
  leader_id?: number
  leader_name?: string
  status: number
}

interface OrganizationTreeNode {
  id: number
  org_code: string
  org_name: string
  org_type: string
  parent_id?: number
  leader_id?: number
  leader_name?: string
  oa_org_id?: string
  status: number
  data_source?: string
  children: OrganizationTreeNode[]
}

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

interface OrgStats {
  total: number
  by_type: Record<string, number>
  missing_leader: number
}

type ScopeMode = 'self' | 'sub'

const SUB_ORG_CAP = 20

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

const ORG_TYPE_STYLES: Record<string, CSSProperties> = {
  公司: { color: '#fff', background: '#334155' },
  部门: { color: '#4c4dc2', background: '#eef0fe' },
  车间: { color: '#0284c7', background: '#f0f9ff' },
  班组: { color: '#8b5cf6', background: '#f5f3ff' },
}
const ORG_TYPE_FALLBACK: CSSProperties = { color: '#64748b', background: '#f1f5f9' }
const LEADER_TAG_STYLE: CSSProperties = { color: '#16a34a', background: '#f0fdf4' }
const DISABLED_TAG_STYLE: CSSProperties = { color: '#94a3b8', background: '#f1f5f9' }

const ORG_FORM_NOTE = 'OA 同步的组织（oa_org_id 非空）其层级关系由 OA 侧维护，本系统仅在 OA 未覆盖的班组粒度允许手工新增。删除组织前需先转移其名下员工。'

const TREE_FOOT_NOTE = '组织树以 OA 同步为主（树 key 优先使用 oa_org_id）；点击节点查看右侧行下员工'

const ORG_DELETE_CONFIRM = '名下员工需先转移，建议改用「禁用」'

const orgTypeTag = (type?: string | null) => (
  <span className="sc-tag" style={ORG_TYPE_STYLES[type || ''] || ORG_TYPE_FALLBACK}>{type || '未知'}</span>
)

const renderTreeTitle = (node: OrganizationTreeNode) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
      {node.org_name}
    </span>
    {orgTypeTag(node.org_type)}
    {node.leader_name && (
      <span className="sc-tag" style={LEADER_TAG_STYLE}>负责人 · {node.leader_name}</span>
    )}
    {node.status === 0 && <span className="sc-tag" style={DISABLED_TAG_STYLE}>已禁用</span>}
  </div>
)

const convertToTreeData = (nodes: OrganizationTreeNode[]): DataNode[] => {
  if (!nodes || !Array.isArray(nodes)) {
    return []
  }
  return nodes.map(node => {
    const childNodes = node.children && node.children.length > 0
      ? convertToTreeData(node.children)
      : undefined
    return {
      title: renderTreeTitle(node),
      key: String(node.oa_org_id || node.id),
      children: childNodes,
    }
  })
}

const findOrgByKey = (nodes: OrganizationTreeNode[], key: string): OrganizationTreeNode | null => {
  for (const node of nodes) {
    const nodeKey = String(node.oa_org_id || node.id)
    if (nodeKey === key) {
      return node
    }
    if (node.children && node.children.length > 0) {
      const found = findOrgByKey(node.children, key)
      if (found) {
        return found
      }
    }
  }
  return null
}

const findPathByKey = (nodes: OrganizationTreeNode[], key: string): OrganizationTreeNode[] => {
  for (const node of nodes) {
    const nodeKey = String(node.oa_org_id || node.id)
    if (nodeKey === key) {
      return [node]
    }
    if (node.children && node.children.length > 0) {
      const sub = findPathByKey(node.children, key)
      if (sub.length > 0) {
        return [node, ...sub]
      }
    }
  }
  return []
}

const collectAllKeys = (nodes: OrganizationTreeNode[]): Key[] => {
  const keys: Key[] = []
  const walk = (list: OrganizationTreeNode[]) => {
    for (const n of list) {
      keys.push(String(n.oa_org_id || n.id))
      if (n.children && n.children.length > 0) walk(n.children)
    }
  }
  walk(nodes)
  return keys
}

const collectDescendantQueryIds = (node: OrganizationTreeNode): string[] => {
  const out: string[] = []
  const walk = (n: OrganizationTreeNode) => {
    for (const child of n.children || []) {
      out.push(String(child.oa_org_id || child.id))
      walk(child)
    }
  }
  walk(node)
  return out
}

const filterTreeNodes = (nodes: OrganizationTreeNode[], kw: string): OrganizationTreeNode[] => {
  const out: OrganizationTreeNode[] = []
  for (const node of nodes) {
    const children = node.children && node.children.length > 0 ? filterTreeNodes(node.children, kw) : []
    const selfMatch =
      (node.org_name || '').toLowerCase().includes(kw) ||
      (node.org_code || '').toLowerCase().includes(kw)
    if (selfMatch || children.length > 0) {
      out.push({ ...node, ...(children.length > 0 ? { children } : {}) })
    }
  }
  return out
}

export default function Organizations() {
  const [stats, setStats] = useState<OrgStats>({ total: 0, by_type: {}, missing_leader: 0 })
  const [rawTreeData, setRawTreeData] = useState<OrganizationTreeNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [treeKeyword, setTreeKeyword] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([])
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null)
  const [selectedOrg, setSelectedOrg] = useState<OrganizationTreeNode | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeesLoading, setEmployeesLoading] = useState(false)
  const [positions, setPositions] = useState<Position[]>([])
  const [scope, setScope] = useState<ScopeMode>('self')
  const [empKeywordInput, setEmpKeywordInput] = useState('')
  const [empKeyword, setEmpKeyword] = useState('')

  const [orgModalVisible, setOrgModalVisible] = useState(false)
  const [editingOrg, setEditingOrg] = useState<OrganizationTreeNode | null>(null)
  const [orgForm] = Form.useForm()

  const [empModalVisible, setEmpModalVisible] = useState(false)
  const [editingEmp, setEditingEmp] = useState<Employee | null>(null)
  const [empForm] = Form.useForm()

  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data.organizations', 'delete')

  const fetchTreeData = useCallback(async () => {
    setTreeLoading(true)
    try {
      const res: any = await api.get('/basicdata/organizations/tree')
      const data = res.data || []
      ;(window as any).lastOrgTreeData = data
      setRawTreeData(data)
    } catch (error) {
      // 错误已由全局拦截器提示
    } finally {
      setTreeLoading(false)
    }
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/organizations/stats')
      setStats({
        total: res.data?.total || 0,
        by_type: res.data?.by_type || {},
        missing_leader: res.data?.missing_leader || 0,
      })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  useEffect(() => {
    fetchTreeData()
    fetchStats()
  }, [fetchTreeData, fetchStats])

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

  const displayTreeData = useMemo(() => {
    const kw = treeKeyword.trim().toLowerCase()
    const source = kw ? filterTreeNodes(rawTreeData, kw) : rawTreeData
    return convertToTreeData(source)
  }, [rawTreeData, treeKeyword])

  useEffect(() => {
    const kw = treeKeyword.trim().toLowerCase()
    const base = kw ? filterTreeNodes(rawTreeData, kw) : rawTreeData
    setExpandedKeys(collectAllKeys(base))
  }, [rawTreeData, treeKeyword])

  const getOrgEmployeeQueryId = (org: OrganizationTreeNode | null, fallback?: string | null) => {
    return org?.oa_org_id || org?.id || fallback || null
  }

  const loadEmployees = async (
    org: OrganizationTreeNode | null,
    key: string | null,
    sc: ScopeMode,
    kw: string,
  ) => {
    const queryId = getOrgEmployeeQueryId(org, key)
    if (!org || !queryId) {
      setEmployees([])
      return
    }
    setEmployeesLoading(true)
    try {
      if (sc === 'sub') {
        const tree: OrganizationTreeNode[] = (window as any).lastOrgTreeData || []
        const node = findOrgByKey(tree, String(key || ''))
        const ids = [String(queryId)]
        if (node) ids.push(...collectDescendantQueryIds(node))
        const capped = ids.slice(0, SUB_ORG_CAP)
        if (ids.length > SUB_ORG_CAP) {
          message.warning(`子组织较多，仅查询前 ${SUB_ORG_CAP} 个组织（含本级）`)
        }
        const results = await Promise.all(
          capped.map(id =>
            api.get(`/basicdata/organizations/${id}/employees`, kw ? { params: { keyword: kw } } : undefined).catch(() => null),
          ),
        )
        const byId = new Map<number, Employee>()
        for (const res of results) {
          for (const item of ((res as any)?.data?.items || []) as Employee[]) {
            byId.set(item.id, item)
          }
        }
        setEmployees(
          [...byId.values()].sort((a, b) => String(a.emp_code).localeCompare(String(b.emp_code))),
        )
      } else {
        const res: any = await api.get(
          `/basicdata/organizations/${queryId}/employees`,
          kw ? { params: { keyword: kw } } : undefined,
        )
        setEmployees(res.data?.items || [])
      }
    } catch (error) {
      // 错误已由全局拦截器提示
    } finally {
      setEmployeesLoading(false)
    }
  }

  const handleOrgSelect = (selectedKeys: Key[]) => {
    if (selectedKeys.length > 0) {
      const orgId = String(selectedKeys[0])
      setSelectedOrgId(orgId)
      const orgTreeData = (window as any).lastOrgTreeData || []
      const org = findOrgByKey(orgTreeData, orgId)
      setSelectedOrg(org)
      loadEmployees(org, orgId, scope, empKeyword)
    } else {
      setSelectedOrgId(null)
      setSelectedOrg(null)
      setEmployees([])
    }
  }

  const handleScopeChange = (value: ScopeMode) => {
    setScope(value)
    loadEmployees(selectedOrg, selectedOrgId, value, empKeyword)
  }

  const onEmpSearchChange = (v: string) => {
    setEmpKeywordInput(v)
    if (v === '' && empKeyword !== '') {
      setEmpKeyword('')
      loadEmployees(selectedOrg, selectedOrgId, scope, '')
    }
  }

  const commitEmpKeyword = () => {
    setEmpKeyword(empKeywordInput)
    loadEmployees(selectedOrg, selectedOrgId, scope, empKeywordInput)
  }

  const handleAddOrg = () => {
    setEditingOrg(null)
    orgForm.resetFields()
    if (selectedOrg) {
      orgForm.setFieldsValue({ parent_id: selectedOrg.id })
    }
    setOrgModalVisible(true)
  }

  const handleEditOrg = (org: OrganizationTreeNode) => {
    setEditingOrg(org)
    orgForm.setFieldsValue(org)
    setOrgModalVisible(true)
  }

  const handleDeleteOrg = async (id: number) => {
    try {
      await api.delete(`/basicdata/organizations/${id}`)
      message.success('删除成功')
      fetchTreeData()
      fetchStats()
      if (selectedOrg?.id === id) {
        setSelectedOrgId(null)
        setSelectedOrg(null)
        setEmployees([])
      }
    } catch (error) {
      // 错误已由全局拦截器提示
    }
  }

  const handleOrgSubmit = async () => {
    try {
      const values = await orgForm.validateFields()
      if (editingOrg) {
        await api.put(`/basicdata/organizations/${editingOrg.id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/organizations', values)
        message.success('创建成功')
      }
      setOrgModalVisible(false)
      orgForm.resetFields()
      fetchTreeData()
      fetchStats()
    } catch (error) {
      // 错误已由全局拦截器提示
    }
  }

  const handleAddEmp = () => {
    setEditingEmp(null)
    empForm.resetFields()
    if (selectedOrg) {
      empForm.setFieldsValue({ org_id: getOrgEmployeeQueryId(selectedOrg) })
    }
    setEmpModalVisible(true)
  }

  const handleEditEmp = (emp: Employee) => {
    setEditingEmp(emp)
    empForm.setFieldsValue(emp)
    setEmpModalVisible(true)
  }

  const handleEmpSubmit = async () => {
    try {
      const values = await empForm.validateFields()
      if (editingEmp) {
        await api.put(`/basicdata/employees/${editingEmp.id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/employees', values)
        message.success('创建成功')
      }
      setEmpModalVisible(false)
      empForm.resetFields()
      loadEmployees(selectedOrg, selectedOrgId, scope, empKeyword)
    } catch (error) {
      // 错误已由全局拦截器提示
    }
  }

  const crumbPath = useMemo(
    () => (selectedOrgId ? findPathByKey(rawTreeData, selectedOrgId) : []),
    [selectedOrgId, rawTreeData],
  )

  const deptCount = stats.by_type['部门'] || 0
  const workshopCount = (stats.by_type['车间'] || 0) + (stats.by_type['班组'] || 0)

  const kpiItems: KpiItem[] = [
    { label: '组织总数', value: stats.total.toLocaleString(), sub: 'OA 同步为主', accent: 'brand' },
    { label: '部门', value: deptCount.toLocaleString(), accent: 'info' },
    { label: '车间 · 班组', value: workshopCount.toLocaleString(), accent: 'purple' },
    { label: '空缺负责人', value: stats.missing_leader.toLocaleString(), accent: 'warning' },
  ]

  const employeeColumns: TableColumnsType<Employee> = [
    {
      title: '员工',
      dataIndex: 'emp_code',
      key: 'emp_code',
      width: 200,
      render: (_: any, record: Employee) => (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={AVA_STYLE}>{(record.emp_name || '?').charAt(0)}</span>
            <span className="sc-mat-name">{record.emp_name}</span>
          </div>
          <div className="sc-mat-code">{record.emp_code}</div>
        </div>
      ),
    },
    {
      title: '岗位',
      dataIndex: 'position_name',
      key: 'position_name',
      width: 150,
      ellipsis: true,
      render: (_: any, record: Employee) => record.position_name || record.position || <span className="sc-note">—</span>,
    },
    {
      title: '上级',
      dataIndex: 'manager_name',
      key: 'manager_name',
      width: 110,
      ellipsis: true,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '手机号',
      dataIndex: 'phone',
      key: 'phone',
      width: 130,
      className: 'sc-mono',
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: number) => {
        const meta = getEmployeeStatusMeta(status)
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      fixed: 'right' as const,
      render: (_: any, record: Employee) => (
        <span className="sc-row-act">
          <PermButton
            permResource="basicdata.data.organizations"
            permAction="update"
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEditEmp(record)}
          >
            编辑
          </PermButton>
        </span>
      ),
    },
  ]

  return (
    <div
      className="sc-page"
      style={{ height: 'calc(100vh - 72px - 12px - 24px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <KpiBand items={kpiItems} />

      <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', gap: 12, flex: 1, minHeight: 0 }}>
        <div className="sc-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="sc-search" style={{ flex: 1, minWidth: 0 }}>
              <Input
                allowClear
                prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                placeholder="搜索组织名称 / 编码"
                value={treeKeyword}
                onChange={(e) => setTreeKeyword(e.target.value)}
              />
            </span>
            <Tooltip title="新增组织">
              <PermButton
                permResource="basicdata.data.organizations"
                permAction="create"
                icon={<PlusOutlined />}
                onClick={handleAddOrg}
              />
            </Tooltip>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 6px' }}>
            {treeLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                <Spin />
              </div>
            ) : (
              <Tree
                className="org-scope-tree"
                blockNode
                showLine
                treeData={displayTreeData}
                selectedKeys={selectedOrgId ? [selectedOrgId] : []}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                onSelect={handleOrgSelect}
              />
            )}
          </div>
          <div className="org-pane-note">{TREE_FOOT_NOTE}</div>
        </div>

        <div className="sc-card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {selectedOrg && selectedOrgId ? (
            <>
              <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 16, fontWeight: 650 }}>{selectedOrg.org_name}</span>
                  {orgTypeTag(selectedOrg.org_type)}
                  {selectedOrg.leader_name && (
                    <span className="sc-tag" style={LEADER_TAG_STYLE}>负责人 · {selectedOrg.leader_name}</span>
                  )}
                  {selectedOrg.status === 0 && <span className="sc-tag" style={DISABLED_TAG_STYLE}>已禁用</span>}
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <PermButton
                      permResource="basicdata.data.organizations"
                      permAction="update"
                      icon={<EditOutlined />}
                      onClick={() => handleEditOrg(selectedOrg)}
                    >
                      编辑组织
                    </PermButton>
                    <PermButton
                      permResource="basicdata.data.organizations"
                      permAction="create"
                      icon={<PlusOutlined />}
                      onClick={handleAddOrg}
                    >
                      新增下级
                    </PermButton>
                    <Popconfirm
                      title={ORG_DELETE_CONFIRM}
                      onConfirm={() => handleDeleteOrg(selectedOrg.id)}
                      okText="确认"
                      cancelText="取消"
                      disabled={!canDelete}
                    >
                      <PermButton
                        permResource="basicdata.data.organizations"
                        permAction="delete"
                        danger
                        icon={<DeleteOutlined />}
                      />
                    </Popconfirm>
                    <PermButton
                      permResource="basicdata.data.organizations"
                      permAction="create"
                      type="primary"
                      icon={<UserOutlined />}
                      onClick={handleAddEmp}
                    >
                      新增员工
                    </PermButton>
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 6,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexWrap: 'wrap',
                    fontSize: 12,
                    color: '#94a3b8',
                  }}
                >
                  {crumbPath.length > 0 ? (
                    crumbPath.map((n, i) => (
                      <span key={`${n.id}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {i > 0 && <span style={{ color: '#cbd5e1' }}>›</span>}
                        <span style={i === crumbPath.length - 1 ? { fontWeight: 600, color: '#475569' } : undefined}>
                          {n.org_name}
                        </span>
                      </span>
                    ))
                  ) : (
                    <span className="sc-mono">{selectedOrgId}</span>
                  )}
                  <span style={{ color: '#cbd5e1' }}>·</span>
                  <span className="sc-mono">ORG-{selectedOrg.id}</span>
                  <span>下辖 {employees.length} 人</span>
                </div>
              </div>

              <div
                style={{
                  padding: '8px 16px',
                  borderBottom: '1px solid #f1f5f9',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span className="sc-search">
                  <Input
                    allowClear
                    prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                    placeholder="姓名 / 工号"
                    style={{ width: 220 }}
                    value={empKeywordInput}
                    onChange={(e) => onEmpSearchChange(e.target.value)}
                    onPressEnter={commitEmpKeyword}
                  />
                </span>
                <Segmented
                  value={scope}
                  onChange={(v) => handleScopeChange(v as ScopeMode)}
                  options={[
                    { label: '本级', value: 'self' },
                    { label: '含子组织', value: 'sub' },
                  ]}
                />
                {scope === 'sub' && (
                  <span className="sc-note">合并去重，最多查询前 {SUB_ORG_CAP} 个组织（含本级）</span>
                )}
                <span style={{ marginLeft: 'auto' }}>
                  <Tooltip title="刷新">
                    <Button
                      icon={<ReloadOutlined />}
                      onClick={() => loadEmployees(selectedOrg, selectedOrgId, scope, empKeyword)}
                    />
                  </Tooltip>
                </span>
              </div>

              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <Table
                  rowKey="id"
                  columns={employeeColumns}
                  dataSource={employees}
                  loading={employeesLoading}
                  size="small"
                  scroll={{ x: 780 }}
                  pagination={{
                    pageSize: 20,
                    showSizeChanger: true,
                    showTotal: (t: number) => `共 ${t} 人`,
                    pageSizeOptions: ['20', '50', '100'],
                  }}
                />
              </div>
            </>
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: '#94a3b8',
              }}
            >
              <TeamOutlined style={{ fontSize: 36 }} />
              <span>在左侧选择组织节点，查看该组织下的员工</span>
            </div>
          )}
        </div>
      </div>

      <Modal
        title={editingOrg ? '编辑组织' : '新增组织'}
        open={orgModalVisible}
        onOk={handleOrgSubmit}
        onCancel={() => setOrgModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={600}
        rootClassName="sc-page"
      >
        <Form form={orgForm} layout="vertical" initialValues={{ status: 1 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="org_code" label="组织编码" rules={[{ required: true }]}>
                <Input placeholder="请输入组织编码" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="org_name" label="组织名称" rules={[{ required: true }]}>
                <Input placeholder="请输入组织名称" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="org_type" label="组织类型" rules={[{ required: true }]}>
                <Select
                  placeholder="请选择组织类型"
                  options={[
                    { value: '部门', label: '部门' },
                    { value: '车间', label: '车间' },
                    { value: '班组', label: '班组' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="parent_id" label="父级组织ID">
                <InputNumber style={{ width: '100%' }} placeholder="请输入父级组织ID" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="leader_id" label="负责人ID">
                <InputNumber style={{ width: '100%' }} placeholder="请输入负责人ID" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="状态" initialValue={1}>
                <Select
                  options={[
                    { value: 1, label: '启用' },
                    { value: 0, label: '禁用' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={24}>
              <div className="f-note">{ORG_FORM_NOTE}</div>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title={editingEmp ? '编辑员工' : '新增员工'}
        open={empModalVisible}
        onOk={handleEmpSubmit}
        onCancel={() => setEmpModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={680}
        rootClassName="sc-page"
      >
        <Form form={empForm} layout="vertical" initialValues={{ status: 1 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="emp_code" label="员工工号" rules={[{ required: true }]}>
                <Input placeholder="请输入员工工号" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="emp_name" label="员工姓名" rules={[{ required: true }]}>
                <Input placeholder="请输入员工姓名" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="org_id" label="所属组织ID" rules={[{ required: true }]}>
                <InputNumber style={{ width: '100%' }} placeholder="请输入所属组织ID" />
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
                  options={employees
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
                <Input placeholder="请输入手机号" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="email" label="邮箱">
                <Input placeholder="请输入邮箱" />
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
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
