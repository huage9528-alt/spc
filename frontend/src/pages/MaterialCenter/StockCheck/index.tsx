import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  Table, Input, Button, message, Modal, Row, Col, Spin, Popover, Tour,
  Tooltip, DatePicker, Dropdown, Tabs, Progress, Checkbox, Badge, Tag, Select,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  QuestionCircleOutlined, PlusOutlined, DownOutlined, DownloadOutlined, BarChartOutlined,
  ThunderboltOutlined, FilterOutlined, FileTextOutlined, AppstoreOutlined, DatabaseOutlined,
  AuditOutlined, CalendarOutlined, WarningOutlined, CheckCircleOutlined,
} from '@ant-design/icons'

import { useAntTableQuery } from '@/hooks/useAntTableQuery'
import { useExport } from '@/hooks/useExport'
import { materialApi, orderApi } from '@/services/api'
import { formatDateTime } from '@/utils'
import { useUiPreferencesStore } from '@/store/uiPreferences'
import { useStockCheckPoolStore } from '@/store/stockCheckPool'
import ExportColumnSelector, { ExportColumnOption } from '@/components/ExportColumnSelector'
import { stockCheckIntroSteps, STOCK_CHECK_INTRO_TOUR_ID } from './StockCheckTour'
import MaterialPickerModal from './MaterialPickerModal'
import OrderProductPickerModal, { OrderProductSelection } from './OrderProductPickerModal'
import SearchableColumnFilter from './SearchableColumnFilter'
import StatsCharts from './components/StatsCharts'
import K3ImportModal from './K3ImportModal'
import { STATUS_MAP, checkTypeTag, AvatarStack, DiffPair, ScTag } from './types'
import type { StockCheck, MaterialCandidate, CoChecker, StockCheckKpiData } from './types'

interface LedgerRow {
  check_id?: number | null
  check_no?: string | null
  check_type?: string | null
  status?: string | null
  material_id?: number | null
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  wh_id?: number | null
  wh_name?: string | null
  system_qty?: number | null
  system_qty_time?: string | null
  live_qty?: number | null
  live_wh_names?: string | null
  req_qty?: number | null
  actual_qty?: number | null
  diff_qty?: number | null
  counted_by?: string | null
  counted_at?: string | null
}

const STATUS_OPTIONS = [
  { text: '待盘点', value: 'open' },
  { text: '进行中', value: 'in_progress' },
  { text: '已完成', value: 'completed' },
  { text: '已取消', value: 'cancelled' },
]

const STATUS_CHIP_ORDER = ['in_progress', 'open', 'completed', 'cancelled'] as const

// 抽检状态 Tag（原型 .tag-audit-*：软底语义色 + dot; NULL=存量老单,列显示 —）
const AUDIT_TAG: Record<string, { label: string; cls: string }> = {
  pending: { label: '待抽检', cls: 'sca-audit-pending' },
  passed: { label: '已通过', cls: 'sca-audit-passed' },
  rejected: { label: '已发回', cls: 'sca-audit-rejected' },
}

// 列表「抽检」列: null 显示 —; pending 仅完结单可见(reject 后回 in_progress 也保留已发回标记)
function auditTagOf(r: StockCheck): ReactNode {
  const s = r.audit_status
  if (!s || (s === 'pending' && r.status !== 'completed')) return <span className="sc-diff-flat">—</span>
  const t = AUDIT_TAG[s]
  return t ? <span className={`sc-tag ${t.cls}`}><span className="dot" />{t.label}</span> : <span className="sc-diff-flat">—</span>
}

const STOCK_CHECK_EXPORT_OPTIONS: ExportColumnOption[] = [
  { field: 'material_code', label: '物料编码' },
  { field: 'material_name', label: '物料名称' },
  { field: 'spec_model', label: '规格' },
  { field: 'material_type', label: '分类' },
  { field: 'material_property_label', label: '属性' },
  { field: 'unit', label: '单位' },
  { field: 'system_qty', label: '快照库存' },
  { field: 'system_qty_time', label: '快照时间' },
  { field: 'live_qty', label: '即时库存' },
  { field: 'wh_name', label: '仓库' },
  { field: 'req_qty', label: '应盘数' },
  { field: 'actual_qty', label: '盘点数' },
  { field: 'diff_qty', label: '差异' },
  { field: 'is_checked', label: '已盘' },
  { field: 'checked_by', label: '标记人' },
  { field: 'checked_at', label: '标记时间' },
  { field: 'remark', label: '备注' },
]

// 原型 .mono = tabular-nums + 轻字距（非等宽字体）
const MONO: CSSProperties = { fontVariantNumeric: 'tabular-nums', letterSpacing: '0.01em' }

function fmtNum(v: number | null | undefined): string {
  return v == null ? '—' : String(Number(v))
}

// 前端 CSV 导出（带 BOM，Excel 可直接打开）
function exportCsv(filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = '\ufeff' + [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

export default function StockCheckPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const poolCount = useStockCheckPoolStore((s) => s.items.length)
  const poolRemove = useStockCheckPoolStore((s) => s.remove)

  // ===== 工具栏 / 筛选状态 =====
  const [activeTab, setActiveTab] = useState<'checks' | 'ledger'>('checks')
  const [searchText, setSearchText] = useState('')
  const [appliedKeyword, setAppliedKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<string[]>(['in_progress'])
  const [wbTodoOnly, setWbTodoOnly] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [auditFilter, setAuditFilter] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState<string>()
  const [dateTo, setDateTo] = useState<string>()
  const [statsOpen, setStatsOpen] = useState(false)

  // ===== KPI =====
  const [kpi, setKpi] = useState<StockCheckKpiData | null>(null)
  const [kpiLoading, setKpiLoading] = useState(false)
  const loadKpi = useCallback(async () => {
    setKpiLoading(true)
    try {
      const res: any = await materialApi.getStockCheckKpi()
      setKpi(res.data)
    } catch {
      /* 静默失败, KPI 显示 0 */
    } finally {
      setKpiLoading(false)
    }
  }, [])
  useEffect(() => { loadKpi() }, [loadKpi])

  // ===== 台账 Tab 2 附加筛选 =====
  const [onlyMine, setOnlyMine] = useState(false)
  const [diffOnly, setDiffOnly] = useState(false)
  const [whFilterOptions, setWhFilterOptions] = useState<{ text: string; value: string }[]>([])
  useEffect(() => {
    materialApi.listCountedWarehouses().then((res: any) => {
      const list = (res?.data || []) as Array<{ wh_id: number; wh_name: string }>
      setWhFilterOptions(list.map((w) => ({ text: w.wh_name || `仓库#${w.wh_id}`, value: String(w.wh_id) })))
    }).catch(() => { /* 静默 */ })
  }, [])

  // ===== Tab 1 · 盘点单列表 =====
  const {
    tableProps: recentTableProps,
    reload: reloadRecentList,
    total: recentTotal,
  } = useAntTableQuery({
    fetchData: async (params) => {
      const res: any = await materialApi.getRecentStockChecks({
        page: params.page,
        page_size: params.page_size,
        keyword: appliedKeyword || undefined,
        sort_by: params.sort_by ?? 'updated_at',
        sort_order: params.sort_order ?? 'desc',
        status: statusFilter.length ? statusFilter.join(',') : undefined,
        writeback_todo: wbTodoOnly || undefined,
        check_type: typeFilter && typeFilter !== 'k3' ? typeFilter : undefined,
        source: typeFilter === 'k3' ? 'k3' : undefined,
        audit_status: auditFilter || undefined,
        date_from: dateFrom,
        date_to: dateTo,
      })
      return { items: res.data?.items || [], total: res.data?.total || 0 }
    },
    extraDeps: [appliedKeyword, statusFilter, wbTodoOnly, typeFilter, auditFilter, dateFrom, dateTo],
  })

  // ===== Tab 2 · 物料台账 =====
  const {
    tableProps: ledgerTableProps,
    total: ledgerTotal,
    filters: ledgerFilters,
  } = useAntTableQuery({
    fetchData: async (params) => {
      const res: any = await materialApi.listCountedMaterials({
        page: params.page,
        page_size: params.page_size,
        keyword: appliedKeyword || undefined,
        sort_by: params.sort_by ?? 'diff_qty',
        sort_order: params.sort_order ?? 'desc',
        wh_id: params.wh_id as string | number | undefined,
        date_from: dateFrom,
        date_to: dateTo,
        only_mine: onlyMine || undefined,
        diff_only: diffOnly || undefined,
      })
      return { items: res.data?.items || [], total: Number(res.data?.total || 0) }
    },
    filterToQuery: (filters) => ({
      wh_id: (filters.wh_name as string[] | undefined)?.[0],
    }),
    extraDeps: [appliedKeyword, dateFrom, dateTo, onlyMine, diffOnly],
  })

  // 表头筛选变化同步到页面级状态（状态 chips 与「类型」筛选联动）。
  // 内容不变时返回原引用, 避免 extraDeps 变化导致翻页被重置回第 1 页。
  const handleRecentChange: typeof recentTableProps.onChange = (pagination, filters, sorter, extra) => {
    const s = ((filters.status as string[] | undefined) ?? []).filter(Boolean)
    // 仅当用户真的改了状态列筛选才退出「K3 待回写」chip（纯翻页/排序不清筛选）
    if (statusFilter.join(',') !== s.join(',')) setWbTodoOnly(false)
    setStatusFilter((prev) => (prev.join(',') === s.join(',') ? prev : s))
    const t = (filters.type as string[] | undefined)?.[0] ?? null
    setTypeFilter((prev) => (prev === t ? prev : t))
    recentTableProps.onChange(pagination, filters, sorter, extra)
  }

  const statsFilters = useMemo(() => ({
    check_type: typeFilter && typeFilter !== 'k3' ? typeFilter : undefined,
    date_from: dateFrom,
    date_to: dateTo,
    status: statusFilter.length ? statusFilter.join(',') : undefined,
  }), [typeFilter, dateFrom, dateTo, statusFilter])

  // ===== 深链处理（OrderList 入口 /stock-check?orderNo=xxx 与旧 ?checkId=）=====
  const deepLinkHandled = useRef(false)
  useEffect(() => {
    if (deepLinkHandled.current) return
    deepLinkHandled.current = true
    const checkId = params.get('checkId')
    const orderNoParam = params.get('orderNo')
    if (!checkId && !orderNoParam) return
    setParams({}, { replace: true })
    if (checkId && !Number.isNaN(Number(checkId))) {
      navigate(`/stock-check/${checkId}`, { replace: true })
      return
    }
    if (orderNoParam) {
      materialApi.getStockChecksByOrder(orderNoParam).then((res: any) => {
        const list: StockCheck[] = res.data || []
        const ongoing = list.find((c) => c.status === 'in_progress' || c.status === 'open')
        if (ongoing) {
          navigate(`/stock-check/${ongoing.id}`, { replace: true })
        } else {
          setOrderInput(orderNoParam)
          setOrderNo(orderNoParam)
          setOrderModalOpen(true)
        }
      }).catch(() => {
        setOrderInput(orderNoParam)
        setOrderNo(orderNoParam)
        setOrderModalOpen(true)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ===== 创建入口 =====
  const [orderModalOpen, setOrderModalOpen] = useState(false)
  const [orderInput, setOrderInput] = useState('')
  const [orderNo, setOrderNo] = useState('')
  const [orderPickerOpen, setOrderPickerOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [k3ModalOpen, setK3ModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [coveredKeys, setCoveredKeys] = useState<Set<string>>(new Set())

  // 打开订单产品选择器前, 拉取该订单已有(非取消)盘点单覆盖的产品 key
  useEffect(() => {
    if (!orderPickerOpen || !orderNo) { setCoveredKeys(new Set()); return }
    let cancelled = false
    materialApi.getStockChecksByOrder(orderNo).then((res: any) => {
      if (cancelled) return
      const set = new Set<string>()
      for (const c of res.data || []) {
        if (c.status === 'cancelled') continue
        for (const p of c.covered_products || []) set.add(`${p.product_code ?? ''}__${p.bom_no ?? ''}`)
      }
      setCoveredKeys(set)
    }).catch(() => { /* 静默 */ })
    return () => { cancelled = true }
  }, [orderPickerOpen, orderNo])

  const openOrderModal = () => {
    setOrderInput(orderNo || '')
    setOrderModalOpen(true)
  }

  // 下一步前先验证订单号有效(拉取订单产品行),不存在则报错留在本弹窗
  const [orderChecking, setOrderChecking] = useState(false)
  const confirmOrderModal = async () => {
    const v = orderInput.trim()
    if (!v) { message.warning('请输入订单号'); return }
    setOrderChecking(true)
    try {
      await orderApi.getProductMaterials(v)
      setOrderNo(v)
      setOrderModalOpen(false)
      setOrderPickerOpen(true)
    } catch (e: any) {
      const status = e?.response?.status
      if (status === 404) {
        message.error(`订单 ${v} 不存在，请检查订单号`)
      } else {
        message.error(e?.response?.data?.detail || e.message || '订单校验失败')
      }
    } finally {
      setOrderChecking(false)
    }
  }

  const handleCreateFromOrder = useCallback(async (selected: OrderProductSelection[], recentDays?: number) => {
    if (!orderNo) return
    setCreating(true)
    try {
      const res: any = await materialApi.createStockCheckFromOrder(orderNo, {
        ...(selected && selected.length ? { selected_products: selected } : {}),
        ...(recentDays != null ? { recent_days: recentDays } : {}),
      })
      const c: StockCheck = res.data
      message.success(`已创建盘点单 ${c.check_no}`)
      setOrderPickerOpen(false)
      loadKpi()
      reloadRecentList()
      navigate(`/stock-check/${c.id}`)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '创建盘点单失败')
    } finally {
      setCreating(false)
    }
  }, [orderNo, loadKpi, reloadRecentList, navigate])

  const handleCreateFromMaterials = useCallback(async (selected: MaterialCandidate[], source: 'search' | 'pool', recentDays?: number | null) => {
    setCreating(true)
    try {
      // 带仓库信息的行走 items(按物料+仓库精确创建); 旧版无仓库信息的池数据走 material_ids 兜底(全仓库)
      const items = selected
        .filter((s) => s.wh_id !== undefined)
        .map((s) => ({ material_id: s.erp_material_id, wh_id: s.wh_id ?? null }))
      const legacyIds = selected.filter((s) => s.wh_id === undefined).map((s) => s.erp_material_id)
      const res: any = await materialApi.createStockCheckFromMaterials({
        ...(items.length ? { items } : {}),
        ...(legacyIds.length ? { material_ids: legacyIds } : {}),
        ...(recentDays != null ? { recent_days: recentDays } : {}),
      })
      const c: StockCheck = res.data
      message.success(`已创建手动盘点单 ${c.check_no}`)
      if (source === 'pool') {
        poolRemove(selected.map((s) => ({ erp_material_id: s.erp_material_id, wh_id: s.wh_id })))
      }
      setPickerOpen(false)
      loadKpi()
      reloadRecentList()
      navigate(`/stock-check/${c.id}`)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '创建盘点单失败')
    } finally {
      setCreating(false)
    }
  }, [poolRemove, loadKpi, reloadRecentList, navigate])

  // ===== 行操作：取消 / 导出 =====
  const handleCancelRow = (r: StockCheck) => {
    Modal.confirm({
      title: '取消盘点单',
      content: `确认取消盘点单 ${r.check_no}? 取消后不可恢复。`,
      okType: 'danger',
      onOk: async () => {
        try {
          await materialApi.cancelStockCheck(r.id)
          message.success('已取消')
          reloadRecentList()
          loadKpi()
        } catch (e: any) {
          const code = e?.response?.data?.detail?.code ?? e?.response?.data?.code
          if (code === 409) {
            message.warning('盘点单状态刚被他人修改,正在刷新')
            reloadRecentList()
          } else {
            message.error(e?.response?.data?.detail || e.message || '取消失败')
          }
        }
      },
    })
  }

  const { exporting, exportData } = useExport()
  const [exportCheck, setExportCheck] = useState<StockCheck | null>(null)
  const [exportFormat] = useState<'xlsx' | 'csv'>('xlsx')
  const [exportColumnModalOpen, setExportColumnModalOpen] = useState(false)

  const openRowExport = (r: StockCheck) => {
    setExportCheck(r)
    setExportColumnModalOpen(true)
  }

  const handleExportColumnConfirm = (selectedColumns: string[]) => {
    setExportColumnModalOpen(false)
    if (!exportCheck) return
    const ext = exportFormat === 'csv' ? 'csv' : 'xlsx'
    exportData(
      `/api/v1/materials/stock-check/${exportCheck.id}/export`,
      { format: exportFormat, columns: selectedColumns.join(',') },
      `物料盘点明细_${exportCheck.check_no}.${ext}`,
    )
  }

  // ===== 工具栏导出（当前 Tab 按筛选条件全量拉取 → CSV）=====
  const [exportingAll, setExportingAll] = useState(false)
  const fetchAllPages = async (fetchPage: (p: number) => Promise<{ items: any[]; total: number }>): Promise<any[]> => {
    const all: any[] = []
    let p = 1
    for (;;) {
      const res = await fetchPage(p)
      const batch = res.items || []
      all.push(...batch)
      if (all.length >= (res.total ?? 0) || batch.length === 0 || p >= 50) break
      p++
    }
    return all
  }

  const handleToolbarExport = async () => {
    setExportingAll(true)
    try {
      if (activeTab === 'checks') {
        const rows = (await fetchAllPages((p) =>
          materialApi.getRecentStockChecks({
            page: p, page_size: 100,
            keyword: appliedKeyword || undefined,
            sort_by: 'updated_at', sort_order: 'desc',
            status: statusFilter.length ? statusFilter.join(',') : undefined,
            check_type: typeFilter && typeFilter !== 'k3' ? typeFilter : undefined,
            source: typeFilter === 'k3' ? 'k3' : undefined,
            audit_status: auditFilter || undefined,
            date_from: dateFrom,
            date_to: dateTo,
          }).then((res: any) => ({ items: res.data?.items || [], total: res.data?.total || 0 })),
        )) as StockCheck[]
        if (!rows.length) { message.info('当前筛选无数据可导出'); return }
        exportCsv('盘点单台账.csv',
          ['盘点单号', '类型', '关联订单', '状态', '已盘', '应盘', '盘盈', '盘亏', '创建人', '更新时间'],
          rows.map((r) => [
            r.check_no, checkTypeTag(r.check_type, r.source).label, r.order_no || '',
            STATUS_MAP[r.status || '']?.label || r.status || '',
            r.checked_materials ?? 0, r.total_materials ?? 0, r.gain_count ?? 0, r.loss_count ?? 0,
            r.created_by || '', r.updated_at ? formatDateTime(r.updated_at) : '',
          ]))
      } else {
        const rows = (await fetchAllPages((p) =>
          materialApi.listCountedMaterials({
            page: p, page_size: 100,
            keyword: appliedKeyword || undefined,
            sort_by: 'diff_qty', sort_order: 'desc',
            wh_id: (ledgerFilters.wh_name as string[] | undefined)?.[0],
            date_from: dateFrom,
            date_to: dateTo,
            only_mine: onlyMine || undefined,
            diff_only: diffOnly || undefined,
          }).then((res: any) => ({ items: res.data?.items || [], total: Number(res.data?.total || 0) })),
        )) as LedgerRow[]
        if (!rows.length) { message.info('当前筛选无数据可导出'); return }
        exportCsv('物料盘点台账.csv',
          ['物料编码', '物料名称', '规格', '仓库', '应盘', '系统快照', '实盘', '差异', '所属盘点单', '盘点人', '盘点时间'],
          rows.map((r) => [
            r.material_code || '', r.material_name || '', r.spec_model || '', r.wh_name || '',
            r.req_qty ?? '', r.system_qty ?? '', r.actual_qty ?? '', r.diff_qty ?? '',
            r.check_no || '', r.counted_by || '', r.counted_at ? formatDateTime(r.counted_at) : '',
          ]))
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '导出失败')
    } finally {
      setExportingAll(false)
    }
  }

  // ===== 新手引导 =====
  const newbieMode = useUiPreferencesStore(s => s.preferences?.newbie_mode !== false)
  const tourId = STOCK_CHECK_INTRO_TOUR_ID
  const tourSteps = stockCheckIntroSteps ?? []
  const seenTour = useUiPreferencesStore(s => s.preferences?.['tours_seen']?.[tourId])
  const setUiFlag = useUiPreferencesStore(s => s.setFlag)
  const [tourOpen, setTourOpen] = useState(false)

  useEffect(() => {
    if (!newbieMode) return
    if (seenTour) return
    const t = setTimeout(() => setTourOpen(true), 500)
    return () => clearTimeout(t)
  }, [newbieMode, seenTour])

  const handleTourClose = useCallback(() => {
    const current = useUiPreferencesStore.getState().getFlag('tours_seen', {}) as Record<string, boolean>
    useUiPreferencesStore.getState().setFlag('tours_seen', { ...current, [tourId]: true })
    setTourOpen(false)
  }, [tourId])

  const handleHelpClick = useCallback(() => {
    setTourOpen(true)
  }, [])

  const handleNewbieToggle = useCallback((checked: boolean) => {
    setUiFlag('newbie_mode', checked)
  }, [setUiFlag])

  // ===== Tab 1 · 盘点单列定义 =====
  const recentColumns = useMemo(() => [
    {
      title: '盘点单号', dataIndex: 'check_no', width: 170, sorter: true,
      render: (v: string, r: StockCheck) => (
        <Button type="link" size="small" style={{ padding: 0, ...MONO, fontWeight: 600 }} onClick={() => navigate(`/stock-check/${r.id}`)}>{v}</Button>
      ),
    },
    {
      title: <span data-tour="stock-check-type-filter">类型</span>, dataIndex: 'check_type', width: 90,
      filters: [
        { text: '订单', value: 'order' },
        { text: '手动', value: 'manual' },
        { text: '快捷', value: 'quick' },
        { text: 'K3', value: 'k3' },
      ],
      filterMultiple: false,
      filteredValue: typeFilter ? [typeFilter] : null,
      onFilter: (value: boolean | React.Key, r: StockCheck) =>
        value === 'k3' ? r.source === 'k3' : r.check_type === value,
      render: (_v: any, r: StockCheck) => {
        const t = checkTypeTag(r.check_type, r.source)
        return <ScTag variant={t.variant}>{t.label}</ScTag>
      },
    },
    {
      title: '关联订单', dataIndex: 'order_no', width: 170, sorter: true,
      onCell: () => ({ style: { maxWidth: 170, overflow: 'hidden' } }),
      render: (v: string | null) => v
        ? <Tooltip title={v} mouseEnterDelay={0.3}>
            <Button type="link" size="small" style={{ padding: 0, ...MONO, maxWidth: '100%', display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => navigate(`/orders/${v}`)}>{v}</Button>
          </Tooltip>
        : <span className="sc-diff-flat">—</span>,
    },
    {
      title: '覆盖产品', dataIndex: 'covered_products', width: 150,
      onCell: () => ({ style: { maxWidth: 150, overflow: 'hidden' } }),
      render: (_v: any, r: StockCheck) => {
        const ps = r.covered_products || []
        if (!ps.length) return <span className="sc-diff-flat">—</span>
        const full = ps.map((p) => `${p.product_code || '—'}${p.bom_no ? ` (${p.bom_no})` : ''}`).join('、')
        if (ps.length === 1) {
          const p = ps[0]
          return <Tooltip title={full} mouseEnterDelay={0.3}>
            <span style={{ ...MONO, display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{p.product_code || '—'}{p.order_qty != null ? ` ×${p.order_qty}` : ''}</span>
          </Tooltip>
        }
        return <Tooltip title={full} mouseEnterDelay={0.3}>
          <span style={{ ...MONO, display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{ps[0].product_code || '—'} 等 {ps.length} 款</span>
        </Tooltip>
      },
    },
    {
      title: '已盘进度', dataIndex: 'checked_materials', width: 160, sorter: true,
      render: (_v: any, r: StockCheck) => {
        const total = r.total_materials || 0
        const checked = r.checked_materials || 0
        const pct = total > 0 ? Math.round((checked / total) * 100) : 0
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Progress percent={pct} size="small" showInfo={false} style={{ flex: 1, margin: 0, minWidth: 56 }} strokeColor={pct >= 100 ? '#16a34a' : undefined} />
            <span className='sc-mono' style={{ whiteSpace: 'nowrap' }}>{checked}/{total}</span>
          </div>
        )
      },
    },
    {
      title: '差异', dataIndex: 'total_diff_qty', width: 130, sorter: true,
      render: (_v: any, r: StockCheck) => <DiffPair gain={r.gain_count} loss={r.loss_count} />,
    },
    {
      title: '状态', dataIndex: 'status', width: 150,
      filters: STATUS_OPTIONS,
      filterMultiple: true,
      filteredValue: statusFilter,
      render: (v: string, r: StockCheck) => {
        const wbF = r.writeback_failed ?? 0
        const wbP = r.writeback_pending ?? 0
        return (
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            <ScTag variant={STATUS_MAP[v]?.variant || 'wait'}>{STATUS_MAP[v]?.label || v}</ScTag>
            {v === 'completed' && wbF > 0 && <Tag color="error">回写失败 {wbF}</Tag>}
            {v === 'completed' && wbF === 0 && wbP > 0 && <Tag color="warning">K3 待回写 {wbP}</Tag>}
          </span>
        )
      },
    },
    {
      title: '抽检', dataIndex: 'audit_status', width: 90,
      render: (_v: any, r: StockCheck) => auditTagOf(r),
    },
    {
      title: '协同人', dataIndex: 'co_checkers', width: 110,
      render: (_v: any, r: StockCheck) => <AvatarStack users={(r.co_checkers as CoChecker[]) || []} />,
    },
    { title: '创建人', dataIndex: 'created_by', width: 100, render: (v: string) => v || '—' },
    { title: '更新时间', dataIndex: 'updated_at', width: 140, sorter: true, render: (v: string) => (v ? <span className="sc-mono">{formatDateTime(v)}</span> : '-') },
    {
      title: '操作', key: 'op', width: 210, fixed: 'right' as const,
      render: (_v: any, r: StockCheck) => {
        const active = r.status === 'open' || r.status === 'in_progress'
        const wbTodo = ((r.writeback_pending ?? 0) + (r.writeback_failed ?? 0)) > 0
        return (
          <span className="sc-row-act">
            <Button type="link" size="small" onClick={() => navigate(`/stock-check/${r.id}`)}>
              {active ? '继续盘点' : '查看'}
            </Button>
            {r.status === 'completed' && wbTodo && (
              <Button type="link" size="small" style={{ color: '#d97706' }} onClick={() => navigate(`/stock-check/${r.id}?wb=1`)}>
                K3 回写
              </Button>
            )}
            <Button type="link" size="small" onClick={() => openRowExport(r)}>导出</Button>
            {active && (
              <Button type="link" size="small" danger onClick={() => handleCancelRow(r)}>取消</Button>
            )}
          </span>
        )
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [navigate, typeFilter, statusFilter])

  // ===== Tab 2 · 物料台账列定义 =====
  const renderDiff = (v: number | null | undefined) => {
    if (v == null) return <span className="sc-diff-flat">—</span>
    const n = Number(v)
    if (n > 0) return <span className="sc-diff-up">+{fmtNum(n)}</span>
    if (n < 0) return <span className="sc-diff-down">-{fmtNum(Math.abs(n))}</span>
    return <span className="sc-diff-flat">0</span>
  }

  const ledgerColumns = useMemo(() => [
    {
      title: '物料编码', dataIndex: 'material_code', width: 140, sorter: true,
      render: (v: string) => <span style={{ ...MONO, fontWeight: 600 }}>{v || '—'}</span>,
    },
    {
      title: '物料名称 / 规格', dataIndex: 'material_name', width: 200, ellipsis: true,
      render: (v: string, r: LedgerRow) => (
        <div>
          <div>{v || '—'}</div>
          {r.spec_model ? (
            <div className='sc-sub' style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.spec_model}</div>
          ) : null}
        </div>
      ),
    },
    {
      title: '仓库', dataIndex: 'wh_name', width: 130,
      render: (v: string, r: LedgerRow) => {
        if (r.wh_id == null && r.live_wh_names) {
          return (
            <Tooltip title={`建单时未入库，现已入库：${r.live_wh_names}`}>
              <span style={{ color: '#0284c7' }}>{r.live_wh_names}</span>
            </Tooltip>
          )
        }
        return v || <span className="sc-wh-none">(未入库)</span>
      },
      filterDropdown: (props: any) => <SearchableColumnFilter {...props} filters={whFilterOptions} columnKey="wh_name" />,
      filteredValue: (ledgerFilters.wh_name as string[] | undefined) ?? null,
    },
    { title: '应盘', dataIndex: 'req_qty', width: 90, align: 'right' as const, render: fmtNum },
    {
      title: '系统快照', dataIndex: 'system_qty', width: 110, align: 'right' as const,
      render: (v: number | null) => v == null ? <span className="sc-diff-flat">—</span> : <span>{fmtNum(v)}<span className="sc-snap-badge">快照</span></span>,
    },
    { title: '实盘', dataIndex: 'actual_qty', width: 90, align: 'right' as const, render: (v: number | null) => <span style={{ fontWeight: 500 }}>{fmtNum(v)}</span> },
    { title: '差异', dataIndex: 'diff_qty', width: 90, align: 'right' as const, sorter: true, render: renderDiff },
    {
      title: '所属盘点单', dataIndex: 'check_no', width: 160,
      render: (v: string, r: LedgerRow) => (v && r.check_id
        ? <Button type="link" size="small" style={{ padding: 0, ...MONO }} onClick={() => navigate(`/stock-check/${r.check_id}`)}>{v}</Button>
        : '—'),
    },
    {
      title: '盘点人', dataIndex: 'counted_by', width: 120,
      render: (v: string, r: LedgerRow) => (
        <div>
          <div>{v || '—'}</div>
          {r.counted_at ? <div className='sc-sub'>{formatDateTime(r.counted_at).slice(11)}</div> : null}
        </div>
      ),
    },
    {
      title: '标记', key: 'mark', width: 100,
      render: (_v: any, r: LedgerRow) => {
        if (!r.counted_at) return null
        const within7 = Date.now() - new Date(r.counted_at).getTime() < 7 * 86400000
        return within7 ? <ScTag variant="done">近期已盘</ScTag> : null
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [navigate, whFilterOptions, ledgerFilters.wh_name])

  // ===== 新建盘点下拉 =====
  const createMenuItems: MenuProps['items'] = [
    { key: 'order', icon: <FileTextOutlined />, label: '从订单创建（选订单产品）' },
    {
      key: 'manual', icon: <AppstoreOutlined />,
      label: (
        <span data-tour="stock-check-manual-create">
          <span data-tour="stock-check-pool-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            手动选物料创建
            {poolCount > 0 && <Badge count={poolCount} size="small" overflowCount={999} />}
          </span>
        </span>
      ),
    },
    { type: 'divider' },
    { key: 'k3', icon: <DatabaseOutlined />, label: '从 K3 盘盈亏单导入' },
  ]

  const handleCreateMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'order') openOrderModal()
    else if (key === 'manual') setPickerOpen(true)
    else if (key === 'k3') setK3ModalOpen(true)
  }

  // ===== KPI 卡片 =====
  const weekTypeParts: string[] = []
  if (kpi) {
    const by = kpi.week_new_by_type || {}
    if (by.order) weekTypeParts.push(`订单 ${by.order}`)
    if (by.manual) weekTypeParts.push(`手动 ${by.manual}`)
    if (by.quick) weekTypeParts.push(`快捷 ${by.quick}`)
    if (by.k3) weekTypeParts.push(`K3 ${by.k3}`)
  }

  const kpiCards = [
    {
      accent: '#5b5bd6', accentBg: '#eef0fe', icon: <AuditOutlined />,
      label: '进行中盘点单', value: kpi?.in_progress_checks ?? 0, unit: '单',
      delta: <span className="sc-stat-delta up">▲ 本周 +{kpi?.week_new_checks ?? 0}</span>,
    },
    {
      accent: '#0284c7', accentBg: '#f0f9ff', icon: <CalendarOutlined />,
      label: '本周新增盘点', value: kpi?.week_new_checks ?? 0, unit: '单',
      delta: <span className="sc-stat-delta flat">{weekTypeParts.join(' · ') || '本周暂无新增'}</span>,
    },
    {
      accent: '#dc2626', accentBg: '#fef2f2', icon: <WarningOutlined />,
      label: '待处理差异物料', value: (kpi?.pending_gain_count ?? 0) + (kpi?.pending_loss_count ?? 0), unit: '项',
      delta: <span className="sc-stat-delta down">盘亏 {kpi?.pending_loss_count ?? 0} · 盘盈 {kpi?.pending_gain_count ?? 0}</span>,
    },
    {
      accent: '#16a34a', accentBg: '#f0fdf4', icon: <CheckCircleOutlined />,
      label: '7 日内已盘物料', value: kpi?.recent7_checked_materials ?? 0, unit: '项',
      delta: <span className="sc-stat-delta flat">近期已盘 · 免重复盘点</span>,
    },
  ]

  return (
    <div className="sc-page">
      {/* ===== 工具栏（原型为无卡片平铺行） ===== */}
      <div className="sc-toolbar">
        <span data-tour="stock-check-search">
          <Input.Search
            placeholder="盘点单号 / 物料编码 / 订单号"
            style={{ width: 240 }}
            allowClear
            value={searchText}
            onChange={(e) => { setSearchText(e.target.value); if (!e.target.value) setAppliedKeyword('') }}
            onSearch={(v) => setAppliedKeyword(v.trim())}
          />
        </span>
        {activeTab === 'checks' && (
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
            {STATUS_CHIP_ORDER.map((s) => (
              <span
                key={s}
                className={`sc-chip${!wbTodoOnly && statusFilter.includes(s) ? ' on' : ''}`}
                onClick={() => { setWbTodoOnly(false); if (statusFilter.join(',') !== s) setStatusFilter([s]) }}
              >
                {STATUS_MAP[s].label} <span className="n">{kpi?.status_counts?.[s] ?? 0}</span>
              </span>
            ))}
            <span
              className={`sc-chip${wbTodoOnly ? ' on' : ''}`}
              onClick={() => { if (!wbTodoOnly) { setWbTodoOnly(true); setStatusFilter(['completed']) } }}
            >
              K3 待回写{' '}
              <span className="n" style={((kpi?.writeback_todo_checks ?? 0) > 0) ? { color: '#dc2626', opacity: 1, fontWeight: 600 } : undefined}>
                {kpi?.writeback_todo_checks ?? 0}
              </span>
            </span>
            <span
              className={`sc-chip${auditFilter === 'pending' && !wbTodoOnly && statusFilter.join(',') === 'completed' ? ' on' : ''}`}
              onClick={() => { setWbTodoOnly(false); setAuditFilter('pending'); setStatusFilter(['completed']) }}
            >
              待抽检
            </span>
            <Select
              allowClear
              placeholder="抽检状态"
              style={{ width: 104 }}
              value={auditFilter ?? undefined}
              onChange={(v) => {
                setAuditFilter(v ?? null)
                // 抽检状态与单据状态联动,避免与状态 chips 冲突导致空结果
                if (v === 'pending' || v === 'passed') setStatusFilter(['completed'])
                else if (v === 'rejected') setStatusFilter(['in_progress'])
              }}
              options={[
                { value: 'pending', label: '待抽检' },
                { value: 'passed', label: '已通过' },
                { value: 'rejected', label: '已发回' },
              ]}
            />
          </span>
        )}
        <span className="sc-toolbar-hint">盘点完结后进入财务抽检 · 抽检通过才计划 K3 盘盈/调拨单</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Popover
            trigger="click"
            placement="bottomRight"
            content={
              <div style={{ padding: 4 }}>
                <div style={{ fontSize: 'calc(12.5px * var(--font-size-scale))', color: '#64748b', marginBottom: 8 }}>盘点日期范围（应用于当前 Tab）</div>
                <DatePicker.RangePicker
                  onChange={(d) => {
                    setDateFrom(d?.[0]?.format('YYYY-MM-DD'))
                    setDateTo(d?.[1]?.format('YYYY-MM-DD'))
                  }}
                />
              </div>
            }
          >
            <Button icon={<FilterOutlined />}>更多筛选{(dateFrom || dateTo) ? ' ·' : ''}</Button>
          </Popover>
          {activeTab === 'checks' && (
            <Button type={statsOpen ? 'primary' : 'default'} icon={<BarChartOutlined />} onClick={() => setStatsOpen((v) => !v)}>
              统计图表
            </Button>
          )}
          <Button icon={<DownloadOutlined />} loading={exportingAll} onClick={handleToolbarExport}>导出</Button>
          <span style={{ width: 1, height: 20, background: '#e2e8f0' }} />
          <Button icon={<ThunderboltOutlined style={{ color: '#faad14' }} />} onClick={() => navigate('/quick-stock-check')}>
            快捷盘点
          </Button>
          <span data-tour="stock-check-create">
            <Dropdown menu={{ items: createMenuItems, onClick: handleCreateMenuClick }}>
              <Button type="primary" icon={<PlusOutlined />}>
                新建盘点 <DownOutlined />
              </Button>
            </Dropdown>
          </span>
          <Popover
            trigger="click"
            placement="bottomRight"
            content={
              <div style={{ width: 200 }}>
                <div style={{ marginBottom: 8, fontWeight: 500 }}>新手指引</div>
                <Button type="link" size="small" onClick={handleHelpClick} style={{ padding: 0, marginBottom: 8 }}>
                  ▶ 立即查看
                </Button>
                <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                  <Checkbox checked={newbieMode} onChange={(e) => handleNewbieToggle(e.target.checked)}>
                    开启新手指引
                  </Checkbox>
                </div>
              </div>
            }
          >
            <Button icon={<QuestionCircleOutlined />} shape="circle" title="新手指引" />
          </Popover>
        </span>
      </div>

      {/* ===== 统计图表（可折叠面板）===== */}
      {statsOpen && (
        <div style={{ marginBottom: 12 }}>
          <StatsCharts filters={statsFilters} />
        </div>
      )}

      {/* ===== KPI 行 ===== */}
      <Spin spinning={kpiLoading}>
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          {kpiCards.map((c) => (
            <Col key={c.label} xs={24} sm={12} xl={6}>
              <div className="sc-stat-card" style={{ '--accent': c.accent, '--accent-bg': c.accentBg } as CSSProperties}>
                <div className="sc-stat-icon">{c.icon}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="sc-stat-label">{c.label}</div>
                  <div className="sc-stat-value">
                    {c.value}<small>{c.unit}</small>
                  </div>
                  {c.delta}
                </div>
              </div>
            </Col>
          ))}
        </Row>
      </Spin>

      {/* ===== 双 Tab 台账 ===== */}
      <div className="sc-card" style={{ padding: '0 8px 12px' }}>
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as 'checks' | 'ledger')}
          tabBarExtraContent={activeTab === 'ledger' ? {
            right: (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <span className={`sc-chip${onlyMine ? ' on' : ''}`} onClick={() => setOnlyMine((v) => !v)}>仅我盘的</span>
                <span className={`sc-chip${diffOnly ? ' on' : ''}`} onClick={() => setDiffOnly((v) => !v)}>仅看差异</span>
              </span>
            ),
          } : undefined}
          items={[
            {
              key: 'checks',
              label: <>盘点单<span className="sc-tab-count">{recentTotal}</span></>,
              children: (
                <Table
                  rowKey="id"
                  size="small"
                  scroll={{ x: 1400 }}
                  dataSource={recentTableProps.dataSource}
                  loading={recentTableProps.loading}
                  pagination={recentTableProps.pagination}
                  onChange={handleRecentChange}
                  columns={recentColumns}
                  summary={() => {
                    const rows = recentTableProps.dataSource as StockCheck[]
                    if (!rows.length) return null
                    const inProg = rows.filter((r) => r.status === 'in_progress').length
                    const checked = rows.reduce((s, r) => s + (r.checked_materials || 0), 0)
                    const gain = rows.reduce((s, r) => s + (r.gain_count || 0), 0)
                    const loss = rows.reduce((s, r) => s + (r.loss_count || 0), 0)
                    return (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={4}>
                          <span style={{ color: '#94a3b8' }}>本页 {rows.length} 单 · 进行中 {inProg}</span>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={4} align="right">
                          <span style={{ color: '#94a3b8' }}>合计已盘 {checked} 项</span>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={5} align="right">
                          <DiffPair gain={gain} loss={loss} />
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={6} colSpan={6} />
                      </Table.Summary.Row>
                    )
                  }}
                />
              ),
            },
            {
              key: 'ledger',
              label: <>物料台账<span className="sc-tab-count">{ledgerTotal}</span></>,
              children: (
                <Table
                  rowKey={(r) => `${(r as LedgerRow).material_id ?? 'x'}|${(r as LedgerRow).wh_id ?? 'none'}`}
                  size="small"
                  scroll={{ x: 1300 }}
                  dataSource={ledgerTableProps.dataSource}
                  loading={ledgerTableProps.loading}
                  pagination={ledgerTableProps.pagination}
                  onChange={ledgerTableProps.onChange}
                  columns={ledgerColumns}
                  summary={() => {
                    const rows = ledgerTableProps.dataSource as LedgerRow[]
                    if (!rows.length) return null
                    const gain = rows.filter((r) => (r.diff_qty ?? 0) > 0).length
                    const loss = rows.filter((r) => (r.diff_qty ?? 0) < 0).length
                    const net = rows.reduce((s, r) => s + Number(r.diff_qty || 0), 0)
                    return (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={6}>
                          <span style={{ color: '#94a3b8' }}>本页 {rows.length} 行 · 盘盈 {gain} · 盘亏 {loss}</span>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={6} align="right">
                          <span className={net > 0 ? 'sc-diff-up' : net < 0 ? 'sc-diff-down' : 'sc-diff-flat'}>
                            {net > 0 ? '+' : ''}{Math.round(net * 100) / 100}
                          </span>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={7} colSpan={3} />
                      </Table.Summary.Row>
                    )
                  }}
                />
              ),
            },
          ]}
        />
      </div>

      <Tour open={tourOpen} steps={tourSteps} onClose={handleTourClose} onFinish={handleTourClose} />

      {/* ===== 从订单创建：订单号输入 ===== */}
      <Modal
        open={orderModalOpen}
        title="从订单创建盘点"
        okText="下一步"
        cancelText="取消"
        confirmLoading={orderChecking}
        onOk={confirmOrderModal}
        onCancel={() => setOrderModalOpen(false)}
        destroyOnClose
      >
        <div style={{ marginBottom: 8, color: '#64748b' }}>输入订单号后选择要盘点的产品（按订单 BOM 展开）。</div>
        <Input
          placeholder="订单号，如 HJ2024-001"
          value={orderInput}
          onChange={(e) => setOrderInput(e.target.value)}
          onPressEnter={confirmOrderModal}
          autoFocus
        />
      </Modal>

      <ExportColumnSelector
        open={exportColumnModalOpen}
        columns={STOCK_CHECK_EXPORT_OPTIONS}
        onConfirm={handleExportColumnConfirm}
        onCancel={() => setExportColumnModalOpen(false)}
      />

      <MaterialPickerModal
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onConfirm={handleCreateFromMaterials}
        confirmLoading={creating}
        showRecentDays
      />

      <OrderProductPickerModal
        open={orderPickerOpen}
        orderNo={orderNo}
        coveredKeys={coveredKeys}
        onCancel={() => setOrderPickerOpen(false)}
        onCreate={(selected, recentDays) => handleCreateFromOrder(selected, recentDays)}
        confirmLoading={creating}
      />

      {k3ModalOpen && (
        <K3ImportModal
          open
          onClose={() => setK3ModalOpen(false)}
          onImported={() => { reloadRecentList(); loadKpi() }}
        />
      )}
    </div>
  )
}
