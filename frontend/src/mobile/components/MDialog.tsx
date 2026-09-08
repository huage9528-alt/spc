import { useEffect } from 'react'

export interface MDialogAction {
  label: string
  kind?: 'primary' | 'plain' | 'danger-o'
  onClick?: () => void
}

export default function MDialog({
  visible,
  title,
  onClose,
  children,
  actions,
}: {
  visible: boolean
  title: string
  onClose?: () => void
  children?: React.ReactNode
  actions?: MDialogAction[]
}) {
  useEffect(() => {
    if (!visible) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [visible])
  if (!visible) return null
  return (
    <>
      <div className="m-dialog-mask" onClick={() => onClose?.()} />
      <div className="m-dialog">
        <h3>{title}</h3>
        <div className="dbody">{children}</div>
        {actions && actions.length > 0 && (
          <div className="dacts">
            {actions.map((a, i) => (
              <button
                key={i}
                className={`mbtn${a.kind === 'primary' ? ' mbtn--deep' : a.kind === 'danger-o' ? ' mbtn--danger-o' : ' mbtn--plain'}`}
                onClick={() => a.onClick?.()}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
