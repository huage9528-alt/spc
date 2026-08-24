import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Table, Input, Button, Space, Tag, message, Modal, Card, Row, Col,
  InputNumber, Checkbox, Spin, Popover, Tour, Drawer, Empty, Tooltip, DatePicker, Segmented, Badge, Select, Dropdown, Tabs, Typography,
} from 'antd'
import { SearchOutlined, ReloadOutlined, CheckCircleOutlined, CloudDownloadOutlined, StopOutlined, ArrowLeftOutlined, SaveOutlined, QuestionCircleOutlined, HistoryOutlined, PlusOutlined, RightOutlined, DownOutlined, DownloadOutlined, BarChartOutlined, DeleteOutlined } from '@ant-design/icons'
import { useAntTableQuery } from '@/hooks/useAntTableQuery'
import { useExport } from '@/hooks/useExport'
import { materialApi, orderApi } from '@/services/api'
import { formatDateTime } from '@/utils'
import { useUiPreferencesStore } from '@/store/uiPreferences'
import { useStockCheckPoolStore } from '@/store/stockCheckPool'
import ExportColumnSelector, { ExportColumnOption } from '@/components/ExportColumnSelector'
import { stockCheckIntroSteps, stockCheckDetailSteps, stockCheckManualDetailSteps, STOCK_CHECK_INTRO_TOUR_ID, STOCK_CHECK_DETAIL_TOUR_ID, STOCK_CHECK_MANUAL_DETAIL_TOUR_ID } from './StockCheckTour'
import MaterialPickerModal from './MaterialPickerModal'
import CountedLedgerPanel from './CountedLedger'
import OrderProductPickerModal, { OrderProductSelection, OrderProductLine } from './OrderProductPickerModal'
import CoCheckerPickerModal from './CoCheckerPickerModal'
import SearchableColumnFilter from './SearchableColumnFilter'
import { textColumnFilter, textFilterIcon } from './TextColumnFilter'
import StatsCharts from './components/StatsCharts'
import { useStockCheckSync } from '@/hooks/useStockCheckSync'
import ConflictModal, { ConflictDraft } from './ConflictModal'
import K3ImportModal from './K3ImportModal'
import { useAuthStore } from '@/store/auth'

interface StockCheckItem {
  id: number
  check_id: number
  line_no?: string | null
  level?: number | null
  material_id?: number | null
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  material_property_label?: string | null
  material_type?: string | null
  warehouses?: string | null
  wh_id?: number | null
  wh_name?: string | null
  wh_code?: string | null
  recent_checked_check_no?: string | null
  recent_checked_date?: string | null
  req_qty?: number | null
  system_qty?: number | null
  system_qty_time?: string | null
  live_qty?: number | null
  live_wh_names?: string | null
  snapshot_live?: boolean | null
  warehouse_display?: string | null
  actual_qty?: number | null
  diff_qty?: number | null
  is_checked?: number | null
  checked_at?: string | null
  checked_by?: string | null
  remark?: string | null
  force_recount?: boolean
  version?: number | null
}

interface MyStockCheckItem {
  item_id: number
  check_id: number
  check_no: string
  order_no?: string | null
  title?: string | null
  check_type?: string | null
  status?: string | null
  check_date?: string | null
  completed_at?: string | null
  material_id?: number | null
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  wh_id?: number | null
  wh_name?: string | null
  wh_code?: string | null
  system_qty?: number | null
  actual_qty?: number | null
  diff_qty?: number | null
  counted_by_user_id?: number | null
  counted_by?: string | null
  counted_at?: string | null
  recent_checked_check_no?: string | null
  recent_checked_date?: string | null
}

interface CoveredProduct {
  product_code?: string | null
  bom_no?: string | null
  line_no?: string | null
  product_name?: string | null
  order_qty?: number | null
}

interface CoChecker {
  user_id: number
  name: string
}

interface StockCheck {
  id: number
  check_no: string
  order_no?: string | null
  title?: string | null
  check_type?: string | null
  status?: string | null
  check_date?: string | null
  total_materials?: number | null
  checked_materials?: number | null
  total_diff_qty?: number | null
  created_by?: string | null
  created_by_user_id?: number | null
  checked_by?: string | null
  created_at?: string | null
  completed_at?: string | null
  remark?: string | null
  covered_products?: CoveredProduct[] | null
  co_checker_user_ids?: number[] | null
  co_checkers?: CoChecker[] | null
  can_edit?: boolean | null
  items?: StockCheckItem[]
  version?: number | null
}

interface MaterialCandidate {
  erp_material_id: number
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  system_qty?: number | null
  // wh_id === undefined 表示旧版池数据(整物料全仓库); null 表示未入库合成行
  wh_id?: number | null
  wh_code?: string | null
  wh_name?: string | null
}

interface MaterialHistoryItem {
  check_no: string
  order_no: string
  customer?: string | null
  status: string
  check_date?: string | null
  completed_at?: string | null
  actual_qty?: number | null
  created_at?: string | null
  created_by?: string | null
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  open: { label: '待盘点', color: 'default' },
  in_progress: { label: '进行中', color: 'processing' },
  completed: { label: '已完成', color: 'success' },
  cancelled: { label: '已取消', color: 'error' },
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

export default function StockCheckPage() {
  const [params, setParams] = useSearchParams()
  const poolCount = useStockCheckPoolStore((s) => s.items.length)
  const poolRemove = useStockCheckPoolStore((s) => s.remove)
  const [orderNo, setOrderNo] = useState<string>(params.get('orderNo') || '')
  const [checkIdParam, setCheckIdParam] = useState<number | null>(() => {
    const v = params.get('checkId')
    return v ? Number(v) : null
  })
  const [searchText, setSearchText] = useState<string>('')

  const [activeCheck, setActiveCheck] = useState<StockCheck | null>(null)
  const [items, setItems] = useState<StockCheckItem[]>([])
  const [loading, setLoading] = useState(false)
  const [savingAll, setSavingAll] = useState(false)
  const [listTab, setListTab] = useState<'all' | 'my' | 'counted'>('all')
  const [dateFrom, setDateFrom] = useState<string>()
  const [dateTo, setDateTo] = useState<string>()
  const [checkTypeFilter, setCheckTypeFilter] = useState<string>('all')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [addPickerOpen, setAddPickerOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [orderPickerOpen, setOrderPickerOpen] = useState(false)
  const [coPickerOpen, setCoPickerOpen] = useState(false)
  const [coPickerIds, setCoPickerIds] = useState<number[]>([])
  const [coSaving, setCoSaving] = useState(false)
  const [editingItemId, setEditingItemId] = useState<number | null>(null)
  const [presenceByItem, setPresenceByItem] = useState<Record<number, { user_id: number; name: string; isSelf: boolean }[]>>({})
  const presenceHeartbeat = useRef<ReturnType<typeof setInterval> | null>(null)
  const [conflict, setConflict] = useState<{
    myDraft: ConflictDraft
    serverVersion: number
    itemId: number
    serverItem: Record<string, any> | null
    serverChangedBy: string | null
  } | null>(null)
  const [syncBanner, setSyncBanner] = useState<string | null>(null)
  const [orderProducts, setOrderProducts] = useState<OrderProductLine[]>([])
  const [orderChecks, setOrderChecks] = useState<StockCheck[]>([])
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [progressCollapsed, setProgressCollapsed] = useState(true)
  const [productFilter, setProductFilter] = useState<string>('all')
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [statsOpen, setStatsOpen] = useState(false)
  const [k3ModalOpen, setK3ModalOpen] = useState(false)

  const { exporting, exportData } = useExport()
  const [exportFormat, setExportFormat] = useState<'xlsx' | 'csv'>('xlsx')
  const [exportColumnModalOpen, setExportColumnModalOpen] = useState(false)

  const loadCheck = useCallback(async (checkId: number) => {
    setLoading(true)
    try {
      const res: any = await materialApi.getStockCheck(checkId)
      const c: StockCheck = res.data
      setActiveCheck(c)
      setItems(c.items || [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '加载盘点单失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const { connected: syncConnected, lastEventAt: syncLastEventAt } = useStockCheckSync({
    checkId: activeCheck?.id ?? null,
    onSnapshot: (p) => {
      // can_edit 为空时保留原值,防止旧版 snapshot 的 null 覆盖 REST 返回的 can_edit=false
      setActiveCheck((prev) => (prev ? { ...prev, ...p, can_edit: p.can_edit ?? prev.can_edit } : prev))
      setItems(p.items || [])
      const map: Record<number, { user_id: number; name: string; isSelf: boolean }[]> = {}
      const me = useAuthStore.getState().currentUser?.id
      for (const pr of (p.presence || [])) {
        if (pr.item_id == null) continue
        if (me != null && Number(pr.user_id) === Number(me)) continue  // 自己的不显示
        ;(map[pr.item_id] ||= []).push({ user_id: pr.user_id, name: pr.name || `user#${pr.user_id}`, isSelf: false })
      }
      setPresenceByItem(map)
      setSyncBanner(null)
    },
    onItemUpdated: (p) => {
      // 编辑态保护:正编辑的行不覆盖、不更新 version,强制走 409
      if (editingItemId === p.item_id) {
        setSyncBanner(`行 #${p.item_id} 刚被他人修改,保存时会提示对比`)
        return
      }
      setItems((prev) => {
        const idx = prev.findIndex((it: any) => it.id === p.item_id)
        if (idx === -1) return prev
        const next = [...prev]
        next[idx] = { ...next[idx], ...p.item, version: p.version }
        return next
      })
      setActiveCheck((prev) =>
        prev
          ? {
              ...prev,
              checked_materials: p.head_aggregates.checked_materials,
              total_materials: p.head_aggregates.total_materials,
              total_diff_qty: p.head_aggregates.total_diff_qty,
            }
          : prev,
      )
    },
    onStatusChanged: (p) => {
      setActiveCheck((prev) => (prev ? { ...prev, status: p.status, version: p.head_version } : prev))
      if (p.status === 'completed' || p.status === 'cancelled') {
        setSyncBanner(`该盘点单已被 ${p.checked_by || '他人'} ${p.status === 'completed' ? '完成' : '取消'}`)
      }
    },
    onCoCheckersChanged: (p) => {
      setActiveCheck((prev) =>
        prev
          ? {
              ...prev,
              version: p.head_version,
              co_checker_user_ids: p.co_checker_user_ids,
              co_checkers: p.co_checkers,
            }
          : prev,
      )
      const me = useAuthStore.getState().currentUser?.id
      const isCreator = activeCheck?.created_by_user_id === me
      if (me && !isCreator && !(p.co_checker_user_ids || []).includes(Number(me))) {
        setSyncBanner('你已被移出共同盘点,刷新后只读')
      }
    },
    onBomRefreshed: () => {
      if (activeCheck?.id) loadCheck(activeCheck.id)
      setSyncBanner('BOM 已被刷新,行已重载')
    },
    onWarehousesRefreshed: () => {
      if (activeCheck?.id) loadCheck(activeCheck.id)
      setSyncBanner('仓库已被刷新,行已重载')
    },
    onPresence: (p) => {
      const me = useAuthStore.getState().currentUser?.id
      if (me != null && Number(p.user_id) === Number(me)) return  // 自己的不显示
      console.log('[presence-debug] onPresence 处理:', { payload: p, me })
      setPresenceByItem((prev) => {
        const next: Record<number, { user_id: number; name: string; isSelf: boolean }[]> = {}
        for (const k of Object.keys(prev)) next[Number(k)] = prev[Number(k)].filter((x) => x.user_id !== p.user_id)
        if (p.item_id != null) {
          ;(next[p.item_id] ||= []).push({ user_id: p.user_id, name: p.name || `user#${p.user_id}`, isSelf: false })
        }
        for (const k of Object.keys(next)) if (next[Number(k)].length === 0) delete next[Number(k)]
        return next
      })
    },
  })

  // 存在感:聚焦即声明编辑某行(立即广播 + 心跳续命);离开停心跳并延迟清除 presence。
  // 用 150ms 防抖避免 Ant InputNumber blur/focus 时序抖动导致误清:
  // 若 blur 后 150ms 内又 focus 回同一行,取消清除。
  // 注意: blur 必须走 InputNumber 的 onBlur props(React 管理监听器生命周期),
  // 不要用 ref + addEventListener 挂原生监听 —— 内联 ref 每次渲染都重挂且不清理,
  // 监听器会无限累积,一次 blur 触发 N 次清除请求。
  const clearPresenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleEditingFocus = useCallback((itemId: number) => {
    // 取消待发的 clear presence
    if (clearPresenceTimer.current) { clearTimeout(clearPresenceTimer.current); clearPresenceTimer.current = null }
    setEditingItemId(itemId)
    const cid = activeCheck?.id
    if (!cid) return
    console.log('[presence-debug] focus → POST presence', { cid, itemId })
    materialApi.updateStockCheckPresence(cid, itemId)
      .then(() => console.log('[presence-debug] POST presence 成功', itemId))
      .catch((e) => console.log('[presence-debug] POST presence 失败', itemId, e?.response?.status, e?.response?.data))
    if (presenceHeartbeat.current) clearInterval(presenceHeartbeat.current)
    presenceHeartbeat.current = setInterval(
      () => materialApi.updateStockCheckPresence(cid, itemId).catch(() => {}),
      30000,
    )
  }, [activeCheck?.id])

  const handleEditingBlur = useCallback(() => {
    console.log('[presence-debug] blur → 停心跳 + 延迟清 presence')
    setEditingItemId(null)
    if (presenceHeartbeat.current) { clearInterval(presenceHeartbeat.current); presenceHeartbeat.current = null }
    const cid = activeCheck?.id
    if (!cid) return
    // 防抖: 先取消旧定时器再挂新的,保证连续 blur 只发一次清除
    if (clearPresenceTimer.current) { clearTimeout(clearPresenceTimer.current); clearPresenceTimer.current = null }
    clearPresenceTimer.current = setTimeout(() => {
      clearPresenceTimer.current = null
      console.log('[presence-debug] blur 防抖到期 → POST presence null')
      materialApi.updateStockCheckPresence(cid, null)
        .then(() => console.log('[presence-debug] POST presence null 成功'))
        .catch((e) => console.log('[presence-debug] POST presence null 失败', e?.response?.status))
    }, 150)
  }, [activeCheck?.id])

  // 卸载时清理心跳 + 清除计时器
  useEffect(() => {
    return () => {
      if (presenceHeartbeat.current) clearInterval(presenceHeartbeat.current)
      if (clearPresenceTimer.current) clearTimeout(clearPresenceTimer.current)
    }
  }, [])

  const STATUS_OPTIONS = [
    { text: '待盘点', value: 'open' },
    { text: '进行中', value: 'in_progress' },
    { text: '已完成', value: 'completed' },
    { text: '已取消', value: 'cancelled' },
  ]
  const MY_STATUS_OPTIONS = [
    { text: '待盘点', value: 'open' },
    { text: '进行中', value: 'in_progress' },
    { text: '已完成', value: 'completed' },
  ]

  const {
    tableProps: recentTableProps,
    searchInput: recentSearchInput,
    reload: reloadRecentList,
    filters: recentFilters,
  } = useAntTableQuery({
    initialFilters: { status: ['open', 'in_progress', 'completed'] },
    fetchData: async (params) => {
      if (listTab !== 'all') return { items: [], total: 0 }
      const res: any = await materialApi.getRecentStockChecks({
        page: params.page,
        page_size: params.page_size,
        keyword: params.keyword,
        sort_by: params.sort_by,
        sort_order: params.sort_order,
        status: params.status,
        check_type: checkTypeFilter === 'all' ? undefined : checkTypeFilter,
        source: params.source,
        date_from: params.date_from,
        date_to: params.date_to,
      })
      return { items: res.data?.items || [], total: res.data?.total || 0 }
    },
    filterToQuery: (filters) => ({
      status: (filters.status as string[] | undefined)?.join(','),
      source: (filters.source as string[] | undefined)?.[0],
      date_from: dateFrom,
      date_to: dateTo,
    }),
    extraDeps: [listTab, dateFrom, dateTo, checkTypeFilter],
  })

  const {
    tableProps: myItemsTableProps,
    searchInput: myItemsSearchInput,
    reload: reloadMyItems,
    filters: myItemsFilters,
  } = useAntTableQuery({
    fetchData: async (params) => {
      if (listTab !== 'my') return { items: [], total: 0 }
      try {
        const res: any = await materialApi.getMyStockCheckItems({
          page: params.page,
          page_size: params.page_size,
          keyword: params.keyword,
          sort_by: params.sort_by,
          sort_order: params.sort_order,
          date_from: dateFrom,
          date_to: dateTo,
          wh_id: params.wh_id,
          check_type: checkTypeFilter === 'all' ? undefined : checkTypeFilter,
          check_no: params.check_no,
          order_no: params.order_no,
          material_code: params.material_code,
          material_name: params.material_name,
          spec_model: params.spec_model,
          status: params.status,
        })
        return { items: res.data?.items || [], total: res.data?.total || 0 }
      } catch (e: any) {
        message.error(e?.response?.data?.detail || e.message || '加载我的盘点台账失败')
        throw e
      }
    },
    filterToQuery: (filters) => {
      const first = (k: string) => (filters[k] as string[] | undefined)?.[0]
      const wh = first('wh_name')
      return {
        status: (filters.status as string[] | undefined)?.join(','),
        check_no: first('check_no'),
        order_no: first('order_no'),
        material_code: first('material_code'),
        material_name: first('material_name'),
        spec_model: first('spec_model'),
        wh_id: wh,
      }
    },
    extraDeps: [listTab, dateFrom, dateTo, checkTypeFilter],
  })

  const statsFilters = useMemo(() => ({
    check_type: checkTypeFilter === 'all' ? undefined : checkTypeFilter,
    date_from: dateFrom,
    date_to: dateTo,
    status: (recentFilters.status as string[] | undefined)?.join(','),
  }), [checkTypeFilter, dateFrom, dateTo, recentFilters.status])

  const loadOrderOverview = useCallback(async (no: string) => {
    setOverviewLoading(true)
    try {
      const [prodRes, checkRes] = await Promise.all([
        orderApi.getProductMaterials(no).catch(() => null),
        materialApi.getStockChecksByOrder(no).catch(() => null),
      ])
      setOrderProducts((prodRes as any)?.data || [])
      setOrderChecks((checkRes as any)?.data || [])
    } finally {
      setOverviewLoading(false)
    }
  }, [])

  const handleCreate = useCallback(async (no: string, selected?: OrderProductSelection[]) => {
    setLoading(true)
    try {
      const res: any = await materialApi.createStockCheckFromOrder(
        no,
        selected && selected.length ? { selected_products: selected } : {},
      )
      const c: StockCheck = res.data
      message.success(`已创建盘点单 ${c.check_no}`)
      setActiveCheck(c)
      setItems(c.items || [])
      setOrderNo(no)
      setCheckIdParam(null)
      setParams({ orderNo: no })
      setOrderPickerOpen(false)
      reloadRecentList()
      loadOrderOverview(no)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '创建盘点单失败')
    } finally {
      setLoading(false)
    }
  }, [reloadRecentList, setParams, loadOrderOverview])

  const handleCreateFromMaterials = useCallback(async (selected: MaterialCandidate[], source: 'search' | 'pool') => {
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
      })
      const c: StockCheck = res.data
      message.success(`已创建手动盘点单 ${c.check_no}`)
      if (source === 'pool') {
        poolRemove(selected.map((s) => ({ erp_material_id: s.erp_material_id, wh_id: s.wh_id })))
      }
      setPickerOpen(false)
      setActiveCheck(c)
      setItems(c.items || [])
      setOrderNo('')
      setCheckIdParam(c.id)
      setParams({ checkId: String(c.id) })
      reloadRecentList()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '创建盘点单失败')
    } finally {
      setCreating(false)
    }
  }, [reloadRecentList, setParams, poolRemove])

  const handleAddItemsToCheck = useCallback(async (selected: MaterialCandidate[], source: 'search' | 'pool') => {
    if (!activeCheck?.id) return
    setCreating(true)
    try {
      const items = selected
        .filter((s) => s.wh_id !== undefined)
        .map((s) => ({ material_id: s.erp_material_id, wh_id: s.wh_id ?? null }))
      const legacyIds = selected.filter((s) => s.wh_id === undefined).map((s) => s.erp_material_id)
      await materialApi.addStockCheckItems(activeCheck.id, {
        ...(items.length ? { items } : {}),
        ...(legacyIds.length ? { material_ids: legacyIds } : {}),
      })
      message.success(`已添加 ${selected.length} 条物料`)
      setAddPickerOpen(false)
      await loadCheck(activeCheck.id)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '添加物料失败')
    } finally {
      setCreating(false)
    }
  }, [activeCheck?.id, loadCheck])

  const handleRemoveItem = useCallback(async (item: StockCheckItem) => {
    try {
      await materialApi.removeStockCheckItem(item.id)
      message.success('已移除该明细')
      await loadCheck(activeCheck?.id as number)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '移除失败')
    }
  }, [activeCheck?.id, loadCheck])

  const handleSearch = useCallback(() => {
    if (searchText.trim()) {
      setParams({ orderNo: searchText.trim() })
      setOrderNo(searchText.trim())
    } else {
      setParams({})
      setOrderNo('')
      setActiveCheck(null)
      setItems([])
    }
  }, [searchText, setParams])

  // 概览(BOM 树 + 该订单盘点单)的触发：搜索态用 orderNo，查看盘点单态用 activeCheck.order_no
  const overviewOrderNo = activeCheck?.order_no || orderNo || ''
  useEffect(() => {
    if (!overviewOrderNo) {
      setOrderProducts([])
      setOrderChecks([])
      return
    }
    loadOrderOverview(overviewOrderNo)
  }, [overviewOrderNo, loadOrderOverview])

  useEffect(() => {
    if (checkIdParam) {
      if (!activeCheck || activeCheck.id !== checkIdParam) {
        loadCheck(checkIdParam)
      }
      return
    }
    if (orderNo && !activeCheck) {
      materialApi.getStockChecksByOrder(orderNo).then((res: any) => {
        const list: StockCheck[] = res.data || []
        const ongoing = list.find(c => c.status === 'in_progress' || c.status === 'open')
        if (ongoing) {
          loadCheck(ongoing.id)
        }
      }).catch(() => { /* silent */ })
    }
  }, [orderNo, checkIdParam, activeCheck, loadCheck])

  const productKey = (p: { product_code?: string | null; bom_no?: string | null }) =>
    `${p.product_code ?? ''}__${p.bom_no ?? ''}`

  // 已盘点产品 → 覆盖它的(非取消)盘点单信息
  const productCoverage = useMemo(() => {
    const map = new Map<string, { check_no: string; status: string; check_date?: string | null }>()
    for (const c of orderChecks) {
      if (!c.covered_products || c.status === 'cancelled') continue
      for (const p of c.covered_products) {
        const k = productKey(p)
        if (!map.has(k)) map.set(k, { check_no: c.check_no, status: c.status || 'open', check_date: c.check_date })
      }
    }
    return map
  }, [orderChecks])

  const coveredKeySet = useMemo(() => new Set(productCoverage.keys()), [productCoverage])

  const newbieMode = useUiPreferencesStore(s => s.preferences?.newbie_mode !== false)
  const isManualDetail = activeCheck?.check_type === 'manual'
  const tourId = activeCheck
    ? (isManualDetail ? STOCK_CHECK_MANUAL_DETAIL_TOUR_ID : STOCK_CHECK_DETAIL_TOUR_ID)
    : STOCK_CHECK_INTRO_TOUR_ID
  const tourSteps = (activeCheck
    ? (isManualDetail ? stockCheckManualDetailSteps! : stockCheckDetailSteps!)
    : stockCheckIntroSteps!) ?? []
  const seenTour = useUiPreferencesStore(s => s.preferences?.['tours_seen']?.[tourId])
  const setUiFlag = useUiPreferencesStore(s => s.setFlag)
  const [tourOpen, setTourOpen] = useState(false)

  useEffect(() => {
    if (!newbieMode) return
    if (seenTour) return
    const t = setTimeout(() => setTourOpen(true), 500)
    return () => clearTimeout(t)
  }, [newbieMode, seenTour, tourId])

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

  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false)
  const [historyMaterial, setHistoryMaterial] = useState<StockCheckItem | null>(null)
  const [historyItems, setHistoryItems] = useState<MaterialHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const openMaterialHistory = useCallback(async (r: StockCheckItem) => {
    if (!r.material_id) {
      message.warning('该物料无 ID,无法查询历史')
      return
    }
    setHistoryMaterial(r)
    setHistoryDrawerOpen(true)
    setHistoryLoading(true)
    try {
      const res: any = await materialApi.getMaterialHistory({ material_id: r.material_id })
      setHistoryItems(res.data || [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '加载历史盘点失败')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const saveItem = useCallback(async (item: StockCheckItem) => {
    try {
      const res: any = await materialApi.updateStockCheckItem(item.id, {
        actual_qty: item.actual_qty != null ? Number(item.actual_qty) : null,
        is_checked: item.is_checked ?? 0,
        remark: item.remark ?? undefined,
        force_recount: item.force_recount || undefined,
        expected_version: item.version ?? undefined,
      })
      const updated: StockCheckItem = res.data
      setItems(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated, version: updated.version, force_recount: undefined } : p))
      const headRes: any = await materialApi.getStockCheck(updated.check_id)
      setActiveCheck(prev => prev ? { ...prev, ...headRes.data } : headRes.data)
    } catch (e: any) {
      const code = e?.response?.data?.detail?.code ?? e?.response?.data?.code
      if (code === 409) {
        const detail = e?.response?.data?.detail?.data ?? e?.response?.data?.data ?? {}
        setConflict({
          myDraft: {
            item_id: item.id,
            material_code: item.material_code,
            material_name: item.material_name,
            actual_qty: item.actual_qty,
            is_checked: item.is_checked,
            remark: item.remark,
          },
          serverVersion: detail.server_version,
          itemId: item.id,
          serverItem: detail.server_item ?? null,
          serverChangedBy: detail.server_item?.counted_by ?? detail.server_item?.checked_by ?? null,
        })
      } else {
        message.error(e?.response?.data?.detail || e?.response?.data?.message || e.message || '保存失败')
      }
    }
  }, [])

  const handleConflictOverwrite = async () => {
    if (!conflict) return
    // 先按 itemId 重拉最新行,再用新 version + 用户的草稿重试一次
    if (activeCheck?.id) {
      await loadCheck(activeCheck.id)
    }
    setConflict(null)
  }

  const handleConflictDiscard = () => {
    setConflict(null)
    if (activeCheck?.id) loadCheck(activeCheck.id)
  }

  const saveAll = useCallback(async () => {
    if (!activeCheck) return
    setSavingAll(true)
    try {
      await materialApi.batchUpdateStockCheckItems(
        activeCheck.id,
        items.map(it => ({
          id: it.id,
          actual_qty: it.actual_qty != null ? Number(it.actual_qty) : null,
          is_checked: it.is_checked ?? 0,
          remark: it.remark ?? undefined,
          force_recount: it.force_recount || undefined,
        })),
      )
      message.success('已批量保存')
      setItems(prev => prev.map(p => ({ ...p, force_recount: undefined })))
      await loadCheck(activeCheck.id)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '批量保存失败')
    } finally {
      setSavingAll(false)
    }
  }, [activeCheck, items, loadCheck])

  const handleComplete = useCallback(async () => {
    if (!activeCheck) return
    const incomplete = items.filter(it => it.actual_qty == null)
    if (incomplete.length > 0) {
      message.error(`还有 ${incomplete.length} 行未录入实盘数,请先填写后再标记完成`)
      return
    }
    Modal.confirm({
      title: '标记完成',
      content: '完结后所有行将不可再修改,确认继续?',
      onOk: async () => {
        try {
          const res: any = await materialApi.completeStockCheck(activeCheck.id, activeCheck.version ?? undefined)
          setActiveCheck(res.data)
          setItems(res.data.items || [])
          message.success('已完结')
          if (orderNo) loadOrderOverview(orderNo)
        } catch (e: any) {
          const code = e?.response?.data?.detail?.code ?? e?.response?.data?.code
          if (code === 409) {
            message.warning('盘点单状态刚被他人修改,正在刷新')
            loadCheck(activeCheck.id)
          } else {
            message.error(e?.response?.data?.detail || e.message || '完结失败')
          }
        }
      },
    })
  }, [activeCheck, items, orderNo, loadOrderOverview, loadCheck])

  const handleCancel = useCallback(async () => {
    if (!activeCheck) return
    Modal.confirm({
      title: '取消盘点单',
      content: '确认取消该盘点单?',
      okType: 'danger',
      onOk: async () => {
        try {
          const res: any = await materialApi.cancelStockCheck(activeCheck.id, activeCheck.version ?? undefined)
          setActiveCheck(res.data)
          message.success('已取消')
          if (orderNo) loadOrderOverview(orderNo)
        } catch (e: any) {
          const code = e?.response?.data?.detail?.code ?? e?.response?.data?.code
          if (code === 409) {
            message.warning('盘点单状态刚被他人修改,正在刷新')
            loadCheck(activeCheck.id)
          } else {
            message.error(e?.response?.data?.detail || e.message || '取消失败')
          }
        }
      },
    })
  }, [activeCheck, orderNo, loadOrderOverview, loadCheck])

  const goBack = useCallback(() => {
    setActiveCheck(null)
    setItems([])
    setCheckIdParam(null)
    setSearchText('')
    setOrderNo('')
    setParams({})
  }, [setParams])

  const openCoPicker = useCallback(() => {
    setCoPickerIds(activeCheck?.co_checker_user_ids || [])
    setCoPickerOpen(true)
  }, [activeCheck])

  const handleRefreshBom = useCallback(async () => {
    if (!activeCheck) return
    Modal.confirm({
      title: '补入缺失的子BOM物料',
      content: '将按当前订单的最新BOM重新展开，把之前未纳入的子BOM物料补入此盘点单（已有明细及已录入数据保留）。是否继续？',
      okText: '刷新',
      cancelText: '取消',
      onOk: async () => {
        try {
          await materialApi.refreshStockCheckBom(activeCheck.id)
          await loadCheck(activeCheck.id)
          message.success('已补入子BOM物料')
        } catch (e: any) {
          message.error(e?.response?.data?.detail || e.message || '刷新失败')
        }
      },
    })
  }, [activeCheck, loadCheck])

  const handleRefreshWarehouses = useCallback(async () => {
    if (!activeCheck) return
    Modal.confirm({
      title: '刷新"(未入库)"行为具体仓库',
      content: '将按当前即时库存，把本单中未录入数据的"(未入库)"行更新/拆分为具体仓库行：物料现处于多个仓库时拆为多行，各行快照库存取刷新时点数量。已录入数据的行不会被改动。是否继续？',
      okText: '刷新仓库',
      cancelText: '取消',
      onOk: async () => {
        try {
          const res: any = await materialApi.refreshStockCheckWarehouses(activeCheck.id)
          await loadCheck(activeCheck.id)
          const s = res?.data || {}
          message.success(`仓库已刷新：更新 ${s.updated ?? 0} 行、拆分新增 ${s.inserted ?? 0} 行`)
        } catch (e: any) {
          message.error(e?.response?.data?.detail || e.message || '刷新失败')
        }
      },
    })
  }, [activeCheck, loadCheck])

  const handleSaveCoCheckers = useCallback(async (ids: number[]) => {
    if (!activeCheck) return
    setCoSaving(true)
    try {
      await materialApi.updateStockCheckCoCheckers(activeCheck.id, ids, activeCheck.version ?? undefined)
      setCoPickerOpen(false)
      await loadCheck(activeCheck.id)
      message.success('已更新共同盘点人')
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '更新失败')
    } finally {
      setCoSaving(false)
    }
  }, [activeCheck, loadCheck])

  const updateItem = useCallback((id: number, patch: Partial<StockCheckItem>) => {
    setItems(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p))
  }, [])

  const handleExportClick = (format: 'xlsx' | 'csv') => {
    setExportFormat(format)
    setExportColumnModalOpen(true)
  }

  const handleExportColumnConfirm = (selectedColumns: string[]) => {
    setExportColumnModalOpen(false)
    if (!activeCheck) return
    const ext = exportFormat === 'csv' ? 'csv' : 'xlsx'
    exportData(
      `/api/v1/materials/stock-check/${activeCheck.id}/export`,
      { format: exportFormat, columns: selectedColumns.join(',') },
      `物料盘点明细_${activeCheck.check_no}.${ext}`,
    )
  }

  const readonly = activeCheck?.status === 'completed' || activeCheck?.status === 'cancelled' || activeCheck?.can_edit === false

  // 表格表头支持拖动改变列宽
  const DraggableResizableHeader = (props: any) => {
    const { onResize, width, ...restProps } = props
    if (!width) return <th {...restProps} />
    return (
      <th {...restProps} style={{ ...restProps.style, position: 'relative' }}>
        {restProps.children}
        <span
          onMouseDown={(e: React.MouseEvent) => {
            e.preventDefault()
            e.stopPropagation()
            const startX = e.clientX
            const startW = width
            const onMove = (ev: MouseEvent) => {
              const newW = Math.max(40, startW + (ev.clientX - startX))
              onResize?.(null, { size: { width: newW } } as any)
            }
            const onUp = () => {
              window.removeEventListener('mousemove', onMove)
              window.removeEventListener('mouseup', onUp)
            }
            window.addEventListener('mousemove', onMove)
            window.addEventListener('mouseup', onUp)
          }}
          style={{
            position: 'absolute', right: 0, top: 0, bottom: 0, width: 6,
            cursor: 'col-resize', userSelect: 'none',
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </th>
    )
  }

  const tableComponents = { header: { cell: DraggableResizableHeader } }

  const columns = useMemo(() => {
    const makeStringFilters = (key: keyof StockCheckItem) => {
      const set = new Set<string>()
      items.forEach(it => {
        const v = it[key]
        if (v != null && String(v).trim() !== '') set.add(String(v))
      })
      return Array.from(set).sort().map(v => ({ text: v, value: v }))
    }
    const stringCol = (
      key: keyof StockCheckItem,
      width: number,
      extra: Record<string, any> = {},
    ) => ({
      sorter: (a: any, b: any) => String(a[key] || '').localeCompare(String(b[key] || '')),
      filters: makeStringFilters(key),
      onFilter: (value: any, record: any) => record[key] === value,
      filterDropdown: (props: any) => <SearchableColumnFilter {...props} filters={makeStringFilters(key)} columnKey={String(key)} />,
      ...extra,
    })
    const numCol = (key: keyof StockCheckItem) => ({
      sorter: (a: any, b: any) => (Number(a[key]) || 0) - (Number(b[key]) || 0),
    })

    const resizeCol = (key: string, staticWidth?: number) => ({
      onHeaderCell: () => ({
        width: colWidths[key] ?? staticWidth,
        onResize: (_: any, { size }: { size: { width: number } }) =>
          setColWidths((prev) => ({ ...prev, [key]: size.width })),
      }),
    })

    return [
      { title: '物料编码', dataIndex: 'material_code', width: 140, fixed: 'left' as const, ...stringCol('material_code', 140), ...resizeCol('material_code', 140) },
      { title: '物料名称', dataIndex: 'material_name', width: 200, ellipsis: true, ...stringCol('material_name', 200), ...resizeCol('material_name', 200) },
      { title: '规格', dataIndex: 'spec_model', width: 140, ellipsis: true, ...stringCol('spec_model', 140), ...resizeCol('spec_model', 140) },
      { title: '分类', dataIndex: 'material_type', width: 110, ellipsis: true, ...stringCol('material_type', 110), ...resizeCol('material_type', 110) },
      { title: '属性', dataIndex: 'material_property_label', width: 90, ...stringCol('material_property_label', 90), ...resizeCol('material_property_label', 90) },
      { title: '单位', dataIndex: 'unit', width: 60, ...stringCol('unit', 60), ...resizeCol('unit', 60) },
      {
        title: '快照库存', dataIndex: 'system_qty', width: 130, align: 'right' as const,
        ...numCol('system_qty'),
        render: (v: any, r: StockCheckItem) => {
          if (r.snapshot_live) {
            return (
              <div style={{ lineHeight: 1.2 }}>
                <div style={{ color: '#1677ff', fontWeight: 500 }}>{v != null ? Number(v).toFixed(2) : '-'}</div>
                <Tag color="blue" style={{ margin: '2px 0 0', fontSize: 11, lineHeight: '16px' }}>实时</Tag>
              </div>
            )
          }
          const snapTime = r.system_qty_time || activeCheck?.created_at
          return (
            <div style={{ lineHeight: 1.2 }}>
              <div>{v != null ? Number(v).toFixed(2) : '-'}</div>
              {snapTime && (
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{formatDateTime(snapTime)}</div>
              )}
            </div>
          )
        },
        ...resizeCol('system_qty', 130),
      },
      {
        title: '即时库存', dataIndex: 'live_qty', width: 90, align: 'right' as const,
        ...numCol('live_qty'),
        render: (v: any) => v != null ? Number(v).toFixed(2) : '-',
        ...resizeCol('live_qty', 90),
      },
      {
        title: '仓库',
        dataIndex: 'wh_name',
        width: 160,
        ellipsis: true,
        ...stringCol('warehouse_display', 160),
        ...resizeCol('wh_name', 160),
        render: (v: any, r: StockCheckItem) => {
          if (r.wh_id == null && r.live_wh_names) {
            return (
              <Tooltip title={`建单时未入库，现已入库：${r.live_wh_names}`}>
                <span style={{ color: '#1677ff' }}>{r.live_wh_names}</span>
              </Tooltip>
            )
          }
          return v || '—'
        },
      },
      {
        title: '盘点数', dataIndex: 'actual_qty', width: 220, align: 'right' as const,
        ...numCol('actual_qty'),
        render: (_: any, r: StockCheckItem) => {
          const recentMark = !!r.recent_checked_check_no
          // 近期已盘免盘行(带标记未重盘,含旧预填行): 只显示标签+重盘入口,不显示输入框
          const recentPending = recentMark
          return (
            <Space size={4} style={{ width: '100%', justifyContent: 'flex-end' }}>
              {!recentPending && (
                <InputNumber
                  size="small"
                  min={0}
                  step={0.01}
                  style={{ width: 100 }}
                  disabled={readonly || recentMark}
                  value={r.actual_qty != null ? Number(r.actual_qty) : null}
                  onFocus={() => handleEditingFocus(r.id)}
                  onBlur={handleEditingBlur}
                  onChange={(v) => {
                    const actual = v == null ? null : Number(v)
                    const diff = actual != null && r.system_qty != null ? actual - Number(r.system_qty) : null
                    updateItem(r.id, { actual_qty: actual, diff_qty: diff, is_checked: actual != null ? 1 : 0 })
                  }}
                />
              )}
              {recentMark && (
                <Tooltip title={`近期已盘 ${r.recent_checked_check_no}${r.recent_checked_date ? ` · ${r.recent_checked_date}` : ''}，免盘`}>
                  <Tag color="default">近期已盘</Tag>
                </Tooltip>
              )}
              {recentPending && !readonly && (
                <Button
                  type="link" size="small" style={{ padding: 0, height: 'auto' }}
                  onClick={() => {
                    materialApi.updateStockCheckItem(r.id, { force_recount: true }).then(async (res: any) => {
                      const updated: StockCheckItem = res.data
                      setItems(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated, force_recount: true } : p))
                      const headRes: any = await materialApi.getStockCheck(updated.check_id)
                      setActiveCheck(prev => prev ? { ...prev, ...headRes.data } : headRes.data)
                    }).catch((err: any) => {
                      message.error(err?.response?.data?.detail || err.message || '重盘失败')
                    })
                  }}
                >重盘</Button>
              )}
              {(presenceByItem[r.id] || []).length > 0 && (
                <Tooltip title={`${(presenceByItem[r.id] || []).map((x) => x.name).join('、')} 正在编辑此行`}>
                  <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                    {(presenceByItem[r.id] || []).map((x, i) => (
                      <span key={x.user_id} style={{ color: x.isSelf ? '#2563eb' : '#d97706', marginLeft: i > 0 ? 4 : 0 }}>
                        👤{x.name}
                      </span>
                    ))}
                  </span>
                </Tooltip>
              )}
            </Space>
          )
        },
        ...resizeCol('actual_qty', 220),
      },
      {
        title: <span data-tour="stock-check-diff">差异</span>, dataIndex: 'diff_qty', width: 90, align: 'right' as const,
        ...numCol('diff_qty'),
        render: (v: any) => {
          if (v == null) return '-'
          const n = Number(v)
          const color = n > 0 ? '#16a34a' : n < 0 ? '#dc2626' : '#64748b'
          return <span style={{ color, fontWeight: 500 }}>{n.toFixed(2)}</span>
        },
        ...resizeCol('diff_qty', 90),
      },
      {
        title: '已盘', dataIndex: 'is_checked', width: 70, align: 'center' as const,
        sorter: (a: any, b: any) => (Number(a.is_checked) || 0) - (Number(b.is_checked) || 0),
        filters: [
          { text: '已盘', value: 1 },
          { text: '未盘', value: 0 },
        ],
        onFilter: (value: any, record: any) => Number(record.is_checked) === Number(value),
        render: (_: any, r: StockCheckItem) => (
          <Checkbox
            disabled={readonly || r.actual_qty == null}
            checked={r.is_checked === 1}
            onChange={(e) => updateItem(r.id, { is_checked: e.target.checked ? 1 : 0 })}
          />
        ),
        ...resizeCol('is_checked', 70),
      },
      {
        title: '标记时间', dataIndex: 'checked_at', width: 160,
        sorter: (a: any, b: any) => {
          const ta = a.checked_at ? new Date(a.checked_at).getTime() : 0
          const tb = b.checked_at ? new Date(b.checked_at).getTime() : 0
          return ta - tb
        },
        render: (v: any) => v ? formatDateTime(v) : '-',
        ...resizeCol('checked_at', 160),
      },
      { title: '标记人', dataIndex: 'checked_by', width: 100, ...stringCol('checked_by', 100), ...resizeCol('checked_by', 100) },
      { title: '备注', dataIndex: 'remark', width: 160, ellipsis: true, ...stringCol('remark', 160), ...resizeCol('remark', 160) },
      {
        title: '操作', key: 'op', width: 200, fixed: 'right' as const,
        ...resizeCol('op', 200),
        render: (_: any, r: StockCheckItem) => {
          const canRemove = !readonly
            && activeCheck?.check_type === 'manual'
            && (activeCheck.status === 'in_progress' || activeCheck.status === 'open')
            && r.is_checked === 0
            && r.actual_qty == null
          return (
            <Space size="small">
              <Button type="link" size="small" icon={<SaveOutlined />}
                disabled={readonly}
                onClick={() => saveItem(r)}>保存</Button>
              <Tooltip title="查看该物料被哪些盘点单盘点过">
                <Button
                  type="link" size="small" icon={<HistoryOutlined />}
                  onClick={() => openMaterialHistory(r)}
                />
              </Tooltip>
              {canRemove && (
                <Tooltip title="移除该明细(已录入数据的行禁删)">
                  <Button type="link" size="small" danger icon={<DeleteOutlined />}
                    onClick={() => handleRemoveItem(r)}>删除</Button>
                </Tooltip>
              )}
            </Space>
          )
        },
      },
    ]
  }, [items, readonly, saveItem, updateItem, openMaterialHistory, colWidths, activeCheck, presenceByItem, handleRemoveItem])

  // ===== 按产品筛选盘点明细 =====
  // 切到不同盘点单时重置过滤器
  useEffect(() => { setProductFilter('all') }, [activeCheck?.id])

  // 从 BOM 树(orderProducts)构建 material_id -> 所属产品 key 集合
  const productMaterialMap = useMemo(() => {
    const map = new Map<number, Set<string>>()
    for (const p of orderProducts) {
      const pkey = productKey(p)
      const walk = (nodes: any[]) => {
        for (const n of nodes || []) {
          if (n.material_id != null) {
            const mid = Number(n.material_id)
            if (!map.has(mid)) map.set(mid, new Set())
            map.get(mid)!.add(pkey)
          }
          if (n.children) walk(n.children)
        }
      }
      walk(p.materials || [])
    }
    return map
  }, [orderProducts])

  const productOptions = useMemo(() => {
    if (activeCheck?.check_type !== 'order' || orderProducts.length === 0) return []
    return orderProducts.map((p) => ({
      value: productKey(p),
      label: p.product_code || '—',
    }))
  }, [activeCheck, orderProducts])

  const filteredItems = useMemo(() => {
    if (activeCheck?.check_type !== 'order') return items
    if (!productFilter || productFilter === 'all') return items
    return items.filter(
      (it) => it.material_id != null && productMaterialMap.get(it.material_id)?.has(productFilter),
    )
  }, [items, productFilter, productMaterialMap, activeCheck])

  const renderSearch = () => (
    <div className="card-modern" style={{ padding: 16, marginBottom: 16 }}>
      <Space wrap>
        <span data-tour="stock-check-search">
          <Input
            placeholder="输入订单号 (如 HJ2024-001)"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            onPressEnter={handleSearch}
            allowClear
            style={{ width: 280 }}
            prefix={<SearchOutlined />}
          />
        </span>
        <Button type="primary" onClick={handleSearch}>搜索订单</Button>
        <Button onClick={() => {
          setSearchText('')
          setOrderNo('')
          setCheckIdParam(null)
          setActiveCheck(null)
          setItems([])
          setParams({})
        }}>清空</Button>
        {orderNo && !activeCheck && (
          <span data-tour="stock-check-create">
            <Button type="primary" ghost onClick={() => setOrderPickerOpen(true)}>
              为 {orderNo} 创建盘点单
            </Button>
          </span>
        )}
        <span data-tour="stock-check-manual-create">
          <span data-tour="stock-check-pool-badge">
            <Badge count={poolCount} size="small" offset={[10, -2]} overflowCount={999}>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setPickerOpen(true)}>
                手动盘点 — 选择物料
              </Button>
            </Badge>
          </span>
        </span>
        <Button
          icon={<CloudDownloadOutlined />}
          onClick={() => setK3ModalOpen(true)}
        >从 K3 导入</Button>
        <Button
          type={statsOpen ? 'primary' : 'default'}
          icon={<BarChartOutlined />}
          onClick={() => setStatsOpen((v) => !v)}
        >统计图表</Button>
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
                <Checkbox checked={newbieMode} onChange={e => handleNewbieToggle(e.target.checked)}>
                  开启新手指引
                </Checkbox>
              </div>
            </div>
          }
        >
          <Button icon={<QuestionCircleOutlined />} shape="circle" title="新手指引" />
        </Popover>
      </Space>
    </div>
  )

  const renderProductProgress = () => {
    if (!orderNo || orderProducts.length === 0) return null
    const checkedCount = orderProducts.filter((p) => productCoverage.has(productKey(p))).length
    return (
      <div className="card-modern" style={{ padding: 16, marginBottom: 16 }}>
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setProgressCollapsed((v) => !v)}
        >
          <Space>
            {progressCollapsed ? <RightOutlined style={{ fontSize: 12, color: '#64748b' }} /> : <DownOutlined style={{ fontSize: 12, color: '#64748b' }} />}
            <h3 style={{ margin: 0 }}>产品盘点进度</h3>
            <span style={{ color: '#64748b' }}>已盘点 {checkedCount}/{orderProducts.length} 个产品</span>
          </Space>
        </div>
        {!progressCollapsed && (
          <Table
            rowKey={(r) => productKey(r)}
            dataSource={orderProducts}
            loading={overviewLoading}
            pagination={false}
            size="small"
            scroll={{ y: 260 }}
            style={{ marginTop: 12 }}
            columns={[
              { title: '行号', dataIndex: 'line_no', width: 80, render: (v: any) => v || '—' },
              { title: '产品编码', dataIndex: 'product_code', width: 150 },
              { title: '产品名称', dataIndex: 'product_name', ellipsis: true },
              { title: 'BOM号', dataIndex: 'bom_no', width: 130, render: (v: any) => v || '—' },
              { title: '订单数量', dataIndex: 'order_qty', width: 100, align: 'right' as const, render: (v: any) => (v != null ? v : '—') },
              {
                title: '盘点状态', width: 110,
                render: (_: any, r: OrderProductLine) => {
                  const cov = productCoverage.get(productKey(r))
                  if (!cov) return <Tag>未盘点</Tag>
                  const color = cov.status === 'completed' ? 'success' : 'processing'
                  const label = cov.status === 'completed' ? '已盘点' : '盘点中'
                  return (
                    <Tooltip title={`盘点单 ${cov.check_no}${cov.check_date ? ` · ${cov.check_date}` : ''}`}>
                      <Tag color={color}>{label}</Tag>
                    </Tooltip>
                  )
                },
              },
              {
                title: '盘点单号', width: 170,
                render: (_: any, r: OrderProductLine) => productCoverage.get(productKey(r))?.check_no || '—',
              },
            ]}
          />
        )}
      </div>
    )
  }

  return (
    <div>
      {renderSearch()}
      {statsOpen && !activeCheck && <StatsCharts filters={statsFilters} />}
      {renderProductProgress()}
      {!activeCheck ? (
        <div className="card-modern" style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <Space>
              <Tabs
                activeKey={listTab}
                onChange={(key) => setListTab(key as 'all' | 'my' | 'counted')}
                items={[
                  { key: 'all', label: '全部盘点单' },
                  { key: 'my', label: '我的盘点台账' },
                  { key: 'counted', label: '已盘点物料台账' },
                ]}
                tabBarStyle={{ margin: 0 }}
              />
              {listTab !== 'counted' && (
                <span data-tour="stock-check-type-filter">
                  <Segmented
                    value={checkTypeFilter}
                    onChange={(v) => setCheckTypeFilter(v as string)}
                    options={[
                      { label: '全部', value: 'all' },
                      { label: '订单盘点', value: 'order' },
                      { label: '手动盘点', value: 'manual' },
                    ]}
                  />
                </span>
              )}
            </Space>
            <Space wrap>
              {listTab === 'counted' ? null : (
                <>
                  {listTab === 'all' ? recentSearchInput : myItemsSearchInput}
                  <DatePicker.RangePicker
                    onChange={(d) => {
                      setDateFrom(d?.[0]?.format('YYYY-MM-DD'))
                      setDateTo(d?.[1]?.format('YYYY-MM-DD'))
                    }}
                  />
                  <Button
                    icon={<ReloadOutlined />}
                    onClick={listTab === 'all' ? reloadRecentList : reloadMyItems}
                  >刷新</Button>
                </>
              )}
            </Space>
          </div>
          {listTab === 'all' ? (
            <Table
              rowKey="id"
              dataSource={recentTableProps.dataSource}
              loading={recentTableProps.loading}
              pagination={recentTableProps.pagination}
              onChange={recentTableProps.onChange}
              scroll={{ x: 1500 }}
              columns={[
                { title: '盘点单号', dataIndex: 'check_no', width: 180, sorter: true },
                {
                  title: '类型', dataIndex: 'check_type', width: 90,
                  render: (v: any) => v === 'manual'
                    ? <Tag color="purple">手动</Tag>
                    : <Tag color="blue">订单</Tag>,
                },
                { title: '订单号', dataIndex: 'order_no', width: 180, sorter: true, render: (v: any) => v || '—' },
                {
                  title: '标题', dataIndex: 'title', ellipsis: true,
                  render: (v: any, r: any) => (
                    <Space size={4}>
                      {r.source === 'k3' && <Tag color="geekblue">K3</Tag>}
                      {v || '-'}
                    </Space>
                  ),
                },
                {
                  title: '状态', dataIndex: 'status', width: 100,
                  filters: STATUS_OPTIONS,
                  filteredValue: (recentFilters.status as string[] | undefined) ?? null,
                  filterMultiple: true,
                  render: (v: any) => <Tag color={STATUS_MAP[v]?.color || 'default'}>{STATUS_MAP[v]?.label || v}</Tag>,
                },
                {
                  title: '来源', dataIndex: 'source', width: 90,
                  filters: [
                    { text: 'K3导入', value: 'k3' },
                    { text: '本系统', value: 'manual' },
                  ],
                  filteredValue: (recentFilters.source as string[] | undefined) ?? null,
                  filterMultiple: false,
                  render: (v: any) => v === 'k3'
                    ? <Tag color="geekblue">K3</Tag>
                    : v === 'manual'
                      ? <Tag>本系统</Tag>
                      : '-',
                },
                { title: '盘点日期', dataIndex: 'check_date', width: 120, sorter: true },
                { title: '应盘', dataIndex: 'total_materials', width: 70, align: 'right' as const, sorter: true },
                { title: '已盘', dataIndex: 'checked_materials', width: 70, align: 'right' as const, sorter: true },
                {
                  title: '总差异', dataIndex: 'total_diff_qty', width: 100, align: 'right' as const, sorter: true,
                  render: (v: any) => v != null ? Number(v).toFixed(2) : '-',
                },
                { title: '创建人', dataIndex: 'created_by', width: 100 },
                { title: '创建时间', dataIndex: 'created_at', width: 160, sorter: true, render: (v: any) => v ? formatDateTime(v) : '-' },
                {
                  title: '操作', key: 'op', width: 100, fixed: 'right' as const,
                  render: (_: any, r: StockCheck) => (
                    <Button type="link" size="small" onClick={() => {
                      setCheckIdParam(r.id)
                      setOrderNo('')
                      setParams({ checkId: String(r.id) })
                      loadCheck(r.id)
                    }}>详情</Button>
                  ),
                },
              ]}
            />
          ) : listTab === 'my' ? (
            <Table
              rowKey="item_id"
              dataSource={myItemsTableProps.dataSource}
              loading={myItemsTableProps.loading}
              pagination={myItemsTableProps.pagination}
              onChange={myItemsTableProps.onChange}
              scroll={{ x: 1600 }}
              columns={[
                { title: '盘点时间', dataIndex: 'counted_at', width: 170, sorter: true, render: (v: any) => v ? formatDateTime(v) : '-' },
                {
                  title: '盘点单号', dataIndex: 'check_no', key: 'check_no', width: 180, sorter: true,
                  filterDropdown: textColumnFilter({ placeholder: '输入盘点单号' }),
                  filterIcon: textFilterIcon,
                  filteredValue: (myItemsFilters.check_no as string[] | undefined) ?? null,
                },
                {
                  title: '订单号', dataIndex: 'order_no', key: 'order_no', width: 180, sorter: true,
                  render: (v: any) => v || '-',
                  filterDropdown: textColumnFilter({ placeholder: '输入订单号' }),
                  filterIcon: textFilterIcon,
                  filteredValue: (myItemsFilters.order_no as string[] | undefined) ?? null,
                },
                {
                  title: '物料编码', dataIndex: 'material_code', key: 'material_code', width: 150, sorter: true,
                  filterDropdown: textColumnFilter({ placeholder: '输入物料编码' }),
                  filterIcon: textFilterIcon,
                  filteredValue: (myItemsFilters.material_code as string[] | undefined) ?? null,
                },
                {
                  title: '物料名称', dataIndex: 'material_name', key: 'material_name', width: 200, sorter: true, ellipsis: true,
                  filterDropdown: textColumnFilter({ placeholder: '输入物料名称' }),
                  filterIcon: textFilterIcon,
                  filteredValue: (myItemsFilters.material_name as string[] | undefined) ?? null,
                },
                {
                  title: '规格', dataIndex: 'spec_model', key: 'spec_model', width: 150, sorter: true, ellipsis: true, render: (v: any) => v || '-',
                  filterDropdown: textColumnFilter({ placeholder: '输入规格型号' }),
                  filterIcon: textFilterIcon,
                  filteredValue: (myItemsFilters.spec_model as string[] | undefined) ?? null,
                },
                { title: '单位', dataIndex: 'unit', width: 70, render: (v: any) => v || '-' },
                {
                  title: '仓库', dataIndex: 'wh_name', key: 'wh_name', width: 160, sorter: true, ellipsis: true,
                  render: (v: any, r: MyStockCheckItem) => v || r.wh_code || '-',
                  filterDropdown: textColumnFilter({ placeholder: '输入仓库名称或ID' }),
                  filterIcon: textFilterIcon,
                  filteredValue: (myItemsFilters.wh_name as string[] | undefined) ?? null,
                },
                {
                  title: '库存快照', dataIndex: 'system_qty', width: 110, sorter: true, align: 'right' as const,
                  render: (v: any) => v != null ? Number(v).toFixed(2) : '-',
                },
                {
                  title: '实盘数量', dataIndex: 'actual_qty', width: 110, sorter: true, align: 'right' as const,
                  render: (v: any) => v != null ? Number(v).toFixed(2) : '-',
                },
                {
                  title: '差异', dataIndex: 'diff_qty', width: 100, sorter: true, align: 'right' as const,
                  render: (v: any) => {
                    if (v == null) return '-'
                    const n = Number(v)
                    const color = n > 0 ? '#16a34a' : n < 0 ? '#dc2626' : '#64748b'
                    return <span style={{ color, fontWeight: 500 }}>{n.toFixed(2)}</span>
                  },
                },
                {
                  title: '盘点单状态', dataIndex: 'status', key: 'status', width: 120, sorter: true,
                  filters: MY_STATUS_OPTIONS,
                  filterMultiple: true,
                  filteredValue: (myItemsFilters.status as string[] | undefined) ?? null,
                  render: (v: any) => <Tag color={STATUS_MAP[v]?.color || 'default'}>{STATUS_MAP[v]?.label || v}</Tag>,
                },
              ]}
            />
          ) : (
            <CountedLedgerPanel />
          )}
        </div>
      ) : (
        <div>
          <div className="card-modern" style={{ padding: 16, marginBottom: 16 }}>
            <Space style={{ marginBottom: 8 }}>
              <Tooltip title={syncLastEventAt ? `上次同步: ${new Date(syncLastEventAt).toLocaleTimeString()}` : '未收到事件'}>
                <Badge status={syncConnected ? 'success' : 'default'} text={syncConnected ? '已同步(实时)' : '已断开,重连中…'} />
              </Tooltip>
              {syncBanner && <Typography.Text type="warning">{syncBanner}</Typography.Text>}
            </Space>
            <Space style={{ marginBottom: 12 }} wrap>
              <Button icon={<ArrowLeftOutlined />} onClick={goBack}>返回</Button>
              <h2 style={{ margin: 0 }}>{activeCheck.check_no}</h2>
              <Tag color={STATUS_MAP[activeCheck.status || '']?.color || 'default'}>
                {STATUS_MAP[activeCheck.status || '']?.label || activeCheck.status}
              </Tag>
              {activeCheck.check_type === 'manual'
                ? <Tag color="purple">手动盘点</Tag>
                : <Tag color="blue">订单盘点</Tag>}
              {activeCheck.order_no
                ? <span style={{ color: '#64748b' }}>订单: {activeCheck.order_no}</span>
                : <span style={{ color: '#94a3b8' }}>订单: —</span>}
              <span style={{ color: '#64748b' }}>创建: {activeCheck.created_by} / {formatDateTime(activeCheck.created_at)}</span>
              {activeCheck.can_edit === false && <Tag color="orange">只读（无修改权限）</Tag>}
            </Space>
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              <span style={{ color: '#64748b' }}>共同盘点人:</span>
              {(activeCheck.co_checkers && activeCheck.co_checkers.length > 0)
                ? activeCheck.co_checkers.map((c) => <Tag key={c.user_id} color="blue">{c.name}</Tag>)
                : <span style={{ color: '#94a3b8' }}>未设置（仅创建人与管理员可改）</span>}
              {readonly ? null : (
                <Button type="link" size="small" onClick={openCoPicker}>管理</Button>
              )}
              {!readonly && activeCheck.check_type === 'order' && (activeCheck.status === 'in_progress' || activeCheck.status === 'open') && (
                <Button type="link" size="small" onClick={handleRefreshBom}>补入子BOM物料</Button>
              )}
              {!readonly && (activeCheck.status === 'in_progress' || activeCheck.status === 'open') && items.some((it) => it.wh_id == null) && (
                <Button type="link" size="small" onClick={handleRefreshWarehouses}>刷新仓库</Button>
              )}
              {!readonly && activeCheck.check_type === 'manual' && (activeCheck.status === 'in_progress' || activeCheck.status === 'open') && (
                <Button type="link" size="small" icon={<PlusOutlined />} onClick={() => setAddPickerOpen(true)}>添加物料</Button>
              )}
            </div>
            <Row gutter={12}>
              <Col span={4}><Card size="small" className="card-modern">
                <div style={{ color: '#64748b', fontSize: 12 }}>应盘</div>
                <div style={{ fontSize: 22, fontWeight: 600 }}>{activeCheck.total_materials || 0}</div>
              </Card></Col>
              <Col span={4}><Card size="small" className="card-modern">
                <div style={{ color: '#64748b', fontSize: 12 }}>已盘</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: '#16a34a' }}>{activeCheck.checked_materials || 0}</div>
              </Card></Col>
              <Col span={4}><Card size="small" className="card-modern">
                <div style={{ color: '#64748b', fontSize: 12 }}>未盘</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: '#dc2626' }}>
                  {(activeCheck.total_materials || 0) - (activeCheck.checked_materials || 0)}
                </div>
              </Card></Col>
              <Col span={6}><Card size="small" className="card-modern">
                <div style={{ color: '#64748b', fontSize: 12 }}>总差异 (实盘-库存)</div>
                <div style={{ fontSize: 22, fontWeight: 600 }}>
                  {activeCheck.total_diff_qty != null ? Number(activeCheck.total_diff_qty).toFixed(2) : '0.00'}
                </div>
              </Card></Col>
              <Col span={6} style={{ textAlign: 'right' }} data-tour="stock-check-actions">
                <Space wrap>
                  <Button icon={<SaveOutlined />} onClick={saveAll} loading={savingAll} disabled={readonly}>
                    保存全部
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
                  <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleComplete} disabled={readonly}>
                    标记完成
                  </Button>
                  <Button danger icon={<StopOutlined />} onClick={handleCancel} disabled={readonly}>
                    取消
                  </Button>
                </Space>
              </Col>
            </Row>
          </div>
          <div className="card-modern" style={{ padding: 4 }} data-tour="stock-check-table">
            {activeCheck.check_type === 'order' && productOptions.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', gap: 8, borderBottom: '1px solid #f0f0f0' }}>
                <span style={{ color: '#64748b', fontSize: 12 }}>按产品筛选:</span>
                <Select
                  value={productFilter}
                  onChange={setProductFilter}
                  style={{ minWidth: 220 }}
                  options={[{ value: 'all', label: '全部产品' }, ...productOptions]}
                />
                <span style={{ color: '#94a3b8', fontSize: 12 }}>
                  显示 {filteredItems.length} / {items.length} 行
                </span>
              </div>
            )}
            <Spin spinning={loading}>
              <Table
                rowKey="id"
                dataSource={filteredItems}
                columns={columns}
                pagination={false}
                scroll={{ x: 1600, y: 600 }}
                size="small"
                components={tableComponents}
              />
            </Spin>
          </div>
        </div>
      )}
      <Tour
        open={tourOpen}
        steps={tourSteps}
        onClose={handleTourClose}
        onFinish={handleTourClose}
      />
      <ExportColumnSelector
        open={exportColumnModalOpen}
        columns={STOCK_CHECK_EXPORT_OPTIONS}
        onConfirm={handleExportColumnConfirm}
        onCancel={() => setExportColumnModalOpen(false)}
      />
      <Drawer
        title={historyMaterial ? `物料 ${historyMaterial.material_code} 历史盘点记录` : '历史盘点记录'}
        open={historyDrawerOpen}
        onClose={() => setHistoryDrawerOpen(false)}
        width={760}
      >
        {historyLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : historyItems.length === 0 ? (
          <Empty description="暂无历史盘点记录" />
        ) : (
          <Table
            rowKey="check_no"
            dataSource={historyItems}
            pagination={false}
            size="small"
            columns={[
              { title: '盘点单号', dataIndex: 'check_no', width: 160 },
              { title: '订单号', dataIndex: 'order_no', width: 160 },
              { title: '客户', dataIndex: 'customer', width: 140, ellipsis: true,
                render: (v: any) => v || '-' },
              { title: '状态', dataIndex: 'status', width: 90,
                render: (v: any) => <Tag color={STATUS_MAP[v]?.color || 'default'}>{STATUS_MAP[v]?.label || v}</Tag> },
              { title: '实盘数', dataIndex: 'actual_qty', width: 100, align: 'right' as const,
                render: (v: any) => v != null ? Number(v).toFixed(2) : '-' },
              { title: '完结时间', dataIndex: 'completed_at', width: 160,
                render: (v: any) => v ? formatDateTime(v) : '-' },
            ]}
            scroll={{ x: 1000 }}
          />
        )}
      </Drawer>
      <MaterialPickerModal
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onConfirm={handleCreateFromMaterials}
        confirmLoading={creating}
      />
      <MaterialPickerModal
        open={addPickerOpen}
        onCancel={() => setAddPickerOpen(false)}
        onConfirm={handleAddItemsToCheck}
        confirmLoading={creating}
      />
      <OrderProductPickerModal
        open={orderPickerOpen}
        orderNo={orderNo}
        coveredKeys={coveredKeySet}
        onCancel={() => setOrderPickerOpen(false)}
        onCreate={(selected) => handleCreate(orderNo, selected)}
        confirmLoading={loading}
      />
      <CoCheckerPickerModal
        open={coPickerOpen}
        initialIds={coPickerIds}
        onCancel={() => setCoPickerOpen(false)}
        onSave={handleSaveCoCheckers}
        saveLoading={coSaving}
      />
      {k3ModalOpen && (
        <K3ImportModal
          open
          onClose={() => setK3ModalOpen(false)}
          onImported={() => reloadRecentList()}
        />
      )}
      <ConflictModal
        open={!!conflict}
        myDraft={conflict?.myDraft ?? null}
        serverVersion={conflict?.serverVersion ?? null}
        serverItem={conflict?.serverItem ?? null}
        serverChangedBy={conflict?.serverChangedBy ?? null}
        onOverwrite={handleConflictOverwrite}
        onDiscard={handleConflictDiscard}
      />
    </div>
  )
}
