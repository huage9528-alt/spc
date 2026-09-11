import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DatePicker, message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import ExportColumnSelector, { type ExportColumnOption } from '@/components/ExportColumnSelector'
import { useExport } from '@/hooks/useExport'
import { materialApi } from '@/services/api'
import { useUiPreferencesStore } from '@/store/uiPreferences'
import './prototype.css'

interface CoverageItem {
  material_id: number
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  wh_id?: number | null
  wh_name?: string | null
  system_qty?: number | string | null
  req_qty?: number | string | null
  is_checked: boolean
  recent_check_no?: string | null
  recent_check_date?: string | null
  task_nos?: string[]
  order_nos?: string[]
}

interface CoverageStats {
  task_count: number
  product_count: number
  row_count: number
  checked_count: number
  unchecked_count: number
  checked_rate: number | null
}

interface NoBomTask { task_no?: string | null; material_code?: string | null; material_name?: string | null }

interface WarehousePreview {
  material_id: number
  material_code?: string | null
  material_name?: string | null
  system_qty?: number | string | null
  req_qty?: number | string | null
}

interface WarehouseSummary {
  wh_id?: number | null
  wh_name?: string | null
  row_count: number
  checked_count: number
  unchecked_count: number
  preview_items: WarehousePreview[]
}

interface MaterialOrderRow {
  order_no: string
  req_qty?: number | string | null
  task_nos?: string[]
}

interface MaterialOrdersData {
  material_id: number
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  req_qty?: number | string | null
  orders: MaterialOrderRow[]
  no_order_qty?: number | string | null
}

const VIEWS = [
  { key: 'A', name: '物料清单' },
  { key: 'C', name: '仓库执行包' },
] as const
type ViewKey = typeof VIEWS[number]['key']

interface TscCol {
  key: string
  title: string
  sortKey?: string
  filter?: 'wh' | 'status'
  align?: 'right'
}

/** 列宽见 DEFAULT_COL_WIDTHS（可拖动调整并持久化） */
const TSC_COLS: TscCol[] = [
  { key: 'material_code', title: '物料', sortKey: 'material_code' },
  { key: 'wh_name', title: '仓库', sortKey: 'wh_name', filter: 'wh' },
  { key: 'system_qty', title: '当前库存', sortKey: 'system_qty', align: 'right' },
  { key: 'req_qty', title: '需求总量', sortKey: 'req_qty', align: 'right' },
  { key: 'is_checked', title: '盘点状态', sortKey: 'is_checked', filter: 'status' },
  { key: 'task_count', title: '关联任务单', sortKey: 'task_count' },
  { key: 'order_nos', title: '关联订单' },
]

const PAGE_SIZES = [20, 50, 100, 200]

/** 列宽默认值（px），colgroup + table-layout:fixed 生效；用户拖动后按 key 持久化覆盖 */
const DEFAULT_COL_WIDTHS: Record<string, number> = {
  material_code: 260,
  wh_name: 170,
  system_qty: 110,
  req_qty: 110,
  is_checked: 150,
  task_count: 150,
  order_nos: 230,
}
const COL_WIDTHS_KEY = 'task_stock_coverage_columns'
const MIN_COL_WIDTH = 60

/** 导出字段选项（field 与后端导出端点列 key 一致） */
const EXPORT_FIELDS: ExportColumnOption[] = [
  { field: 'material_code', label: '物料编码' },
  { field: 'material_name', label: '物料名称' },
  { field: 'spec_model', label: '规格' },
  { field: 'unit', label: '单位' },
  { field: 'wh_name', label: '仓库' },
  { field: 'system_qty', label: '当前库存' },
  { field: 'req_qty', label: '需求总量' },
  { field: 'is_checked', label: '盘点状态' },
  { field: 'recent_check_no', label: '最近盘点单' },
  { field: 'recent_check_date', label: '最近盘点日期' },
  { field: 'task_nos', label: '关联任务单' },
  { field: 'order_nos', label: '关联订单' },
]

const WH_COLORS: Array<[string, string]> = [
  ['var(--brand-50)', 'var(--brand-600)'],
  ['var(--info-bg)', 'var(--info)'],
  ['var(--warning-bg)', 'var(--warning)'],
  ['var(--success-bg)', 'var(--success)'],
  ['#f5f3ff', 'var(--chart-5)'],
]

/** 「已盘」判定窗口选项（与库存页「近期已盘」同口径；99999=不限全部历史） */
const RECENT_DAYS_OPTIONS = [
  { value: 1, label: '1天' },
  { value: 3, label: '3天' },
  { value: 7, label: '7天' },
  { value: 15, label: '15天' },
  { value: 30, label: '30天' },
  { value: 90, label: '90天' },
  { value: 99999, label: '不限' },
]

const recentDaysLabel = (v: number) => (v >= 99999 ? '全部历史' : v === 0 ? '仅当天' : `近 ${v} 天`)

const Sprite = () => (
  <svg style={{ display: 'none' }} xmlns="http://www.w3.org/2000/svg">
    <symbol id="tsc-cal" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/></symbol>
    <symbol id="tsc-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></symbol>
    <symbol id="tsc-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 3.5V8h-4.5"/></symbol>
    <symbol id="tsc-export" viewBox="0 0 24 24"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/></symbol>
    <symbol id="tsc-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="tsc-checkc" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m8 12.3 2.8 2.8 5.2-5.8"/></symbol>
    <symbol id="tsc-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></symbol>
    <symbol id="tsc-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></symbol>
    <symbol id="tsc-alert" viewBox="0 0 24 24"><path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 17.2v.1"/></symbol>
    <symbol id="tsc-layers" viewBox="0 0 24 24"><path d="m12 4 8.5 4.5L12 13 3.5 8.5z"/><path d="m4 13.5 8 4.2 8-4.2"/></symbol>
    <symbol id="tsc-doc" viewBox="0 0 24 24"><path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></symbol>
    <symbol id="tsc-wh" viewBox="0 0 24 24"><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z"/><path d="M4 8.5 12 13l8-4.5M12 13v7M8 6.2l8 4.6"/></symbol>
    <symbol id="tsc-print" viewBox="0 0 24 24"><path d="M7 8V3.5h10V8"/><rect x="4" y="8" width="16" height="8.5" rx="1.5"/><path d="M7 13.5h10v7H7z"/></symbol>
    <symbol id="tsc-box" viewBox="0 0 24 24"><path d="M3.5 8 12 4l8.5 4v8L12 20l-8.5-4z"/><path d="M3.5 8 12 12l8.5-4M12 12v8"/></symbol>
    <symbol id="tsc-check" viewBox="0 0 24 24"><path d="m4.5 12.5 5 5 10-11"/></symbol>
    <symbol id="tsc-funnel" viewBox="0 0 24 24"><path d="M3.5 5h17l-6.5 7.5V19l-4 1.5v-8z"/></symbol>
    <symbol id="tsc-left" viewBox="0 0 24 24"><path d="M14.5 6 8.5 12l6 6"/></symbol>
    <symbol id="tsc-right" viewBox="0 0 24 24"><path d="m9.5 6 6 6-6 6"/></symbol>
  </svg>
)

const I = ({ id, size = 14, sw = 1.7, style }: { id: string; size?: number; sw?: number; style?: React.CSSProperties }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}><use href={`#tsc-${id}`} /></svg>
)

const fmtQty = (v: number | string | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtMD = (v: string | null | undefined) => (v ? dayjs(v).format('MM-DD') : '—')

const pct = (n: number | null | undefined) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`)

const formatOrders = (orders: string[]) => {
  const shown = orders.slice(0, 2).join(', ')
  return orders.length > 2 ? `${shown} 等 ${orders.length} 单` : shown
}

const rateCls = (rate: number | null | undefined) =>
  rate == null ? '' : rate >= 0.5 ? 'v-good' : rate >= 0.25 ? 'v-mid' : 'v-bad'

const rowKey = (mid: number, wh: number | null | undefined) => `${mid}:${wh ?? 'null'}`

function StatCard(props: {
  accent: string; accentBg: string; icon: string; label: string
  value: React.ReactNode; delta?: React.ReactNode; deltaCls?: string; rate?: number | null
}) {
  return (
    <div className="card stat-card" style={{ ['--accent' as string]: props.accent, ['--accent-bg' as string]: props.accentBg }}>
      <div className="stat-icon"><I id={props.icon} size={18} /></div>
      <div className="stat-main">
        <div className="label">{props.label}</div>
        <div className="value">{props.value}</div>
        {props.rate != null && (
          <div className="rate-mini"><div className="progress"><i className={rateCls(props.rate)} style={{ width: `${Math.min(props.rate * 100, 100)}%` }} /></div></div>
        )}
        {props.delta != null && <div className={`delta ${props.deltaCls ?? 'flat'}`}>{props.delta}</div>}
      </div>
    </div>
  )
}

function NbAlert({ tasks }: { tasks: NoBomTask[] }) {
  if (!tasks.length) return null
  return (
    <div className="nb-alert">
      <I id="alert" size={15} />
      <div>
        范围内有 <b>{tasks.length}</b> 张任务单缺 BOM 无法分析（不阻塞下方清单）：
        <span className="mono">{tasks.map((t) => t.task_no || t.material_code).filter(Boolean).join(' · ')}</span>
      </div>
    </div>
  )
}

function MatCell({ code, name, onCodeClick }: { code?: string | null; name?: string | null; onCodeClick?: () => void }) {
  return (
    <td>
      <div className="mat-cell">
        <div className="code">
          {onCodeClick && code
            ? <a className="code-link" title="点击查看各订单需求量" onClick={onCodeClick}>{code}</a>
            : (code || '—')}
        </div>
        <div className="sub" title={name || ''}>{name || ''}</div>
      </div>
    </td>
  )
}

function pagesWindow(cur: number, total: number): Array<number | '…'> {
  const n = Math.max(1, total)
  if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1)
  const out: Array<number | '…'> = [1]
  const lo = Math.max(2, cur - 1), hi = Math.min(n - 1, cur + 1)
  if (lo > 2) out.push('…')
  for (let i = lo; i <= hi; i++) out.push(i)
  if (hi < n - 1) out.push('…')
  out.push(n)
  return out
}

export default function TaskStockCoverage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const viewParam = (searchParams.get('variant') || 'A').toUpperCase()
  const view: ViewKey = viewParam === 'C' ? 'C' : 'A'
  const setView = useCallback((v: ViewKey) => {
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set('variant', v); return p }, { replace: true })
  }, [setSearchParams])

  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('day'), dayjs().endOf('month')])

  const [status, setStatus] = useState<'all' | 'checked' | 'unchecked'>('unchecked')
  const [includeSample, setIncludeSample] = useState(false)
  const [recentDays, setRecentDays] = useState(99999) // 「已盘」窗口：默认不限(全部历史，与库存页口径一致)，可选近 N 天
  const [kwInput, setKwInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sortBy, setSortBy] = useState<string | null>(null)
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')
  const [whFilter, setWhFilter] = useState<number[]>([])
  const [openMenu, setOpenMenu] = useState<'wh' | 'status' | null>(null)
  const UNSTOCKED_FLAG = -1
  const [loadingA, setLoadingA] = useState(false)
  const [stats, setStats] = useState<CoverageStats | null>(null)
  const [items, setItems] = useState<CoverageItem[]>([])
  const [total, setTotal] = useState(0)
  const [noBomTasks, setNoBomTasks] = useState<NoBomTask[]>([])
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set())
  const rowMapRef = useRef<Map<string, CoverageItem>>(new Map())

  const [loadingC, setLoadingC] = useState(false)
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([])
  const [unstockedCount, setUnstockedCount] = useState(0)

  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState<{ title: string; sub: string; rows: CoverageItem[] } | null>(null)
  const [orderModal, setOrderModal] = useState<{ loading: boolean; data: MaterialOrdersData | null } | null>(null)

  /* ── 列宽拖动（视图 A 主表；拖动结束才持久化，避免拖动过程打接口）── */
  const getColumnWidths = useUiPreferencesStore((s) => s.getColumnWidths)
  const setColumnWidths = useUiPreferencesStore((s) => s.setColumnWidths)
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const saved = getColumnWidths(COL_WIDTHS_KEY, DEFAULT_COL_WIDTHS)
    return { ...DEFAULT_COL_WIDTHS, ...saved }
  })
  const colWidthsRef = useRef(colWidths)
  colWidthsRef.current = colWidths
  const resizingRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null)

  const onResizeStart = (e: React.PointerEvent<HTMLSpanElement>, key: string) => {
    e.preventDefault()
    e.stopPropagation()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 旧浏览器忽略 */ }
    resizingRef.current = { key, startX: e.clientX, startWidth: colWidthsRef.current[key] ?? DEFAULT_COL_WIDTHS[key] ?? 120 }
  }
  const onResizeMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    const st = resizingRef.current
    if (!st) return
    const next = Math.max(MIN_COL_WIDTH, Math.round(st.startWidth + e.clientX - st.startX))
    setColWidths((prev) => (prev[st.key] === next ? prev : { ...prev, [st.key]: next }))
  }
  const onResizeEnd = () => {
    if (!resizingRef.current) return
    resizingRef.current = null
    setColumnWidths(COL_WIDTHS_KEY, { ...colWidthsRef.current })
  }

  const openOrderModal = async (r: CoverageItem) => {
    setOrderModal({ loading: true, data: null })
    try {
      const res: any = await materialApi.getTaskCoverageMaterialOrders({
        start_date: startStr, end_date: endStr, material_id: r.material_id, include_sample: includeSample,
      })
      // 函数式更新：弹窗若已被用户关闭则不再重开
      setOrderModal((prev) => (prev ? { loading: false, data: res.data } : prev))
    } catch (e: any) {
      setOrderModal(null)
      message.error(e?.response?.data?.detail || e.message || '查询失败')
    }
  }

  const startStr = range[0].format('YYYY-MM-DD')
  const endStr = range[1].format('YYYY-MM-DD')

  const loadA = useCallback(async () => {
    setLoadingA(true)
    try {
      const res: any = await materialApi.getTaskStockCoverage({
        start_date: startStr, end_date: endStr, status, keyword: keyword || undefined,
        wh_ids: whFilter.length ? whFilter.join(',') : undefined,
        include_sample: includeSample,
        recent_days: recentDays,
        sort_by: sortBy || undefined, sort_order: sortOrder,
        page, page_size: pageSize,
      })
      setStats(res.data?.stats ?? null)
      setItems(res.data?.items ?? [])
      setTotal(res.data?.total ?? 0)
      setNoBomTasks(res.data?.no_bom_tasks ?? [])
      setWarehouses(res.data?.warehouses ?? [])
      setUnstockedCount(res.data?.unstocked_count ?? 0)
      const m = rowMapRef.current
      for (const r of (res.data?.items ?? []) as CoverageItem[]) m.set(rowKey(r.material_id, r.wh_id), r)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '查询失败')
    } finally {
      setLoadingA(false)
    }
  }, [startStr, endStr, status, keyword, page, pageSize, whFilter, sortBy, sortOrder, includeSample, recentDays])

  const loadC = useCallback(async () => {
    setLoadingC(true)
    try {
      const res: any = await materialApi.getTaskStockCoverage({
        start_date: startStr, end_date: endStr, page: 1, page_size: 1,
        include_sample: includeSample,
        recent_days: recentDays,
      })
      setStats(res.data?.stats ?? null)
      setWarehouses(res.data?.warehouses ?? [])
      setUnstockedCount(res.data?.unstocked_count ?? 0)
      setNoBomTasks(res.data?.no_bom_tasks ?? [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '查询失败')
    } finally {
      setLoadingC(false)
    }
  }, [startStr, endStr, includeSample, recentDays])

  useEffect(() => { if (view === 'A') loadA() }, [view, loadA])
  useEffect(() => { if (view === 'C') loadC() }, [view, loadC])

  useEffect(() => {
    setPage(1); setSelKeys(new Set()); rowMapRef.current = new Map()
  }, [startStr, endStr, status, keyword, whFilter, includeSample, recentDays])

  const clickSort = (col: string) => {
    if (sortBy !== col) { setSortBy(col); setSortOrder('asc') }
    else if (sortOrder === 'asc') { setSortOrder('desc') }
    else { setSortBy(null); setSortOrder('asc') }
    setPage(1)
  }
  const toggleWh = (id: number) => {
    setWhFilter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }
  const setStatusAndClose = (s: 'all' | 'checked' | 'unchecked') => {
    setStatus(s); setOpenMenu(null)
  }

  useEffect(() => {
    if (!openMenu) return
    const close = () => setOpenMenu(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [openMenu])

  const selectedRows = useMemo(
    () => Array.from(selKeys).map((k) => rowMapRef.current.get(k)).filter((r): r is CoverageItem => Boolean(r)),
    [selKeys],
  )

  const toggleRow = (r: CoverageItem) => {
    const k = rowKey(r.material_id, r.wh_id)
    rowMapRef.current.set(k, r)
    setSelKeys((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  }
  const pageAllChecked = items.length > 0 && items.every((r) => selKeys.has(rowKey(r.material_id, r.wh_id)))
  const togglePageAll = () => {
    setSelKeys((prev) => {
      const n = new Set(prev)
      if (pageAllChecked) items.forEach((r) => n.delete(rowKey(r.material_id, r.wh_id)))
      else items.forEach((r) => { n.add(rowKey(r.material_id, r.wh_id)); rowMapRef.current.set(rowKey(r.material_id, r.wh_id), r) })
      return n
    })
  }
  const clearSel = () => setSelKeys(new Set())

  const createCheck = async (rows: Array<{ material_id: number; wh_id: number | null }>, title: string) => {
    if (!rows.length) { message.warning('没有可创建的未盘物料'); return }
    if (rows.length > 500) { message.error(`一次最多创建 500 个盘点项（本次 ${rows.length} 项），请分批创建或缩小范围`); return }
    setCreating(true)
    try {
      const res: any = await materialApi.createStockCheckFromMaterials({ items: rows, title })
      if (!res.data?.id) { message.error('创建盘点单返回数据异常'); return }
      message.success(`盘点单 ${res.data.check_no ?? ''} 已创建`)
      navigate(`/stock-check/${res.data.id}`)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '创建盘点单失败')
    } finally {
      setCreating(false)
    }
  }

  const fetchAllRows = async (params: { status?: 'all' | 'checked' | 'unchecked'; keyword?: string; wh_id?: number; unstocked?: boolean } = {}) => {
    const all: CoverageItem[] = []
    let p = 1
    for (;;) {
      const res: any = await materialApi.getTaskStockCoverage({
        start_date: startStr, end_date: endStr, page: p, page_size: 200,
        include_sample: includeSample, recent_days: recentDays, ...params,
      })
      const batch: CoverageItem[] = res.data?.items ?? []
      all.push(...batch)
      if (all.length >= (res.data?.total ?? 0) || p >= 15 || batch.length === 0) break
      p++
    }
    return all
  }

  /* ── 导出（格式 + 选列弹窗 → 后端 /stock-check/task-coverage/export）── */
  const { exporting, exportData } = useExport()
  const [exportOpen, setExportOpen] = useState(false)
  const [exportScope, setExportScope] = useState<'A' | 'C'>('A')
  const [exportFormat, setExportFormat] = useState<'xlsx' | 'csv'>('xlsx')

  const openExportModal = (scope: 'A' | 'C') => {
    setExportScope(scope)
    setExportFormat('xlsx')
    setExportOpen(true)
  }

  const handleExportConfirm = (selectedColumns: string[]) => {
    setExportOpen(false)
    const ext = exportFormat === 'csv' ? 'csv' : 'xlsx'
    const params: Record<string, any> = { format: exportFormat, start_date: startStr, end_date: endStr, include_sample: includeSample, recent_days: recentDays }
    if (exportScope === 'A') {
      params.status = status
      if (keyword) params.keyword = keyword
      if (whFilter.length) params.wh_ids = whFilter.join(',')
      if (sortBy) { params.sort_by = sortBy; params.sort_order = sortOrder }
    }
    if (selectedColumns.length) params.columns = selectedColumns.join(',')
    const label = exportScope === 'A' ? '物料清单' : '全量'
    exportData('/api/v1/materials/stock-check/task-coverage/export', params, `任务盘点_${label}_${startStr}_${endStr}.${ext}`)
  }

  const openWhModal = async (wh: WarehouseSummary) => {
    setBusy(true)
    try {
      const rows = await fetchAllRows({ status: 'unchecked', wh_id: wh.wh_id ?? undefined })
      setModal({ title: `${wh.wh_name} · 未盘清单`, sub: `${rows.length} 行 · 按物料编码排序`, rows })
    } catch (e: any) { message.error(e?.message || '加载失败') }
    finally { setBusy(false) }
  }

  const openUnstockedModal = async () => {
    setBusy(true)
    try {
      const rows = await fetchAllRows({ unstocked: true })
      setModal({ title: '(未入库) 合成行清单', sub: `${rows.length} 行 · 范围内需求但无库存记录`, rows })
    } catch (e: any) { message.error(e?.message || '加载失败') }
    finally { setBusy(false) }
  }

  const createWhCheck = async (wh: WarehouseSummary) => {
    setBusy(true)
    try {
      const rows = await fetchAllRows({ status: 'unchecked', wh_id: wh.wh_id ?? undefined })
      await createCheck(rows.map((r) => ({ material_id: r.material_id, wh_id: r.wh_id ?? null })), `任务盘点·${wh.wh_name} ${startStr}~${endStr}`)
    } catch (e: any) { message.error(e?.message || '创建失败') }
    finally { setBusy(false) }
  }

  const createAllCheck = async () => {
    setBusy(true)
    try {
      const rows = await fetchAllRows({ status: 'unchecked' })
      await createCheck(rows.map((r) => ({ material_id: r.material_id, wh_id: r.wh_id ?? null })), `任务盘点·跨仓 ${startStr}~${endStr}`)
    } catch (e: any) { message.error(e?.message || '创建失败') }
    finally { setBusy(false) }
  }

  const printCard = async (wh: WarehouseSummary) => {
    setBusy(true)
    try {
      const rows = await fetchAllRows({ status: 'unchecked', wh_id: wh.wh_id ?? undefined })
      const trs = rows.map((r) => `<tr><td>${r.material_code ?? ''}</td><td>${(r.material_name ?? '').replace(/</g, '&lt;')}</td><td>${r.spec_model ?? ''}</td><td>${r.unit ?? ''}</td><td style="text-align:right">${fmtQty(r.system_qty)}</td><td style="text-align:right">${fmtQty(r.req_qty)}</td><td></td><td></td></tr>`).join('')
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>盘点卡 · ${wh.wh_name}</title><style>
        body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;padding:24px;color:#111}
        h2{margin:0 0 4px;font-size:18px} .meta{font-size:12px;color:#555;margin-bottom:14px}
        table{width:100%;border-collapse:collapse} th,td{border:1px solid #444;padding:5px 8px;font-size:12px;text-align:left}
        th{background:#f1f5f9} td:nth-child(5),td:nth-child(6),th:nth-child(5),th:nth-child(6){text-align:right}
      </style></head><body>
        <h2>盘点卡 · ${wh.wh_name}</h2>
        <div class="meta">任务盘点 · 计划开工 ${startStr} ~ ${endStr} · 未盘 ${rows.length} 行 · 盘点人__________ · 日期__________</div>
        <table><thead><tr><th>物料编码</th><th>物料名称</th><th>规格</th><th>单位</th><th>账面库存</th><th>需求总量</th><th>库位</th><th>实盘数</th></tr></thead><tbody>${trs}</tbody></table>
      </body></html>`
      const iframe = document.createElement('iframe')
      iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
      document.body.appendChild(iframe)
      iframe.srcdoc = html
      iframe.onload = () => {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
        setTimeout(() => document.body.removeChild(iframe), 3000)
      }
    } catch (e: any) {
      message.error(e?.message || '打印失败')
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = status === 'unchecked' ? '未盘' : status === 'checked' ? '已盘' : '全部'
  const pagesA = Math.max(1, Math.ceil(total / pageSize))
  const pageReqSum = items.reduce((s, r) => s + Number(r.req_qty || 0), 0)

  const RangePill = (
    <div className="range-pill">
      <I id="cal" size={13} />
      <span>计划开工</span>
      <DatePicker.RangePicker
        className="tsc-picker"
        allowClear={false}
        value={range}
        onChange={(v) => { if (v && v[0] && v[1]) setRange([v[0].startOf('day'), v[1]]) }}
      />
      <span className="cnt">{stats ? `${stats.task_count} 单` : '—'}</span>
    </div>
  )

  const SampleToggle = (
    <label className={`smp-toggle${includeSample ? ' on' : ''}`} title="样品单 = 销售订单号以 HJY 开头">
      <input type="checkbox" checked={includeSample} onChange={(e) => setIncludeSample(e.target.checked)} />
      <span>包含样品单</span>
    </label>
  )

  const RecentDaysPill = (
    <span className="rd-pill" title={`「已盘」判定窗口：${recentDaysLabel(recentDays)}内实盘过算已盘；与库存页「近期已盘」同口径`}>
      <I id="clock" size={13} />
      <span>已盘窗口</span>
      <span className="tsc-ps">
        <select value={recentDays} onChange={(e) => setRecentDays(Number(e.target.value))}>
          {RECENT_DAYS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <I id="down" size={11} sw={2} />
      </span>
    </span>
  )

  const ViewSwitch = (
    <div className="toolbar" style={{ marginBottom: 12 }}>
      <div className="segmented">
        {VIEWS.map((v) => (
          <span key={v.key} className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>{v.name}</span>
        ))}
      </div>
      <span className="hint-line">物料清单统筹全量 · 仓库执行包按仓领取</span>
    </div>
  )

  return (
    <div className="tsc">
      <Sprite />
      {ViewSwitch}

      {/* ===== 视图 A · 物料清单驱动 ===== */}
      <div className={`variant${view === 'A' ? ' show' : ''}`}>
        <div className="toolbar">
          {RangePill}
          {SampleToggle}
          {RecentDaysPill}
          <div className="segmented">
            <span className={status === 'all' ? 'active' : ''} onClick={() => setStatus('all')}>全部 {stats ? stats.row_count.toLocaleString() : ''}</span>
            <span className={status === 'unchecked' ? 'active' : ''} onClick={() => setStatus('unchecked')}>未盘 <b style={{ color: 'var(--danger)' }}>{stats ? stats.unchecked_count.toLocaleString() : ''}</b></span>
            <span className={status === 'checked' ? 'active' : ''} onClick={() => setStatus('checked')}>已盘 {stats ? stats.checked_count.toLocaleString() : ''}</span>
          </div>
          <div className="input input-search">
            <I id="search" />
            <input
              placeholder="物料编码 / 名称 / 规格"
              value={kwInput}
              onChange={(e) => setKwInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setKeyword(kwInput.trim()) }}
            />
          </div>
          <div className="right">
            <button className="btn btn-secondary btn-sm" onClick={loadA} disabled={loadingA}><I id="refresh" />刷新</button>
            <button className="btn btn-secondary btn-sm" onClick={() => openExportModal('A')} disabled={busy || exporting}><I id="export" />导出</button>
          </div>
        </div>

        <NbAlert tasks={noBomTasks} />

        <div className="grid g6 mb12">
          <StatCard accent="var(--brand-500)" accentBg="var(--brand-50)" icon="doc" label="任务单（未关闭）" value={<>{(stats?.task_count ?? 0).toLocaleString()}<small>单</small></>} />
          <StatCard accent="var(--chart-5)" accentBg="#f5f3ff" icon="layers" label="涉及产品" value={<>{(stats?.product_count ?? 0).toLocaleString()}<small>款</small></>} />
          <StatCard accent="var(--info)" accentBg="var(--info-bg)" icon="wh" label="物料×仓库行" value={<>{(stats?.row_count ?? 0).toLocaleString()}<small>行</small></>} />
          <StatCard accent="var(--success)" accentBg="var(--success-bg)" icon="checkc" label={`已盘（${recentDaysLabel(recentDays)}）`} value={<>{(stats?.checked_count ?? 0).toLocaleString()}<small>行</small></>} />
          <StatCard accent="var(--danger)" accentBg="var(--danger-bg)" icon="target" label="未盘" value={<>{(stats?.unchecked_count ?? 0).toLocaleString()}<small>行</small></>} />
          <StatCard accent="var(--warning)" accentBg="var(--warning-bg)" icon="clock" label="已盘率" value={<>{pct(stats?.checked_rate)}<small>%</small></>} rate={stats?.checked_rate ?? null} />
        </div>

        <div className="card list-card">
          <div className="card-body p0 tbl-wrap">
            <table className="tbl">
              <colgroup>
                <col style={{ width: 34 }} />
                {TSC_COLS.map((c) => (
                  <col key={c.key} style={{ width: colWidths[c.key] ?? DEFAULT_COL_WIDTHS[c.key] ?? 120 }} />
                ))}
                <col style={{ width: 90 }} />
              </colgroup>
              <thead><tr>
                <th>
                  <span className={`check${pageAllChecked ? '' : ' off'}`} onClick={togglePageAll}>
                    {!pageAllChecked ? null : <I id="check" size={10} sw={2.4} />}
                  </span>
                </th>
                {TSC_COLS.map((c) => {
                  const whActive = c.filter === 'wh' && whFilter.length > 0
                  const statusActive = c.filter === 'status' && status !== 'all'
                  return (
                    <th key={c.key} className={c.align === 'right' ? 'num' : ''}>
                      <span className="th-cell">
                        {c.sortKey ? (
                          <button type="button" className="th-sortbtn" title="点击排序" onClick={() => clickSort(c.sortKey!)}>
                            <span className="th-label">{c.title}</span>
                            <span className={`th-sort${sortBy === c.sortKey ? (sortOrder === 'asc' ? ' asc' : ' desc') : ''}`}><i className="up" /><i className="dn" /></span>
                          </button>
                        ) : (
                          <span className="th-label">{c.title}</span>
                        )}
                        {c.filter === 'wh' && (
                          <>
                            <button type="button" className={`th-fbtn${whActive ? ' on' : ''}`} title="按仓库筛选" onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === 'wh' ? null : 'wh') }}>
                              <I id="funnel" size={11} sw={2} />
                            </button>
                            {openMenu === 'wh' && (
                              <div className="th-menu" onClick={(e) => e.stopPropagation()}>
                                {warehouses.map((w) => {
                                  const on = whFilter.includes(w.wh_id ?? -999)
                                  return (
                                    <div key={w.wh_id} className={`tm-item${on ? ' on' : ''}`} onClick={() => toggleWh(w.wh_id ?? -999)}>
                                      <span className="tm-check">{on ? <I id="check" size={9} sw={2.6} /> : null}</span>
                                      <span>{w.wh_name}</span>
                                      <span className="tm-n">{w.row_count}</span>
                                    </div>
                                  )
                                })}
                                <div className={`tm-item${whFilter.includes(UNSTOCKED_FLAG) ? ' on' : ''}`} onClick={() => toggleWh(UNSTOCKED_FLAG)}>
                                  <span className="tm-check">{whFilter.includes(UNSTOCKED_FLAG) ? <I id="check" size={9} sw={2.6} /> : null}</span>
                                  <span style={{ fontStyle: 'italic', color: 'var(--text-3)' }}>(未入库)</span>
                                  <span className="tm-n">{unstockedCount}</span>
                                </div>
                                <div className="tm-ops">
                                  <a onClick={() => setWhFilter([])}>清空</a>
                                  <a onClick={() => setWhFilter([...warehouses.map((w) => w.wh_id ?? -999), UNSTOCKED_FLAG])}>全选</a>
                                  <a style={{ marginLeft: 'auto' }} onClick={() => setOpenMenu(null)}>完成</a>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                        {c.filter === 'status' && (
                          <>
                            <button type="button" className={`th-fbtn${statusActive ? ' on' : ''}`} title="按状态筛选" onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === 'status' ? null : 'status') }}>
                              <I id="funnel" size={11} sw={2} />
                            </button>
                            {openMenu === 'status' && (
                              <div className="th-menu" onClick={(e) => e.stopPropagation()}>
                                {([['all', '全部'], ['unchecked', '未盘'], ['checked', '已盘']] as const).map(([v, label]) => (
                                  <div key={v} className={`tm-item${status === v ? ' on' : ''}`} onClick={() => setStatusAndClose(v)}>
                                    <span className="tm-check">{status === v ? <I id="check" size={9} sw={2.6} /> : null}</span>
                                    <span>{label}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </span>
                      <span
                        className="th-resizer"
                        title="拖动调整列宽"
                        onPointerDown={(e) => onResizeStart(e, c.key)}
                        onPointerMove={onResizeMove}
                        onPointerUp={onResizeEnd}
                        onPointerCancel={onResizeEnd}
                      />
                    </th>
                  )
                })}
                <th style={{ width: 90 }}></th>
              </tr></thead>
              <tbody>
                {items.map((r) => {
                  const k = rowKey(r.material_id, r.wh_id)
                  return (
                    <tr key={k}>
                      <td><input type="checkbox" className="tsc-ck" checked={selKeys.has(k)} onChange={() => toggleRow(r)} /></td>
                      <MatCell code={r.material_code} name={r.material_name} onCodeClick={() => openOrderModal(r)} />
                      <td className={r.wh_id == null ? 'wh-none' : ''}>{r.wh_name || '—'}</td>
                      <td className="num" style={Number(r.system_qty) === 0 ? { color: 'var(--danger)' } : undefined}>{fmtQty(r.system_qty)}</td>
                      <td className="num strong">{fmtQty(r.req_qty)}</td>
                      <td>
                        {r.is_checked ? (
                          <>
                            <span className="tag tag-risk-low"><span className="dot" />已盘</span>
                            <div className="ck-recent">{r.recent_check_no ?? ''} · {fmtMD(r.recent_check_date)}</div>
                          </>
                        ) : (
                          <span className="tag tag-risk-high"><span className="dot" />未盘</span>
                        )}
                      </td>
                      <td className="task-n" title={(r.task_nos || []).join('\n')}>
                        <b>{r.task_nos?.length ?? 0}</b> 单 · {(r.task_nos || []).slice(0, 1).join('')}{(r.task_nos?.length ?? 0) > 1 ? ' 等' : ''}
                      </td>
                      <td className="order-n" title={(r.order_nos || []).join('\n')}>
                        {(r.order_nos || []).length > 0
                          ? <>{formatOrders(r.order_nos || [])}</>
                          : '—'}
                      </td>
                      <td></td>
                    </tr>
                  )
                })}
                <tr className="aggregate">
                  <td></td>
                  <td className="lbl">本页合计（筛选后 {total.toLocaleString()} 行中的第 {page} 页）</td>
                  <td></td>
                  <td className="num">—</td>
                  <td className="num">{pageReqSum.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td></td>
                  <td></td>
                  <td></td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span className="total">{statusLabel} {total.toLocaleString()} 行 · 每页
              <span className="tsc-ps">
                <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }}>
                  {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <I id="down" size={11} sw={2} />
              </span>
              行 · 第 {page} / {pagesA} 页</span>
            <button className="pg" disabled={page <= 1} onClick={() => setPage(Math.max(1, page - 1))}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pg-arr"><use href="#tsc-left" /></svg></button>
            {pagesWindow(page, pagesA).map((p, i) =>
              p === '…' ? <span key={`e${i}`} className="pg disabled">…</span> : (
                <button key={p} className={`pg${p === page ? ' cur' : ''}`} onClick={() => setPage(p)}>{p}</button>
              ))}
            <button className="pg" disabled={page >= pagesA} onClick={() => setPage(Math.min(page + 1, pagesA))}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pg-arr"><use href="#tsc-right" /></svg></button>
          </div>
        </div>

        {selectedRows.length > 0 && (
          <div className="batch-bar">
            <span className="b-ico"><I id="target" /></span>
            <span>已选 <span className="n">{selectedRows.length}</span> 项未盘物料</span>
            <span className="sub">将创建 1 张盘点单 · 跳转盘点工作台录入实盘数</span>
            <span className="sp" />
            <button className="btn btn-ghost btn-sm" onClick={clearSel}>清空</button>
            <button
              className="btn btn-primary btn-sm"
              disabled={creating}
              onClick={() => createCheck(selectedRows.map((r) => ({ material_id: r.material_id, wh_id: r.wh_id ?? null })), `任务盘点 ${startStr}~${endStr}`)}
            >
              <I id="plus" sw={1.8} />创建盘点单
            </button>
          </div>
        )}
      </div>

      {/* ===== 视图 C · 仓库执行包 ===== */}
      <div className={`variant${view === 'C' ? ' show' : ''}`}>
        <div className="toolbar">
          {RangePill}
          {SampleToggle}
          {RecentDaysPill}
          <span className="hint-line">按仓库拆分盘点任务包 · 仓管员按仓领取 · 一仓一单</span>
          <div className="right">
            <button className="btn btn-secondary btn-sm" onClick={() => openExportModal('C')} disabled={busy || exporting}><I id="export" />导出全量</button>
            <button className="btn btn-secondary btn-sm" onClick={createAllCheck} disabled={busy || creating}><I id="plus" sw={1.8} />跨仓创建一张盘点单</button>
          </div>
        </div>

        <div className="grid g4 mb12">
          <StatCard accent="var(--danger)" accentBg="var(--danger-bg)" icon="target" label="未盘行合计" value={<>{(stats?.unchecked_count ?? 0).toLocaleString()}<small>行</small></>} />
          <StatCard accent="var(--warning)" accentBg="var(--warning-bg)" icon="clock" label="整体已盘率" value={<>{pct(stats?.checked_rate)}<small>%</small></>} rate={stats?.checked_rate ?? null} />
          <StatCard accent="var(--info)" accentBg="var(--info-bg)" icon="wh" label="涉及仓库"
            value={<>{warehouses.length}<small>个</small></>}
            delta={<>未入库合成行 {unstockedCount} 行不参与执行包</>} />
          <StatCard accent="var(--brand-500)" accentBg="var(--brand-50)" icon="alert" label="缺 BOM 任务单"
            value={<>{noBomTasks.length}<small>单</small></>}
            delta={<>不阻塞执行包 · <a onClick={loadA}>详情见清单视图</a></>} />
        </div>

        <div className="wh-grid">
          {warehouses.map((wh, i) => {
            const [bg, fg] = WH_COLORS[i % WH_COLORS.length]
            const rate = wh.row_count ? wh.checked_count / wh.row_count : null
            const rest = wh.unchecked_count - wh.preview_items.length
            return (
              <div key={wh.wh_id ?? i} className="card wh-card">
                <div className="wh-head">
                  <div className="wh-icon" style={{ background: bg, color: fg }}><I id="wh" size={17} /></div>
                  <div>
                    <div className="wh-name">{wh.wh_name || '—'}</div>
                    <div className="wh-keeper">共 {wh.row_count} 行 · 已盘 {wh.checked_count} 行</div>
                  </div>
                  <div className="wh-nums">
                    <div className="big" style={{ color: 'var(--danger)' }}>{wh.unchecked_count.toLocaleString()}</div>
                    <div className="cap">未盘行</div>
                  </div>
                </div>
                <div className="wh-meta">
                  <div className="progress"><i className={rateCls(rate)} style={{ width: `${rate == null ? 0 : Math.min(rate * 100, 100)}%` }} /></div>
                  <span className="pv">已盘率 {pct(rate)}</span>
                  <span className="pv">{wh.row_count} 行</span>
                </div>
                <div className="wh-preview">
                  <table className="tbl">
                    <tbody>
                      {wh.preview_items.map((p) => (
                        <tr key={p.material_id}>
                          <td>
                            <div className="mat-cell">
                              <div className="code">{p.material_code || '—'}</div>
                              <div className="sub" title={p.material_name || ''}>{p.material_name || ''}</div>
                            </div>
                          </td>
                          <td className="num" style={Number(p.system_qty) === 0 ? { color: 'var(--danger)' } : undefined}>{fmtQty(p.system_qty)}</td>
                          <td className="num strong">{fmtQty(p.req_qty)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 'calc(11px * var(--font-size-scale))' }}>
                          {rest > 0 ? <>… 其余 {rest.toLocaleString()} 行<a style={{ marginLeft: 8 }} onClick={() => openWhModal(wh)}>查看清单 →</a></> : (wh.preview_items.length ? <a onClick={() => openWhModal(wh)}>查看清单 →</a> : '全部已盘')}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="wh-foot">
                  <button className="btn btn-primary btn-sm" disabled={busy || creating || wh.unchecked_count === 0} onClick={() => createWhCheck(wh)}><I id="plus" sw={1.8} />创建本仓盘点单</button>
                  <button className="btn btn-secondary btn-sm" disabled={busy || wh.unchecked_count === 0} onClick={() => printCard(wh)}><I id="print" />打印盘点卡</button>
                </div>
              </div>
            )
          })}

          <div className="card wh-card" style={{ borderStyle: 'dashed', background: 'transparent', boxShadow: 'none' }}>
            <div className="wh-head" style={{ paddingBottom: 12 }}>
              <div className="wh-icon" style={{ background: 'var(--gray-100)', color: 'var(--gray-400)' }}><I id="box" size={17} /></div>
              <div>
                <div className="wh-name" style={{ color: 'var(--text-3)' }}>(未入库) 合成行</div>
                <div className="wh-keeper">范围内需求但无库存记录的物料</div>
              </div>
              <div className="wh-nums">
                <div className="big" style={{ color: 'var(--gray-400)' }}>{unstockedCount}</div>
                <div className="cap">行</div>
              </div>
            </div>
            <div className="wh-foot" style={{ paddingTop: 0 }}>
              <span className="hint-line" style={{ lineHeight: 1.7 }}>
                可加入任意盘点单一起盘，但无仓库实盘数可回写；到货入库后再按仓盘点。
                <a style={{ marginLeft: 6 }} onClick={openUnstockedModal}>查看 {unstockedCount} 行 →</a>
              </span>
            </div>
          </div>
        </div>
      </div>

      {modal && (
        <div className="tsc-modal-mask" onClick={() => setModal(null)}>
          <div className="tsc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tsc-modal-head">
              <h3>{modal.title}</h3>
              <span className="sub">{modal.sub}</span>
              <button className="close" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="tsc-modal-body tbl-wrap">
              <table className="tbl">
                <thead><tr>
                  <th>物料</th><th>仓库</th><th className="num">当前库存</th><th className="num">需求总量</th><th>盘点状态</th><th>最近盘点</th>
                </tr></thead>
                <tbody>
                  {modal.rows.map((r, i) => (
                    <tr key={`${r.material_id}:${r.wh_id ?? 'null'}:${i}`}>
                      <MatCell code={r.material_code} name={r.material_name} />
                      <td className={r.wh_id == null ? 'wh-none' : ''}>{r.wh_name || '—'}</td>
                      <td className="num" style={Number(r.system_qty) === 0 ? { color: 'var(--danger)' } : undefined}>{fmtQty(r.system_qty)}</td>
                      <td className="num strong">{fmtQty(r.req_qty)}</td>
                      <td>{r.is_checked ? <span className="tag tag-risk-low"><span className="dot" />已盘</span> : <span className="tag tag-risk-high"><span className="dot" />未盘</span>}</td>
                      <td className="mono">{r.recent_check_no ? `${r.recent_check_no} · ${fmtMD(r.recent_check_date)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {orderModal && (
        <div className="tsc-modal-mask" onClick={() => setOrderModal(null)}>
          <div className="tsc-modal" style={{ width: 1020, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="tsc-modal-head">
              <h3>订单需求明细</h3>
              <span className="sub">
                {orderModal.data
                  ? `${orderModal.data.material_code || '—'} · ${orderModal.data.material_name || ''} · 计划开工 ${startStr} ~ ${endStr}`
                  : '加载中…'}
              </span>
              <button className="close" onClick={() => setOrderModal(null)}>✕</button>
            </div>
            <div className="tsc-modal-body tbl-wrap">
              {orderModal.loading ? (
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-3)' }}>加载中…</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th>订单号</th>
                    <th className="num">需求量{orderModal.data?.unit ? `（${orderModal.data.unit}）` : ''}</th>
                    <th>关联任务单</th>
                  </tr></thead>
                  <tbody>
                    {(orderModal.data?.orders || []).map((o) => (
                      <tr key={o.order_no}>
                        <td className="mono">{o.order_no}</td>
                        <td className="num strong">{fmtQty(o.req_qty)}</td>
                        <td className="task-n" title={(o.task_nos || []).join('\n')}>
                          <b>{o.task_nos?.length ?? 0}</b> 单 · {(o.task_nos || []).slice(0, 3).join('、')}{(o.task_nos?.length ?? 0) > 3 ? ' 等' : ''}
                        </td>
                      </tr>
                    ))}
                    {Number(orderModal.data?.no_order_qty) > 0 && (
                      <tr>
                        <td style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>（未关联订单）</td>
                        <td className="num">{fmtQty(orderModal.data?.no_order_qty)}</td>
                        <td className="task-n">任务单未关联销售订单</td>
                      </tr>
                    )}
                    <tr className="aggregate">
                      <td className="lbl">合计（与列表「需求总量」同口径）</td>
                      <td className="num">{fmtQty(orderModal.data?.req_qty)}</td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      <ExportColumnSelector
        open={exportOpen}
        columns={EXPORT_FIELDS}
        format={exportFormat}
        onFormatChange={setExportFormat}
        onConfirm={handleExportConfirm}
        onCancel={() => setExportOpen(false)}
      />

      {(busy || creating) && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(15,23,42,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-2)', fontSize: 'calc(13px * var(--font-size-scale))' }}>
          <div className="card" style={{ padding: '16px 24px' }}>处理中…</div>
        </div>
      )}
    </div>
  )
}
