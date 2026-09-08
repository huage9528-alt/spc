import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Dialog, Toast, SpinLoading } from 'antd-mobile'
import { materialApi } from '@/services/api'
import NavBarSimple from '../../components/NavBarSimple'
import MIcon from '../../components/MIcon'

interface CheckHead {
  id: number
  check_no: string
  title?: string | null
  status?: string | null
  check_date?: string | null
  total_materials?: number | null
  checked_materials?: number | null
  total_diff_qty?: number | null
  co_checker_user_ids?: number[] | null
  co_checkers?: Array<{ user_id: number; name: string }> | null
  version?: number | null
  created_by?: string | null
  created_at?: string | null
}

const STATUS_LABEL: Record<string, string> = { open: '进行前', in_progress: '进行中', completed: '已完成', cancelled: '已取消' }
const STATUS_CHIP: Record<string, string> = { open: 'm-chip--open', in_progress: 'm-chip--progress', completed: 'm-chip--done', cancelled: 'm-chip--cancel' }

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
    const diff = head.total_diff_qty != null ? Number(head.total_diff_qty) : null
    Dialog.confirm({
      title: '确认完成盘点？',
      content: `未盘 ${unchecked} 项将按当前快照结束；累计差异 ${diff == null ? 0 : diff > 0 ? `+${diff}` : diff}。完成后单据转为只读。`,
      onConfirm: async () => {
        setBusy(true)
        try {
          await materialApi.completeStockCheck(id, head.version ?? undefined)
          Toast.show({ icon: 'success', content: '盘点已完成' })
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
      title: '确认取消盘点？',
      content: '取消后该盘点单不可恢复，已录数据将保留在快照中。',
      onConfirm: async () => {
        setBusy(true)
        try {
          await materialApi.cancelStockCheck(id, head.version ?? undefined)
          Toast.show({ content: '盘点已取消' })
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
    return (
      <div className="m-page m-page--full" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <SpinLoading color="primary" />
      </div>
    )
  }

  const active = head.status === 'open' || head.status === 'in_progress'
  const diffNum = head.total_diff_qty != null ? Number(head.total_diff_qty) : null

  return (
    <div className="m-page m-page--full">
      <NavBarSimple title="盘点管理" onBack={() => navigate(-1)} />

      <div className="m-page__scroll">
        <div className="m-card">
          <div className="m-card__title" style={{ marginBottom: 6 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {head.title || head.check_no}
            </span>
            <span className={`m-chip ${STATUS_CHIP[head.status || ''] || 'm-chip--cancel'}`} style={{ marginLeft: 8, flex: 'none' }}>
              {STATUS_LABEL[head.status || ''] || head.status}
            </span>
          </div>
          <div className="mg-stat"><span className="l">盘点单号</span><b>{head.check_no}</b></div>
          <div className="mg-stat">
            <span className="l">创建</span>
            <b>{[head.created_by, head.created_at ? new Date(head.created_at).toLocaleString() : null].filter(Boolean).join(' · ')}</b>
          </div>
          <div className="mg-stat">
            <span className="l">已盘 / 总数</span>
            <b>{head.checked_materials ?? 0} / {head.total_materials ?? 0}</b>
          </div>
          <div className="mg-stat">
            <span className="l">差异合计</span>
            <b style={{ color: diffNum == null || diffNum === 0 ? 'var(--spc-text2)' : diffNum > 0 ? '#047857' : '#b91c1c' }}>
              {diffNum == null ? '—' : `${diffNum > 0 ? '+' : ''}${diffNum}`}
            </b>
          </div>
        </div>

        <div className="m-card">
          <div className="m-card__title">协同盘点人</div>
          {candidates.length === 0 && <div className="pool-empty">无可选协同人</div>}
          {candidates.map((c) => {
            const on = selected.includes(c.user_id)
            return (
              <div
                className="cand"
                key={c.user_id}
                onClick={() =>
                  setSelected((prev) => (prev.includes(c.user_id) ? prev.filter((x) => x !== c.user_id) : [...prev, c.user_id]))
                }
              >
                <span className={`cbx${on ? ' on' : ''}`}><MIcon name="check" size={12} /></span>
                <div className="c1">
                  <div className="cc">{c.name}</div>
                </div>
              </div>
            )
          })}
          <button className="mbtn mbtn--primary mbtn--block" style={{ marginTop: 10 }} disabled={busy} onClick={saveCoCheckers}>
            保存协同人
          </button>
        </div>

        {active && (
          <div className="mg-acts">
            <button className="mbtn mbtn--deep mbtn--block" disabled={busy} onClick={complete}>
              <MIcon name="check" size={18} />完成盘点
            </button>
            <button className="mbtn mbtn--danger-o mbtn--block" disabled={busy} onClick={cancel}>
              取消盘点
            </button>
          </div>
        )}
        <div style={{ height: 20 }} />
      </div>
    </div>
  )
}
