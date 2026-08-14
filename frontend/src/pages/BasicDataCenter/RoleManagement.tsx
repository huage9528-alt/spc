import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Table, Tag, Button, Modal, Form, Input, Space, message, Popconfirm, Row, Col, Checkbox, Tree, Radio, Divider, Alert } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, SafetyOutlined, ThunderboltOutlined, SearchOutlined } from '@ant-design/icons'
import { userApi } from '../../services/api'
import { useAuthStore } from '../../store/auth'
import { usePermissionStore, PermNode } from '../../store/permission'

const roleColorMap: Record<string, string> = {
  admin: 'purple',
  planner: 'blue',
  purchaser: 'orange',
  manager: 'cyan',
  purchase_manager: 'gold',
  supplier: 'green',
}

interface PermTreeNode {
  key: string
  label: string
  actions?: string[]
  children?: PermTreeNode[]
}

// 将 API 返回的 PermNode 转换为 PermTreeNode
function permNodeToTreeNode(nodes: PermNode[]): PermTreeNode[] {
  return nodes.map(node => ({
    key: node.code,
    label: node.name,
    actions: node.actions?.length ? [...node.actions] : undefined,
    children: node.children?.length ? permNodeToTreeNode(node.children) : undefined,
  }))
}

// 保留硬编码作为 fallback
const FALLBACK_PERMISSION_TREE: PermTreeNode[] = [
  { key: 'dashboard', label: '供应链驾驶舱' },
  {
    key: 'topbar', label: '顶栏功能',
    children: [
      { key: 'topbar.share', label: '页面分享' },
      { key: 'topbar.feedback', label: '问题反馈' },
      { key: 'topbar.ai_search', label: 'AI 全局搜索' },
      { key: 'topbar.font_size', label: '字号设置' },
      { key: 'topbar.notifications', label: '通知铃铛' },
    ],
  },
  {
    key: 'orders', label: '订单交付中心',
    children: [
      { key: 'orders.list', label: '订单总控台' },
      { key: 'orders.run_orders', label: '跑单管理' },
      { key: 'orders.risk_pool', label: '订单风险池' },
    ],
  },
  {
    key: 'materials', label: '物料齐套中心',
    children: [
      { key: 'materials.purchase_plan', label: '采购到料计划' },
      { key: 'materials.issues', label: '问题物料池' },
      { key: 'materials.long_lead', label: '长交期物料池' },
      { key: 'materials.kit_analysis', label: '齐套分析' },
      { key: 'materials.supplier_risk', label: '供应商风险分析' },
      { key: 'materials.supplier_payment', label: '供应商付款排程' },
      { key: 'materials.stock_check', label: '物料盘点' },
    ],
  },
  {
    key: 'production', label: '生产协同中心',
    children: [
      { key: 'production.overview', label: '生产总览' },
      { key: 'production.schedule_plans', label: '计划排产' },
      { key: 'production.front_process', label: '前道管理' },
      { key: 'production.smt', label: '贴片管理' },
      { key: 'production.lean', label: '精益管理' },
      { key: 'production.assembly', label: '组装管理' },
      { key: 'production.packaging', label: '包装管理' },
      { key: 'production.exceptions', label: '工序异常池' },
    ],
  },
  {
    key: 'exceptions', label: '异常与质量中心',
    children: [
      { key: 'exceptions.pool', label: '异常总池' },
      { key: 'exceptions.issue_log', label: '问题日志' },
      { key: 'exceptions.change_log', label: '变更日志' },
      { key: 'exceptions.quality', label: '品质异常' },
      { key: 'exceptions.product_samples', label: '产品封样' },
      { key: 'exceptions.closure', label: '闭环跟踪' },
    ],
  },
  { key: 'meetings', label: '会议与任务中心' },
  { key: 'npi', label: '新品/NPI项目中心' },
  {
    key: 'rules', label: '规则配置中心',
    children: [
      { key: 'rules.risk_rules', label: '预警规则' },
      { key: 'rules.inspection', label: '点检规则' },
      { key: 'rules.node_standards', label: '节点标准' },
      { key: 'rules.order_standards', label: '订单标准' },
      { key: 'rules.work_instructions', label: '作业指导书' },
      { key: 'rules.responsibility', label: '责任归属' },
      { key: 'rules.status_dict', label: '状态字典' },
    ],
  },
  {
    key: 'basicdata', label: '基础数据与集成中心',
    children: [
      { key: 'basicdata.import', label: '数据集成' },
      { key: 'basicdata.data', label: '基础数据管理' },
      { key: 'basicdata.feedback', label: '问题反馈', children: [{ key: 'basicdata.feedback.handle', label: '处理问题反馈', actions: ['handle'] }] },
      { key: 'basicdata.files', label: '文件管理' },
      { key: 'announcements', label: '公告管理' },
      { key: 'users', label: '用户管理', children: [{ key: 'users.reset_password', label: '重置密码', actions: ['reset_password'] }] },
      { key: 'roles', label: '角色管理' },
      { key: 'audit', label: '审计日志' },
      { key: 'settings', label: '同步SQL配置' },
    ],
  },
  {
    key: 'purchase', label: '采购中心',
    children: [
      { key: 'purchase.price_change', label: '调价单管理' },
      { key: 'purchase.price_change.pending', label: '待我审批' },
      { key: 'purchase.price_change.config', label: '审批配置' },
    ],
  },
]

function flattenLeaves(nodes: PermTreeNode[]): string[] {
  const result: string[] = []
  for (const n of nodes) {
    if (n.children && n.children.length > 0) {
      result.push(...flattenLeaves(n.children))
    } else {
      result.push(n.key)
    }
  }
  return result
}

function flattenAll(nodes: PermTreeNode[]): string[] {
  const result: string[] = []
  for (const n of nodes) {
    result.push(n.key)
    if (n.children) result.push(...flattenAll(n.children))
  }
  return result
}

const ALL_PERM_KEYS = flattenAll(FALLBACK_PERMISSION_TREE)
const ALL_LEAF_KEYS = flattenLeaves(FALLBACK_PERMISSION_TREE)

// 通用操作列：所有页面普遍具备的增删改查等能力
const PERMISSION_ACTIONS = [
  { key: 'create', label: '新增' },
  { key: 'read', label: '查看' },
  { key: 'update', label: '编辑' },
  { key: 'delete', label: '删除' },
  { key: 'import', label: '导入' },
]
const PERMISSION_ACTION_KEYS = PERMISSION_ACTIONS.map(a => a.key)
// 页面专属子权限动作：仅存在于对应页面下（如 用户管理-重置密码、问题反馈-处理），不作为通用列
const SPECIAL_ACTION_LABELS: Record<string, string> = {
  reset_password: '重置密码',
  handle: '处理',
}

// 收集定义中包含非通用动作的叶子节点（页面专属子权限）
function collectSpecialLeafKeys(nodes: PermTreeNode[]): string[] {
  const result: string[] = []
  for (const n of nodes) {
    if (n.children?.length) {
      result.push(...collectSpecialLeafKeys(n.children))
    } else if (n.actions?.some(a => !PERMISSION_ACTION_KEYS.includes(a))) {
      result.push(n.key)
    }
  }
  return result
}

function buildTreeData(nodes: PermTreeNode[]): any[] {
  return nodes.map(n => {
    const isSpecialLeaf = !n.children?.length && n.actions?.some(a => !PERMISSION_ACTION_KEYS.includes(a))
    return {
      title: isSpecialLeaf ? `${n.label}（子权限）` : n.label,
      key: n.key,
      disabled: isSpecialLeaf,
      children: n.children && n.children.length > 0 ? buildTreeData(n.children) : undefined,
    }
  })
}
const FALLBACK_PERM_TREE_DATA = buildTreeData(FALLBACK_PERMISSION_TREE)

interface RoleItem {
  id: number
  role_code: string
  role_name: string
  permissions: Record<string, string[]>
  user_count: number
  org_id: number | null
  org_name: string | null
  position_id: number | null
  position_name: string | null
}

function PermissionMatrix({ value, onChange, permissionTree }: { value: Record<string, string[]>; onChange: (v: Record<string, string[]>) => void; permissionTree: PermTreeNode[] }) {
  const currentAllPermKeys = useMemo(() => flattenAll(permissionTree), [permissionTree])
  const currentAllLeafKeys = useMemo(() => flattenLeaves(permissionTree), [permissionTree])
  // 结构判断：该父节点下挂的是「专属动作」子节点（如 users→重置密码、问题反馈→处理）→ 属于自带动作父节点，
  // 勾选应写自身 key；与运行时值无关，避免首次勾选被误判为纯分组父节点而写入子节点 key
  const isOwnActionParent = (node: PermTreeNode): boolean => {
    const kids = node.children
    if (!kids || kids.length === 0) return false
    if ((value[node.key] || []).length > 0) return true
    return kids.every(c => (c.actions || []).some(a => !PERMISSION_ACTION_KEYS.includes(a)))
  }

  // 父节点且自身持有动作（如 users、basicdata.feedback：既有自身动作又有子权限）→ 可独立勾选
  const ownParentKeys = useMemo(() => {
    const keys = new Set<string>()
    const walk = (nodes: PermTreeNode[]) => {
      for (const n of nodes) {
        if (n.children && n.children.length > 0 && isOwnActionParent(n)) keys.add(n.key)
        if (n.children) walk(n.children)
      }
    }
    walk(permissionTree)
    return keys
  }, [permissionTree, value])
  const currentGrantableKeys = useMemo(() => {
    const specialKeys = new Set(collectSpecialLeafKeys(permissionTree))
    return [...new Set([...currentAllLeafKeys, ...Array.from(ownParentKeys)])].filter(k => !specialKeys.has(k))
  }, [currentAllLeafKeys, ownParentKeys, permissionTree])
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    permissionTree.forEach(n => { if (n.children) init[n.key] = true })
    return init
  })

  const toggleExpand = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }))

  const getActions = (key: string, children?: PermTreeNode[], node?: PermTreeNode): string[] => {
    if (!children || children.length === 0) return value[key] || []
    // 父节点自带动作：显示/编辑自身动作（不再由子节点派生）
    if ((value[key] || []).length > 0) return value[key] || []
    if (node && isOwnActionParent(node)) return value[key] || []
    return PERMISSION_ACTIONS.filter(a => children.every(c => (value[c.key] || []).includes(a.key))).map(a => a.key)
  }
  const getIndeterminate = (action: string, children?: PermTreeNode[]): boolean => {
    if (!children || children.length === 0) return false
    const has = children.filter(c => (value[c.key] || []).includes(action)).length
    return has > 0 && has < children.length
  }

  const toggleLeaf = (key: string, action: string) => {
    const cur = value[key] || []
    const next = cur.includes(action) ? cur.filter(a => a !== action) : [...cur, action]
    onChange({ ...value, [key]: next })
  }

  const toggleParent = (children: PermTreeNode[], action: string, checked: boolean) => {
    const next = { ...value }
    children.forEach(c => {
      next[c.key] = checked ? [...new Set([...(next[c.key] || []), action])] : (next[c.key] || []).filter(a => a !== action)
    })
    onChange(next)
  }

  const toggleRow = (key: string, checked: boolean, children?: PermTreeNode[], node?: PermTreeNode) => {
    const next = { ...value }
    const allActs = PERMISSION_ACTIONS.map(a => a.key)
    const isOwnParent = Boolean(node && isOwnActionParent(node))
    if (children && children.length > 0 && !isOwnParent) {
      // 纯分组父节点：全选/全不选所有子节点
      children.forEach(c => { next[c.key] = checked ? [...allActs] : [] })
    } else {
      // 叶子节点 或 自带动作的父节点：只动自身
      const isLeaf = !children || children.length === 0
      const specialActs = isLeaf && node ? (node.actions || []).filter(a => !PERMISSION_ACTION_KEYS.includes(a)) : []
      next[key] = checked ? [...(specialActs.length > 0 ? specialActs : allActs)] : []
    }
    onChange(next)
  }

  const toggleCol = (action: string, checked: boolean) => {
    const next = { ...value }
    currentGrantableKeys.forEach(k => {
      next[k] = checked ? [...new Set([...(next[k] || []), action])] : (next[k] || []).filter(a => a !== action)
    })
    onChange(next)
  }

  const colAllChecked = (action: string) => currentGrantableKeys.every(k => (value[k] || []).includes(action))
  const colSomeChecked = (action: string) => currentGrantableKeys.some(k => (value[k] || []).includes(action))

  const renderRow = (node: PermTreeNode, depth: number) => {
    const hasChildren = node.children && node.children.length > 0
    const isExpanded = expanded[node.key]
    const isOwnParent = Boolean(node && isOwnActionParent(node))
    const actions = getActions(node.key, node.children, node)
    // 页面专属子权限（如 重置密码、处理）：不占用通用操作列，合并单元格单独展示
    const specialActs = !hasChildren ? (node.actions || []).filter(a => !PERMISSION_ACTION_KEYS.includes(a)) : []
    const allChecked = specialActs.length > 0
      ? specialActs.every(a => actions.includes(a))
      : PERMISSION_ACTIONS.every(a => actions.includes(a.key))
    const rowIndeterminate = isOwnParent
      ? (actions.length > 0 && !allChecked)
      : (hasChildren
          ? PERMISSION_ACTIONS.some(a => getIndeterminate(a.key, node.children) || (node.children!.some(c => (value[c.key] || []).includes(a.key)) && !node.children!.every(c => (value[c.key] || []).includes(a.key)))) && !allChecked
          : (actions.length > 0 && !allChecked))

    const rows: React.ReactNode[] = []
    rows.push(
      <tr key={node.key} style={{ background: depth === 0 && hasChildren ? '#fafafa' : 'transparent' }}>
        <td style={{ padding: '6px 8px', paddingLeft: 8 + depth * 20, borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap', fontWeight: hasChildren ? 500 : 400 }}>
          {hasChildren ? (
            <span onClick={() => toggleExpand(node.key)} style={{ cursor: 'pointer', marginRight: 4, display: 'inline-block', width: 14, textAlign: 'center', color: '#999', fontSize: 12, userSelect: 'none' }}>
              {isExpanded ? '▼' : '▶'}
            </span>
          ) : (
            <span style={{ display: 'inline-block', width: 14, marginRight: 4 }} />
          )}
          <Checkbox checked={allChecked} indeterminate={rowIndeterminate} onChange={e => toggleRow(node.key, e.target.checked, node.children, node)} />
          <span style={{ marginLeft: 6 }}>{node.label}</span>
        </td>
        {specialActs.length > 0 ? (
          <td colSpan={PERMISSION_ACTIONS.length} style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #f0f0f0' }}>
            {specialActs.map(a => (
              <Checkbox key={a} checked={actions.includes(a)} onChange={e => toggleLeaf(node.key, a)}>
                {SPECIAL_ACTION_LABELS[a] || a}
              </Checkbox>
            ))}
          </td>
        ) : PERMISSION_ACTIONS.map(a => {
          const checked = actions.includes(a.key)
          const indeterminate = (hasChildren && !isOwnParent) ? getIndeterminate(a.key, node.children) : false
          return (
            <td key={a.key} style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #f0f0f0' }}>
              <Checkbox
                checked={checked}
                indeterminate={indeterminate}
                onChange={e => hasChildren && !isOwnParent ? toggleParent(node.children!, a.key, e.target.checked) : toggleLeaf(node.key, a.key)}
              />
            </td>
          )
        })}
      </tr>
    )
    if (hasChildren && isExpanded) {
      node.children!.forEach(child => {
        rows.push(...renderRow(child, depth + 1))
      })
    }
    return rows
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid #e5e7eb', minWidth: 200 }}>菜单 / 功能模块</th>
          {PERMISSION_ACTIONS.map(a => (
            <th key={a.key} style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '2px solid #e5e7eb', width: 60 }}>
              <Checkbox checked={colAllChecked(a.key)} indeterminate={colSomeChecked(a.key) && !colAllChecked(a.key)} onChange={e => toggleCol(a.key, e.target.checked)} />
              {' '}{a.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {permissionTree.map(node => renderRow(node, 0))}
      </tbody>
    </table>
  )
}

export default function RoleManagement() {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlSearchAppliedRef = useRef(false)
  const isAdmin = useAuthStore(s => s.isAdmin())
  const hasRolesRead = useAuthStore(s => s.hasPermission('roles', 'read'))
  const hasRolesCreate = useAuthStore(s => s.hasPermission('roles', 'create'))
  const hasRolesDelete = useAuthStore(s => s.hasPermission('roles', 'delete'))
  const { tree: permTree, loaded: permLoaded, fetchTree } = usePermissionStore()
  // 动态权限树：优先 API，fallback 硬编码
  const currentPermissionTree = useMemo(() => {
    if (permLoaded && permTree.length > 0) {
      return permNodeToTreeNode(permTree)
    }
    return FALLBACK_PERMISSION_TREE
  }, [permLoaded, permTree])
  const currentPermTreeData = useMemo(() => {
    if (permLoaded && permTree.length > 0) {
      return buildTreeData(currentPermissionTree)
    }
    return FALLBACK_PERM_TREE_DATA
  }, [permLoaded, permTree, currentPermissionTree])
  const currentAllLeafKeys = useMemo(() => flattenLeaves(currentPermissionTree), [currentPermissionTree])
  const currentAllPermKeys = useMemo(() => flattenAll(currentPermissionTree), [currentPermissionTree])

  // 加载权限树
  useEffect(() => {
    if (!permLoaded) fetchTree()
  }, [permLoaded, fetchTree])
  const [roles, setRoles] = useState<RoleItem[]>([])
  const [roleLoading, setRoleLoading] = useState(false)
  const [rolePage, setRolePage] = useState(1)
  const [rolePageSize, setRolePageSize] = useState(20)
  const [roleTotal, setRoleTotal] = useState(0)
  const [roleQuery, setRoleQuery] = useState<{ sortBy?: string; sortOrder?: string; filters?: Record<string, string[]> }>({})
  const [keyword, setKeyword] = useState('')
  const [roleModalOpen, setRoleModalOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<RoleItem | null>(null)
  const [roleForm] = Form.useForm()
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]>>({})
  // 批量授权弹窗
  const [bgOpen, setBgOpen] = useState(false)
  const [bgKeys, setBgKeys] = useState<string[]>([])
  const [bgActions, setBgActions] = useState<string[]>(['read'])
  const [bgRoleIds, setBgRoleIds] = useState<number[]>([])
  const [bgMode, setBgMode] = useState<'grant' | 'revoke' | 'replace'>('grant')
  const [bgSubmitting, setBgSubmitting] = useState(false)
  const [bgRoles, setBgRoles] = useState<RoleItem[]>([])

  const fetchRoles = async (opts?: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string; filters?: Record<string, string[]>; keyword?: string }) => {
    const p = opts?.page ?? rolePage
    const ps = opts?.pageSize ?? rolePageSize
    const sortBy = opts?.sortBy ?? roleQuery.sortBy
    const sortOrder = opts?.sortOrder ?? roleQuery.sortOrder
    const filters = opts?.filters ?? roleQuery.filters
    const kw = opts?.keyword ?? keyword
    setRoleQuery({ sortBy, sortOrder, filters })
    setRoleLoading(true)
    try {
      const params: any = { page: p, page_size: ps }
      if (sortBy) params.sort_by = sortBy
      if (sortOrder) params.sort_order = sortOrder
      if (kw?.trim()) params.keyword = kw.trim()
      if (filters?.role_code?.length) params.role_code = filters.role_code.join(',')
      if (filters?.org_name?.length) params.org_name = filters.org_name.join(',')
      if (filters?.position_name?.length) params.position_name = filters.position_name.join(',')
      const res: any = await userApi.roles(params)
      const payload = res?.data
      if (Array.isArray(payload)) {
        setRoles(payload)
        setRoleTotal(payload.length)
      } else {
        setRoles(payload?.items || [])
        setRoleTotal(payload?.total ?? 0)
      }
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setRoleLoading(false)
    }
  }

  useEffect(() => {
    fetchRoles()
  }, [])

  // 从用户管理点击角色跳转而来：读取 URL 参数并自动按角色过滤
  useEffect(() => {
    if (urlSearchAppliedRef.current) return
    const roleCode = searchParams.get('role_code')
    if (roleCode) {
      urlSearchAppliedRef.current = true
      setKeyword(roleCode)
      fetchRoles({ page: 1, keyword: roleCode })
      const newParams = new URLSearchParams(searchParams)
      newParams.delete('role_code')
      setSearchParams(newParams, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const openAddRole = () => {
    setEditingRole(null)
    roleForm.resetFields()
    setRolePermissions({})
    setRoleModalOpen(true)
  }

  const openEditRole = (record: RoleItem) => {
    setEditingRole(record)
    roleForm.setFieldsValue({ role_code: record.role_code, role_name: record.role_name })
    setRolePermissions(record.permissions || {})
    setRoleModalOpen(true)
  }

  const handleSaveRole = async () => {
    try {
      const values = await roleForm.validateFields()
      if (editingRole) {
        await userApi.updateRole(editingRole.id, { role_name: values.role_name, permissions: rolePermissions })
        message.success('角色更新成功')
      } else {
        await userApi.createRole({ role_code: values.role_code, role_name: values.role_name, permissions: rolePermissions })
        message.success('角色创建成功')
      }
      setRoleModalOpen(false)
      fetchRoles()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  const handleDeleteRole = async (id: number) => {
    try {
      await userApi.deleteRole(id)
      message.success('角色已删除')
      fetchRoles()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  const openBatchGrant = () => {
    setBgKeys([])
    setBgActions(['read'])
    setBgRoleIds([])
    setBgMode('grant')
    setBgRoles([])
    setBgOpen(true)
    userApi.roles({ page: 1, page_size: 500 }).then((res: any) => {
      const payload = res?.data
      setBgRoles(Array.isArray(payload) ? payload : payload?.items || [])
    }).catch(() => { /* 错误已由全局拦截器提示 */ })
  }

  const handleBatchGrant = async () => {
    const leafSet = new Set(currentAllLeafKeys)
    const specialSet = new Set(collectSpecialLeafKeys(currentPermissionTree))
    const targetKeys = bgKeys.filter(k => leafSet.has(k) && !specialSet.has(k))
    if (targetKeys.length === 0) {
      message.warning('请选择至少一个权限项（具体子菜单）'); return
    }
    if (bgActions.length === 0) {
      message.warning('请选择至少一个操作'); return
    }
    if (bgRoleIds.length === 0) {
      message.warning('请选择至少一个目标角色'); return
    }
    const permissions: Record<string, string[]> = {}
    targetKeys.forEach(k => { permissions[k] = [...bgActions] })
    setBgSubmitting(true)
    try {
      const res: any = await userApi.batchGrant({ role_ids: bgRoleIds, permissions, mode: bgMode })
      const aff = res?.data?.affected ?? 0
      const skip = res?.data?.skipped_admin ?? 0
      message.success(`批量授权完成：影响 ${aff} 个角色${skip ? `，跳过 ${skip} 个 admin` : ''}`)
      setBgOpen(false)
      fetchRoles()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    } finally {
      setBgSubmitting(false)
    }
  }

  const getPermSummary = (permissions: Record<string, string[]>) => {
    const entries = Object.entries(permissions).filter(([, v]) => v && v.length > 0)
    if (entries.length === 0) return <Tag>无权限</Tag>
    if (entries.length >= currentAllPermKeys.length) return <Tag color="green">全部权限</Tag>
    return <Tag color="blue">{entries.length} 个模块</Tag>
  }

  const roleColumns = [
    { title: '角色编码', dataIndex: 'role_code', key: 'role_code', width: 180, sorter: true,
      filters: [...new Set(roles.map(r => r.role_code).filter(Boolean))].map(v => ({ text: v, value: v })),
      filterSearch: true,
      render: (code: string) => <Tag color={roleColorMap[code] || 'default'}>{code}</Tag>,
    },
    { title: '角色名称', dataIndex: 'role_name', key: 'role_name', width: 200, sorter: true },
    {
      title: '部门', dataIndex: 'org_name', key: 'org_name', width: 120,
      filters: [...new Set(roles.map(r => r.org_name).filter(Boolean))].map(v => ({ text: v, value: v! })),
      filterSearch: true,
      render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '岗位', dataIndex: 'position_name', key: 'position_name', width: 120,
      filters: [...new Set(roles.map(r => r.position_name).filter(Boolean))].map(v => ({ text: v, value: v! })),
      filterSearch: true,
      render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '使用人数', dataIndex: 'user_count', key: 'user_count', width: 100, sorter: true,
      render: (count: number) => count > 0 ? <Tag color="blue">{count} 人</Tag> : <Tag>未使用</Tag>,
    },
    {
      title: '权限概览', dataIndex: 'permissions', key: 'permissions', width: 140,
      render: (perms: Record<string, string[]>) => getPermSummary(perms),
    },
    {
      title: '操作', key: 'action', width: 160, fixed: 'right' as const,
      render: (_: any, record: RoleItem) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditRole(record)}>权限</Button>
          {record.role_code !== 'admin' && (isAdmin || hasRolesDelete) && (
            <Popconfirm
              title="确认删除该角色？"
              description={record.user_count > 0 ? `该角色当前有 ${record.user_count} 个用户使用中` : '删除后不可恢复'}
              onConfirm={() => handleDeleteRole(record.id)}
            >
              <Button size="small" icon={<DeleteOutlined />} danger />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  if (!hasRolesRead && !isAdmin) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 'calc(100vh - 130px)' }}>
        <div style={{ color: '#94a3b8', fontSize: 16 }}>无角色权限管理权限</div>
      </div>
    )
  }

  return (
    <div style={{ height: 'calc(100vh - 130px)', display: 'flex', flexDirection: 'column' }}>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col flex="auto">
            <Input
              prefix={<SearchOutlined />}
              placeholder="搜索角色编码 / 角色名称"
              value={keyword}
              allowClear
              onChange={(e) => {
                setKeyword(e.target.value)
                if (!e.target.value) {
                  setRolePage(1)
                  fetchRoles({ page: 1, keyword: '' })
                }
              }}
              onPressEnter={() => { setRolePage(1); fetchRoles({ page: 1 }) }}
              style={{ width: 280 }}
            />
          </Col>
          <Col><Space>
            <Button icon={<ReloadOutlined />} onClick={() => fetchRoles()}>刷新</Button>
            <Button icon={<ThunderboltOutlined />} onClick={openBatchGrant}>批量授权</Button>
            {(isAdmin || hasRolesCreate) && <Button type="primary" icon={<PlusOutlined />} onClick={openAddRole}>新增角色</Button>}
          </Space></Col>
        </Row>
      </div>
      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table columns={roleColumns} dataSource={roles} rowKey="id" loading={roleLoading} size="small" scroll={{ x: 1140, y: 'calc(100vh - 360px)' }}
          onChange={(pag: any, tableFilters: any, sorter: any) => {
            const sortField = sorter.field
            const sortOrder = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : undefined
            const newFilters: Record<string, string[]> = {}
            if (tableFilters.role_code?.length) newFilters.role_code = tableFilters.role_code
            if (tableFilters.org_name?.length) newFilters.org_name = tableFilters.org_name
            if (tableFilters.position_name?.length) newFilters.position_name = tableFilters.position_name
            const newPage = typeof pag?.current === 'number' ? pag.current : rolePage
            const newPageSize = typeof pag?.pageSize === 'number' ? pag.pageSize : rolePageSize
            setRolePage(newPage)
            setRolePageSize(newPageSize)
            fetchRoles({ page: newPage, pageSize: newPageSize, sortBy: sortField, sortOrder, filters: newFilters })
          }}
          pagination={{ current: rolePage, pageSize: rolePageSize, total: roleTotal, showSizeChanger: true, showTotal: (t: number) => `共 ${t} 条`, pageSizeOptions: [20, 50, 100], showQuickJumper: true }} />
      </div>

      {/* 新增/编辑角色 + 权限矩阵 */}
      <Modal
        title={editingRole ? `编辑角色权限 — ${editingRole.role_name}` : '新增角色'}
        open={roleModalOpen} onOk={handleSaveRole} onCancel={() => setRoleModalOpen(false)} width={780} destroyOnClose
      >
        <Form form={roleForm} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="role_code" label="角色编码" rules={[{ required: true, message: '请输入角色编码' }]}>
                <Input placeholder="如: planner" disabled={!!editingRole} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="role_name" label="角色名称" rules={[{ required: true, message: '请输入角色名称' }]}>
                <Input placeholder="如: 生产计划员" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
        <div style={{ marginTop: 8, padding: '12px', border: '1px solid #f0f0f0', borderRadius: 6, background: '#fafafa' }}>
          <div style={{ fontWeight: 500, marginBottom: 8 }}>权限配置</div>
          <PermissionMatrix value={rolePermissions} onChange={setRolePermissions} permissionTree={currentPermissionTree} />
        </div>
      </Modal>

      {/* 批量授权 */}
      <Modal
        title={<span><ThunderboltOutlined /> 批量授权 — 一次将权限分配给多个角色</span>}
        open={bgOpen}
        onOk={handleBatchGrant}
        onCancel={() => setBgOpen(false)}
        confirmLoading={bgSubmitting}
        width={880}
        destroyOnClose
        okText="确认应用"
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="操作说明"
          description={
            <div style={{ fontSize: 13 }}>
              选择要分配的「权限项」+「操作」，再勾选「目标角色」，点击应用即可一次完成多角色赋权。<br />
              <b>追加</b>：在角色已有权限上并集合并；<b>撤销</b>：从角色权限中移除指定操作；<b>覆盖</b>：以本次操作集合替换这些权限项。<br />
              重置密码、处理等页面专属子权限不参与批量授权，请在角色权限矩阵中单独配置。<br />
              admin 角色自动跳过（默认全权限）。
            </div>
          }
        />
        <Row gutter={16}>
          <Col span={12}>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>① 权限项（菜单/子页面）</div>
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 4, padding: 8, maxHeight: 360, overflow: 'auto' }}>
              <Tree
                checkable
                selectable={false}
                defaultExpandAll
                treeData={currentPermTreeData}
                checkedKeys={bgKeys}
                onCheck={(checked: any) => {
                  const keys = Array.isArray(checked) ? checked : checked.checked
                  setBgKeys(keys.map((k: any) => String(k)))
                }}
              />
            </div>
            <Divider style={{ margin: '12px 0 8px' }} />
            <div style={{ fontWeight: 500, marginBottom: 6 }}>② 操作</div>
            <Checkbox.Group
              value={bgActions}
              onChange={(v) => setBgActions(v as string[])}
              options={PERMISSION_ACTIONS.map(a => ({ value: a.key, label: a.label }))}
            />
          </Col>
          <Col span={12}>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>
              ③ 目标角色
              <Button
                size="small"
                type="link"
                onClick={() => {
                  const allIds = bgRoles.filter(r => r.role_code !== 'admin').map(r => r.id)
                  setBgRoleIds(bgRoleIds.length === allIds.length ? [] : allIds)
                }}
              >
                全选 / 反选
              </Button>
            </div>
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 4, padding: 8, maxHeight: 240, overflow: 'auto' }}>
              <Checkbox.Group
                value={bgRoleIds}
                onChange={(v) => setBgRoleIds(v as number[])}
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
              >
                {bgRoles.map(r => (
                  <Checkbox key={r.id} value={r.id} disabled={r.role_code === 'admin'}>
                    <Tag color={roleColorMap[r.role_code] || 'default'} style={{ marginRight: 4 }}>{r.role_code}</Tag>
                    {r.role_name}
                    {r.role_code === 'admin' && <span style={{ color: '#999', marginLeft: 6, fontSize: 12 }}>（默认全权限，自动跳过）</span>}
                  </Checkbox>
                ))}
              </Checkbox.Group>
            </div>
            <Divider style={{ margin: '12px 0 8px' }} />
            <div style={{ fontWeight: 500, marginBottom: 6 }}>④ 应用模式</div>
            <Radio.Group value={bgMode} onChange={e => setBgMode(e.target.value)}>
              <Radio value="grant">追加（并集）</Radio>
              <Radio value="revoke">撤销</Radio>
              <Radio value="replace">覆盖</Radio>
            </Radio.Group>
          </Col>
        </Row>
      </Modal>
    </div>
  )
}
