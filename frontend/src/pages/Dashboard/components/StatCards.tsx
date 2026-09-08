interface OverviewData {
  due_today: number
  due_today_red: number
  due_today_yellow: number
  shortage_orders: number
  in_transit_po: number
  eta_overdue_po: number
  total_orders: number
  red_orders: number
  yellow_orders: number
}

interface StatCardsProps {
  overview: OverviewData | null
  closureRate: number
  overdueIssues: number
  loading: boolean
}

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function DocIcon() {
  return (
    <svg {...iconProps}>
      <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </svg>
  )
}

function BoxIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3.5 8 12 4l8.5 4v8L12 20l-8.5-4z" />
      <path d="M3.5 8 12 12l8.5-4M12 12v8" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 4 2.8 19.5h18.4z" />
      <path d="M12 10v4M12 17.2v.1" />
    </svg>
  )
}

function CheckCircleIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8 12.3 2.8 2.8 5.2-5.8" />
    </svg>
  )
}

export default function StatCards({ overview, closureRate, overdueIssues, loading }: StatCardsProps) {
  const o = overview
  const dash = loading ? '—' : null
  const v = (n: number | undefined) => (dash ?? (n ?? 0).toLocaleString())

  return (
    <>
      <div className="card stat-card" style={{ '--accent': 'var(--brand-500)', '--accent-bg': 'var(--brand-50)' } as React.CSSProperties}>
        <div className="stat-icon"><DocIcon /></div>
        <div className="stat-main">
          <div className="label">今日待交付订单</div>
          <div className="value">{v(o?.due_today)}<small>单</small></div>
          <span className="delta flat">
            红灯 <span className="bad">{o?.due_today_red ?? 0}</span> · 黄灯 <span className="warn">{o?.due_today_yellow ?? 0}</span>
          </span>
        </div>
      </div>

      <div className="card stat-card" style={{ '--accent': 'var(--warning)', '--accent-bg': 'var(--warning-bg)' } as React.CSSProperties}>
        <div className="stat-icon"><BoxIcon /></div>
        <div className="stat-main">
          <div className="label">欠料订单</div>
          <div className="value">{v(o?.shortage_orders)}<small>单</small></div>
          <span className="delta flat">在途PO {o?.in_transit_po ?? 0}</span>
        </div>
      </div>

      <div className="card stat-card" style={{ '--accent': 'var(--danger)', '--accent-bg': 'var(--danger-bg)' } as React.CSSProperties}>
        <div className="stat-icon"><AlertIcon /></div>
        <div className="stat-main">
          <div className="label">风险订单</div>
          <div className="value">{v(o?.red_orders)}<small>单</small></div>
          <span className="delta flat">
            黄灯 <span className="warn">{o?.yellow_orders ?? 0}</span> · 在途共 {o?.total_orders ?? 0}
          </span>
        </div>
      </div>

      <div className="card stat-card" style={{ '--accent': 'var(--success)', '--accent-bg': 'var(--success-bg)' } as React.CSSProperties}>
        <div className="stat-icon"><CheckCircleIcon /></div>
        <div className="stat-main">
          <div className="label">异常闭环达成率</div>
          <div className="value">
            {loading ? '—' : `${(closureRate * 100).toFixed(1)}`}<small>%</small>
          </div>
          <span className="delta flat">
            超时未闭环 {overdueIssues > 0 ? <span className="bad">{overdueIssues}</span> : 0}
          </span>
        </div>
      </div>
    </>
  )
}
