interface TrendPoint {
  date: string
  new: number
  closed: number
}

interface ClosureSparklineProps {
  trend: TrendPoint[]
  rate: number
}

const W = 280
const H = 66

export default function ClosureSparkline({ trend, rate }: ClosureSparklineProps) {
  const pts = trend.length ? trend : []
  const n = Math.max(pts.length, 2)
  const maxV = Math.max(1, ...pts.map((p) => p.closed))
  const stepX = (W - 12) / (n - 1)
  const y = (v: number) => H - 6 - (v / maxV) * (H - 14)

  const coords = pts.map((p, i) => `${(6 + stepX * i).toFixed(1)},${y(p.closed).toFixed(1)}`)
  const line = coords.join(' ')
  const area = coords.length ? `M${line.replace(/ /g, ' L')} L${(6 + stepX * (pts.length - 1)).toFixed(1)},${H - 4} L6,${H - 4} Z` : ''
  const lastX = 6 + stepX * (pts.length - 1)
  const lastY = pts.length ? y(pts[pts.length - 1].closed) : H - 6

  return (
    <div className="card">
      <div className="card-head">
        <h3>闭环达成走势</h3>
        <span className="hint">近 7 天</span>
        <span style={{ marginLeft: 'auto', fontSize: 18, fontWeight: 650, color: 'var(--success)' }} className="mono">
          {(rate * 100).toFixed(1)}%
        </span>
      </div>
      <div className="card-body" style={{ padding: '10px 14px 6px' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="chart-svg">
          {coords.length > 1 ? (
            <>
              <path d={area} fill="#16a34a" opacity=".09" />
              <polyline points={line} fill="none" stroke="#16a34a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              {pts.map((p, i) => (
                <circle key={p.date} cx={6 + stepX * i} cy={y(p.closed)} r={i === pts.length - 1 ? 2.8 : 0} fill="#16a34a">
                  <title>{`${p.date} 闭环 ${p.closed} · 新增 ${p.new}`}</title>
                </circle>
              ))}
              <circle cx={lastX} cy={lastY} r="2.8" fill="#16a34a" stroke="#fff" strokeWidth="1.5" />
            </>
          ) : (
            <line x1="6" y1={H - 6} x2={W - 6} y2={H - 6} stroke="#e2e8f0" strokeWidth="1.8" />
          )}
        </svg>
      </div>
    </div>
  )
}
