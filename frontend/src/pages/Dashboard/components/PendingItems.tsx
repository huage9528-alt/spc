import { Link } from 'react-router-dom'

interface OverviewData {
  pending_close_issues: number
  overdue_tasks: number
  shortage_orders: number
  in_transit_po: number
  eta_overdue_po: number
  due_today_red: number
  due_today_yellow: number
}

interface PendingItemsProps {
  overview: OverviewData | null
}

const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  width: 15,
  height: 15,
}

export default function PendingItems({ overview }: PendingItemsProps) {
  const o = overview
  const rows = [
    {
      to: '/issues',
      icoStyle: { background: 'var(--brand-50)', color: 'var(--brand-600)' },
      icon: (
        <svg {...iconProps}><path d="m4.5 12.5 5 5 10-11" /></svg>
      ),
      name: '待关闭异常',
      desc: `其中超时 ${o?.overdue_tasks ?? 0} 项`,
      n: o?.pending_close_issues ?? 0,
      hot: (o?.overdue_tasks ?? 0) > 0,
    },
    {
      to: '/material-issues',
      icoStyle: { background: 'var(--warning-bg)', color: 'var(--warning)' },
      icon: (
        <svg {...iconProps}><path d="M3.5 8 12 4l8.5 4v8L12 20l-8.5-4z" /><path d="M3.5 8 12 12l8.5-4M12 12v8" /></svg>
      ),
      name: '欠料订单',
      desc: `在途PO ${o?.in_transit_po ?? 0} 单`,
      n: o?.shortage_orders ?? 0,
      hot: (o?.shortage_orders ?? 0) > 0,
    },
    {
      to: '/purchase-plan',
      icoStyle: { background: 'var(--danger-bg)', color: 'var(--danger)' },
      icon: (
        <svg {...iconProps}><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4M12 17.2v.1" /></svg>
      ),
      name: 'ETA 逾期在途PO',
      desc: `在途共 ${o?.in_transit_po ?? 0} 单`,
      n: o?.eta_overdue_po ?? 0,
      hot: (o?.eta_overdue_po ?? 0) > 0,
    },
    {
      to: '/orders',
      icoStyle: { background: 'var(--info-bg)', color: 'var(--info)' },
      icon: (
        <svg {...iconProps}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></svg>
      ),
      name: '今日应交红黄灯',
      desc: `红 ${o?.due_today_red ?? 0} · 黄 ${o?.due_today_yellow ?? 0}`,
      n: (o?.due_today_red ?? 0) + (o?.due_today_yellow ?? 0),
      hot: (o?.due_today_red ?? 0) > 0,
    },
  ]

  return (
    <div className="card">
      <div className="card-head">
        <h3>待处理事项</h3>
        <Link className="more" to="/issues">全部 →</Link>
      </div>
      <div className="card-body todo-list" style={{ paddingTop: 6 }}>
        {rows.map((r) => (
          <Link key={r.name} to={r.to} className="row">
            <div className="ico" style={r.icoStyle}>{r.icon}</div>
            <div>
              <div className="name">{r.name}</div>
              <div className="desc">{r.desc}</div>
            </div>
            <span className={`n ${r.hot ? 'hot' : ''}`}>{r.n}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
