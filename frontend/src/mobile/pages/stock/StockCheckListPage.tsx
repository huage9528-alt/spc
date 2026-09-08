import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PullToRefresh, InfiniteScroll } from 'antd-mobile'
import { materialApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import NavBarSimple from '../../components/NavBarSimple'
import SegTabs from '../../components/SegTabs'
import MIcon from '../../components/MIcon'
import { EmptyState, SkeletonCards } from '../../components/Feedback'

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
  { key: 'open,in_progress', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'cancelled', label: '已取消' },
]
const STATUS_LABEL: Record<string, string> = { open: '进行前', in_progress: '进行中', completed: '已完成', cancelled: '已取消' }
const STATUS_CHIP: Record<string, string> = { open: 'm-chip--open', in_progress: 'm-chip--progress', completed: 'm-chip--done', cancelled: 'm-chip--cancel' }
const PAGE_SIZE = 10

export default function StockCheckListPage() {
  const navigate = useNavigate()
  const hasPermission = useAuthStore((s) => s.hasPermission)
  const canCreate = hasPermission('materials.stock_check', 'update')
  const [statusKey, setStatusKey] = useState(STATUS_TABS[0].key)
  const [rows, setRows] = useState<CheckRow[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<string, number | null>>({})
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [keyword, setKeyword] = useState('')

  const loadCounts = useCallback(async () => {
    const entries = await Promise.all(
      STATUS_TABS.map(async (t) => {
        try {
          const res: any = await materialApi.getRecentStockChecks({ page: 1, page_size: 1, status: t.key })
          return [t.key, Number(res.data?.total ?? res.data?.items?.length ?? 0)] as const
        } catch {
          return [t.key, null] as const
        }
      }),
    )
    setCounts(Object.fromEntries(entries))
  }, [])

  const loadFirst = useCallback(async () => {
    setFailed(false)
    setLoading(true)
    try {
      const res: any = await materialApi.getRecentStockChecks({ page: 1, page_size: PAGE_SIZE, status: statusKey })
      setRows(res.data?.items || [])
      setTotal(Number(res.data?.total ?? (res.data?.items || []).length))
      setPage(1)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [statusKey])

  const loadMore = useCallback(async () => {
    const next = page + 1
    try {
      const res: any = await materialApi.getRecentStockChecks({ page: next, page_size: PAGE_SIZE, status: statusKey })
      const items = res.data?.items || []
      setRows((prev) => [...prev, ...items])
      setTotal(Number(res.data?.total ?? 0))
      setPage(next)
    } catch {
      // 静默失败：InfiniteScroll 停留在原地，可再次触发
    }
  }, [page, statusKey])

  useEffect(() => { loadFirst() }, [loadFirst])
  useEffect(() => { loadCounts() }, [loadCounts])

  const refresh = useCallback(async () => {
    await Promise.all([loadFirst(), loadCounts()])
  }, [loadFirst, loadCounts])

  const kw = keyword.trim().toLowerCase()
  const visible = kw
    ? rows.filter((c) => `${c.check_no}${c.order_no || ''}${c.title || ''}`.toLowerCase().includes(kw))
    : rows

  return (
    <div className="m-page m-page--full">
      <NavBarSimple title="物料盘点" onBack={() => navigate('/')} />

      <div className="lk-search">
        <div className="lk-search__box">
          <MIcon name="search" size={17} />
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索单号 / 订单号 / 标题" />
        </div>
      </div>
      <div className="lk-tabs">
        <SegTabs
          items={STATUS_TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] ?? undefined }))}
          active={statusKey}
          onChange={setStatusKey}
        />
      </div>

      <div className="m-page__scroll">
        <PullToRefresh onRefresh={refresh}>
          {loading && rows.length === 0 && <SkeletonCards count={3} />}
          {failed && <EmptyState icon="warn" text="加载失败，下拉重试" />}
          {!loading && !failed && visible.length === 0 && (
            <EmptyState text={kw ? '没有匹配的盘点单' : '该状态下暂无盘点单'} />
          )}
          {visible.map((c) => {
            const totalMats = c.total_materials || 0
            const checked = c.checked_materials || 0
            const percent = totalMats > 0 ? Math.round((checked / totalMats) * 100) : 0
            return (
              <button className="ck-card" key={c.id} onClick={() => navigate(`/stock-check/${c.id}`)}>
                <div className="ck-top">
                  <span className="ck-title">{c.title || c.check_no}</span>
                  <span className={`m-chip ${STATUS_CHIP[c.status || ''] || 'm-chip--cancel'}`}>
                    {STATUS_LABEL[c.status || ''] || c.status}
                  </span>
                </div>
                <div className="ck-no">{c.check_no}</div>
                <div className="ck-meta">
                  <MIcon name="cal" size={12} />
                  <span>{c.check_date || '-'}</span>
                  {c.created_by && <><span style={{ color: '#d1d5db' }}>·</span><span>{c.created_by}</span></>}
                  {c.order_no && <><span style={{ color: '#d1d5db' }}>·</span><span>{c.order_no}</span></>}
                </div>
                {c.status !== 'cancelled' && totalMats > 0 && (
                  <div className="ck-prog">
                    <div className="m-progress">
                      <i className={percent >= 100 ? 'g' : ''} style={{ width: `${percent}%` }} />
                    </div>
                    <b>{checked}/{totalMats}</b>
                  </div>
                )}
              </button>
            )
          })}
          {!kw && !loading && !failed && (
            <InfiniteScroll loadMore={loadMore} hasMore={rows.length < total} />
          )}
          <div style={{ height: 20 }} />
        </PullToRefresh>
      </div>

      {canCreate && (
        <button className="m-fab" onClick={() => navigate('/stock-check/new')}>
          <MIcon name="plus" />
        </button>
      )}
    </div>
  )
}
