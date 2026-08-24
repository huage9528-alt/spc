import { Button } from 'antd-mobile'

export default function DigitPad({ value, onChange, onSubmit, disabled }: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled?: boolean
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']
  function press(k: string) {
    if (k === '⌫') { onChange(value.slice(0, -1)); return }
    if (k === '.' && value.includes('.')) return
    if (value.replace('.', '').length >= 9) return
    onChange(value + k)
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
      {keys.map((k) => (
        <Button key={k} size="large" disabled={disabled} onClick={() => press(k)}
          style={{ height: 52, fontSize: 20, fontWeight: 600, '--border-radius': '10px' } as any}>
          {k}
        </Button>
      ))}
      <div style={{ gridColumn: '1 / span 2' }}>
        <Button block size="large" color="default" disabled={disabled} onClick={() => onChange('')}
          style={{ height: 52, '--border-radius': '10px' } as any}>清空</Button>
      </div>
      <div>
        <Button block size="large" color="primary" disabled={disabled} onClick={onSubmit}
          style={{ height: 52, fontWeight: 700, '--border-radius': '10px' } as any}>保存</Button>
      </div>
    </div>
  )
}
