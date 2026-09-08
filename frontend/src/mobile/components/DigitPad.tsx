import MIcon from './MIcon'

export default function DigitPad({
  value,
  onChange,
  onSubmit,
  onSubmitNext,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onSubmitNext?: () => void
  disabled?: boolean
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back']
  function press(k: string) {
    if (k === 'back') {
      onChange(value.slice(0, -1))
      return
    }
    if (k === '.') {
      if (!value.includes('.')) onChange((value || '0') + '.')
      return
    }
    if (value === '0') {
      onChange(k)
      return
    }
    if (value.length < 10) onChange(value + k)
  }
  return (
    <div className="dpad">
      <div className="dpad-ops">
        <button className="mbtn mbtn--plain" disabled={disabled} onClick={() => onChange('')}>
          清空
        </button>
        <button className="mbtn mbtn--primary" disabled={disabled} onClick={onSubmit}>
          保存
        </button>
        {onSubmitNext && (
          <button className="mbtn mbtn--deep" disabled={disabled} onClick={onSubmitNext}>
            保存并下一个
          </button>
        )}
      </div>
      <div className="dpad-keys">
        {keys.map((k) => (
          <button
            key={k}
            className={`dkey${k === 'back' ? ' op' : ''}`}
            disabled={disabled}
            onClick={() => press(k)}
          >
            {k === 'back' ? <MIcon name="backspace" size={22} /> : k}
          </button>
        ))}
      </div>
    </div>
  )
}
