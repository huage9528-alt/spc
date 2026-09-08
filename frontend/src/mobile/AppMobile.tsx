import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import MIcon from './components/MIcon'
import MobileLoginPage from './pages/MobileLoginPage'
import WorkbenchPage from './pages/WorkbenchPage'
import MePage from './pages/MePage'
import StockCheckListPage from './pages/stock/StockCheckListPage'
import StockCheckCreatePage from './pages/stock/StockCheckCreatePage'
import StockCheckDetailPage from './pages/stock/StockCheckDetailPage'
import StockCheckEntryPage from './pages/stock/StockCheckEntryPage'
import StockCheckManagePage from './pages/stock/StockCheckManagePage'
import ScanCountPage from './pages/stock/ScanCountPage'

function AuthGuard() {
  const token = useAuthStore((s) => s.currentToken)
  const location = useLocation()
  if (!token) {
    // 保留查询参数（如企微 OAuth 的 ?code=），否则回跳 /m/ 时 code 丢失造成免登死循环
    return <Navigate to={`/login${location.search}`} replace state={{ from: location.pathname }} />
  }
  return <Outlet />
}

const TABS = [
  { key: '/', title: '工作台', icon: 'home' },
  { key: '/me', title: '我的', icon: 'user' },
]

function TabLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const activeKey = '/' + (location.pathname.split('/')[1] || '')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <Outlet />
      </div>
      <nav className="m-tabbar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`m-tabbar__item${activeKey === t.key ? ' active' : ''}`}
            onClick={() => navigate(t.key)}
          >
            <MIcon name={t.icon} size={22} />
            {t.title}
          </button>
        ))}
      </nav>
    </div>
  )
}

export default function AppMobile() {
  return (
    <BrowserRouter basename="/m">
      <Routes>
        <Route path="/login" element={<MobileLoginPage />} />
        <Route element={<AuthGuard />}>
          <Route element={<TabLayout />}>
            <Route path="/" element={<WorkbenchPage />} />
            <Route path="/me" element={<MePage />} />
          </Route>
          <Route path="/stock-check" element={<StockCheckListPage />} />
          <Route path="/stock-check/new" element={<StockCheckCreatePage />} />
          <Route path="/stock-check/:checkId" element={<StockCheckDetailPage />} />
          <Route path="/stock-check/:checkId/items/:itemId" element={<StockCheckEntryPage />} />
          <Route path="/stock-check/:checkId/manage" element={<StockCheckManagePage />} />
          <Route path="/scan-count" element={<ScanCountPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
