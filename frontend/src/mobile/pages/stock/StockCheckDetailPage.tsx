import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Tabs, List, Tag, Button, PullToRefresh, ErrorBlock, SpinLoading } from 'antd-mobile'
import { materialApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { useStockCheckSync } from '@/hooks/useStockCheckSync'
import NavBarSimple from '../../components/NavBarSimple'

interface CheckItem {
  id: number
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  wh_name?: string | null
  system_qty?: number | null
  actual_qty?: number | null
  diff_qty?: number | null
  is_checked?: number | null
  remark?: string | null
  version?: number | null
}

interface CheckHead {
  id: number
  check_no: string
  order_no?: string | null
  title?: string | null
  status?: string | null
  check_date?: string | null
  total_materials?: number | null
  checked_materials?: number | null
  co_checkers?: Array<{ user_id: number; name: string }> | null
  can_edit?: boolean | null
  version?: number | null
  items?: CheckItem[] | null
}

const STATUS_LABEL: Record<string, string> = { open: '待盘点', in_progress: '进行中', completed: '已完成', cancelled: '已取消' }

export default function StockCheckDetailPage() {
  const { checkId } = useParams()
  const navigate = useNavigate()
  const id = Number(checkId)
  const [head, setHead] = useState<CheckHead | null>(null)
  const [items, setItems] = useState<CheckItem[]>([])
  const [filter, setFilter] = useState<'pending' | 'checked' | 'diff'>('pending')
  const [presenceUsers, setPresenceUsers] = useState<Array<{ user_id: number; name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const res: any = await materialApi.getStockCheck(id)
      setHead(res.data)
      setItems(res.data?.items || [])
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  useStockCheckSync({
    checkId: head && head.status !== 'completed' && head.status !== 'cancelled' ? id : null,
    onSnapshot: (p: any) => {
      if (Array.isArray(p?.items)) setItems(p.items)
      if (Array.isArray(p?.presence)) {
        setPresenceUsers(p.presence.map((pr: any) => ({ user_id: pr.user_id, name: pr.name || `用户${pr.user_id}` })))
      }
    },
    onItemUpdated: (p: any) => {
      setItems((prev) => prev.map((it) => (it.id === p?.item?.id ? { ...it, ...p.item } : it)))
    },
    onStatusChanged: (p: any) => setHead((h) => (h ? { ...h, status: p?.status ?? h.status } : h)),
    onCoCheckersChanged: () => load(),
    onBomRefreshed: () => load(),
    onWarehousesRefreshed: () => load(),
    onPresence: (p: { user_id: number; name: string | null; item_id: number | null }) => {
      setPresenceUsers((prev) => {
        const rest = prev.filter((u) => u.user_id !== p.user_id)
        // item_id == null 表示对方离开/结束编辑，从在线列表移除
        return p.item_id == null ? rest : [...rest, { user_id: p.user_id, name: p.name || `用户${p.user_id}` }]
      })
    },
  })

  const filtered = useMemo(() => {
    if (filter === 'pending') return items.filter((i) => !i.is_checked && i.actual_qty == null)
    if (filter === 'checked') return items.filter((i) => i.is_checked === 1 || i.actual_qty != null)
    return items.filter((i) => i.diff_qty != null && Number(i.diff_qty) !== 0)
  }, [items, filter])

  const myUserId = useAuthStore.getState().currentUser?.id ?? 0
  const readonly = !head?.can_edit || head?.status === 'completed' || head?.status === 'cancelled'

  return (
    <div className="mobile-page">
      <NavBarSimple
        title={head?.title || head?.check_no || '盘点单'}
        onBack={() => navigate('/stock-check')}
        right={
          head && !readonly ? (
            <span style={{ color: '#6366f1', fontSize: 13 }} onClick={() => navigate(`/stock-check/${id}/manage`)}>管理</span>
          ) : undefined
        }
      />

      {loading && <div style={{ textAlign: 'center', padding: 40 }}><SpinLoading color="primary" /></div>}
      {failed && <ErrorBlock title="加载失败" description="下拉重试" />}

      {head && (
        <PullToRefresh onRefresh={load}>
          <div className="mobile-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <Tag color="primary" fill="outline">{STATUS_LABEL[head.status || ''] || head.status}</Tag>
              {head.order_no && <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 8 }}>订单 {head.order_no}</span>}
            </div>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              已盘 {head.checked_materials ?? 0}/{head.total_materials ?? 0}
              {presenceUsers.filter((u) => u.user_id !== myUserId).length > 0 && (
                <span style={{ marginLeft: 10, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {presenceUsers.filter((u) => u.user_id !== myUserId).slice(0, 5).map((u) => (
                    <span key={u.user_id} title={u.name} style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                  ))}
                  在线协作
                </span>
              )}
            </div>
          </div>

          <Tabs activeKey={filter} onChange={(k) => setFilter(k as typeof filter)}>
            <Tabs.Tab title={`未盘 ${items.filter((i) => !i.is_checked && i.actual_qty == null).length}`} key="pending" />
            <Tabs.Tab title={`已盘 ${items.filter((i) => i.is_checked === 1 || i.actual_qty != null).length}`} key="checked" />
            <Tabs.Tab title={`差异 ${items.filter((i) => i.diff_qty != null && Number(i.diff_qty) !== 0).length}`} key="diff" />
          </Tabs>

          <List>
            {filtered.map((i) => (
              <List.Item
                key={i.id}
                clickable={!readonly}
                onClick={readonly ? undefined : () => navigate(`/stock-check/${id}/items/${i.id}`)}
                description={<div style={{ fontSize: 12, color: '#64748b' }}>{[i.spec_model, i.wh_name, i.unit].filter(Boolean).join(' · ')}</div>}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{i.material_code} {i.material_name}</div>
                <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 12, color: '#64748b' }}>
                  <span>系统 {i.system_qty ?? '-'}</span>
                  <span style={{ color: i.actual_qty != null ? '#1e293b' : '#94a3b8' }}>实盘 {i.actual_qty ?? '未盘'}</span>
                  {i.diff_qty != null && Number(i.diff_qty) !== 0 && (
                    <span style={{ color: Number(i.diff_qty) > 0 ? '#16a34a' : '#e11d48' }}>差 {Number(i.diff_qty) > 0 ? '+' : ''}{Number(i.diff_qty)}</span>
                  )}
                </div>
              </List.Item>
            ))}
            {filtered.length === 0 && !loading && <List.Item>暂无物料</List.Item>}
          </List>

          {!readonly && filtered.length > 0 && (
            <Button block color="primary" fill="outline" size="large" style={{ marginTop: 12 }}
              onClick={() => {
                const first = filtered[0]
                if (first) navigate(`/stock-check/${id}/items/${first.id}`)
              }}>
              开始盘点
            </Button>
          )}
        </PullToRefresh>
      )}
    </div>
  )
}
