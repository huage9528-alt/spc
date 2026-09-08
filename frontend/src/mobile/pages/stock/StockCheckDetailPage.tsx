import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { PullToRefresh, SpinLoading, ActionSheet, Toast } from 'antd-mobile'
import { materialApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { useStockCheckSync } from '@/hooks/useStockCheckSync'
import NavBarSimple from '../../components/NavBarSimple'
import SegTabs from '../../components/SegTabs'
import MIcon from '../../components/MIcon'
import { EmptyState, SkeletonCards } from '../../components/Feedback'
import RingProgress, { AvatarStack } from '../../components/RingProgress'

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
  checked_by?: string | null
}

interface CheckHead {
  id: number
  check_no: string
  order_no?: string | null
  title?: string | null
  status?: string | null
  check_date?: string | null
  created_by?: string | null
  total_materials?: number | null
  checked_materials?: number | null
  total_diff_qty?: number | null
  co_checkers?: Array<{ user_id: number; name: string }> | null
  can_edit?: boolean | null
  version?: number | null
  items?: CheckItem[] | null
}

const STATUS_LABEL: Record<string, string> = { open: '进行前', in_progress: '进行中', completed: '已完成', cancelled: '已取消' }
const STATUS_CHIP: Record<string, string> = { open: 'm-chip--open', in_progress: 'm-chip--progress', completed: 'm-chip--done', cancelled: 'm-chip--cancel' }

function fmtQty(v: number | null | undefined): string {
  if (v == null) return '-'
  const n = Number(v)
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

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
  const [sseTip, setSseTip] = useState('')
  const sseTipTimer = useRef<number | null>(null)

  const showTip = useCallback((text: string) => {
    setSseTip(text)
    if (sseTipTimer.current) window.clearTimeout(sseTipTimer.current)
    sseTipTimer.current = window.setTimeout(() => setSseTip(''), 6000)
  }, [])

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
      if (p?.head_aggregates) {
        const agg = p.head_aggregates
        setHead((h) => (h ? { ...h, checked_materials: agg.checked_materials ?? h.checked_materials, total_materials: agg.total_materials ?? h.total_materials, total_diff_qty: agg.total_diff_qty ?? h.total_diff_qty } : h))
      }
      const who = p?.item?.counted_by || '协同人'
      const mat = p?.item?.material_code || p?.item?.material_name || '物料'
      showTip(`SSE 更新：${who} 盘点了「${mat}」`)
    },
    // PC 端「批量保存」只发一个 items_batch_updated 事件（替代 N 个 item_updated），
    // 不处理该事件时移动端表现为：同事批量保存后数据不刷新、无任何提示
    onItemsBatchUpdated: (p: any) => {
      const updated = Array.isArray(p?.items) ? p.items : []
      if (updated.length > 0) {
        setItems((prev) => {
          const byId = new Map<number, any>(updated.map((u: any) => [u.item_id, u.item]))
          return prev.map((it) => (byId.has(it.id) ? { ...it, ...byId.get(it.id)! } : it))
        })
      }
      if (p?.head_aggregates) {
        const agg = p.head_aggregates
        setHead((h) => (h ? { ...h, checked_materials: agg.checked_materials ?? h.checked_materials, total_materials: agg.total_materials ?? h.total_materials, total_diff_qty: agg.total_diff_qty ?? h.total_diff_qty } : h))
      }
      if (updated.length > 0) {
        // 显示「谁 + 哪些物料」：取各行的 counted_by 与物料编码，多行时截断
        const whoSet = [...new Set(updated.map((u: any) => u?.item?.counted_by).filter(Boolean))] as string[]
        const who = whoSet.length > 0 ? whoSet.join('、') : '协同人'
        const mats = updated.map((u: any) => u?.item?.material_code || u?.item?.material_name || '?')
        const SHOWN = 3
        const matText = mats.slice(0, SHOWN).join('、') + (mats.length > SHOWN ? ` 等 ${mats.length} 项` : '')
        showTip(`SSE 更新：${who} 批量盘点了 ${matText}`)
      }
    },
    onStatusChanged: (p: any) => {
      setHead((h) => (h ? { ...h, status: p?.status ?? h.status } : h))
      Toast.show(`单据状态已更新：${STATUS_LABEL[p?.status] || p?.status || ''}`)
    },
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

  const pending = useMemo(() => items.filter((i) => !i.is_checked && i.actual_qty == null), [items])
  const checked = useMemo(() => items.filter((i) => i.is_checked === 1 || i.actual_qty != null), [items])
  const diff = useMemo(() => items.filter((i) => i.diff_qty != null && Number(i.diff_qty) !== 0), [items])
  const filtered = filter === 'pending' ? pending : filter === 'checked' ? checked : diff

  const myUserId = useAuthStore.getState().currentUser?.id ?? 0
  const readonly = !head?.can_edit || head?.status === 'completed' || head?.status === 'cancelled'
  const others = presenceUsers.filter((u) => u.user_id !== myUserId)

  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="m-page m-page--full">
      <NavBarSimple
        title={head?.title || head?.check_no || '盘点单'}
        onBack={() => navigate('/stock-check')}
        right={
          <button className="nav-back" style={{ width: 34 }} onClick={() => setMenuOpen(true)}>
            <MIcon name="more" />
          </button>
        }
      />
      <ActionSheet
        visible={menuOpen}
        actions={[{ text: '盘点管理', key: 'manage' }]}
        onClose={() => setMenuOpen(false)}
        cancelText="取消"
        onAction={(action) => {
          setMenuOpen(false)
          if (action.key === 'manage') navigate(`/stock-check/${id}/manage`)
          if (action.key === 'refresh') { void load(); Toast.show('已刷新') }
        }}
        extra={
          <div style={{ padding: '8px 12px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="mbtn mbtn--plain"
              onClick={() => { setMenuOpen(false); void load(); Toast.show('已刷新协同状态') }}
            >
              刷新协同状态
            </button>
          </div>
        }
      />

      {loading && <SkeletonCards count={2} />}
      {failed && <EmptyState icon="warn" text="加载失败，下拉重试" />}

      {head && !loading && (
        <>
          <div className="m-page__scroll">
            <PullToRefresh onRefresh={load}>
              {sseTip && (
                <div className="sse-tip">
                  <MIcon name="users" size={15} />
                  {sseTip}
                </div>
              )}

              <div className="m-card">
                <div className="dt-sum">
                  <RingProgress value={head.checked_materials ?? 0} total={head.total_materials ?? 0} />
                  <div className="dt-info">
                    <div className="dt-t">
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {head.title || head.check_no}
                      </span>
                      <span className={`m-chip ${STATUS_CHIP[head.status || ''] || 'm-chip--cancel'}`}>
                        {STATUS_LABEL[head.status || ''] || head.status}
                      </span>
                    </div>
                    <div className="dt-o">
                      {head.check_no}
                      {head.order_no ? ` · 订单 ${head.order_no}` : ''}
                      {head.created_by ? ` · ${head.created_by} 创建` : ''}
                    </div>
                    {others.length > 0 ? (
                      <AvatarStack users={others} />
                    ) : (
                      (head.co_checkers?.length ?? 0) > 0 && (
                        <div className="dt-o" style={{ marginTop: 6 }}>
                          协同人：{head.co_checkers!.map((c) => c.name).join('、')}
                        </div>
                      )
                    )}
                  </div>
                </div>
              </div>

              <div className="lk-tabs">
                <SegTabs
                  items={[
                    { key: 'pending', label: '未盘', count: pending.length },
                    { key: 'checked', label: '已盘', count: checked.length },
                    { key: 'diff', label: '差异', count: diff.length, red: true },
                  ]}
                  active={filter}
                  onChange={(k) => setFilter(k as typeof filter)}
                />
              </div>

              {filtered.length === 0 ? (
                <EmptyState icon="check" text={filter === 'diff' ? '暂无差异项' : filter === 'pending' ? '全部物料已盘完' : '暂无数据'} />
              ) : (
                <div className="m-card" style={{ padding: '4px 14px' }}>
                  {filtered.map((i) => {
                    const d = i.diff_qty != null ? Number(i.diff_qty) : null
                    return (
                      <div
                        className="mat"
                        key={i.id}
                        onClick={readonly ? undefined : () => navigate(`/stock-check/${id}/items/${i.id}`)}
                        style={readonly ? { cursor: 'default' } : undefined}
                      >
                        <div className="m1">
                          <div className="mc">
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {i.material_name || i.material_code}
                            </span>
                            <span className="code">{i.material_code}</span>
                          </div>
                          <div className="ms">{[i.spec_model, i.wh_name, i.unit].filter(Boolean).join(' · ')}</div>
                        </div>
                        <div className="mq">
                          {i.actual_qty != null ? (
                            <>
                              <div className="a">{fmtQty(i.actual_qty)}</div>
                              <div className="s">系统 {fmtQty(i.system_qty)}</div>
                              <div style={{ marginTop: 3 }}>
                                {d == null || d === 0 ? (
                                  <span className="m-chip m-chip--zero">±0</span>
                                ) : (
                                  <span className={`m-chip ${d > 0 ? 'm-chip--pos' : 'm-chip--neg'}`}>
                                    {d > 0 ? '+' : ''}{fmtQty(d)}
                                  </span>
                                )}
                              </div>
                            </>
                          ) : (
                            <span className="m-chip m-chip--open" style={{ marginTop: 4 }}>待盘</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <div style={{ height: 20 }} />
            </PullToRefresh>
          </div>

          {!readonly && (
            <div className="dt-footer">
              {pending.length > 0 ? (
                <button className="mbtn mbtn--deep mbtn--block" onClick={() => navigate(`/stock-check/${id}/items/${pending[0].id}`)}>
                  开始盘点（未盘 {pending.length}）
                </button>
              ) : (
                items.length > 0 && (
                  <button className="mbtn mbtn--primary mbtn--block" onClick={() => navigate(`/stock-check/${id}/items/${items[0].id}`)}>
                    从首项查看盘点
                  </button>
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
