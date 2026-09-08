interface RiskDimensionItem {
  name: string
  red_count: number
  yellow_count: number
  blue_count: number
  green_count: number
  total_count: number
}

interface OrderRiskDistributionData {
  by_risk_level: RiskDimensionItem[]
}

interface RiskDonutProps {
  data: OrderRiskDistributionData | null
  loading: boolean
}

const R = 52
const CIRC = 2 * Math.PI * R

export default function RiskDonut({ data, loading }: RiskDonutProps) {
  let red = 0
  let yellow = 0
  let blue = 0
  let green = 0
  for (const row of data?.by_risk_level ?? []) {
    red += row.red_count
    yellow += row.yellow_count
    blue += row.blue_count
    green += row.green_count
  }
  const total = red + yellow + blue + green
  const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0.0')

  const segs = [
    { key: 'high', label: '高', count: red, color: '#dc2626' },
    { key: 'mid', label: '中', count: yellow, color: '#d97706' },
    { key: 'low', label: '低', count: blue, color: '#0284c7' },
    { key: 'green', label: '正常', count: green, color: '#16a34a' },
  ]

  let offset = 0

  return (
    <div className="card">
      <div className="card-head">
        <h3>订单风险分布</h3>
        <span className="hint">在途 {total} 单</span>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        {loading && !data ? (
          <div className="tbl-empty"><p>加载中…</p></div>
        ) : (
          <>
            <svg viewBox="0 0 170 150" width="176" className="chart-svg">
              <circle cx="85" cy="80" r={R} fill="none" stroke="#f1f5f9" strokeWidth="18" />
              <g transform="rotate(-90 85 80)" fill="none" strokeWidth="18" strokeLinecap="butt">
                {total > 0 && segs.filter((s) => s.count > 0).map((s) => {
                  const len = (s.count / total) * CIRC
                  const el = (
                    <circle
                      key={s.key}
                      cx="85" cy="80" r={R}
                      stroke={s.color}
                      strokeDasharray={`${len} ${CIRC - len}`}
                      strokeDashoffset={-offset}
                      opacity={s.key === 'green' ? 0.8 : 1}
                    >
                      <title>{`${s.label} ${s.count} · ${pct(s.count)}%`}</title>
                    </circle>
                  )
                  offset += len
                  return el
                })}
              </g>
              <text x="85" y="77" textAnchor="middle" fontSize="22" fontWeight="650" fill="#0f172a">{total}</text>
              <text x="85" y="94" textAnchor="middle" fontSize="10.5" fill="#94a3b8">在途订单</text>
            </svg>
            <div className="legend" style={{ justifyContent: 'center', flexDirection: 'column', alignItems: 'flex-start', gap: '6px 18px' }}>
              {segs.map((s) => (
                <span key={s.key}>
                  <i style={{ background: s.color }} />{s.label} <b className="mono">{s.count}</b> · {pct(s.count)}%
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
