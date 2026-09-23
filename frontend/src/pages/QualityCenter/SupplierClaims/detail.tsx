import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Card, Descriptions, Input, Modal, Space, Steps, Tabs, Tag, Timeline, message } from 'antd'
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, EditOutlined, PrinterOutlined, SendOutlined, UndoOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { qualityApi, CLAIM_STATUS_MAP, claimReasonText, claimItemText, claimReturnText } from '../../../services/quality'
import { canApproveNode } from '../../../utils/approvalNode'
import { useAuthStore } from '../../../store/auth'
import { fileApi } from '../../../services/api'

const ACTION_TEXT: Record<string, string> = {
  submit: '提交审批', approve: '通过', reject: '驳回', recall: '撤回单据',
  auto_skip: '自动通过（同人）', revoked: '已撤回审批',
}

export default function SupplierClaimDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [r, setR] = useState<any>(null)
  const [comment, setComment] = useState('')
  const [acting, setActing] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)

  const load = async () => {
    if (!id) return
    try {
      const res: any = await qualityApi.get(parseInt(id))
      setR(res.data)
    } catch { /* 全局拦截器已提示 */ }
  }
  useEffect(() => { load() }, [id])

  if (!r) return <Card loading />

  const status = r.approval_status
  const snap = r.approval_snapshot || []
  const logs = r.approval_logs || []
  const currentLevel = r.approval_level || 1
  const currentStep = snap.find((n: any) => n.seq === currentLevel)
  const curLogs = logs.filter((l: any) => l.round === r.approval_round)
  const rounds = [...new Set<number>(logs.map((l: any) => l.round))]
  const isMine = (r.applicant === useAuthStore.getState().currentUser?.username)

  const act = async (action: string) => {
    if (!id) return
    setActing(true)
    try {
      const cid = parseInt(id)
      if (action === 'submit') await qualityApi.submit(cid)
      else if (action === 'approve') await qualityApi.approve(cid, comment, r.version)
      else if (action === 'reject') await qualityApi.reject(cid, comment, r.version)
      else if (action === 'recall') await qualityApi.recall(cid)
      message.success('操作成功')
      setComment('')
      load()
    } catch { /* 全局拦截器已提示 */ } finally { setActing(false) }
  }

  const doRevoke = async () => {
    if (!id) return
    setActing(true)
    try {
      await qualityApi.revokeApproval(parseInt(id))
      message.success('已撤回审批')
      setRevokeOpen(false)
      load()
    } catch { /* 全局拦截器已提示 */ } finally { setActing(false) }
  }

  const s = CLAIM_STATUS_MAP[status] || CLAIM_STATUS_MAP.draft
  const canAct = status === 'pending' && canApproveNode(useAuthStore.getState().currentUser, currentStep)

  return (
    <Card title={
      <Space>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/quality/supplier-claims')} />
        <span style={{ fontFamily: 'monospace' }}>{r.claim_no}</span>
        <Tag color={s.color}>{s.text}</Tag>
      </Space>
    } extra={
      <Space>
        <Button icon={<PrinterOutlined />} onClick={() => navigate(`/quality/supplier-claims/print/${r.id}`)}>打印 / 导出 PDF</Button>
        {status === 'draft' && isMine && <Button type="primary" icon={<SendOutlined />} loading={acting} onClick={() => act('submit')}>提交审批</Button>}
        {(status === 'rejected' || status === 'recalled') && isMine && (
          <>
            <Button icon={<EditOutlined />} onClick={() => navigate(`/quality/supplier-claims/new?edit=${r.id}`)}>编辑</Button>
            <Button type="primary" icon={<SendOutlined />} loading={acting} onClick={() => act('submit')}>重新提交</Button>
          </>
        )}
        {status === 'pending' && isMine && <Button loading={acting} onClick={() => act('recall')}>撤回单据</Button>}
        {status === 'pending' && (
          <Button icon={<UndoOutlined />} onClick={() => setRevokeOpen(true)}>反审核</Button>
        )}
      </Space>
    }>
      <Tabs defaultActiveKey="info" items={[
        {
          key: 'info', label: '单据信息',
          children: (
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="单号">{r.claim_no}</Descriptions.Item>
              <Descriptions.Item label="开单日期">{r.claim_date || '-'}</Descriptions.Item>
              <Descriptions.Item label="供应商">{r.supplier_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="索赔原因">{claimReasonText(r.claim_reason)}</Descriptions.Item>
              <Descriptions.Item label="索赔细项" span={2}>
                <Space size={4} wrap>{(r.claim_items || []).map((i: string) => <Tag key={i}>☑ {claimItemText(i)}</Tag>)}</Space>
              </Descriptions.Item>
              <Descriptions.Item label="索赔金额（元）"><b style={{ color: '#dc2626', fontSize: 16 }}>{r.claim_amount != null ? Number(r.claim_amount).toLocaleString() : '-'}</b></Descriptions.Item>
              <Descriptions.Item label="退回要求">{claimReturnText(r.return_requirement)}</Descriptions.Item>
              <Descriptions.Item label="索赔方式" span={2}><div style={{ whiteSpace: 'pre-wrap' }}>{r.claim_method || '-'}</div></Descriptions.Item>
              <Descriptions.Item label="金额计算说明" span={2}><div style={{ whiteSpace: 'pre-wrap' }}>{r.calc_explanation || '-'}</div></Descriptions.Item>
              <Descriptions.Item label="备注" span={2}><div style={{ whiteSpace: 'pre-wrap' }}>{r.remarks || '-'}</div></Descriptions.Item>
              <Descriptions.Item label="附件" span={2}>
                {(r.attachments || []).length === 0 ? '-' : (
                  <Space direction="vertical" size={2}>
                    {r.attachments.map((a: any, i: number) => (
                      <a key={i} href={fileApi.downloadUrl(a.key)} target="_blank" rel="noreferrer">{a.name || a.key}</a>
                    ))}
                  </Space>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="申请人">{r.applicant_display || r.applicant}</Descriptions.Item>
              <Descriptions.Item label="提交时间">{r.submitted_at ? dayjs(r.submitted_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
            </Descriptions>
          ),
        },
        {
          key: 'approval', label: '审批流程',
          children: (
            <>
              {snap.length > 0 ? (
                <Steps
                  current={status === 'approved' ? snap.length : Math.max(currentLevel - 1, 0)}
                  status={status === 'rejected' ? 'error' : 'process'}
                  size="small"
                  items={snap.map((st: any, i: number) => {
                    const rej = curLogs.find((l: any) => l.approval_level === i + 1 && l.action === 'reject')
                    const app = curLogs.find((l: any) => l.approval_level === i + 1 && l.action === 'approve')
                    const approvers = Array.isArray(st.approvers) ? st.approvers : null
                    const desc = approvers ? approvers.map((a: any) => a.username || a).join('、') : `角色 ${st.role}`
                    return {
                      title: st.label,
                      description: desc,
                      status: rej ? 'error' : app ? 'finish' : i < currentLevel - 1 ? 'finish' : i === currentLevel - 1 ? 'process' : 'wait',
                    }
                  })}
                />
              ) : (
                <div style={{ fontSize: 13, color: '#94a3b8' }}>暂无审批流程配置</div>
              )}
              {status === 'pending' && (
                canAct ? (
                  <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>审批操作（{currentStep?.label}）</div>
                    <Input.TextArea value={comment} onChange={e => setComment(e.target.value)} placeholder="审批意见（可选）" rows={3} style={{ marginBottom: 12 }} />
                    <Space>
                      <Button type="primary" icon={<CheckOutlined />} loading={acting} onClick={() => act('approve')}>通过</Button>
                      <Button danger icon={<CloseOutlined />} loading={acting} onClick={() => act('reject')}>驳回</Button>
                    </Space>
                  </div>
                ) : (
                  <div style={{ marginTop: 16, fontSize: 13, color: '#94a3b8' }}>
                    当前级别需 {currentStep?.approvers?.map((a: any) => a.username).join('、') || `角色 ${currentStep?.role}`} 审批，您无权操作
                  </div>
                )
              )}
              <div style={{ marginTop: 24, borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>审批记录</div>
                {logs.length === 0 ? <div style={{ color: '#94a3b8', fontSize: 13 }}>暂无审批记录</div> : rounds.map(rn => {
                  const rlogs = logs.filter((l: any) => l.round === rn)
                  return (
                    <div key={rn} style={{ marginBottom: 18 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>第 {rn} 轮提交{rn < rounds[rounds.length - 1] ? '（历史存档）' : ''}</div>
                      <Timeline
                        items={rlogs.map((log: any) => ({
                          color: log.action === 'reject' ? 'red' : (log.action === 'approve' || log.action === 'auto_skip') ? 'green' : log.action === 'revoked' ? 'orange' : 'blue',
                          children: (
                            <div>
                              <Space size={8} wrap>
                                <span style={{ fontWeight: 600 }}>{log.approver}</span>
                                <Tag color={log.action === 'reject' ? 'red' : (log.action === 'approve' || log.action === 'auto_skip') ? 'green' : log.action === 'revoked' ? 'orange' : 'blue'}>{ACTION_TEXT[log.action] || log.action}</Tag>
                                <span style={{ fontSize: 12, color: '#94a3b8' }}>{log.operated_at ? dayjs(log.operated_at).format('YYYY-MM-DD HH:mm') : ''}</span>
                              </Space>
                              {log.comment && <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>{log.comment}</div>}
                            </div>
                          ),
                        }))}
                      />
                    </div>
                  )
                })}
              </div>
            </>
          ),
        },
      ]} />
      <Modal title="反审核（撤回最近一次审批）" open={revokeOpen} onOk={doRevoke} onCancel={() => setRevokeOpen(false)} confirmLoading={acting}>
        将撤回本轮最近一次审批并回退一级重新审批，确认执行？
      </Modal>
    </Card>
  )
}
