import dayjs from 'dayjs'

export interface OccupancyOrderRow {
  order_no: string
  line_no: string
  customer: string | null
  product_code: string | null
  product_name: string | null
  promised_date: string | null
  order_qty: number | string | null
  completed_qty: number | string | null
  open_qty: number | string
  unit_qty: number | string
  scrap_rate: number | string | null
  demand_qty: number | string
  available_qty: number | string
  allocated_qty: number | string
  shortage_qty: number | string
  status: string
}

export interface MaterialOccupancyData {
  material_code: string
  material_name: string | null
  spec_model: string | null
  unit_of_measure: string | null
  material_property: number | null
  stock_qty: number | string
  transit_qty: number | string
  order_count: number
  total_demand_qty: number | string
  total_allocated_qty: number | string
  total_shortage_qty: number | string
  rows: OccupancyOrderRow[]
  skipped_lines: number
}

export interface OccupancyMaterialRow {
  level: number
  material_id: number
  material_code: string
  material_name: string | null
  spec_model: string | null
  unit_of_measure: string | null
  scrap_rate: number | string | null
  unit_qty: number | string
  demand_qty: number | string
  stock_qty: number | string
  prior_allocated_qty: number | string
  available_qty: number | string
  allocated_qty: number | string
  shortage_qty: number | string
  status: string
}

export interface OrderLineOccupancy {
  line_no: string
  product_code: string | null
  product_name: string | null
  promised_date: string | null
  order_qty: number | string | null
  completed_qty: number | string | null
  open_qty: number | string
  bom_id: string | null
  rows: OccupancyMaterialRow[]
}

export interface OrderOccupancyData {
  order_no: string
  customer: string | null
  skipped_lines: number
  shortage_material_count: number
  lines: OrderLineOccupancy[]
}

export const num = (v: number | string | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v)

export const fmt = (v: number | string | null | undefined): string =>
  v === null || v === undefined ? '-' : num(v).toLocaleString(undefined, { maximumFractionDigits: 2 })

export const duePill = (d: string | null): JSX.Element => {
  if (!d) return <span className="occ-zero">-</span>
  const days = dayjs(d).startOf('day').diff(dayjs().startOf('day'), 'day')
  const cls = days < 0 ? 'occ-due-urgent' : days <= 7 ? 'occ-due-soon' : 'occ-due-ok'
  const label = days < 0 ? `逾期${-days}天` : days === 0 ? '今天' : `${days}天`
  const md = d.slice(5).replace('-', '/')
  return (
    <span className={`occ-due ${cls}`}>
      {md} · {label}
    </span>
  )
}

export const statusTag = (status: string): JSX.Element => {
  const map: Record<string, { cls: string; label: string }> = {
    met: { cls: 'occ-tag-met', label: '满足' },
    partial: { cls: 'occ-tag-partial', label: '部分' },
    shortage: { cls: 'occ-tag-shortage', label: '欠料' },
  }
  const it = map[status] || map.shortage
  return (
    <span className={`occ-tag ${it.cls}`}>
      <span className="dot" />
      {it.label}
    </span>
  )
}

export const exportCsv = (filename: string, headers: string[], rows: (string | number)[][]) => {
  const esc = (v: string | number) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = '\ufeff' + [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export const pushRecent = (key: string, value: string) => {
  try {
    const raw = localStorage.getItem(key)
    const list: string[] = raw ? JSON.parse(raw) : []
    const next = [value, ...list.filter((v) => v !== value)].slice(0, 5)
    localStorage.setItem(key, JSON.stringify(next))
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export const getRecent = (key: string): string[] => {
  try {
    const raw = localStorage.getItem(key)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}
