import { useNavigate } from 'react-router-dom'
import MIcon from './MIcon'

export default function NavBarSimple({
  title,
  onBack,
  right,
}: {
  title: React.ReactNode
  onBack?: () => void
  right?: React.ReactNode
}) {
  const navigate = useNavigate()
  return (
    <header className="en-nav">
      <button className="nav-back" onClick={onBack ?? (() => navigate(-1))}>
        <MIcon name="back" />
      </button>
      <div className="nav-title">{title}</div>
      <div className="nav-right">{right}</div>
    </header>
  )
}
