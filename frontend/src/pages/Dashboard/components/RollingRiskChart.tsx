interface RollingRiskDay {
  date: string
  due_count: number
  red_count: number
  yellow_count: number
  blue_count: number
}

interface RollingRiskData {
  days: RollingRiskDay[]
  total_due: number
  total_red: number
  total_yellow: number
  total_blue: number
}

interface RollingRiskChartProps {
  data: RollingRiskData | null
  loading: boolean
}

// 画布几何：与原型一致 viewBox 0 0 600 232
const W = 600
const H = 232
const PAD_L = 30
const PAD_R = 14
const TOP = 18
const AXIS_Y = 198
const BAR_W = 20

export default function RollingRiskChart({ data, loading }: RollingRiskChartProps) {
  const days = data?.days ?? []
  const todayStr = new Date().toISOString().slice(0, 10)
  const maxVal = Math.max(10, ...days.map((d) => d.due_count || 0))
  // Y 轴刻度：0..maxVal 分 4 段
  const niceMax = Math.ceil(maxVal / 10) * 10
  const yScale = (v: number) => AXIS_Y - (v / niceMax) * (AXIS_Y - TOP)

  const plotW = W - PAD_L - PAD_R
  const n = Math.max(days.length, 1)
  const step = plotW / n
  const xCenter = (i: number) => PAD_L + step * i + step / 2

  const gridVals = [0, niceMax / 4, niceMax / 2, (niceMax * 3) / 4, niceMax]

  return (
    <div className="card">
      <div className="card-head">
        <h3>14 天滚动风险趋势</h3>
        <span className="hint">按风险等级堆叠 · 在途订单口径</span>
        <div className="legend" style={{ marginLeft: 'auto' }}>
          <span><i style={{ background: 'var(--risk-high)' }} />高</span>
          <span><i style={{ background: 'var(--risk-mid)' }} />中</span>
          <span><i style={{ background: 'var(--info)' }} />低</span>
        </div>
      </div>
      <div className="card-body">
        {loading && !data ? (
          <div className="tbl-empty"><p>加载中…</p></div>
        ) : days.length === 0 ? (
          <div className="tbl-empty"><p>暂无数据</p></div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="chart-svg">
            {/* 网格线 */}
            <g stroke="#f1f5f9" strokeWidth="1">
              {gridVals.slice(1, -1).map((v) => (
                <line key={v} x1={PAD_L} y1={yScale(v)} x2={W - PAD_R} y2={yScale(v)} />
              ))}
            </g>
            <line x1={PAD_L} y1={AXIS_Y} x2={W - PAD_R} y2={AXIS_Y} stroke="#e2e8f0" />
            <g fill="#94a3b8" fontSize="10" textAnchor="end">
              {gridVals.map((v) => (
                <text key={v} x={PAD_L - 6} y={yScale(v) + 3.5}>{Math.round(v)}</text>
              ))}
            </g>

            {/* 堆叠柱：低(蓝,底) / 中(黄) / 高(红,顶) */}
            {days.map((d, i) => {
              const x = xCenter(i) - BAR_W / 2
              const hBlue = ((AXIS_Y - TOP) * d.blue_count) / niceMax
              const hYellow = ((AXIS_Y - TOP) * d.yellow_count) / niceMax
              const hRed = ((AXIS_Y - TOP) * d.red_count) / niceMax
              const yBlue = AXIS_Y - hBlue
              const yYellow = yBlue - hYellow
              const yRed = yYellow - hRed
              const isToday = d.date === todayStr
              return (
                <g key={d.date}>
                  <title>{`${d.date} 到期 ${d.due_count} · 高 ${d.red_count} / 中 ${d.yellow_count} / 低 ${d.blue_count}`}</title>
                  {hBlue > 0 && <rect x={x} y={yBlue} width={BAR_W} height={hBlue} fill="#0284c7" opacity=".75" rx="1.5" />}
                  {hYellow > 0 && <rect x={x} y={yYellow} width={BAR_W} height={hYellow} fill="#d97706" opacity=".8" rx="1.5" />}
                  {hRed > 0 && <rect x={x} y={yRed} width={BAR_W} height={hRed} fill="#dc2626" rx="1.5" />}
                  {d.due_count === 0 && (
                    <rect x={x} y={AXIS_Y - 2} width={BAR_W} height={2} fill="#e2e8f0" rx="1" />
                  )}
                  {isToday && (
                    <>
                      <rect
                        x={x - 2.5} y={Math.min(yRed, TOP) - 2.5}
                        width={BAR_W + 5} height={AXIS_Y - Math.min(yRed, TOP) + 5}
                        fill="none" stroke="#5b5bd6" strokeDasharray="3 2.5" rx="3"
                      />
                      <text x={xCenter(i)} y={Math.min(yRed, TOP) - 7} fill="#5b5bd6" fontSize="10" fontWeight="600" textAnchor="middle">今日</text>
                    </>
                  )}
                </g>
              )
            })}

            {/* X 轴日期 */}
            <g fill="#94a3b8" fontSize="9.5" textAnchor="middle">
              {days.map((d, i) => (
                <text
                  key={d.date}
                  x={xCenter(i)} y={AXIS_Y + 14}
                  fill={d.date === todayStr ? '#334155' : '#94a3b8'}
                  fontWeight={d.date === todayStr ? 600 : 400}
                >
                  {d.date.slice(5)}
                </text>
              ))}
            </g>
          </svg>
        )}
      </div>
    </div>
  )
}
