import { useEffect, useState, useCallback, useMemo } from 'react'
import { Table, Button, Modal, Input, message, Tooltip, Empty } from 'antd'
import {
  CopyOutlined, SendOutlined, UndoOutlined, ReloadOutlined,
  LinkOutlined, SearchOutlined, DeleteOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { shareApi, wecomApi, type WecomUser } from '@/services/api'
import KpiBand, { type KpiItem } from './components/KpiBand'
import ChipsFilter from './components/ChipsFilter'

interface ShareItem {
  id: number
  token: string
  target_path: string
  target_params: Record<string, string> | null
  permissions: string[] | null
  reason: string | null
  expires_at: string | null
  is_revoked: boolean
  access_count: number
  created_at: string
}

type ShareStatus = 'live' | 'expired' | 'revoked'

const statusOf = (r: ShareItem): ShareStatus => {
  if (r.is_revoked) return 'revoked'
  if (r.expires_at && dayjs(r.expires_at).isBefore(dayjs())) return 'expired'
  return 'live'
}

const FULL_URL = (token: string) => `${window.location.origin}/share/${token}`
const TOKEN_SHORT = (token: string) => (token.length > 12 ? `${token.slice(0, 10)}…` : token)

export default function ShareManagement() {
  const [data, setData] = useState<ShareItem[]>([])
  const [loading, setLoading] = useState(false)
  const [statusChip, setStatusChip] = useState<string | number>('all')
  const [keyword, setKeyword] = useState('')

  const [resendTarget, setResendTarget] = useState<ShareItem | null>(null)
  const [wecomUsers, setWecomUsers] = useState<WecomUser[]>([])
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [userFilter, setUserFilter] = useState('')
  const [sending, setSending] = useState(false)

  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ShareItem | null>(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await shareApi.list()
      setData(res.data || [])
    } catch {
      setData([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const stats = useMemo(() => {
    const live = data.filter((r) => statusOf(r) === 'live').length
    const expired = data.filter((r) => statusOf(r) === 'expired').length
    const revoked = data.filter((r) => statusOf(r) === 'revoked').length
    const access = data.reduce((s, r) => s + (r.access_count || 0), 0)
    return { total: data.length, live, expired, revoked, access }
  }, [data])

  const kpiItems: KpiItem[] = [
    { label: '生效中', value: stats.live, sub: '链接当前可访问', accent: 'success', onClick: () => setStatusChip('live') },
    { label: '已过期', value: stats.expired, sub: '过期后链接自动失效', go: '查看 →', accent: 'warning', onClick: () => setStatusChip('expired') },
    { label: '已撤销', value: stats.revoked, sub: '手动撤销', go: '查看 →', accent: 'danger', onClick: () => setStatusChip('revoked') },
    { label: '累计访问', value: stats.access.toLocaleString(), sub: `平均每链接 ${stats.total ? (stats.access / stats.total).toFixed(1) : 0} 次`, accent: 'brand', onClick: () => setStatusChip('all') },
  ]

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return data.filter((r) => {
      if (statusChip !== 'all' && statusOf(r) !== statusChip) return false
      if (!kw) return true
      return (
        r.target_path?.toLowerCase().includes(kw) ||
        r.reason?.toLowerCase().includes(kw) ||
        r.token?.toLowerCase().includes(kw)
      )
    })
  }, [data, statusChip, keyword])

  const handleCopy = (token: string) => {
    navigator.clipboard.writeText(FULL_URL(token)).then(() => {
      message.success('链接已复制')
      setCopiedToken(token)
      setTimeout(() => setCopiedToken(null), 1600)
    }).catch(() => message.error('复制失败'))
  }

  const openResend = (item: ShareItem) => {
    setResendTarget(item)
    setSelectedUserIds([])
    setUserFilter('')
    if (wecomUsers.length === 0) {
      wecomApi.listUsers().then((res: any) => setWecomUsers(res.data || [])).catch(() => {
        message.warning('企业微信用户列表加载失败，请检查企业微信配置')
      })
    }
  }

  const handleResend = async () => {
    if (!resendTarget || selectedUserIds.length === 0) {
      message.warning('请选择至少一名收件人')
      return
    }
    setSending(true)
    try {
      const res: any = await shareApi.sendWecom(resendTarget.id, { user_ids: selectedUserIds })
      const d = res.data || {}
      if (d.success > 0) message.success(`已推送 ${d.success} 人`)
      if (d.failed?.length > 0) message.warning(`${d.failed.length} 人推送失败`)
      setResendTarget(null)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '推送失败')
    } finally {
      setSending(false)
    }
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await shareApi.revoke(revokeTarget.id)
      message.success('链接已撤销，立即失效')
      setRevokeTarget(null)
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '撤销失败')
    } finally {
      setRevoking(false)
    }
  }

  const filteredUsers = wecomUsers.filter((u) =>
    !userFilter || u.name?.includes(userFilter) || u.userid?.includes(userFilter),
  )

  const renderExpiry = (r: ShareItem) => {
    const st = statusOf(r)
    if (st === 'revoked') {
      return (
        <span className="sc-tag sc-tag-danger">
          <span style={{ textDecoration: 'line-through' }}>{r.expires_at ? dayjs(r.expires_at).format('YYYY-MM-DD') : ''}</span>
          {' 已撤销'}
        </span>
      )
    }
    if (!r.expires_at) return <span className="sc-tag sc-tag-done">永久</span>
    const txt = dayjs(r.expires_at).format('YYYY-MM-DD')
    return st === 'expired'
      ? <span className="sc-tag sys-exp-over">{txt} · 已过期</span>
      : <span className="sc-tag sys-exp-date">{txt}</span>
  }

  const renderTarget = (r: ShareItem) => {
    const st = statusOf(r)
    const dim = st !== 'live'
    return (
      <span>
        <span className="sys-tgt-main" style={dim ? { color: '#94a3b8' } : undefined}>
          <LinkOutlined style={{ color: dim ? '#cbd5e1' : '#5b5bd6', fontSize: 12 }} />
          <Tooltip title={r.target_path}>
            <span style={dim ? {} : { cursor: 'pointer' }}>{r.target_path}</span>
          </Tooltip>
        </span>
        <div className="sys-tgt-link">
          …/share/<span className="tok">{TOKEN_SHORT(r.token)}</span>
        </div>
      </span>
    )
  }

  const columns = [
    {
      title: '目标页面', key: 'target', width: 300,
      render: (_: any, r: ShareItem) => renderTarget(r),
    },
    {
      title: '分享原因', dataIndex: 'reason', key: 'reason', width: 220, ellipsis: true,
      render: (v: string | null, r: ShareItem) =>
        v || <span className="sc-note">—</span>,
    },
    {
      title: '权限', dataIndex: 'permissions', key: 'permissions', width: 140,
      render: (v: string[] | null) => {
        const perms = v && v.length ? v : ['read']
        return (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            {perms.map((p) => (
              <span key={p} className="sc-tag sc-tag-kit">{p}</span>
            ))}
          </span>
        )
      },
    },
    {
      title: '有效期', key: 'expires', width: 180,
      render: (_: any, r: ShareItem) => renderExpiry(r),
    },
    {
      title: '访问次数', dataIndex: 'access_count', key: 'access_count', width: 90, align: 'center' as const,
      render: (v: number, r: ShareItem) => (
        <span style={{ fontWeight: statusOf(r) === 'live' ? 600 : 400, color: statusOf(r) === 'live' ? '#0f172a' : '#94a3b8' }}>
          {v ?? 0}
        </span>
      ),
    },
    {
      title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 150,
      render: (v: string, r: ShareItem) => (
        <span className="sc-mono" style={{ color: statusOf(r) === 'live' ? '#64748b' : '#cbd5e1' }}>
          {dayjs(v).format('YYYY-MM-DD HH:mm')}
        </span>
      ),
    },
    {
      title: '操作', key: 'action', width: 230, fixed: 'right' as const,
      render: (_: any, r: ShareItem) => {
        const st = statusOf(r)
        if (st === 'revoked') {
          return <span style={{ color: '#cbd5e1', fontSize: 'calc(12.5px * var(--font-size-scale))' }}>已失效</span>
        }
        return (
          <span className="sc-row-act">
            <a onClick={() => handleCopy(r.token)}>
              {copiedToken === r.token ? <CheckCircleOutlined style={{ color: '#16a34a' }} /> : <CopyOutlined />} 复制链接
            </a>
            {st !== 'expired' && <a onClick={() => openResend(r)}><SendOutlined /> 推送企微</a>}
            <a style={{ color: '#dc2626' }} onClick={() => setRevokeTarget(r)}><UndoOutlined /> 撤销</a>
          </span>
        )
      },
    },
  ]

  return (
    <div className="sc-page">
      <KpiBand items={kpiItems} />

      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="目标页面 / 原因 / Token"
            style={{ width: 260 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </span>
        <ChipsFilter
          options={[
            { label: '全部', value: 'all', count: stats.total },
            { label: '生效中', value: 'live', count: stats.live },
            { label: '已过期', value: 'expired', count: stats.expired },
            { label: '已撤销', value: 'revoked', count: stats.revoked },
          ]}
          value={statusChip}
          onChange={(v) => setStatusChip(v)}
        />
        <span className="sc-toolbar-hint" style={{ marginLeft: 'auto' }}>
          分享由各业务页「生成链接」创建 · 本页统一治理
        </span>
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          dataSource={filtered}
          columns={columns as any}
          loading={loading}
          size="small"
          scroll={{ x: 1300 }}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={filtered.length === 0 && data.length > 0 ? '无匹配的分享记录' : '暂无分享记录'}
              />
            ),
          }}
        />
      </div>

      {/* 推送企业微信 */}
      <Modal
        title="推送到企业微信"
        open={!!resendTarget}
        onOk={handleResend}
        onCancel={() => setResendTarget(null)}
        confirmLoading={sending}
        okText="推送"
        width={620}
        destroyOnClose
        rootClassName="sc-page"
      >
        <div style={{ marginBottom: 12, display: 'flex', gap: 10 }}>
          <Input.Search
            placeholder="搜索姓名 / userid"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            allowClear
            style={{ flex: 1 }}
          />
          <span style={{ alignSelf: 'center', fontSize: 'calc(11.5px * var(--font-size-scale))', color: '#94a3b8', whiteSpace: 'nowrap' }}>
            来源：企微通讯录
          </span>
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 }}>
          {filteredUsers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 36, color: '#94a3b8' }}>
              {wecomUsers.length === 0 ? '企业微信用户加载中…' : '无匹配用户'}
            </div>
          ) : (
            filteredUsers.map((u) => {
              const checked = selectedUserIds.includes(u.userid)
              return (
                <label
                  key={u.userid}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', cursor: 'pointer',
                    borderBottom: '1px solid #f8fafc', background: checked ? '#eef0fe' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedUserIds((prev) => [...prev, u.userid])
                      else setSelectedUserIds((prev) => prev.filter((id) => id !== u.userid))
                    }}
                    style={{ width: 14, height: 14, accentColor: '#5b5bd6', margin: 0 }}
                  />
                  <span style={{ fontWeight: 500, color: '#0f172a' }}>{u.name}</span>
                  <span className="sc-mono" style={{ color: '#94a3b8', fontSize: 'calc(11.5px * var(--font-size-scale))' }}>{u.userid}</span>
                </label>
              )
            })
          )}
        </div>
        <div className="sc-toolbar-hint" style={{ marginTop: 8 }}>
          已选 <b style={{ color: '#4c4dc2' }}>{selectedUserIds.length}</b> 人 · 点击推送后对方企微将收到分享卡片
        </div>
      </Modal>

      {/* 撤销确认 */}
      <Modal
        title={<span style={{ color: '#dc2626' }}>撤销分享链接</span>}
        open={!!revokeTarget}
        onOk={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
        okText="确认撤销"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        confirmLoading={revoking}
        width={480}
        rootClassName="sc-page"
      >
        <p style={{ fontSize: 'calc(13.5px * var(--font-size-scale))', color: '#475569', lineHeight: 1.8 }}>
          确认撤销以下分享？撤销后链接<b style={{ color: '#dc2626' }}>立即失效</b>，已打开页面也将停止刷新数据。操作将记入审计日志。
        </p>
        {revokeTarget && (
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px' }}>
            <div className="sys-tgt-main">
              <LinkOutlined style={{ color: '#5b5bd6', fontSize: 12 }} /> {revokeTarget.target_path}
            </div>
            <div className="sys-tgt-link" style={{ marginTop: 3 }}>
              …/share/{TOKEN_SHORT(revokeTarget.token)} · 已访问 {revokeTarget.access_count} 次 · 创建于 {dayjs(revokeTarget.created_at).format('MM-DD HH:mm')}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
