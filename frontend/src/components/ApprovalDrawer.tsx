import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Descriptions, Drawer, Input, Space, Spin, Steps, Tag, Timeline, Typography, message } from 'antd'
import dayjs from 'dayjs'
import { approvalApi, type ApprovalPreview } from '../services/approval'

const STATE_TEXT: Record<string, string> = { done: '已处理', current: '当前节点', todo: '待处理' }
const STATE_STATUS: Record<string, 'finish' | 'process' | 'wait'> = { done: 'finish', current: 'process', todo: 'wait' }

const fmt = (v?: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-')

export default function ApprovalDrawer({ open, bizType, itemId, onClose, onDone }: {
  open: boolean
  bizType?: string
  itemId?: number
  onClose: () => void
  onDone?: (payload: { action: 'approve' | 'reject'; id: number }) => void
}) {
  const [data, setData] = useState<ApprovalPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    if (!bizType || !itemId) return
    setLoading(true)
    try {
      const res: any = await approvalApi.preview(bizType, itemId)
      setData(res.data || null)
      setComment('')
    } catch { /* 全局拦截器已提示 */ } finally { setLoading(false) }
  }, [bizType, itemId])

  useEffect(() => { if (open) load() }, [open, load])

  const act = async (action: 'approve' | 'reject') => {
    if (!bizType || !itemId || !data) return
    if (action === 'reject' && !comment.trim()) { message.warning('驳回必须填写审批意见'); return }
    setSubmitting(true)
    try {
      const payload = { comment: comment.trim(), expected_version: data.version }
      const res: any = action === 'approve'
        ? await approvalApi.approve(bizType, itemId, payload)
        : await approvalApi.reject(bizType, itemId, payload)
      message.success(res.message || '操作成功')
      onDone?.({ action, id: itemId })
      onClose()
    } catch { /* 全局拦截器已提示 */ } finally { setSubmitting(false) }
  }

  const canAct = !!data?.can_act

  return (
    <Drawer
      title={data ? `${data.title || '-'} · ${data.no || ''}` : '审批详情'}
      width={640}
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={data?.deep_link ? (
        <a href={data.deep_link} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>打开完整详情</a>
      ) : null}
      footer={canAct ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.TextArea rows={2} value={comment} onChange={e => setComment(e.target.value)}
            placeholder="审批意见（驳回必填）…" />
          <div style={{ textAlign: 'right' }}>
            <Space>
              <Button danger loading={submitting} onClick={() => act('reject')}>驳回</Button>
              <Button type="primary" loading={submitting} onClick={() => act('approve')}>通过</Button>
            </Space>
          </div>
        </Space>
      ) : (
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text type="secondary">{data?.action_hint || '该业务不支持在审批中心内审批'}</Typography.Text>
          {data?.deep_link ? <Button type="primary" onClick={() => window.open(data.deep_link, '_self')}>前往业务页面</Button> : null}
        </Space>
      )}
    >
      <Spin spinning={loading}>
        {data ? (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Tag color="blue">{data.biz_name}</Tag>
              {data.current_node ? <Tag>{data.current_node}</Tag> : null}
              {data.wait_level === 'overdue' ? <Tag color="red">已超时 {data.wait_hours} 小时</Tag> : null}
              {data.wait_level === 'soon' ? <Tag color="orange">已等待 {data.wait_hours} 小时</Tag> : null}
            </Space>

            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              {(data.fields || []).map(f => (
                <Descriptions.Item key={f.label} label={f.label} span={f.emphasis ? 2 : 1}>
                  <span style={f.emphasis ? { color: '#dc2626', fontWeight: 600 } : undefined}>{f.value ?? '-'}</span>
                </Descriptions.Item>
              ))}
            </Descriptions>

            {(data.progress || []).length > 0 && (
              <>
                <Typography.Title level={5}>审批进度</Typography.Title>
                <Steps
                  direction="vertical"
                  size="small"
                  style={{ marginBottom: 16 }}
                  items={(data.progress || []).map(n => ({
                    title: n.label,
                    status: STATE_STATUS[n.state] || 'wait',
                    description: (
                      <div style={{ fontSize: 12, color: '#64748b' }}>
                        {n.approver_label} · {STATE_TEXT[n.state]}{n.acted_at ? ` · ${fmt(n.acted_at)}` : ''}
                        {n.comment ? <div style={{ color: '#334155' }}>{n.comment}</div> : null}
                      </div>
                    ),
                  }))}
                />
              </>
            )}

            <Typography.Title level={5}>审批记录</Typography.Title>
            <Timeline
              items={(data.logs || []).map(lg => ({
                children: (
                  <div style={{ fontSize: 12 }}>
                    <div style={{ color: '#94a3b8' }}>{fmt(lg.time)}</div>
                    <div>{lg.who} {lg.action_label || lg.action}</div>
                    {lg.comment ? <div style={{ color: '#64748b' }}>{lg.comment}</div> : null}
                  </div>
                ),
              }))}
            />
          </>
        ) : !loading ? <Alert type="warning" message="未获取到单据详情" /> : null}
      </Spin>
    </Drawer>
  )
}
