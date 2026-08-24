import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PullToRefresh, Tag, ErrorBlock, SpinLoading } from 'antd-mobile'
import { dashboardApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'

interface Summary { total_orders: number; red_count: number; yellow_count: number; blue_count: number; green_count: number }

interface RollingDay { date: string; due_count: number; red_count: number; yellow_count: number; blue_count: number }

interface DueOrder {
  order_no: string
  line_no: string | null
  customer: string | null
  product_name: string | null
  promised_date: string | null
  risk_level: string | null
  owner: string | null
}

const RISK_COLORS: Record<string, string> = { red: '#e11d48', yellow: '#d97706', blue: '#3b82f6', green: '#059669' }
const RISK_LABELS: Record<string, string> = { red: '高', yellow: '中', blue: '低', green: '正常' }

const APP_GROUPS = [
  {
    group: '智能仓储',
    items: [
      { key: 'stock-check', title: '物料盘点', path: '/stock-check', perm: ['materials.stock_check', 'read'] as const },
    ],
  },
]

function AppGrid() {
  const navigate = useNavigate()
  const hasPermission = useAuthStore((s) => s.hasPermission)
  const groups = APP_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((e) => hasPermission(e.perm[0], e.perm[1])) }))
    .filter((g) => g.items.length > 0)
  if (groups.length === 0) return null
  return (
    <div className="mobile-card">
      {groups.map((g, gi) => (
        <div key={g.group}>
          {(gi > 0 || groups.length > 1) && (
            <div style={{ fontSize: 12, color: '#94a3b8', margin: gi > 0 ? '12px 0 8px' : '0 0 8px' }}>{g.group}</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {g.items.map((e) => (
              <div
                key={e.key}
                onClick={() => navigate(e.path)}
                style={{ textAlign: 'center', padding: '8px 0', borderRadius: 10, background: '#f1f2f8' }}
              >
                <div style={{ fontSize: 22 }}>📋</div>
                <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>{e.title}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function WorkbenchPage() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [rolling, setRolling] = useState<RollingDay[]>([])
  const [dueOrders, setDueOrders] = useState<DueOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const [s, r, d] = await Promise.all([
        dashboardApi.getSummary(),
        dashboardApi.getRollingRisk(),
        dashboardApi.getTodayDueOrders({ page: 1, page_size: 50 }),
      ])
      setSummary((s as any).data)
      setRolling(((r as any).data?.days || []) as RollingDay[])
      setDueOrders(((d as any).data?.items || (d as any).data || []) as DueOrder[])
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const maxDue = Math.max(1, ...rolling.map((d) => d.due_count))

  return (
    <div className="mobile-page mobile-page--with-tabbar">
      <PullToRefresh onRefresh={load}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', margin: '4px 0 12px' }}>工作台</div>

        {loading && <div style={{ textAlign: 'center', padding: 40 }}><SpinLoading color="primary" /></div>}
        {failed && <ErrorBlock status="empty" title="加载失败" description="下拉重试" />}

        <AppGrid />

        {summary && summary.total_orders > 0 && (
          <div className="mobile-card">
            <h3 className="mobile-card__title">风险分布</h3>
            <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', height: 10 }}>
              {(['red', 'yellow', 'blue', 'green'] as const).map((k) => {
                const v = summary[`${k}_count` as keyof Summary] as number
                return <div key={k} style={{ width: `${(v / summary.total_orders) * 100}%`, background: RISK_COLORS[k] }} />
              })}
            </div>
            <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 12, color: '#64748b', flexWrap: 'wrap' }}>
              {(['red', 'yellow', 'blue', 'green'] as const).map((k) => (
                <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: RISK_COLORS[k] }} />
                  {RISK_LABELS[k]} {summary[`${k}_count` as keyof Summary] as number}
                </span>
              ))}
            </div>
          </div>
        )}

        {rolling.length > 0 && (
          <div className="mobile-card">
            <h3 className="mobile-card__title">14 天滚动风险</h3>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 90 }}>
              {rolling.map((d) => (
                <div key={d.date} style={{ flex: 1, textAlign: 'center' }} title={`${d.date} 到期${d.due_count} 高风险${d.red_count}`}>
                  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: 70, gap: 1 }}>
                    <div style={{ height: `${(d.red_count / maxDue) * 40}px`, background: '#e11d48', borderRadius: 2, minHeight: d.red_count > 0 ? 3 : 0 }} />
                    <div style={{ height: `${(d.yellow_count / maxDue) * 30}px`, background: '#d97706', borderRadius: 2, minHeight: d.yellow_count > 0 ? 3 : 0 }} />
                    <div style={{ height: `${(d.due_count / maxDue) * 30}px`, background: '#c7d2fe', borderRadius: 2, minHeight: d.due_count > 0 ? 3 : 0 }} />
                  </div>
                  <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3 }}>{d.date.slice(5)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {dueOrders.length > 0 && (
          <div className="mobile-card">
            <h3 className="mobile-card__title">今日到期订单</h3>
            {dueOrders.map((o, i) => (
              <div key={`${o.order_no}-${o.line_no}-${i}`} style={{ padding: '8px 0', borderBottom: i < dueOrders.length - 1 ? '1px solid #f1f5f9' : 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 600, color: '#334155', fontSize: 13 }}>{o.order_no}{o.line_no ? `-${o.line_no}` : ''}</span>
                  {o.risk_level && (
                    <span style={{ fontSize: 11, borderRadius: 6, padding: '1px 8px', background: (RISK_COLORS[o.risk_level] || '#94a3b8') + '18', color: RISK_COLORS[o.risk_level] || '#64748b' }}>
                      {RISK_LABELS[o.risk_level] || o.risk_level}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                  {[o.customer, o.product_name].filter(Boolean).join(' · ') || '-'}
                </div>
              </div>
            ))}
          </div>
        )}
      </PullToRefresh>
    </div>
  )
}
