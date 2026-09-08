import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Table, Tag, Button, Modal, Form, Input, Select, Space, message, Checkbox, Tree, Radio, Divider, Alert,
} from 'antd'
import { PlusOutlined, DeleteOutlined, ReloadOutlined, ThunderboltOutlined, SearchOutlined, LockOutlined, SafetyOutlined, TeamOutlined, ClockCircleOutlined, AuditOutlined } from '@ant-design/icons'
import { userApi } from '../../services/api'
import { useAuthStore } from '../../store/auth'
import { usePermissionStore, PermNode } from '../../store/permission'
import KpiBand, { type KpiItem } from './components/KpiBand'
import ChipsFilter, { type ChipOption } from './components/ChipsFilter'

const roleColorMap: Record<string, string> = {
  admin: 'purple',
  planner: 'blue',
  purchaser: 'orange',
  manager: 'cyan',
  purchase_manager: 'gold',
  supplier: 'green',
}

const ROLE_TAG_CLASS: Record<string, string> = {
  admin: 'sc-tag-purple',
  planner: 'sc-tag-kit',
  purchaser: 'sc-tag-amber',
  manager: 'sc-tag-cyan',
  purchase_manager: 'sc-tag-warn',
  supplier: 'sc-tag-done',
  qc_inspector: 'sc-tag-plain',
  wh_keeper: 'sc-tag-kit',
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
          ? PERMISSION_ACTIONS.some(a => getIndeterminate(a.key, node.children)) && !allChecked
          : (actions.length > 0 && !allChecked))

    const rows: React.ReactNode[] = []
    rows.push(
      <tr key={node.key} style={{ background: depth === 0 && hasChildren ? '#f8fafc' : 'transparent' }}>
        <td style={{ padding: '5px 10px', paddingLeft: 8 + depth * 20, borderBottom: '1px solid #f1f5f9', whiteSpace: 'nowrap', fontWeight: hasChildren ? 600 : 400, color: '#0f172a', fontSize: 'calc(13px * var(--font-size-scale))' }}>
          {hasChildren ? (
            <span onClick={() => toggleExpand(node.key)} style={{ cursor: 'pointer', marginRight: 4, display: 'inline-block', width: 14, textAlign: 'center', color: '#94a3b8', fontSize: 12, userSelect: 'none' }}>
              {isExpanded ? '▼' : '▶'}
            </span>
          ) : (
            <span style={{ display: 'inline-block', width: 14, marginRight: 4 }} />
          )}
          <Checkbox checked={allChecked} indeterminate={rowIndeterminate} onChange={e => toggleRow(node.key, e.target.checked, node.children, node)} />
          <span style={{ marginLeft: 6 }}>{node.label}</span>
        </td>
        {specialActs.length > 0 ? (
          <td colSpan={PERMISSION_ACTIONS.length} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #f1f5f9', background: '#f0fdf4' }}>
            <span style={{ color: '#16a34a', fontSize: 11, fontWeight: 600, marginRight: 10 }}>专属子权限</span>
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
            <td key={a.key} style={{ textAlign: 'center', padding: '6px 4px', borderBottom: '1px solid #f1f5f9' }}>
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
    <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(13px * var(--font-size-scale))' }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={{ textAlign: 'left', padding: '7px 10px', borderBottom: '1px solid #e2e8f0', minWidth: 240, fontSize: 'calc(11.5px * var(--font-size-scale))', fontWeight: 500, color: '#64748b', letterSpacing: '0.03em' }}>
              权限项（按模块分组）
            </th>
            {PERMISSION_ACTIONS.map(a => (
              <th key={a.key} style={{ textAlign: 'center', padding: '7px 4px', borderBottom: '1px solid #e2e8f0', width: 68, fontSize: 'calc(11.5px * var(--font-size-scale))', fontWeight: 500, color: '#64748b', letterSpacing: '0.03em' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <Checkbox checked={colAllChecked(a.key)} indeterminate={colSomeChecked(a.key) && !colAllChecked(a.key)} onChange={e => toggleCol(a.key, e.target.checked)} />
                  {a.label}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {permissionTree.map(node => renderRow(node, 0))}
        </tbody>
      </table>
    </div>
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
  const [chip, setChip] = useState<string | number>('all')
  const [keyword, setKeyword] = useState('')
  const [orgSel, setOrgSel] = useState<string | undefined>()
  const [posSel, setPosSel] = useState<string | undefined>()
  const [roleModalOpen, setRoleModalOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<RoleItem | null>(null)
  const [roleForm] = Form.useForm()
  const [rolePermissions, setRolePermissions] = useState<Record<string, string[]>>({})
  const [deleteTarget, setDeleteTarget] = useState<RoleItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  // 批量授权弹窗
  const [bgOpen, setBgOpen] = useState(false)
  const [bgKeys, setBgKeys] = useState<string[]>([])
  const [bgActions, setBgActions] = useState<string[]>(['read'])
  const [bgRoleIds, setBgRoleIds] = useState<number[]>([])
  const [bgMode, setBgMode] = useState<'grant' | 'revoke' | 'replace'>('grant')
  const [bgSubmitting, setBgSubmitting] = useState(false)
  const [bgRoles, setBgRoles] = useState<RoleItem[]>([])

  const fetchRoles = async () => {
    setRoleLoading(true)
    try {
      const res: any = await userApi.roles({ page: 1, page_size: 500 })
      const payload = res?.data
      setRoles(Array.isArray(payload) ? payload : payload?.items || [])
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
      const newParams = new URLSearchParams(searchParams)
      newParams.delete('role_code')
      setSearchParams(newParams, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // ---------- 统计 / 过滤 ----------
  const stats = useMemo(() => {
    const used = roles.filter(r => r.user_count > 0).length
    const protectedCount = roles.filter(r => r.role_code === 'admin').length
    return { total: roles.length, used, unused: roles.length - used, protected: protectedCount }
  }, [roles])

  const viewRoles = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return roles
      .filter(r => {
        if (chip === 'used' && r.user_count <= 0) return false
        if (chip === 'unused' && r.user_count > 0) return false
        if (chip === 'protected' && r.role_code !== 'admin') return false
        if (orgSel && r.org_name !== orgSel) return false
        if (posSel && r.position_name !== posSel) return false
        if (kw && !r.role_code.toLowerCase().includes(kw) && !r.role_name.toLowerCase().includes(kw)) return false
        return true
      })
  }, [roles, chip, keyword, orgSel, posSel])

  const kpiItems: KpiItem[] = [
    { label: '角色总数', value: stats.total.toLocaleString(), sub: '按「岗位 → 角色」映射分配', accent: 'brand', icon: <SafetyOutlined />, onClick: () => setChip('all') },
    { label: '使用中', value: stats.used.toLocaleString(), sub: '至少 1 名用户绑定', accent: 'info', icon: <TeamOutlined />, onClick: () => setChip('used') },
    { label: '未使用 / 无权限', value: stats.unused.toLocaleString(), go: '闲置角色待梳理 · 查看 →', accent: 'warning', icon: <ClockCircleOutlined />, onClick: () => setChip('unused') },
    { label: '系统保护', value: stats.protected.toLocaleString(), sub: '内置 admin · 不可删除', accent: 'purple', icon: <LockOutlined />, onClick: () => setChip('protected') },
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    { label: '使用中', value: 'used', count: stats.used },
    { label: '未使用', value: 'unused', count: stats.unused, hot: true },
    { label: '系统保护', value: 'protected', count: stats.protected },
  ]

  const orgOptions = useMemo(() => [...new Set(roles.map(r => r.org_name).filter(Boolean) as string[])].sort(), [roles])
  const posOptions = useMemo(() => [...new Set(roles.map(r => r.position_name).filter(Boolean) as string[])].sort(), [roles])

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

  const handleDeleteRole = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await userApi.deleteRole(deleteTarget.id)
      message.success('角色已删除')
      setDeleteTarget(null)
      fetchRoles()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    } finally {
      setDeleting(false)
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
    if (entries.length === 0) return <span className="sc-tag sc-tag-wait">无权限</span>
    if (entries.length >= currentAllPermKeys.length) return <span className="sc-tag sc-tag-done"><span className="dot" />全部模块</span>
    return <span className="sc-tag sc-tag-kit">{entries.length} 个模块</span>
  }

  const renderCode = (r: RoleItem) => (
    <span className={`sc-tag ${ROLE_TAG_CLASS[r.role_code] || 'sc-tag-plain'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{r.role_code}</span>
  )

  const roleColumns: any[] = [
    {
      title: '角色编码', dataIndex: 'role_code', key: 'role_code', width: 150,
      sorter: (a: RoleItem, b: RoleItem) => a.role_code.localeCompare(b.role_code),
      render: (code: string, r: RoleItem) => renderCode(r),
    },
    {
      title: '角色名称', dataIndex: 'role_name', key: 'role_name', width: 240,
      sorter: (a: RoleItem, b: RoleItem) => a.role_name.localeCompare(b.role_name),
      render: (name: string, r: RoleItem) => (
        <span style={{ color: '#0f172a', fontWeight: 500 }}>
          {name}
          {r.role_code === 'admin' && (
            <>
              <LockOutlined style={{ color: '#d97706', marginLeft: 6, fontSize: 11 }} />
              <span className="sc-tag sc-tag-warn" style={{ marginLeft: 6, height: 18, fontSize: 'calc(11px * var(--font-size-scale))' }}>内置</span>
            </>
          )}
        </span>
      ),
    },
    {
      title: '部门', dataIndex: 'org_name', key: 'org_name', width: 140,
      render: (v: string | null) => v || <span className="sc-note">—</span>,
    },
    {
      title: '岗位', dataIndex: 'position_name', key: 'position_name', width: 140,
      render: (v: string | null) => v || <span className="sc-note">—</span>,
    },
    {
      title: '使用人数', dataIndex: 'user_count', key: 'user_count', width: 110, align: 'center' as const,
      sorter: (a: RoleItem, b: RoleItem) => (a.user_count || 0) - (b.user_count || 0),
      render: (count: number) => count > 0
        ? <span className="sc-tag sc-tag-kit">{count} 人</span>
        : <span className="sc-tag sc-tag-wait">未使用</span>,
    },
    {
      title: '权限概览', dataIndex: 'permissions', key: 'permissions', width: 150,
      render: (perms: Record<string, string[]>) => getPermSummary(perms),
    },
    {
      title: '操作', key: 'action', width: 120, fixed: 'right' as const,
      render: (_: any, record: RoleItem) => (
        <span className="sc-row-act">
          <a onClick={() => openEditRole(record)}>权限</a>
          {record.role_code !== 'admin' && (isAdmin || hasRolesDelete) && (
            <a style={{ color: '#dc2626' }} onClick={() => setDeleteTarget(record)}>删除</a>
          )}
        </span>
      ),
    },
  ]

  if (!hasRolesRead && !isAdmin) {
    return (
      <div className="sc-page" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 480 }}>
        <div style={{ color: '#94a3b8', fontSize: 16 }}>无角色权限管理权限</div>
      </div>
    )
  }

  return (
    <div className="sc-page">
      <KpiBand items={kpiItems} />

      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="角色编码 / 名称"
            style={{ width: 220 }}
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); setChip('all') }}
          />
        </span>
        <Select
          allowClear
          placeholder="全部部门"
          style={{ width: 140 }}
          value={orgSel}
          onChange={setOrgSel}
          options={orgOptions.map(v => ({ label: v, value: v }))}
        />
        <Select
          allowClear
          placeholder="全部岗位"
          style={{ width: 140 }}
          value={posSel}
          onChange={setPosSel}
          options={posOptions.map(v => ({ label: v, value: v }))}
        />
        <ChipsFilter options={chipOptions} value={chip} onChange={(v) => { setChip(v); setKeyword('') }} />
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Button icon={<ReloadOutlined />} onClick={fetchRoles}>刷新</Button>
          <Button icon={<ThunderboltOutlined />} onClick={openBatchGrant}>批量授权</Button>
          {(isAdmin || hasRolesCreate) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openAddRole}>新增角色</Button>
          )}
        </span>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table
          columns={roleColumns}
          dataSource={viewRoles}
          rowKey="id"
          loading={roleLoading}
          size="small"
          scroll={{ x: 1050 }}
          key={`${chip}-${keyword}-${orgSel ?? ''}-${posSel ?? ''}`}
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            showTotal: (t: number) => `共 ${t} 条`,
            pageSizeOptions: [10, 20, 50, 100],
          }}
        />
      </div>

      {/* 新增/编辑角色 + 权限矩阵 */}
      <Modal
        title={editingRole ? `编辑角色权限 — ${editingRole.role_name}` : '新增角色'}
        open={roleModalOpen}
        onOk={handleSaveRole}
        onCancel={() => setRoleModalOpen(false)}
        width={1000}
        destroyOnClose
        okText="保存角色"
        rootClassName="sc-page"
      >
        <Form form={roleForm} layout="vertical">
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="role_code" label="角色编码" rules={[{ required: true, message: '请输入角色编码' }]} style={{ flex: 1 }}>
              <Input placeholder="如: planner" disabled={!!editingRole} />
            </Form.Item>
            <Form.Item name="role_name" label="角色名称" rules={[{ required: true, message: '请输入角色名称' }]} style={{ flex: 1 }}>
              <Input placeholder="如: 生产计划员" />
            </Form.Item>
          </div>
        </Form>
        <div style={{ marginTop: 4 }}>
          <div className="sc-toolbar-hint" style={{ marginBottom: 8, fontWeight: 500, color: '#334155' }}>
            权限配置
            <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>
              行 = 权限节点（父行级联子节点） · 列 = 通用动作 · 绿底行 = 专属子权限
            </span>
          </div>
          <PermissionMatrix value={rolePermissions} onChange={setRolePermissions} permissionTree={currentPermissionTree} />
          <div className="f-note" style={{ marginTop: 10 }}>
            保存后约影响该角色下全部用户；受影响账号登录版本将递增，需重新登录后生效。专属子权限（重置密码 / 处理等）随所属节点一并保存。
          </div>
        </div>
      </Modal>

      {/* 批量授权 */}
      <Modal
        title={<span><ThunderboltOutlined /> 批量授权</span>}
        open={bgOpen}
        onOk={handleBatchGrant}
        onCancel={() => setBgOpen(false)}
        confirmLoading={bgSubmitting}
        width={900}
        destroyOnClose
        okText="提交批量授权"
        rootClassName="sc-page"
      >
        <div style={{ maxHeight: '68vh', overflowY: 'auto', paddingRight: 4 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="四步：选择权限 → 勾选动作 → 指定目标角色 → 选择模式；提交后所有受影响用户强制重登"
          />
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span className="sys-step-no" style={{ width: 20, height: 20, borderRadius: '50%', background: '#5b5bd6', color: '#fff', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>1</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>选择权限项 <span style={{ fontWeight: 400, color: '#94a3b8', fontSize: 'calc(12px * var(--font-size-scale))' }}>含子权限的节点将同步应用其专属子权限</span></div>
                <div style={{ border: '1px solid #f1f5f9', borderRadius: 6, padding: 8, maxHeight: 240, overflow: 'auto' }}>
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
              </div>
            </div>
          </div>

          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span className="sys-step-no" style={{ width: 20, height: 20, borderRadius: '50%', background: '#5b5bd6', color: '#fff', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>2</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>授权动作 <span style={{ fontWeight: 400, color: '#94a3b8', fontSize: 'calc(12px * var(--font-size-scale))' }}>默认仅授予「查看」</span></div>
                <Checkbox.Group value={bgActions} onChange={(v) => setBgActions(v as string[])} options={PERMISSION_ACTIONS.map(a => ({ value: a.key, label: a.label }))} />
              </div>
            </div>
          </div>

          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span className="sys-step-no" style={{ width: 20, height: 20, borderRadius: '50%', background: '#5b5bd6', color: '#fff', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>3</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>
                  目标角色
                  <Button size="small" type="link" style={{ padding: 0, marginLeft: 8 }} onClick={() => {
                    const allIds = bgRoles.filter(r => r.role_code !== 'admin').map(r => r.id)
                    setBgRoleIds(bgRoleIds.length === allIds.length ? [] : allIds)
                  }}>全选 / 反选</Button>
                  <span style={{ fontWeight: 400, color: '#94a3b8', fontSize: 'calc(12px * var(--font-size-scale))', marginLeft: 8 }}>admin 自动跳过</span>
                </div>
                <div style={{ border: '1px solid #f1f5f9', borderRadius: 6, padding: 8, maxHeight: 180, overflow: 'auto' }}>
                  <Checkbox.Group value={bgRoleIds} onChange={(v) => setBgRoleIds(v as number[])} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {bgRoles.map(r => (
                      <Checkbox key={r.id} value={r.id} disabled={r.role_code === 'admin'}>
                        <span className={`sc-tag ${ROLE_TAG_CLASS[r.role_code] || 'sc-tag-plain'}`} style={{ marginRight: 4, height: 18, fontSize: 'calc(11px * var(--font-size-scale))' }}>{r.role_code}</span>
                        {r.role_name}
                        {r.role_code === 'admin' && <span style={{ color: '#94a3b8', marginLeft: 6, fontSize: 12 }}>（默认全权限，自动跳过）</span>}
                      </Checkbox>
                    ))}
                  </Checkbox.Group>
                </div>
              </div>
            </div>
          </div>

          <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span className="sys-step-no" style={{ width: 20, height: 20, borderRadius: '50%', background: '#5b5bd6', color: '#fff', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>4</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, marginBottom: 6 }}>授权模式 <span style={{ fontWeight: 400, color: '#94a3b8', fontSize: 'calc(12px * var(--font-size-scale))' }}>覆盖 = 目标角色将只保留本次所选权限</span></div>
                <Radio.Group value={bgMode} onChange={e => setBgMode(e.target.value)}>
                  <Radio value="grant">追加（并集）</Radio>
                  <Radio value="revoke">撤销</Radio>
                  <Radio value="replace">覆盖</Radio>
                </Radio.Group>
              </div>
            </div>
          </div>
        </div>
      </Modal>

      {/* 删除二次确认 */}
      <Modal
        title={<span style={{ color: '#dc2626' }}>删除角色</span>}
        open={!!deleteTarget}
        onOk={handleDeleteRole}
        confirmLoading={deleting}
        onCancel={() => setDeleteTarget(null)}
        okText={deleteTarget?.user_count ? '删除并收回用户权限' : '确认删除'}
        okButtonProps={{ danger: true }}
        cancelText="取消"
        width={480}
        rootClassName="sc-page"
      >
        <p style={{ fontSize: 'calc(13.5px * var(--font-size-scale))', color: '#475569', lineHeight: 1.8 }}>
          确认删除角色 <b style={{ color: '#0f172a' }}>{deleteTarget?.role_name}（{deleteTarget?.role_code}）</b>？
          {deleteTarget && deleteTarget.user_count > 0
            ? <>该角色当前分配给 <b style={{ color: '#dc2626' }}>{deleteTarget.user_count}</b> 名用户，删除前请先在「用户管理」中更换这些用户的角色（后端将拦截带用户的角色删除）。</>
            : <>删除后不可恢复，操作将记入审计日志。</>}
        </p>
        {deleteTarget && deleteTarget.user_count > 0 && (
          <div className="f-note" style={{ background: '#fffbeb', borderColor: '#fde68a', color: '#92400e' }}>
            提示：若仅是想临时收回权限，建议改用「权限」编辑矩阵，而非删除角色。
          </div>
        )}
      </Modal>
    </div>
  )
}
