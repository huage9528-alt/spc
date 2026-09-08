import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Row, Col, Table, Tag, Input, InputNumber, Select, Button, message, Space, Tooltip, Modal, Form, DatePicker, Card, Spin, Progress, Dropdown, Switch, Checkbox, Popover, Drawer } from 'antd'
import zhCN from 'antd/locale/zh_CN'
const { RangePicker } = DatePicker
import {
  SearchOutlined,
  ReloadOutlined,
  ShoppingCartOutlined,
  WarningOutlined,
  ExclamationCircleOutlined,
  CheckCircleOutlined,
  AuditOutlined,
  EditOutlined,
  SaveOutlined,
  FilterOutlined,
  CloseOutlined,
  DownloadOutlined,
  DownOutlined,
  SettingOutlined,
  BarChartOutlined,
  LockOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import RiskBadge from '../../../components/RiskBadge'
import RiskDetailModal from '../../../components/RiskDetailModal'
import { orderApi, riskApi } from '../../../services/api'
import api from '../../../services/api'
import { formatDate, formatDateTime } from '../../../utils'
import { useExport } from '../../../hooks/useExport'
import ExportColumnSelector, { type ExportColumnOption } from '../../../components/ExportColumnSelector'
import { useUiPreferencesStore } from '../../../store/uiPreferences'
import { useAuthStore } from '../../../store/auth'
import ShippingAnalyticsCharts from './components/ShippingAnalyticsCharts'

interface OrderRow {
  id: number
  order_no: string
  line_no: string | null
  customer: string | null
  customer_code: string | null
  product_code: string | null
  product_name: string | null
  order_qty: number | null
  order_amount: number | null
  completed_qty: number | null
  promised_date: string | null
  planned_start_date: string | null
  department: string | null
  owner: string | null
  status: string
  erp_id: number | null
  erp_status: number | null
  risk_level: string | null
  risk_score: number | null
  risk_factors: Record<string, number> | null
  risk_assessed_at: string | null
  data_source: string | null
  delivery_completed_date: string | null
  customer_grade: string | null
  shipping_plan: string | null
  customer_inspection_date: string | null
  inspection_result: string | null
  packaging_status: string | null
  bom_return_date: string | null
  material_ready_date: string | null
  shipping_status_desc: string | null
  procurement_status: string | null
  kit_rate: number | null
  kit_status: string | null
  kit_risk_level: string | null
  kit_total_materials: number
  kit_received_materials: number
  material_dates: Record<string, string> | null
  front_process_date: string | null
  first_article_date: string | null
  assembly_start_date: string | null
  assembly_complete_date: string | null
  is_closed: number
  remark: string | null
  order_date: string | null
  shortage_count: number
  field_synced_at: Record<string, string> | null
}

interface OrderLineData {
  id: number
  order_no: string
  line_no: string | null
  product_code: string | null
  product_name: string | null
  product_model: string | null
  order_qty: number | null
  order_amount: number | null
  promised_date: string | null
  planned_start_date: string | null
  batch_no: string | null
  status: string
}

interface OrderDetailData {
  id: number
  order_no: string
  line_no: string | null
  customer: string | null
  product_name: string | null
  order_qty: number | null
  promised_date: string | null
  shortage_count: number
  in_transit_count: number
  latest_eta: string | null
  lines: OrderLineData[]
  material_demands: any[]
  bindings: any[]
  issues: any[]
}

interface Filters {
  keyword: string
  year: number | null
  risk_level: string[]
  customer_grade: string[]
  department: string[]
  status: string[]
  inspection_result: string[]
  packaging_status: string[]
  procurement_status: string[]
  delivery_completed: string[]
  is_closed: string[]
  order_type: string[]
  promised_date_range: [string, string] | null
  shipping_plan_range: [string, string] | null
  order_date_range: [string, string] | null
  customer_inspection_date_range: [string, string] | null
  planned_start_date_range: [string, string] | null
  material_ready_date_range: [string, string] | null
  front_process_date_range: [string, string] | null
  first_article_date_range: [string, string] | null
  assembly_start_date_range: [string, string] | null
  assembly_complete_date_range: [string, string] | null
}

const MATERIAL_KEYS = [
  '电子料', 'SMT上线', '光源', '感应器/电源/控制板',
  '结构', '结构2', '支架', '电缆线', '塑料件', '手杆',
  '彩盒', '说明书', '灯珠', '光源板', '电源板', '包材',
]

// ── 列设置（显示/隐藏）──
const ORDER_LIST_PAGE_KEY = 'order_list_columns'

const ORDER_COLUMN_GROUPS: { title: string; keys: { key: string; label: string }[] }[] = [
  {
    title: '基本信息', keys: [
      { key: 'department', label: '销售部门' },
      { key: 'delivery_completed_date', label: '发货完成' },
      { key: 'customer_grade', label: '客户等级' },
      { key: 'customer_code', label: '客户' },
      { key: 'order_no', label: '单号' },
    ],
  },
  {
    title: '风险/数量', keys: [
      { key: 'risk_level', label: '风险等级' },
      { key: 'order_qty', label: '数量' },
      { key: 'order_amount', label: '金额' },
      { key: 'completed_qty', label: '完成数量' },
      { key: 'order_date', label: '下单时间' },
    ],
  },
  {
    title: '交期 & 计划', keys: [
      { key: 'promised_date', label: '合同交期' },
      { key: 'shipping_plan', label: '出货计划' },
      { key: 'customer_inspection_date', label: '客户验货时间' },
      { key: 'planned_start_date', label: '上线时间' },
      { key: 'inspection_result', label: '客检结果' },
      { key: 'packaging_status', label: '包装完成状况' },
      { key: 'bom_return_date', label: 'BOM回收' },
      { key: 'material_ready_date', label: '料齐套时间' },
    ],
  },
  {
    title: '发货 & 采购', keys: [
      { key: 'shipping_status_desc', label: '发货状态即时说明' },
      { key: 'procurement_status', label: '采购物料齐套' },
    ],
  },
  {
    title: '物料分类到料日期', keys: MATERIAL_KEYS.map(k => ({ key: `mat_${k}`, label: k })),
  },
  {
    title: '生产节点', keys: [
      { key: 'front_process_date', label: '前道' },
      { key: 'first_article_date', label: '首件检验日期' },
      { key: 'assembly_start_date', label: '组装上线日期' },
      { key: 'assembly_complete_date', label: '组装完成日期' },
    ],
  },
  {
    title: '其他', keys: [
      { key: 'remark', label: '备注' },
      { key: 'is_closed', label: '是否关闭' },
      { key: 'status', label: '状态' },
    ],
  },
]

const ORDER_COLUMN_KEYS: string[] = ORDER_COLUMN_GROUPS.flatMap(g => g.keys.map(k => k.key))

/* ── 默认列（原型 v5：核心列常显；物料分类16 / 生产节点4 / 补充维护4 默认收起，列设置里展开）── */
const DEFAULT_COLUMN_KEYS: string[] = [
  'department', 'delivery_completed_date', 'customer_grade', 'customer_code', 'order_no',
  'risk_level', 'order_qty', 'order_amount', 'completed_qty', 'order_date',
  'promised_date', 'shipping_plan', 'inspection_result', 'packaging_status',
  'material_ready_date', 'shipping_status_desc', 'procurement_status', 'is_closed', 'status',
]

/* ── 字段编辑元数据：edit=可手工填写类型；ro=只读原因（表头 ✎/🔒 标记来源）── */
const FIELD_EDIT_META: Record<string, { edit?: 'text' | 'date' | 'number' | 'select'; ro?: string }> = {
  department: { ro: 'ERP 同步，只读' },
  delivery_completed_date: { edit: 'date' },
  customer_grade: { edit: 'select' },
  customer_code: { ro: 'ERP 同步，只读' },
  order_no: { ro: 'ERP 同步，只读' },
  risk_level: { edit: 'select' },
  order_qty: { ro: 'ERP 同步，只读' },
  order_amount: { ro: 'ERP 同步，只读' },
  completed_qty: { edit: 'number' },
  order_date: { ro: 'ERP 同步，只读' },
  promised_date: { ro: 'ERP 同步，只读' },
  shipping_plan: { edit: 'date' },
  customer_inspection_date: { edit: 'date' },
  planned_start_date: { edit: 'date' },
  inspection_result: { edit: 'select' },
  packaging_status: { edit: 'text' },
  bom_return_date: { edit: 'date' },
  material_ready_date: { edit: 'date' },
  shipping_status_desc: { edit: 'text' },
  procurement_status: { ro: '自动计算，只读' },
  front_process_date: { edit: 'date' },
  first_article_date: { edit: 'date' },
  assembly_start_date: { edit: 'date' },
  assembly_complete_date: { edit: 'date' },
  remark: { edit: 'text' },
  is_closed: { ro: '只读' },
  status: { ro: 'ERP 同步，只读' },
  ...Object.fromEntries(MATERIAL_KEYS.map(k => [`mat_${k}`, { edit: 'date' as const }])),
}

/* 表头标记改为 th 伪元素（见 index.css sc-hed/sc-hro）：✎ 可手工填写 / 🔒 只读，绝对定位在 th 左侧预留区，不进标题流、不与筛选/排序图标重叠 */

/* 快速视图（映射后端已有筛选参数） */
type QuickView = 'all' | 'mine' | 'today' | 'overdue' | 'high' | 'shipweek'
const QUICK_VIEW_DEFS: { key: QuickView; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'mine', label: '我的待办' },
  { key: 'today', label: '今日到期' },
  { key: 'overdue', label: '已逾期' },
  { key: 'high', label: '高危' },
  { key: 'shipweek', label: '本周发货' },
]

/* 编辑弹窗：选项与分节配置（整单字段集中维护） */
const GRADE_OPTS = [
  { value: 'A', label: 'A 级' }, { value: 'B', label: 'B 级' },
  { value: 'C', label: 'C 级' }, { value: 'D', label: 'D 级' },
]
const RESULT_OPTS = [
  { value: 'OK', label: 'OK / 通过' }, { value: 'NG', label: 'NG / 不通过' }, { value: '待检', label: '待检' },
]
const RISK_OPTS = [
  { value: 'red', label: '高风险' }, { value: 'yellow', label: '中风险' },
  { value: 'blue', label: '低风险' }, { value: 'green', label: '正常' },
]
const CLOSED_OPTS = [{ value: 'true', label: '已关闭' }, { value: 'false', label: '未关闭' }]
type EditFieldType = 'date' | 'text' | 'select' | 'number'
interface EditFieldDef { k: string; label: string; t: EditFieldType; opts?: { value: string; label: string }[] }
const EDIT_SECTIONS: { title: string; fields: EditFieldDef[] }[] = [
  {
    title: '交期与计划', fields: [
      { k: 'delivery_completed_date', label: '发货完成', t: 'date' },
      { k: 'customer_grade', label: '客户等级', t: 'select', opts: GRADE_OPTS },
      { k: 'shipping_plan', label: '出货计划', t: 'date' },
      { k: 'customer_inspection_date', label: '客户验货时间', t: 'date' },
      { k: 'planned_start_date', label: '上线时间', t: 'date' },
      { k: 'inspection_result', label: '客检结果', t: 'select', opts: RESULT_OPTS },
      { k: 'packaging_status', label: '包装完成状况', t: 'text' },
      { k: 'bom_return_date', label: 'BOM回收', t: 'date' },
      { k: 'material_ready_date', label: '料齐套时间', t: 'date' },
    ],
  },
  {
    title: '风险与发货', fields: [
      { k: 'risk_level', label: '风险等级', t: 'select', opts: RISK_OPTS },
      { k: 'shipping_status_desc', label: '发货状态即时说明', t: 'text' },
      { k: 'remark', label: '备注', t: 'text' },
    ],
  },
  {
    title: '生产节点', fields: [
      { k: 'completed_qty', label: '完成数量', t: 'number' },
      { k: 'front_process_date', label: '前道', t: 'date' },
      { k: 'first_article_date', label: '首件检验日期', t: 'date' },
      { k: 'assembly_start_date', label: '组装上线日期', t: 'date' },
      { k: 'assembly_complete_date', label: '组装完成日期', t: 'date' },
    ],
  },
  {
    title: '物料分类到料日期', fields: MATERIAL_KEYS.map(k => ({ k: `mat_${k}`, label: k, t: 'date' as const })),
  },
]


const today = () => new Date().toISOString().slice(0, 10)

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: CURRENT_YEAR - 2019 }, (_, i) => CURRENT_YEAR - i)

function DateCell({ value, overdue }: { value: string | null; overdue?: boolean }) {
  if (!value) return <span style={{ color: '#cbd5e1' }}>-</span>
  return <span style={{ color: overdue ? '#e11d48' : undefined, fontWeight: overdue ? 600 : undefined }}>{formatDate(value)}</span>
}

function GreenDateCell({ value }: { value: string | null }) {
  if (!value) return <span style={{ color: '#cbd5e1' }}>-</span>
  return <span style={{ color: '#16a34a', fontWeight: 500 }}>{formatDate(value)}</span>
}

const ERP_STATUS_MAP: Record<number, { label: string; color: string }> = {
  0: { label: '未审核', color: 'default' },
  1: { label: '审核', color: 'blue' },
  2: { label: '部分关闭', color: 'orange' },
  3: { label: '已关闭', color: 'green' },
}

function ErpStatusTag({ value }: { value: number | null }) {
  if (value == null) return <span style={{ color: '#cbd5e1' }}>-</span>
  const cfg = ERP_STATUS_MAP[value]
  return cfg ? <Tag color={cfg.color}>{cfg.label}</Tag> : <Tag>{value}</Tag>
}


// 从表格列自动生成导出列选项
const generateExportColumns = (tableColumns: any[]): ExportColumnOption[] => {
  return tableColumns
    .filter(col => col.title && col.dataIndex) // 过滤掉没有标题或数据索引的列
    .map(col => ({
      field: col.dataIndex,
      label: col.title
    }))
}

export default function OrderList() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { exporting, exportData } = useExport()
  const getColumnVisibility = useUiPreferencesStore(s => s.getColumnVisibility)
  const setColumnVisibility = useUiPreferencesStore(s => s.setColumnVisibility)
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<string[]>(
    () => getColumnVisibility(ORDER_LIST_PAGE_KEY, DEFAULT_COLUMN_KEYS)
  )
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [pagination, setPagination] = useState({ current: 1, pageSize: 50, total: 0 })
  const [filters, setFilters] = useState<Filters>({
    keyword: '',
    year: new Date().getFullYear(),
    risk_level: [],
    customer_grade: [],
    department: [],
    status: [],
    inspection_result: [],
    packaging_status: [],
    procurement_status: [],
    delivery_completed: ['no'],
    is_closed: [],
    order_type: ['big'],
    promised_date_range: null,
    shipping_plan_range: null,
    order_date_range: null,
    customer_inspection_date_range: null,
    planned_start_date_range: null,
    material_ready_date_range: null,
    front_process_date_range: null,
    first_article_date_range: null,
    assembly_start_date_range: null,
    assembly_complete_date_range: null,
  })
  const [sortInfo, setSortInfo] = useState<{ sort_by?: string; sort_order?: string }>({})
  const [summary, setSummary] = useState({ total: 0, red: 0, yellow: 0, blue: 0, green: 0, shortage: 0, order_qty_total: 0, order_amount_total: 0 })
  const [showCharts, setShowCharts] = useState(false)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsData, setAnalyticsData] = useState<any>(null)
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const [detailCache, setDetailCache] = useState<Record<string, OrderDetailData>>({})
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({})
  const [riskModalOpen, setRiskModalOpen] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<OrderRow | null>(null)
  const [exportColumnModalOpen, setExportColumnModalOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<'xlsx' | 'csv'>('xlsx')
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [fieldRemarks, setFieldRemarks] = useState<Record<string, string>>({})

  /* ── v5 行内编辑 / 快速视图 / 列设置抽屉 ── */
  const userName = useAuthStore(s => s.currentUser?.display_name || s.currentUser?.username)
  const [quickView, setQuickView] = useState<QuickView>('all')
  const [chipCounts, setChipCounts] = useState<Record<string, number | undefined>>({})
  const [highlightEdit, setHighlightEdit] = useState(false)
  const [colsDrawerOpen, setColsDrawerOpen] = useState(false)
  const [tipDismissed, setTipDismissed] = useState(() => {
    try { return localStorage.getItem('order_edit_tip_dismissed') === '1' } catch { return false }
  })
  /* 行编辑（弹窗形态：整单字段集中维护） */
  const [rowEdId, setRowEdId] = useState<number | null>(null)
  const [rowEdDraft, setRowEdDraft] = useState<Record<string, any>>({})
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  /* 本次会话手工修改过的单元格（圆点标记）与保存绿闪 */
  const [sessionEdited, setSessionEdited] = useState<Set<string>>(new Set())
  const [flashCells, setFlashCells] = useState<Set<string>>(new Set())

  // ── 加载字段备注 ──
  useEffect(() => {
    api.get('/basicdata/sync-sql/field-remarks/orders').then((res: any) => {
      if (res.data) setFieldRemarks(res.data)
    }).catch(() => {})
  }, [])

  // ── URL 参数处理 ──
  const urlSearchAppliedRef = useRef(false)
  const [shouldInitialLoad, setShouldInitialLoad] = useState(false)
  
  // 第一步：从 URL 读取参数并更新 filters
  useEffect(() => {
    if (urlSearchAppliedRef.current) return
    
    const searchKeyword = searchParams.get('search')
    if (searchKeyword) {
      // 自动填充搜索关键字
      setFilters(prev => ({ ...prev, keyword: searchKeyword }))
      urlSearchAppliedRef.current = true
      
      // 清除 URL 参数
      const newParams = new URLSearchParams(searchParams)
      newParams.delete('search')
      setSearchParams(newParams, { replace: true })
    }
    
    // 标记可以开始初始加载
    setShouldInitialLoad(true)
  }, [searchParams, setSearchParams])

  // ── 行内编辑（v5：✎ 列点击即编 · Enter/Tab 保存跳格 · Esc 取消 · 整行编辑 + 保存条）──
  const [editingCell, setEditingCell] = useState<string | null>(null)
  const [savingCell, setSavingCell] = useState<string | null>(null)
  const savingCellRef = useRef<string | null>(null)

  const DATE_FIELDS = [
    'delivery_completed_date', 'shipping_plan', 'customer_inspection_date',
    'planned_start_date', 'bom_return_date', 'material_ready_date',
    'front_process_date', 'first_article_date', 'assembly_start_date', 'assembly_complete_date',
  ]

  /* 日期快捷项（今天/明天/+3天/+7天；清除走 allowClear） */
  const DATE_PRESETS = [
    { label: '今天', value: dayjs() },
    { label: '明天', value: dayjs().add(1, 'day') },
    { label: '+3天', value: dayjs().add(3, 'day') },
    { label: '+7天', value: dayjs().add(7, 'day') },
  ]

  /* 保存后跳到本行下一个可编辑格（横向滚动跟随） */
  const advanceNext = (rowId: number, field: string) => {
    const tr = document.querySelector(`tr[data-row-key="${rowId}"]`)
    if (!tr) return
    const cells = Array.from(tr.querySelectorAll<HTMLElement>('[data-ec]'))
    const idx = cells.findIndex(c => c.dataset.ec === field)
    for (let j = idx + 1; j < cells.length; j++) {
      const el = cells[j]
      if (el.dataset.ec) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        el.click()
        return
      }
    }
  }

  /* 手工修改标记（本次会话）+ 保存绿闪 */
  const markEdited = (id: number, field: string) => {
    const key = `${id}:${field}`
    setSessionEdited(prev => new Set(prev).add(key))
    setFlashCells(prev => new Set(prev).add(key))
    window.setTimeout(() => {
      setFlashCells(prev => { const n = new Set(prev); n.delete(key); return n })
    }, 1600)
  }

  const handleCellSave = useCallback(async (record: OrderRow, field: string, value: any) => {
    const cellKey = `${record.id}-${field}`
    if (savingCellRef.current) return
    savingCellRef.current = cellKey
    setSavingCell(cellKey)
    try {
      const payload: Record<string, any> = {}
      if (field.startsWith('mat_')) {
        const matKey = field.replace('mat_', '')
        const newMaterialDates = { ...(record.material_dates || {}) }
        if (value) {
          newMaterialDates[matKey] = dayjs.isDayjs(value) ? value.format('YYYY-MM-DD') : value
        } else {
          delete newMaterialDates[matKey]
        }
        payload.material_dates = Object.keys(newMaterialDates).length > 0 ? newMaterialDates : null
      } else if (DATE_FIELDS.includes(field)) {
        payload[field] = value && dayjs.isDayjs(value) ? value.format('YYYY-MM-DD') : value || null
      } else if (field === 'is_closed') {
        payload[field] = value === 'true' ? 1 : 0
      } else {
        payload[field] = value ?? null
      }

      await orderApi.update(record.order_no, payload)

      setOrders(prev => prev.map(o => {
        if (o.id !== record.id) return o
        if (field.startsWith('mat_')) {
          return { ...o, material_dates: payload.material_dates }
        }
        return { ...o, [field]: payload[field] }
      }))
      markEdited(record.id, field)
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      savingCellRef.current = null
      setSavingCell(null)
    }
  }, [])

  /* ── 整行编辑 ── */
  const origVal = (r: OrderRow, field: string): any => {
    if (field.startsWith('mat_')) return r.material_dates?.[field.slice(4)] ?? null
    if (field === 'is_closed') return r.is_closed === 1 ? 'true' : 'false'
    return (r as any)[field] ?? null
  }
  const setDraftVal = (field: string, v: any) => setRowEdDraft(prev => ({ ...prev, [field]: v }))
  const startRowEd = (record: OrderRow) => {
    const draft: Record<string, any> = {}
    Object.keys(FIELD_EDIT_META).forEach(f => { if (FIELD_EDIT_META[f].edit) draft[f] = origVal(record, f) })
    setRowEdDraft(draft)
    setEditingCell(null)
    setRowEdId(record.id)
    setEditModalOpen(true)
  }
  const cancelRowEd = () => { setEditModalOpen(false); setRowEdId(null); setRowEdDraft({}) }
  const rowEdRecord = rowEdId != null ? orders.find(o => o.id === rowEdId) ?? null : null
  const rowDirtyCount = useMemo(() => {
    if (!rowEdRecord) return 0
    const r = rowEdRecord
    return Object.keys(rowEdDraft).filter(f => String(rowEdDraft[f] ?? '') !== String(origVal(r, f) ?? '')).length
  }, [rowEdRecord, rowEdDraft])
  const saveRowEd = async () => {
    const r = rowEdRecord
    if (!r) { cancelRowEd(); return }
    const changedFields = Object.keys(rowEdDraft).filter(f => String(rowEdDraft[f] ?? '') !== String(origVal(r, f) ?? ''))
    if (changedFields.length === 0) { message.info('无修改'); cancelRowEd(); return }
    const payload: Record<string, any> = {}
    const materialDates: Record<string, string> = { ...(r.material_dates || {}) }
    let matChanged = false
    changedFields.forEach(f => {
      const nv = rowEdDraft[f] ?? null
      if (f.startsWith('mat_')) {
        const k = f.slice(4)
        if (nv) materialDates[k] = nv; else delete materialDates[k]
        matChanged = true
      } else if (f === 'is_closed') {
        payload[f] = nv === 'true' ? 1 : 0
      } else {
        payload[f] = nv
      }
    })
    if (matChanged) payload.material_dates = Object.keys(materialDates).length > 0 ? materialDates : null
    setSaving(true)
    try {
      await orderApi.update(r.order_no, payload)
      message.success(`已保存 ${changedFields.length} 处修改 · ${r.order_no}`)
      changedFields.forEach(f => markEdited(r.id, f))
      cancelRowEd()
      fetchOrders(pagination.current, pagination.pageSize)
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setSaving(false)
    }
  }
  useEffect(() => {
    if (rowEdId == null) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveRowEd() }
      else if (e.key === 'Escape') { e.preventDefault(); cancelRowEd() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ── 单元格展示包装：悬停编辑暗示 + ＋待填写 + 手工圆点 + 字段备注/同步时间 ── */
  const editWrap = (record: OrderRow, field: string, display: React.ReactNode, extraCls = '') => {
    const cellKey = `${record.id}-${field}`
    const manKey = `${record.id}:${field}`
    const syncedField = field.startsWith('mat_') ? 'material_dates' : field
    const syncedAt = record.field_synced_at?.[syncedField]
    const remark = fieldRemarks[syncedField]
    const inner = display ?? <span className="sc-fill-ph" title="待填写 · 点击录入">＋</span>
    const cell = (
      <div
        className={`sc-edit${extraCls}${sessionEdited.has(manKey) ? ' man' : ''}${flashCells.has(manKey) ? ' saved' : ''}`}
        data-ec={field}
        onClick={() => { if (!savingCell && rowEdId == null) setEditingCell(cellKey) }}
      >
        {inner}
        {sessionEdited.has(manKey) && <span className="sc-mdot" title="本次会话手工修改" />}
      </div>
    )
    if (remark || syncedAt) {
      return (
        <Tooltip title={<div style={{ fontSize: 'calc(12px * var(--font-size-scale))' }}>{remark && <div style={{ marginBottom: remark && syncedAt ? 4 : 0 }}>{remark}</div>}{syncedAt && <div>同步时间: {syncedAt}</div>}</div>}>
          {cell}
        </Tooltip>
      )
    }
    return cell
  }

  // ── 行内编辑渲染辅助（v5 范式：悬停 ✎ 暗示 + 日历/菜单/输入框 + Enter/Tab 跳格）──
  const editableDate = (field: string, opts?: {
    overdue?: (value: string | null, record: OrderRow) => boolean
    green?: boolean
  }) => (value: string | null, record: OrderRow) => {
    const cellKey = `${record.id}-${field}`
    if (editingCell === cellKey) {
      return (
        <DatePicker
          size="small"
          autoFocus
          open
          allowClear
          presets={DATE_PRESETS}
          value={value ? dayjs(value) : null}
          disabled={savingCell === cellKey}
          style={{ width: '100%' }}
          onChange={(d) => {
            handleCellSave(record, field, d ? d.format('YYYY-MM-DD') : null)
            setEditingCell(null)
            window.setTimeout(() => advanceNext(record.id, field), 60)
          }}
          onOpenChange={(open) => { if (!open) setEditingCell(null) }}
        />
      )
    }
    const isOverdue = opts?.overdue ? opts.overdue(value, record) : false
    const isGreen = opts?.green || false
    const display = value ? (
      <span style={{
        color: isGreen ? '#16a34a' : isOverdue ? '#e11d48' : undefined,
        fontWeight: (isGreen || isOverdue) ? (isGreen ? 500 : 600) : undefined,
      }}>{formatDate(value)}</span>
    ) : null
    return editWrap(record, field, display)
  }

  const editableSelect = (field: string, options: { value: string; label: string }[], renderValue?: (v: string | null, r: OrderRow) => React.ReactNode) =>
    (value: string | null, record: OrderRow) => {
      const cellKey = `${record.id}-${field}`
      if (editingCell === cellKey) {
        return (
          <Select
            size="small"
            defaultValue={value || undefined}
            disabled={savingCell === cellKey}
            style={{ width: '100%' }}
            autoFocus
            open
            allowClear
            options={options}
            onChange={(v) => {
              handleCellSave(record, field, v ?? null)
              setEditingCell(null)
              window.setTimeout(() => advanceNext(record.id, field), 60)
            }}
            onDropdownVisibleChange={(open) => { if (!open) setEditingCell(null) }}
            dropdownStyle={{ zIndex: 1050 }}
          />
        )
      }
      const display = renderValue ? renderValue(value, record) : (value || null)
      return editWrap(record, field, display)
    }

  const editableText = (field: string, renderValue?: (v: string | null, r: OrderRow) => React.ReactNode) =>
    (value: string | null, record: OrderRow) => {
      const cellKey = `${record.id}-${field}`
      if (editingCell === cellKey) {
        const commit = (el: HTMLInputElement) => {
          const next = el.value.trim()
          if ((value || '') !== next) handleCellSave(record, field, next || null)
          setEditingCell(null)
        }
        return (
          <Input
            size="small"
            defaultValue={value || ''}
            disabled={savingCell === cellKey}
            autoFocus
            onBlur={(e) => commit(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                commit(e.currentTarget)
                advanceNext(record.id, field)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditingCell(null)
              }
            }}
            onPressEnter={(e) => e.currentTarget.blur()}
          />
        )
      }
      const display = renderValue ? renderValue(value, record) : (value || null)
      return editWrap(record, field, display)
    }

  const editableNumber = (field: string, min = 0, renderValue?: (v: number | null, r: OrderRow) => React.ReactNode) =>
    (value: number | null, record: OrderRow) => {
      const cellKey = `${record.id}-${field}`
      if (editingCell === cellKey) {
        const commit = (raw: string) => {
          const next = raw === '' ? null : Number(raw)
          if ((value ?? null) !== next && (next == null || !Number.isNaN(next))) handleCellSave(record, field, next)
          setEditingCell(null)
        }
        return (
          <InputNumber
            size="small"
            min={min}
            defaultValue={value ?? undefined}
            disabled={savingCell === cellKey}
            style={{ width: '100%' }}
            autoFocus
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                commit((e.target as HTMLInputElement).value)
                advanceNext(record.id, field)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditingCell(null)
              }
            }}
            onPressEnter={(e) => e.currentTarget.blur()}
          />
        )
      }
      const display = renderValue
        ? renderValue(value, record)
        : (value != null ? value : null)
      return editWrap(record, field, display)
    }

  /* ── 快速视图 → 后端筛选参数（复用已有接口能力，不改后端）── */
  const quickViewParams = useCallback((view: QuickView): Record<string, any> => {
    const t = dayjs().format('YYYY-MM-DD')
    switch (view) {
      case 'mine': return userName ? { owner: userName } : {}
      case 'today': return { promised_date_start: t, promised_date_end: t, delivery_completed: 'no' }
      case 'overdue': return { promised_date_end: dayjs().subtract(1, 'day').format('YYYY-MM-DD'), delivery_completed: 'no' }
      case 'high': return { risk_level: 'red,yellow', delivery_completed: 'no' }
      case 'shipweek': return { shipping_plan_start: t, shipping_plan_end: dayjs().add(6, 'day').format('YYYY-MM-DD'), delivery_completed: 'no' }
      default: return {}
    }
  }, [userName])

  /* 快速视图 chips 计数（page_size=1 轻量并行请求，只取 total） */
  const fetchChipCounts = useCallback(async (baseParams: Record<string, any>) => {
    const allBase = { ...baseParams }
    delete allBase.delivery_completed
    const views: QuickView[] = ['all', 'mine', 'today', 'overdue', 'high', 'shipweek']
    const totals = await Promise.all(views.map(async (v) => {
      try {
        const res: any = await orderApi.list({ page: 1, page_size: 1, ...(v === 'all' ? allBase : baseParams), ...quickViewParams(v) })
        return (res?.data?.total ?? undefined) as number | undefined
      } catch { return undefined }
    }))
    setChipCounts({
      all: totals[0],
      mine: !userName ? undefined : totals[1],
      today: totals[2], overdue: totals[3], high: totals[4], shipweek: totals[5],
    })
  }, [quickViewParams, userName])

  /* 计数请求防抖（搜索逐键触发时避免每键 6 个请求） */
  const chipCountsTimer = useRef<number | null>(null)
  const scheduleChipCounts = useCallback((base: Record<string, any>) => {
    if (chipCountsTimer.current) window.clearTimeout(chipCountsTimer.current)
    chipCountsTimer.current = window.setTimeout(() => { fetchChipCounts(base) }, 600)
  }, [fetchChipCounts])

  const fetchOrders = useCallback(async (
    page = 1,
    pageSize = 50,
    overrideFilters?: Filters,
    overrideSort?: { sort_by?: string; sort_order?: string },
  ) => {
    setLoading(true)
    try {
      const f = overrideFilters ?? filters
      const s = overrideSort ?? sortInfo
      const params: Record<string, any> = { page, page_size: pageSize }
      const countBase: Record<string, any> = {}
      if (f.keyword) countBase.keyword = f.keyword
      if (f.year) countBase.year = f.year
      if (f.delivery_completed.length > 0) countBase.delivery_completed = f.delivery_completed.join(',')
      if (s.sort_by) params.sort_by = s.sort_by
      if (s.sort_order) params.sort_order = s.sort_order
      if (f.keyword) params.keyword = f.keyword
      if (f.risk_level.length > 0) params.risk_level = f.risk_level.join(',')
      if (f.customer_grade.length > 0) params.customer_grade = f.customer_grade.join(',')
      if (f.department.length > 0) params.department = f.department.join(',')
      if (f.status.length > 0) params.erp_status = f.status.join(',')
      if (f.inspection_result.length > 0) params.inspection_result = f.inspection_result.join(',')
      if (f.packaging_status.length > 0) params.packaging_status = f.packaging_status.join(',')
      if (f.procurement_status.length > 0) params.procurement_status = f.procurement_status.join(',')
      if (f.delivery_completed.length > 0) params.delivery_completed = f.delivery_completed.join(',')
      if (f.is_closed.length > 0) params.is_closed = f.is_closed.join(',')
      if (f.order_type.length > 0) params.order_type = f.order_type.join(',')
      if (f.year) params.year = f.year
      if (f.promised_date_range) {
        params.promised_date_start = f.promised_date_range[0]
        params.promised_date_end = f.promised_date_range[1]
      }
      if (f.shipping_plan_range) {
        params.shipping_plan_start = f.shipping_plan_range[0]
        params.shipping_plan_end = f.shipping_plan_range[1]
      }
      if (f.order_date_range) {
        params.order_date_start = f.order_date_range[0]
        params.order_date_end = f.order_date_range[1]
      }
      if (f.customer_inspection_date_range) {
        params.customer_inspection_date_start = f.customer_inspection_date_range[0]
        params.customer_inspection_date_end = f.customer_inspection_date_range[1]
      }
      if (f.planned_start_date_range) {
        params.planned_start_date_start = f.planned_start_date_range[0]
        params.planned_start_date_end = f.planned_start_date_range[1]
      }
      if (f.material_ready_date_range) {
        params.material_ready_date_start = f.material_ready_date_range[0]
        params.material_ready_date_end = f.material_ready_date_range[1]
      }
      if (f.front_process_date_range) {
        params.front_process_date_start = f.front_process_date_range[0]
        params.front_process_date_end = f.front_process_date_range[1]
      }
      if (f.first_article_date_range) {
        params.first_article_date_start = f.first_article_date_range[0]
        params.first_article_date_end = f.first_article_date_range[1]
      }
      if (f.assembly_start_date_range) {
        params.assembly_start_date_start = f.assembly_start_date_range[0]
        params.assembly_start_date_end = f.assembly_start_date_range[1]
      }
      if (f.assembly_complete_date_range) {
        params.assembly_complete_date_start = f.assembly_complete_date_range[0]
        params.assembly_complete_date_end = f.assembly_complete_date_range[1]
      }
      Object.assign(params, quickViewParams(quickView))
      const res: any = await orderApi.list(params)
      const items = res.data.items || []
      setOrders(items)
      setPagination({ current: res.data.page, pageSize: res.data.page_size, total: res.data.total })
      // 使用后端返回的全局统计
      const stats = res.data.stats || {}
      setSummary({
        total: stats.total || res.data.total,
        red: stats.red_count || 0,
        yellow: stats.yellow_count || 0,
        blue: stats.blue_count || 0,
        green: stats.green_count || 0,
        shortage: stats.shortage_count || 0,
        order_qty_total: stats.order_qty_total || 0,
        order_amount_total: stats.order_amount_total || 0,
      })
      scheduleChipCounts(countBase)
    } catch (err: any) {
      const detail = err?.response?.data?.message || err?.response?.data?.detail || err?.message || '未知错误'
      console.error('[OrderList] fetchOrders failed:', err)
    } finally {
      setLoading(false)
    }
  }, [filters, sortInfo, quickView, quickViewParams, scheduleChipCounts])

  // 第二步：初始化加载数据（在 fetchOrders 定义之后）
  const initialLoadRef = useRef(false)
  useEffect(() => {
    if (shouldInitialLoad && !initialLoadRef.current) {
      fetchOrders()
      initialLoadRef.current = true
    }
  }, [shouldInitialLoad, fetchOrders])

  // 快速视图切换后重新拉取（跳过首次，避免与初始加载重复）
  const quickViewFirstRef = useRef(false)
  useEffect(() => {
    if (!quickViewFirstRef.current) { quickViewFirstRef.current = true; return }
    fetchOrders(1, pagination.pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickView])

  const handleTableChange = (pag: any, tableFilters: any, sorter: any) => {
    let sortField = sorter.field
    const sortOrder = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : undefined
    // 风险等级列按分值排序
    if (sortField === 'risk_level') sortField = 'risk_score'
    
    // 处理各种筛选
    const riskLevelFilter = tableFilters.risk_level?.length > 0 ? tableFilters.risk_level : []
    const customerGradeFilter = tableFilters.customer_grade?.length > 0 ? tableFilters.customer_grade : []
    const departmentFilter = tableFilters.department?.length > 0 ? tableFilters.department : []
    const statusFilter = tableFilters.status?.length > 0 ? tableFilters.status : []
    const inspectionResultFilter = tableFilters.inspection_result?.length > 0 ? tableFilters.inspection_result : []
    const packagingStatusFilter = tableFilters.packaging_status?.length > 0 ? tableFilters.packaging_status : []
    const procurementStatusFilter = tableFilters.procurement_status?.length > 0 ? tableFilters.procurement_status : []
    const deliveryCompletedFilter = tableFilters.delivery_completed_date != null
      ? (tableFilters.delivery_completed_date.length > 0 ? tableFilters.delivery_completed_date : [])
      : filters.delivery_completed
    const orderTypeFilter = tableFilters.order_no?.length > 0 ? tableFilters.order_no : []
    const isClosedFilter = tableFilters.is_closed?.length > 0 ? tableFilters.is_closed : []

    const newSort = { sort_by: sortField, sort_order: sortOrder }
    const newFilters = {
      ...filters,
      risk_level: riskLevelFilter,
      customer_grade: customerGradeFilter,
      department: departmentFilter,
      status: statusFilter,
      inspection_result: inspectionResultFilter,
      packaging_status: packagingStatusFilter,
      procurement_status: procurementStatusFilter,
      delivery_completed: deliveryCompletedFilter,
      is_closed: isClosedFilter,
      order_type: orderTypeFilter,
    }
    setSortInfo(newSort)
    setFilters(newFilters)
    fetchOrders(pag.current, pag.pageSize, newFilters, newSort)
  }

  const handleScan = async () => {
    setScanning(true)
    try {
      const res: any = await riskApi.scan()
      message.success(`扫描完成: ${res.data.new_issues} 个新问题, ${res.data.updated_orders} 个订单更新`)
      fetchOrders()
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setScanning(false)
    }
  }

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true)
    try {
      const res: any = await orderApi.getShippingAnalytics()
      setAnalyticsData(res.data)
    } catch {
      console.error('加载分析数据失败')
    } finally {
      setAnalyticsLoading(false)
    }
  }, [])

  const toggleCharts = () => {
    const next = !showCharts
    setShowCharts(next)
    if (next && !analyticsData) {
      loadAnalytics()
    }
  }

  const buildFilterParams = useCallback(() => {
    const params: Record<string, any> = {}
    if (filters.keyword) params.keyword = filters.keyword
    if (filters.risk_level.length > 0) params.risk_level = filters.risk_level.join(',')
    if (filters.customer_grade.length > 0) params.customer_grade = filters.customer_grade.join(',')
    if (filters.department.length > 0) params.department = filters.department.join(',')
    if (filters.status.length > 0) params.erp_status = filters.status.join(',')
    if (filters.inspection_result.length > 0) params.inspection_result = filters.inspection_result.join(',')
    if (filters.packaging_status.length > 0) params.packaging_status = filters.packaging_status.join(',')
    if (filters.procurement_status.length > 0) params.procurement_status = filters.procurement_status.join(',')
    if (filters.delivery_completed.length > 0) params.delivery_completed = filters.delivery_completed.join(',')
    if (filters.is_closed.length > 0) params.is_closed = filters.is_closed.join(',')
    if (filters.order_type.length > 0) params.order_type = filters.order_type.join(',')
    if (filters.year) params.year = filters.year
    if (filters.promised_date_range) {
      params.promised_date_start = filters.promised_date_range[0]
      params.promised_date_end = filters.promised_date_range[1]
    }
    if (filters.shipping_plan_range) {
      params.shipping_plan_start = filters.shipping_plan_range[0]
      params.shipping_plan_end = filters.shipping_plan_range[1]
    }
    if (filters.order_date_range) {
      params.order_date_start = filters.order_date_range[0]
      params.order_date_end = filters.order_date_range[1]
    }
    if (filters.customer_inspection_date_range) {
      params.customer_inspection_date_start = filters.customer_inspection_date_range[0]
      params.customer_inspection_date_end = filters.customer_inspection_date_range[1]
    }
    if (filters.planned_start_date_range) {
      params.planned_start_date_start = filters.planned_start_date_range[0]
      params.planned_start_date_end = filters.planned_start_date_range[1]
    }
    if (filters.material_ready_date_range) {
      params.material_ready_date_start = filters.material_ready_date_range[0]
      params.material_ready_date_end = filters.material_ready_date_range[1]
    }
    if (filters.front_process_date_range) {
      params.front_process_date_start = filters.front_process_date_range[0]
      params.front_process_date_end = filters.front_process_date_range[1]
    }
    if (filters.first_article_date_range) {
      params.first_article_date_start = filters.first_article_date_range[0]
      params.first_article_date_end = filters.first_article_date_range[1]
    }
    if (filters.assembly_start_date_range) {
      params.assembly_start_date_start = filters.assembly_start_date_range[0]
      params.assembly_start_date_end = filters.assembly_start_date_range[1]
    }
    if (filters.assembly_complete_date_range) {
      params.assembly_complete_date_start = filters.assembly_complete_date_range[0]
      params.assembly_complete_date_end = filters.assembly_complete_date_range[1]
    }
    Object.assign(params, quickViewParams(quickView))
    return params
  }, [filters, quickView, quickViewParams])

  const handleExport = (format: 'xlsx' | 'csv', columns?: string[]) => {
    const params: Record<string, any> = { format, ...buildFilterParams() }
    if (sortInfo.sort_by) { params.sort_by = sortInfo.sort_by; params.sort_order = sortInfo.sort_order || 'asc' }
    if (columns && columns.length > 0) {
      params.columns = columns.join(',')
    }
    const ext = format === 'csv' ? 'csv' : 'xlsx'
    exportData(`/api/v1/orders/export`, params, `订单总控台.${ext}`)
  }

  const handleExportClick = (format: 'xlsx' | 'csv') => {
    setExportFormat(format)
    setExportColumnModalOpen(true)
  }

  const handleExportColumnConfirm = (selectedColumns: string[]) => {
    setExportColumnModalOpen(false)
    handleExport(exportFormat, selectedColumns)
  }

  const handleExportColumnCancel = () => {
    setExportColumnModalOpen(false)
  }

  const handleUnfinishedOrdersToggle = (checked: boolean) => {
    const newFilters = { ...filters, delivery_completed: checked ? ['no'] : [] }
    setFilters(newFilters)
    fetchOrders(1, pagination.pageSize, newFilters, sortInfo)
  }

  const fetchDetail = useCallback(async (orderNo: string, lineNo: string | null) => {
    const cacheKey = `${orderNo}_${lineNo || '10'}`
    if (detailCache[cacheKey] || detailLoading[cacheKey]) return
    setDetailLoading(prev => ({ ...prev, [cacheKey]: true }))
    try {
      const res: any = await orderApi.getDetail(orderNo, lineNo || undefined)
      setDetailCache(prev => ({ ...prev, [cacheKey]: res.data }))
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setDetailLoading(prev => ({ ...prev, [cacheKey]: false }))
    }
  }, [detailCache, detailLoading])

  const columns = useMemo<any[]>(() => [
    // ── 基本信息（固定左侧）──
    {
      title: '销售部门', dataIndex: 'department', key: 'department', minWidth: 70, fixed: 'left' as const,
      sorter: true,
      render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>-</span>,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <Input
            placeholder="输入销售部门"
            value={selectedKeys[0]}
            onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
            style={{ width: 188, marginBottom: 8, display: 'block' }}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => confirm()}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      onFilter: (value: string, record: OrderRow) => 
        record.department ? record.department.toLowerCase().includes(value.toLowerCase()) : false,
    },
    {
      title: '发货完成', dataIndex: 'delivery_completed_date', key: 'delivery_completed_date', minWidth: 90, fixed: 'left' as const,
      render: editableDate('delivery_completed_date', { green: true }), sorter: true,
      filters: [
        { text: '已发货', value: 'yes' },
        { text: '未发货', value: 'no' },
      ],
      filterMultiple: true,
    },
    {
      title: '客户等级', dataIndex: 'customer_grade', key: 'customer_grade', minWidth: 60, fixed: 'left' as const,
      render: editableSelect('customer_grade',
        [{ value: 'A', label: 'A级' }, { value: 'B', label: 'B级' }, { value: 'C', label: 'C级' }, { value: 'D', label: 'D级' }],
        (val) => val ? <Tag color={val === 'A' ? 'red' : val === 'B' ? 'orange' : val === 'C' ? 'blue' : 'default'}>{val}</Tag> : '-'
      ),
      sorter: true,
      filters: [
        { text: 'A级', value: 'A' },
        { text: 'B级', value: 'B' },
        { text: 'C级', value: 'C' },
        { text: 'D级', value: 'D' },
      ],
      filterMultiple: true,
    },
    {
      title: '客户', dataIndex: 'customer_code', key: 'customer_code', minWidth: 70, fixed: 'left' as const,
      ellipsis: true,
      render: (v: string, r: OrderRow) => {
        const firstDashIndex = v?.indexOf('-') ?? -1
        const displayCode = v ? (firstDashIndex !== -1 ? v.substring(firstDashIndex + 1) : v) : ''
        const displayValue = r.customer || displayCode
        if (!displayValue) return '-'
        const tooltip = [r.customer, v].filter(Boolean).join(' / ')
        return <Tooltip title={tooltip}>{displayValue}</Tooltip>
      }, sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <Input
            placeholder="输入客户代码"
            value={selectedKeys[0]}
            onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
            style={{ width: 188, marginBottom: 8, display: 'block' }}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => confirm()}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      onFilter: (value: string, record: OrderRow) => 
        [record.customer_code, record.customer].some(text => text?.toLowerCase().includes(value.toLowerCase())),
    },
    {
      title: '单号', dataIndex: 'order_no', key: 'order_no', minWidth: 120, fixed: 'left' as const,
      render: (v: string, r: OrderRow) => {
        if (!v) return '-'
        const lastDashIndex = v.lastIndexOf('-')
        const afterDash = lastDashIndex !== -1 ? v.substring(lastDashIndex + 1) : v
        // 去除前导零，但至少保留3位
        const displayValue = afterDash.replace(/^0+/, '').padStart(3, '0')
        // 确定订单类型
        let orderTypeTag = null
        if (v.startsWith('HJY')) {
          orderTypeTag = <Tag color="blue" style={{ marginLeft: 4, fontSize: 10, padding: '0 4px', height: 18, lineHeight: '16px' }}>样品</Tag>
        } else if (v.startsWith('HJ')) {
          orderTypeTag = <Tag color="orange" style={{ marginLeft: 4, fontSize: 10, padding: '0 4px', height: 18, lineHeight: '16px' }}>大单</Tag>
        }
        return (
          <Tooltip title={v}>
            <div>
              <a onClick={() => navigate(`/orders/${v}`)} style={{ fontWeight: 600, fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{displayValue}</a>
              {orderTypeTag}
            </div>
          </Tooltip>
        )
      }, sorter: true,
      filters: [
        { text: '大单（HJ开头）', value: 'big' },
        { text: '样品单（HJY开头）', value: 'sample' },
      ],
      filterMultiple: true,
      filteredValue: filters.order_type,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8, width: 200 }}>
          <Input
            placeholder="输入订单号"
            value={selectedKeys.find((k: string) => !['big', 'sample'].includes(k)) || ''}
            onChange={(e) => {
              const typeKeys = selectedKeys.filter((k: string) => ['big', 'sample'].includes(k))
              const newKeys = e.target.value ? [...typeKeys, e.target.value] : typeKeys
              setSelectedKeys(newKeys.length > 0 ? newKeys : [])
            }}
            style={{ width: '100%', marginBottom: 8, display: 'block' }}
          />
          <Checkbox.Group
            value={selectedKeys.filter((k: string) => ['big', 'sample'].includes(k))}
            onChange={(checkedValues) => {
              const textKey = selectedKeys.find((k: string) => !['big', 'sample'].includes(k))
              const newKeys = textKey ? [...checkedValues, textKey] : [...checkedValues]
              setSelectedKeys(newKeys.length > 0 ? newKeys : [])
            }}
            style={{ marginBottom: 8, display: 'block' }}
          >
            <Checkbox value="big">大单（HJ开头）</Checkbox>
            <Checkbox value="sample">样品单（HJY开头）</Checkbox>
          </Checkbox.Group>
          <Space>
            <Button
              type="primary"
              onClick={() => confirm()}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      onFilter: (value: string, record: OrderRow) => {
        if (value === 'big') return record.order_no ? record.order_no.toUpperCase().startsWith('HJ') && !record.order_no.toUpperCase().startsWith('HJY') : false
        if (value === 'sample') return record.order_no ? record.order_no.toUpperCase().startsWith('HJY') : false
        return record.order_no ? record.order_no.toLowerCase().includes(value.toLowerCase()) : false
      },
    },
    {
      title: '风险等级', dataIndex: 'risk_level', key: 'risk_level', minWidth: 80,
      render: editableSelect('risk_level',
        [{ value: 'red', label: '高风险' }, { value: 'yellow', label: '中风险' }, { value: 'blue', label: '低风险' }, { value: 'green', label: '正常' }],
        (val, r) => <RiskBadge level={val} onClick={() => { setSelectedOrder(r); setRiskModalOpen(true) }} />
      ),
      sorter: true,
      filters: [
        { text: '高风险', value: 'red' },
        { text: '中风险', value: 'yellow' },
        { text: '低风险', value: 'blue' },
        { text: '正常', value: 'green' },
      ],
      filterMultiple: true,
    },
    {
      title: '数量', dataIndex: 'order_qty', key: 'order_qty', minWidth: 60, align: 'right' as const,
      render: (v: number | null) => v != null ? v.toLocaleString() : <span style={{ color: '#cbd5e1' }}>-</span>, sorter: true,
    },
    {
      title: '金额', dataIndex: 'order_amount', key: 'order_amount', minWidth: 80, align: 'right' as const,
      render: (v: number | null) => v != null ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : <span style={{ color: '#cbd5e1' }}>-</span>, sorter: true,
    },
    {
      title: '完成数量', dataIndex: 'completed_qty', key: 'completed_qty', minWidth: 80, align: 'right' as const,
      render: editableNumber('completed_qty', 0), sorter: true,
    },
    {
      title: '下单时间', dataIndex: 'order_date', key: 'order_date', minWidth: 90,
      render: (v: string) => <DateCell value={v} />, sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, order_date_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, order_date_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
    },
    // ── 交期 & 计划 ──
    {
      title: '合同交期', dataIndex: 'promised_date', key: 'promised_date', minWidth: 85,
      render: (v: string | null, r: OrderRow) => <DateCell value={v} overdue={!!(v && v < today() && r.status !== 'closed')} />, sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, promised_date_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, promised_date_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
    },
    {
      title: '出货计划', dataIndex: 'shipping_plan', key: 'shipping_plan', minWidth: 85,
      render: editableDate('shipping_plan'), sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, shipping_plan_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, shipping_plan_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
    },
    {
      title: '客户验货时间', dataIndex: 'customer_inspection_date', key: 'customer_inspection_date', minWidth: 100,
      render: editableDate('customer_inspection_date'), sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, customer_inspection_date_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, customer_inspection_date_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    {
      title: '上线时间', dataIndex: 'planned_start_date', key: 'planned_start_date', minWidth: 85,
      render: editableDate('planned_start_date'), sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, planned_start_date_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, planned_start_date_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    {
      title: '客检结果', dataIndex: 'inspection_result', key: 'inspection_result', minWidth: 70,
      render: editableSelect('inspection_result',
        [{ value: 'OK', label: 'OK / 通过' }, { value: 'NG', label: 'NG / 不通过' }, { value: '待检', label: '待检' }],
        (val) => {
          if (!val) return '-'
          const color = val === 'OK' || val === '通过' ? '#16a34a' : val === 'NG' ? '#e11d48' : undefined
          return <span style={{ color, fontWeight: 600 }}>{val}</span>
        }
      ),
      filters: [
        { text: 'OK', value: 'OK' },
        { text: '通过', value: '通过' },
        { text: 'NG', value: 'NG' },
        { text: '不通过', value: '不通过' },
        { text: '待检', value: '待检' },
      ],
      filterMultiple: true,
    },
    {
      title: '包装完成状况', dataIndex: 'packaging_status', key: 'packaging_status', minWidth: 100,
      ellipsis: true,
      render: editableText('packaging_status', (val) => {
        if (!val) return <span style={{ color: '#cbd5e1' }}>-</span>
        const isBlue = val.includes('完成') && !val.includes('入库')
        const isGreen = val.includes('入库')
        return <span style={{ color: isGreen ? '#16a34a' : isBlue ? '#2563eb' : undefined }}>{val}</span>
      }),
      filters: [
        { text: '完成', value: '完成' },
        { text: '入库', value: '入库' },
        { text: '进行中', value: '进行中' },
        { text: '未开始', value: '未开始' },
      ],
      filterMultiple: true,
    },
    {
      title: 'BOM回收', dataIndex: 'bom_return_date', key: 'bom_return_date', minWidth: 80,
      render: editableDate('bom_return_date'), sorter: true,
    },
    {
      title: '料齐套时间', dataIndex: 'material_ready_date', key: 'material_ready_date', minWidth: 85,
      render: editableDate('material_ready_date', { green: true }), sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, material_ready_date_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, material_ready_date_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    // ── 发货 & 采购 ──
    {
      title: '发货状态即时说明', dataIndex: 'shipping_status_desc', key: 'shipping_status_desc', minWidth: 120,
      ellipsis: true,
      render: editableText('shipping_status_desc'),
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <Input
            placeholder="输入发货状态说明"
            value={selectedKeys[0]}
            onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
            style={{ width: 188, marginBottom: 8, display: 'block' }}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => confirm()}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      onFilter: (value: string, record: OrderRow) => 
        record.shipping_status_desc ? record.shipping_status_desc.toLowerCase().includes(value.toLowerCase()) : false,
    },
    {
      title: '采购物料齐套', dataIndex: 'procurement_status', key: 'procurement_status', minWidth: 100,
      ellipsis: true,
      render: (_v: string, r: OrderRow) => {
        if (!r.kit_total_materials || r.kit_rate == null || !r.kit_risk_level) {
          return <span style={{ color: '#cbd5e1' }}>-</span>
        }
        const percent = Math.round(r.kit_rate * 100)
        const color = r.kit_risk_level === 'green' ? 'success' : r.kit_risk_level === 'yellow' ? 'warning' : 'error'
        return (
          <Tooltip title={`${r.kit_received_materials}/${r.kit_total_materials}`}>
            <Tag color={color}>{r.kit_status || ''} {percent}%</Tag>
          </Tooltip>
        )
      },
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <Input
            placeholder="输入采购状态"
            value={selectedKeys[0]}
            onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
            style={{ width: 188, marginBottom: 8, display: 'block' }}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => confirm()}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      onFilter: (value: string, record: OrderRow) => 
        record.procurement_status ? record.procurement_status.toLowerCase().includes(value.toLowerCase()) : false,
    },
    // ── 物料分类到料日期（16列 from material_dates JSONB）──
    ...MATERIAL_KEYS.map(key => ({
      title: key, key: `mat_${key}`, minWidth: key.length > 6 ? 100 : 70,
      render: (_: any, r: OrderRow) => editableDate(`mat_${key}`)(r.material_dates?.[key] || null, r),
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters }
                if (selectedKeys[0]) {
                  const materialKey = `${key}_date_range` as keyof Filters
                  ;(newFilters as any)[materialKey] = selectedKeys[0]
                }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters }
                const materialKey = `${key}_date_range` as keyof Filters
                ;(newFilters as any)[materialKey] = null
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    })),
    // ── 生产节点 ──
    {
      title: '前道', dataIndex: 'front_process_date', key: 'front_process_date', minWidth: 80,
      render: editableDate('front_process_date'), sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, front_process_date_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, front_process_date_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    {
      title: '首件检验日期', dataIndex: 'first_article_date', key: 'first_article_date', minWidth: 100,
      render: editableDate('first_article_date'), sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, first_article_date_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, first_article_date_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    {
      title: '组装上线日期', dataIndex: 'assembly_start_date', key: 'assembly_start_date', minWidth: 100,
      render: editableDate('assembly_start_date'), sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, assembly_start_date_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, assembly_start_date_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    {
      title: '组装完成日期', dataIndex: 'assembly_complete_date', key: 'assembly_complete_date', minWidth: 100,
      render: editableDate('assembly_complete_date', { green: true }), sorter: true,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <RangePicker
            locale={zhCN.DatePicker}
            value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) {
                setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
              } else {
                setSelectedKeys([])
              }
            }}
            style={{ width: 250, marginBottom: 8, display: 'block' }}
            placeholder={['开始日期', '结束日期']}
          />
          <Space>
            <Button
              type="primary"
              onClick={() => {
                const newFilters = { ...filters, assembly_complete_date_range: selectedKeys[0] || null }
                setFilters(newFilters)
                confirm()
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              筛选
            </Button>
            <Button
              onClick={() => {
                clearFilters()
                const newFilters = { ...filters, assembly_complete_date_range: null }
                setFilters(newFilters)
                fetchOrders(pagination.current, pagination.pageSize, newFilters, sortInfo)
              }}
              size="small"
            >
              重置
            </Button>
          </Space>
        </div>
      ),
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    // ── 备注 ──
    {
      title: '备注', dataIndex: 'remark', key: 'remark', minWidth: 120,
      ellipsis: true,
      render: editableText('remark'),
    },
    {
      title: '是否关闭', dataIndex: 'is_closed', key: 'is_closed', minWidth: 70,
      render: (v: number) => v === 1 ? <Tag color="default">已关闭</Tag> : <Tag color="green">未关闭</Tag>,
      filters: [
        { text: '已关闭', value: '1' },
        { text: '未关闭', value: '0' },
      ],
      filterMultiple: true,
      filteredValue: filters.is_closed,
    },
    {
      title: '状态', dataIndex: 'erp_status', key: 'status', minWidth: 80,
      render: (v: number | null) => <ErpStatusTag value={v} />,
      sorter: true,
      filters: [
        { text: '未审核', value: 0 },
        { text: '审核', value: 1 },
        { text: '部分关闭', value: 2 },
        { text: '已关闭', value: 3 },
      ],
      filterMultiple: true,
    },
    {
      title: '操作', key: 'action', width: 108, fixed: 'right' as const,
      render: (_: any, r: OrderRow) => (
        <span className="sc-row-actions">
          <a onClick={() => navigate(`/orders/${r.order_no}`)}>详情</a>
          <a onClick={() => navigate(`/stock-check?orderNo=${r.order_no}`)} title="盘点物料库存">盘点</a>
          <a onClick={() => startRowEd(r)} title="打开编辑弹窗，集中维护本单全部可填写字段">编辑</a>
        </span>
      ),
    },
  ].filter(col => col.key === 'action' || visibleColumnKeys.includes(col.key))
   .map(col => {
    if (col.key === 'action') return col
    const meta = FIELD_EDIT_META[col.key]
    /* 列宽需容纳表头（左侧标记预留区 + 标题 + 筛选图标 + 内边距）；剥离 ellipsis，记录不省略（自然换行） */
    const headerW = (typeof col.title === 'string' ? col.title.length * 13 : 80) + 78
    return {
      ...col,
      ellipsis: undefined,
      width: Math.max(col.minWidth || 100, headerW),
      onHeaderCell: meta?.edit
        ? () => ({ className: 'sc-hed', title: '✎ 可手工填写：点击单元格行内编辑' })
        : meta?.ro
          ? () => ({ className: 'sc-hro', title: `🔒 ${meta.ro}` })
          : undefined,
    }
  }), [editingCell, savingCell, handleCellSave, navigate, filters, pagination, sortInfo, fetchOrders, visibleColumnKeys, sessionEdited, flashCells, fieldRemarks, startRowEd])

  // 图例统计（当前可见列中可手工填写 / 只读数量）
  const visMeta = visibleColumnKeys.map(k => FIELD_EDIT_META[k]).filter(Boolean)
  const edCount = visMeta.filter(m => m!.edit).length
  const roCount = visMeta.filter(m => m!.ro).length
  const extColCount = visibleColumnKeys.filter(k => !DEFAULT_COLUMN_KEYS.includes(k)).length
  const listHint = `${QUICK_VIEW_DEFS.find(v => v.key === quickView)?.label ?? '全部订单'}${filters.delivery_completed.includes('no') ? '（未完成）' : ''}`

  const applyColumns = (next: string[]) => {
    if (next.length === 0) return
    setVisibleColumnKeys(next)
    setColumnVisibility(ORDER_LIST_PAGE_KEY, next)
  }
  const toggleGroupKeys = (gKeys: string[], on: boolean) => {
    const cur = new Set(visibleColumnKeys)
    gKeys.forEach(k => { if (on) cur.add(k); else cur.delete(k) })
    if (cur.size === 0) return
    applyColumns(Array.from(cur))
  }

  return (
    <div className={`sc-page${highlightEdit ? ' sc-hl' : ''}`}>

      {/* ── 工具栏：搜索 + 快速视图 chips + 右侧动作 ── */}
      <div className="sc-toolbar">
        <Input
          placeholder="订单号 / 客户 / 产品"
          prefix={<SearchOutlined />}
          allowClear
          value={filters.keyword}
          onChange={e => {
            const newKeyword = e.target.value
            setFilters(f => ({ ...f, keyword: newKeyword }))
            // 直接传递新的keyword值，避免状态更新延迟问题
            const newFilters = { ...filters, keyword: newKeyword }
            fetchOrders(1, pagination.pageSize, newFilters)
          }}
          style={{ width: 230 }}
        />
        <span
          className={`sc-chip${filters.delivery_completed.includes('no') ? '' : ' on'}`}
          style={{ cursor: 'pointer' }}
          onClick={() => handleUnfinishedOrdersToggle(filters.delivery_completed.includes('no') ? false : true)}
          title="是否包含已关闭/已交付订单"
        >含已关闭 <span className="n">{chipCounts.all ?? '-'}</span></span>
        {QUICK_VIEW_DEFS.map(v => {
          const hot = (v.key === 'high' && (chipCounts.high ?? 0) > 0) || (v.key === 'overdue' && (chipCounts.overdue ?? 0) > 0)
          const cnt = v.key === 'all' ? summary.total : chipCounts[v.key]
          return (
            <span
              key={v.key}
              className={`sc-chip${quickView === v.key ? ' on' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => setQuickView(v.key)}
            >{v.label} <span className={`n${hot ? ' hot' : ''}`}>{cnt ?? '-'}</span></span>
          )
        })}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            className={`sc-chip${highlightEdit ? ' on' : ''}`}
            style={{ cursor: 'pointer' }}
            onClick={() => setHighlightEdit(v => !v)}
            title="给所有 ✎ 可手工填写列铺上底色，一眼分辨可编辑范围"
          ><EditOutlined /> 高亮可编辑列</span>
          <Select<number | null>
            value={filters.year}
            placeholder="全部年份"
            allowClear
            style={{ width: 96 }}
            onChange={(v) => {
              const newFilters = { ...filters, year: v ?? null }
              setFilters(newFilters)
              fetchOrders(1, pagination.pageSize, newFilters, sortInfo)
            }}
            options={YEAR_OPTIONS.map(y => ({ value: y, label: `${y}年` }))}
          />
          <Button icon={<SettingOutlined />} onClick={() => setColsDrawerOpen(true)}>
            列设置{extColCount > 0 && <span className="sc-extdot">扩展 {extColCount}</span>}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => fetchOrders()} title="刷新" />
          <Button
            icon={<BarChartOutlined />}
            type={showCharts ? 'primary' : 'default'}
            onClick={toggleCharts}
          >
            {showCharts ? '隐藏图表' : '分析图表'}
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'xlsx', label: '导出 Excel', icon: <DownloadOutlined /> },
                { key: 'csv', label: '导出 CSV', icon: <DownloadOutlined /> },
              ],
              onClick: ({ key }) => handleExportClick(key as 'xlsx' | 'csv'),
            }}
          >
            <Button icon={<DownloadOutlined />} loading={exporting}>导出 <DownOutlined /></Button>
          </Dropdown>
          <Button type="primary" icon={<AuditOutlined />} onClick={handleScan} loading={scanning}>风险扫描</Button>
        </div>
      </div>

      {/* ── 行内编辑提示条（可关闭，本机记忆） ── */}
      {!tipDismissed && (
        <div className="sc-edit-tip">
          <EditOutlined className="ic" />
          <span>
            <b>行内编辑：</b>带 <b>✎</b> 的 <b>{edCount}</b> 列点击即编——日期弹出日历（含 今天 / 明天 / +3天 / +7天 快捷项，✕ 清除），
            下拉弹出选项，文本/数字直接输入；<b>Enter / Tab 保存并跳到下一格</b>，Esc 取消；空格虚线 <b>＋</b> 表示待填写，
            保存过的值带 <span className="sc-mdot" /> 手工标记。灰 <b>🔒</b> 列为 ERP / 自动计算只读。
            行尾「编辑」打开弹窗集中维护整单字段，保存按钮实时显示修改处数。
          </span>
          <a className="x" onClick={() => {
            setTipDismissed(true)
            try { localStorage.setItem('order_edit_tip_dismissed', '1') } catch { /* ignore */ }
          }}>知道了</a>
        </div>
      )}

      {showCharts && (
        <ShippingAnalyticsCharts loading={analyticsLoading} data={analyticsData} />
      )}

      <div className="card-modern order-list-card" style={{ padding: '2px 0 0' }}>
        <div className="sc-card-head">
          <h3>订单列表</h3>
          <span className="sc-hint">{listHint}</span>
          <span className="sc-legend" title="带 ✎ 的列点击单元格即可行内编辑"><EditOutlined className="ic-edit" /><b>{edCount}</b> 列可手动填写</span>
          <span className="sc-legend" title="ERP 同步 / 系统自动计算，不可手工修改"><LockOutlined className="ic-ro" /><b>{roCount}</b> 列只读</span>
          <span style={{ marginLeft: 'auto', fontSize: 'calc(12px * var(--font-size-scale))', color: '#94a3b8' }}>
            高危 <b style={{ color: '#dc2626' }}>{summary.red + summary.yellow}</b> · 已逾期 <b style={{ color: '#dc2626' }}>{chipCounts.overdue ?? '-'}</b> · 缺料 <b style={{ color: '#ea580c' }}>{summary.shortage}</b>
          </span>
        </div>
        <div className="table-modern">
          <Table
            columns={columns}
            dataSource={orders}
            rowKey={(r) => `${r.id}`}
            loading={loading}
            size="small"
            tableLayout="fixed"
            scroll={{
              x: columns.reduce((s: number, c: any) => s + (c.width ?? c.minWidth ?? 100), 0) + 48,
              y: 'calc(100vh - 380px)',
            }}
            locale={{ emptyText: '暂无订单数据' }}
            onChange={handleTableChange}
            summary={() => {
              const visKeys: string[] = columns.map((c: any) => c.key)
              const qtyIdx = visKeys.indexOf('order_qty')
              const amtIdx = visKeys.indexOf('order_amount')
              const lastIdx = visKeys.length - 1
              // 数量/金额都隐藏时，只显示合计标签
              if (qtyIdx === -1 && amtIdx === -1) {
                return (
                  <Table.Summary fixed>
                    <Table.Summary.Row>
                      <Table.Summary.Cell index={0} colSpan={Math.max(1, lastIdx + 1)}>
                        <span style={{ fontWeight: 600 }}>合计</span>
                      </Table.Summary.Cell>
                    </Table.Summary.Row>
                  </Table.Summary>
                )
              }
              const firstNumIdx = qtyIdx !== -1 ? qtyIdx : amtIdx
              const lastNumIdx = amtIdx !== -1 ? amtIdx : qtyIdx
              const cells: React.ReactNode[] = []
              // 合计标签（占据第一个数值列之前的所有列）
              if (firstNumIdx > 0) {
                cells.push(
                  <Table.Summary.Cell key="label" index={0} colSpan={firstNumIdx}>
                    <span style={{ fontWeight: 600 }}>合计</span>
                  </Table.Summary.Cell>
                )
              }
              // 在两个数值列之间逐列填充
              for (let i = firstNumIdx; i <= lastNumIdx; i++) {
                if (i === qtyIdx) {
                  cells.push(
                    <Table.Summary.Cell key="qty" index={i} align="right">
                      <span style={{ fontWeight: 600 }}>{summary.order_qty_total?.toLocaleString() || '0'}</span>
                    </Table.Summary.Cell>
                  )
                } else if (i === amtIdx) {
                  cells.push(
                    <Table.Summary.Cell key="amt" index={i} align="right">
                      <span style={{ fontWeight: 600 }}>{summary.order_amount_total?.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}</span>
                    </Table.Summary.Cell>
                  )
                } else {
                  cells.push(<Table.Summary.Cell key={`gap-${i}`} index={i} />)
                }
              }
              // 末尾填充（排除操作列）
              const fillerStart = lastNumIdx + 1
              const fillerSpan = lastIdx - fillerStart
              if (fillerSpan > 0) {
                cells.push(<Table.Summary.Cell key="filler" index={fillerStart} colSpan={fillerSpan} />)
              }
              return (
                <Table.Summary fixed>
                  <Table.Summary.Row>
                    {cells}
                  </Table.Summary.Row>
                </Table.Summary>
              )
            }}
            expandable={{
              expandedRowKeys: expandedKeys,
              onExpandedRowsChange: (keys) => {
                const newKeys = keys as string[]
                // auto-fetch detail for newly expanded rows
                const added = newKeys.filter(k => !expandedKeys.includes(k))
                added.forEach(key => {
                  const order = orders.find(o => `${o.id}` === key)
                  if (order) fetchDetail(order.order_no, null)
                })
                setExpandedKeys(newKeys)
              },
              expandedRowRender: (record: OrderRow) => {
                const cacheKey = `${record.order_no}_${record.line_no || '10'}`
                const detail = detailCache[cacheKey]
                if (detailLoading[cacheKey] && !detail) {
                  return <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
                }
                const lineColumns = [
                  { 
                    title: '明细ID', 
                    dataIndex: 'erp_line_id', 
                    width: 120, 
                    ellipsis: true, 
                    render: (v: string) => v || '-',
                    filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
                      <div style={{ padding: 8 }}>
                        <Input
                          placeholder="输入明细ID"
                          value={selectedKeys[0]}
                          onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
                          style={{ width: 188, marginBottom: 8, display: 'block' }}
                        />
                        <Space>
                          <Button
                            type="primary"
                            onClick={() => confirm()}
                            size="small"
                          >
                            筛选
                          </Button>
                          <Button
                            onClick={() => clearFilters()}
                            size="small"
                          >
                            重置
                          </Button>
                        </Space>
                      </div>
                    ),
                    filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
                    onFilter: (value: any, record: any) => 
                      record.erp_line_id ? record.erp_line_id.toLowerCase().includes(String(value).toLowerCase()) : false,
                  },
                  { 
                    title: '产品编码', 
                    dataIndex: 'product_code', 
                    width: 150, 
                    ellipsis: true,
                    filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
                      <div style={{ padding: 8 }}>
                        <Input
                          placeholder="输入产品编码"
                          value={selectedKeys[0]}
                          onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
                          style={{ width: 188, marginBottom: 8, display: 'block' }}
                        />
                        <Space>
                          <Button
                            type="primary"
                            onClick={() => confirm()}
                            size="small"
                          >
                            筛选
                          </Button>
                          <Button
                            onClick={() => clearFilters()}
                            size="small"
                          >
                            重置
                          </Button>
                        </Space>
                      </div>
                    ),
                    filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
                    onFilter: (value: any, record: any) => 
                      record.product_code ? record.product_code.toLowerCase().includes(String(value).toLowerCase()) : false,
                  },
                  { 
                    title: '产品名称', 
                    dataIndex: 'product_name', 
                    width: 200, 
                    ellipsis: true,
                    filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
                      <div style={{ padding: 8 }}>
                        <Input
                          placeholder="输入产品名称"
                          value={selectedKeys[0]}
                          onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
                          style={{ width: 188, marginBottom: 8, display: 'block' }}
                        />
                        <Space>
                          <Button
                            type="primary"
                            onClick={() => confirm()}
                            size="small"
                          >
                            筛选
                          </Button>
                          <Button
                            onClick={() => clearFilters()}
                            size="small"
                          >
                            重置
                          </Button>
                        </Space>
                      </div>
                    ),
                    filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
                    onFilter: (value: any, record: any) => 
                      record.product_name ? record.product_name.toLowerCase().includes(String(value).toLowerCase()) : false,
                  },
                  { 
                    title: '产品型号', 
                    dataIndex: 'product_model', 
                    width: 150, 
                    ellipsis: true,
                    render: (v: string) => v || '-',
                  },
                  {
                    title: '数量',
                    dataIndex: 'order_qty',
                    width: 100,
                    render: (v: number) => v?.toLocaleString() || '-',
                    filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
                      <div style={{ padding: 8 }}>
                        <Input
                          placeholder="输入数量"
                          value={selectedKeys[0]}
                          onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
                          style={{ width: 188, marginBottom: 8, display: 'block' }}
                        />
                        <Space>
                          <Button
                            type="primary"
                            onClick={() => confirm()}
                            size="small"
                          >
                            筛选
                          </Button>
                          <Button
                            onClick={() => clearFilters()}
                            size="small"
                          >
                            重置
                          </Button>
                        </Space>
                      </div>
                    ),
                    filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
                    onFilter: (value: any, record: any) =>
                      record.order_qty ? record.order_qty.toString().includes(String(value)) : false,
                  },
                  {
                    title: '金额',
                    dataIndex: 'order_amount',
                    width: 120,
                    align: 'right' as const,
                    render: (v: number) => v?.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '-',
                  },
                  {
                    title: '工价',
                    dataIndex: 'labor_price_amount',
                    width: 100,
                    align: 'right' as const,
                    render: (v: number) => v != null ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-',
                  },
                  {
                    title: '交期',
                    dataIndex: 'promised_date',
                    width: 120,
                    render: (v: string) => <DateCell value={v} overdue={!!(v && v < today())} />,
                    filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
                      <div style={{ padding: 8 }}>
                        <RangePicker
                          locale={zhCN.DatePicker}
                          value={selectedKeys[0] ? [dayjs(selectedKeys[0][0]), dayjs(selectedKeys[0][1])] : null}
                          onChange={(dates) => {
                            if (dates && dates[0] && dates[1]) {
                              setSelectedKeys([[dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')]])
                            } else {
                              setSelectedKeys([])
                            }
                          }}
                          style={{ width: 250, marginBottom: 8, display: 'block' }}
                          placeholder={['开始日期', '结束日期']}
                        />
                        <Space>
                          <Button
                            type="primary"
                            onClick={() => confirm()}
                            size="small"
                          >
                            筛选
                          </Button>
                          <Button
                            onClick={() => clearFilters()}
                            size="small"
                          >
                            重置
                          </Button>
                        </Space>
                      </div>
                    ),
                    filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
                    onFilter: (value: any, record: any) => {
                      if (!value || !Array.isArray(value) || value.length !== 2) return true
                      const date = record.promised_date
                      if (!date) return false
                      return date >= value[0] && date <= value[1]
                    },
                  },
                ]
                if (!detail) return null
                return (
                  <div style={{ padding: '8px 0' }}>
                    <Table
                      columns={lineColumns}
                      dataSource={detail.lines}
                      rowKey="id"
                      size="small"
                      pagination={false}
                      scroll={{ x: 670 }}
                      locale={{ emptyText: '暂无明细行' }}
                    />
                  </div>
                )
              },
            }}
            pagination={{
              ...pagination,
              showSizeChanger: true,
              pageSizeOptions: ['20', '50', '100'],
              showTotal: (total) => `共 ${total} 条`,
              style: { padding: '0 16px' },
            }}
          />
        </div>
      </div>

      {/* ── 编辑弹窗（整单字段集中维护，一次保存） ── */}
      <Modal
        open={editModalOpen}
        onCancel={cancelRowEd}
        width={880}
        style={{ top: 28 }}
        rootClassName="sc-page"
        title={<span><EditOutlined style={{ marginRight: 8 }} />编辑订单 — {rowEdRecord?.order_no ?? ''}</span>}
        footer={[
          <Button key="cancel" onClick={cancelRowEd}>取消</Button>,
          <Button key="save" type="primary" icon={<SaveOutlined />} loading={saving} onClick={saveRowEd}>
            保存{rowDirtyCount > 0 ? `（${rowDirtyCount} 处修改）` : ''}
          </Button>,
        ]}
        destroyOnClose
      >
        <div className="sc-frm-ro">
          <div><div className="k">销售部门</div><div className="v">{rowEdRecord?.department || '-'}</div></div>
          <div><div className="k">客户</div><div className="v">{rowEdRecord?.customer || rowEdRecord?.customer_code || '-'}</div></div>
          <div><div className="k">单号</div><div className="v" style={{ fontFamily: 'Consolas, Menlo, monospace' }}>{rowEdRecord?.order_no || '-'}</div></div>
          <div><div className="k">数量</div><div className="v">{rowEdRecord?.order_qty?.toLocaleString() ?? '-'}</div></div>
          <div><div className="k">合同交期</div><div className="v">{rowEdRecord?.promised_date || '-'}</div></div>
        </div>
        {EDIT_SECTIONS.map(sec => (
          <React.Fragment key={sec.title}>
            <div className="sc-frm-sec">{sec.title}</div>
            <Row gutter={[12, 10]}>
              {sec.fields.map(f => (
                <Col span={sec.fields.length > 8 ? 6 : 8} key={f.k}>
                  <span className="sc-frm-label">{f.label}</span>
                  {f.t === 'date' && (
                    <DatePicker
                      size="small" style={{ width: '100%' }} presets={DATE_PRESETS} allowClear
                      value={rowEdDraft[f.k] ? dayjs(rowEdDraft[f.k]) : null}
                      onChange={(d) => setDraftVal(f.k, d ? d.format('YYYY-MM-DD') : null)}
                    />
                  )}
                  {f.t === 'select' && (
                    <Select
                      size="small" style={{ width: '100%' }} allowClear options={f.opts}
                      value={rowEdDraft[f.k] ?? undefined}
                      onChange={(v) => setDraftVal(f.k, v ?? null)}
                    />
                  )}
                  {f.t === 'number' && (
                    <InputNumber
                      size="small" style={{ width: '100%' }} min={0}
                      value={rowEdDraft[f.k] ?? undefined}
                      onChange={(v) => setDraftVal(f.k, v ?? null)}
                    />
                  )}
                  {f.t === 'text' && (
                    <Input
                      size="small" allowClear
                      value={rowEdDraft[f.k] ?? ''}
                      onChange={(e) => setDraftVal(f.k, e.target.value)}
                    />
                  )}
                </Col>
              ))}
            </Row>
          </React.Fragment>
        ))}
      </Modal>

      {/* ── 列设置抽屉 ── */}
      <Drawer
        open={colsDrawerOpen}
        onClose={() => setColsDrawerOpen(false)}
        width={400}
        title="列设置"
        rootClassName="sc-page"
        extra={
          <Space size="small">
            <Button size="small" onClick={() => applyColumns(DEFAULT_COLUMN_KEYS)}>仅核心列</Button>
            <Button size="small" onClick={() => applyColumns(ORDER_COLUMN_KEYS)}>显示全部</Button>
          </Space>
        }
      >
        <div style={{ fontSize: 'calc(12px * var(--font-size-scale))', color: '#94a3b8', marginBottom: 12, lineHeight: 1.8 }}>
          核心列常显（含 <b>✎</b> 可编辑列与 <b>🔒</b> 只读列）；扩展列组勾选后即时加入表格，全部支持行内填写（本机记忆）。
          齐套率 = 已到齐 ÷ 物料数，由系统自动计算；客户 / 单号 / 下单时间 / ERP状态 来自 ERP 同步，只读。
        </div>
        {ORDER_COLUMN_GROUPS.map(group => {
          const gKeys = group.keys.map(k => k.key)
          const allOn = gKeys.every(k => visibleColumnKeys.includes(k))
          const edN = gKeys.filter(k => FIELD_EDIT_META[k]?.edit).length
          return (
            <div key={group.title} style={{ marginBottom: 14 }}>
              <div className="sc-grp-row">
                <span style={{ fontWeight: 600 }}>{group.title}</span>
                <span className="cnt">{gKeys.length} 列</span>
                {edN > 0 && <span className="edn">✎ {edN} 可填写</span>}
                <Switch size="small" checked={allOn} onChange={(v) => toggleGroupKeys(gKeys, v)} />
              </div>
              <Checkbox.Group
                value={visibleColumnKeys.filter(k => gKeys.includes(k))}
                onChange={(checked) => {
                  const cur = new Set(visibleColumnKeys.filter(k => !gKeys.includes(k)))
                  const nextInGroup = checked as string[]
                  nextInGroup.forEach(k => cur.add(k))
                  if (cur.size === 0) return
                  applyColumns(Array.from(cur))
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, auto)', gap: '2px 16px', padding: '4px 0 0 2px' }}>
                  {group.keys.map(({ key, label }) => (
                    <Checkbox key={key} value={key}>{label}</Checkbox>
                  ))}
                </div>
              </Checkbox.Group>
            </div>
          )
        })}
      </Drawer>

      {/* ── 风险详情弹窗 ── */}
      <RiskDetailModal
        visible={riskModalOpen}
        order={selectedOrder}
        onClose={() => { setRiskModalOpen(false); setSelectedOrder(null) }}
      />

      {/* ── 导出列选择弹窗 ── */}
      <ExportColumnSelector
        open={exportColumnModalOpen}
        columns={generateExportColumns(columns)}
        onConfirm={handleExportColumnConfirm}
        onCancel={handleExportColumnCancel}
      />
    </div>
  )
}
