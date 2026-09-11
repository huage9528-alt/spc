import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { CSSProperties, Key } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Table, Input, Button, message, Modal, Card, Row, Col, InputNumber,
  Spin, Tour, Drawer, Empty, Tooltip, Segmented, Select, Dropdown,
  Alert, Tag,
} from 'antd'
import {
  SearchOutlined, CheckCircleOutlined, StopOutlined, ArrowLeftOutlined,
  HistoryOutlined, PlusOutlined, DownOutlined, DownloadOutlined, DeleteOutlined,
  AppstoreOutlined, ClockCircleOutlined, ArrowUpOutlined, ArrowDownOutlined,
  BarsOutlined, WarningOutlined, FullscreenOutlined, FullscreenExitOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useExport } from '@/hooks/useExport'
import { materialApi, orderApi } from '@/services/api'
import { formatDateTime } from '@/utils'
import { useUiPreferencesStore } from '@/store/uiPreferences'
import ExportColumnSelector, { ExportColumnOption } from '@/components/ExportColumnSelector'
import {
  stockCheckDetailSteps, stockCheckManualDetailSteps,
  STOCK_CHECK_DETAIL_TOUR_ID, STOCK_CHECK_MANUAL_DETAIL_TOUR_ID,
} from './StockCheckTour'
import MaterialPickerModal from './MaterialPickerModal'
import type { OrderProductLine } from './OrderProductPickerModal'
import CoCheckerPickerModal from './CoCheckerPickerModal'
import SearchableColumnFilter from './SearchableColumnFilter'
import { useStockCheckSync } from '@/hooks/useStockCheckSync'
import ConflictModal, { ConflictDraft } from './ConflictModal'
import { useAuthStore } from '@/store/auth'
import { STATUS_MAP, AVATAR_COLORS, checkTypeTag, AvatarStack, ScTag } from './types'
import type { StockCheck, StockCheckItem, MaterialCandidate, MaterialHistoryItem, StockCheckWriteback, WritebackOverview } from './types'

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

type SegKey = 'all' | 'unchecked' | 'checked' | 'diff'

// 脏行判定基线: loadCheck / onSnapshot / 保存成功 后重抓
type BaselineEntry = { actual_qty: number | null; is_checked: number; remark: string | null }

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function avatarColor(name: string): string {
  let h = 0
  for (const c of name) h = (h + c.charCodeAt(0)) % 997
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

// 近期已盘免盘标记(未点重盘)
function hasRecentMark(r: StockCheckItem): boolean {
  return !!r.recent_checked_check_no && !r.force_recount
}

export default function StockCheckWorkbench() {
  const navigate = useNavigate()
  const { checkId } = useParams()
  const [searchParams] = useSearchParams()
  const checkIdNum = checkId ? Number(checkId) : null

  const [activeCheck, setActiveCheck] = useState<StockCheck | null>(null)
  const [items, setItems] = useState<StockCheckItem[]>([])
  const [loading, setLoading] = useState(false)
  const [savingAll, setSavingAll] = useState(false)

  // ===== 过滤器 =====
  const [searchText, setSearchText] = useState('')
  const [productFilter, setProductFilter] = useState<string>('all')
  const [whFilter, setWhFilter] = useState<string>('all')
  const [segFilter, setSegFilter] = useState<SegKey>('all')
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([])

  // ===== 脏行基线 =====
  const baselineRef = useRef<Map<number, BaselineEntry>>(new Map())
  const captureBaseline = useCallback((list: StockCheckItem[]) => {
    const m = new Map<number, BaselineEntry>()
    for (const it of list) {
      m.set(it.id, {
        actual_qty: it.actual_qty != null ? Number(it.actual_qty) : null,
        is_checked: it.is_checked ?? 0,
        remark: it.remark ?? null,
      })
    }
    baselineRef.current = m
  }, [])

  const loadCheck = useCallback(async (id: number) => {
    setLoading(true)
    try {
      const res: any = await materialApi.getStockCheck(id)
      const c: StockCheck = res.data
      setActiveCheck(c)
      setItems(c.items || [])
      captureBaseline(c.items || [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '加载盘点单失败')
    } finally {
      setLoading(false)
    }
  }, [captureBaseline])

  useEffect(() => {
    if (checkIdNum == null || Number.isNaN(checkIdNum)) return
    if (activeCheck?.id === checkIdNum) return
    loadCheck(checkIdNum)
  }, [checkIdNum, activeCheck?.id, loadCheck])

  // 切换盘点单: 重置过滤/选择, 支持 ?product= 预筛
  useEffect(() => {
    setSelectedKeys([])
    setWhFilter('all')
    setSegFilter('all')
    setSearchText('')
    setProductFilter(searchParams.get('product') || 'all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkIdNum])

  // ===== SSE 协同 =====
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

  const { connected: syncConnected } = useStockCheckSync({
    checkId: activeCheck?.id ?? null,
    onSnapshot: (p) => {
      // can_edit 为空时保留原值,防止旧版 snapshot 的 null 覆盖 REST 返回的 can_edit=false
      setActiveCheck((prev) => (prev ? { ...prev, ...p, can_edit: p.can_edit ?? prev.can_edit } : prev))
      setItems(p.items || [])
      captureBaseline(p.items || [])
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
      // 他人保存的行同步进基线,避免被误判为本地脏行
      if (baselineRef.current.has(p.item_id) && p.item) {
        baselineRef.current.set(p.item_id, {
          actual_qty: p.item.actual_qty != null ? Number(p.item.actual_qty) : null,
          is_checked: p.item.is_checked ?? 0,
          remark: p.item.remark ?? null,
        })
      }
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
    onItemsBatchUpdated: (p) => {
      // 批量保存事件:一次合并多行(编辑态保护同单行逻辑)
      const byId = new Map(p.items.map((u: any) => [u.item_id as number, u]))
      if (editingItemId != null && byId.has(editingItemId)) {
        setSyncBanner(`行 #${editingItemId} 刚被他人批量修改,保存时会提示对比`)
      }
      setItems((prev) => prev.map((it) => {
        const u = byId.get(it.id)
        if (!u || editingItemId === it.id) return it
        return { ...it, ...u.item, version: u.version }
      }))
      for (const u of p.items) {
        if (baselineRef.current.has(u.item_id) && u.item) {
          baselineRef.current.set(u.item_id, {
            actual_qty: u.item.actual_qty != null ? Number(u.item.actual_qty) : null,
            is_checked: u.item.is_checked ?? 0,
            remark: u.item.remark ?? null,
          })
        }
      }
      if (p.head_aggregates) {
        setActiveCheck((prev) =>
          prev
            ? {
                ...prev,
                checked_materials: p.head_aggregates!.checked_materials,
                total_materials: p.head_aggregates!.total_materials,
                total_diff_qty: p.head_aggregates!.total_diff_qty,
              }
            : prev,
        )
      }
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

  // ===== 现已入库的「(未入库)」行自动按仓库拆分/归属 =====
  // 后端 refresh-warehouses 仅处理 wh_id=NULL 且未录数据的行:
  // 单仓 → 原行归属该仓;多仓 → 原行归属库存最大的仓,其余仓各 INSERT 一行(即"分成两行")。
  // 自己触发的 SSE 事件不回显(origin 过滤),拆分成功后需主动重载。
  const whAutoRefreshRef = useRef(false)
  useEffect(() => {
    const cid = activeCheck?.id
    if (!cid) return
    if (activeCheck.status !== 'open' && activeCheck.status !== 'in_progress') return
    if (activeCheck.can_edit === false) return
    const splittable = items.some((it) => it.wh_id == null && it.actual_qty == null && it.live_wh_names)
    if (!splittable || whAutoRefreshRef.current) return
    whAutoRefreshRef.current = true
    materialApi.refreshStockCheckWarehouses(cid).then((res: any) => {
      const s = res?.data || {}
      const n = (s.updated || 0) + (s.inserted || 0)
      if (n > 0) {
        if ((s.split || 0) > 0) message.info(`检测到现已多仓入库的明细,已自动按仓库拆分(更新 ${s.updated} 行、新增 ${s.inserted} 行)`)
        else message.info('检测到现已入库的明细,已自动归属到对应仓库')
        loadCheck(cid)
      }
    }).catch(() => { /* 静默:无权限/并发已处理时不打扰 */ })
      .finally(() => { whAutoRefreshRef.current = false })
  }, [items, activeCheck, loadCheck])

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
    materialApi.updateStockCheckPresence(cid, itemId)
      .then(() => { /* presence 已广播 */ })
      .catch(() => { /* 静默 */ })
    if (presenceHeartbeat.current) clearInterval(presenceHeartbeat.current)
    presenceHeartbeat.current = setInterval(
      () => materialApi.updateStockCheckPresence(cid, itemId).catch(() => {}),
      30000,
    )
  }, [activeCheck?.id])

  const handleEditingBlur = useCallback(() => {
    setEditingItemId(null)
    if (presenceHeartbeat.current) { clearInterval(presenceHeartbeat.current); presenceHeartbeat.current = null }
    const cid = activeCheck?.id
    if (!cid) return
    // 防抖: 先取消旧定时器再挂新的,保证连续 blur 只发一次清除
    if (clearPresenceTimer.current) { clearTimeout(clearPresenceTimer.current); clearPresenceTimer.current = null }
    clearPresenceTimer.current = setTimeout(() => {
      clearPresenceTimer.current = null
      materialApi.updateStockCheckPresence(cid, null).catch(() => { /* 静默 */ })
    }, 150)
  }, [activeCheck?.id])

  // 卸载时清理心跳 + 清除计时器
  useEffect(() => {
    return () => {
      if (presenceHeartbeat.current) clearInterval(presenceHeartbeat.current)
      if (clearPresenceTimer.current) clearTimeout(clearPresenceTimer.current)
    }
  }, [])

  // ===== 产品筛选(订单类型): BOM 树 → material_id → 产品 key =====
  const [orderProducts, setOrderProducts] = useState<OrderProductLine[]>([])
  useEffect(() => {
    const no = activeCheck?.check_type === 'order' ? activeCheck.order_no : null
    if (!no) { setOrderProducts([]); return }
    let cancelled = false
    orderApi.getProductMaterials(no)
      .then((res: any) => { if (!cancelled) setOrderProducts(res.data || []) })
      .catch(() => { /* 静默 */ })
    return () => { cancelled = true }
  }, [activeCheck?.check_type, activeCheck?.order_no])

  const productKey = (p: { product_code?: string | null; bom_no?: string | null }) =>
    `${p.product_code ?? ''}__${p.bom_no ?? ''}`

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

  const productRowCount = useCallback((key: string) =>
    items.filter((it) => it.material_id != null && productMaterialMap.get(it.material_id)?.has(key)).length,
    [items, productMaterialMap])

  const productOptions = useMemo(() => {
    if (activeCheck?.check_type !== 'order' || orderProducts.length === 0) return []
    return orderProducts.map((p) => {
      const label = `${p.product_code || '—'}${p.bom_no ? ` · BOM ${p.bom_no}` : ''} (${productRowCount(productKey(p))} 行)`
      return { value: productKey(p), label, title: label }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCheck, orderProducts, productRowCount])

  // ===== 保存 / 完成 / 取消 =====
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
      // 即时保存成功的行同步进基线,避免 sticky 条误报
      baselineRef.current.set(updated.id, {
        actual_qty: updated.actual_qty != null ? Number(updated.actual_qty) : null,
        is_checked: updated.is_checked ?? 0,
        remark: updated.remark ?? null,
      })
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

  // 盘平快捷录入: 实盘=快照库存,差异=0,已盘=1;复用 saveItem(含乐观锁/冲突弹窗/头表刷新)
  const handleMarkEven = useCallback((r: StockCheckItem) => {
    if (r.system_qty == null) {
      message.warning('该行无库存快照,无法盘平')
      return
    }
    saveItem({ ...r, actual_qty: Number(r.system_qty), is_checked: 1 })
  }, [saveItem])

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

  // ===== 脏行判定 =====
  const isRowDirty = useCallback((it: StockCheckItem) => {
    const b = baselineRef.current.get(it.id)
    if (!b) return false
    const actual = it.actual_qty != null ? Number(it.actual_qty) : null
    return actual !== b.actual_qty || (it.is_checked ?? 0) !== b.is_checked || (it.remark ?? null) !== b.remark
  }, [])

  const saveAll = useCallback(async () => {
    if (!activeCheck) return
    // 只提交脏行(与基线比对),未改动的行不再随批保存
    const toSave = items.filter(isRowDirty)
    if (toSave.length === 0) {
      message.info('没有未保存的修改')
      return
    }
    setSavingAll(true)
    try {
      await materialApi.batchUpdateStockCheckItems(
        activeCheck.id,
        toSave.map(it => ({
          id: it.id,
          actual_qty: it.actual_qty != null ? Number(it.actual_qty) : null,
          is_checked: it.is_checked ?? 0,
          remark: it.remark ?? undefined,
          force_recount: it.force_recount || undefined,
        })),
      )
      message.success(`已保存 ${toSave.length} 项修改`)
      setItems(prev => prev.map(p => ({ ...p, force_recount: undefined })))
      await loadCheck(activeCheck.id)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '批量保存失败')
    } finally {
      setSavingAll(false)
    }
  }, [activeCheck, items, isRowDirty, loadCheck])

  // ===== 完结弹窗（含 K3 回写分组预览：完结并回写 / 仅完结） =====
  const [completeOpen, setCompleteOpen] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [completeMode, setCompleteMode] = useState<'writeback' | 'only' | null>(null)

  const handleComplete = useCallback(() => {
    if (!activeCheck) return
    // 允许部分盘点完结:未录实盘的行视为放弃(diff=0、不回写 K3),弹窗内另行警示
    setCompleteOpen(true)
  }, [activeCheck])

  const handleCancel = useCallback(async () => {
    if (!activeCheck) return
    Modal.confirm({
      title: '取消盘点单',
      content: '确认取消该盘点单?',
      okType: 'danger',
      onOk: async () => {
        let curVersion: number | undefined = activeCheck.version ?? undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res: any = await materialApi.cancelStockCheck(activeCheck.id, curVersion)
            setActiveCheck(res.data)
            message.success('已取消')
            return
          } catch (e: any) {
            const detail = e?.response?.data?.detail
            const code = detail?.code ?? e?.response?.data?.code
            if (attempt === 0 && code === 409) {
              const sv = detail?.data?.server_version
              if (typeof sv === 'number') {
                curVersion = sv
                continue
              }
            }
            if (code === 409) {
              message.warning('盘点单状态刚被他人修改,正在刷新')
              loadCheck(activeCheck.id)
            } else {
              message.error(detail || e.message || '取消失败')
            }
            return
          }
        }
      },
    })
  }, [activeCheck, loadCheck])

  // ===== K3 回写卡片 =====
  const [wbOverview, setWbOverview] = useState<WritebackOverview | null>(null)
  const [wbLoading, setWbLoading] = useState(false)
  const [wbRetrying, setWbRetrying] = useState(false)

  const loadWritebacks = useCallback(async (checkId: number) => {
    setWbLoading(true)
    try {
      const res: any = await materialApi.getStockCheckWritebacks(checkId)
      setWbOverview(res.data)
    } catch {
      setWbOverview(null)
    } finally {
      setWbLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeCheck?.id && activeCheck.status === 'completed') {
      loadWritebacks(activeCheck.id)
    } else {
      setWbOverview(null)
    }
  }, [activeCheck?.id, activeCheck?.status, loadWritebacks])

  const retryWritebacks = useCallback(async () => {
    if (!activeCheck?.id) return
    setWbRetrying(true)
    try {
      const res: any = await materialApi.retryStockCheckWritebacks(activeCheck.id)
      setWbOverview(res.data)
      const failed = (res.data?.writebacks || []).filter((w: StockCheckWriteback) => w.status === 'failed').length
      if (failed > 0) message.warning(`仍有 ${failed} 张单据回写失败，请检查失败原因`)
      else message.success('K3 单据回写成功')
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '重试失败')
    } finally {
      setWbRetrying(false)
    }
  }, [activeCheck?.id])

  // ===== 完结弹窗 · K3 回写分组预览（与后端 plan_writebacks 同规则：diff≠0 且有仓库，按 类型×仓库 分组） =====
  const writebackPreview = useMemo(() => {
    const groups = new Map<string, { key: string; bill_type: 'gain' | 'loss_transfer'; wh_label: string; count: number; total: number }>()
    const skipped: { material_code?: string | null; material_name?: string | null; diff: number }[] = []
    let gainRows = 0
    let lossRows = 0
    for (const it of items) {
      const diff = it.diff_qty != null ? Number(it.diff_qty) : 0
      if (!diff) continue
      if (diff > 0) gainRows += 1
      else lossRows += 1
      if (it.wh_id == null) {
        skipped.push({ material_code: it.material_code, material_name: it.material_name, diff })
        continue
      }
      const bill_type: 'gain' | 'loss_transfer' = diff > 0 ? 'gain' : 'loss_transfer'
      const key = `${bill_type}-${it.wh_id}`
      const g = groups.get(key) || {
        key, bill_type,
        wh_label: it.wh_name || it.wh_code || `仓库#${it.wh_id}`,
        count: 0, total: 0,
      }
      g.count += 1
      g.total += Math.abs(diff)
      groups.set(key, g)
    }
    const isK3Source = (activeCheck?.source || '') === 'k3'
    return {
      bills: [...groups.values()].sort((a, b) => a.bill_type.localeCompare(b.bill_type) || a.wh_label.localeCompare(b.wh_label)),
      skipped,
      gainRows,
      lossRows,
      diffRows: gainRows + lossRows,
      disabled: isK3Source,
    }
  }, [items, activeCheck?.source])

  const doComplete = useCallback(async (withWriteback: boolean) => {
    if (!activeCheck) return
    setCompleteMode(withWriteback ? 'writeback' : 'only')
    setCompleting(true)
    try {
      const res: any = await materialApi.completeStockCheck(activeCheck.id, activeCheck.version ?? undefined)
      setActiveCheck(res.data)
      setItems(res.data.items || [])
      captureBaseline(res.data.items || [])
      const ws = res.data?.writeback_summary
      if (withWriteback && ws && Number(ws.total) > 0) {
        try {
          const wb: any = await materialApi.retryStockCheckWritebacks(activeCheck.id)
          setWbOverview(wb.data)
          const failed = (wb.data?.writebacks || []).filter((w: StockCheckWriteback) => w.status === 'failed').length
          if (failed > 0) message.warning(`已完结；${failed} 张 K3 单据回写失败，请在「K3 回写」卡片查看原因并重试`, 6)
          else message.success(`已完结；${ws.total} 张 K3 单据已生成（未审核），需仓管员在 K3 中审核`, 6)
        } catch (e: any) {
          message.warning(`已完结；K3 回写执行失败（${e?.response?.data?.detail || e.message || '网络异常'}），请在「K3 回写」卡片重试`, 6)
          loadWritebacks(activeCheck.id)
        }
      } else if (ws && Number(ws.total) > 0) {
        message.info(`已完结；${ws.total} 张 K3 单据待手动提交，请在「K3 回写」卡片操作`, 6)
      } else {
        message.success('已完结')
      }
      setCompleteOpen(false)
    } catch (e: any) {
      const code = e?.response?.data?.detail?.code ?? e?.response?.data?.code
      if (code === 409) {
        message.warning('盘点单状态刚被他人修改,正在刷新')
        loadCheck(activeCheck.id)
        setCompleteOpen(false)
      } else {
        message.error(e?.response?.data?.detail || e.message || '完结失败')
      }
    } finally {
      setCompleting(false)
      setCompleteMode(null)
    }
  }, [activeCheck, captureBaseline, loadCheck, loadWritebacks])

  // 台账页「K3 回写」行操作带 ?wb=1 进入时，滚到 K3 回写卡片
  const wbAnchorDone = useRef(false)
  useEffect(() => {
    if (wbAnchorDone.current) return
    if (searchParams.get('wb') === '1' && activeCheck?.status === 'completed' && !wbLoading) {
      wbAnchorDone.current = true
      const el = document.getElementById('k3-writeback')
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [searchParams, activeCheck?.status, wbLoading])

  // ===== 补入子BOM / 刷新仓库 / 协同人 =====
  const handleRefreshBom = useCallback(async () => {
    if (!activeCheck) return
    let recentDays = 7
    // 确认框内容组件(自带 state,同步到外部变量供 onOk 读取)
    const Content = () => {
      const [days, setDays] = useState<number | null>(7)
      return (
        <div>
          <p>将按当前订单的最新BOM重新展开，把之前未纳入的子BOM物料补入此盘点单（已有明细及已录入数据保留）。</p>
          <p style={{ marginBottom: 0 }}>
            近期已盘免盘天数(必选,可选可输;0=仅当天;不限=全部历史)：
            <Select
              showSearch size="small" style={{ width: 180, margin: '0 6px' }}
              value={days ?? undefined}
              placeholder="选择或输入天数"
              status={days == null ? 'error' : undefined}
              options={[
                { value: 1, label: '1 天' },
                { value: 3, label: '3 天' },
                { value: 7, label: '7 天' },
                { value: 15, label: '15 天' },
                { value: 30, label: '30 天' },
                { value: 90, label: '90 天' },
                { value: 99999, label: '不限（全部历史）' },
              ]}
              onSelect={(v) => {
                const d = Number(v)
                setDays(d)
                recentDays = d
              }}
              onSearch={(text) => {
                const t = text.replace(/[^\d]/g, '')
                if (t === '') { setDays(null); recentDays = 0; return }
                const d = Math.max(0, Math.min(99999, Number(t)))
                setDays(d)
                recentDays = d
              }}
              filterOption={() => true}
            />
          </p>
        </div>
      )
    }
    Modal.confirm({
      title: '补入缺失的子BOM物料',
      content: <Content />,
      okText: '刷新',
      cancelText: '取消',
      onOk: async () => {
        try {
          await materialApi.refreshStockCheckBom(activeCheck.id, recentDays)
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

  const [coPickerOpen, setCoPickerOpen] = useState(false)
  const [coPickerIds, setCoPickerIds] = useState<number[]>([])
  const [coSaving, setCoSaving] = useState(false)

  const openCoPicker = useCallback(() => {
    setCoPickerIds(activeCheck?.co_checker_user_ids || [])
    setCoPickerOpen(true)
  }, [activeCheck])

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

  // ===== 添加 / 移除物料 =====
  const [addPickerOpen, setAddPickerOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  const handleAddItemsToCheck = useCallback(async (selected: MaterialCandidate[], _source: 'search' | 'pool', recentDays?: number | null) => {
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
        ...(recentDays != null ? { recent_days: recentDays } : {}),
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

  // 近期已盘 → 重盘: 本地置 force_recount 进入录入态,服务端标记保留至真正录入实盘数
  const handleForceRecount = useCallback((r: StockCheckItem) => {
    materialApi.updateStockCheckItem(r.id, { force_recount: true }).then(async (res: any) => {
      const updated: StockCheckItem = res.data
      setItems(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated, force_recount: true } : p))
      const headRes: any = await materialApi.getStockCheck(updated.check_id)
      setActiveCheck(prev => prev ? { ...prev, ...headRes.data } : headRes.data)
    }).catch((err: any) => {
      message.error(err?.response?.data?.detail || err.message || '重盘失败')
    })
  }, [])

  const updateItem = useCallback((id: number, patch: Partial<StockCheckItem>) => {
    setItems(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p))
  }, [])

  // ===== 物料历史 Drawer =====
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

  // ===== 导出 =====
  const { exporting, exportPostData } = useExport()
  const [exportFormat, setExportFormat] = useState<'xlsx' | 'csv'>('xlsx')
  const [exportColumnModalOpen, setExportColumnModalOpen] = useState(false)

  const handleExportClick = (format: 'xlsx' | 'csv') => {
    setExportFormat(format)
    setExportColumnModalOpen(true)
  }

  const handleExportColumnConfirm = (selectedColumns: string[]) => {
    setExportColumnModalOpen(false)
    if (!activeCheck) return
    // 页面筛选(搜索/产品/仓库/分段Tab/表头筛选)均为客户端筛选,导出时把当前可见行 id 传给后端
    const ids = exportableItems.map((it) => it.id)
    if (!ids.length) { message.info('当前筛选下无数据可导出'); return }
    const ext = exportFormat === 'csv' ? 'csv' : 'xlsx'
    exportPostData(
      `/api/v1/materials/stock-check/${activeCheck.id}/export`,
      { format: exportFormat, columns: selectedColumns, item_ids: ids },
      `物料盘点明细_${activeCheck.check_no}.${ext}`,
    )
  }

  const readonly = activeCheck?.status === 'completed' || activeCheck?.status === 'cancelled' || activeCheck?.can_edit === false

  const dirtyItems = useMemo(() => items.filter(isRowDirty), [items, isRowDirty])

  // ===== 过滤链 =====
  const searchedItems = useMemo(() => {
    let list = items
    if (activeCheck?.check_type === 'order' && productFilter && productFilter !== 'all') {
      list = list.filter((it) => it.material_id != null && productMaterialMap.get(it.material_id)?.has(productFilter))
    }
    const kw = searchText.trim().toLowerCase()
    if (kw) {
      list = list.filter((it) =>
        (it.material_code || '').toLowerCase().includes(kw) ||
        (it.material_name || '').toLowerCase().includes(kw))
    }
    if (whFilter !== 'all') {
      // 与仓库列展示同口径(warehouse_display): 「(未入库)」行现已入库的按实时仓库名参与筛选,
      // 仅真正仍无库存的行留在「(未入库)」分组
      list = list.filter((it) => (it.warehouse_display || it.wh_name || '(未入库)') === whFilter)
    }
    return list
  }, [items, searchText, productFilter, productMaterialMap, whFilter, activeCheck])

  const segCounts = useMemo(() => ({
    all: searchedItems.length,
    unchecked: searchedItems.filter((it) => it.is_checked !== 1 && !hasRecentMark(it)).length,
    checked: searchedItems.filter((it) => it.is_checked === 1 || hasRecentMark(it)).length,
    diff: searchedItems.filter((it) => it.diff_qty != null && Number(it.diff_qty) !== 0).length,
  }), [searchedItems])

  const tableItems = useMemo(() => {
    if (segFilter === 'all') return searchedItems
    if (segFilter === 'unchecked') return searchedItems.filter((it) => it.is_checked !== 1 && !hasRecentMark(it))
    if (segFilter === 'checked') return searchedItems.filter((it) => it.is_checked === 1 || hasRecentMark(it))
    return searchedItems.filter((it) => it.diff_qty != null && Number(it.diff_qty) !== 0)
  }, [searchedItems, segFilter])

  // ===== 明细表自适应高度：整页收敛在视口内（窗口不出现滚动条），仅表格内部滚动 =====
  const detailSectionRef = useRef<HTMLDivElement | null>(null)
  const [detailMounted, setDetailMounted] = useState(false)
  const attachDetailSection = useCallback((node: HTMLDivElement | null) => {
    detailSectionRef.current = node
    setDetailMounted((prev) => (prev === !!node ? prev : !!node))
  }, [])
  const [tableScrollY, setTableScrollY] = useState<number>(560)
  const measureTableScrollY = useCallback(() => {
    const el = detailSectionRef.current
    if (!el || !el.clientHeight) return
    const tableEl = el.querySelector<HTMLElement>('.ant-table')
    const bodyEl = el.querySelector<HTMLElement>('.ant-table-body')
    const pad = dirtyItems.length > 0 ? 56 : 8
    const avail = el.clientHeight - pad - 4
    if (avail < 140) return
    // 表头 + 汇总行等固定骨架高度：由 DOM 实测得出（body 滚动容器高度之外的差值）
    const chrome = tableEl && bodyEl && bodyEl.offsetHeight > 0
      ? Math.max(50, tableEl.offsetHeight - bodyEl.offsetHeight)
      : 92
    const next = Math.max(160, Math.floor(avail - chrome))
    setTableScrollY((prev) => (Math.abs(next - prev) >= 2 ? next : prev))
  }, [dirtyItems.length])

  useEffect(() => {
    // 明细表在数据加载完成后才挂载：node 出现后再建立 ResizeObserver / resize 监听，
    // 这样浏览器缩放、拖拽窗口等引起的视口变化才能持续驱动表格高度自适应
    if (!detailMounted) return
    measureTableScrollY()
    const el = detailSectionRef.current
    if (!el) return
    const ro = new ResizeObserver(() => measureTableScrollY())
    ro.observe(el)
    window.addEventListener('resize', measureTableScrollY)
    const vv = window.visualViewport
    vv?.addEventListener('resize', measureTableScrollY)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measureTableScrollY)
      vv?.removeEventListener('resize', measureTableScrollY)
    }
  }, [measureTableScrollY, detailMounted])

  // ===== 页面内全屏模式（大屏）：隐藏信息卡/统计卡等上部区块，表格占满整个浏览器窗口 =====
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (loading) return
    const raf = requestAnimationFrame(measureTableScrollY)
    return () => cancelAnimationFrame(raf)
  }, [loading, tableItems.length, activeCheck?.status, fullscreen, measureTableScrollY])

  // 表头列筛选(物料编码/仓库/盘点人)是 antd 表内状态,onChange 时同步一份,导出时按同口径复筛
  const [columnFilters, setColumnFilters] = useState<Record<string, unknown>>({})
  const exportableItems = useMemo(() => {
    const inFilter = (key: string, val: string | null | undefined) => {
      const fs = (columnFilters[key] as Array<unknown> | null | undefined) ?? []
      return !fs.length || (val != null && fs.includes(val))
    }
    return tableItems.filter((it) =>
      inFilter('material_code', it.material_code) &&
      inFilter('wh_name', it.warehouse_display || it.wh_name || '(未入库)') &&
      inFilter('checked_by', it.checked_by))
  }, [tableItems, columnFilters])

  const whOptions = useMemo(() => {
    // 同 warehouse_display 口径: 现已入库的「(未入库)」行按其实时仓库名(可能是多仓顿号拼接)归组
    const s = new Set<string>()
    for (const it of items) {
      s.add(it.warehouse_display || it.wh_name || '(未入库)')
    }
    const opts = [{ value: 'all', label: '全部仓库' }]
    for (const n of Array.from(s).sort()) opts.push({ value: n, label: n })
    return opts
  }, [items])

  const selectedItems = useMemo(() => items.filter((it) => selectedKeys.includes(it.id)), [items, selectedKeys])

  // 批量盘平: 只入草稿(不即时提交),无快照/近期已盘行跳过
  const handleBatchMarkEven = useCallback(() => {
    let skipped = 0
    for (const r of selectedItems) {
      if (r.system_qty == null || hasRecentMark(r)) { skipped++; continue }
      updateItem(r.id, { actual_qty: Number(r.system_qty), diff_qty: 0, is_checked: 1 })
    }
    if (skipped > 0) message.warning(`${skipped} 行无库存快照或近期已盘,已跳过`)
  }, [selectedItems, updateItem])

  // 扫码/回车定位唯一匹配行: 在当前过滤结果(tableItems)中匹配, 唯一命中时聚焦该行实盘录入框
  const handleSearchEnter = useCallback(() => {
    const kw = searchText.trim().toLowerCase()
    if (!kw) return
    const m = tableItems.filter((it) =>
      (it.material_code || '').toLowerCase().includes(kw) ||
      (it.material_name || '').toLowerCase().includes(kw))
    if (m.length === 0) {
      message.warning('未找到匹配物料')
      return
    }
    if (m.length > 1) {
      message.info(`匹配 ${m.length} 行，请继续输入缩小范围`)
      return
    }
    const match = m[0]
    const input = document.getElementById(`sc-actual-${match.id}`)?.querySelector('input')
    if (input) {
      input.focus()
      input.select()
      message.info(`已定位 ${match.material_code || match.material_name || match.id}`)
    } else {
      // 行存在但录入框未渲染(如近期已盘行)或不在可视 DOM
      message.info(`已定位 ${match.material_code || match.material_name || match.id}（该行无录入框）`)
    }
  }, [tableItems, searchText])

  // ===== 统计(本地聚合) =====
  // 已盘口径与后端 _refresh_check_aggregates 一致: is_checked=1 或 近期已盘免盘行
  const stats = useMemo(() => {
    const total = items.length
    const recent = items.filter((it) => hasRecentMark(it)).length
    const checked = items.filter((it) => it.is_checked === 1 || hasRecentMark(it)).length
    const gain = items.filter((it) => it.diff_qty != null && Number(it.diff_qty) > 0).length
    const loss = items.filter((it) => it.diff_qty != null && Number(it.diff_qty) < 0).length
    const totalDiff = round2(items.reduce((s, it) => s + Number(it.diff_qty || 0), 0))
    return { total, checked, recent, unchecked: total - checked, gain, loss, totalDiff }
  }, [items])

  const onlineNames = useMemo(() => {
    const m = new Map<number, string>()
    for (const list of Object.values(presenceByItem)) for (const u of list) m.set(u.user_id, u.name)
    return Array.from(m.values())
  }, [presenceByItem])

  // ===== 新手引导 =====
  const newbieMode = useUiPreferencesStore(s => s.preferences?.newbie_mode !== false)
  const isManualDetail = activeCheck?.check_type === 'manual'
  const tourId = activeCheck
    ? (isManualDetail ? STOCK_CHECK_MANUAL_DETAIL_TOUR_ID : STOCK_CHECK_DETAIL_TOUR_ID)
    : ''
  const tourSteps = (activeCheck
    ? (isManualDetail ? stockCheckManualDetailSteps! : stockCheckDetailSteps!)
    : []) ?? []
  const seenTour = useUiPreferencesStore(s => s.preferences?.['tours_seen']?.[tourId])
  const [tourOpen, setTourOpen] = useState(false)

  useEffect(() => {
    if (!newbieMode || !tourId || seenTour) return
    const t = setTimeout(() => setTourOpen(true), 500)
    return () => clearTimeout(t)
  }, [newbieMode, seenTour, tourId])

  const handleTourClose = useCallback(() => {
    const current = useUiPreferencesStore.getState().getFlag('tours_seen', {}) as Record<string, boolean>
    useUiPreferencesStore.getState().setFlag('tours_seen', { ...current, [tourId]: true })
    setTourOpen(false)
  }, [tourId])

  // ===== 差异三色 =====
  const renderDiff = (v: number | null | undefined) => {
    if (v == null) return <span className="sc-diff-flat">—</span>
    const n = Number(v)
    if (n > 0) return <span className="sc-diff-up">+{round2(n)}</span>
    if (n < 0) return <span className="sc-diff-down">−{round2(Math.abs(n))}</span>
    return <span className="sc-diff-flat">0</span>
  }

  // ===== 表头筛选选项（物料编码 / 仓库 / 盘点人） =====
  const materialFilterOptions = useMemo(
    () => Array.from(new Set(items.map((i) => i.material_code).filter(Boolean))).map((v) => ({ text: v as string, value: v as string })),
    [items],
  )
  const whFilterOptions = useMemo(
    () => Array.from(new Set(items.map((i) => i.warehouse_display || i.wh_name || '(未入库)'))).map((v) => ({ text: v, value: v })),
    [items],
  )
  const checkerFilterOptions = useMemo(
    () => Array.from(new Set(items.map((i) => i.checked_by).filter(Boolean))).map((v) => ({ text: v as string, value: v as string })),
    [items],
  )
  const nullsLast = (a: number | null, b: number | null) => {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    return a - b
  }

  // ===== 明细表列 =====
  const columns = useMemo(() => [
    {
      title: '物料编码 / 名称', dataIndex: 'material_code', width: 210, fixed: 'left' as const,
      sorter: (a: StockCheckItem, b: StockCheckItem) => (a.material_code || '').localeCompare(b.material_code || ''),
      filterDropdown: (props: any) => <SearchableColumnFilter {...props} filters={materialFilterOptions} columnKey="material_code" />,
      onFilter: (v: any, r: StockCheckItem) => r.material_code === v,
      render: (v: any, r: StockCheckItem) => (
        <div style={{ lineHeight: 1.2 }}>
          <div className="sc-mono" style={{ color: '#0f172a', fontWeight: 500 }}>{v || '—'}</div>
          <div className="sc-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {r.material_name || '—'}{r.spec_model ? ` · ${r.spec_model}` : ''}
          </div>
        </div>
      ),
    },
    {
      title: '仓库', dataIndex: 'wh_name', width: 130, ellipsis: true,
      sorter: (a: StockCheckItem, b: StockCheckItem) =>
        (a.warehouse_display || a.wh_name || '(未入库)').localeCompare(b.warehouse_display || b.wh_name || '(未入库)'),
      filters: whFilterOptions,
      onFilter: (v: any, r: StockCheckItem) => (r.warehouse_display || r.wh_name || '(未入库)') === v,
      render: (v: any, r: StockCheckItem) => {
        if (r.wh_id == null && r.live_wh_names) {
          return (
            <Tooltip title={`建单时未入库，现已入库：${r.live_wh_names}`}>
              <span style={{ color: '#0284c7' }}>{r.live_wh_names}</span>
            </Tooltip>
          )
        }
        if (r.wh_id == null || !v) return <span className="sc-wh-none">(未入库)</span>
        return v
      },
    },
    {
      title: '快照', dataIndex: 'system_qty', width: 120, align: 'right' as const,
      sorter: (a: StockCheckItem, b: StockCheckItem) => nullsLast(
        a.system_qty != null ? Number(a.system_qty) : null,
        b.system_qty != null ? Number(b.system_qty) : null,
      ),
      render: (v: any, r: StockCheckItem) => {
        if (r.snapshot_live) {
          return (
            <div style={{ lineHeight: 1.2 }}>
              <div style={{ color: '#0284c7', fontWeight: 500 }}>{v != null ? Number(v).toFixed(2) : '-'}</div>
              <div><span className="sc-snap-badge">实时</span></div>
            </div>
          )
        }
        const snapTime = r.system_qty_time || activeCheck?.created_at
        return (
          <div style={{ lineHeight: 1.2 }}>
            <div>{v != null ? Number(v).toFixed(2) : <span className="sc-diff-flat">—</span>}</div>
            {snapTime && <div className="sc-sub">{formatDateTime(snapTime)}</div>}
          </div>
        )
      },
    },
    {
      title: '即时库存', dataIndex: 'live_qty', width: 112, align: 'right' as const,
      sorter: (a: StockCheckItem, b: StockCheckItem) => nullsLast(
        a.live_qty != null ? Number(a.live_qty) : null,
        b.live_qty != null ? Number(b.live_qty) : null,
      ),
      render: (v: any) => v != null ? (
        <span>{Number(v).toFixed(2)}<Tooltip title="scm_inventory 实时值"><span className="sc-live-dot" /></Tooltip></span>
      ) : <span className="sc-diff-flat">—</span>,
    },
    {
      title: '实盘录入', dataIndex: 'actual_qty', width: 150, align: 'right' as const,
      sorter: (a: StockCheckItem, b: StockCheckItem) => nullsLast(
        a.actual_qty != null ? Number(a.actual_qty) : null,
        b.actual_qty != null ? Number(b.actual_qty) : null,
      ),
      render: (_: any, r: StockCheckItem) => {
        const recentMark = hasRecentMark(r)
        const names = (presenceByItem[r.id] || []).map((x) => x.name)
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {!recentMark && (
              <span className={`sc-input${isRowDirty(r) ? ' sc-input-edited' : ''}`}>
                <InputNumber
                  id={`sc-actual-${r.id}`}
                  size="small"
                  min={0}
                  step={0.01}
                  style={{ width: 96 }}
                  placeholder="录入"
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
              </span>
            )}
            {recentMark && (
              <Tooltip title={
                <div style={{ lineHeight: 1.9 }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>近期已盘 · 免盘</div>
                  <div>盘点单：{r.recent_checked_check_no}</div>
                  {r.recent_checked_date && <div>盘点日期：{r.recent_checked_date}</div>}
                  <div>物料：{r.material_code || '—'}{r.material_name ? ` · ${r.material_name}` : ''}</div>
                  <div>仓库：{r.wh_name || '(未入库)'}</div>
                  {r.system_qty != null && <div>快照数量：{Number(r.system_qty).toFixed(2)}</div>}
                  <div style={{ opacity: 0.72, marginTop: 2 }}>近期已盘默认免盘，如需重新清点请点「重盘」</div>
                </div>
              }>
                <ScTag variant="done">近期已盘</ScTag>
              </Tooltip>
            )}
            {recentMark && !readonly && (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => handleForceRecount(r)}>重盘</Button>
            )}
            {names.length > 0 && (
              <Tooltip title={`${names.join('、')} 正在编辑此行`}>
                <span className='sc-note' style={{ whiteSpace: 'nowrap', color: '#d97706' }}>{names.join('、')}</span>
              </Tooltip>
            )}
          </div>
        )
      },
    },
    {
      title: <span data-tour="stock-check-diff">差异</span>, dataIndex: 'diff_qty', width: 104, align: 'right' as const,
      sorter: (a: StockCheckItem, b: StockCheckItem) => nullsLast(
        a.diff_qty != null ? Number(a.diff_qty) : null,
        b.diff_qty != null ? Number(b.diff_qty) : null,
      ),
      render: (v: any) => renderDiff(v),
    },
    {
      title: '盘点人', dataIndex: 'checked_by', width: 132,
      sorter: (a: StockCheckItem, b: StockCheckItem) => (a.checked_by || '').localeCompare(b.checked_by || ''),
      filters: checkerFilterOptions,
      onFilter: (v: any, r: StockCheckItem) => r.checked_by === v,
      render: (_: any, r: StockCheckItem) => {
        if (!r.checked_by && !r.checked_at) return <span className="sc-diff-flat">—</span>
        return (
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {r.checked_by && (
                <span className="sc-avatar-sm" style={{ background: avatarColor(r.checked_by) }}>{r.checked_by.charAt(0)}</span>
              )}
              <span>{r.checked_by || '—'}</span>
            </div>
            {r.checked_at && <div className="sc-sub">{formatDateTime(r.checked_at)}</div>}
          </div>
        )
      },
    },
    {
      title: '操作', key: 'op', width: 130, fixed: 'right' as const,
      render: (_: any, r: StockCheckItem) => {
        const recentMark = hasRecentMark(r)
        const canRemove = !readonly
          && (activeCheck?.check_type === 'manual' || activeCheck?.check_type === 'order')
          && (activeCheck.status === 'in_progress' || activeCheck.status === 'open')
          && r.is_checked === 0
          && r.actual_qty == null
        return (
          <span className="sc-row-act">
            {!readonly && r.system_qty != null && !recentMark && (
              <Tooltip title={`按库存数 ${Number(r.system_qty)} 盘点(差异 0)并立即保存`}>
                <Button type="link" size="small" onClick={() => handleMarkEven(r)}>盘平</Button>
              </Tooltip>
            )}
            <Tooltip title="查看该物料被哪些盘点单盘点过">
              <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => openMaterialHistory(r)} />
            </Tooltip>
            {canRemove && (
              <Tooltip title="移除该明细(已录入数据的行禁删)">
                <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => handleRemoveItem(r)} />
              </Tooltip>
            )}
          </span>
        )
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [readonly, activeCheck, presenceByItem, isRowDirty, handleEditingFocus, handleEditingBlur, updateItem, handleForceRecount, handleMarkEven, openMaterialHistory, handleRemoveItem, materialFilterOptions, whFilterOptions, checkerFilterOptions, nullsLast])

  if (!activeCheck) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: 40 }}>
          {loading ? <Spin /> : (
            <>
              <Empty description="盘点单不存在或加载失败" />
              <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/stock-check')}>返回列表</Button>
            </>
          )}
        </div>
      </Card>
    )
  }

  const typeTag = checkTypeTag(activeCheck.check_type, activeCheck.source)
  const coveredProducts = activeCheck.covered_products || []
  const isOrder = activeCheck.check_type === 'order'

  const statCards = [
    {
      accent: '#64748b', accentBg: '#f1f5f9', icon: <AppstoreOutlined />,
      label: '应盘物料',
      value: <span>{stats.total}</span>,
      valueStyle: undefined as CSSProperties | undefined,
    },
    {
      accent: '#16a34a', accentBg: '#f0fdf4', icon: <CheckCircleOutlined />,
      label: '已盘',
      value: (
        <span style={{ whiteSpace: 'nowrap' }}>
          {stats.checked}
          {stats.recent > 0 && (
            <Tooltip title={`${stats.recent} 行近期已盘（免盘），默认无需再盘；口径与后端统计一致`}>
              <small style={{ fontSize: 12, fontWeight: 500, color: '#d97706', marginLeft: 5 }}>含免盘 {stats.recent}</small>
            </Tooltip>
          )}
        </span>
      ),
      valueStyle: { color: '#16a34a' },
    },
    {
      accent: '#d97706', accentBg: '#fffbeb', icon: <ClockCircleOutlined />,
      label: '未盘',
      value: <span>{stats.unchecked}</span>,
      valueStyle: { color: '#d97706' },
    },
    {
      accent: '#16a34a', accentBg: '#f0fdf4', icon: <ArrowUpOutlined />,
      label: '盘盈',
      value: <span>+{stats.gain} <small>行</small></span>,
      valueStyle: { color: '#16a34a' },
    },
    {
      accent: '#dc2626', accentBg: '#fef2f2', icon: <ArrowDownOutlined />,
      label: '盘亏',
      value: <span>−{stats.loss} <small>行</small></span>,
      valueStyle: { color: '#dc2626' },
    },
    {
      accent: '#5b5bd6', accentBg: '#eef0fe', icon: <BarsOutlined />,
      label: '总差异',
      value: <span>{stats.totalDiff > 0 ? '+' : stats.totalDiff < 0 ? '−' : ''}{Math.abs(stats.totalDiff)}</span>,
      valueStyle: stats.totalDiff > 0 ? { color: '#16a34a' } : stats.totalDiff < 0 ? { color: '#dc2626' } : undefined,
    },
  ]

  return (
    <div
      className="sc-page"
      style={
        fullscreen
          ? {
              position: 'fixed', inset: 0, zIndex: 9999,
              background: '#f8fafc',
              padding: '10px 20px 14px',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }
          : {
              // 整页收敛在视口内（窗口不出现滚动条），仅明细表内部滚动
              height: 'calc(100vh - 104px)',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }
      }
    >
      {/* ===== 信息头卡 ===== */}
      {!fullscreen && (
        <Card styles={{ body: { padding: '16px 20px' } }} style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/stock-check')}>返回</Button>
          <ScTag variant={STATUS_MAP[activeCheck.status || '']?.variant || 'wait'}>
            {STATUS_MAP[activeCheck.status || '']?.label || activeCheck.status}
          </ScTag>
          <ScTag variant={typeTag.variant}>{typeTag.label}盘点</ScTag>
          {(activeCheck.co_checkers || []).length > 0 && (
            <ScTag variant="plain">
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />
              协同盘点
            </ScTag>
          )}
          {activeCheck.can_edit === false && <ScTag variant="warn">只读（无修改权限）</ScTag>}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
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
            <Button danger ghost icon={<StopOutlined />} disabled={readonly} onClick={handleCancel}>取消盘点</Button>
          </span>
        </div>
        <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div className="sc-meta-k">关联订单</div>
            <div style={{ fontWeight: 500 }}>
              {activeCheck.order_no ? (
                <Button type="link" size="small" className="sc-mono" style={{ padding: 0, fontWeight: 500 }} onClick={() => navigate(`/orders/${activeCheck.order_no}`)}>
                  {activeCheck.order_no}
                </Button>
              ) : <span className="sc-diff-flat">—</span>}
            </div>
          </div>
          <div>
            <div className="sc-meta-k">覆盖产品</div>
            {coveredProducts.length > 0 ? (
              <Tooltip title={coveredProducts.map((p) => `${p.product_code || '—'}${p.bom_no ? ` (${p.bom_no})` : ''}`).join('、')}>
                <span style={{ fontWeight: 500, cursor: 'default' }}>
                  {coveredProducts.length} 个产品
                  {isOrder && <span className="sc-note" style={{ marginLeft: 6 }}>工具栏可按产品筛选</span>}
                </span>
              </Tooltip>
            ) : <span className="sc-diff-flat">—</span>}
          </div>
          <div>
            <div className="sc-meta-k">创建人</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
              {activeCheck.created_by && (
                <span className="sc-avatar-sm" style={{ background: avatarColor(activeCheck.created_by) }}>
                  {activeCheck.created_by.charAt(0)}
                </span>
              )}
              {activeCheck.created_by || '—'}
            </div>
          </div>
          <div>
            <div className="sc-meta-k">创建时间</div>
            <div style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{formatDateTime(activeCheck.created_at)}</div>
          </div>
          <div>
            <div className="sc-meta-k">协同人</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
              <AvatarStack users={activeCheck.co_checkers || []} />
              {readonly ? null : (
                <Button type="link" size="small" style={{ padding: 0 }} onClick={openCoPicker}>管理</Button>
              )}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          {!readonly && isOrder && (activeCheck.status === 'in_progress' || activeCheck.status === 'open') && (
            <Button type="link" size="small" onClick={handleRefreshBom}>补入子BOM物料</Button>
          )}
          {!readonly && (activeCheck.status === 'in_progress' || activeCheck.status === 'open') && items.some((it) => it.wh_id == null) && (
            <Button type="link" size="small" onClick={handleRefreshWarehouses}>刷新仓库</Button>
          )}
          {!readonly && activeCheck.check_type === 'manual' && (activeCheck.status === 'in_progress' || activeCheck.status === 'open') && (
            <Button type="link" size="small" icon={<PlusOutlined />} onClick={() => setAddPickerOpen(true)}>添加物料</Button>
          )}
        </div>
        </Card>
      )}

      {/* ===== SSE 协同提示条 ===== */}
      {!fullscreen && (
      <div
        className="sc-sync-bar"
        style={syncBanner ? { background: '#fffbeb', borderColor: '#fde68a', color: '#b45309' } : undefined}
      >
        {!syncBanner && syncConnected && <span className="sc-live-dot" />}
        {syncBanner ? (
          <span style={{ color: '#b45309', fontWeight: 500 }}>{syncBanner}</span>
        ) : syncConnected ? (
          onlineNames.length > 0 ? (
            <span><b>{onlineNames.join('、')}</b> 正在盘点同单物料，行变更实时同步 · 在线 {onlineNames.length} 人</span>
          ) : (
            <span>协同盘点已连接 · 数据实时同步</span>
          )
        ) : (
          <span style={{ color: '#b45309' }}>已断开，重连中…</span>
        )}
        {!syncBanner && (
          <span className="sc-note" style={{ marginLeft: 'auto', color: '#64748b', flexShrink: 0 }}>
            版本 v{activeCheck.version ?? '-'} · 乐观锁保护
          </span>
        )}
      </div>
      )}

      {/* ===== 进度卡带 ===== */}
      {!fullscreen && (
        <Row gutter={[10, 10]} style={{ marginBottom: 12 }}>
          {statCards.map((c) => (
            <Col key={c.label} xs={12} md={8} xl={4}>
              <div className="sc-stat-card slim" style={{ '--accent': c.accent, '--accent-bg': c.accentBg, height: '100%' } as CSSProperties}>
                <div className="sc-stat-icon">{c.icon}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="sc-stat-label">{c.label}</div>
                  <div className="sc-stat-value" style={{ ...c.valueStyle, whiteSpace: 'nowrap' }}>{c.value}</div>
                </div>
              </div>
            </Col>
          ))}
        </Row>
      )}

      {/* ===== K3 回写卡片（已完结盘点单 · 台账「K3 回写」行操作锚点 #k3-writeback） ===== */}
      {!fullscreen && activeCheck?.status === 'completed' && (() => {
        const wbs = wbOverview?.writebacks || []
        const skippedItems = wbOverview?.skipped_items ?? []
        const loaded = wbOverview != null
        // 加载中:不渲染任何回写卡片(原页面 area 留空),避免把"加载未完成"误判为"盘平"
        if (wbLoading && !loaded) return null
        // 加载完成且零数据(无回写记录 + 无跳过行):完全盘平 → 轻量绿框确认
        if (loaded && wbs.length === 0 && skippedItems.length === 0) {
          return (
            <Card size="small" id="k3-writeback" style={{ marginBottom: 12 }}>
              <Alert type="success" showIcon
                message="已盘平，无盘差行，无需回写 K3"
                description="盘差行（diff≠0 且关联仓库）才会按（类型×仓库）分组生成 K3 未审核单据；全部行 actual = snapshot 时不生成任何单据。" />
            </Card>
          )
        }
        // 加载完成 + 有跳过行(无仓库盘差) + 零回写记录:有盘差但都被跳过
        if (loaded && wbs.length === 0) {
          return (
            <Card size="small" title="K3 回写" id="k3-writeback" style={{ marginBottom: 12 }}>
              <Alert type="warning" showIcon style={{ marginBottom: 8 }}
                message={`${skippedItems.length} 行盘差物料未关联仓库，未生成 K3 单据`}
                description={skippedItems.map((s, i) => (
                  <span key={i}>
                    {s.material_code || s.material_name || '-'}（差异 {s.diff_qty}）{i < skippedItems.length - 1 ? '、' : ''}
                  </span>
                ))} />
              <Alert type="info" showIcon message="无可生成的 K3 单据：盘差行均因缺少仓库而被跳过。关联仓库后重新提交盘点可补生成。" />
            </Card>
          )
        }
        const pendingCount = wbs.filter((w) => w.status === 'pending').length
        const failedCount = wbs.filter((w) => w.status === 'failed').length
        const successCount = wbs.filter((w) => w.status === 'success').length
        const todoCount = pendingCount + failedCount
        return (
        <Card size="small" title="K3 回写" id="k3-writeback" style={{ marginBottom: 12 }}
          extra={
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Tag color="success">已生成 {successCount}</Tag>
              {pendingCount > 0 && <Tag color="warning">待写入 {pendingCount}</Tag>}
              {failedCount > 0 && <Tag color="error">失败 {failedCount}</Tag>}
              <Tooltip title="刷新回写状态">
                <Button size="small" icon={<ReloadOutlined />} loading={wbLoading}
                  onClick={() => activeCheck?.id && loadWritebacks(activeCheck.id)} />
              </Tooltip>
              {todoCount > 0 && (
                <Button size="small" type="primary" loading={wbRetrying} onClick={retryWritebacks}>
                  执行 K3 回写（{todoCount}）
                </Button>
              )}
            </span>
          }
        >
          <Alert type="info" showIcon style={{ marginBottom: 8 }}
            message="盘盈生成 K3 盘盈入库单、盘亏生成调拨单（调入库存检查不良仓）；单据为未审核状态，需仓管员在 K3 中审核后库存才会调整，并经 ERP 同步回流本系统。成功单据不会重复生成。" />
          {wbOverview && wbOverview.skipped_items.length > 0 && (
            <Alert type="warning" showIcon style={{ marginBottom: 8 }}
              message="以下盘差行无仓库信息，未生成 K3 单据"
              description={wbOverview.skipped_items.map((s, i) => (
                <span key={i}>
                  {s.material_code || s.material_name || '-'}（差异 {s.diff_qty}）{i < wbOverview.skipped_items.length - 1 ? '、' : ''}
                </span>
              ))} />
          )}
          {todoCount > 0 ? (
            <Table size="small" rowKey="id" loading={wbLoading}
              dataSource={wbOverview?.writebacks || []} pagination={false}
              columns={[
                {
                  title: '类型', dataIndex: 'bill_type', width: 110,
                  render: (v: string) => (v === 'gain' ? '盘盈入库单' : '盘亏调拨单'),
                },
                { title: '仓库', dataIndex: 'wh_name', width: 120, render: (v: string, r: StockCheckWriteback) => v || r.wh_code || r.wh_id },
                { title: '明细行数', dataIndex: 'item_count', width: 80 },
                { title: '数量合计', dataIndex: 'total_qty', width: 100 },
                {
                  title: '状态', dataIndex: 'status', width: 80,
                  render: (v: string) =>
                    v === 'success' ? <Tag color="success">已生成</Tag> :
                    v === 'failed' ? <Tag color="error">失败</Tag> :
                    <Tag color="default">待写入</Tag>,
                },
                { title: 'K3 单号', dataIndex: 'erp_bill_no', width: 120, render: (v: string) => v || '-' },
                {
                  title: '写入时间', dataIndex: 'written_at', width: 130,
                  render: (v: string) => (v ? <span className="sc-mono">{formatDateTime(v)}</span> : <span className="sc-diff-flat">—</span>),
                },
                {
                  title: '失败原因', dataIndex: 'error_msg', ellipsis: true,
                  render: (v: string) => v || '-',
                },
                {
                  title: '操作', key: 'op', width: 60,
                  render: (_v: unknown, r: StockCheckWriteback) =>
                    r.status === 'pending' ? (
                      <Button type="link" size="small" style={{ padding: 0 }} onClick={retryWritebacks}>写入</Button>
                    ) : r.status === 'failed' ? (
                      <Button type="link" size="small" style={{ padding: 0 }} onClick={retryWritebacks}>重试</Button>
                    ) : (
                      <span className="sc-diff-flat">—</span>
                    ),
                },
              ]} />
          ) : (
            <Alert type="success" showIcon
              message={`全部 ${successCount} 张 K3 单据已生成（未审核），待仓管员在 K3 中审核`}
              description={wbs
                .filter((w) => w.status === 'success' && w.erp_bill_no)
                .map((w) => `${w.bill_type === 'gain' ? '盘盈' : '盘亏调拨'} ${w.erp_bill_no}（${w.wh_name || w.wh_code || `仓库#${w.wh_id}`}）`)
                .join('　')} />
          )}
        </Card>
        );
      })()}

      {/* ===== 全屏模式 · 摘要条 ===== */}
      {fullscreen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/stock-check')}>返回</Button>
          <ScTag variant={STATUS_MAP[activeCheck.status || '']?.variant || 'wait'}>
            {STATUS_MAP[activeCheck.status || '']?.label || activeCheck.status}
          </ScTag>
          <ScTag variant={typeTag.variant}>{typeTag.label}盘点</ScTag>
          {(activeCheck.co_checkers || []).length > 0 && (
            <ScTag variant="plain">
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />
              协同盘点
            </ScTag>
          )}
          {activeCheck.can_edit === false && <ScTag variant="warn">只读（无修改权限）</ScTag>}
          <span className="sc-mono" style={{ fontWeight: 600 }}>{activeCheck.check_no}</span>
          {activeCheck.order_no && (
            <Button type="link" size="small" className="sc-mono" style={{ padding: 0 }} onClick={() => navigate(`/orders/${activeCheck.order_no}`)}>
              {activeCheck.order_no}
            </Button>
          )}
          <span className="sc-note" style={{ marginLeft: 'auto', flexShrink: 0 }}>ESC 或右上角按钮退出全屏</span>
        </div>
      )}

      {/* ===== 工具条 ===== */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="物料编码 / 名称 · 支持扫码"
          style={{ width: 230 }}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onPressEnter={handleSearchEnter}
        />
        {isOrder && productOptions.length > 0 && (
          <Select
            style={{ minWidth: 160, maxWidth: 360 }}
            popupMatchSelectWidth={false}
            value={productFilter}
            onChange={setProductFilter}
            options={[{ value: 'all', label: '全部产品' }, ...productOptions]}
          />
        )}
        <Select style={{ minWidth: 110 }} value={whFilter} onChange={setWhFilter} options={whOptions} />
        <Segmented
          value={segFilter}
          onChange={(v) => setSegFilter(v as SegKey)}
          options={[
            { label: `全部 ${segCounts.all}`, value: 'all' },
            { label: `未盘 ${segCounts.unchecked}`, value: 'unchecked' },
            { label: `已盘 ${segCounts.checked}`, value: 'checked' },
            { label: `仅差异 ${segCounts.diff}`, value: 'diff' },
          ]}
        />
        {!readonly && selectedItems.length > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#eef0fe', border: '1px solid #c6cbfa', borderRadius: 999, padding: '3px 6px 3px 12px', color: '#3f3f9f' }}>
            <Button size="small" onClick={handleBatchMarkEven}>
              按库存盘平 ({selectedItems.length})
            </Button>
            <Button size="small" ghost style={{ color: '#64748b', borderColor: '#e2e8f0' }} onClick={() => setSelectedKeys([])}>
              清除
            </Button>
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }} data-tour="stock-check-actions">
          <Tooltip title={fullscreen ? '退出全屏 (ESC)' : '全屏'}>
            <Button
              icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={() => setFullscreen((v) => !v)}
            >
              {fullscreen ? '退出全屏' : '全屏'}
            </Button>
          </Tooltip>
          <Button type="primary" icon={<CheckCircleOutlined />} disabled={readonly} onClick={handleComplete}>
            标记完成
          </Button>
        </span>
      </div>

      {/* ===== 明细表（占满剩余高度，表格内部滚动） ===== */}
      <div
        data-tour="stock-check-table"
        ref={attachDetailSection}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          // 底部预留空间，避免 fixed 保存条遮挡表格内容
          paddingBottom: dirtyItems.length > 0 ? 56 : 8,
        }}
      >
        <Card styles={{ body: { padding: 0, flex: 1, minHeight: 0 } }} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <Spin spinning={loading}>
              <Table
                rowKey="id"
                size="small"
                dataSource={tableItems}
                columns={columns as any}
                pagination={false}
                scroll={{ x: 1300, y: tableScrollY }}
              onChange={(_pagination, filters) => setColumnFilters(filters as Record<string, unknown>)}
              rowClassName={(r: StockCheckItem) => (r.actual_qty == null && !hasRecentMark(r) ? 'sc-unchecked' : '')}
              rowSelection={readonly ? undefined : {
                selectedRowKeys: selectedKeys,
                onChange: (keys: Key[]) => setSelectedKeys(keys),
              }}
              summary={() => {
                const rows = tableItems
                if (!rows.length) return null
                const checked = rows.filter((r) => r.is_checked === 1 || hasRecentMark(r)).length
                const actualSum = round2(rows.reduce((s, r) => s + (r.actual_qty != null ? Number(r.actual_qty) : 0), 0))
                const diffSum = round2(rows.reduce((s, r) => s + Number(r.diff_qty || 0), 0))
                const diffCell = (
                  <span className={diffSum > 0 ? 'sc-diff-up' : diffSum < 0 ? 'sc-diff-down' : 'sc-diff-flat'}>
                    {diffSum > 0 ? '+' : diffSum < 0 ? '−' : ''}{Math.abs(diffSum)}
                  </span>
                )
                return (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={5}>
                      <span style={{ color: '#94a3b8' }}>本页 {rows.length} 行（已盘 {checked} · 未盘 {rows.length - checked}）· 共 {items.length} 行</span>
                    </Table.Summary.Cell>
                    {readonly ? (
                      <>
                        {/* 无选择列：物料..实盘(0-4) 差异5 盘点人6 操作7 */}
                        <Table.Summary.Cell index={5} align="right">{diffCell}</Table.Summary.Cell>
                        <Table.Summary.Cell index={6} />
                        <Table.Summary.Cell index={7}>
                          <span className="sc-note">差异 = 实盘 − 快照</span>
                        </Table.Summary.Cell>
                      </>
                    ) : (
                      <>
                        {/* 有选择列：sel0 物料..即时(1-4) 实盘5 差异6 盘点人7 操作8 */}
                        <Table.Summary.Cell index={5} align="right">
                          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{actualSum}</span>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={6} align="right">{diffCell}</Table.Summary.Cell>
                        <Table.Summary.Cell index={7} />
                        <Table.Summary.Cell index={8}>
                          <span className="sc-note">差异 = 实盘 − 快照</span>
                        </Table.Summary.Cell>
                      </>
                    )}
                  </Table.Summary.Row>
                )
              }}
            />
            </Spin>
          </div>
        </Card>
      </div>

      {/* ===== sticky 保存条 ===== */}
      {dirtyItems.length > 0 && (
        <div className="sc-save-bar">
          <span className="sc-warn"><WarningOutlined />未保存 {dirtyItems.length} 项修改</span>
          <span className="sc-note">差异实时计算 · 保存后生效</span>
          <Button size="small" onClick={() => { if (checkIdNum != null) loadCheck(checkIdNum) }}>放弃修改</Button>
          <Button size="small" type="primary" icon={<CheckCircleOutlined />} loading={savingAll} disabled={readonly} onClick={saveAll}>
            保存全部
          </Button>
        </div>
      )}

      <Tour open={tourOpen} steps={tourSteps} onClose={handleTourClose} onFinish={handleTourClose} />

      {/* ===== 完结确认弹窗（K3 回写分组预览 · 完结并回写 / 仅完结） ===== */}
      {(() => {
        // source='k3' 的单后端永不回写(plan_writebacks 直接跳过)，不展示回写预览与按钮
        const wbAvailable = !writebackPreview.disabled && writebackPreview.bills.length > 0
        // 未盘行(未录实盘且非近期已盘免盘):完结后视为放弃盘点
        const uncheckedCount = items.filter(it => it.actual_qty == null && !hasRecentMark(it)).length
        return (
        <Modal
          open={completeOpen}
          title={`完结盘点 · ${activeCheck?.check_no ?? ''}`}
          width={600}
          maskClosable={false}
          onCancel={() => { if (!completing) setCompleteOpen(false) }}
          footer={
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ marginRight: 'auto', fontSize: 12, color: '#94a3b8' }}>回写失败不影响完结结果</span>
              {wbAvailable && (
                <Button loading={completing && completeMode === 'only'} disabled={completing && completeMode !== 'only'} onClick={() => doComplete(false)}>
                  仅完结，稍后回写
                </Button>
              )}
              <Button type="primary" icon={<CheckCircleOutlined />}
                loading={completing && completeMode === 'writeback'}
                disabled={completing && completeMode !== 'writeback'}
                onClick={() => doComplete(true)}>
                {wbAvailable ? '完结并回写 K3' : '完结'}
              </Button>
            </span>
          }
        >
          <div style={{ marginBottom: 12, color: '#475569' }}>
            应盘 <b>{activeCheck?.total_materials ?? '—'}</b> 项 · 已盘 <b>{activeCheck?.checked_materials ?? '—'}</b> 项 · 盘差 <b>{writebackPreview.diffRows}</b> 行（盈 {writebackPreview.gainRows} · 亏 {writebackPreview.lossRows}）· 完结后所有行不可再修改
          </div>
          {uncheckedCount > 0 && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }}
              message={`还有 ${uncheckedCount} 行未盘点`}
              description="完结后未盘行视为放弃盘点：不产生差异、不生成 K3 单据，且不可再录入。如需计入这些物料，请先完成盘点或点「重盘」。" />
          )}
          {wbAvailable ? (
            <>
              <div style={{ fontSize: 12.5, color: '#475569', fontWeight: 500, marginBottom: 6 }}>
                将按（单据类型 × 仓库）分组生成 <b style={{ color: '#0f172a' }}>{writebackPreview.bills.length} 张 K3 单据</b>（未审核）：
              </div>
              <Table size="small" rowKey="key" pagination={false} dataSource={writebackPreview.bills}
                columns={[
                  {
                    title: '单据类型', dataIndex: 'bill_type', width: 210,
                    render: (v: string) => (v === 'gain' ? '盘盈入库单（YADJ）' : '盘亏调拨单（CHG · 调入不良仓）'),
                  },
                  { title: '仓库', dataIndex: 'wh_label', width: 120 },
                  { title: '行数', dataIndex: 'count', width: 70, align: 'right' as const },
                  {
                    title: '数量合计', dataIndex: 'total', width: 100, align: 'right' as const,
                    render: (v: number) => (
                      <span style={{ fontWeight: 500, color: '#0f172a' }}>{v}</span>
                    ),
                  },
                ]} />
              {writebackPreview.skipped.length > 0 && (
                <Alert type="warning" showIcon style={{ marginTop: 10 }}
                  message={`${writebackPreview.skipped.length} 行盘差物料未关联仓库，不生成单据`}
                  description={writebackPreview.skipped.map((s, i) => (
                    <span key={i}>
                      {s.material_code || s.material_name || '-'}（差异 {s.diff}）{i < writebackPreview.skipped.length - 1 ? '、' : ''}
                    </span>
                  ))} />
              )}
              <Alert type="info" showIcon style={{ marginTop: 10 }}
                message="单据写入 K3 后为未审核状态，需仓管员在 K3 中审核后库存才会调整。若 K3 暂不可用或部分失败，完结不受影响，可稍后在本页「K3 回写」卡片重试（成功单据不会重复生成）。" />
            </>
          ) : (
            <Alert type="info" showIcon
              message={writebackPreview.disabled ? 'K3 导入单不回写（K3 单据已存在）。' : '无盘差行，完结后不生成 K3 单据。'} />
          )}
        </Modal>
        )
      })()}

      {/* ===== 弹层 ===== */}
      <MaterialPickerModal
        open={addPickerOpen}
        onCancel={() => setAddPickerOpen(false)}
        onConfirm={handleAddItemsToCheck}
        confirmLoading={creating}
        showRecentDays
      />

      <CoCheckerPickerModal
        open={coPickerOpen}
        initialIds={coPickerIds}
        onCancel={() => setCoPickerOpen(false)}
        onSave={handleSaveCoCheckers}
        saveLoading={coSaving}
      />

      <ConflictModal
        open={!!conflict}
        myDraft={conflict?.myDraft ?? null}
        serverVersion={conflict?.serverVersion ?? null}
        serverItem={conflict?.serverItem ?? null}
        serverChangedBy={conflict?.serverChangedBy ?? null}
        onOverwrite={handleConflictOverwrite}
        onDiscard={handleConflictDiscard}
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
              {
                title: '客户', dataIndex: 'customer', width: 140, ellipsis: true,
                render: (v: any) => v || '-',
              },
              {
                title: '状态', dataIndex: 'status', width: 90,
                render: (v: any) => <ScTag variant={STATUS_MAP[v]?.variant || 'wait'}>{STATUS_MAP[v]?.label || v}</ScTag>,
              },
              {
                title: '实盘数', dataIndex: 'actual_qty', width: 100, align: 'right' as const,
                render: (v: any) => v != null ? Number(v).toFixed(2) : '-',
              },
              {
                title: '完结时间', dataIndex: 'completed_at', width: 160,
                render: (v: any) => v ? formatDateTime(v) : '-',
              },
            ]}
            scroll={{ x: 1000 }}
          />
        )}
      </Drawer>
    </div>
  )
}
