export interface ChipOption {
  label: string
  value: string | number
  count?: number
  hot?: boolean
}

interface ChipsFilterProps {
  options: ChipOption[]
  value: string | number
  onChange: (v: string | number) => void
}

export default function ChipsFilter({ options, value, onChange }: ChipsFilterProps) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map((opt) => (
        <span
          key={String(opt.value)}
          className={`sc-chip${opt.value === value ? ' on' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
          {opt.count !== undefined && (
            <span className="n" style={opt.hot ? { color: '#dc2626', opacity: 1 } : undefined}>
              {opt.count.toLocaleString()}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}
