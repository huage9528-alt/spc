import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Spin, Tooltip } from 'antd'
import { FullscreenOutlined, FullscreenExitOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { inventoryBoardApi } from '@/services/api'
import { useThemeStore } from '@/store/theme'

/*
 * 库存看板（驾驶舱 · 大屏版）— 复刻 docs/prototype/redesign/inventory-board.html
 * 2×2 一屏栅格（无滚动）+ 四类手绘 SVG 图形：
 *   库存分布·按仓库[环形图] / 库存分布·按类别[100%堆叠条] / 盘点覆盖[半环仪表] / 盘点进度[面积折线]
 * 口径：仓库 chips 作用于库存分布 2 区块 + 盘点覆盖；盘点进度为全仓口径
 *      已盘 = 该「物料×仓库」在窗口内实盘过（与库存页「近期已盘」同口径）
 */

const PALETTE = [
  '#5b5bd6', '#0ea5e9', '#f59e0b', '#8b5cf6', '#10b981', '#14b8a6',
  '#f43f5e', '#64748b', '#e879f9', '#84cc16', '#06b6d4', '#fb7185',
]
const OTHER_COLOR = '#94a3b8'
/* 各列表显示上限（防 25 仓全铺开过长）；装不下时板块内滚动，不裁内容 */
const MAX_WH_ROWS = 8   // 按仓库：含「其他」最多 8 行
const MAX_CAT_ROWS = 7  // 按类别：含「其他」最多 7 行
const MAX_COV_ROWS = 8  // 盘点覆盖：最多 8 行
const MAX_CHECKS = 5    // 盘点进度：最多 5 张盘点单

const WINDOWS = [
  { k: 7, label: '近 7 天' },
  { k: 30, label: '近 30 天' },
  { k: -1, label: '全部历史' },
]

interface OverviewKpi {
  material_count: number
  total_qty: number | string
  total_value: number | string
  warehouse_count: number
}
interface WarehouseRow {
  warehouse_id: number
  warehouse_name: string
  material_count: number
  total_qty: number | string
  total_value: number | string
}
interface CategoryRow {
  category: string
  material_count: number
  total_qty: number | string
  total_value: number | string
}
interface AgingRow {
  bucket: string
  material_count: number
  total_qty: number | string
  total_value: number | string
}
interface Overview {
  kpi: OverviewKpi
  by_warehouse: WarehouseRow[]
  by_category: CategoryRow[]
  aging: AgingRow[]
}
interface CoverageWh {
  wh_id: number | null
  wh_name: string
  total: number
  checked: number
  unchecked: number
  rate: number
}
interface Coverage {
  total: number
  checked: number
  unchecked: number
  rate: number
  warehouses: CoverageWh[]
}
interface ActiveCheck {
  check_id: number
  check_no: string
  status: string
  total_materials: number
  checked_materials: number
  check_date: string
  age_days: number
  created_by?: string | null
}
interface StockCheckData {
  kpi: {
    active_checks: number
    month_completion_rate: number
    month_profit_qty: number | string
    month_loss_qty: number | string
  }
  active_checks: ActiveCheck[]
  trend: { date: string; checks_completed: number }[]
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const fmt = (n: number) => n.toLocaleString('zh-CN')
/** 数量：亿 / 万 / 原值（库存数量常达亿级，避免出现 17900.0万） */
const fmtQty = (n: number) => {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) {
    const w = n / 1e4
    return `${w >= 1000 ? w.toFixed(0) : w.toFixed(1)}万`
  }
  return fmt(n)
}
const fmtWan = (v: number) => {
  const w = v / 10000
  return w >= 1000 ? w.toFixed(0) : w >= 10 ? w.toFixed(1) : w.toFixed(2)
}
const pct = (a: number, b: number) => {
  if (!b) return '0.0'
  const p = (a / b) * 100
  return p < 1 ? p.toFixed(2) : p.toFixed(1)
}

const css = `
.ivb-wrap {
  /* 字号完全跟随统一字体管理（--font-size-scale，顶栏设置实时生效，无上限压制）；
     一屏装不下时由 JS 减行数自适应（见 rowBudget），绝不压字号 */
  font-size: calc(15px * var(--font-size-scale, 1));
  color: #0f172a; display: flex; flex-direction: column; flex: 1; min-height: 0;
}
.ivb-wrap * { box-sizing: border-box; }
.ivb-bar {
  display: flex; align-items: center; gap: 0.6em 1.2em; flex-wrap: wrap; flex: none;
  padding: 0.65em 1.2em; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 10px;
}
.ivb-bar h1 { font-size: 1.1em; font-weight: 700; margin: 0; white-space: nowrap; }
.ivb-bar h1 small { font-size: 0.68em; font-weight: 400; color: #94a3b8; margin-left: 0.5em; }
.ivb-stats { display: flex; gap: 1.1em; flex-wrap: wrap; }
.ivb-stat { display: flex; align-items: baseline; gap: 0.3em; font-size: 0.76em; color: #64748b; white-space: nowrap; }
.ivb-stat b { font-size: 1.18em; font-weight: 700; font-variant-numeric: tabular-nums; color: #0f172a; }
.ivb-stat em { font-style: normal; font-size: 0.68em; color: #94a3b8; }
.ivb-stat.warn b { color: #d97706; }
.ivb-chips {
  display: flex; align-items: center; gap: 0.4em; margin-left: auto;
  flex-wrap: nowrap; overflow-x: auto; min-width: 0; max-width: 100%;
  scrollbar-width: none;
}
.ivb-chips::-webkit-scrollbar { display: none; }
.ivb-chips .lbl { font-size: 0.72em; color: #94a3b8; flex: none; }
.ivb-chip {
  border: 1px solid #e2e8f0; background: #fff; border-radius: 999px; padding: 0.2em 0.75em;
  font-size: 0.74em; color: #64748b; cursor: pointer; user-select: none; white-space: nowrap;
  transition: all .15s; flex: none;
}
.ivb-chip b { font-weight: 600; margin-left: 0.25em; color: #0f172a; }
.ivb-chip:hover { border-color: #a3a9f5; color: #0f172a; }
.ivb-chip.on { background: #5b5bd6; border-color: #5b5bd6; color: #fff; }
.ivb-chip.on b { color: #fff; }
.ivb-clock { font-size: 0.82em; font-weight: 600; font-variant-numeric: tabular-nums; color: #64748b; white-space: nowrap; }

.ivb-board {
  flex: 1; min-height: 0; display: grid; gap: 10px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  overflow: hidden;
}
.ivb-card {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .04);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}
.ivb-card-head { display: flex; align-items: center; gap: 0.5em; padding: 0.6em 0.95em; border-bottom: 1px solid #f1f5f9; flex: none; }
.ivb-card-head h3 { font-size: 0.9em; font-weight: 600; margin: 0; white-space: nowrap; }
.ivb-hint { font-size: 0.72em; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ivb-hint b { color: #475569; font-weight: 600; }
.ivb-body { padding: 0.55em 0.95em 0.7em; flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.ivb-body.split { flex-direction: row; gap: 1.1em; }
.ivb-chart { flex: 0 0 clamp(9.5em, 24%, 14.5em); display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; }
.ivb-chart svg { width: 100%; height: auto; max-height: 100%; }
.ivb-list {
  /* 行列表：装得下时行均分变高；装不下时板块内滚动（细滚动条），内容永不裁 */
  flex: 1; min-height: 0; min-width: 0;
  display: flex; flex-direction: column;
  overflow-y: auto; scrollbar-width: thin; scrollbar-color: #cbd5e1 transparent;
}
.ivb-list::-webkit-scrollbar { width: 5px; }
.ivb-list::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
.ivb-list::-webkit-scrollbar-track { background: transparent; }

.ivb-row {
  /* 不设 min-height:0 —— 行永不压缩到比内容矮（那会裁字/叠行）；
     有富余时 flex 分摊变高，装不下时整行在卡片底部被裁（预算逻辑保证基本不会） */
  flex: 1 1 auto; overflow: hidden;
  display: flex; flex-direction: column; justify-content: center; padding: 0.15em 0;
}
.ivb-row + .ivb-row { border-top: 1px solid #eef2f7; }
.ivb-row.dim { opacity: 0.32; }
.ivb-row.hl .ivb-name { color: #4c4dc2; font-weight: 600; }
.ivb-row-top { display: flex; align-items: baseline; gap: 0.6em; margin-bottom: 0.35em; }
.ivb-name { flex: 1; min-width: 0; font-size: 0.8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ivb-name em { font-style: normal; font-size: 0.85em; color: #94a3b8; margin-left: 0.4em; }
.ivb-val { margin-left: auto; font-size: 0.8em; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ivb-pct { width: 3.8em; text-align: right; font-size: 0.7em; color: #94a3b8; font-variant-numeric: tabular-nums; flex: none; }
.ivb-track { height: 0.5em; border-radius: 999px; background: #eef2f7; overflow: hidden; }
.ivb-track i { display: block; height: 100%; border-radius: 999px; }
.ivb-dot { width: 0.6em; height: 0.6em; border-radius: 3px; flex: none; margin-right: 0.15em; }
.ivb-cov {
  margin-left: auto; display: flex; align-items: baseline; gap: 0.5em;
  font-size: 0.68em; color: #94a3b8; white-space: nowrap; font-variant-numeric: tabular-nums;
}
.ivb-cov b { font-weight: 700; font-size: 1.15em; }
.ivb-cov b.g { color: #16a34a; }
.ivb-cov b.r { color: #dc2626; }

.ivb-stacked { display: flex; height: 1.7em; border-radius: 7px; overflow: hidden; background: #eef2f7; flex: none; margin-bottom: 0.7em; }
.ivb-stacked i { display: flex; align-items: center; justify-content: center; min-width: 3px; }
.ivb-stacked i span { font-size: 0.62em; font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; }
.ivb-gauge-legend { display: flex; gap: 0.9em; justify-content: center; margin-top: 0.15em; font-size: 0.72em; color: #94a3b8; white-space: nowrap; }
.ivb-gauge-legend b { font-weight: 700; }
.ivb-gauge-legend .on b { color: #16a34a; }
.ivb-gauge-legend .off b { color: #dc2626; }
.ivb-gauge-legend i { display: inline-block; width: 0.55em; height: 0.55em; border-radius: 2px; margin-right: 0.3em; }

.ivb-seg { display: inline-flex; background: #f1f5f9; border-radius: 7px; padding: 2px; gap: 2px; margin-left: auto; }
.ivb-seg span { padding: 0.15em 0.65em; border-radius: 5px; font-size: 0.68em; color: #64748b; cursor: pointer; white-space: nowrap; }
.ivb-seg span.on { background: #fff; color: #0f172a; font-weight: 600; box-shadow: 0 1px 2px rgba(15, 23, 42, .06); }

/* SVG 内文字：一律 em，跟随 --font-size-scale（勿写死 px） */
.ivb-donut-num { font-size: 1.73em; font-weight: 700; fill: #0f172a; }
.ivb-donut-sub { font-size: 0.8em; fill: #94a3b8; }
.ivb-gauge-num { font-size: 2.13em; font-weight: 700; fill: #16a34a; }
.ivb-gauge-sub { font-size: 0.87em; fill: #94a3b8; }

.ivb-kpi4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.45em; margin-bottom: 0.6em; flex: none; }
.ivb-kpi4 .k { background: #f8fafc; border: 1px solid #f1f5f9; border-radius: 8px; padding: 0.35em 0.55em 0.4em; }
.ivb-kpi4 .lbl { font-size: 0.64em; color: #94a3b8; white-space: nowrap; }
.ivb-kpi4 .v { font-size: 0.92em; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.35; white-space: nowrap; }
.ivb-kpi4 .v.good { color: #16a34a; }
.ivb-kpi4 .v.bad { color: #dc2626; }
.ivb-kpi4 .v.brand { color: #4c4dc2; }
.ivb-chk {
  /* 同 .ivb-row：不压缩到比内容矮，防止「单号/副行文字不见」 */
  flex: 1 1 auto; overflow: hidden;
  display: flex; flex-direction: column; justify-content: center; padding: 0.2em 0; border-bottom: 1px solid #eef2f7;
}
.ivb-chk:last-of-type { border-bottom: none; }
.ivb-chk-top { display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.3em; }
.ivb-chk-no { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 0.74em; font-weight: 700; white-space: nowrap; }
.ivb-st { font-size: 0.62em; font-weight: 700; border-radius: 4px; padding: 0.05em 0.45em; white-space: nowrap; }
.ivb-st.open { color: #0284c7; background: #f0f9ff; }
.ivb-st.doing { color: #4c4dc2; background: #eef0fe; }
.ivb-chk-age { margin-left: auto; font-size: 0.66em; color: #94a3b8; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ivb-chk-age.hot { color: #dc2626; font-weight: 600; }
.ivb-chk-sub { display: flex; align-items: center; gap: 0.6em; margin-top: 0.3em; font-size: 0.68em; color: #94a3b8; font-variant-numeric: tabular-nums; }
.ivb-chk-sub .p { margin-left: auto; font-weight: 700; color: #475569; }
.ivb-trend { margin-top: 0.55em; border-top: 1px solid #f1f5f9; padding-top: 0.5em; flex: none; }
.ivb-trend-head { display: flex; align-items: baseline; gap: 0.5em; font-size: 0.68em; color: #94a3b8; margin-bottom: 0.3em; }
.ivb-trend-head b { margin-left: auto; font-size: 1.15em; color: #475569; font-weight: 700; }
.ivb-trend svg { display: block; width: 100%; }
.ivb-trend-axis { display: flex; justify-content: space-between; font-size: 0.62em; color: #94a3b8; margin-top: 0.2em; font-variant-numeric: tabular-nums; }
`

/* ---------- 图形 ---------- */
function Donut({ groups, total, label, hover, onHover }: {
  groups: { name: string; qty: number; other?: boolean }[]
  total: number
  label: string
  hover: number | null
  onHover: (i: number | null) => void
}) {
  const cx = 100, cy = 100, r = 68, sw = 26
  const C = 2 * Math.PI * r
  let acc = 0
  return (
    <svg viewBox="0 0 200 200">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f1f5f9" strokeWidth={sw} />
      <g transform={`rotate(-90 ${cx} ${cy})`}>
        {groups.map((g, i) => {
          const frac = total ? g.qty / total : 0
          const len = frac * C
          const off = -acc * C
          acc += frac
          const color = g.other ? OTHER_COLOR : PALETTE[i % PALETTE.length]
          return (
            <circle
              key={g.name}
              cx={cx} cy={cy} r={r} fill="none"
              stroke={color} strokeWidth={sw}
              strokeDasharray={`${len.toFixed(2)} ${(C - len).toFixed(2)}`}
              strokeDashoffset={off.toFixed(2)}
              opacity={hover === null || hover === i ? 1 : 0.2}
              style={{ transition: 'opacity .15s', cursor: 'default' }}
              onMouseEnter={() => onHover(i)}
              onMouseLeave={() => onHover(null)}
            >
              <title>{`${g.name} · ${fmtQty(g.qty)} · ${pct(g.qty, total)}%`}</title>
            </circle>
          )
        })}
      </g>
      <text x="100" y="99" textAnchor="middle" className="ivb-donut-num">{fmtQty(total)}</text>
      <text x="100" y="120" textAnchor="middle" className="ivb-donut-sub">{`库存数量 · ${label}`}</text>
    </svg>
  )
}

function Stacked({ groups, total }: { groups: { name: string; qty: number; color: string }[]; total: number }) {
  return (
    <div className="ivb-stacked">
      {groups.map(g => {
        const w = total ? (g.qty / total) * 100 : 0
        return (
          <i key={g.name} style={{ width: `${w.toFixed(2)}%`, background: g.color }}
            title={`${g.name} · ${fmtQty(g.qty)} · ${w.toFixed(1)}%`}>
            {w >= 11 && <span>{w.toFixed(0)}%</span>}
          </i>
        )
      })}
    </div>
  )
}

function Gauge({ on, off }: { on: number; off: number }) {
  const p = on + off ? on / (on + off) : 0
  const r = 62, cx = 90, cy = 92, sw = 18
  const L = Math.PI * r
  const d = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`
  return (
    <svg viewBox="0 0 180 118">
      <path d={d} fill="none" stroke="#fee2e2" strokeWidth={sw} strokeLinecap="round" />
      <path d={d} fill="none" stroke="#16a34a" strokeWidth={sw} strokeLinecap="round"
        strokeDasharray={`${(p * L).toFixed(2)} ${(L + 2).toFixed(2)}`}>
        <title>{`已盘率 ${(p * 100).toFixed(1)}%`}</title>
      </path>
      <text x="90" y="88" textAnchor="middle" className="ivb-gauge-num">{(p * 100).toFixed(1)}%</text>
      <text x="90" y="108" textAnchor="middle" className="ivb-gauge-sub">已盘率</text>
    </svg>
  )
}

function AreaChart({ trend }: { trend: number[] }) {
  const w = 300, h = 40, pad = 3
  const n = trend.length
  if (!n) return null
  const max = Math.max(...trend) || 1
  const pts = trend.map((v, i) => [
    pad + (i * (w - 2 * pad)) / Math.max(1, n - 1),
    h - pad - (v / max) * (h - 2 * pad),
  ])
  const line = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`
  const last = pts[n - 1]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ height: '2.7em', display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="ivbAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5b5bd6" stopOpacity=".3" />
          <stop offset="100%" stopColor="#5b5bd6" stopOpacity=".02" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#ivbAreaGrad)" />
      <polyline points={line} fill="none" stroke="#5b5bd6" strokeWidth="1.8"
        strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <line x1={last[0].toFixed(1)} y1={pad} x2={last[0].toFixed(1)} y2={h - pad}
        stroke="#5b5bd6" strokeWidth="1" strokeDasharray="2 2" opacity=".55" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export default function InventoryBoard() {
  const [base, setBase] = useState<Overview | null>(null)
  const [scoped, setScoped] = useState<Overview | null>(null)
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [chk, setChk] = useState<StockCheckData | null>(null)
  const [loading, setLoading] = useState(true)
  const [whFilter, setWhFilter] = useState<'all' | number>('all')
  const [win, setWin] = useState(30)
  const [hover, setHover] = useState<number | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [clock, setClock] = useState(() => dayjs().format('HH:mm'))
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  // 实测可用高度（不依赖 100vh - 魔数）；字号完全跟随统一字体设置，
  // 一屏装不下时按高度减少行数（绝不压字号）
  const { fontSizeScale } = useThemeStore()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [boardH, setBoardH] = useState(0)

  useEffect(() => {
    const calc = () => {
      const el = wrapRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top
      setBoardH(Math.max(360, Math.round(window.innerHeight - top - 32)))
    }
    const raf = requestAnimationFrame(calc)
    const t = window.setTimeout(calc, 250)
    window.addEventListener('resize', calc)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(t)
      window.removeEventListener('resize', calc)
    }
  }, [fullscreen, fontSizeScale])

  const loadOverview = useCallback(async () => {
    try {
      const res: any = await inventoryBoardApi.getOverview()
      setBase(res?.data ?? null)
      setUpdatedAt(dayjs().format('HH:mm'))
    } catch {
      /* 错误已由全局拦截器提示 */
    }
  }, [])

  const loadChecks = useCallback(async (days: number) => {
    try {
      const [cov, sc]: any[] = await Promise.all([
        inventoryBoardApi.getCoverage({ recent_days: days }),
        inventoryBoardApi.getStockCheck({ trend_days: 30, active_limit: 5 }),
      ])
      setCoverage(cov?.data ?? null)
      setChk(sc?.data ?? null)
    } catch {
      /* 错误已由全局拦截器提示 */
    }
  }, [])

  useEffect(() => { loadOverview() }, [loadOverview])

  useEffect(() => {
    setLoading(true)
    loadChecks(win).finally(() => setLoading(false))
  }, [loadChecks, win])

  // 选中仓：单独拉一次带 warehouse_id 的 overview（KPI / 类别 / 库龄 随筛选变化）
  useEffect(() => {
    if (whFilter === 'all') { setScoped(null); return }
    let alive = true
    inventoryBoardApi.getOverview({ warehouse_id: whFilter })
      .then((res: any) => { if (alive) setScoped(res?.data ?? null) })
      .catch(() => { /* 已提示 */ })
    return () => { alive = false }
  }, [whFilter])

  // 自动刷新：库存 30 分钟 / 盘点 5 分钟
  useEffect(() => {
    const t1 = window.setInterval(loadOverview, 30 * 60 * 1000)
    const t2 = window.setInterval(() => loadChecks(win), 5 * 60 * 1000)
    return () => { window.clearInterval(t1); window.clearInterval(t2) }
  }, [loadOverview, loadChecks, win])

  useEffect(() => {
    const t = window.setInterval(() => setClock(dayjs().format('HH:mm')), 30000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false) }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [fullscreen])

  const view = whFilter === 'all' ? base : (scoped ?? base)

  // 按仓库：数量降序；装不下时尾部合并「其他 N 仓」（灰色）
  const whGroups = useMemo(() => {
    const list = (base?.by_warehouse ?? []).map(w => ({
      id: w.warehouse_id,
      name: w.warehouse_name,
      count: num(w.material_count),
      qty: num(w.total_qty),
      ids: [w.warehouse_id] as number[],
      other: false,
    })).sort((a, b) => b.qty - a.qty)

    if (list.length <= MAX_WH_ROWS) return list

    const head = list.slice(0, MAX_WH_ROWS - 1)
    const tail = list.slice(MAX_WH_ROWS - 1)
    head.push({
      id: -1,
      name: `其他 ${tail.length} 仓`,
      count: tail.reduce((a, w) => a + w.count, 0),
      qty: tail.reduce((a, w) => a + w.qty, 0),
      ids: tail.map(w => w.id),
      other: true,
    })
    return head
  }, [base])

  const whTotal = useMemo(() => whGroups.reduce((a, w) => a + w.qty, 0), [whGroups])
  const whCount = useMemo(() => (base?.by_warehouse ?? []).length, [base])

  // 按类别：数量降序；Top N + 其他（堆叠条与图例同源，保证合计 100%）
  const catGroups = useMemo(() => {
    const all = (view?.by_category ?? [])
      .map(c => ({ name: c.category || '未分类', count: num(c.material_count), qty: num(c.total_qty) }))
      .sort((a, b) => b.qty - a.qty)
      .filter(c => c.qty > 0)

    if (all.length <= MAX_CAT_ROWS) return all.map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length] }))

    const head = all.slice(0, MAX_CAT_ROWS - 1).map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length] }))
    const tail = all.slice(MAX_CAT_ROWS - 1)
    head.push({
      name: `其他 ${tail.length} 类`,
      count: tail.reduce((a, c) => a + c.count, 0),
      qty: tail.reduce((a, c) => a + c.qty, 0),
      color: OTHER_COLOR,
    })
    return head
  }, [view])

  const catTotal = useMemo(() => catGroups.reduce((a, c) => a + c.qty, 0), [catGroups])
  const catCount = useMemo(() => (view?.by_category ?? []).length, [view])
  const agedCount = useMemo(
    () => num((view?.aging ?? []).find(a => a.bucket === '180d+')?.material_count),
    [view],
  )

  // 盘点覆盖：未盘降序（先看欠盘最多的仓）；选中仓时只显示该仓
  const covRows = useMemo(() => {
    const list = [...(coverage?.warehouses ?? [])]
    list.sort((a, b) => b.unchecked - a.unchecked || b.total - a.total)
    const picked = whFilter === 'all' ? list : list.filter(w => w.wh_id === whFilter)
    return whFilter === 'all' ? picked.slice(0, MAX_COV_ROWS) : picked
  }, [coverage, whFilter])

  const covWhCount = useMemo(() => (coverage?.warehouses ?? []).length, [coverage])
  const covOn = whFilter === 'all' ? num(coverage?.checked) : covRows.reduce((a, w) => a + w.checked, 0)
  const covOff = whFilter === 'all' ? num(coverage?.unchecked) : covRows.reduce((a, w) => a + w.unchecked, 0)

  const trend = useMemo(() => (chk?.trend ?? []).map(t => num(t.checks_completed)), [chk])
  const trendSum = useMemo(() => trend.reduce((a, b) => a + b, 0), [trend])

  const winLabel = WINDOWS.find(w => w.k === win)?.label ?? ''
  const kpi = view?.kpi

  const content = (
    <div className="ivb-wrap">
      <style>{css}</style>

      <header className="ivb-bar">
        <h1>库存看板<small>库存健康 · 盘点进度</small></h1>
        <div className="ivb-stats">
          <span className="ivb-stat">物料种类 <b>{num(kpi?.material_count)}</b><em>种</em></span>
          <span className="ivb-stat">库存总量 <b>{fmtQty(num(kpi?.total_qty))}</b></span>
          <span className="ivb-stat">库存金额 <b>{fmtWan(num(kpi?.total_value))}</b><em>万元</em></span>
          <span className="ivb-stat">覆盖仓库 <b>{num(kpi?.warehouse_count)}</b><em>个</em></span>
          <span className="ivb-stat warn">库龄 180 天+ <b>{agedCount}</b><em>项</em></span>
        </div>
        <div className="ivb-chips">
          <span className="lbl">仓库</span>
          <span className={`ivb-chip${whFilter === 'all' ? ' on' : ''}`} onClick={() => setWhFilter('all')}>
            全部 <b>{whCount}</b>
          </span>
          {(base?.by_warehouse ?? [])
            .slice()
            .sort((a, b) => num(b.total_qty) - num(a.total_qty))
            .map(w => (
              <span
                key={w.warehouse_id}
                className={`ivb-chip${whFilter === w.warehouse_id ? ' on' : ''}`}
                onClick={() => setWhFilter(w.warehouse_id)}
              >
                {w.warehouse_name} <b>{num(w.material_count)}</b>
              </span>
            ))}
        </div>
        <Tooltip title={fullscreen ? '退出全屏 (ESC)' : '全屏 / 大屏模式'}>
          <Button
            size="small"
            type="text"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            onClick={() => setFullscreen(!fullscreen)}
          />
        </Tooltip>
        <Tooltip title={updatedAt ? `数据截至 ${updatedAt} · 库存 30 分钟 / 盘点 5 分钟刷新` : ''}>
          <span className="ivb-clock">{clock}</span>
        </Tooltip>
      </header>

      <div className="ivb-board">
        {/* 库存分布 · 按仓库（环形图 + 同色横条，hover 联动） */}
        <section className="ivb-card">
          <div className="ivb-card-head">
            <h3>库存分布 · 按仓库</h3>
            <span className="ivb-hint">
              合计 <b>{whCount}</b> 仓 · 库存数量 {fmtQty(whTotal)}
              {whGroups.some(w => w.other) ? ` · Top ${MAX_WH_ROWS - 1} + 其他` : ''}
              {whFilter === 'all' ? '' : ` · 已选 ${(base?.by_warehouse ?? []).find(w => w.warehouse_id === whFilter)?.warehouse_name ?? ''}`}
            </span>
          </div>
          <div className="ivb-body split">
            <div className="ivb-chart">
              <Donut groups={whGroups} total={whTotal} label={`${whCount} 仓`} hover={hover} onHover={setHover} />
            </div>
            <div className="ivb-list">
              {whGroups.map((w, i) => (
                <div
                  key={w.id}
                  className={`ivb-row${whFilter !== 'all' && !w.ids.includes(whFilter as number) ? ' dim' : ''}${hover === i ? ' hl' : ''}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div className="ivb-row-top">
                    <span className="ivb-name">{w.name}<em>{w.count} 种</em></span>
                    <span className="ivb-val">{fmtQty(w.qty)}</span>
                    <span className="ivb-pct">{pct(w.qty, whTotal)}%</span>
                  </div>
                  <div className="ivb-track">
                    <i style={{
                      width: `${Math.max(1.5, whGroups[0].qty ? (w.qty / whGroups[0].qty) * 100 : 0).toFixed(1)}%`,
                      background: w.other ? OTHER_COLOR : PALETTE[i % PALETTE.length],
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 库存分布 · 按类别（100% 堆叠条 + 色点图例） */}
        <section className="ivb-card">
          <div className="ivb-card-head">
            <h3>库存分布 · 按类别</h3>
            <span className="ivb-hint">
              共 <b>{catCount}</b> 类 · 库存数量 {fmtQty(catTotal)}
              {catGroups.some(c => c.name.startsWith('其他'))
                ? ` · Top ${catGroups.filter(c => !c.name.startsWith('其他')).length} + 其他`
                : ''}
              {whFilter === 'all' ? '' : ` · ${(base?.by_warehouse ?? []).find(w => w.warehouse_id === whFilter)?.warehouse_name ?? ''}`}
            </span>
          </div>
          <div className="ivb-body">
            <Stacked groups={catGroups} total={catTotal} />
            <div className="ivb-list">
              {catGroups.map(c => (
                <div key={c.name} className="ivb-row">
                  <div className="ivb-row-top">
                    <span className="ivb-dot" style={{ background: c.color }} />
                    <span className="ivb-name">{c.name}<em>{c.count} 种</em></span>
                    <span className="ivb-val">{fmtQty(c.qty)}</span>
                    <span className="ivb-pct">{pct(c.qty, catTotal)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 盘点覆盖（半环仪表 + 按仓库覆盖率） */}
        <section className="ivb-card">
          <div className="ivb-card-head">
            <h3>盘点覆盖</h3>
            <span className="ivb-hint">
              物料×仓库 项 · {winLabel}{win === -1 ? '' : '内'}实盘过算已盘 · 共 <b>{covWhCount}</b> 仓
              {whFilter === 'all' ? ` · 未盘降序 Top ${MAX_COV_ROWS}` : ` · ${(base?.by_warehouse ?? []).find(w => w.warehouse_id === whFilter)?.warehouse_name ?? ''}`}
            </span>
            <div className="ivb-seg">
              {WINDOWS.map(w => (
                <span key={w.k} className={win === w.k ? 'on' : ''} onClick={() => setWin(w.k)}>{w.label}</span>
              ))}
            </div>
          </div>
          <div className="ivb-body split">
            <div className="ivb-chart">
              <Gauge on={covOn} off={covOff} />
              <div className="ivb-gauge-legend">
                <span className="on"><i style={{ background: '#16a34a' }} />已盘 <b>{covOn}</b></span>
                <span className="off"><i style={{ background: '#fecaca' }} />未盘 <b>{covOff}</b></span>
              </div>
            </div>
            <div className="ivb-list">
              {covRows.map(w => {
                const p = w.total ? (w.checked / w.total) * 100 : 0
                return (
                  <div key={String(w.wh_id)} className="ivb-row">
                    <div className="ivb-row-top">
                      <span className="ivb-name">{w.wh_name}<em>{w.total} 项</em></span>
                      <span className="ivb-cov">
                        <span>已盘 <b className="g">{w.checked}</b></span>
                        <span>未盘 <b className="r">{w.unchecked}</b></span>
                      </span>
                      <span className="ivb-pct">{p.toFixed(1)}%</span>
                    </div>
                    <div className="ivb-track" style={{ background: '#fee2e2' }}>
                      <i style={{ width: `${p.toFixed(1)}%`, background: '#16a34a' }} />
                    </div>
                  </div>
                )
              })}
              {!covRows.length && <div style={{ color: '#94a3b8', fontSize: '.76em', padding: '1em 0' }}>暂无数据</div>}
            </div>
          </div>
        </section>

        {/* 盘点进度（KPI + 进行中盘点单 + 30 天面积折线） */}
        <section className="ivb-card">
          <div className="ivb-card-head">
            <h3>盘点进度</h3>
            <span className="ivb-hint">全仓口径 · 不受仓库筛选影响</span>
          </div>
          <div className="ivb-body">
            <div className="ivb-kpi4">
              <div className="k">
                <div className="lbl">本月完成率</div>
                <div className="v good">{Math.round(num(chk?.kpi.month_completion_rate) * 100)}%</div>
              </div>
              <div className="k">
                <div className="lbl">本月盘盈</div>
                <div className="v good">+{fmt(num(chk?.kpi.month_profit_qty))}</div>
              </div>
              <div className="k">
                <div className="lbl">本月盘亏</div>
                <div className="v bad">−{fmt(num(chk?.kpi.month_loss_qty))}</div>
              </div>
              <div className="k">
                <div className="lbl">进行中</div>
                <div className="v brand">{num(chk?.kpi.active_checks)} 单</div>
              </div>
            </div>
            <div className="ivb-list">
              {(chk?.active_checks ?? []).slice(0, MAX_CHECKS).map(c => {
                const p = c.total_materials ? c.checked_materials / c.total_materials : 0
                const barColor = p >= 0.8 ? '#16a34a' : p > 0 ? '#d97706' : '#e2e8f0'
                return (
                  <div key={c.check_id} className="ivb-chk">
                    <div className="ivb-chk-top">
                      <span className="ivb-chk-no">{c.check_no}</span>
                      <span className={`ivb-st ${c.status === 'open' ? 'open' : 'doing'}`}>
                        {c.status === 'open' ? '待开始' : '进行中'}
                      </span>
                      <span className={`ivb-chk-age${c.age_days >= 7 ? ' hot' : ''}`}>停留 {c.age_days} 天</span>
                    </div>
                    <div className="ivb-track">
                      <i style={{ width: `${(p * 100).toFixed(0)}%`, background: barColor }} />
                    </div>
                    <div className="ivb-chk-sub">
                      <span>已盘 {c.checked_materials} / 应盘 {c.total_materials}</span>
                      {c.created_by && <span>{c.created_by}</span>}
                      <span>{c.check_date ? dayjs(c.check_date).format('MM-DD') : ''}</span>
                      <span className="p">{Math.round(p * 100)}%</span>
                    </div>
                  </div>
                )
              })}
              {trend.length > 0 && (
                <div className="ivb-trend">
                  <div className="ivb-trend-head">
                    <span>近 30 天完成单数</span><b>{trendSum} 单</b>
                  </div>
                  <AreaChart trend={trend} />
                  <div className="ivb-trend-axis">
                    <span>{dayjs().subtract(29, 'day').format('MM-DD')}</span>
                    <span>今天 {dayjs().format('MM-DD')}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )

  const board = loading && !base
    ? <div style={{ textAlign: 'center', padding: '60px 0' }}><Spin size="large" tip="加载库存看板..." /></div>
    : content

  if (fullscreen) {
    return (
      <div
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999,
          background: '#f4f6fa', padding: '1em 1.2em', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {board}
      </div>
    )
  }

  return (
    <div
      ref={wrapRef}
      style={{ height: boardH || 'calc(100vh - 13em)', minHeight: 380, display: 'flex', flexDirection: 'column' }}
    >
      {board}
    </div>
  )
}
