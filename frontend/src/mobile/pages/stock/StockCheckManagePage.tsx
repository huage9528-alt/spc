import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Button, Dialog, List, Checkbox, Toast, Tag, SpinLoading } from 'antd-mobile'
import { materialApi } from '@/services/api'
import NavBarSimple from '../../components/NavBarSimple'

interface CheckHead {
  id: number
  check_no: string
  title?: string | null
  status?: string | null
  total_materials?: number | null
  checked_materials?: number | null
  total_diff_qty?: number | null
  co_checker_user_ids?: number[] | null
  co_checkers?: Array<{ user_id: number; name: string }> | null
  version?: number | null
  created_by?: string | null
  created_at?: string | null
}

export default function StockCheckManagePage() {
  const { checkId } = useParams()
  const navigate = useNavigate()
  const id = Number(checkId)
  const [head, setHead] = useState<CheckHead | null>(null)
  const [candidates, setCandidates] = useState<Array<{ user_id: number; name: string }>>([])
  const [selected, setSelected] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [h, c]: any[] = await Promise.all([
        materialApi.getStockCheck(id),
        materialApi.getCoCheckerCandidates(),
      ])
      setHead(h.data)
      setSelected(h.data?.co_checker_user_ids || [])
      setCandidates(c.data || [])
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  async function saveCoCheckers() {
    if (!head) return
    setBusy(true)
    try {
      await materialApi.updateStockCheckCoCheckers(id, selected, head.version ?? undefined)
      Toast.show({ icon: 'success', content: '协同人已更新' })
      load()
    } catch (e: any) {
      Toast.show(e?.response?.data?.detail || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function complete() {
    if (!head) return
    const unchecked = (head.total_materials ?? 0) - (head.checked_materials ?? 0)
    const diff = head.total_diff_qty
    Dialog.confirm({
      title: '完成盘点',
      content: `未盘 ${unchecked} 项将按当前快照结束；累计差异数 ${diff ?? 0}。确认完成？`,
      onConfirm: async () => {
        setBusy(true)
        try {
          await materialApi.completeStockCheck(id, head.version ?? undefined)
          Toast.show({ icon: 'success', content: '已完成' })
          navigate(`/stock-check/${id}`, { replace: true })
        } catch (e: any) {
          Toast.show(e?.response?.data?.detail || '操作失败')
        } finally {
          setBusy(false)
        }
      },
    })
  }

  async function cancel() {
    if (!head) return
    Dialog.confirm({
      title: '取消盘点',
      content: '取消后不可恢复，确认取消该盘点单？',
      onConfirm: async () => {
        setBusy(true)
        try {
          await materialApi.cancelStockCheck(id, head.version ?? undefined)
          Toast.show({ content: '已取消' })
          navigate(`/stock-check/${id}`, { replace: true })
        } catch (e: any) {
          Toast.show(e?.response?.data?.detail || '操作失败')
        } finally {
          setBusy(false)
        }
      },
    })
  }

  if (loading || !head) {
    return <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><SpinLoading color="primary" /></div>
  }

  const active = head.status === 'open' || head.status === 'in_progress'

  return (
    <div className="mobile-page">
      <NavBarSimple title="盘点管理" onBack={() => navigate(-1)} />

      <div className="mobile-card">
        <div style={{ fontWeight: 600, fontSize: 15 }}>{head.title || head.check_no}</div>
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
          {head.created_by} · {head.created_at ? new Date(head.created_at).toLocaleString() : ''}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8, fontSize: 12 }}>
          <Tag color="primary" fill="outline">{head.status}</Tag>
          <span style={{ color: '#64748b' }}>已盘 {head.checked_materials ?? 0}/{head.total_materials ?? 0}</span>
          <span style={{ color: '#64748b' }}>差异 {head.total_diff_qty ?? 0}</span>
        </div>
      </div>

      {active && (
        <div className="mobile-card" style={{ padding: 0 }}>
          <List header="协同盘点人">
            {candidates.map((c) => (
              <List.Item
                key={c.user_id}
                clickable
                extra={<Checkbox checked={selected.includes(c.user_id)} onChange={(v) => {
                  setSelected((prev) => (v ? [...prev, c.user_id] : prev.filter((x) => x !== c.user_id)))
                }} />}
                onClick={() => setSelected((prev) => (prev.includes(c.user_id) ? prev.filter((x) => x !== c.user_id) : [...prev, c.user_id]))}
              >
                {c.name}
              </List.Item>
            ))}
            {candidates.length === 0 && <List.Item>无可选协同人</List.Item>}
          </List>
          <div style={{ padding: 12 }}>
            <Button block color="primary" fill="outline" loading={busy} onClick={saveCoCheckers}>保存协同人</Button>
          </div>
        </div>
      )}

      {active && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <Button block color="primary" size="large" loading={busy} style={{ '--border-radius': '10px' } as any} onClick={complete}>完成盘点</Button>
          <Button block color="danger" fill="outline" size="large" loading={busy} style={{ '--border-radius': '10px' } as any} onClick={cancel}>取消盘点</Button>
        </div>
      )}
    </div>
  )
}
