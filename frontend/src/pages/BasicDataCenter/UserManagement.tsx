import { useState, useEffect, useRef, useCallback, useMemo, type Key, type ReactNode, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Table, Button, Modal, Form, Input, Select, message, Popconfirm,
  Row, Col, Drawer, Popover, Checkbox, Tooltip, Switch, Timeline,
  type TableColumnsType,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, KeyOutlined, ReloadOutlined,
  ExportOutlined, SyncOutlined, UserAddOutlined, SearchOutlined, TeamOutlined,
  LinkOutlined, ColumnHeightOutlined, SettingOutlined, ClearOutlined,
  FilterOutlined, ProfileOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import api, { userApi, wecomApi, type WecomUser } from '../../services/api'
import ExportColumnSelector, { type ExportColumnOption } from '../../components/ExportColumnSelector'
import { useExport } from '../../hooks/useExport'
import { formatDateTime } from '../../utils'
import { useAuthStore } from '../../store/auth'

// ===== 原型：docs/prototype/redesign/users.html（重设计 · 靛蓝精致版） =====

interface SupplierOption {
  supplier_code?: string
  supplier_name: string
  status: number
}

interface EmployeeOption {
  emp_code: string
  emp_name: string
  login_id?: string
  position_id?: number
  position_name?: string
  role_id?: number
  role_code?: string
  role_name?: string
  oa_user_id?: string
  manager_oa_user_id?: string
  status: number
}

const SUPPLIER_PAGE_SIZE = 100

interface RoleItem {
  id: number
  role_code: string
  role_name: string
  permissions: Record<string, string[]>
}

interface UserItem {
  id: number
  username: string
  display_name: string | null
  emp_code: string | null
  emp_name: string | null
  position_id: number | null
  position_name: string | null
  org_name: string | null
  manager_name: string | null
  role_id: number
  role_code: string
  role_name: string
  supplier_name: string | null
  wecom_user_id: string | null
  is_active: boolean
  is_default_password: boolean
  last_login_time: string | null
  created_at: string | null
  updated_at: string | null
}

interface UserStats {
  total: number
  active: number
  disabled: number
  employees: number
  suppliers: number
  default_password: number
  wecom_unbound: number
}

interface AuditItem {
  id: number
  action: string
  field_name: string | null
  old_value: string | null
  new_value: string | null
  operator: string | null
  operated_at: string | null
}

const USER_EXPORT_COLUMNS: ExportColumnOption[] = [
  { field: 'username', label: '用户名' },
  { field: 'display_name', label: '显示名称' },
  { field: 'emp_code', label: '员工工号' },
  { field: 'emp_name', label: '员工姓名' },
  { field: 'position_name', label: '岗位' },
  { field: 'org_name', label: '所属组织' },
  { field: 'manager_name', label: '上级' },
  { field: 'role_code', label: '角色编码' },
  { field: 'role_name', label: '角色名称' },
  { field: 'supplier_name', label: '绑定供应商' },
  { field: 'is_active', label: '状态' },
  { field: 'is_default_password', label: '默认密码' },
  { field: 'last_login_time', label: '最后登录' },
  { field: 'created_at', label: '创建时间' },
  { field: 'updated_at', label: '更新时间' },
]

// 角色 → 标签色（原型 .tag-role-*）
const ROLE_TAG: Record<string, string> = {
  admin: 'sc-tag-purple',
  planner: 'sc-tag-kit',
  purchaser: 'sc-tag-amber',
  manager: 'um-tag-mgr',
  purchase_manager: 'um-tag-pm',
  supplier: 'sc-tag-done',
}

// 角色 → 头像渐变（原型每行头像）
const ROLE_AVATAR: Record<string, string> = {
  admin: 'linear-gradient(135deg,#8b5cf6,#5b5bd6)',
  planner: 'linear-gradient(135deg,#7a7de6,#5b5bd6)',
  purchaser: 'linear-gradient(135deg,#f59e0b,#f43f5e)',
  manager: 'linear-gradient(135deg,#0ea5e9,#14b8a6)',
  purchase_manager: 'linear-gradient(135deg,#14b8a6,#0ea5e9)',
  supplier: 'linear-gradient(135deg,#10b981,#0ea5e9)',
}

const avatarChar = (u: UserItem) =>
  (u.display_name || u.emp_name || u.username || '?').trim().charAt(0).toUpperCase()

const renderRoleTag = (u: UserItem, onClick: () => void) => (
  <span
    className={`sc-tag ${ROLE_TAG[u.role_code] || 'sc-tag-plain'} um-role-link`}
    title="点击查看该角色"
    onClick={onClick}
  >
    {u.role_name}
  </span>
)

// 可隐藏列（用户 / 状态 / 操作 固定展示）
const OPTIONAL_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'pos', label: '岗位 / 组织 / 上级' },
  { key: 'role', label: '角色' },
  { key: 'supplier', label: '绑定供应商' },
  { key: 'wecom', label: '企业微信' },
  { key: 'last_login', label: '最后登录' },
  { key: 'created_at', label: '创建时间' },
]

const HIDDEN_COLS_KEY = 'users.hiddenCols.v1'
const DENSITY_KEY = 'users.density.v1'

function loadHiddenCols(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_COLS_KEY)
    const parsed = raw ? JSON.parse(raw) : ['created_at']
    return Array.isArray(parsed) ? parsed : ['created_at']
  } catch {
    return ['created_at']
  }
}

function loadDensity(): 'small' | 'middle' {
  return localStorage.getItem(DENSITY_KEY) === 'small' ? 'small' : 'middle'
}

// 审计字段 → 展示文案（抽屉操作记录）
const AUDIT_FIELD_LABEL: Record<string, string> = {
  password: '密码',
  is_active: '状态',
  role_id: '角色',
  display_name: '显示名称',
  emp_code: '关联员工',
  supplier_name: '绑定供应商',
  wecom_user_id: '企业微信',
  username: '用户名',
}

const auditTimelineItem = (log: AuditItem) => {
  let what = '修改账号'
  let color = '#5b5bd6'
  if (log.action === 'create') {
    what = '开通 / 创建账号'
    color = '#16a34a'
  } else if (log.action === 'delete') {
    what = '删除账号'
    color = '#dc2626'
  } else if (log.action === 'update') {
    const f = log.field_name || ''
    if (f === 'password') what = '重置密码'
    else if (f === 'is_active') {
      const disabled = log.new_value === 'False'
      what = disabled ? '停用账号' : '启用账号'
      color = disabled ? '#d97706' : '#16a34a'
    } else if (f === 'role_id') what = `变更角色（${log.old_value ?? '—'} → ${log.new_value ?? '—'}）`
    else if (f === 'wecom_user_id') what = log.new_value ? '绑定企业微信' : '解绑企业微信'
    else if (AUDIT_FIELD_LABEL[f]) what = `修改${AUDIT_FIELD_LABEL[f]}（${log.old_value ?? '—'} → ${log.new_value ?? '—'}）`
  }
  return { what, color }
}

const EMP_STATUS: Record<number, { text: string; cls: string }> = {
  0: { text: '试用期', cls: 'sc-tag-kit' },
  1: { text: '在职', cls: 'sc-tag-done' },
  2: { text: '兼职', cls: 'um-tag-mgr' },
  3: { text: '外派', cls: 'sc-tag-purple' },
  4: { text: '解聘', cls: 'sc-tag-danger' },
  5: { text: '离职', cls: 'sc-tag-danger' },
  6: { text: '退休', cls: 'um-tag-pm' },
  7: { text: '无效', cls: 'sc-tag-wait' },
}

export default function UserManagement() {
  const navigate = useNavigate()
  const { exporting, exportData } = useExport()
  const isAdmin = useAuthStore(s => s.isAdmin())
  const hasPermission = useAuthStore(s => s.hasPermission)

  // ===== 列表数据 =====
  const [users, setUsers] = useState<UserItem[]>([])
  const [loading, setLoading] = useState(false)
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [stats, setStats] = useState<UserStats>({ total: 0, active: 0, disabled: 0, employees: 0, suppliers: 0, default_password: 0, wecom_unbound: 0 })
  const [unprovTotal, setUnprovTotal] = useState(0)

  // ===== 筛选 =====
  const [searchText, setSearchText] = useState('')
  const [keyword, setKeyword] = useState('')
  const [userChip, setUserChip] = useState<'all' | 'employee' | 'supplier'>('all')
  const [activeFilter, setActiveFilter] = useState<boolean | null>(null)
  const [defPwdFilter, setDefPwdFilter] = useState<boolean | null>(null)
  const [roleFilter, setRoleFilter] = useState<string[]>([])
  const [orgFilter, setOrgFilter] = useState<string[]>([])
  const [positionFilter, setPositionFilter] = useState<string[]>([])
  const [supplierFilter, setSupplierFilter] = useState<string[]>([])
  const [sortBy, setSortBy] = useState<string | null>(null)
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')

  // ===== 选项数据 =====
  const [roles, setRoles] = useState<RoleItem[]>([])
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([])
  const [employeeLoading, setEmployeeLoading] = useState(false)
  const [supplierLoading, setSupplierLoading] = useState(false)
  const [wecomUsers, setWecomUsers] = useState<WecomUser[]>([])
  const employeeSearchTimer = useRef<number | undefined>(undefined)
  const supplierSearchTimer = useRef<number | undefined>(undefined)
  const supplierRequestSeq = useRef(0)

  // ===== 表格个性化 =====
  const [hiddenCols, setHiddenCols] = useState<string[]>(loadHiddenCols)
  const [density, setDensity] = useState<'small' | 'middle'>(loadDensity)

  // ===== 勾选 / 批量 =====
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  const [selectedMap, setSelectedMap] = useState<Record<number, UserItem>>({})
  const [isSelectAllFiltered, setIsSelectAllFiltered] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  const [confirmModalOpen, setConfirmModalOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'reset_password' | 'delete' | null>(null)
  const [confirmInput, setConfirmInput] = useState('')

  // ===== 详情抽屉 =====
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerUser, setDrawerUser] = useState<UserItem | null>(null)
  const [drawerAudit, setDrawerAudit] = useState<AuditItem[] | null>(null)
  const [drawerAuditLoading, setDrawerAuditLoading] = useState(false)

  // ===== 弹窗 =====
  const [modalOpen, setModalOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<UserItem | null>(null)
  const [pwdModalOpen, setPwdModalOpen] = useState(false)
  const [pwdUser, setPwdUser] = useState<UserItem | null>(null)
  const [exportColumnModalOpen, setExportColumnModalOpen] = useState(false)
  const [syncingRoles, setSyncingRoles] = useState(false)
  const [form] = Form.useForm()
  const [pwdForm] = Form.useForm()

  // ===== 批量开通员工 =====
  const [unprovLoading, setUnprovLoading] = useState(false)
  const [unprovEmployees, setUnprovEmployees] = useState<any[]>([])
  const [unprovTotalCount, setUnprovTotalCount] = useState(0)
  const [unprovSelected, setUnprovSelected] = useState<string[]>([])
  const [unprovPage, setUnprovPage] = useState(1)
  const [unprovPageSize, setUnprovPageSize] = useState(100)
  const [unprovKeyword, setUnprovKeyword] = useState('')
  const [unprovOrgFilter, setUnprovOrgFilter] = useState<string | undefined>()
  const [unprovPosFilter, setUnprovPosFilter] = useState<string | undefined>()
  const [unprovOrgOptions, setUnprovOrgOptions] = useState<string[]>([])
  const [unprovPosOptions, setUnprovPosOptions] = useState<string[]>([])
  const [provisionModalOpen, setProvisionModalOpen] = useState(false)
  const [provisioning, setProvisioning] = useState(false)

  // ===== 批量绑定企业微信 =====
  const [wecomMatchOpen, setWecomMatchOpen] = useState(false)
  const [wecomMatchLoading, setWecomMatchLoading] = useState(false)
  const [wecomMatchItems, setWecomMatchItems] = useState<any[]>([])
  const [wecomMatchStats, setWecomMatchStats] = useState({ matched: 0, ambiguous: 0, unmatched: 0 })
  const [wecomMatchSelected, setWecomMatchSelected] = useState<number[]>([])
  const [wecomMatchValues, setWecomMatchValues] = useState<Record<number, string>>({})
  const [wecomBindSaving, setWecomBindSaving] = useState(false)
  const [editingWecomId, setEditingWecomId] = useState<number | null>(null)
  const [savingWecomId, setSavingWecomId] = useState<number | null>(null)

  const selectedRoleId = Form.useWatch('role_id', form)
  const selectedEmpCode = Form.useWatch('emp_code', form)
  const selectedRole = roles.find(r => r.id === selectedRoleId)
  const isSupplierRole = selectedRole?.role_code === 'supplier'
  const selectedEmployee = employeeOptions.find(item => item.emp_code === selectedEmpCode)
  const hasPositionRole = !!selectedEmployee?.role_id
  const canEditWecom = hasPermission('users', 'update')
  const canAuditRead = hasPermission('audit', 'read')

  // ===== 查询参数 =====
  const buildParams = useCallback((page: number, pageSize: number) => {
    const p: Record<string, any> = { page, page_size: pageSize }
    if (keyword.trim()) p.keyword = keyword.trim()
    if (userChip === 'employee') p.user_type = 'employee'
    if (userChip === 'supplier') p.user_type = 'supplier'
    if (activeFilter !== null) p.is_active = activeFilter
    if (defPwdFilter !== null) p.is_default_password = defPwdFilter
    if (roleFilter.length) p.role_code = roleFilter.join(',')
    if (orgFilter.length) p.org_name = orgFilter.join(',')
    if (positionFilter.length) p.position_name = positionFilter.join(',')
    if (supplierFilter.length) p.supplier_name = supplierFilter.join(',')
    if (sortBy) {
      p.sort_by = sortBy
      p.sort_order = sortOrder
    }
    return p
  }, [keyword, userChip, activeFilter, defPwdFilter, roleFilter, orgFilter, positionFilter, supplierFilter, sortBy, sortOrder])

  // 「选中所有筛选结果」时批量操作的 filter 载荷
  const buildBatchFilter = useCallback(() => {
    const f: Record<string, any> = {}
    if (keyword.trim()) f.keyword = keyword.trim()
    if (userChip === 'employee') f.user_type = 'employee'
    if (userChip === 'supplier') f.user_type = 'supplier'
    if (activeFilter !== null) f.is_active = activeFilter
    if (defPwdFilter !== null) f.is_default_password = defPwdFilter
    if (roleFilter.length) f.role_code = roleFilter.join(',')
    if (orgFilter.length) f.org_name = orgFilter.join(',')
    if (positionFilter.length) f.position_name = positionFilter.join(',')
    if (supplierFilter.length) f.supplier_name = supplierFilter.join(',')
    return f
  }, [keyword, userChip, activeFilter, defPwdFilter, roleFilter, orgFilter, positionFilter, supplierFilter])

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await userApi.stats()
      const d = res?.data || {}
      setStats({
        total: d.total || 0,
        active: d.active || 0,
        disabled: d.disabled || 0,
        employees: d.employees || 0,
        suppliers: d.suppliers || 0,
        default_password: d.default_password || 0,
        wecom_unbound: d.wecom_unbound || 0,
      })
    } catch {
      // ignore
    }
    // 待开通员工计数（KPI）：轻量拉 total
    try {
      const res: any = await userApi.listUnprovisionedEmployees({ page: 1, page_size: 1 })
      setUnprovTotal(res?.data?.total || 0)
    } catch {
      // ignore
    }
  }, [])

  const fetchUsers = useCallback(async (page = 1, pageSize = 20) => {
    setLoading(true)
    try {
      const res: any = await userApi.list(buildParams(page, pageSize))
      const payload = res?.data
      if (Array.isArray(payload)) {
        setUsers(payload)
        setPagination(prev => ({ ...prev, current: page, total: payload.length }))
      } else {
        setUsers(payload?.items || [])
        setPagination({ current: payload?.page || page, pageSize: payload?.page_size || pageSize, total: payload?.total ?? 0 })
      }
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [buildParams])

  const refreshAll = useCallback(async () => {
    await fetchUsers(pagination.current, pagination.pageSize)
    await fetchStats()
  }, [fetchUsers, fetchStats, pagination])

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => setKeyword(searchText), 350)
    return () => clearTimeout(timer)
  }, [searchText])

  // 筛选变化回到第 1 页
  useEffect(() => {
    fetchUsers(1, pagination.pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, userChip, activeFilter, defPwdFilter, roleFilter, orgFilter, positionFilter, supplierFilter, sortBy, sortOrder])

  useEffect(() => {
    fetchStats()
    return () => {
      if (employeeSearchTimer.current) window.clearTimeout(employeeSearchTimer.current)
      if (supplierSearchTimer.current) window.clearTimeout(supplierSearchTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 选项数据 =====
  const fetchRoles = async () => {
    try {
      const res: any = await userApi.roles({ page_size: 500 })
      const payload = res.data
      setRoles(Array.isArray(payload) ? payload : payload?.items || [])
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const fetchEmployeeOptions = async (kw = '') => {
    setEmployeeLoading(true)
    try {
      const params: { keyword?: string } = {}
      if (kw.trim()) params.keyword = kw.trim()
      const res: any = await userApi.employeeOptions(params)
      setEmployeeOptions(res.data || [])
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setEmployeeLoading(false)
    }
  }

  const fetchWecomUsers = async () => {
    try {
      const res: any = await wecomApi.listUsers()
      setWecomUsers(res.data || [])
    } catch {
      // 企业微信未配置或网络异常：静默，下拉为空，校验由后端兜底
    }
  }

  const mergeSuppliers = (list: SupplierOption[]) => {
    const map = new Map<string, SupplierOption>()
    list.forEach(item => {
      if (item.supplier_name) map.set(item.supplier_name, item)
    })
    return Array.from(map.values())
  }

  const fetchSuppliers = async (kw = '') => {
    const requestSeq = ++supplierRequestSeq.current
    setSupplierLoading(true)
    try {
      const params: Record<string, any> = {
        page: 1,
        page_size: SUPPLIER_PAGE_SIZE,
        status: '1',
        sort_by: 'supplier_name',
        sort_order: 'asc',
      }
      if (kw.trim()) params.keyword = kw.trim()

      const firstRes: any = await api.get('/basicdata/suppliers', { params })
      const data = firstRes.data || {}
      let items: SupplierOption[] = data.items || []

      const total = data.total || items.length
      const totalPages = Math.ceil(total / SUPPLIER_PAGE_SIZE)
      for (let page = 2; page <= totalPages; page += 1) {
        const res: any = await api.get('/basicdata/suppliers', { params: { ...params, page } })
        items = [...items, ...(res.data?.items || [])]
      }

      if (requestSeq === supplierRequestSeq.current) {
        setSuppliers(prev => (kw.trim() ? mergeSuppliers([...prev, ...items]) : mergeSuppliers(items)))
      }
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      if (requestSeq === supplierRequestSeq.current) {
        setSupplierLoading(false)
      }
    }
  }

  const handleSupplierSearch = (kw: string) => {
    if (supplierSearchTimer.current) window.clearTimeout(supplierSearchTimer.current)
    supplierSearchTimer.current = window.setTimeout(() => {
      fetchSuppliers(kw)
    }, 300)
  }

  const handleEmployeeSearch = (kw: string) => {
    if (employeeSearchTimer.current) window.clearTimeout(employeeSearchTimer.current)
    employeeSearchTimer.current = window.setTimeout(() => {
      fetchEmployeeOptions(kw)
    }, 300)
  }

  useEffect(() => {
    fetchRoles()
    fetchEmployeeOptions()
    fetchSuppliers()
    fetchWecomUsers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 新增 / 编辑 =====
  const openAdd = () => {
    setEditingUser(null)
    form.resetFields()
    form.setFieldsValue({ is_active: true })
    setModalOpen(true)
  }

  const openEdit = (record: UserItem) => {
    setEditingUser(record)
    form.setFieldsValue({
      username: record.username,
      display_name: record.display_name,
      emp_code: record.emp_code,
      role_id: record.role_id,
      supplier_name: record.supplier_name,
      wecom_user_id: record.wecom_user_id,
      is_active: record.is_active,
    })
    if (record.emp_code && !employeeOptions.some(item => item.emp_code === record.emp_code)) {
      setEmployeeOptions(prev => [
        ...prev,
        {
          emp_code: record.emp_code!,
          emp_name: record.emp_name || record.display_name || record.emp_code!,
          position_id: record.position_id || undefined,
          position_name: record.position_name || undefined,
          role_id: record.role_id,
          role_code: record.role_code,
          role_name: record.role_name,
          status: record.is_active ? 1 : 5,
        },
      ])
    }
    setModalOpen(true)
  }

  const handleEmployeeChange = (empCode?: string) => {
    if (!empCode) {
      form.setFieldsValue({ emp_code: undefined, role_id: undefined })
      return
    }
    const employee = employeeOptions.find(item => item.emp_code === empCode)
    if (!employee) {
      form.setFieldsValue({ emp_code: empCode })
      return
    }
    form.setFieldsValue({
      emp_code: employee.emp_code,
      display_name: employee.emp_name,
      role_id: employee.role_id || undefined,
    })
    if (!editingUser) {
      form.setFieldsValue({
        username: employee.login_id || employee.emp_code,
        password: employee.emp_code,
      })
    }
    if (!employee.role_id) {
      message.warning('该员工岗位暂未绑定角色，请手动选择角色')
    }
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      if (editingUser) {
        await userApi.update(editingUser.id, {
          display_name: values.display_name,
          role_id: values.role_id,
          emp_code: values.emp_code,
          supplier_name: values.supplier_name,
          wecom_user_id: values.wecom_user_id,
          is_active: values.is_active,
        })
        message.success('更新成功')
      } else {
        await userApi.create(values)
        message.success('创建成功')
      }
      setModalOpen(false)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await userApi.delete(id)
      message.success('已删除')
      if (drawerOpen) setDrawerOpen(false)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  // ===== 重置密码 =====
  const openResetPwd = (record: UserItem) => {
    setPwdUser(record)
    pwdForm.resetFields()
    setPwdModalOpen(true)
  }

  const handleResetPwd = async () => {
    try {
      const values = await pwdForm.validateFields()
      if (!pwdUser) return
      await userApi.resetPassword(pwdUser.id, values.new_password)
      message.success(`已重置 ${pwdUser.username} 的密码`)
      setPwdModalOpen(false)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const handleToggleActive = async (record: UserItem) => {
    try {
      await userApi.update(record.id, { is_active: !record.is_active })
      message.success(record.is_active ? '已停用（该账号在线会话已强制下线）' : '已启用')
      if (drawerUser?.id === record.id) {
        setDrawerUser({ ...record, is_active: !record.is_active })
      }
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  // ===== 行内企微绑定 =====
  const handleInlineWecomSave = async (userId: number, newValue: string | null) => {
    setSavingWecomId(userId)
    try {
      await userApi.update(userId, { wecom_user_id: newValue ?? undefined })
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, wecom_user_id: newValue } : u)))
      message.success(newValue ? '企业微信已更新' : '已解绑企业微信')
    } catch {
      // 本地未变，关闭编辑器即恢复旧值；全局拦截器已 toast 错误
    } finally {
      setSavingWecomId(null)
      setEditingWecomId(null)
    }
  }

  // ===== 导出 =====
  const handleExportUsers = (selectedColumns: string[]) => {
    const params = buildParams(1, 20)
    delete params.page
    delete params.page_size
    params.format = 'xlsx'
    params.columns = selectedColumns.join(',')
    setExportColumnModalOpen(false)
    exportData('/api/v1/basicdata/users/export', params, '用户管理.xlsx')
  }

  // ===== 同步角色 =====
  const handleSyncRoles = async () => {
    setSyncingRoles(true)
    try {
      const res: any = await userApi.syncRoles()
      const data = res?.data
      const parts = [`共检查 ${data?.total ?? 0} 个用户，更新 ${data?.updated ?? 0} 个用户角色`]
      if (data?.created) parts.push(`新建 ${data.created} 个角色`)
      message.success(`同步完成：${parts.join('，')}`)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setSyncingRoles(false)
    }
  }

  // ===== 详情抽屉 =====
  const openDrawer = async (record: UserItem) => {
    setDrawerUser(record)
    setDrawerOpen(true)
    setDrawerAudit(null)
    if (!canAuditRead) return
    setDrawerAuditLoading(true)
    try {
      const res: any = await api.get('/basicdata/audit/logs', {
        params: { table_name: 'sys_user', record_id: record.id, page_size: 20, sort_by: 'operated_at', sort_order: 'desc' },
      })
      setDrawerAudit(res.data?.items || [])
    } catch {
      setDrawerAudit([])
    } finally {
      setDrawerAuditLoading(false)
    }
  }

  // ===== 批量开通 =====
  const fetchUnprovisioned = async (opts?: { page?: number; pageSize?: number; keyword?: string; orgName?: string; positionName?: string }) => {
    setUnprovLoading(true)
    try {
      const p = opts?.page ?? unprovPage
      const ps = opts?.pageSize ?? unprovPageSize
      const kw = opts?.keyword !== undefined ? opts?.keyword : unprovKeyword
      const orgName = opts?.orgName !== undefined ? opts?.orgName : unprovOrgFilter
      const posName = opts?.positionName !== undefined ? opts?.positionName : unprovPosFilter
      const params: Record<string, any> = { page: p, page_size: ps }
      if (kw?.trim()) params.keyword = kw.trim()
      if (orgName) params.org_name = orgName
      if (posName) params.position_name = posName
      const res: any = await userApi.listUnprovisionedEmployees(params)
      const data = res?.data || {}
      setUnprovEmployees(data.items || [])
      setUnprovTotalCount(data.total || 0)
      setUnprovOrgOptions(data.org_options || [])
      setUnprovPosOptions(data.position_options || [])
    } catch {
      // message.error('加载待开通员工列表失败')
    } finally {
      setUnprovLoading(false)
    }
  }

  const handleOpenProvision = () => {
    setUnprovSelected([])
    setUnprovKeyword('')
    setUnprovOrgFilter(undefined)
    setUnprovPosFilter(undefined)
    setProvisionModalOpen(true)
    fetchUnprovisioned({ page: 1, pageSize: unprovPageSize, keyword: '', orgName: undefined, positionName: undefined })
  }

  const handleBatchProvision = async () => {
    if (unprovSelected.length === 0) {
      message.warning('请选择至少一名员工')
      return
    }
    setProvisioning(true)
    try {
      const res: any = await userApi.batchProvision({
        emp_codes: unprovSelected,
        // role_id 不传 — 后端自动按员工岗位 + 组织匹配
      })
      const data = res?.data || {}
      const created = data.created || 0
      const skipped = data.skipped || 0
      const errors = data.errors || []
      const defaultPwd = data.default_password || '默认密码'
      const parts = [`成功开通 ${created} 个用户`]
      if (skipped > 0) parts.push(`跳过 ${skipped} 个已存在用户`)
      parts.push(`默认密码：${defaultPwd}`)
      if (errors.length > 0) {
        parts.push(`${errors.length} 条异常（详情见日志）`)
        message.warning(parts.join('，'))
      } else {
        message.success(parts.join('，'))
      }
      setProvisionModalOpen(false)
      setUnprovSelected([])
      refreshAll()
    } catch {
      // error handled by interceptor
    } finally {
      setProvisioning(false)
    }
  }

  // ===== 批量绑定企微 =====
  const handleOpenWecomMatch = async () => {
    setWecomMatchOpen(true)
    setWecomMatchLoading(true)
    try {
      const res: any = await userApi.wecomMatch()
      const data = res?.data || {}
      const items: any[] = data.items || []
      setWecomMatchItems(items)
      setWecomMatchStats(data.stats || { matched: 0, ambiguous: 0, unmatched: 0 })
      setWecomMatchSelected(items.filter((it: any) => it.match_status === 'matched').map((it: any) => it.user_id))
      const vals: Record<number, string> = {}
      items.forEach((it: any) => { if (it.suggested_wecom_userid) vals[it.user_id] = it.suggested_wecom_userid })
      setWecomMatchValues(vals)
    } catch {
      // 全局拦截器已 toast
    } finally {
      setWecomMatchLoading(false)
    }
  }

  const handleBatchBindWecom = async () => {
    const bindings = wecomMatchSelected
      .map(uid => ({ user_id: uid, wecom_user_id: wecomMatchValues[uid] }))
      .filter(b => b.wecom_user_id)
    if (bindings.length === 0) {
      message.warning('请勾选并选择企业微信账号')
      return
    }
    setWecomBindSaving(true)
    try {
      const res: any = await userApi.batchBindWecom(bindings)
      const data = res?.data || {}
      const updated = data.updated || 0
      const errs = data.errors || []
      if (errs.length) {
        message.warning(`成功绑定 ${updated} 个，${errs.length} 条失败：${errs[0]?.message || ''}`)
      } else {
        message.success(`成功绑定 ${updated} 个用户`)
      }
      setWecomMatchOpen(false)
      refreshAll()
    } catch {
      // 全局拦截器已 toast
    } finally {
      setWecomBindSaving(false)
    }
  }

  // ===== 批量操作 =====
  const openConfirmModal = (action: 'reset_password' | 'delete') => {
    setConfirmAction(action)
    setConfirmInput('')
    setConfirmModalOpen(true)
  }

  const buildBatchPayload = () => {
    const payload: any = {}
    if (isSelectAllFiltered) {
      const f = buildBatchFilter()
      if (Object.keys(f).length) payload.filter = f
    } else {
      if (!selectedRowKeys.length) {
        message.warning('请先选择用户')
        return null
      }
      payload.user_ids = selectedRowKeys
    }
    return payload
  }

  const handleConfirmOk = () => {
    const expected = confirmAction === 'delete' ? '删除' : '重置'
    if (confirmInput !== expected) {
      message.warning(`请输入"${expected}"以确认操作`)
      return
    }
    setConfirmModalOpen(false)
    if (confirmAction === 'delete') {
      handleBatchDelete()
    } else {
      handleBatchResetPassword()
    }
  }

  const afterBatch = () => {
    setSelectedRowKeys([])
    setSelectedMap({})
    setIsSelectAllFiltered(false)
    refreshAll()
  }

  const handleBatchToggleActive = async (isActive: boolean) => {
    const payload = buildBatchPayload()
    if (!payload) return
    setBatchLoading(true)
    try {
      payload.is_active = isActive
      const res: any = await userApi.batchToggleActive(payload)
      const data = res?.data
      message.success(`已${data?.action} ${data?.updated ?? 0} 个用户`)
      afterBatch()
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setBatchLoading(false)
    }
  }

  const handleBatchResetPassword = async () => {
    const payload = buildBatchPayload()
    if (!payload) return
    setBatchLoading(true)
    try {
      const res: any = await userApi.batchResetPassword(payload)
      const data = res?.data
      message.success(`已重置 ${data?.updated ?? 0} 个用户密码，默认密码：${data?.default_password ?? 'admin123'}`)
      afterBatch()
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setBatchLoading(false)
    }
  }

  const handleBatchDelete = async () => {
    const payload = buildBatchPayload()
    if (!payload) return
    setBatchLoading(true)
    try {
      const res: any = await userApi.batchDelete(payload)
      const data = res?.data
      message.success(`已删除 ${data?.deleted ?? 0} 个用户`)
      afterBatch()
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setBatchLoading(false)
    }
  }

  // ===== 表格个性化 =====
  const toggleHiddenCol = (keys: string[]) => {
    setHiddenCols(keys)
    try {
      localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify(keys))
    } catch {
      // ignore
    }
  }

  const toggleDensity = () => {
    const next = density === 'small' ? 'middle' : 'small'
    setDensity(next)
    try {
      localStorage.setItem(DENSITY_KEY, next)
    } catch {
      // ignore
    }
  }

  // ===== chips =====
  const chipOn = (key: string) => {
    if (key === 'all') return userChip === 'all' && activeFilter === null && defPwdFilter === null
    if (key === 'employee') return userChip === 'employee'
    if (key === 'supplier') return userChip === 'supplier'
    if (key === 'on') return activeFilter === true
    if (key === 'off') return activeFilter === false
    if (key === 'def') return defPwdFilter === true
    return false
  }

  const handleChipClick = (key: string) => {
    setUserChip(key === 'employee' || key === 'supplier' ? key : 'all')
    setActiveFilter(key === 'on' ? true : key === 'off' ? false : null)
    setDefPwdFilter(key === 'def' ? true : null)
  }

  const clearSelection = () => {
    setSelectedRowKeys([])
    setSelectedMap({})
    setIsSelectAllFiltered(false)
  }

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[], rows: UserItem[]) => {
      setSelectedRowKeys(keys)
      setIsSelectAllFiltered(false)
      const byKey = new Map(rows.map((r) => [r.id, r]))
      setSelectedMap(prev => {
        const next: Record<number, UserItem> = {}
        for (const k of keys) {
          const u = byKey.get(Number(k)) ?? prev[Number(k)]
          if (u) next[Number(k)] = u
        }
        return next
      })
    },
  }

  // 列 key → 后端 sort_by 映射
  const SORT_KEY_MAP: Record<string, string> = {
    user: 'username',
    pos: 'position_name',
    role: 'role_code',
    supplier: 'supplier_name',
    last_login: 'last_login_time',
    created_at: 'created_at',
  }

  const handleTableChange = (_pg: any, _filters: any, sorter: any) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter
    if (s?.order && SORT_KEY_MAP[s.columnKey]) {
      setSortBy(SORT_KEY_MAP[s.columnKey])
      setSortOrder(s.order === 'ascend' ? 'asc' : 'desc')
    } else {
      setSortBy(null)
    }
  }

  const sortOrderOf = (key: string) =>
    sortBy === SORT_KEY_MAP[key] ? (sortOrder === 'asc' ? 'ascend' as const : 'descend' as const) : null

  const wecomNameOf = (userid: string | null) =>
    userid ? (wecomUsers.find(w => w.userid === userid)?.name ?? userid) : null

  // ===== 表格列 =====
  const baseColumns: TableColumnsType<UserItem> = [
    {
      title: '用户',
      dataIndex: 'username',
      key: 'user',
      width: 210,
      sorter: true,
      sortOrder: sortOrderOf('user'),
      render: (_: any, record: UserItem) => (
        <div className="um-usr">
          <span
            className={`um-avatar${record.is_active ? '' : ' off'}`}
            style={{ background: ROLE_AVATAR[record.role_code] || 'linear-gradient(135deg,#7a7de6,#5b5bd6)' }}
          >
            {avatarChar(record)}
          </span>
          <div>
            <div className={`um-usr-name${record.is_active ? '' : ' off'}`}>{record.username}</div>
            <div className="sc-mat-code">
              {record.role_code === 'supplier'
                ? (record.display_name || '供应商账号')
                : [record.display_name || record.emp_name, record.emp_code].filter(Boolean).join(' · ') || '未关联员工'}
            </div>
          </div>
        </div>
      ),
    },
    {
      title: '岗位 / 组织',
      key: 'pos',
      width: 200,
      sorter: true,
      sortOrder: sortOrderOf('pos'),
      render: (_: any, record: UserItem) => (
        <div>
          <div className={`um-pos-top${record.is_active ? '' : ' off'}`}>{record.position_name || '—'}</div>
          <div className="um-pos-sub">
            {record.role_code === 'supplier'
              ? '外部供应商'
              : [record.org_name, record.manager_name ? `上级 ${record.manager_name}` : null].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role_code',
      key: 'role',
      width: 110,
      sorter: true,
      sortOrder: sortOrderOf('role'),
      render: (_: any, record: UserItem) => renderRoleTag(record, () => navigate(`/roles?role_code=${encodeURIComponent(record.role_code)}`)),
    },
    {
      title: '绑定供应商',
      dataIndex: 'supplier_name',
      key: 'supplier',
      width: 180,
      sorter: true,
      sortOrder: sortOrderOf('supplier'),
      render: (v: string | null) => v || <span className="sc-note">—</span>,
    },
    {
      title: '企业微信',
      dataIndex: 'wecom_user_id',
      key: 'wecom',
      width: 170,
      render: (v: string | null, record: UserItem) => {
        if (canEditWecom && editingWecomId === record.id) {
          return (
            <Select
              autoFocus
              defaultOpen
              showSearch
              allowClear
              size="small"
              style={{ width: '100%' }}
              placeholder="搜索选择账号"
              optionFilterProp="label"
              defaultValue={v ?? undefined}
              options={wecomUsers.map(u => ({ value: u.userid, label: `${u.name} (${u.userid})` }))}
              loading={savingWecomId === record.id}
              onBlur={() => { if (savingWecomId !== record.id) setEditingWecomId(null) }}
              onChange={(nv) => handleInlineWecomSave(record.id, (nv as string) || null)}
              notFoundContent="未加载到通讯录"
            />
          )
        }
        const text = v
          ? <span>{wecomNameOf(v)} <span style={{ color: '#94a3b8' }}>({v})</span></span>
          : <span className="sc-note">{canEditWecom ? '—（点击绑定）' : '—'}</span>
        if (!canEditWecom) return text
        return (
          <span className="um-we-edit" title="点击修改" onClick={() => setEditingWecomId(record.id)}>
            {text}
          </span>
        )
      },
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 150,
      render: (v: boolean, record: UserItem) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Switch size="small" checked={v} onChange={() => handleToggleActive(record)} />
          {record.is_default_password && <span className="um-mini-def">默认密码</span>}
        </span>
      ),
    },
    {
      title: '最后登录',
      dataIndex: 'last_login_time',
      key: 'last_login',
      width: 130,
      sorter: true,
      sortOrder: sortOrderOf('last_login'),
      className: 'sc-mono',
      render: (v: string | null) => (v ? formatDateTime(v) : <span className="sc-note">从未登录</span>),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 130,
      sorter: true,
      sortOrder: sortOrderOf('created_at'),
      className: 'sc-mono',
      render: (v: string | null) => (v ? formatDateTime(v) : '—'),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      fixed: 'right' as const,
      render: (_: any, record: UserItem) => (
        <span className="sc-row-act">
          <Button type="text" size="small" icon={<ProfileOutlined />} onClick={() => openDrawer(record)}>详情</Button>
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          {hasPermission('users.reset_password', 'reset_password') && (
            <Button type="text" size="small" icon={<KeyOutlined />} title="重置密码" onClick={() => openResetPwd(record)}>重置密码</Button>
          )}
          {isAdmin && (
            <Popconfirm title="确认删除该用户？" onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消">
              <Button type="text" size="small" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
        </span>
      ),
    },
  ]

  const columns = baseColumns.filter(c => !c.key || !hiddenCols.includes(String(c.key)))

  const summaryRow = (rows: UserItem[]) => {
    const suppliers = rows.filter(u => u.role_code === 'supplier').length
    const active = rows.filter(u => u.is_active).length
    const defPwd = rows.filter(u => u.is_default_password).length
    const wecomUnbound = rows.filter(u => !u.wecom_user_id).length
    return `本页 ${rows.length} 项 · 员工 ${rows.length - suppliers} / 供应商 ${suppliers} · 启用 ${active} · 停用 ${rows.length - active} · 默认密码 ${defPwd} · 企微未绑 ${wecomUnbound}`
  }

  // ===== 更多筛选浮层 =====
  const orgOptions = useMemo(() => Array.from(new Set(users.map(u => u.org_name).filter(Boolean))) as string[], [users])
  const positionOptions = useMemo(() => Array.from(new Set(users.map(u => u.position_name).filter(Boolean))) as string[], [users])
  const supplierNameOptions = useMemo(() => Array.from(new Set(users.map(u => u.supplier_name).filter(Boolean))) as string[], [users])
  const advFilterActive = roleFilter.length + orgFilter.length + positionFilter.length + supplierFilter.length > 0

  const advFilterContent = (
    <div style={{ width: 260, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div className="sc-meta-k">角色</div>
        <Select
          mode="multiple"
          allowClear
          style={{ width: '100%' }}
          placeholder="全部角色"
          value={roleFilter}
          onChange={setRoleFilter}
          options={roles.map(r => ({ label: r.role_name, value: r.role_code }))}
          maxTagCount="responsive"
        />
      </div>
      <div>
        <div className="sc-meta-k">岗位</div>
        <Select
          mode="tags"
          allowClear
          style={{ width: '100%' }}
          placeholder="输入或选择岗位"
          value={positionFilter}
          onChange={setPositionFilter}
          options={positionOptions.map(v => ({ label: v, value: v }))}
          maxTagCount="responsive"
        />
      </div>
      <div>
        <div className="sc-meta-k">所属组织</div>
        <Select
          mode="tags"
          allowClear
          style={{ width: '100%' }}
          placeholder="输入或选择组织"
          value={orgFilter}
          onChange={setOrgFilter}
          options={orgOptions.map(v => ({ label: v, value: v }))}
          maxTagCount="responsive"
        />
      </div>
      <div>
        <div className="sc-meta-k">绑定供应商</div>
        <Select
          mode="tags"
          allowClear
          style={{ width: '100%' }}
          placeholder="输入或选择供应商"
          value={supplierFilter}
          onChange={setSupplierFilter}
          options={supplierNameOptions.map(v => ({ label: v, value: v }))}
          maxTagCount="responsive"
        />
      </div>
      <Button
        size="small"
        type="text"
        disabled={!advFilterActive}
        onClick={() => { setRoleFilter([]); setOrgFilter([]); setPositionFilter([]); setSupplierFilter([]) }}
      >
        清空高级筛选
      </Button>
    </div>
  )

  const colSettingsContent = (
    <div style={{ minWidth: 160 }}>
      <Checkbox.Group
        value={OPTIONAL_COLUMNS.filter(c => !hiddenCols.includes(c.key)).map(c => c.key)}
        onChange={(keys) => toggleHiddenCol(OPTIONAL_COLUMNS.filter(c => !keys.includes(c.key)).map(c => c.key))}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {OPTIONAL_COLUMNS.map(c => (
            <Checkbox key={c.key} value={c.key}>{c.label}</Checkbox>
          ))}
        </div>
      </Checkbox.Group>
      <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => toggleHiddenCol(['created_at'])}>恢复默认</Button>
        <span className="sc-note">用户 / 状态 / 操作 固定展示</span>
      </div>
    </div>
  )

  const chipsDef: Array<{ key: string; label: string; count: number; danger?: boolean }> = [
    { key: 'all', label: '全部', count: stats.total },
    { key: 'employee', label: '员工', count: stats.employees },
    { key: 'supplier', label: '供应商', count: stats.suppliers },
    { key: 'on', label: '启用', count: stats.active },
    { key: 'off', label: '停用', count: stats.disabled },
    { key: 'def', label: '默认密码', count: stats.default_password, danger: stats.default_password > 0 },
  ]

  const kpis: Array<{
    key: string
    label: string
    value: number
    icon: ReactNode
    accent: string
    accentBg: string
    sub?: ReactNode
    go?: string
    danger?: boolean
    onClick: () => void
  }> = [
    {
      key: 'total', label: '用户总数', value: stats.total,
      icon: <TeamOutlined />, accent: '#5b5bd6', accentBg: '#eef0fe',
      sub: <span className="um-kpi-sub">员工 {stats.employees} · 供应商 {stats.suppliers}</span>,
      onClick: () => handleChipClick('all'),
    },
    {
      key: 'active', label: '启用中', value: stats.active,
      icon: <CheckCircleOutlined />, accent: '#16a34a', accentBg: '#f0fdf4',
      sub: <span className="um-kpi-sub">停用 {stats.disabled}（含离职交接）</span>,
      onClick: () => handleChipClick('on'),
    },
    {
      key: 'provision', label: '待开通员工', value: unprovTotal,
      icon: <UserAddOutlined />, accent: '#d97706', accentBg: '#fffbeb',
      go: 'ERP 在职未开通 · 点击开通 →',
      onClick: () => { if (hasPermission('users', 'create')) handleOpenProvision() },
    },
    {
      key: 'wecom', label: '企微未绑定', value: stats.wecom_unbound,
      icon: <LinkOutlined />, accent: '#0284c7', accentBg: '#f0f9ff',
      go: '点击批量绑定 →',
      onClick: () => { if (hasPermission('users', 'update')) handleOpenWecomMatch() },
    },
    {
      key: 'defpwd', label: '默认密码未改', value: stats.default_password,
      icon: <KeyOutlined />, accent: '#dc2626', accentBg: '#fef2f2',
      go: '安全隐患 · 点击筛选 →', danger: true,
      onClick: () => handleChipClick('def'),
    },
  ]

  const batchHint = isSelectAllFiltered
    ? `已选中所有筛选结果（共 ${pagination.total} 个用户）`
    : `已选 ${selectedRowKeys.length} 项（跨页保留）`

  return (
    <div className="sc-page" style={{ paddingBottom: selectedRowKeys.length > 0 || isSelectAllFiltered ? 72 : 0 }}>
      {/* ===== KPI 带（原型：把驱动动作的数字放到最前面） ===== */}
      <div className="um-kpi-band">
        {kpis.map(k => (
          <div
            key={k.key}
            className={`sc-stat-card um-kpi${k.danger ? ' danger' : ''}`}
            style={{ '--accent': k.accent, '--accent-bg': k.accentBg } as CSSProperties}
            onClick={k.onClick}
            title="点击直达对应操作"
          >
            <span className="sc-stat-icon">{k.icon}</span>
            <span className="sc-stat-main">
              <span className="sc-stat-label">{k.label}</span>
              <span className="sc-stat-value">{k.value}</span>
              {k.sub}
              {k.go && <span className="um-kpi-go">{k.go}</span>}
            </span>
          </div>
        ))}
      </div>

      {/* ===== 工具栏：搜索 + chips + 动作 ===== */}
      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="用户名 / 显示名 / 工号 / 姓名"
            style={{ width: 250 }}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </span>
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {chipsDef.map(chip => (
            <span
              key={chip.key}
              className={`sc-chip${chipOn(chip.key) ? ' on' : ''}`}
              style={
                chip.key === 'def' && chipOn('def')
                  ? { background: '#fef2f2', borderColor: '#fecaca', color: '#dc2626', fontWeight: 500 }
                  : undefined
              }
              onClick={() => handleChipClick(chip.key)}
            >
              {chip.label} <span className="n" style={chip.danger && !chipOn(chip.key) ? { color: '#dc2626', opacity: 1, fontWeight: 600 } : undefined}>{chip.count.toLocaleString()}</span>
            </span>
          ))}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Popover content={advFilterContent} trigger="click" placement="bottomLeft" title="更多筛选">
            <Button icon={<FilterOutlined />} type={advFilterActive ? 'primary' : 'default'}>更多筛选</Button>
          </Popover>
          <Tooltip title="紧凑密度">
            <Button icon={<ColumnHeightOutlined />} onClick={toggleDensity} type={density === 'small' ? 'primary' : 'default'} />
          </Tooltip>
          <Popover content={colSettingsContent} trigger="click" placement="bottomRight" title="列设置">
            <Button icon={<SettingOutlined />} />
          </Popover>
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={refreshAll} />
          </Tooltip>
          <span style={{ width: 1, height: 20, background: '#e2e8f0' }} />
          <Tooltip title="按 ERP 岗位→角色映射刷新全部用户角色">
            <Button icon={<SyncOutlined />} loading={syncingRoles} onClick={handleSyncRoles}>同步角色</Button>
          </Tooltip>
          <Button icon={<ExportOutlined />} loading={exporting} onClick={() => setExportColumnModalOpen(true)}>导出</Button>
          {hasPermission('users', 'create') && (
            <Button icon={<UserAddOutlined />} onClick={handleOpenProvision}>
              批量开通 {unprovTotal > 0 && <span className="sc-tag sc-tag-amber" style={{ marginLeft: 4 }}>{unprovTotal}</span>}
            </Button>
          )}
          {hasPermission('users', 'update') && (
            <Button icon={<LinkOutlined />} onClick={handleOpenWecomMatch}>
              绑定企微 {stats.wecom_unbound > 0 && <span className="sc-tag sc-tag-kit" style={{ marginLeft: 4 }}>{stats.wecom_unbound}</span>}
            </Button>
          )}
          {isAdmin && <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>新增用户</Button>}
        </span>
      </div>

      {/* ===== 用户表 ===== */}
      <div className={`sc-card${density === 'small' ? ' um-dense' : ''}`} style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={users}
          loading={loading}
          size={density}
          scroll={{ x: 1500 }}
          rowSelection={rowSelection}
          onChange={handleTableChange}
          pagination={{
            ...pagination,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
            onChange: (page, pageSize) => fetchUsers(page, pageSize),
            pageSizeOptions: ['20', '50', '100'],
          }}
          summary={() =>
            users.length ? (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={columns.length + 1}>{summaryRow(users)}</Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            ) : null
          }
        />
      </div>

      {/* ===== 批量操作条（勾选后浮起） ===== */}
      {(selectedRowKeys.length > 0 || isSelectAllFiltered) && (
        <div className="sc-batch-bar">
          <span className="bb-n">{isSelectAllFiltered ? batchHint : <>已选 <b>{selectedRowKeys.length}</b> 项（跨页保留）</>}</span>
          {!isSelectAllFiltered && (
            <a
              style={{ fontSize: 'calc(12.5px * var(--font-size-scale))', color: '#4c4dc2', cursor: 'pointer', padding: '2px 6px', borderRadius: 5 }}
              onClick={() => {
                setIsSelectAllFiltered(true)
                setSelectedRowKeys([])
                setSelectedMap({})
                message.info('已选中所有筛选结果，批量操作将应用到全部符合条件的用户')
              }}
            >
              选择全部筛选结果（{pagination.total}）
            </a>
          )}
          <span className="bb-sep" />
          <Button size="small" loading={batchLoading} onClick={() => handleBatchToggleActive(true)}>批量启用</Button>
          <Button size="small" loading={batchLoading} onClick={() => handleBatchToggleActive(false)}>批量停用</Button>
          {hasPermission('users.reset_password', 'reset_password') && (
            <Button size="small" icon={<KeyOutlined />} loading={batchLoading} onClick={() => openConfirmModal('reset_password')}>批量重置密码</Button>
          )}
          {isAdmin && (
            <Button
              size="small"
              icon={<DeleteOutlined />}
              loading={batchLoading}
              style={{ background: '#fef2f2', color: '#dc2626', borderColor: '#fecaca' }}
              onClick={() => openConfirmModal('delete')}
            >
              批量删除
            </Button>
          )}
          <span className="bb-sep" />
          <Button size="small" type="text" icon={<ClearOutlined />} onClick={clearSelection}>清除选择</Button>
        </div>
      )}

      {/* ===== 详情抽屉（原型：基本信息 / 登录与安全 / 企业微信 / 操作记录） ===== */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
        rootClassName="sc-page"
        className="sc-drawer"
        styles={{ body: { padding: 0 } }}
        title={
          drawerUser ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                className={`um-avatar lg${drawerUser.is_active ? '' : ' off'}`}
                style={{ background: ROLE_AVATAR[drawerUser.role_code] || 'linear-gradient(135deg,#7a7de6,#5b5bd6)' }}
              >
                {avatarChar(drawerUser)}
              </span>
              <div>
                <div>{drawerUser.username} · {drawerUser.display_name || drawerUser.emp_name || '—'}</div>
                <div className="sc-mat-code">
                  用户ID {drawerUser.id}
                  {drawerUser.emp_code ? ` · 工号 ${drawerUser.emp_code}` : ' · 供应商账号'}
                </div>
              </div>
            </div>
          ) : '用户详情'
        }
        extra={
          drawerUser && (
            <span style={{ display: 'inline-flex', gap: 2 }}>
              <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(drawerUser)}>编辑</Button>
              {hasPermission('users.reset_password', 'reset_password') && (
                <Button type="text" size="small" icon={<KeyOutlined />} onClick={() => openResetPwd(drawerUser)}>重置密码</Button>
              )}
              <Button type="text" size="small" onClick={() => handleToggleActive(drawerUser)}>
                {drawerUser.is_active ? '停用' : '启用'}
              </Button>
              {isAdmin && (
                <Popconfirm title="确认删除该用户？" onConfirm={() => handleDelete(drawerUser.id)} okText="确认" cancelText="取消">
                  <Button type="text" size="small" danger icon={<DeleteOutlined />}>删除</Button>
                </Popconfirm>
              )}
            </span>
          )
        }
      >
        {drawerUser && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '12px 20px 0' }}>
              {renderRoleTag(drawerUser, () => navigate(`/roles?role_code=${encodeURIComponent(drawerUser.role_code)}`))}
              <span className={`sc-tag ${drawerUser.is_active ? 'sc-tag-done' : 'sc-tag-wait'}`}><span className="dot" />{drawerUser.is_active ? '启用' : '停用'}</span>
              <span className="sc-tag sc-tag-plain">{drawerUser.role_code === 'supplier' ? '外部供应商' : '内部员工'}</span>
              {drawerUser.is_default_password && <span className="sc-tag sc-tag-amber">默认密码未改</span>}
            </div>

            <div className="d-sec" style={{ marginTop: 12 }}>
              <h4>基本信息</h4>
              <dl className="d-kv">
                <dt>用户名</dt><dd className="sc-mono">{drawerUser.username}</dd>
                <dt>显示名称</dt><dd>{drawerUser.display_name || '—'}</dd>
                <dt>关联员工</dt><dd>{drawerUser.emp_code ? `${drawerUser.emp_name || '—'}（${drawerUser.emp_code}）` : '—'}</dd>
                <dt>岗位</dt><dd>{drawerUser.position_name || '—'}</dd>
                <dt>所属组织</dt><dd>{drawerUser.org_name || '—'}</dd>
                <dt>直属上级</dt><dd>{drawerUser.manager_name || '—'}</dd>
                <dt>角色</dt>
                <dd>
                  {renderRoleTag(drawerUser, () => navigate(`/roles?role_code=${encodeURIComponent(drawerUser.role_code)}`))}
                  <a
                    style={{ marginLeft: 8, fontSize: 'calc(12px * var(--font-size-scale))' }}
                    onClick={() => navigate(`/roles?role_code=${encodeURIComponent(drawerUser.role_code)}`)}
                  >
                    查看角色权限 →
                  </a>
                </dd>
                <dt>绑定供应商</dt><dd>{drawerUser.supplier_name || '—（内部员工账号）'}</dd>
                <dt>状态</dt><dd><span className={`sc-tag ${drawerUser.is_active ? 'sc-tag-done' : 'sc-tag-wait'}`}><span className="dot" />{drawerUser.is_active ? '启用' : '停用'}</span></dd>
                <dt>创建时间</dt><dd className="sc-mono">{drawerUser.created_at || '—'}</dd>
                <dt>更新时间</dt><dd className="sc-mono">{drawerUser.updated_at || '—'}</dd>
              </dl>
            </div>

            <div className="d-sec">
              <h4>登录与安全</h4>
              <dl className="d-kv">
                <dt>最后登录</dt><dd className="sc-mono">{drawerUser.last_login_time || '从未登录'}</dd>
                <dt>密码状态</dt>
                <dd>
                  {drawerUser.is_default_password
                    ? <span style={{ color: '#d97706', fontWeight: 500 }}>默认密码未修改（建议重置）</span>
                    : <span style={{ color: '#16a34a', fontWeight: 500 }}>已修改初始密码 ✓</span>}
                </dd>
              </dl>
              <div className="f-note" style={{ marginTop: 10, background: '#f8fafc', borderColor: '#e2e8f0', color: '#475569' }}>
                重置密码或停用账号会使该用户的全部在线会话立即失效（强制下线）；重新登录后发放新令牌。
              </div>
            </div>

            <div className="d-sec">
              <h4>企业微信绑定</h4>
              <dl className="d-kv">
                <dt>企微账号</dt>
                <dd>{drawerUser.wecom_user_id ? `${wecomNameOf(drawerUser.wecom_user_id)}（${drawerUser.wecom_user_id}）` : '未绑定'}</dd>
                <dt>能力</dt>
                <dd style={{ color: '#94a3b8' }}>{drawerUser.wecom_user_id ? '企微扫码登录 · 待办 / 会议提醒推送' : '绑定后可扫码登录并接收待办提醒'}</dd>
              </dl>
            </div>

            <div className="d-sec">
              <h4>操作记录{drawerAuditLoading ? '（加载中…）' : drawerAudit ? `（${drawerAudit.length}）` : ''}</h4>
              {canAuditRead ? (
                drawerAudit && drawerAudit.length > 0 ? (
                  <Timeline
                    items={drawerAudit.map(log => {
                      const { what, color } = auditTimelineItem(log)
                      return {
                        color,
                        children: (
                          <div>
                            <div style={{ fontSize: 'calc(13.5px * var(--font-size-scale))', color: '#0f172a' }}>{what}</div>
                            <div className="sc-sub">{log.operated_at || ''} · 操作人 {log.operator || 'system'}</div>
                          </div>
                        ),
                      }
                    })}
                  />
                ) : (
                  <div className="sc-note">{drawerAuditLoading ? '' : '暂无操作记录'}</div>
                )
              ) : (
                <div className="sc-note">需要审计日志查看权限（audit.read）</div>
              )}
            </div>
          </>
        )}
      </Drawer>

      {/* ===== 新增 / 编辑用户 ===== */}
      <Modal
        title={editingUser ? '编辑用户' : '新增用户'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={720}
        rootClassName="sc-page"
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="emp_code" label="关联员工">
                <Select
                  allowClear
                  showSearch
                  placeholder="选择员工后自动匹配岗位权限"
                  loading={employeeLoading}
                  optionFilterProp="label"
                  options={employeeOptions.map(employee => ({
                    value: employee.emp_code,
                    label: `${employee.emp_name} (${employee.emp_code})${employee.position_name ? ` - ${employee.position_name}` : ''}`,
                  }))}
                  filterOption={false}
                  onSearch={handleEmployeeSearch}
                  onDropdownVisibleChange={(open) => {
                    if (open && employeeOptions.length === 0) fetchEmployeeOptions()
                  }}
                  onChange={handleEmployeeChange}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                <Input placeholder="登录用户名" disabled={!!editingUser} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="display_name" label="显示名称">
                <Input placeholder="如：计划员 张三" />
              </Form.Item>
            </Col>
            {!editingUser && (
              <Col span={12}>
                <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '密码至少6位' }]}>
                  <Input.Password placeholder="至少6位" />
                </Form.Item>
              </Col>
            )}
            <Col span={12}>
              <Form.Item name="role_id" label="角色" rules={[{ required: !hasPositionRole, message: '请选择角色' }]}>
                <Select
                  placeholder={hasPositionRole ? '已从岗位自动获取角色' : '选择角色；关联员工后自动从岗位获取'}
                  disabled={hasPositionRole}
                  options={roles.map(r => ({ value: r.id, label: `${r.role_name} (${r.role_code})` }))}
                  onChange={(roleId) => {
                    const role = roles.find(r => r.id === roleId)
                    if (role?.role_code !== 'supplier') {
                      form.setFieldValue('supplier_name', undefined)
                    }
                  }}
                />
              </Form.Item>
            </Col>
            {isSupplierRole && (
              <Col span={12}>
                <Form.Item name="supplier_name" label="绑定供应商" rules={[{ required: true, message: '请选择供应商' }]}>
                  <Select
                    showSearch
                    placeholder="选择供应商"
                    loading={supplierLoading}
                    optionFilterProp="label"
                    options={suppliers.map(s => ({
                      value: s.supplier_name,
                      label: s.supplier_name,
                      searchText: `${s.supplier_name} ${s.supplier_code || ''}`,
                    }))}
                    filterOption={(input, option) => String(option?.searchText || option?.label || '').toLowerCase().includes(input.toLowerCase())}
                    onSearch={handleSupplierSearch}
                    onDropdownVisibleChange={(open) => {
                      if (open && suppliers.length === 0) fetchSuppliers()
                    }}
                    onChange={(supplierName) => {
                      if (!editingUser && supplierName) {
                        form.setFieldsValue({
                          username: supplierName,
                          display_name: supplierName,
                          password: supplierName,
                        })
                      }
                    }}
                  />
                </Form.Item>
              </Col>
            )}
            <Col span={12}>
              <Form.Item name="wecom_user_id" label="企业微信账号">
                <Select
                  allowClear
                  showSearch
                  placeholder="选择企业微信账号（可解绑）"
                  optionFilterProp="label"
                  options={wecomUsers.map(u => ({ value: u.userid, label: `${u.name} (${u.userid})` }))}
                  notFoundContent="未加载到企业微信通讯录"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="is_active" label="状态" valuePropName="checked">
                <Switch checkedChildren="启用" unCheckedChildren="停用" />
              </Form.Item>
            </Col>
          </Row>
          <div className="f-note">
            规则：新增时选择关联员工后，自动带出岗位并按「岗位→角色」映射填充角色；无映射岗位需手动选择。用户名默认取登录账号、密码默认取工号；角色为「供应商」时用户名 / 密码默认取供应商名称。停用即时生效 — 该账号所有在线会话强制下线。
          </div>
        </Form>
      </Modal>

      {/* ===== 重置密码 ===== */}
      <Modal
        title={`重置密码 — ${pwdUser?.username ?? ''}`}
        open={pwdModalOpen}
        onOk={handleResetPwd}
        onCancel={() => setPwdModalOpen(false)}
        okText="确认重置"
        cancelText="取消"
        width={420}
        rootClassName="sc-page"
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item name="new_password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 6, message: '密码至少6位' }]}>
            <Input.Password placeholder="至少6位" />
          </Form.Item>
          <Form.Item name="confirm_password" label="确认密码" dependencies={['new_password']}
            rules={[
              { required: true, message: '请确认密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                  return Promise.reject(new Error('两次密码不一致'))
                },
              }),
            ]}>
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
          <div className="f-note">
            重置后该账号所有在线会话立即失效，需重新登录。
          </div>
        </Form>
      </Modal>

      {/* ===== 批量开通用户 — 选择员工 ===== */}
      <Modal
        title="批量开通用户"
        open={provisionModalOpen}
        onOk={handleBatchProvision}
        onCancel={() => setProvisionModalOpen(false)}
        confirmLoading={provisioning}
        okText={`开通选中（${unprovSelected.length}）`}
        okButtonProps={{ disabled: unprovSelected.length === 0 }}
        cancelText="取消"
        width={1100}
        rootClassName="sc-page"
        styles={{ body: { padding: '8px 24px 24px' } }}
      >
        <div style={{ margin: '8px 0 16px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Input
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="搜索工号 / 姓名 / 登录账号（空格分隔多人）"
            value={unprovKeyword}
            allowClear
            onChange={(e) => {
              setUnprovKeyword(e.target.value)
              setUnprovPage(1)
              fetchUnprovisioned({ page: 1, pageSize: unprovPageSize, keyword: e.target.value })
            }}
            onPressEnter={() => { setUnprovPage(1); fetchUnprovisioned() }}
            style={{ width: 280 }}
          />
          <Select
            allowClear
            placeholder="按岗位筛选"
            value={unprovPosFilter}
            onChange={(v) => {
              setUnprovPosFilter(v)
              setUnprovPage(1)
              fetchUnprovisioned({ page: 1, positionName: v })
            }}
            options={unprovPosOptions.map(v => ({ value: v, label: v }))}
            style={{ width: 180 }}
          />
          <Select
            allowClear
            placeholder="按组织筛选"
            value={unprovOrgFilter}
            onChange={(v) => {
              setUnprovOrgFilter(v)
              setUnprovPage(1)
              fetchUnprovisioned({ page: 1, orgName: v })
            }}
            options={unprovOrgOptions.map(v => ({ value: v, label: v }))}
            style={{ width: 200 }}
          />
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <span className="sc-note">共 {unprovTotalCount} 名员工</span>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchUnprovisioned()}>刷新</Button>
          </span>
        </div>
        <Table
          rowKey="emp_code"
          size="small"
          loading={unprovLoading}
          dataSource={unprovEmployees}
          scroll={{ x: 1000, y: 420 }}
          rowSelection={{
            type: 'checkbox',
            selectedRowKeys: unprovSelected,
            onChange: (keys) => setUnprovSelected(keys as string[]),
          }}
          columns={[
            { title: '工号', dataIndex: 'emp_code', width: 140, className: 'sc-mono' },
            { title: '姓名', dataIndex: 'emp_name', width: 100 },
            {
              title: '登录账号', dataIndex: 'login_id', width: 140,
              render: (v: string) => v || <span className="sc-note">—</span>,
            },
            {
              title: '岗位', dataIndex: 'position_name', width: 160,
              render: (v: string) => v || <span className="sc-note">—</span>,
            },
            {
              title: '所属组织', dataIndex: 'org_name', width: 180,
              render: (v: string) => v || <span className="sc-note">—</span>,
            },
            {
              title: '员工状态', dataIndex: 'status', width: 100,
              render: (v: number) => {
                const info = EMP_STATUS[v] || { text: `状态${v}`, cls: 'sc-tag-wait' }
                return <span className={`sc-tag ${info.cls}`}>{info.text}</span>
              },
            },
          ]}
          pagination={{
            current: unprovPage, pageSize: unprovPageSize, total: unprovTotalCount,
            showSizeChanger: true, showTotal: (t: number) => `共 ${t} 条`,
            pageSizeOptions: ['20', '50', '100', '200'],
            onChange: (p: number, ps: number) => { setUnprovPage(p); setUnprovPageSize(ps); fetchUnprovisioned({ page: p, pageSize: ps }) },
            onShowSizeChange: (p: number, ps: number) => { setUnprovPage(1); setUnprovPageSize(ps); fetchUnprovisioned({ page: 1, pageSize: ps }) },
          }}
        />
        <div className="f-note" style={{ marginTop: 12 }}>
          开通规则：角色按「岗位→角色」映射自动分配；无映射岗位开通后需在角色管理中补配。默认密码为工号，建议首次登录后修改。
        </div>
      </Modal>

      {/* ===== 批量绑定企业微信 — 智能匹配 ===== */}
      <Modal
        title="批量绑定企业微信"
        open={wecomMatchOpen}
        onOk={handleBatchBindWecom}
        onCancel={() => setWecomMatchOpen(false)}
        confirmLoading={wecomBindSaving}
        okText={`绑定选中（${wecomMatchSelected.length}）`}
        okButtonProps={{ disabled: wecomMatchSelected.length === 0 }}
        cancelText="取消"
        width={1000}
        rootClassName="sc-page"
        styles={{ body: { padding: '8px 24px 24px' } }}
      >
        <div style={{ margin: '8px 0 12px', display: 'flex', gap: 16, alignItems: 'center' }}>
          <span style={{ color: '#16a34a' }}>已匹配 {wecomMatchStats.matched}</span>
          <span style={{ color: '#ea580c' }}>待确认 {wecomMatchStats.ambiguous}</span>
          <span style={{ color: '#94a3b8' }}>未匹配 {wecomMatchStats.unmatched}</span>
          <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 12 }}>
            仅显示未绑定用户；下拉可搜索全量通讯录
          </span>
        </div>
        <Table
          rowKey="user_id"
          size="small"
          loading={wecomMatchLoading}
          dataSource={wecomMatchItems}
          scroll={{ y: 440 }}
          rowSelection={{
            type: 'checkbox',
            selectedRowKeys: wecomMatchSelected,
            onChange: (keys) => setWecomMatchSelected(keys as number[]),
          }}
          columns={[
            {
              title: '用户', dataIndex: 'username', width: 180,
              render: (_: any, r: any) => (
                <span>{r.display_name || r.username} <span style={{ color: '#94a3b8' }}>({r.username})</span></span>
              ),
            },
            {
              title: '员工姓名', dataIndex: 'emp_name', width: 100,
              render: (v: string | null) => v || <span className="sc-note">—</span>,
            },
            {
              title: '匹配状态', dataIndex: 'match_status', width: 100,
              render: (v: string) => {
                const map: Record<string, { text: string; cls: string }> = {
                  matched: { text: '已匹配', cls: 'sc-tag-done' },
                  ambiguous: { text: '待确认', cls: 'sc-tag-amber' },
                  unmatched: { text: '未匹配', cls: 'sc-tag-wait' },
                }
                const info = map[v] || { text: v, cls: 'sc-tag-plain' }
                return <span className={`sc-tag ${info.cls}`}><span className="dot" />{info.text}</span>
              },
            },
            {
              title: '企业微信账号', dataIndex: 'user_id', width: 280,
              render: (_: any, r: any) => (
                <Select
                  showSearch
                  allowClear
                  style={{ width: '100%' }}
                  placeholder="搜索并选择企业微信账号"
                  optionFilterProp="label"
                  value={wecomMatchValues[r.user_id]}
                  onChange={(v) => setWecomMatchValues(prev => ({ ...prev, [r.user_id]: v }))}
                  options={wecomUsers.map(u => ({ value: u.userid, label: `${u.name} (${u.userid})` }))}
                  notFoundContent="未加载到企业微信通讯录"
                />
              ),
            },
          ]}
        />
        <div className="f-note" style={{ marginTop: 12 }}>
          绑定后该用户可通过企微扫码登录、接收待办与会议提醒；同名多候选时请人工确认后勾选。
        </div>
      </Modal>

      {/* ===== 高危操作二次确认 ===== */}
      <Modal
        title={confirmAction === 'delete' ? '确认批量删除' : '确认批量重置密码'}
        open={confirmModalOpen}
        onOk={handleConfirmOk}
        onCancel={() => setConfirmModalOpen(false)}
        okButtonProps={{ danger: confirmAction === 'delete' }}
        okText="确认执行"
        cancelText="取消"
        width={440}
        rootClassName="sc-page"
      >
        <p style={{ marginBottom: 12 }}>
          {confirmAction === 'delete'
            ? `即将删除 ${isSelectAllFiltered ? `当前筛选命中的全部 ${pagination.total} 个` : selectedRowKeys.length} 个用户，此操作不可恢复！关联员工、企微绑定将一并解除。`
            : `即将重置 ${isSelectAllFiltered ? `当前筛选命中的全部 ${pagination.total} 个` : selectedRowKeys.length} 个用户的密码为默认密码！`}
        </p>
        <p style={{ marginBottom: 8, color: '#6b7280' }}>
          请输入 <b style={{ color: '#dc2626' }}>{confirmAction === 'delete' ? '删除' : '重置'}</b> 以确认操作：
        </p>
        <Input
          value={confirmInput}
          onChange={(e) => setConfirmInput(e.target.value)}
          placeholder={`请输入"${confirmAction === 'delete' ? '删除' : '重置'}"`}
          onPressEnter={handleConfirmOk}
        />
      </Modal>

      <ExportColumnSelector
        open={exportColumnModalOpen}
        columns={USER_EXPORT_COLUMNS}
        onConfirm={handleExportUsers}
        onCancel={() => setExportColumnModalOpen(false)}
      />
    </div>
  )
}
