import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  App,
  Button,
  Col,
  Input,
  Progress,
  Row,
  Table,
  Tooltip,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  AimOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import api, { materialApi } from '@/services/api'
import { formatDateTime } from '@/utils'
import { STATUS_MAP } from '../StockCheck/types'
import type { StockCheck, StockCheckItem, StockCheckAuditLog } from '../StockCheck/types'

const PAGE_SIZE = 20

const MONO: CSSProperties = { fontVariantNumeric: 'tabular-nums', letterSpacing: '0.01em' }

const TYPE_TAG: Record<string, { label: string; cls: string }> = {
  order: { label: '订单', cls: 'sc-tag-kit' },
  manual: { label: '手动', cls: 'sc-tag-wait' },
  quick: { label: '快捷', cls: 'sc-tag-purple' },
}

const AUDIT_TAG: Record<string, { label: string; cls: string }> = {
  pending: { label: '待抽检', cls: 'sca-audit-pending' },
  passed: { label: '已通过', cls: 'sca-audit-passed' },
  rejected: { label: '已发回', cls: 'sca-audit-rejected' },
}

const ACTION_LABEL: Record<string, string> = {
  pass: '抽检通过',
  pass_exemption: '免检通过',
  reject: '发回重填',
  flag: '过程标记',
}

type TabKey = 'progress' | 'pending' | 'appeal' | 'done'

const TAB_KEYS = ['progress', 'pending', 'appeal', 'done'] as const
const isTabKey = (v: string | null): v is TabKey => v !== null && (TAB_KEYS as readonly string[]).includes(v)

interface HistoryEntry {
  audit_qty: number
  matches?: number | null
  actual_qty_snapshot?: number | null
}

function fmtNum(v: number | null | undefined): string {
  return v == null ? '—' : String(Number(v))
}

function typeTagOf(r: { check_type?: string | null; source?: string | null }) {
  if (r.source === 'k3') return <span className="sc-tag sc-tag-amber">K3 导入</span>
  const t = TYPE_TAG[r.check_type || '']
  return t ? <span className={`sc-tag ${t.cls}`}>{t.label}</span> : <span className="sc-tag sc-tag-plain">{r.check_type || '—'}</span>
}

function auditTagOf(s?: string | null) {
  if (!s) return <span style={{ color: '#cbd5e1' }}>—</span>
  const t = AUDIT_TAG[s]
  return t ? (
    <span className={`sc-tag ${t.cls}`}><span className="dot" />{t.label}</span>
  ) : (
    <span className="sc-tag sc-tag-plain">{s}</span>
  )
}

function renderDiff(v: number | null | undefined) {
  if (v == null) return <span style={{ color: '#cbd5e1' }}>—</span>
  const n = Number(v)
  if (n === 0) return <span style={{ ...MONO, color: '#94a3b8' }}>0</span>
  return (
    <span style={{ ...MONO, color: n > 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
      {n > 0 ? `+${n}` : n}
    </span>
  )
}

/** 通过确认弹窗的 K3 分组预览（与后端 plan_writebacks 同口径：盘差行按 盈/亏 × 仓库 分组） */
function wbGroupsOf(items: StockCheckItem[] | null | undefined) {
  const groups = new Map<string, { gain: boolean; wh: string; count: number; total: number }>()
  for (const it of items || []) {
    const diff = Number(it.diff_qty ?? 0)
    if (diff === 0 || it.actual_qty == null) continue
    const gain = diff > 0
    const wh = it.wh_name || '(未关联仓库)'
    const key = `${gain ? 'gain' : 'loss'}|${wh}`
    const g = groups.get(key) || { gain, wh, count: 0, total: 0 }
    g.count += 1
    g.total += Math.abs(diff)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => Number(b.gain) - Number(a.gain) || a.wh.localeCompare(b.wh))
}

function errText(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail
  return (
    e?._apiData?.message
    || (typeof detail === 'string' ? detail : detail?.message)
    || e?.message
    || fallback
  )
}

export default function StockCheckAuditPage() {
  const { message, modal } = App.useApp()

  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState<TabKey>(() => {
    const t = searchParams.get('tab')
    return isTabKey(t) ? t : 'pending'
  })
  const [rows, setRows] = useState<StockCheck[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [appliedKeyword, setAppliedKeyword] = useState('')

  // KPI 队列计数（轻量请求 page_size=1 取 total）
  const [kpi, setKpi] = useState<{ pending: number; progress: number; rejected: number; done: number; appeal: number }>({
    pending: 0, progress: 0, rejected: 0, done: 0, appeal: 0,
  })

  // 复点抽屉
  const [detail, setDetail] = useState<StockCheck | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [appealLoading, setAppealLoading] = useState(false)
  const [auditQtys, setAuditQtys] = useState<Record<number, number | null>>({})
  const [historyMap, setHistoryMap] = useState<Record<number, HistoryEntry>>({})
  const [auditLogs, setAuditLogs] = useState<StockCheckAuditLog[]>([])

  // 抽屉明细行筛选(长列表定位:全部/已盘/差异/问题行)
  const [dwFilter, setDwFilter] = useState<'all' | 'counted' | 'diff' | 'failed' | 'appeal'>('all')

  // 行勾选(问题行标记;过程标记与终检发回共用) + footer 原因输入
  const [pickedIds, setPickedIds] = useState<number[]>([])
  const [footComment, setFootComment] = useState('')
  // footer 展开的动作(null=收起;reject=发回原因;flag=标记说明)
  const [footAction, setFootAction] = useState<'reject' | 'flag' | null>(null)
  const [acting, setActing] = useState(false)

  // 表格视口内滚动:直接测量表体元素距视口顶部的位置(自适应 KPI 换行/字号缩放),页面不出现滚动条
  const tableWrapRef = useRef<HTMLDivElement>(null)
  const [tableY, setTableY] = useState(420)
  useEffect(() => {
    const calc = () => {
      const body = tableWrapRef.current?.querySelector('.ant-table-body') as HTMLElement | null
      if (!body) return
      const top = body.getBoundingClientRect().top
      // 底部预留: 分页条(含上下 margin ≈56) + Content 下内距(32) + 少量缓冲
      setTableY(Math.max(220, window.innerHeight - top - 96))
    }
    calc()
    const t = window.setTimeout(calc, 60) // 首帧布局稳定后复核
    window.addEventListener('resize', calc)
    return () => { window.clearTimeout(t); window.removeEventListener('resize', calc) }
  }, [tab, loading])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, unknown> = {
        page,
        page_size: PAGE_SIZE,
        keyword: appliedKeyword || undefined,
      }
      if (tab === 'progress') {
        params.status = 'in_progress'
      } else if (tab === 'appeal') {
        // 复议待裁决队列:进行中且存在待裁决复议行
        params.status = 'in_progress'
        params.has_appeal = true
      } else if (tab === 'pending') {
        params.status = 'completed'
        params.audit_status = 'pending'
      } else {
        params.status = 'completed'
        // rejected 单发回后必为 in_progress（进行中队列呈现），此处仅 passed
        params.audit_status = 'passed'
      }
      const res: any = await api.get('/materials/stock-check/recent', { params })
      setRows(res.data?.items ?? [])
      setTotal(res.data?.total ?? 0)
    } catch {
    } finally {
      setLoading(false)
    }
  }, [tab, page, appliedKeyword])

  const loadKpi = useCallback(async () => {
    const q = async (p: Record<string, unknown>) => {
      try {
        const res: any = await api.get('/materials/stock-check/recent', { params: { page: 1, page_size: 1, ...p } })
        return Number(res.data?.total ?? 0)
      } catch {
        return 0
      }
    }
    const [pending, progress, rejected, done, appeal] = await Promise.all([
      q({ status: 'completed', audit_status: 'pending' }),
      q({ status: 'in_progress' }),
      q({ status: 'in_progress', audit_status: 'rejected' }),
      q({ status: 'completed', audit_status: 'passed' }),
      q({ status: 'in_progress', has_appeal: true }),
    ])
    setKpi({ pending, progress, rejected, done, appeal })
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadKpi()
  }, [loadKpi])

  // 深链指定队列(如通知点击 /stock-check-audit?tab=appeal);同页跳转不重挂载,需监听 searchParams
  useEffect(() => {
    const t = searchParams.get('tab')
    if (isTabKey(t) && t !== tab) {
      setTab(t)
      setPage(1)
    }
  }, [searchParams, tab])

  // Esc 关闭抽屉/弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!acting) {
        setAppealCheck(null)
        setDetail(null)
        setFootAction(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openDetail = useCallback(
    async (row: StockCheck) => {
      setDetailLoading(true)
      setAuditQtys({})
      setHistoryMap({})
      setAuditLogs([])
      setDwFilter('all')
      setFootComment('')
      try {
        const res: any = await materialApi.getStockCheck(row.id)
        const c: StockCheck = res.data
        setDetail(c)
        // 有待裁决复议 → 自动过滤到复议行(财务打开即为裁决视图),可切回「全部」
        const hasAppeal = (c.items || []).some((i) => i.appeal_status === 'pending')
        setDwFilter(hasAppeal ? 'appeal' : 'all')
        // 已标记的问题行默认勾选(过程标记/发回都以此为起点)
        setPickedIds((c.items || []).filter((i) => i.audit_failed === 1).map((i) => i.id))
        // 已处理单附带全量处置历史（时间线 + 只读复点展示）
        if (c.status === 'completed' && c.audit_status && c.audit_status !== 'pending') {
          try {
            const logsRes: any = await materialApi.getStockCheckAuditLogs(row.id)
            const logs: StockCheckAuditLog[] = logsRes.data || []
            setAuditLogs(logs)
            const last = logs[logs.length - 1]
            const m: Record<number, HistoryEntry> = {}
            for (const it of last?.items || []) {
              m[it.item_id] = {
                audit_qty: it.audit_qty,
                matches: it.matches,
                actual_qty_snapshot: it.actual_qty_snapshot,
              }
            }
            setHistoryMap(m)
          } catch {
          }
        }
      } catch (e: any) {
        message.error(errText(e, '加载盘点单失败'))
        setDetail(null)
      } finally {
        setDetailLoading(false)
      }
    },
    [message],
  )

  const matchOf = useCallback(
    (i: StockCheckItem): boolean | null => {
      const q = auditQtys[i.id]
      if (q === undefined || q === null) return null
      if (i.actual_qty == null) return false
      return Number(q) === Number(i.actual_qty)
    },
    [auditQtys],
  )

  const mismatchIds = useMemo(() => {
    if (!detail?.items) return []
    return detail.items.filter((i) => matchOf(i) === false).map((i) => i.id)
  }, [detail, matchOf])

  const rdCount = useMemo(
    () => Object.values(auditQtys).filter((q) => q !== null && q !== undefined).length,
    [auditQtys],
  )
  const rdOk = useMemo(
    () => (detail?.items || []).filter((i) => matchOf(i) === true).length,
    [detail, matchOf],
  )

  const canFinalAudit = detail?.status === 'completed' && detail?.audit_status === 'pending'
  const canFlag = detail?.status === 'in_progress'
  const readonly = !(canFinalAudit || canFlag)

  const wbGroups = useMemo(() => wbGroupsOf(detail?.items), [detail])

  const buildAuditItems = useCallback(() => {
    return Object.entries(auditQtys)
      .filter(([, q]) => q !== null && q !== undefined)
      .map(([id, q]) => ({ item_id: Number(id), audit_qty: Number(q) }))
  }, [auditQtys])

  const doAudit = useCallback(
    async (action: 'pass' | 'exempt' | 'reject' | 'flag', extra?: { comment?: string; item_ids?: number[] }) => {
      if (!detail) return
      setActing(true)
      try {
        const res: any = await materialApi.auditStockCheck(detail.id, action, {
          comment: extra?.comment,
          item_ids: extra?.item_ids,
          audit_items: action === 'exempt' ? undefined : buildAuditItems(),
          expected_version: detail.version ?? undefined,
        })
        if (action === 'pass' || action === 'exempt') {
          const planned = res.data?.writeback_summary?.pending
          message.success(
            `已${action === 'pass' ? '抽检' : '免检'}通过${planned != null ? `，已计划 K3 回写 ${planned} 条` : ''}`,
          )
          setDetail(null)
        } else if (action === 'reject') {
          message.success('已发回重填，并通知盘点人')
          setDetail(null)
        } else {
          // 过程标记:单据仍在进行中,抽屉保持打开并原地刷新(标记已生效、可继续核对其余行)
          message.success(`已标记 ${extra?.item_ids?.length ?? 0} 行问题并通知盘点人`)
          const cur = detail
          setFootComment('')
          setFootAction(null)
          if (cur) void openDetail(cur)
        }
        void load()
        void loadKpi()
      } catch (e: any) {
        const code = e?.response?.data?.detail?.code ?? e?.response?.status
        if (code === 409) {
          message.warning('该盘点单已被处置或刚被修改，正在刷新')
          setDetail(null)
          void load()
        } else {
          message.error(errText(e, '操作失败'))
        }
      } finally {
        setActing(false)
      }
    },
    [detail, buildAuditItems, load, loadKpi, openDetail, message],
  )

  // 通过:无不符直接生效;有不符弹确认(唯一保留的确认弹窗)
  const handlePassClick = () => {
    if (mismatchIds.length > 0) {
      modal.confirm({
        title: '存在复点不一致行',
        content: `有 ${mismatchIds.length} 行复点数与实盘数不一致。仍要通过吗？通过后将按盘点人实盘数计划 K3 回写，不一致记录将留档。`,
        okText: '仍要通过',
        cancelText: '再检查',
        onOk: () => doAudit('pass'),
      })
    } else {
      void doAudit('pass')
    }
  }

  // 发回重填(终检):原因必填;勾选行 = 问题行(可空,纯原因发回也允许)
  const submitReject = async () => {
    if (!footComment.trim()) {
      message.warning('发回重填必须填写原因')
      return
    }
    await doAudit('reject', {
      comment: footComment.trim(),
      item_ids: pickedIds,
    })
  }

  // 过程标记:原因可选;勾选行至少一行
  const submitFlag = async () => {
    if (pickedIds.length === 0) {
      message.warning('请先勾选要标记的问题行')
      return
    }
    await doAudit('flag', {
      comment: footComment.trim() || undefined,
      item_ids: pickedIds,
    })
  }

  // 发回重填入口(终检 footer):展开原因输入并自动聚焦
  const startReject = () => {
    setFootAction('reject')
    // 下一帧聚焦,体验接近弹层
    window.setTimeout(() => {
      document.getElementById('sca-foot-reason')?.focus()
    }, 50)
  }

  // ===== 复议裁决(独立弹窗,不复用复点抽屉) =====
  const [appealCheck, setAppealCheck] = useState<StockCheck | null>(null)
  const [appealLogs, setAppealLogs] = useState<StockCheckAuditLog[]>([])
  const [appealComment, setAppealComment] = useState('')

  const openAppealResolve = useCallback(async (row: StockCheck) => {
    setAppealLoading(true)
    setAppealComment('')
    try {
      const res: any = await materialApi.getStockCheck(row.id)
      const c: StockCheck = res.data
      setAppealCheck(c)
      try {
        const logsRes: any = await materialApi.getStockCheckAuditLogs(row.id)
        setAppealLogs(logsRes.data || [])
      } catch {
        setAppealLogs([])
      }
    } catch (e: any) {
      message.error(errText(e, '加载盘点单失败'))
    } finally {
      setAppealLoading(false)
    }
  }, [message])

  // 财务在标记轮次的复点数(最近一轮 flag/reject),供裁决时对照
  const appealQtyMap = useMemo(() => {
    const m = new Map<number, { audit_qty: number; matches: number | null; snapshot: number | null }>()
    for (const log of appealLogs) {
      if (log.action !== 'flag' && log.action !== 'reject') continue
      m.clear()
      for (const it of log.items || []) {
        m.set(it.item_id, {
          audit_qty: Number(it.audit_qty),
          matches: it.matches ?? null,
          snapshot: it.actual_qty_snapshot != null ? Number(it.actual_qty_snapshot) : null,
        })
      }
    }
    return m
  }, [appealLogs])

  const appealPendingRows = useMemo(
    () => (appealCheck?.items || []).filter((i) => i.appeal_status === 'pending'),
    [appealCheck],
  )

  const resolveAppeal = useCallback(async (itemId: number, accept: boolean) => {
    if (!appealCheck) return
    setActing(true)
    try {
      await materialApi.resolveStockCheckAppeal(appealCheck.id, {
        item_ids: [itemId],
        accept,
        comment: appealComment.trim() || undefined,
        expected_version: appealCheck.version ?? undefined,
      })
      message.success(accept ? '已支持复议：该行标记已撤销' : '已驳回复议：该行标记维持')
      const res: any = await materialApi.getStockCheck(appealCheck.id)
      setAppealCheck(res.data)
      const remaining = (res.data.items || []).filter((i: StockCheckItem) => i.appeal_status === 'pending').length
      if (remaining === 0) {
        setAppealCheck(null)
        void load()
        void loadKpi()
      }
    } catch (e: any) {
      const code = e?.response?.data?.detail?.code ?? e?.response?.status
      if (code === 409) {
        message.warning('盘点单状态刚被修改，正在刷新')
        const res: any = await materialApi.getStockCheck(appealCheck.id)
        setAppealCheck(res.data)
      } else {
        message.error(errText(e, '裁决失败'))
      }
    } finally {
      setActing(false)
    }
  }, [appealCheck, appealComment, load, loadKpi, message])

  const listRows = useMemo(
    () => (tab === 'progress' ? rows.filter((r) => (r.checked_materials ?? 0) > 0) : rows),
    [rows, tab],
  )

  const progressCell = (r: StockCheck) => {
    const t = r.total_materials ?? 0
    const done = r.checked_materials ?? 0
    const pct = t > 0 ? Math.round((done / t) * 100) : 0
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
        <Progress percent={pct} size="small" showInfo={false} style={{ flex: 1, margin: 0 }} />
        <span style={MONO} className="sc-sub">{done}/{t}</span>
      </div>
    )
  }

  const listColumns: ColumnsType<StockCheck> = useMemo(() => {
    const openCol = (label: string, onClick?: (r: StockCheck) => void) => ({
      title: '',
      key: 'op',
      width: 150,
      render: (_v: any, r: StockCheck) => (
        <span className="sc-row-act" style={{ opacity: 1 }}>
          <a onClick={() => (onClick ? onClick(r) : void openDetail(r))}>{label}</a>
          {r.status === 'in_progress' && (
            <a href={`/stock-check/${r.id}`}>查看</a>
          )}
        </span>
      ),
    })
    if (tab === 'done') {
      return [
        {
          title: '盘点单号',
          dataIndex: 'check_no',
          width: 170,
          render: (v: string, r: StockCheck) => (
            <a style={{ ...MONO, fontWeight: 600 }} onClick={() => void openDetail(r)}>{v}</a>
          ),
        },
        { title: '类型', dataIndex: 'check_type', width: 90, render: (_v: any, r: StockCheck) => typeTagOf(r) },
        {
          title: '结论',
          dataIndex: 'audit_status',
          width: 130,
          render: (s: string | null) => auditTagOf(s),
        },
        {
          title: '处理人',
          dataIndex: 'audit_by',
          width: 110,
          render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>—</span>,
        },
        {
          title: '处理时间',
          dataIndex: 'audit_at',
          width: 140,
          render: (v: string | null) => (v ? <span style={MONO}>{formatDateTime(v)}</span> : '—'),
        },
        {
          title: '备注 / 原因',
          dataIndex: 'audit_comment',
          ellipsis: true,
          render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>—</span>,
        },
        openCol('处置时间线'),
      ]
    }
    if (tab === 'appeal') {
      return [
        {
          title: '盘点单号',
          dataIndex: 'check_no',
          width: 170,
          render: (v: string, r: StockCheck) => (
            <a style={{ ...MONO, fontWeight: 600 }} onClick={() => void openDetail(r)}>{v}</a>
          ),
        },
        { title: '类型', dataIndex: 'check_type', width: 90, render: (_v: any, r: StockCheck) => typeTagOf(r) },
        {
          title: '复议行数',
          dataIndex: 'pending_appeals',
          width: 90,
          align: 'right' as const,
          render: (v: number | null) => (
            <span className="sc-tag sca-audit-flag"><span className="dot" />{v ?? 0} 行</span>
          ),
        },
        {
          title: '最近申请原因',
          dataIndex: 'appeal_last_reason',
          ellipsis: true,
          render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>—</span>,
        },
        {
          title: '最近申请时间',
          dataIndex: 'appeal_last_at',
          width: 140,
          render: (v: string | null) => (v ? <span style={MONO}>{formatDateTime(v)}</span> : '—'),
        },
        {
          title: '盘点人',
          dataIndex: 'created_by',
          width: 100,
          render: (v: string | null) => v || '—',
        },
        openCol('去裁决', (r) => void openAppealResolve(r)),
      ]
    }
    const cols: ColumnsType<StockCheck> = [
      {
        title: '盘点单号',
        dataIndex: 'check_no',
        width: 170,
        render: (v: string, r: StockCheck) => (
          <a style={{ ...MONO, fontWeight: 600 }} onClick={() => void openDetail(r)}>{v}</a>
        ),
      },
      { title: '类型', dataIndex: 'check_type', width: 90, render: (_v: any, r: StockCheck) => typeTagOf(r) },
      {
        title: '订单号',
        dataIndex: 'order_no',
        width: 150,
        ellipsis: true,
        render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>—</span>,
      },
      { title: '已盘进度', key: 'prog', width: 150, render: (_v: any, r: StockCheck) => progressCell(r) },
      { title: '盘差', key: 'diff', width: 90, align: 'right' as const, render: (_v: any, r: StockCheck) => renderDiff(r.total_diff_qty) },
    ]
    if (tab === 'progress') {
      cols.push(
        {
          title: '抽检状态',
          dataIndex: 'audit_status',
          width: 100,
          render: (s: string | null) => auditTagOf(s),
        },
        {
          title: '盘点人',
          dataIndex: 'created_by',
          width: 100,
          render: (v: string | null) => v || '—',
        },
        {
          title: '更新时间',
          dataIndex: 'updated_at',
          width: 130,
          render: (v: string | null) => (v ? <span style={MONO}>{formatDateTime(v)}</span> : '—'),
        },
        openCol('过程抽检'),
      )
    } else {
      cols.push(
        {
          title: '完结时间',
          dataIndex: 'completed_at',
          width: 130,
          render: (v: string | null) => (v ? <span style={MONO}>{formatDateTime(v)}</span> : '—'),
        },
        {
          title: '盘点人',
          dataIndex: 'created_by',
          width: 100,
          render: (v: string | null) => v || '—',
        },
        openCol('开始抽检'),
      )
    }
    return cols
  }, [tab, openDetail])

  const kpiCards = [
    {
      accent: '#d97706', accentBg: '#fffbeb', icon: <SafetyCertificateOutlined />,
      label: '待抽检', value: kpi.pending, unit: '单',
      delta: <span className="sc-stat-delta" style={{ color: '#d97706' }}>抽检通过后才计划 K3 回写</span>,
    },
    {
      accent: '#dc2626', accentBg: '#fef2f2', icon: <AimOutlined />,
      label: '发回待重填', value: kpi.rejected, unit: '单',
      delta: <span className="sc-stat-delta" style={{ color: '#dc2626' }}>进行中 · 问题行待修正</span>,
    },
    {
      accent: '#0284c7', accentBg: '#f0f9ff', icon: <UndoOutlined />,
      label: '进行中 · 可过程抽检', value: kpi.progress, unit: '单',
      delta: <span className="sc-stat-delta flat">对已盘行随时复点纠错</span>,
    },
    {
      accent: '#16a34a', accentBg: '#f0fdf4', icon: <CheckCircleOutlined />,
      label: '已处理', value: kpi.done, unit: '单',
      delta: <span className="sc-stat-delta up">终检结论与复点记录留档</span>,
    },
  ]

  const drawerItems = detail?.items || []

  const dwFiltered = useMemo(() => {
    if (dwFilter === 'counted') return drawerItems.filter((i) => i.actual_qty != null)
    if (dwFilter === 'diff') return drawerItems.filter((i) => i.actual_qty != null && Number(i.diff_qty ?? 0) !== 0)
    if (dwFilter === 'failed') return drawerItems.filter((i) => i.audit_failed === 1)
    if (dwFilter === 'appeal') return drawerItems.filter((i) => i.appeal_status === 'pending')
    return drawerItems
  }, [drawerItems, dwFilter])
  const dwCounts = useMemo(() => ({
    all: drawerItems.length,
    counted: drawerItems.filter((i) => i.actual_qty != null).length,
    diff: drawerItems.filter((i) => i.actual_qty != null && Number(i.diff_qty ?? 0) !== 0).length,
    failed: drawerItems.filter((i) => i.audit_failed === 1).length,
    appeal: drawerItems.filter((i) => i.appeal_status === 'pending').length,
  }), [drawerItems])

  const drawerRdCell = (i: StockCheckItem) => {
    if (readonly) {
      const h = historyMap[i.id]
      if (!h) return <span style={{ color: '#cbd5e1' }}>—</span>
      return (
        <div className="sca-rd-cell">
          <div className="v">{fmtNum(h.audit_qty)}</div>
          <div className={`cmp ${h.matches ? 'ok' : 'bad'}`}>{h.matches ? '一致' : '不符'}</div>
        </div>
      )
    }
    const q = auditQtys[i.id]
    const disabled = i.actual_qty == null
    return (
      <input
        className={`sca-rd-input${q !== undefined && q !== null ? ' filled' : ''}`}
        value={q ?? ''}
        placeholder={disabled ? '未盘点' : '复点'}
        disabled={disabled}
        inputMode="decimal"
        onChange={(e) => {
          const raw = e.target.value.trim()
          if (raw === '') {
            setAuditQtys((m) => ({ ...m, [i.id]: null }))
          } else if (!isNaN(Number(raw))) {
            const n = Number(raw)
            setAuditQtys((m) => ({ ...m, [i.id]: n }))
            // 复点与盘点人实盘不一致 → 自动勾选为问题行(可手动取消)
            if (i.actual_qty != null && n !== Number(i.actual_qty)) {
              setPickedIds((s) => (s.includes(i.id) ? s : [...s, i.id]))
            }
          }
        }}
      />
    )
  }

  const drawerVerdictCell = (i: StockCheckItem) => {
    if (readonly) {
      const h = historyMap[i.id]
      if (!h) return <span className="sca-verdict none">—</span>
      return h.matches
        ? <span className="sca-verdict ok">✓ 一致</span>
        : <span className="sca-verdict bad">✗ 不符</span>
    }
    const m = matchOf(i)
    if (m === null) return <span className="sca-verdict none">—</span>
    if (m) return <span className="sca-verdict ok">✓ 一致</span>
    const q = auditQtys[i.id]
    const d = i.actual_qty != null && q != null ? Number(q) - Number(i.actual_qty) : null
    return <span className="sca-verdict bad">✗ 不符{d != null ? ` ${d > 0 ? '+' : ''}${d}` : ''}</span>
  }

  const switchTab = (t: TabKey) => {
    setTab(t)
    setPage(1)
    const next = new URLSearchParams(searchParams)
    if (t === 'pending') next.delete('tab')
    else next.set('tab', t)
    setSearchParams(next, { replace: true })
  }

  const queueMeta: Record<TabKey, { title: string; hint: string }> = {
    progress: { title: '进行中的盘点单', hint: '对已盘的行随时复点纠错，不打断盘点进度' },
    pending: { title: '待抽检', hint: '已完结、等待财务终检 · 通过后按（类型 × 仓库）计划 K3 单据' },
    appeal: { title: '复议待裁决', hint: '盘点人对问题行提出异议 · 支持则撤销标记认可盘点数，驳回则维持标记' },
    done: { title: '已处理', hint: '终检结论与复点记录全程留档 · 点击单号查看处置时间线' },
  }

  return (
    <div className="sc-page">
      {/* ===== 队列切换 + 搜索 ===== */}
      <div className="sc-toolbar">
        <div className="sca-seg">
          <button className={tab === 'progress' ? 'on' : ''} onClick={() => switchTab('progress')}>
            进行中 · 过程抽检 <span className="n">{kpi.progress}</span>
          </button>
          <button className={tab === 'pending' ? 'on' : ''} onClick={() => switchTab('pending')}>
            待抽检 <span className={`n${kpi.pending > 0 ? ' hot' : ''}`}>{kpi.pending}</span>
          </button>
          <button className={tab === 'appeal' ? 'on' : ''} onClick={() => switchTab('appeal')}>
            复议待裁决 <span className={`n${kpi.appeal > 0 ? ' hot' : ''}`} style={kpi.appeal > 0 ? { background: '#dbeafe', color: '#1d4ed8' } : undefined}>{kpi.appeal}</span>
          </button>
          <button className={tab === 'done' ? 'on' : ''} onClick={() => switchTab('done')}>
            已处理 <span className="n">{kpi.done}</span>
          </button>
        </div>
        <Input
          className="sc-search"
          style={{ width: 240 }}
          prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
          placeholder="盘点单号 / 订单号 / 盘点人"
          allowClear
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value)
            if (!e.target.value) {
              setAppliedKeyword('')
              setPage(1)
            }
          }}
          onPressEnter={() => { setAppliedKeyword(searchText.trim()); setPage(1) }}
        />
        <span className="sc-toolbar-hint">抽检通过后才计划 K3 回写 · 发回重填将通知盘点人</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => { void load(); void loadKpi() }}>刷新</Button>
        </div>
      </div>

      {/* ===== KPI 行 ===== */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {kpiCards.map((c) => (
          <Col key={c.label} xs={24} sm={12} xl={6}>
            <div className="sc-stat-card" style={{ '--accent': c.accent, '--accent-bg': c.accentBg } as CSSProperties}>
              <div className="sc-stat-icon">{c.icon}</div>
              <div style={{ minWidth: 0 }}>
                <div className="sc-stat-label">{c.label}</div>
                <div className="sc-stat-value">{c.value}<small>{c.unit}</small></div>
                {c.delta}
              </div>
            </div>
          </Col>
        ))}
      </Row>

      {/* ===== 队列表 ===== */}
      <div className="sc-card" style={{ padding: 0 }} ref={tableWrapRef}>
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid #f1f5f9' }}>
          <h3 style={{ fontSize: 'calc(14px * var(--font-size-scale))', fontWeight: 600, margin: 0 }}>{queueMeta[tab].title}</h3>
          <span className="sc-toolbar-hint">{queueMeta[tab].hint}</span>
        </div>
        <Table<StockCheck>
          className="sca-queue"
          rowKey="id"
          size="small"
          loading={loading}
          columns={listColumns}
          dataSource={listRows}
          scroll={{ y: tableY }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p) => setPage(p),
            showSizeChanger: false,
            size: 'small',
          }}
        />
      </div>

      {/* ===== 复点抽屉遮罩 + 抽屉 ===== */}
      <div className={`sca-mask${detail ? ' open' : ''}`} onClick={() => { if (!acting) setDetail(null) }} />
      <div className={`sca-drawer${detail ? ' open' : ''}`}>
        {detail && (
          <>
            <div className="sca-dw-head">
              <div className="row1">
                <AimOutlined style={{ color: '#5b5bd6' }} />
                {readonly ? <h3>处置档案 · {detail.check_no}</h3>
                  : canFlag ? <h3>过程抽检 · {detail.check_no}</h3>
                    : <h3>终检复点 · {detail.check_no}</h3>}
                {readonly ? <span className="hint">只读 · 处置结论与复点记录</span>
                  : canFlag ? <span className="hint">盘点仍在进行中 · 仅标记问题行，不打断盘点</span>
                    : <span className="hint">已完结 · 抽检通过后才计划 K3 回写</span>}
                <button className="sca-dw-close" onClick={() => setDetail(null)}><CloseOutlined /></button>
              </div>
              <div className="sca-dw-meta">
                <div><div className="k">类型</div><div className="v">{typeTagOf(detail)}</div></div>
                <div><div className="k">订单号</div><div className="v">{detail.order_no || '—'}</div></div>
                <div><div className="k">已盘进度</div><div className="v">{detail.checked_materials ?? 0} / {detail.total_materials ?? 0}</div></div>
                <div><div className="k">盘差</div><div className="v">{renderDiff(detail.total_diff_qty)}</div></div>
                <div><div className="k">盘点人</div><div className="v">{detail.created_by || '—'}</div></div>
                <div><div className="k">{canFlag ? '更新时间' : '完结时间'}</div><div className="v">{formatDateTime((canFlag ? detail.updated_at : detail.completed_at) || '') || '—'}</div></div>
              </div>
              <div className="sca-statline">
                <span className="st">复点 <b>{readonly ? Object.keys(historyMap).length : rdCount}</b></span>
                <span className="sep" />
                <span className="st ok">一致 <b>{readonly ? Object.values(historyMap).filter((h) => h.matches).length : rdOk}</b></span>
                <span className="st bad">不符 <b>{readonly ? Object.values(historyMap).filter((h) => !h.matches).length : mismatchIds.length}</b></span>
                <span className="sep" />
                <span className="st mark">已标记 <b>{dwCounts.failed}</b> 行</span>
                {canFinalAudit && <span className="st">通过后计划 K3 单据 <b>{wbGroups.length}</b></span>}
                {readonly && <><span className="sep" /><span className="st">结论 {auditTagOf(detail.audit_status)}</span></>}
                <div className="filters">
                  <button className={`fc${dwFilter === 'all' ? ' on' : ''}`} onClick={() => setDwFilter('all')}>全部 <span className="n">{dwCounts.all}</span></button>
                  <button className={`fc${dwFilter === 'counted' ? ' on' : ''}`} onClick={() => setDwFilter('counted')}>已盘 <span className="n">{dwCounts.counted}</span></button>
                  <button className={`fc${dwFilter === 'diff' ? ' on' : ''}`} onClick={() => setDwFilter('diff')}>差异 <span className="n">{dwCounts.diff}</span></button>
                  {dwCounts.failed > 0 && (
                    <button className={`fc danger${dwFilter === 'failed' ? ' on' : ''}`} onClick={() => setDwFilter('failed')}>问题行 <span className="n">{dwCounts.failed}</span></button>
                  )}
                </div>
              </div>
            </div>


            <div className="sca-dw-body">
              <div className="sca-tbl-wrap">
                <table className="sca-tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th>物料编码 / 名称</th>
                      <th>仓库</th>
                      <th className="num">实盘（快照）</th>
                      <th className="num">盘差</th>
                      <th className="num" style={{ width: 104 }}>财务复点</th>
                      <th style={{ width: 88 }}>裁定</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dwFiltered.map((i) => {
                      const picked = pickedIds.includes(i.id)
                      const marked = i.audit_failed === 1
                      const diff = i.diff_qty == null || i.actual_qty == null ? null : Number(i.diff_qty)
                      const togglePick = i.actual_qty == null
                        ? undefined
                        : () => setPickedIds((s) => (picked ? s.filter((x) => x !== i.id) : [...s, i.id]))
                      return (
                        <tr
                          key={i.id}
                          className={`${marked ? 'marked' : ''} ${picked ? 'picked' : ''}`.trim() || undefined}
                          onClick={togglePick}
                          style={togglePick ? { cursor: 'pointer' } : undefined}
                        >
                          <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                            {i.actual_qty == null
                              ? <span className="sca-circle disabled" />
                              : (
                                <span
                                  className={`sca-circle${picked ? ' on' : ''}`}
                                  onClick={() => {
                                    setPickedIds((s) => (picked ? s.filter((x) => x !== i.id) : [...s, i.id]))
                                  }}
                                />
                              )}
                          </td>
                          <td title={`${i.material_code} ${i.material_name || ''}${i.spec_model ? ` · ${i.spec_model}` : ''}`}>
                            <div className="mat-code">
                              {i.material_code}
                              {marked && <span className="sca-mini-mark">已标记</span>}
                              {i.appeal_status === 'pending' && (
                                <Tooltip title={`复议原因：${i.appeal_reason || '—'}`}>
                                  <span className="sc-tag sca-audit-flag"><span className="dot" />复议中</span>
                                </Tooltip>
                              )}
                            </div>
                            <div className="mat-sub">{i.material_name}{i.spec_model ? ` · ${i.spec_model}` : ''}</div>
                          </td>
                          <td className="wh" style={{ color: '#475569' }}>{i.wh_name || <span style={{ color: '#cbd5e1', fontStyle: 'italic' }}>(未入库)</span>}</td>
                          <td className="num">
                            <div className="sca-act-cell">
                              {i.actual_qty == null
                                ? <div className="main" style={{ color: '#94a3b8', fontWeight: 400 }}>未盘点</div>
                                : <div className="main">{fmtNum(i.actual_qty)}</div>}
                              {i.system_qty != null && <div className="snap">快照 {fmtNum(i.system_qty)}</div>}
                            </div>
                          </td>
                          <td className="num">
                            {diff == null
                              ? <span className="sca-diff-pill flat">—</span>
                              : diff === 0
                                ? <span className="sca-diff-pill flat">盘平</span>
                                : diff > 0
                                  ? <span className="sca-diff-pill up">+{diff}</span>
                                  : <span className="sca-diff-pill down">{diff}</span>}
                          </td>
                          <td className="num" onClick={(e) => e.stopPropagation()}>{drawerRdCell(i)}</td>
                          <td>
                            {i.appeal_status === 'pending'
                              ? <Tooltip title="复议待财务裁决，可在上方复议面板处理"><span className="sca-verdict none">复议中</span></Tooltip>
                              : drawerVerdictCell(i)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {dwFiltered.length > 0 && <div className="sca-end-mark">共 {dwCounts.all} 行 · 已全部显示</div>}
              {dwFiltered.length === 0 && (
                <div className="sca-end-mark">
                  {dwFilter === 'all' ? '暂无明细行' : '当前筛选无匹配行 · 可切换筛选'}
                </div>
              )}

              {/* 处置时间线（只读档案模式） */}
              {readonly && auditLogs.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div className="sc-frm-label" style={{ marginBottom: 10 }}>处置时间线</div>
                  <div className="sca-hist">
                    {[...auditLogs].reverse().map((l) => (
                      <div key={l.id} className={`sca-hist-item h-${l.action === 'pass' || l.action === 'pass_exemption' ? 'pass' : l.action === 'reject' ? 'reject' : 'flag'}`}>
                        <div className="t">
                          {l.action !== 'pass' && l.action !== 'pass_exemption' ? `第 ${l.round_no} 轮 · ` : ''}
                          {ACTION_LABEL[l.action] || l.action} · {formatDateTime(l.created_at || '')} · {l.operated_by || '—'}
                        </div>
                        <div className="d">
                          {l.action === 'flag' && `过程标记 ${(l.rejected_item_ids?.length ?? 0)} 行问题`}
                          {l.action === 'reject' && `复点后发回，问题行 ${l.rejected_item_ids?.length ?? 0} 个`}
                          {(l.action === 'pass' || l.action === 'pass_exemption') && `复点 ${l.items.length} 行${l.items.length ? ` · 一致 ${l.items.filter((x) => x.matches).length}` : '（免检无复点）'}`}
                          {l.comment ? `。${l.comment}` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="sca-dw-foot">
              {canFinalAudit && (
                footAction === 'reject' ? (
                  <>
                    <div className="reason-row" style={{ width: '100%' }}>
                      <input
                        id="sca-foot-reason"
                        value={footComment}
                        placeholder="发回原因（必填）· 回车确认发回…"
                        onChange={(e) => setFootComment(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !acting) void submitReject() }}
                      />
                    </div>
                    <div className="btn-row">
                      <span className="note">已勾选 {pickedIds.length} 行问题行 · 发回后单据回到进行中，已盘数据保留</span>
                      <Button onClick={() => { setFootAction(null); setFootComment('') }}>取消</Button>
                      <Button danger icon={<UndoOutlined />} loading={acting} onClick={() => void submitReject()}>
                        确认发回{pickedIds.length > 0 ? `（${pickedIds.length} 行）` : ''}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="btn-row">
                    <span className="note">
                      复点 {rdCount} 行 · 不符 {mismatchIds.length} 行 · 通过将按盘点人实盘数计划 K3 回写
                    </span>
                    <Button danger icon={<UndoOutlined />} onClick={startReject}>
                      {mismatchIds.length > 0 ? `发回不符行（${mismatchIds.length}）` : '发回重填'}
                    </Button>
                    <Button type="primary" icon={<CheckCircleOutlined />} onClick={handlePassClick}>通 过</Button>
                  </div>
                )
              )}
              {canFlag && (
                footAction === 'flag' ? (
                  <>
                    <div className="reason-row" style={{ width: '100%' }}>
                      <input
                        id="sca-foot-reason"
                        value={footComment}
                        placeholder="标记说明（可选）· 回车确认标记…"
                        onChange={(e) => setFootComment(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !acting && pickedIds.length > 0) void submitFlag() }}
                      />
                    </div>
                    <div className="btn-row">
                      <span className="note">已勾选 {pickedIds.length} 行 · 标记后立即通知盘点人，抽屉保持打开可继续核对</span>
                      <Button onClick={() => { setFootAction(null); setFootComment('') }}>取消</Button>
                      <Button type="primary" loading={acting} onClick={() => void submitFlag()}>
                        确认标记 {pickedIds.length} 行并通知
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="btn-row">
                    <span className="note">单据仍在进行中 · 点击行即可勾选问题行（复点不符会自动勾选），标记后通知盘点人</span>
                    <Button
                      type="primary"
                      onClick={() => setFootAction('flag')}
                    >
                      标记问题行{pickedIds.length > 0 ? `（${pickedIds.length}）` : ''}
                    </Button>
                  </div>
                )
              )}
              {readonly && (
                <div className="btn-row">
                  <span className="note">处置已完成，档案只读</span>
                  <Button onClick={() => setDetail(null)}>关闭</Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ===== 复议裁决弹窗（独立于复点抽屉） ===== */}
      <div className={`sca-bmask${appealCheck ? ' open' : ''}`} onClick={() => { if (!acting) setAppealCheck(null) }}>
        <div className="sca-modal" onClick={(e) => e.stopPropagation()}>
          <div className="sca-md-head">
            <AimOutlined style={{ color: '#0284c7' }} />
            <h3>复议裁决 · {appealCheck?.check_no}</h3>
            <span className="hint">盘点人认为复点有误 · 支持则撤销标记，驳回则维持标记</span>
            <button className="sca-dw-close" onClick={() => setAppealCheck(null)}><CloseOutlined /></button>
          </div>
          <div className="sca-md-body">
            {appealPendingRows.length === 0 && (
              <div style={{ textAlign: 'center', color: '#94a3b8', padding: '18px 0' }}>
                {appealLoading ? '加载中…' : '没有待裁决的复议（可能已被处理）'}
              </div>
            )}
            {appealPendingRows.map((i) => {
              const fin = appealQtyMap.get(i.id)
              const diff = i.diff_qty == null ? null : Number(i.diff_qty)
              return (
                <div key={i.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 14px', marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="sc-mono" style={{ fontWeight: 600 }}>{i.material_code}</span>
                    <span className="sc-sub">{i.material_name}</span>
                    <span className="sc-sub" style={{ marginLeft: 'auto' }}>{i.wh_name || '(未入库)'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 6, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
                    <span>盘点人实盘 <b style={{ color: '#0f172a' }}>{fmtNum(i.actual_qty)}</b></span>
                    <span>财务复点 <b style={{ color: fin && fin.matches === 0 ? '#dc2626' : '#0f172a' }}>{fin ? fmtNum(fin.audit_qty) : '—'}</b></span>
                    <span className="sc-sub">快照 {fmtNum(i.system_qty)}</span>
                    {diff != null && diff !== 0 && (
                      diff > 0 ? <span className="sca-diff-pill up">+{diff}</span> : <span className="sca-diff-pill down">{diff}</span>
                    )}
                    {fin && <span className={`sca-verdict ${fin.matches === 0 ? 'bad' : 'ok'}`}>{fin.matches === 0 ? '✗ 不符' : '✓ 一致'}</span>}
                  </div>
                  <div style={{ marginTop: 6, padding: '6px 10px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, fontSize: 12, color: '#075985', lineHeight: 1.6 }}>
                    复议原因：{i.appeal_reason || '—'}
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                    <Button size="small" type="primary" disabled={acting} onClick={() => void resolveAppeal(i.id, true)}>支持复议（撤销标记，认可盘点数）</Button>
                    <Button size="small" danger disabled={acting} onClick={() => void resolveAppeal(i.id, false)}>驳回复议（维持标记）</Button>
                  </div>
                </div>
              )
            })}
            {appealPendingRows.length > 0 && (
              <Input
                value={appealComment}
                placeholder="裁决意见（可选），将随通知发送给盘点人…"
                onChange={(e) => setAppealComment(e.target.value)}
                style={{ marginTop: 4 }}
              />
            )}
          </div>
          <div className="sca-md-foot">
            <span className="foot-hint">支持=撤销标记认可盘点数 · 驳回=维持标记需改数 · 裁决将通知盘点人</span>
            <Button onClick={() => setAppealCheck(null)}>关闭</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
