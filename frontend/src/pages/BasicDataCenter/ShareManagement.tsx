import { useEffect, useState, useCallback } from 'react'
import { Table, Tag, Button, Space, Popconfirm, message, Modal, Input, Empty, Tooltip, Card } from 'antd'
import { CopyOutlined, DeleteOutlined, SendOutlined, ReloadOutlined, LinkOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { shareApi, wecomApi, type WecomUser } from '@/services/api'
import { useAuthStore } from '@/store/auth'

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

export default function ShareManagement() {
  const [data, setData] = useState<ShareItem[]>([])
  const [loading, setLoading] = useState(false)
  const [resendModal, setResendModal] = useState<{ open: boolean; shareId: number | null }>({ open: false, shareId: null })
  const [wecomUsers, setWecomUsers] = useState<WecomUser[]>([])
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [userFilter, setUserFilter] = useState('')
  const [sending, setSending] = useState(false)

  const hasPermission = useAuthStore((s) => s.hasPermission)

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

  const handleCopy = (token: string) => {
    const url = `${window.location.origin}/share/${token}`
    navigator.clipboard.writeText(url).then(() => message.success('链接已复制'))
  }

  const handleRevoke = async (id: number) => {
    try {
      await shareApi.revoke(id)
      message.success('已撤销')
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '撤销失败')
    }
  }

  const openResend = async (shareId: number) => {
    setResendModal({ open: true, shareId })
    setSelectedUserIds([])
    setUserFilter('')
    if (wecomUsers.length === 0) {
      try {
        const res: any = await wecomApi.listUsers()
        setWecomUsers(res.data || [])
      } catch {
        message.warning('企业微信用户列表加载失败，请检查企业微信配置')
      }
    }
  }

  const handleResend = async () => {
    if (!resendModal.shareId || selectedUserIds.length === 0) {
      message.warning('请选择至少一名收件人')
      return
    }
    setSending(true)
    try {
      const res: any = await shareApi.sendWecom(resendModal.shareId, { user_ids: selectedUserIds })
      const d = res.data || {}
      if (d.success > 0) message.success(`已推送 ${d.success} 人`)
      if (d.failed?.length > 0) message.warning(`${d.failed.length} 人推送失败`)
      setResendModal({ open: false, shareId: null })
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '推送失败')
    } finally {
      setSending(false)
    }
  }

  const filteredUsers = wecomUsers.filter(u =>
    !userFilter || u.name?.includes(userFilter) || u.userid?.includes(userFilter)
  )

  const columns = [
    {
      title: '目标页面', dataIndex: 'target_path', width: 200, ellipsis: true,
      render: (v: string, r: ShareItem) => (
        <Tooltip title={v}>
          <span><LinkOutlined /> {v}</span>
        </Tooltip>
      ),
    },
    { title: '原因', dataIndex: 'reason', width: 150, ellipsis: true, render: (v: string | null) => v || '-' },
    {
      title: '权限', dataIndex: 'permissions', width: 120,
      render: (v: string[] | null) => v?.length ? v.map(p => <Tag key={p} color="blue">{p}</Tag>) : <Tag>read</Tag>,
    },
    {
      title: '过期时间', dataIndex: 'expires_at', width: 120,
      render: (v: string | null, r: ShareItem) => {
        if (r.is_revoked) return <Tag color="red">已撤销</Tag>
        if (!v) return <Tag color="green">永久</Tag>
        if (dayjs(v).isBefore(dayjs())) return <Tag color="orange">已过期</Tag>
        return <span>{dayjs(v).format('YYYY-MM-DD HH:mm')}</span>
      },
    },
    { title: '访问次数', dataIndex: 'access_count', width: 80, align: 'center' as const },
    {
      title: '创建时间', dataIndex: 'created_at', width: 140,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '操作', key: 'action', width: 200, fixed: 'right' as const,
      render: (_: any, r: ShareItem) => (
        <Space size={0}>
          <Button size="small" type="link" icon={<CopyOutlined />} onClick={() => handleCopy(r.token)}>复制链接</Button>
          {!r.is_revoked && (
            <>
              <Button size="small" type="link" icon={<SendOutlined />} onClick={() => openResend(r.id)}>推送企微</Button>
              <Popconfirm title="确认撤销此分享链接？" onConfirm={() => handleRevoke(r.id)}>
                <Button size="small" type="link" danger icon={<DeleteOutlined />}>撤销</Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: '#1f2f47' }}>分享管理</span>
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          dataSource={data}
          columns={columns}
          loading={loading}
          size="small"
          scroll={{ x: 1000 }}
          pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条` }}
          locale={{ emptyText: <Empty description="暂无分享记录" /> }}
        />
      </div>

      <Modal
        title="推送到企业微信"
        open={resendModal.open}
        onOk={handleResend}
        onCancel={() => setResendModal({ open: false, shareId: null })}
        confirmLoading={sending}
        width={500}
        destroyOnClose
      >
        <div style={{ marginBottom: 12 }}>
          <Input.Search
            placeholder="搜索姓名/工号"
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            style={{ width: '100%' }}
            allowClear
          />
        </div>
        <div style={{ maxHeight: 350, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 8 }}>
          {filteredUsers.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
              {wecomUsers.length === 0 ? '企业微信用户加载中...' : '无匹配用户'}
            </div>
          ) : (
            filteredUsers.map(u => (
              <label
                key={u.userid}
                style={{
                  display: 'flex', alignItems: 'center', padding: '8px 16px', cursor: 'pointer',
                  borderBottom: '1px solid #f5f5f5', background: selectedUserIds.includes(u.userid) ? '#e6f4ff' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedUserIds.includes(u.userid)}
                  onChange={e => {
                    if (e.target.checked) setSelectedUserIds(prev => [...prev, u.userid])
                    else setSelectedUserIds(prev => prev.filter(id => id !== u.userid))
                  }}
                  style={{ marginRight: 12 }}
                />
                <span style={{ fontWeight: 500 }}>{u.name}</span>
                <span style={{ marginLeft: 8, color: '#999', fontSize: 12 }}>{u.userid}</span>
              </label>
            ))
          )}
        </div>
        <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>
          已选 {selectedUserIds.length} 人 — 点击确定后企业微信会收到分享消息卡片
        </div>
      </Modal>
    </div>
  )
}
