import { useNavigate } from 'react-router-dom'
import { NavBar } from 'antd-mobile'

export default function NavBarSimple({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  const navigate = useNavigate()
  return (
    <NavBar
      style={{ background: '#fff', borderRadius: 12, marginBottom: 10, '--height': '44px' } as any}
      onBack={onBack ?? (() => navigate(-1))}
      right={right}
    >
      {title}
    </NavBar>
  )
}
