export interface SegTabItem {
  key: string
  label: string
  count?: number
  red?: boolean
}

export default function SegTabs({
  items,
  active,
  onChange,
  style,
}: {
  items: SegTabItem[]
  active: string
  onChange: (key: string) => void
  style?: React.CSSProperties
}) {
  return (
    <div className="m-seg" style={style}>
      {items.map((t) => (
        <button
          key={t.key}
          className={`m-seg__item${active === t.key ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count != null && <span className={`m-seg__cnt${t.red ? ' m-seg__cnt--red' : ''}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  )
}
