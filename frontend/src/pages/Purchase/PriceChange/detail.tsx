import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Collapse, Descriptions, Input, Modal, Space, Steps, Table, Tag, Tabs, Timeline, message } from 'antd'
import { FileTextOutlined, AuditOutlined, BulbOutlined } from '@ant-design/icons'
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, RollbackOutlined, ClockCircleOutlined, CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { purchaseApi } from '../../../services/purchase'
import axios from 'axios'
import { useAuthStore } from '../../../store/auth'

const STATUS_TAG: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  pending: { label: '审批中', color: 'processing' },
  approved: { label: '已通过', color: 'success' },
  rejected: { label: '已驳回', color: 'error' },
  recalled: { label: '已撤回', color: 'warning' },
}

export default function PriceChangeDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [r, setR] = useState<any>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [refreshingAi, setRefreshingAi] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    if (!id) return
    setLoading(true)
    try {
      const res: any = await purchaseApi.get(parseInt(id))
      setR(res.data)
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [id])

  const act = async (action: string) => {
    if (!id) return
    setSubmitting(true)
    try {
      const cid = parseInt(id)
      if (action === 'submit') await purchaseApi.submit(cid)
      else if (action === 'approve') await purchaseApi.approve(cid, comment)
      else if (action === 'reject') await purchaseApi.reject(cid, comment)
      else if (action === 'recall') await purchaseApi.recall(cid)
      message.success('操作成功')
      setComment('')
      load()
    } catch (e: any) {
      message.error(e.message || '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  const refreshAi = async () => {
    if (!id) return
    setRefreshingAi(true)
    try {
      await purchaseApi.aiAnalyze(parseInt(id))
      message.success('AI 分析已刷新')
      load()
    } catch (e: any) {
      message.error(e.message || '刷新失败')
    } finally {
      setRefreshingAi(false)
    }
  }

  const downloadAtt = async (key: string, name: string) => {
    try {
      const token = useAuthStore.getState().currentToken
      const res = await axios.get(`/api/v1/files/download/${key}`, {
        responseType: 'blob',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const url = window.URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (e: any) {
      message.error('下载失败: ' + (e.message || ''))
    }
  }

  const del = () => {
    if (!id) return
    Modal.confirm({
      title: '确认删除',
      icon: <ExclamationCircleOutlined />,
      content: '删除后不可恢复，确认删除？',
      okText: '确认删除',
      okType: 'danger',
      onOk: async () => {
        try {
          await purchaseApi.delete(parseInt(id))
          message.success('已删除')
          navigate('/purchase/price-change')
        } catch (e: any) {
          message.error(e.message || '删除失败')
        }
      },
    })
  }

  const items = r?.items || []
  const logs = r?.approval_logs || []
  const s = r?.approval_status
  const snap = r?.approval_snapshot || []
  const currentLevel = r?.approval_level || 1
  const currentStep = snap[currentLevel - 1]

  let attachments: any[] = []
  try {
    attachments = r && typeof r.attachments === 'string' ? JSON.parse(r.attachments || '[]') : (r?.attachments || [])
  } catch {
    attachments = []
  }

  const aiAnalysis = r?.ai_analysis
  const aiAnalyzedAt = aiAnalysis?.ai_analyzed_at ? dayjs(aiAnalysis.ai_analyzed_at) : null
  const aiOutdated = Boolean(aiAnalyzedAt && dayjs().diff(aiAnalyzedAt, 'hour') >= 24)
  const aiStatusLabel =
    !aiAnalysis ? '未分析'
      : aiOutdated ? '建议刷新'
      : aiAnalysis.ai_status === 'error' ? '分析失败'
      : aiAnalysis.ai_status === 'pending' || aiAnalysis.ai_status === 'analyzing' ? '分析中'
      : aiAnalysis.ai_risk_level === 'high' ? '高风险'
      : aiAnalysis.ai_risk_level === 'medium' ? '中风险'
      : '已完成'
  const aiStatusColor =
    !aiAnalysis ? 'default'
      : aiOutdated ? 'orange'
      : aiAnalysis.ai_status === 'error' ? 'red'
      : aiAnalysis.ai_status === 'pending' || aiAnalysis.ai_status === 'analyzing' ? 'blue'
      : aiAnalysis.ai_risk_level === 'high' ? 'red'
      : aiAnalysis.ai_risk_level === 'medium' ? 'orange'
      : 'green'

  const sectionStyle = {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    padding: '16px 18px',
    marginBottom: 12,
  } as const

  const descProps = {
    bordered: true,
    size: 'small' as const,
    column: 3 as const,
    labelStyle: { width: 120, background: '#f8fafc', color: '#475569' },
    contentStyle: { color: '#0f172a' },
  }

  if (loading) return <div style={{ padding: 40 }}>加载中...</div>
  if (!r) return <div style={{ padding: 40 }}>未找到调价单</div>

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ ...sectionStyle, padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/purchase/price-change')} style={{ paddingLeft: 0, marginBottom: 4 }}>
              返回调价单列表
            </Button>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>调价单</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#334155' }}>{r.change_no || '-'}</span>
              <Tag color={(STATUS_TAG[s] || {}).color}>{(STATUS_TAG[s] || {}).label}</Tag>
              <Tag color="blue">{currentStep?.label || `第${currentLevel}级审批`}</Tag>
              <span style={{ fontSize: 12, color: '#64748b' }}>申请人 {r.applicant || '-'}</span>
            </div>
          </div>
          <Space>
            {(s === 'draft' || s === 'rejected' || s === 'recalled') && <Button danger icon={<DeleteOutlined />} onClick={del}>删除</Button>}
            {s === 'draft' && (
              <>
                <Button onClick={() => navigate(`/purchase/price-change/new?edit=${id}`)}>编辑</Button>
                <Button type="primary" onClick={() => act('submit')} loading={submitting}>提交审批</Button>
              </>
            )}
            {s === 'pending' && <Button icon={<RollbackOutlined />} onClick={() => act('recall')} loading={submitting}>撤回</Button>}
          </Space>
        </div>
      </div>

      <Tabs defaultActiveKey="info">
        <Tabs.TabPane tab={<><FileTextOutlined /> 基础资料</>} key="info">
          <div style={sectionStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#0f172a' }}>表单信息</div>
            <Descriptions {...descProps}>
              <Descriptions.Item label="标题">{r.title || '-'}</Descriptions.Item>
              <Descriptions.Item label="申请人">{r.applicant || '-'}</Descriptions.Item>
              <Descriptions.Item label="调价日期">{r.change_date || '-'}</Descriptions.Item>
              <Descriptions.Item label="供应商名称">{r.supplier_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="供应商代码">{r.supplier_code || '-'}</Descriptions.Item>
              <Descriptions.Item label="联系人">{r.contact_person || '-'}</Descriptions.Item>
              <Descriptions.Item label="电话">{r.phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="传真">{r.fax || '-'}</Descriptions.Item>
              <Descriptions.Item label="地址">{r.address || '-'}</Descriptions.Item>
              <Descriptions.Item label="类型">
                <Tag color={r.price_direction === '涨价' ? 'red' : r.price_direction === '降价' ? 'green' : 'blue'}>{r.price_direction || '-'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="采购联系人">{r.purchase_contact || '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{r.created_at ? dayjs(r.created_at).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
              <Descriptions.Item label="顾客">{r.customer || '-'}</Descriptions.Item>
              <Descriptions.Item label="顾客电话">{r.customer_phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="顾客传真">{r.customer_fax || '-'}</Descriptions.Item>
              <Descriptions.Item label="付款方式">{r.payment_method || '-'}</Descriptions.Item>
              <Descriptions.Item label="结算方式">{r.settlement_method || '-'}</Descriptions.Item>
              <Descriptions.Item label="税率">{r.tax_rate || '-'}</Descriptions.Item>
              <Descriptions.Item label="备注" span={3}>{r.remark || '-'}</Descriptions.Item>
            </Descriptions>
          </div>

          <div style={sectionStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#0f172a' }}>物料明细</div>
            <Table
              rowKey="id"
              dataSource={items}
              size="small"
              pagination={false}
              scroll={{ x: 980 }}
              locale={{ emptyText: '暂无物料明细' }}
              columns={[
                { title: '序号', dataIndex: 'seq', width: 60, render: (v: any, _: any, i: number) => v || i + 1 },
                { title: '物料代码', dataIndex: 'material_code', width: 140 },
                { title: '物料名称', dataIndex: 'material_name', width: 180 },
                { title: '规格', dataIndex: 'spec', width: 130 },
                { title: '单位', dataIndex: 'unit', width: 70 },
                { title: '订货量', dataIndex: 'order_qty', width: 90 },
                { title: '原价', dataIndex: 'old_price', width: 90 },
                { title: '原价年月', dataIndex: 'old_price_date', width: 100 },
                { title: '现价', dataIndex: 'new_price', width: 90 },
                {
                  title: '涨幅',
                  dataIndex: 'price_change_pct',
                  width: 90,
                  render: (v: number) => v == null
                    ? <span style={{ color: '#cbd5e1' }}>--</span>
                    : <span style={{ color: v >= 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{v >= 0 ? '+' : ''}{v}%</span>,
                },
                { title: '备注', dataIndex: 'remark', width: 120, ellipsis: true },
              ]}
            />
          </div>

          <div style={sectionStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#0f172a' }}>附件与分析</div>
            {attachments.length > 0 ? (
              <div style={{ marginBottom: 12 }}>
                {attachments.map((a: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                    <span style={{ fontSize: 13, color: '#334155' }}>{a.name}</span>
                    <a onClick={(e) => { e.preventDefault(); downloadAtt(a.key, a.name) }} style={{ fontSize: 12, color: '#2563eb', cursor: 'pointer' }}>下载</a>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 12 }}>暂无附件</div>
            )}

            <Collapse
              ghost
              items={[
                {
                  key: 'ai',
                  label: (
                    <Space size={8}>
                      <BulbOutlined />
                      <span>AI 分析</span>
                      <Tag color={aiStatusColor}>{aiStatusLabel}</Tag>
                    </Space>
                  ),
                  children: (
                    <div>
                      <div style={{ marginBottom: 10, fontSize: 13, color: '#475569', whiteSpace: 'pre-wrap' }}>
                        {aiAnalysis?.ai_conclusion || aiAnalysis?.ai_detail || aiAnalysis?.ai_error_msg || '暂无 AI 分析结果'}
                      </div>
                      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 10 }}>
                        {aiAnalysis?.ai_model ? `模型 ${aiAnalysis.ai_model}` : '模型待返回'}
                        {aiAnalyzedAt ? ` | 更新时间 ${aiAnalyzedAt.format('YYYY-MM-DD HH:mm')}` : ''}
                      </div>
                      <Button icon={<ReloadOutlined />} loading={refreshingAi} onClick={refreshAi}>刷新 AI 分析</Button>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane tab={<><AuditOutlined /> 审批</>} key="approval">
          <div style={sectionStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#0f172a' }}>审批流程</div>
            {snap.length > 0 ? (
              <Steps
                current={s === 'approved' ? snap.length : Math.max(currentLevel - 1, 0)}
                status={s === 'rejected' ? 'error' : 'process'}
                size="small"
                items={snap.map((st: any, i: number) => {
                  const rej = logs.find((l: any) => l.approval_level === i + 1 && l.action === 'reject')
                  const app = logs.find((l: any) => l.approval_level === i + 1 && l.action === 'approve')
                  return {
                    title: st.label,
                    description: st.role,
                    status: rej ? 'error' : app ? 'finish' : i < currentLevel - 1 ? 'finish' : i === currentLevel - 1 ? 'process' : 'wait',
                    icon: rej ? <CloseCircleOutlined /> : app ? <CheckCircleOutlined /> : <ClockCircleOutlined />,
                  }
                })}
              />
            ) : (
              <div style={{ fontSize: 13, color: '#94a3b8' }}>暂无审批流程配置</div>
            )}

            {s === 'pending' && (
              <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>审批操作</div>
                <Input.TextArea value={comment} onChange={e => setComment(e.target.value)} placeholder="审批意见（可选）" rows={3} style={{ marginBottom: 12 }} />
                <Space>
                  <Button type="primary" icon={<CheckOutlined />} loading={submitting} onClick={() => act('approve')}>通过</Button>
                  <Button danger icon={<CloseOutlined />} loading={submitting} onClick={() => act('reject')}>驳回</Button>
                </Space>
              </div>
            )}
          </div>

          <div style={sectionStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#0f172a' }}>审批记录</div>
            {logs.length === 0 ? <div style={{ color: '#94a3b8', fontSize: 13 }}>暂无审批记录</div> : (
              <Timeline
                items={logs.map((log: any, i: number) => ({
                  color: log.action === 'reject' ? 'red' : log.action === 'approve' ? 'green' : 'blue',
                  children: (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{log.approver}</span>
                        <Tag color={log.action === 'reject' ? 'red' : log.action === 'approve' ? 'green' : 'blue'}>
                          {log.action === 'submit' ? '提交审批' : log.action === 'approve' ? '已通过' : log.action === 'recall' ? '已撤回' : '已驳回'}
                        </Tag>
                        <span style={{ fontSize: 12, color: '#94a3b8' }}>{log.operated_at ? dayjs(log.operated_at).format('YYYY-MM-DD HH:mm') : ''}</span>
                      </div>
                      {log.comment && <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>意见：{log.comment}</div>}
                    </div>
                  ),
                }))}
              />
            )}
          </div>
        </Tabs.TabPane>
      </Tabs>
    </div>
  )
}
