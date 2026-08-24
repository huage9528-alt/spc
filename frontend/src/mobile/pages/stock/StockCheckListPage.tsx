import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tabs, List, ProgressBar, FloatingBubble, PullToRefresh, ErrorBlock, SpinLoading } from 'antd-mobile'
import { AddOutline } from 'antd-mobile-icons'
import { materialApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import NavBarSimple from '../../components/NavBarSimple'

interface CheckRow {
  id: number
  check_no: string
  order_no?: string | null
  title?: string | null
  check_type?: string | null
  status?: string | null
  check_date?: string | null
  total_materials?: number | null
  checked_materials?: number | null
  created_by?: string | null
}

const STATUS_TABS = [
  { key: 'open,in_progress', title: '进行中' },
  { key: 'completed', title: '已完成' },
  { key: 'cancelled', title: '已取消' },
]
const STATUS_LABEL: Record<string, string> = { open: '待盘点', in_progress: '进行中', completed: '已完成', cancelled: '已取消' }
const STATUS_COLOR: Record<string, string> = { open: '#64748b', in_progress: '#6366f1', completed: '#16a34a', cancelled: '#e11d48' }

export default function StockCheckListPage() {
  const navigate = useNavigate()
  const hasPermission = useAuthStore((s) => s.hasPermission)
  const canCreate = hasPermission('materials.stock_check', 'update')
  const [statusKey, setStatusKey] = useState(STATUS_TABS[0].key)
  const [rows, setRows] = useState<CheckRow[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    setLoading(true)
    try {
      const res: any = await materialApi.getRecentStockChecks({ page: 1, page_size: 50, status: statusKey })
      setRows(res.data?.items || [])
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [statusKey])

  useEffect(() => { load() }, [load])

  return (
    <div className="mobile-page">
      <NavBarSimple title="物料盘点" onBack={() => navigate('/')} />
      <Tabs activeKey={statusKey} onChange={(k) => setStatusKey(k as string)}>
        {STATUS_TABS.map((t) => <Tabs.Tab key={t.key} title={t.title} />)}
      </Tabs>

      <PullToRefresh onRefresh={load}>
        {loading && <div style={{ textAlign: 'center', padding: 40 }}><SpinLoading color="primary" /></div>}
        {failed && <ErrorBlock title="加载失败" description="下拉重试" />}
        {!loading && !failed && rows.length === 0 && <ErrorBlock status="empty" title="暂无盘点单" />}
        <List>
          {rows.map((c) => {
            const total = c.total_materials || 0
            const checked = c.checked_materials || 0
            return (
              <List.Item
                key={c.id}
                description={
                  <div style={{ paddingTop: 4 }}>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {[c.check_date, c.created_by && `创建: ${c.created_by}`].filter(Boolean).join(' · ')}
                    </div>
                    {c.status !== 'cancelled' && total > 0 && (
                      <div style={{ marginTop: 6, maxWidth: 220 }}>
                        <ProgressBar percent={Math.round((checked / total) * 100)} style={{ '--fill-color': '#6366f1', height: 6 } as any} />
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>{checked}/{total}</span>
                      </div>
                    )}
                  </div>
                }
                onClick={() => navigate(`/stock-check/${c.id}`)}
              >
                <span style={{ fontWeight: 600, fontSize: 14 }}>{c.title || c.check_no}</span>
                <span style={{ marginLeft: 8, fontSize: 12, color: STATUS_COLOR[c.status || ''] || '#64748b', background: (STATUS_COLOR[c.status || ''] || '#64748b') + '15', borderRadius: 6, padding: '1px 8px' }}>
                  {STATUS_LABEL[c.status || ''] || c.status}
                </span>
                {c.order_no && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>订单 {c.order_no}</div>}
              </List.Item>
            )
          })}
        </List>
      </PullToRefresh>

      {canCreate && (
        <FloatingBubble
          style={{ '--initial-position-bottom': '24px', '--size': '48px', '--background': '#6366f1', '--edge-distance': '24px' } as any}
          onClick={() => navigate('/stock-check/new')}
        >
          <AddOutline fontSize={22} color="#fff" />
        </FloatingBubble>
      )}
    </div>
  )
}
