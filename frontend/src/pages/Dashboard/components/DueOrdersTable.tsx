import { Link } from 'react-router-dom'
import { Spin } from 'antd'

interface TodayDueOrder {
  order_no: string
  line_no: string | null
  customer: string | null
  product_name: string | null
  order_qty: number | null
  promised_date: string | null
  risk_level: string | null
  owner: string | null
  risk_score: number | null
}

interface DueOrdersTableProps {
  orders: TodayDueOrder[]
  loading: boolean
}

const RISK_TAG: Record<string, { cls: string; label: string }> = {
  red: { cls: 'tag-risk-high', label: '高' },
  yellow: { cls: 'tag-risk-mid', label: '中' },
  blue: { cls: 'tag-risk-blue', label: '低' },
  green: { cls: 'tag-risk-low', label: '正常' },
}

function scoreBar(score: number | null) {
  if (score == null || isNaN(score)) return <span className="chart-note">—</span>
  const pct = Math.max(0, Math.min(100, Math.round(score)))
  const cls = pct > 70 ? 'v-bad' : pct > 40 ? 'v-mid' : 'v-good'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="progress" style={{ flex: 1 }}><i className={cls} style={{ width: `${pct}%` }} /></div>
      <span className="mono">{pct}</span>
    </div>
  )
}

export default function DueOrdersTable({ orders, loading }: DueOrdersTableProps) {
  const shown = orders.slice(0, 8)
  const totalQty = shown.reduce((s, o) => s + (o.order_qty ?? 0), 0)
  const redN = orders.filter((o) => o.risk_level === 'red').length
  const scores = shown.filter((o) => o.risk_score != null).map((o) => o.risk_score as number)
  const avgScore = scores.length ? (scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(1) : '—'
  const todayStr = new Date().toISOString().slice(0, 10)

  return (
    <div className="card">
      <div className="card-head">
        <h3>今日到期订单</h3>
        <span className="tag tag-risk-high">高 {redN}</span>
        <span className="hint">共 {orders.length} 单 · 今日完成齐套确认</span>
        <Link className="more" to="/orders">全部 →</Link>
      </div>
      <div className="card-body p0 tbl-wrap">
        {loading && orders.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
        ) : shown.length === 0 ? (
          <div className="tbl-empty"><p>今日暂无到期订单</p></div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>订单号</th><th>客户</th><th>产品</th><th className="num">数量</th>
                <th>交期</th><th style={{ width: 120 }}>风险评分</th><th>风险</th><th>负责人</th><th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => {
                const tag = RISK_TAG[o.risk_level ?? ''] ?? { cls: 'tag-risk-none', label: '未评估' }
                const detailPath = o.line_no ? `/orders/${o.order_no}/lines/${o.line_no}` : `/orders/${o.order_no}`
                const isToday = o.promised_date === todayStr
                return (
                  <tr key={`${o.order_no}-${o.line_no ?? ''}`}>
                    <td className="strong mono">{o.order_no}{o.line_no ? `-${o.line_no}` : ''}</td>
                    <td>{o.customer || '—'}</td>
                    <td>{o.product_name || '—'}</td>
                    <td className="num">{o.order_qty != null ? o.order_qty.toLocaleString() : '—'}</td>
                    <td>
                      <span className={`due-pill ${isToday ? 'urgent' : 'ok'}`}>{o.promised_date?.slice(5) ?? '—'}</span>
                    </td>
                    <td>{scoreBar(o.risk_score)}</td>
                    <td><span className={`tag ${tag.cls}`}><span className="dot" />{tag.label}</span></td>
                    <td>{o.owner || '—'}</td>
                    <td>
                      <span className="row-actions" style={{ opacity: 1 }}>
                        <Link to={detailPath}>详情</Link>
                      </span>
                    </td>
                  </tr>
                )
              })}
              <tr className="aggregate">
                <td className="lbl">合计 {orders.length} 单</td>
                <td></td><td></td>
                <td className="num">{totalQty.toLocaleString()}</td>
                <td></td>
                <td className="lbl">平均 {avgScore}</td>
                <td>高 {redN}</td>
                <td></td><td></td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
