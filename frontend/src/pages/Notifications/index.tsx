import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Empty, Pagination, Spin, message } from 'antd'
import {
  SoundOutlined, SettingOutlined, AppstoreOutlined, WarningOutlined,
  MessageOutlined, AuditOutlined, BellOutlined, CheckOutlined, ReloadOutlined,
  RightOutlined, CheckCircleFilled, TransactionOutlined, MoreOutlined, ClockCircleOutlined,
} from '@ant-design/icons'
import { notificationApi } from '../../services/api'
import { useAuthStore } from '../../store/auth'
import './index.css'

interface NotifItem {
  id: number
  type: string
  title: string
  content?: string | null
  ref_type?: string | null
  ref_id?: number | null
  sender_id?: number | null
  sender_name?: string | null
  priority: string
  is_read: boolean
  created_at: string
}

// 全量消息类型（据库内真实数据 + 后端创建点整理，2026-09-21）
const TYPE_DEFS = [
  { key: 'announcement', label: '公告', icon: SoundOutlined, color: '#4c4dc2', bg: '#eef0fe' },
  { key: 'price_change', label: '调价单', icon: TransactionOutlined, color: '#0e7490', bg: '#ecfeff' },
  { key: 'stock_check_audit', label: '盘点抽检', icon: AuditOutlined, color: '#16a34a', bg: '#f0fdf4' },
  { key: 'stock_check_appeal', label: '复议待裁决', icon: AuditOutlined, color: '#1d4ed8', bg: '#dbeafe' },
  { key: 'approval_timeout', label: '审批超时', icon: ClockCircleOutlined, color: '#dc2626', bg: '#fef2f2' },
  { key: 'material_alert', label: '物料提醒', icon: AppstoreOutlined, color: '#d97706', bg: '#fffbeb' },
  { key: 'exception_alert', label: '异常提醒', icon: WarningOutlined, color: '#dc2626', bg: '#fef2f2' },
  { key: 'feedback', label: '问题反馈', icon: MessageOutlined, color: '#8b5cf6', bg: '#f5f3ff' },
  { key: 'feedback_alert', label: '反馈提醒', icon: MessageOutlined, color: '#8b5cf6', bg: '#f5f3ff' },
  { key: 'system', label: '系统', icon: SettingOutlined, color: '#0284c7', bg: '#f0f9ff' },
]

const KNOWN_TYPES = TYPE_DEFS.map(t => t.key)

const typeDef = (type: string) => TYPE_DEFS.find(t => t.key === type)

// 后端返回 "YYYY-MM-DD HH:mm" → 今天/昨天用相对表述，其余本月/跨年缩写（对齐原型）
function fmtTime(s: string) {
  const d = new Date(s.replace(' ', 'T'))
  if (isNaN(d.getTime())) return s
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const now = new Date()
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return `今天 ${hm}`
  if (sameDay(d, yesterday)) return `昨天 ${hm}`
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`
}

// 数据里出现枚举外的新类型时，追加到分类导航（label 用原始 type）
const extraTypeDef = (type: string) => ({ key: type, label: type, icon: BellOutlined, color: '#64748b', bg: '#f1f5f9' })

const PRIORITY_DEFS: Record<string, { label: string; color: string; bg: string }> = {
  urgent: { label: '紧急', color: '#dc2626', bg: '#fef2f2' },
  high: { label: '重要', color: '#d97706', bg: '#fffbeb' },
  important: { label: '重要', color: '#d97706', bg: '#fffbeb' },
  normal: { label: '普通', color: '#64748b', bg: '#f1f5f9' },
}

function jumpTarget(n: NotifItem): { label: string; path: string } | null {
  if (n.type === 'stock_check_appeal' && n.ref_id) return { label: '复议待裁决', path: '/stock-check-audit?tab=appeal' }
  // 审批超时提醒的 ref_type 就是业务标识（如 supplier_claim），必须先于 ref_type 分支判断，否则会被索赔单详情分支抢走
  if (n.type === 'approval_timeout') return { label: '待办工作台', path: '/approvals/pending' }
  if (n.ref_type === 'stock_check' && n.ref_id) return { label: `盘点单 #${n.ref_id}`, path: `/stock-check/${n.ref_id}` }
  if (n.ref_type === 'price_change' && n.ref_id) return { label: `调价单 #${n.ref_id}`, path: `/purchase/price-change/${n.ref_id}` }
  if (n.ref_type === 'supplier_claim' && n.ref_id) return { label: `索赔单 #${n.ref_id}`, path: `/quality/supplier-claims/${n.ref_id}` }
  if ((n.type === 'feedback' || n.type === 'feedback_alert') && n.ref_id) return { label: `反馈单 #${n.ref_id}`, path: `/basicdata/feedback?id=${n.ref_id}` }
  if (n.ref_type === 'purchase_order') return { label: '采购到料计划', path: '/purchase-plan' }
  if (n.type === 'exception_alert') return { label: '异常总池', path: '/issues' }
  return null
}

const NmTag = ({ color, bg, dot, children }: { color: string; bg: string; dot?: boolean; children: React.ReactNode }) => (
  <span className="nm-tag" style={{ color, background: bg }}>{dot && <i className="dot" />}{children}</span>
)

export default function Notifications() {
  const navigate = useNavigate()
  const originalToken = useAuthStore((s: any) => s.originalToken)

  const [filter, setFilter] = useState<string>('all') // all | unread | <type>
  const [items, setItems] = useState<NotifItem[]>([])
  const [total, setTotal] = useState(0)
  const [allTotal, setAllTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [unreadTotal, setUnreadTotal] = useState(0)
  const [unreadByType, setUnreadByType] = useState<Record<string, number>>({})
  const [sseOn, setSseOn] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const fetchCounts = useCallback(async () => {
    try {
      const [cntRes, allRes]: any[] = await Promise.all([
        notificationApi.unreadCount(),
        notificationApi.list({ page: 1, page_size: 1 }),
      ])
      setUnreadTotal(cntRes.data?.total || 0)
      setUnreadByType(cntRes.data?.by_type || {})
      setAllTotal(allRes.data?.total || 0)
    } catch { /* silent */ }
  }, [])

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = { page, page_size: 20 }
      if (filter === 'unread') params.is_read = false
      else if (filter === 'other') params.exclude_types = KNOWN_TYPES.join(',')
      else if (filter !== 'all') params.type = filter
      const res: any = await notificationApi.list(params)
      setItems(res.data?.items || [])
      setTotal(res.data?.total || 0)
    } catch { /* handled by interceptor */ }
    setLoading(false)
  }, [filter, page])

  useEffect(() => { fetchCounts() }, [fetchCounts])
  useEffect(() => { fetchList() }, [fetchList])

  const fetchListRef = useRef(fetchList)
  fetchListRef.current = fetchList
  const fetchCountsRef = useRef(fetchCounts)
  fetchCountsRef.current = fetchCounts
  // SSE 实时：未读数与列表静默刷新（创建/已读都会触发 unread 事件）；断开后 30s 重连（对齐 MainLayout）
  useEffect(() => {
    if (!originalToken) return
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let closed = false
    const connect = () => {
      if (closed) return
      try {
        es = new EventSource(`/api/v1/notifications/stream?token=${encodeURIComponent(originalToken)}`)
      } catch { return }
      es.addEventListener('open', () => setSseOn(true))
      es.addEventListener('unread', () => { fetchCountsRef.current(); fetchListRef.current() })
      es.addEventListener('error', () => {
        setSseOn(false)
        try { es?.close() } catch { /* silent */ }
        es = null
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = setTimeout(connect, 30000)
      })
    }
    connect()
    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      setSseOn(false)
      try { es?.close() } catch { /* silent */ }
    }
  }, [originalToken])

  const changeFilter = (key: string) => {
    setFilter(key)
    setPage(1)
    setSelectedId(null)
    listRef.current?.scrollTo({ top: 0 })
  }

  const openDetail = async (n: NotifItem) => {
    setSelectedId(n.id)
    if (!n.is_read) {
      try {
        await notificationApi.markRead(n.id)
        setItems(prev => prev.map(x => x.id === n.id ? { ...x, is_read: true } : x))
        setUnreadByType(prev => ({ ...prev, [n.type]: Math.max(0, (prev[n.type] || 0) - 1) }))
        setUnreadTotal(v => Math.max(0, v - 1))
      } catch { /* silent */ }
    }
  }

  const handleMarkAllRead = async () => {
    try {
      await notificationApi.markAllRead()
      message.success('已全部标记为已读')
      setItems(prev => prev.map(x => ({ ...x, is_read: true })))
      setUnreadByType({})
      setUnreadTotal(0)
    } catch { /* handled by interceptor */ }
  }

  const selected = useMemo(() => items.find(n => n.id === selectedId) || null, [items, selectedId])

  // 「其他消息」未读数 = 总未读 − 已知类型未读之和
  const otherUnread = useMemo(() => {
    const known = new Set(KNOWN_TYPES)
    return Object.entries(unreadByType).filter(([k]) => !known.has(k)).reduce((s, [, v]) => s + (v || 0), 0)
  }, [unreadByType])

  const navItem = (key: string, icon: React.ReactNode, label: string, count?: number, hotCount?: number) => (
    <div
      key={key}
      onClick={() => changeFilter(key)}
      className={`nm-nav-item ${filter === key ? 'active' : ''}`}
    >
      <span className="nm-ni-icon">{icon}</span>
      <span>{label}</span>
      {hotCount !== undefined && hotCount > 0 && <span className="cnt hot">{hotCount}</span>}
      {hotCount !== undefined && hotCount === 0 && <span className="cnt" style={{ color: '#cbd5e1' }}>—</span>}
      {hotCount === undefined && count !== undefined && count > 0 && <span className="cnt mid">{count}</span>}
    </div>
  )

  const jump = selected ? jumpTarget(selected) : null
  const selectedType = selected ? typeDef(selected.type) : null
  const selectedPr = selected ? (PRIORITY_DEFS[selected.priority] || PRIORITY_DEFS.normal) : null

  return (
    <div className="nm-page">
      <div className="nm-head">
        <h1>站内信</h1>
        <span className="nm-sub">公告 / 系统 / 物料与异常提醒 / 反馈 / 盘点抽检 统一收口</span>
        <div className="nm-head-actions">
          <span className="nm-unread-strip">{unreadTotal > 0 ? <><b>{unreadTotal}</b>条未读</> : '无未读消息'}</span>
          <button className="nm-btn nm-btn-secondary" onClick={handleMarkAllRead} disabled={unreadTotal === 0}>
            <CheckOutlined />全部已读
          </button>
          <button className="nm-icon-btn" title="刷新" onClick={() => { fetchCounts(); fetchList() }}>
            <ReloadOutlined />
          </button>
        </div>
      </div>

      <div className="nm-card">
        {/* 左：类型导航 */}
        <aside className="nm-nav">
          <div className="nm-nav-cap">视图</div>
          {navItem('all', <AppstoreOutlined />, '全部消息', allTotal)}
          {navItem('unread', <BellOutlined />, '仅看未读', undefined, unreadTotal)}
          <div className="nm-nav-cap">分类</div>
          {TYPE_DEFS.map(t => {
            const Icon = t.icon
            return navItem(t.key, <Icon />, t.label, undefined, unreadByType[t.key] || 0)
          })}
          {navItem('other', <MoreOutlined />, '其他消息', undefined, otherUnread)}
          <div className="nm-nav-foot">
            <div className={`sse ${sseOn ? 'on' : ''}`}><i />{sseOn ? 'SSE 实时推送已连接' : '实时连接已断开'}</div>
            <button className="nm-btn nm-btn-secondary" onClick={handleMarkAllRead} disabled={unreadTotal === 0}>
              <CheckOutlined />全部已读
            </button>
          </div>
        </aside>

        {/* 中：消息列表 */}
        <section className="nm-list">
          <div className="nm-list-cap">
            <span className="cap-check"><CheckCircleFilled /></span>
            {sseOn ? '实时连接中 · 点击消息查看详情' : '点击消息查看详情'}
            {filter !== 'unread' && unreadTotal > 0 && (
              <span className="cap-link" onClick={() => changeFilter('unread')}>仅看未读 ({unreadTotal})</span>
            )}
          </div>
          <div className="nm-list-body" ref={listRef}>
            <Spin spinning={loading}>
              {items.length === 0 && !loading ? (
                <Empty className="mt-16" description="暂无消息" style={{ marginTop: 64 }} />
              ) : (
                items.map(n => {
                  const td = typeDef(n.type)
                  const Icon = td?.icon || BellOutlined
                  const pr = PRIORITY_DEFS[n.priority] || PRIORITY_DEFS.normal
                  return (
                    <div
                      key={n.id}
                      onClick={() => openDetail(n)}
                      className={`nm-row ${n.is_read ? 'read' : 'unread'} ${n.id === selectedId ? 'active' : ''}`}
                    >
                      <span className="nm-ico" style={{ background: td?.bg || '#f1f5f9', color: td?.color || '#64748b' }}>
                        <Icon />
                      </span>
                      <div className="nm-main">
                        <div className="nm-title">
                          {!n.is_read && <i className="nm-udot" />}
                          <span className="tt">{n.title}</span>
                          {n.priority === 'urgent' && <NmTag color={pr.color} bg={pr.bg}>{pr.label}</NmTag>}
                          {n.priority === 'important' && <NmTag color={pr.color} bg={pr.bg}>{pr.label}</NmTag>}
                        </div>
                        <div className="nm-snip">{n.sender_name ? `${n.sender_name}：` : ''}{n.content || '—'}</div>
                      </div>
                      <div className="nm-side">
                        <span className="nm-time">{fmtTime(n.created_at)}</span>
                      </div>
                    </div>
                  )
                })
              )}
            </Spin>
          </div>
          <div className="nm-list-foot">
            <span className="nm-total">
              {filter === 'unread'
                ? `未读 ${total} 条`
                : filter === 'all'
                  ? `共 ${total} 条`
                  : filter === 'other'
                    ? `其他 ${total} 条`
                    : `${typeDef(filter)?.label || ''} ${total} 条`}
            </span>
            <Pagination
              size="small"
              current={page}
              pageSize={20}
              total={total}
              showSizeChanger={false}
              onChange={p => { setPage(p); listRef.current?.scrollTo({ top: 0 }) }}
            />
          </div>
        </section>

        {/* 右：详情栏 */}
        <aside className="nm-pane">
          {!selected ? (
            <Empty description="点击左侧消息查看详情" style={{ marginTop: 96 }} />
          ) : (
            <div className="nm-pane-body">
              <div className="nm-tags">
                <NmTag color={selectedType?.color || '#64748b'} bg={selectedType?.bg || '#f1f5f9'}>{selectedType?.label || selected.type}</NmTag>
                {selected.priority !== 'normal' && <NmTag color={selectedPr!.color} bg={selectedPr!.bg} dot>{selectedPr!.label}</NmTag>}
                {selected.is_read && <NmTag color="#94a3b8" bg="#f1f5f9">已读</NmTag>}
              </div>
              <h2>{selected.title}</h2>
              <div className="nm-meta">
                <span>{fmtTime(selected.created_at)}</span>
                {selectedType && <span>类型：{selectedType.label}</span>}
                {selected.sender_name && <span>提出人：{selected.sender_name}</span>}
              </div>
              <div className="nm-body">{selected.content || '（无正文）'}</div>
              {jump && (
                <div className="nm-actions">
                  <button className="nm-btn nm-btn-primary" onClick={() => navigate(jump.path)}>
                    打开{jump.label}<RightOutlined style={{ fontSize: 11 }} />
                  </button>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
