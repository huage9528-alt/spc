export default function RingProgress({
  value,
  total,
  size = 76,
}: {
  value: number
  total: number
  size?: number
}) {
  const r = 30
  const C = 2 * Math.PI * r
  const p = total > 0 ? Math.min(1, value / total) : 0
  const color = p >= 1 ? '#10b981' : '#6366f1'
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#eef0f4" strokeWidth="7" fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - p)}
          style={{ transition: 'stroke-dashoffset 0.4s' }}
        />
      </svg>
      <div className="ring__text">
        <b>
          {value}/{total}
        </b>
        <span>已盘</span>
      </div>
    </div>
  )
}

export function AvatarStack({ users }: { users: Array<{ user_id: number; name: string }> }) {
  if (users.length === 0) return null
  return (
    <div className="avs">
      {users.slice(0, 5).map((u, i) => (
        <div className={`av${i > 0 ? ` g${(i % 4) + 1}` : ''}`} key={u.user_id} title={u.name}>
          {(u.name || '?').slice(0, 1)}
          <i className="on-dot" />
        </div>
      ))}
      <span className="online-cnt">
        <i />
        {users.length} 人在线
      </span>
    </div>
  )
}
