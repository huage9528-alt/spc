import { useState, useCallback, useEffect, useRef } from 'react'
import { Table, Button, Input, InputNumber, message, Space, Tabs, Tag, Tooltip, Popover, Checkbox, Select, DatePicker, Segmented, Card } from 'antd'
import {
  ReloadOutlined, SearchOutlined, SettingOutlined, HolderOutlined,
  InfoCircleOutlined, DownloadOutlined,
} from '@ant-design/icons'
import api from '../../services/api'
import { useAuthStore } from '../../store/auth'
import { useExport } from '../../hooks/useExport'
import dayjs from 'dayjs'
import ExportColumnSelector, { type ExportColumnOption } from '../../components/ExportColumnSelector'


interface InventoryItem {
  id: number
  material_id: number
  material_code: string
  material_name: string
  wh_id: number
  wh_code: string
  wh_name: string
  location_id: number | null
  location_name: string
  qty_on_hand: number
  locked_qty: number
  balance_qty: number
  qty_in_transit: number
  unit_price: number
  ending_balance: number
  batch_no: string
  last_inbound_at?: string | null
  last_outbound_at?: string | null
  last_picking_at?: string | null
  created_at: string
  updated_at: string
  recent_checked?: boolean
  recent_checked_date?: string | null
  recent_checked_check_no?: string | null
  unit_of_measure?: string
}

interface InventoryByWhItem {
  material_id: number
  material_code: string
  material_name: string
  wh_id: number
  wh_code: string
  wh_name: string
  qty_on_hand: number
  locked_qty: number
  balance_qty: number
  qty_in_transit: number
  unit_price: number
  ending_balance: number
  location_count: number
  last_inbound_at?: string | null
  last_outbound_at?: string | null
  last_picking_at?: string | null
  recent_checked?: boolean
  recent_checked_date?: string | null
  recent_checked_check_no?: string | null
  unit_of_measure?: string
}

const numFmt = (v: number | null | undefined) => (v != null ? v.toLocaleString() : '-')
const priceFmt = (v: number | null | undefined) =>
  v != null ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '-'
const moneyFmt = (v: number | null | undefined) =>
  v != null ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'
const optList = (arr?: string[]) => (arr || []).map(v => ({ text: v, value: v }))
const dtFmt = (v: string | null | undefined) => {
  if (!v) return '-'
  const d = new Date(v)
  if (isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 收发时间字段筛选: 时间范围 / 最近N天内 / 距今超N天(含为空) */
type TimeFilterMode = 'range' | 'within' | 'over'
interface TimeFilterValue { mode: TimeFilterMode; start?: string; end?: string; days?: number }
type TimeFilterField = 'last_inbound_at' | 'last_outbound_at' | 'last_picking_at'
type TimeFilters = Partial<Record<TimeFilterField, TimeFilterValue>>

const timeFilterParams = (tf: TimeFilters): Record<string, any> => {
  const p: Record<string, any> = {}
  ;(Object.keys(tf) as TimeFilterField[]).forEach((f) => {
    const v = tf[f]
    if (!v) return
    if (v.mode === 'range') {
      if (v.start) p[`${f}_start`] = v.start
      if (v.end) p[`${f}_end`] = v.end
    } else if (v.days != null && v.days >= 0) {
      p[`${f}_${v.mode}_days`] = v.days
    }
  })
  return p
}

function TimeFilterDropdown({ value, onApply }: { value?: TimeFilterValue; onApply: (v?: TimeFilterValue) => void }) {
  const [mode, setMode] = useState<TimeFilterMode>(value?.mode ?? 'range')
  const [range, setRange] = useState<[any, any] | null>(
    value?.mode === 'range' && value?.start && value?.end ? [dayjs(value.start), dayjs(value.end)] : null,
  )
  const [days, setDays] = useState<number | null>(value?.days ?? null)

  const apply = (clear?: boolean) => {
    if (clear) { onApply(undefined); return }
    if (mode === 'range') {
      if (range && range[0] && range[1]) {
        onApply({ mode, start: range[0].format('YYYY-MM-DD'), end: range[1].format('YYYY-MM-DD') })
      } else {
        onApply(undefined)
      }
    } else if (days != null && days >= 0) {
      onApply({ mode, days })
    } else {
      onApply(undefined)
    }
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, width: 264 }}>
      <Select
        size="small"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'range', label: '时间范围' },
          { value: 'within', label: '最近 N 天内' },
          { value: 'over', label: '距今超 N 天未动' },
        ]}
      />
      {mode === 'range' ? (
        <DatePicker.RangePicker size="small" style={{ width: '100%' }} value={range} onChange={(v: any) => setRange(v)} />
      ) : (
        <>
          <InputNumber
            size="small" min={0} max={100000} style={{ width: '100%' }} addonAfter="天"
            value={days ?? undefined} onChange={(v) => setDays(v ?? null)} placeholder="N"
          />
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
            {mode === 'within' ? '只显示该时间在最近 N 天内的行' : '该时间距今天超过 N 天、或从未发生(为空)的行'}
          </span>
        </>
      )}
      <Space style={{ justifyContent: 'flex-end' }}>
        <Button size="small" onClick={() => apply(true)}>清除</Button>
        <Button size="small" type="primary" onClick={() => apply()}>确定</Button>
      </Space>
    </div>
  )
}

/** 呆滞天数筛选: 参考时间 = 最后出库时间(无则最后入库时间), 空/未来时间显示 '-' 不计入 */
type DormantFilterValue = { relation: 'gt' | 'lt'; days: number }

const dormantParams = (v?: DormantFilterValue | null): Record<string, number> => {
  if (!v) return {}
  return v.relation === 'gt' ? { days_in_stock_gt: v.days } : { days_in_stock_lt: v.days }
}

function DormantFilterDropdown({ value, onApply }: { value?: DormantFilterValue; onApply: (v?: DormantFilterValue) => void }) {
  const [relation, setRelation] = useState<'gt' | 'lt'>(value?.relation ?? 'gt')
  const [days, setDays] = useState<number | null>(value?.days ?? null)

  const apply = (clear?: boolean) => {
    if (clear) { onApply(undefined); return }
    if (days != null && days >= 0) onApply({ relation, days })
    else onApply(undefined)
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, width: 232 }}>
      <Select
        size="small"
        value={relation}
        onChange={setRelation}
        options={[
          { value: 'gt', label: '大于 N 天' },
          { value: 'lt', label: '小于 N 天' },
        ]}
      />
      <InputNumber
        size="small" min={0} max={100000} style={{ width: '100%' }} addonAfter="天"
        value={days ?? undefined} onChange={(v) => setDays(v ?? null)} placeholder="N"
      />
      <span style={{ fontSize: 12, color: '#94a3b8' }}>
        按呆滞天数(最后出库时间,无则最后入库时间)距今天数过滤；从未收发(显示 '-')的行不计入。
      </span>
      <Space style={{ justifyContent: 'flex-end' }}>
        <Button size="small" onClick={() => apply(true)}>清除</Button>
        <Button size="small" type="primary" onClick={() => apply()}>确定</Button>
      </Space>
    </div>
  )
}

const dormantDaysOf = (outbound?: string | null, inbound?: string | null): number | null => {
  const ref = outbound || inbound
  if (!ref) return null
  const diff = Math.floor((Date.now() - new Date(ref).getTime()) / 86400000)
  return diff < 0 ? null : diff
}

const dormantCellStyle = (days: number): React.CSSProperties => {
  if (days >= 180) return { color: '#c62828', fontWeight: 700 }
  if (days >= 90) return { color: '#e53935', fontWeight: 700 }
  if (days >= 30) return { color: '#ef6c00', fontWeight: 600 }
  return { fontVariantNumeric: 'tabular-nums' }
}

/** 呆滞天数列: 排序按后端 days_in_stock(参考最后出库/无则最后入库), 保证与单元格天数一致; 表头带 大于/小于 N 天 下拉筛选; 数值分级着色 */
function dormantColumn(
  value: DormantFilterValue | undefined,
  apply: (v?: DormantFilterValue) => void,
): any {
  return {
    title: '呆滞天数', dataIndex: 'last_outbound_at', key: 'days_in_stock', width: 100, align: 'right' as const, sorter: true,
    filtered: !!value,
    filterDropdown: (dp: any) => (
      <DormantFilterDropdown
        value={value}
        onApply={(v) => { apply(v); dp?.confirm?.({ closeDropdown: true }) }}
      />
    ),
    render: (v: string | null | undefined, r: { last_inbound_at?: string | null }) => {
      const days = dormantDaysOf(v, r.last_inbound_at)
      if (days == null) return '-'
      return <span style={dormantCellStyle(days)}>{days}</span>
    },
  }
}

/** 导出字段选项（key 与后端导出列一致） */
const DETAIL_EXPORT_OPTIONS: ExportColumnOption[] = [
  { field: 'material_code', label: '物料编码' },
  { field: 'material_name', label: '物料名称' },
  { field: 'unit_of_measure', label: '单位' },
  { field: 'wh_code', label: '仓库编码' },
  { field: 'wh_name', label: '仓库名称' },
  { field: 'location_name', label: '库位名称' },
  { field: 'qty_on_hand', label: '库存量' },
  { field: 'locked_qty', label: '锁定数量' },
  { field: 'balance_qty', label: '结存数量' },
  { field: 'qty_in_transit', label: '在途库存' },
  { field: 'unit_price', label: '库存单价' },
  { field: 'ending_balance', label: '期末余额' },
  { field: 'batch_no', label: '批次号' },
  { field: 'last_inbound_at', label: '最后入库时间' },
  { field: 'last_outbound_at', label: '最后出库时间' },
  { field: 'last_picking_at', label: '最后领料时间' },
  { field: 'days_in_stock', label: '呆滞天数' },
  { field: 'recent_checked', label: '近期已盘' },
  { field: 'updated_at', label: '更新时间' },
]

const BYWH_EXPORT_OPTIONS: ExportColumnOption[] = [
  { field: 'material_code', label: '物料编码' },
  { field: 'material_name', label: '物料名称' },
  { field: 'unit_of_measure', label: '单位' },
  { field: 'wh_code', label: '仓库编码' },
  { field: 'wh_name', label: '仓库名称' },
  { field: 'location_count', label: '库位数' },
  { field: 'qty_on_hand', label: '库存量' },
  { field: 'locked_qty', label: '锁定数量' },
  { field: 'balance_qty', label: '结存数量' },
  { field: 'qty_in_transit', label: '在途库存' },
  { field: 'unit_price', label: '加权单价' },
  { field: 'ending_balance', label: '期末余额' },
  { field: 'last_inbound_at', label: '最后入库时间' },
  { field: 'last_outbound_at', label: '最后出库时间' },
  { field: 'last_picking_at', label: '最后领料时间' },
  { field: 'days_in_stock', label: '呆滞天数' },
  { field: 'recent_checked', label: '近期已盘' },
]

const FORMULA_NOTE = (
  <div className="f-note" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 'calc(11.5px * var(--font-size-scale))', marginBottom: 12 }}>
    <InfoCircleOutlined style={{ flexShrink: 0 }} />
    <span>核算口径：<b>结存数量 = 库存量 − 锁定数量</b>；期末余额 = Σ(结存 × 库存单价)；在途库存取未到货采购单合计。统计 Tab 合并库位维度、单价为加权单价。</span>
  </div>
)

/** 实测容器高度，扣除表头/分页实测高度，得出表格体 scroll.y，保证窗口不出现滚动条 */
function useTableScrollY(wrapRef: React.RefObject<HTMLDivElement | null>, deps: unknown[] = []) {
  const [scrollY, setScrollY] = useState<number>(400)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      const thead = el.querySelector('.ant-table-thead') as HTMLElement | null
      const pag = el.querySelector('.ant-pagination') as HTMLElement | null
      const theadH = thead ? thead.offsetHeight : 39
      // 分页: 自身高度 + 上外距16; 卡片: 底部内边距4 + 边框2; 无分页时仅卡片部分
      const extra = pag ? pag.offsetHeight + 16 + 4 + 2 : 4 + 2
      const y = el.clientHeight - theadH - extra
      setScrollY(Math.max(y, 120))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild as HTMLElement)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapRef, ...deps])
  return scrollY
}

function ColumnSettings({
  columns, config, onChange,
}: {
  columns: { key: string; title: string }[]
  config: { order: string[]; hidden: Record<string, boolean> }
  onChange: (config: { order: string[]; hidden: Record<string, boolean> }) => void
}) {
  const allKeys = columns.map(c => c.key)
  const titleMap: Record<string, string> = {}
  columns.forEach(c => { titleMap[c.key] = c.title })
  const order = [...config.order, ...allKeys.filter(k => !config.order.includes(k))]
  const hiddenCount = order.filter(k => config.hidden[k] === true).length
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const move = (from: number, to: number) => {
    const next = [...order]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onChange({ ...config, order: next })
  }

  const toggle = (key: string, checked: boolean) => {
    onChange({ ...config, hidden: { ...config.hidden, [key]: !checked } })
  }

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      content={
        <div style={{ width: 260 }}>
          <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>拖动图标调整顺序</span>
            <Space>
              <Button size="small" onClick={() => onChange({ ...config, hidden: {} })}>全选</Button>
              <Button size="small" onClick={() => onChange({ order: allKeys, hidden: {} })}>重置</Button>
            </Space>
          </div>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            {order.map((key, i) => {
              const isOver = overIdx === i && dragIdx !== null && dragIdx !== i
              return (
                <div
                  key={key}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => { e.preventDefault(); if (overIdx !== i) setOverIdx(i) }}
                  onDragLeave={() => { if (overIdx === i) setOverIdx(null) }}
                  onDrop={() => {
                    if (dragIdx !== null && dragIdx !== i) move(dragIdx, i)
                    setDragIdx(null); setOverIdx(null)
                  }}
                  onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                    borderRadius: 6, cursor: 'grab',
                    background: isOver ? '#e6f4ff' : undefined,
                    border: isOver ? '1px dashed #1677ff' : '1px solid transparent',
                  }}
                >
                  <HolderOutlined style={{ color: '#94a3b8', cursor: 'grab' }} />
                  <Checkbox checked={config.hidden[key] !== true} onChange={(e) => toggle(key, e.target.checked)} style={{ flex: 1 }}>
                    {titleMap[key]}
                  </Checkbox>
                </div>
              )
            })}
          </div>
        </div>
      }
    >
      <Button icon={<SettingOutlined />}>列设置{hiddenCount ? `（${hiddenCount}）` : ''}</Button>
    </Popover>
  )
}

function StatSummary({
  totals, stats, recentDays,
}: {
  totals: { onHand: number; locked: number; balance: number; inTransit: number; endingBalance: number }
  stats: { totalMaterials: number; countedMaterials: number }
  recentDays: number
}) {
  const num2 = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const countedTitle = recentDays >= 99999 ? '已盘（全部历史）' : recentDays === 0 ? '已盘（仅当天）' : `近 ${recentDays} 天已盘`
  const pct = stats.totalMaterials > 0 ? ((stats.countedMaterials / stats.totalMaterials) * 100).toFixed(1) : '0.0'
  const cards = [
    { color: '#5b5bd6', title: '库存物料数', value: stats.totalMaterials.toLocaleString(), sub: '按物料×仓库去重' },
    { color: '#16a34a', title: countedTitle, value: stats.countedMaterials.toLocaleString(), sub: `${pct}% · 口径随右侧切换` },
    { color: '#0284c7', title: '库存量合计', value: num2(totals.onHand), sub: '含锁定' },
    { color: '#d97706', title: '锁定数量', value: num2(totals.locked), sub: '已分配工单' },
    { color: '#8b5cf6', title: '结存数量', value: num2(totals.balance), sub: '= 库存 − 锁定' },
    { color: '#06b6d4', title: '在途库存', value: num2(totals.inTransit), sub: '在途采购单未到货' },
    { color: '#f59e0b', title: '期末余额', value: num2(totals.endingBalance), sub: 'Σ 结存 × 单价' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 10, marginBottom: 12 }}>
      {cards.map((c, i) => (
        <Card
          key={i}
          size="small"
          styles={{ body: { padding: '10px 12px', minWidth: 0 } }}
          style={{ borderLeft: `3px solid ${c.color}`, minWidth: 0 }}
        >
          <div style={{ fontSize: 'calc(12.5px * var(--font-size-scale))', color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</div>
          <div style={{ fontSize: 'calc(20px * var(--font-size-scale))', fontWeight: 650, fontVariantNumeric: 'tabular-nums', lineHeight: 1.25, marginTop: 2 }}>{c.value}</div>
          <div style={{ fontSize: 'calc(11.5px * var(--font-size-scale))', color: '#94a3b8', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.sub}</div>
        </Card>
      ))}
    </div>
  )
}

function SearchBar({
  keyword, setKeyword, onRefresh, onSearch, placeholder, extra, left,
}: {
  keyword: string
  setKeyword: (v: string) => void
  onRefresh: () => void
  onSearch: () => void
  placeholder: string
  extra?: React.ReactNode
  left?: React.ReactNode
}) {
  return (
    <div className="sc-toolbar">
      <span className="sc-search">
        <Input
          placeholder={placeholder}
          prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={onSearch}
          style={{ width: 240 }}
          allowClear
        />
      </span>
      {left}
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {extra}
        <Tooltip title="刷新">
          <Button icon={<ReloadOutlined />} onClick={onRefresh} />
        </Tooltip>
      </span>
    </div>
  )
}

/** 近期已盘天数: 0=仅当天;99999=不限(全部历史); 防抖 400ms 生效 */
function RecentDaysControl({
  value, onChange,
}: { value: number; onChange: (v: number) => void }) {
  const options = [
    { value: 1, label: '1天' },
    { value: 3, label: '3天' },
    { value: 7, label: '7天' },
    { value: 15, label: '15天' },
    { value: 30, label: '30天' },
    { value: 90, label: '90天' },
    { value: 99999, label: '不限' },
  ]
  if (!options.some((o) => o.value === value)) {
    options.push({ value, label: value === 0 ? '0天' : `${value}天` })
  }
  return (
    <Tooltip title="「近期已盘」= 近 N 天内盘点过;0=仅当天;不限=全部历史;修改后自动刷新">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 'calc(11.5px * var(--font-size-scale))', color: '#94a3b8', whiteSpace: 'nowrap' }}>近期已盘</span>
        <Segmented size="small" value={value} options={options} onChange={(v) => onChange(Number(v))} />
      </span>
    </Tooltip>
  )
}

/** 天数变化防抖触发重新加载 */
function useRecentDaysDebounce(days: number, reload: () => void) {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const t = setTimeout(reload, 400)
    return () => clearTimeout(t)
  }, [days]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** 库存明细：物料 x 仓库 x 库位 */
function InventoryDetail() {
  const [data, setData] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [recentDays, setRecentDays] = useState(99999) // 默认「不限（全部历史）」
  const [totals, setTotals] = useState({ onHand: 0, locked: 0, balance: 0, inTransit: 0, endingBalance: 0 })
  const [stats, setStats] = useState({ totalMaterials: 0, countedMaterials: 0 })
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [sortInfo, setSortInfo] = useState<{ sort_by?: string; sort_order?: string }>({})
  const [timeFilters, setTimeFilters] = useState<TimeFilters>({})
  const applyTimeFilter = (field: TimeFilterField, v?: TimeFilterValue) => {
    const next: TimeFilters = { ...timeFilters }
    if (v) next[field] = v
    else delete next[field]
    setTimeFilters(next)
    fetchData(1, pagination.pageSize, { timeFilters: next })
  }
  const [dormantFilter, setDormantFilter] = useState<DormantFilterValue | null>(null)
  const applyDormant = (v?: DormantFilterValue) => {
    const next = v ?? null
    setDormantFilter(next)
    fetchData(1, pagination.pageSize, { dormant: next })
  }
  const dormantCol = dormantColumn(dormantFilter ?? undefined, applyDormant)
  const timeCol = (field: TimeFilterField, title: string): any => ({
    title, dataIndex: field, key: field, width: 140, sorter: true, render: dtFmt,
    filtered: !!timeFilters[field],
    filterDropdown: (dp: any) => (
      <TimeFilterDropdown
        value={timeFilters[field]}
        onApply={(v) => { applyTimeFilter(field, v); dp?.confirm?.({ closeDropdown: true }) }}
      />
    ),
  })
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [colConfig, setColConfig] = useState<{ order: string[]; hidden: Record<string, boolean> }>(() => {
    try {
      const legacy = localStorage.getItem('inv_detail_col_keys')
      if (legacy) {
        localStorage.removeItem('inv_detail_col_keys')
        const legacyObj = JSON.parse(legacy)
        const hidden: Record<string, boolean> = {}
        Object.keys(legacyObj).forEach(k => { if (legacyObj[k] === false) hidden[k] = true })
        return { order: [], hidden }
      }
      const saved = JSON.parse(localStorage.getItem('inv_detail_cols') || '{}')
      if (saved && Array.isArray(saved.order) && saved.hidden && typeof saved.hidden === 'object') {
        return { order: saved.order, hidden: saved.hidden }
      }
    } catch { /* ignore */ }
    return { order: [], hidden: {} }
  })
  const { exporting, exportData } = useExport()
  const [exportColumnModalOpen, setExportColumnModalOpen] = useState(false)
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  const scrollY = useTableScrollY(tableWrapRef, [data.length, pagination.total])

  const fetchData = useCallback(async (
    page = 1,
    pageSize = 20,
    override?: { sort?: { sort_by?: string; sort_order?: string }; filters?: Record<string, string[]>; timeFilters?: TimeFilters; dormant?: DormantFilterValue | null },
  ) => {
    setLoading(true)
    try {
      const s = override?.sort ?? sortInfo
      const f = override?.filters ?? filters
      const params: any = { page, page_size: pageSize }
      Object.assign(params, timeFilterParams(override?.timeFilters ?? timeFilters))
      Object.assign(params, dormantParams(override?.dormant !== undefined ? override.dormant : dormantFilter))
      if (keyword) params.keyword = keyword
      if (s.sort_by) params.sort_by = s.sort_by
      if (s.sort_order) params.sort_order = s.sort_order
      if (f.material_code?.length) params.material_code = f.material_code.join(',')
      if (f.wh_code?.length) params.wh_code = f.wh_code.join(',')
      if (f.wh_name?.length) params.wh_name = f.wh_name.join(',')
      if (f.batch_no?.length) params.batch_no = f.batch_no.join(',')
      if (f.recent_checked?.length === 1) params.recent_checked = f.recent_checked[0]
      params.recent_days = recentDays
      const res: any = await api.get('/basicdata/inventory', { params })
      const items = res.data?.items || []
      setData(items)
      setPagination({
        current: res.data?.page || 1,
        pageSize: res.data?.page_size || 20,
        total: res.data?.total || 0,
      })

      const sums = res.data?.sums || {}
      setTotals({
        onHand: sums.qty_on_hand ?? 0,
        locked: sums.locked_qty ?? 0,
        balance: sums.balance_qty ?? 0,
        inTransit: sums.qty_in_transit ?? 0,
        endingBalance: sums.ending_balance ?? 0,
      })

      const s2 = res.data?.stats || {}
      setStats({
        totalMaterials: s2.total_materials ?? 0,
        countedMaterials: s2.counted_materials ?? 0,
      })
    } catch (error) {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [keyword, sortInfo, filters, recentDays, timeFilters, dormantFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  useRecentDaysDebounce(recentDays, () => fetchData(1, pagination.pageSize))

  useEffect(() => {
    fetchData(1, pagination.pageSize)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/basicdata/inventory/filter-options')
      .then((res: any) => setFilterOptions(res.data || {}))
      .catch(() => {})
  }, [])

  useEffect(() => {
    localStorage.setItem('inv_detail_cols', JSON.stringify(colConfig))
  }, [colConfig])

  const handleTableChange = (_pag: any, tableFilters: any, sorter: any) => {
    const sortField = sorter?.column?.key === 'days_in_stock' ? 'days_in_stock' : sorter.field
    const sortOrder = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : undefined
    const newFilters: Record<string, string[]> = {}
    if (tableFilters.material_code?.length) newFilters.material_code = tableFilters.material_code
    if (tableFilters.wh_code?.length) newFilters.wh_code = tableFilters.wh_code
    if (tableFilters.wh_name?.length) newFilters.wh_name = tableFilters.wh_name
    if (tableFilters.batch_no?.length) newFilters.batch_no = tableFilters.batch_no
    if (tableFilters.recent_checked?.length === 1) newFilters.recent_checked = tableFilters.recent_checked
    const sortChanged = sortField !== sortInfo.sort_by || sortOrder !== sortInfo.sort_order
    const filterChanged = JSON.stringify(newFilters) !== JSON.stringify(filters)
    const pageChanged = !!_pag?.current && _pag.current !== pagination.current
    if (!sortChanged && !filterChanged && !pageChanged) return
    const page = (sortChanged || filterChanged) ? 1 : (_pag.current || 1)
    setSortInfo({ sort_by: sortField, sort_order: sortOrder })
    setFilters(newFilters)
    fetchData(page, _pag.pageSize, { sort: { sort_by: sortField, sort_order: sortOrder }, filters: newFilters })
  }

  const handleExportConfirm = (selectedColumns: string[]) => {
    setExportColumnModalOpen(false)
    const params: Record<string, any> = { format: 'xlsx', columns: selectedColumns.join(',') }
    Object.assign(params, timeFilterParams(timeFilters))
    Object.assign(params, dormantParams(dormantFilter ?? undefined))
    if (keyword) params.keyword = keyword
    if (sortInfo.sort_by) params.sort_by = sortInfo.sort_by
    if (sortInfo.sort_order) params.sort_order = sortInfo.sort_order
    if (filters.material_code?.length) params.material_code = filters.material_code.join(',')
    if (filters.wh_code?.length) params.wh_code = filters.wh_code.join(',')
    if (filters.wh_name?.length) params.wh_name = filters.wh_name.join(',')
    if (filters.batch_no?.length) params.batch_no = filters.batch_no.join(',')
    if (filters.recent_checked?.length === 1) params.recent_checked = filters.recent_checked[0]
    params.recent_days = recentDays
    exportData('/api/v1/basicdata/inventory/export', params, `库存明细_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const allColumns = [
    { title: '物料编码', dataIndex: 'material_code', key: 'material_code', width: 120, sorter: true, filters: optList(filterOptions.material_codes), filterSearch: true },
    { title: '物料名称', dataIndex: 'material_name', key: 'material_name', width: 160, ellipsis: true, sorter: true },
    { title: '单位', dataIndex: 'unit_of_measure', key: 'unit_of_measure', width: 60, align: 'center' as const },
    { title: '仓库编码', dataIndex: 'wh_code', key: 'wh_code', width: 100, sorter: true, filters: optList(filterOptions.wh_codes), filterSearch: true },
    { title: '仓库名称', dataIndex: 'wh_name', key: 'wh_name', width: 120, filters: optList(filterOptions.wh_names), filterSearch: true },
    { title: '库位名称', dataIndex: 'location_name', key: 'location_name', width: 120, ellipsis: true },
    { title: '库存量', dataIndex: 'qty_on_hand', key: 'qty_on_hand', width: 100, align: 'right' as const, sorter: true, render: numFmt },
    { title: '锁定数量', dataIndex: 'locked_qty', key: 'locked_qty', width: 100, align: 'right' as const, sorter: true, render: numFmt },
    { title: '结存数量', dataIndex: 'balance_qty', key: 'balance_qty', width: 100, align: 'right' as const, sorter: true, render: numFmt },
    { title: '在途库存', dataIndex: 'qty_in_transit', key: 'qty_in_transit', width: 100, align: 'right' as const, sorter: true, render: numFmt },
    { title: '库存单价', dataIndex: 'unit_price', key: 'unit_price', width: 110, align: 'right' as const, sorter: true, render: priceFmt },
    { title: '期末余额', dataIndex: 'ending_balance', key: 'ending_balance', width: 120, align: 'right' as const, sorter: true, render: moneyFmt },
    { title: '批次号', dataIndex: 'batch_no', key: 'batch_no', width: 100, sorter: true, filters: optList(filterOptions.batch_nos), filterSearch: true },
    timeCol('last_inbound_at', '最后入库时间'),
    timeCol('last_outbound_at', '最后出库时间'),
    dormantCol,
    {
      title: '近期已盘', dataIndex: 'recent_checked', key: 'recent_checked', width: 90, align: 'center' as const,
      filters: [{ text: '是', value: 'true' }, { text: '否', value: 'false' }],
      render: (v: boolean, r: InventoryItem) => v ? (
        <Tooltip title={`近期已盘${r.recent_checked_date ? ' · ' + r.recent_checked_date : ''}${r.recent_checked_check_no ? ' · ' + r.recent_checked_check_no : ''}`}>
          <Tag color="green" style={{ marginInlineEnd: 0 }}>是</Tag>
        </Tooltip>
      ) : <span style={{ color: '#94a3b8' }}>否</span>,
    },
    {
      title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 160, sorter: true,
      render: (v: string) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
  ]
  const allKeys = allColumns.map(c => c.key)
  const colOrder = [...colConfig.order, ...allKeys.filter(k => !colConfig.order.includes(k))]
  const columns = colOrder
    .filter(k => !colConfig.hidden[k])
    .map(k => allColumns.find(c => c.key === k)!)
    .filter(Boolean)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0 }}>
        <StatSummary totals={totals} stats={stats} recentDays={recentDays} />
        <SearchBar
          keyword={keyword}
          setKeyword={setKeyword}
          onSearch={() => fetchData(1, pagination.pageSize)}
          onRefresh={() => fetchData(pagination.current, pagination.pageSize)}
          placeholder="搜索物料编码/名称/仓库"
          left={<RecentDaysControl value={recentDays} onChange={setRecentDays} />}
          extra={<Space><Button icon={<DownloadOutlined />} loading={exporting} onClick={() => setExportColumnModalOpen(true)}>导出</Button><ColumnSettings columns={allColumns} config={colConfig} onChange={setColConfig} /></Space>}
        />
        {FORMULA_NOTE}
      </div>

      <div ref={tableWrapRef} className="card-modern" style={{ padding: '0 0 4px', flex: 1, minHeight: 0 }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={data}
          loading={loading}
          scroll={{ x: 2150, y: scrollY }}
          size="small"
          onChange={handleTableChange}
          pagination={{
            ...pagination,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
            pageSizeOptions: ['20', '50', '100'],
          }}
        />
      </div>

      <ExportColumnSelector
        open={exportColumnModalOpen}
        columns={DETAIL_EXPORT_OPTIONS}
        onConfirm={handleExportConfirm}
        onCancel={() => setExportColumnModalOpen(false)}
      />
    </div>
  )
}

/** 按物料 x 仓库 统计（合并库位维度） */
function InventoryByWarehouse() {
  const [data, setData] = useState<InventoryByWhItem[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [recentDays, setRecentDays] = useState(99999) // 默认「不限（全部历史）」
  const [totals, setTotals] = useState({ onHand: 0, locked: 0, balance: 0, inTransit: 0, endingBalance: 0 })
  const [stats, setStats] = useState({ totalMaterials: 0, countedMaterials: 0 })
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [sortInfo, setSortInfo] = useState<{ sort_by?: string; sort_order?: string }>({})
  const [timeFilters, setTimeFilters] = useState<TimeFilters>({})
  const applyTimeFilter = (field: TimeFilterField, v?: TimeFilterValue) => {
    const next: TimeFilters = { ...timeFilters }
    if (v) next[field] = v
    else delete next[field]
    setTimeFilters(next)
    fetchData(1, pagination.pageSize, { timeFilters: next })
  }
  const [dormantFilter, setDormantFilter] = useState<DormantFilterValue | null>(null)
  const applyDormant = (v?: DormantFilterValue) => {
    const next = v ?? null
    setDormantFilter(next)
    fetchData(1, pagination.pageSize, { dormant: next })
  }
  const dormantCol = dormantColumn(dormantFilter ?? undefined, applyDormant)
  const timeCol = (field: TimeFilterField, title: string): any => ({
    title, dataIndex: field, key: field, width: 140, sorter: true, render: dtFmt,
    filtered: !!timeFilters[field],
    filterDropdown: (dp: any) => (
      <TimeFilterDropdown
        value={timeFilters[field]}
        onApply={(v) => { applyTimeFilter(field, v); dp?.confirm?.({ closeDropdown: true }) }}
      />
    ),
  })
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [colConfig, setColConfig] = useState<{ order: string[]; hidden: Record<string, boolean> }>(() => {
    try {
      const legacy = localStorage.getItem('inv_bywh_col_keys')
      if (legacy) {
        localStorage.removeItem('inv_bywh_col_keys')
        const legacyObj = JSON.parse(legacy)
        const hidden: Record<string, boolean> = {}
        Object.keys(legacyObj).forEach(k => { if (legacyObj[k] === false) hidden[k] = true })
        return { order: [], hidden }
      }
      const saved = JSON.parse(localStorage.getItem('inv_bywh_cols') || '{}')
      if (saved && Array.isArray(saved.order) && saved.hidden && typeof saved.hidden === 'object') {
        return { order: saved.order, hidden: saved.hidden }
      }
    } catch { /* ignore */ }
    return { order: [], hidden: {} }
  })
  const { exporting, exportData } = useExport()
  const [exportColumnModalOpen, setExportColumnModalOpen] = useState(false)
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  const scrollY = useTableScrollY(tableWrapRef, [data.length, pagination.total])

  const fetchData = useCallback(async (
    page = 1,
    pageSize = 20,
    override?: { sort?: { sort_by?: string; sort_order?: string }; filters?: Record<string, string[]>; timeFilters?: TimeFilters; dormant?: DormantFilterValue | null },
  ) => {
    setLoading(true)
    try {
      const s = override?.sort ?? sortInfo
      const f = override?.filters ?? filters
      const params: any = { page, page_size: pageSize }
      Object.assign(params, timeFilterParams(override?.timeFilters ?? timeFilters))
      Object.assign(params, dormantParams(override?.dormant !== undefined ? override.dormant : dormantFilter))
      if (keyword) params.keyword = keyword
      if (s.sort_by) params.sort_by = s.sort_by
      if (s.sort_order) params.sort_order = s.sort_order
      if (f.material_code?.length) params.material_code = f.material_code.join(',')
      if (f.wh_code?.length) params.wh_code = f.wh_code.join(',')
      if (f.wh_name?.length) params.wh_name = f.wh_name.join(',')
      if (f.recent_checked?.length === 1) params.recent_checked = f.recent_checked[0]
      params.recent_days = recentDays
      const res: any = await api.get('/basicdata/inventory/by-warehouse', { params })
      setData(res.data?.items || [])
      setPagination({
        current: res.data?.page || 1,
        pageSize: res.data?.page_size || 20,
        total: res.data?.total || 0,
      })

      const sums = res.data?.sums || {}
      setTotals({
        onHand: sums.qty_on_hand ?? 0,
        locked: sums.locked_qty ?? 0,
        balance: sums.balance_qty ?? 0,
        inTransit: sums.qty_in_transit ?? 0,
        endingBalance: sums.ending_balance ?? 0,
      })

      const s2 = res.data?.stats || {}
      setStats({
        totalMaterials: s2.total_materials ?? 0,
        countedMaterials: s2.counted_materials ?? 0,
      })
    } catch (error) {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [keyword, sortInfo, filters, recentDays, timeFilters, dormantFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  useRecentDaysDebounce(recentDays, () => fetchData(1, pagination.pageSize))

  useEffect(() => {
    fetchData(1, pagination.pageSize)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/basicdata/inventory/filter-options')
      .then((res: any) => setFilterOptions(res.data || {}))
      .catch(() => {})
  }, [])

  useEffect(() => {
    localStorage.setItem('inv_bywh_cols', JSON.stringify(colConfig))
  }, [colConfig])

  const handleTableChange = (_pag: any, tableFilters: any, sorter: any) => {
    const sortField = sorter?.column?.key === 'days_in_stock' ? 'days_in_stock' : sorter.field
    const sortOrder = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : undefined
    const newFilters: Record<string, string[]> = {}
    if (tableFilters.material_code?.length) newFilters.material_code = tableFilters.material_code
    if (tableFilters.wh_code?.length) newFilters.wh_code = tableFilters.wh_code
    if (tableFilters.wh_name?.length) newFilters.wh_name = tableFilters.wh_name
    if (tableFilters.recent_checked?.length === 1) newFilters.recent_checked = tableFilters.recent_checked
    const sortChanged = sortField !== sortInfo.sort_by || sortOrder !== sortInfo.sort_order
    const filterChanged = JSON.stringify(newFilters) !== JSON.stringify(filters)
    const pageChanged = !!_pag?.current && _pag.current !== pagination.current
    if (!sortChanged && !filterChanged && !pageChanged) return
    const page = (sortChanged || filterChanged) ? 1 : (_pag.current || 1)
    setSortInfo({ sort_by: sortField, sort_order: sortOrder })
    setFilters(newFilters)
    fetchData(page, _pag.pageSize, { sort: { sort_by: sortField, sort_order: sortOrder }, filters: newFilters })
  }

  const handleExportConfirm = (selectedColumns: string[]) => {
    setExportColumnModalOpen(false)
    const params: Record<string, any> = { format: 'xlsx', columns: selectedColumns.join(',') }
    Object.assign(params, timeFilterParams(timeFilters))
    Object.assign(params, dormantParams(dormantFilter ?? undefined))
    if (keyword) params.keyword = keyword
    if (sortInfo.sort_by) params.sort_by = sortInfo.sort_by
    if (sortInfo.sort_order) params.sort_order = sortInfo.sort_order
    if (filters.material_code?.length) params.material_code = filters.material_code.join(',')
    if (filters.wh_code?.length) params.wh_code = filters.wh_code.join(',')
    if (filters.wh_name?.length) params.wh_name = filters.wh_name.join(',')
    if (filters.recent_checked?.length === 1) params.recent_checked = filters.recent_checked[0]
    params.recent_days = recentDays
    exportData('/api/v1/basicdata/inventory/by-warehouse/export', params, `按物料仓库库存_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const allColumns = [
    { title: '物料编码', dataIndex: 'material_code', key: 'material_code', width: 120, sorter: true, filters: optList(filterOptions.material_codes), filterSearch: true },
    { title: '物料名称', dataIndex: 'material_name', key: 'material_name', width: 180, ellipsis: true, sorter: true },
    { title: '单位', dataIndex: 'unit_of_measure', key: 'unit_of_measure', width: 60, align: 'center' as const },
    { title: '仓库编码', dataIndex: 'wh_code', key: 'wh_code', width: 100, sorter: true, filters: optList(filterOptions.wh_codes), filterSearch: true },
    { title: '仓库名称', dataIndex: 'wh_name', key: 'wh_name', width: 140, filters: optList(filterOptions.wh_names), filterSearch: true },
    {
      title: '库位数', dataIndex: 'location_count', key: 'location_count', width: 80, align: 'right' as const,
      render: (v: number) => (v != null ? v.toLocaleString() : '-'),
    },
    { title: '库存量', dataIndex: 'qty_on_hand', key: 'qty_on_hand', width: 110, align: 'right' as const, sorter: true, render: numFmt },
    { title: '锁定数量', dataIndex: 'locked_qty', key: 'locked_qty', width: 110, align: 'right' as const, sorter: true, render: numFmt },
    { title: '结存数量', dataIndex: 'balance_qty', key: 'balance_qty', width: 110, align: 'right' as const, sorter: true, render: numFmt },
    { title: '在途库存', dataIndex: 'qty_in_transit', key: 'qty_in_transit', width: 110, align: 'right' as const, sorter: true, render: numFmt },
    { title: '加权单价', dataIndex: 'unit_price', key: 'unit_price', width: 120, align: 'right' as const, render: priceFmt },
    { title: '期末余额', dataIndex: 'ending_balance', key: 'ending_balance', width: 130, align: 'right' as const, sorter: true, render: moneyFmt },
    timeCol('last_inbound_at', '最后入库时间'),
    timeCol('last_outbound_at', '最后出库时间'),
    dormantCol,
    {
      title: '近期已盘', dataIndex: 'recent_checked', key: 'recent_checked', width: 90, align: 'center' as const,
      filters: [{ text: '是', value: 'true' }, { text: '否', value: 'false' }],
      render: (v: boolean, r: InventoryByWhItem) => v ? (
        <Tooltip title={`近期已盘${r.recent_checked_date ? ' · ' + r.recent_checked_date : ''}${r.recent_checked_check_no ? ' · ' + r.recent_checked_check_no : ''}`}>
          <Tag color="green" style={{ marginInlineEnd: 0 }}>是</Tag>
        </Tooltip>
      ) : <span style={{ color: '#94a3b8' }}>否</span>,
    },
  ]
  const allKeys = allColumns.map(c => c.key)
  const colOrder = [...colConfig.order, ...allKeys.filter(k => !colConfig.order.includes(k))]
  const columns = colOrder
    .filter(k => !colConfig.hidden[k])
    .map(k => allColumns.find(c => c.key === k)!)
    .filter(Boolean)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flexShrink: 0 }}>
        <StatSummary totals={totals} stats={stats} recentDays={recentDays} />
        <SearchBar
          keyword={keyword}
          setKeyword={setKeyword}
          onSearch={() => fetchData(1, pagination.pageSize)}
          onRefresh={() => fetchData(pagination.current, pagination.pageSize)}
          placeholder="搜索物料编码/名称/仓库"
          left={<RecentDaysControl value={recentDays} onChange={setRecentDays} />}
          extra={<Space><Button icon={<DownloadOutlined />} loading={exporting} onClick={() => setExportColumnModalOpen(true)}>导出</Button><ColumnSettings columns={allColumns} config={colConfig} onChange={setColConfig} /></Space>}
        />
        {FORMULA_NOTE}
      </div>

      <div ref={tableWrapRef} className="card-modern" style={{ padding: '0 0 4px', flex: 1, minHeight: 0 }}>
        <Table
          rowKey={(r) => `${r.material_id}-${r.wh_id}`}
          columns={columns}
          dataSource={data}
          loading={loading}
          scroll={{ x: 1750, y: scrollY }}
          size="small"
          onChange={handleTableChange}
          pagination={{
            ...pagination,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
            pageSizeOptions: ['20', '50', '100'],
          }}
        />
      </div>

      <ExportColumnSelector
        open={exportColumnModalOpen}
        columns={BYWH_EXPORT_OPTIONS}
        onConfirm={handleExportConfirm}
        onCancel={() => setExportColumnModalOpen(false)}
      />
    </div>
  )
}

export default function Inventory() {
  const [activeKey, setActiveKey] = useState('detail')

  return (
    <div className="sc-page" style={{ height: 'calc(100vh - 104px)', overflow: 'hidden' }}>
      <Tabs
        className="inv-page-tabs"
        activeKey={activeKey}
        onChange={setActiveKey}
        destroyInactiveTabPane
        items={[
          { key: 'detail', label: '库存明细（物料/仓库/库位）', children: <InventoryDetail /> },
          { key: 'by-wh', label: '按物料/仓库统计', children: <InventoryByWarehouse /> },
        ]}
      />
    </div>
  )
}
