import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Collapse, Descriptions, Input, Modal, Space, Steps, Table, Tag, Tabs, Timeline, Alert, Divider, Upload, message } from 'antd'
import { FileTextOutlined, AuditOutlined, BulbOutlined, WarningOutlined } from '@ant-design/icons'
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, RollbackOutlined, ClockCircleOutlined, CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined, ExclamationCircleOutlined, ReloadOutlined, SendOutlined, UploadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { purchaseApi } from '../../../services/purchase'
import { fileApi } from '../../../services/api'
import axios from 'axios'
import { useAuthStore } from '../../../store/auth'

const STATUS_TAG: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  pending: { label: '审批中', color: 'processing' },
  approved: { label: '已归档', color: 'success' },
  rejected: { label: '已驳回', color: 'error' },
  recalled: { label: '已撤回', color: 'warning' },
}

function canApproveNode(user: any, node: any): boolean {
  if (!user || !node) return false
  if ('role_code' in user && user.role_code === 'admin') return true
  const approvers = node.approvers
  if (Array.isArray(approvers)) {
    return approvers.some((a: any) => a.username === user.username || String(a.user_id) === String(user.id))
  }
  const role = node.role
  if (role && role !== '__dept_manager__') {
    return 'role_code' in user && user.role_code === role
  }
  return false
}

export default function PriceChangeDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [r, setR] = useState<any>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [refreshingAi, setRefreshingAi] = useState(false)
  const [loading, setLoading] = useState(false)
  // 详情页提交弹窗
  const [scModal, setScModal] = useState(false)
  const [scResult, setScResult] = useState<any>(null)
  const [scEvidence, setScEvidence] = useState<any[]>([])
  const [scEvidenceFiles, setScEvidenceFiles] = useState<any[]>([])
  const [scActionNote, setScActionNote] = useState('')
  const [scSaving, setScSaving] = useState(false)
  const [previewFile, setPreviewFile] = useState<{ url: string; name: string } | null>(null)

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
      if (action === 'submit') {
        // 提交前先查自检结果，高风险弹窗传凭证
        const scRes: any = await purchaseApi.selfCheckRecord(cid)
        const scData = scRes.data
        if (scData?.overall_status === 'high' || scData?.overall_status === 'medium') {
          setScResult(scData)
          setScEvidence([])
          setScEvidenceFiles([])
          setScActionNote('')
          setScModal(true)
          setSubmitting(false)
          return
        }
        await purchaseApi.submit(cid)
      }
      else if (action === 'approve') await purchaseApi.approve(cid, comment, r?.version)
      else if (action === 'reject') await purchaseApi.reject(cid, comment, r?.version)
      else if (action === 'recall') await purchaseApi.recall(cid)
      else if (action === 'revoke') await purchaseApi.revokeApproval(cid)
      message.success('操作成功')
      setComment('')
      load()
    } catch (e: any) {
      const apiData = e._apiData
      if (apiData?.data?._self_check_required) {
        setScResult(apiData.data._self_check_result || { overall_status: 'high' })
        setScModal(true)
        message.warning(apiData.message || '自检未通过，请上传支撑凭证')
        return
      }
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

  const uploadScEvidence = async (file: File): Promise<any> => {
    try {
      const upRes: any = await fileApi.upload(file, 'purchase-price-change-evidence')
      return { id: upRes.data.id, key: upRes.data.key, name: upRes.data.name, url: upRes.data.url }
    } catch (err: any) {
      message.warning(`上传失败: ${file.name}: ${err?.message || err}`)
      return null
    }
  }

  const submitWithEvidence = async () => {
    if (!id) return
    setScSaving(true)
    try {
      const cid = parseInt(id)
      const evidenceItems: any[] = []
      const uploadTasks = scEvidenceFiles.map(async (ef) => {
        const rawFile = ef.originFileObj || ef
        const uploaded = await uploadScEvidence(rawFile)
        if (uploaded) evidenceItems.push(uploaded)
      })
      await Promise.all(uploadTasks)
      for (const existing of scEvidence) {
        if (existing.id) evidenceItems.push(existing)
      }
      await purchaseApi.submit(cid, { self_check_evidence: evidenceItems, self_check_action_note: scActionNote })
      message.success('已提交审批')
      setScModal(false)
      load()
    } catch (e: any) {
      const apiData = e._apiData
      if (apiData?.data?._self_check_required) {
        message.warning(apiData.message || '自检未通过，请补充凭证')
        setScSaving(false)
        return
      }
      message.error(e.message || '提交失败')
    } finally {
      setScSaving(false)
    }
  }

  const closeScModal = () => {
    setScModal(false)
    setScResult(null)
    setScEvidence([])
    setScEvidenceFiles([])
    setScActionNote('')
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
  // 用 seq 匹配当前级别，避免数组索引与 seq 不一致（条件过滤/跳过导致）
  const currentStep = snap.find((n: any) => n.seq === currentLevel) || snap[currentLevel - 1]

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

  // 自检风险块渲染（详情 Tab 与审批 Tab 共用，确保审批人无论看哪个 Tab 都能看到风险）
  const renderSelfCheckBlock = (record: any) => {
    if (!record || !record.self_check_result) return null
    let sc: any = record.self_check_result
    if (typeof sc === 'string') { try { sc = JSON.parse(sc) } catch { return null } }
    if (!sc || !sc.checks) return null
    const status = sc.overall_status || 'low'
    const highCount = sc.checks.filter((c: any) => c.risk_level === 'high').length
    const medCount = sc.checks.filter((c: any) => c.risk_level === 'medium').length
    const evidence = (() => {
      try { const e = typeof record.self_check_evidence === 'string' ? JSON.parse(record.self_check_evidence) : (record.self_check_evidence || []); return Array.isArray(e) ? e : [] } catch { return [] }
    })()
    const bgColor = status === 'high' ? '#fef2f2' : status === 'medium' ? '#fffbeb' : '#f0fdf4'
    const borderColor = status === 'high' ? '#fecaca' : status === 'medium' ? '#fde68a' : '#bbf7d0'
    const textColor = status === 'high' ? '#991b1b' : status === 'medium' ? '#92400e' : '#166534'
    const iconColor = status === 'high' ? '#dc2626' : status === 'medium' ? '#d97706' : '#16a34a'
    const icon = status === 'high' ? <WarningOutlined style={{ color: iconColor, fontSize: 18 }} />
      : status === 'medium' ? <ExclamationCircleOutlined style={{ color: iconColor, fontSize: 18 }} />
      : <CheckCircleOutlined style={{ color: iconColor, fontSize: 18 }} />
    const label = status === 'high' ? '自检异常 — 高风险' : status === 'medium' ? '自检异常 — 中风险' : '自检通过'
    return (
      <div style={{ ...sectionStyle, border: `1.5px solid ${borderColor}`, background: bgColor }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          {icon}
          <span style={{ fontSize: 14, fontWeight: 700, color: textColor }}>{label}</span>
          <Tag color={status === 'high' ? 'error' : status === 'medium' ? 'warning' : 'success'}>{sc.summary || '-'}</Tag>
        </div>
        {sc.checks?.filter((c: any) => c.risk_level !== 'low').map((check: any, idx: number) => {
          const risks = check.risks?.filter((rsk: any) => rsk.severity !== 'low') || []
          if (risks.length === 0) return null
          return (
            <div key={idx} style={{ padding: '8px 12px', marginBottom: 8, background: '#fff', borderRadius: 6, border: `1px solid ${status === 'high' ? '#fecaca' : '#fde68a'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <Tag color={check.risk_level === 'high' ? 'red' : 'orange'}>{check.risk_level === 'high' ? '高风险' : '中风险'}</Tag>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{check.material_code} {check.material_name}</span>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#64748b', marginBottom: 4 }}>
                <span>原价: <b>{check.old_price}</b></span>
                <span>新价: <b>{check.new_price}</b></span>
              </div>
              {risks.map((risk: any, ri: number) => (
                <div key={ri} style={{ fontSize: 12, color: risk.severity === 'high' ? '#dc2626' : '#d97706', padding: '1px 0' }}>
                  • [{risk.source === 'erp' ? 'ERP采购' : risk.source === 'surge' ? '涨幅' : '历史比价'}] {risk.detail}
                </div>
              ))}
            </div>
          )
        })}
        {evidence.length > 0 && (
          <div style={{ marginTop: 8, padding: '8px 12px', background: '#fff', borderRadius: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#16a34a', marginBottom: 4 }}>
              <CheckCircleOutlined style={{ fontSize: 12, marginRight: 4 }} />已上传支撑凭证（{evidence.length} 个）
            </div>
            {evidence.map((ev: any, ei: number) => (
              <div key={ei} style={{ fontSize: 12, color: '#334155', padding: '2px 0' }}>
                • {ev.name || '凭证文件'}
                {ev.key && <a onClick={(e) => { e.preventDefault(); downloadAtt(ev.key, ev.name || '凭证') }} style={{ color: '#2563eb', marginLeft: 8, cursor: 'pointer' }}>下载</a>}
              </div>
            ))}
          </div>
        )}
        {record.self_check_action_note && (
          <div style={{ marginTop: 8, padding: '8px 12px', background: '#fff', borderRadius: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 4 }}>行动项说明</div>
            <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.6 }}>{record.self_check_action_note}</div>
          </div>
        )}
        {evidence.length === 0 && status !== 'low' && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>⚠️ 该调价单异常项未上传支撑凭证</div>
        )}
      </div>
    )
  }

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
              <span style={{ fontSize: 12, color: '#64748b' }}>申请人 {r.applicant_display || r.applicant || '-'}</span>
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
            {s === 'pending' && (() => {
              const currentUser = useAuthStore.getState().currentUser
              const canAct = canApproveNode(currentUser, currentStep)
              if (!canAct) return null
              return (
                <>
                  <Input size="small" placeholder="审批意见（可选）" value={comment} onChange={e => setComment(e.target.value)} style={{ width: 200 }} />
                  <Button type="primary" icon={<CheckOutlined />} loading={submitting} onClick={() => act('approve')}>通过</Button>
                  <Button danger icon={<CloseOutlined />} loading={submitting} onClick={() => act('reject')}>驳回</Button>
                </>
              )
            })()}
            {s === 'pending' && (() => {
              // 判断当前用户能否反审核：最后一条 approve/auto_skip log 是当前用户审的（admin 也可）
              const currentUser = useAuthStore.getState().currentUser
              const isAdmin = !!(currentUser && 'role_code' in currentUser && currentUser.role_code === 'admin')
              const myName = (currentUser && 'username' in currentUser) ? currentUser.username : ''
              const approveLogs = logs.filter((l: any) => l.action === 'approve' || l.action === 'auto_skip')
              const lastApproveLog = approveLogs[approveLogs.length - 1]
              const canRevoke = lastApproveLog && (isAdmin || lastApproveLog.approver === myName)
              if (!canRevoke) return null
              return (
                <Button icon={<RollbackOutlined />} onClick={() => act('revoke')} loading={submitting}>撤回审批</Button>
              )
            })()}
          </Space>
        </div>
      </div>

      <Tabs defaultActiveKey="info">
        <Tabs.TabPane tab={<><FileTextOutlined /> 基础资料</>} key="info">
          <div style={sectionStyle}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#0f172a' }}>表单信息</div>
            <Descriptions {...descProps}>
              <Descriptions.Item label="标题">{r.title || '-'}</Descriptions.Item>
              <Descriptions.Item label="申请人">{r.applicant_display || r.applicant || '-'}</Descriptions.Item>
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

          {/* 自检结果摘要 — 显性展示（复用 renderSelfCheckBlock，与审批 Tab 共用） */}
          {renderSelfCheckBlock(r)}

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

            {(() => {
              let eps: any[] = []
              try { eps = typeof r.erp_price_snapshot === 'string' ? JSON.parse(r.erp_price_snapshot || '[]') : (r.erp_price_snapshot || []) } catch { eps = [] }
              if (eps.length === 0) return null
              return (
                <Collapse
                  ghost
                  style={{ marginBottom: 12 }}
                  items={[{
                    key: 'erp',
                    label: <span style={{ fontSize: 13, fontWeight: 600 }}>ERP供应商比价（{eps.length}条，点击展开）</span>,
                    children: (
                      <Table size="small" dataSource={eps} pagination={false} rowKey="supplier_code"
                        columns={[
                          { title: '供应商', dataIndex: 'supplier_name', width: 150 },
                          { title: '单价', dataIndex: 'price', width: 80 },
                          { title: '起订量', dataIndex: 'qty_min', width: 70 },
                          { title: '报价日期', dataIndex: 'start_date', width: 100 },
                        ]} />
                    ),
                  }]}
                />
              )
            })()}

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
          {/* 审批 Tab 顶部复用自检风险块 — 审批人无论看哪个 Tab 都能看到风险 */}
          {renderSelfCheckBlock(r)}
          {r.self_check_result && (() => {
            const sc: any = typeof r.self_check_result === 'string' ? JSON.parse(r.self_check_result) : r.self_check_result
            const ev: any[] = (() => { try { const e = typeof r.self_check_evidence === 'string' ? JSON.parse(r.self_check_evidence) : (r.self_check_evidence || []); return Array.isArray(e) ? e : [] } catch { return [] } })()
            if (sc?.overall_status === 'high' && ev.length === 0) {
              return <Alert type="error" showIcon message="该单为高风险且未上传支撑凭证，请谨慎审批" style={{ marginBottom: 12 }} />
            }
            return null
          })()}
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
                  const approvers = Array.isArray(st.approvers) ? st.approvers : null
                  const desc = approvers
                    ? (approvers.length > 0
                        ? `审批人：${approvers.map((a: any) => a.username || a).join('、')}`
                        : '⚠️ 部门经理解析失败')
                    : (st.role === '__dept_manager__' ? '申请人部门经理' : st.role)
                  return {
                    title: st.label,
                    description: desc,
                    status: rej ? 'error' : app ? 'finish' : i < currentLevel - 1 ? 'finish' : i === currentLevel - 1 ? 'process' : 'wait',
                    icon: rej ? <CloseCircleOutlined /> : app ? <CheckCircleOutlined /> : <ClockCircleOutlined />,
                  }
                })}
              />
            ) : (
              <div style={{ fontSize: 13, color: '#94a3b8' }}>暂无审批流程配置</div>
            )}

            {s === 'pending' && (
              (() => {
                const currentUser = useAuthStore.getState().currentUser
                const canAct = canApproveNode(currentUser, currentStep)
                if (!canAct) {
                  return (
                    <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
                      <div style={{ fontSize: 13, color: '#94a3b8' }}>
                        当前级别需 {currentStep?.approvers?.map((a: any) => a.username).join('、') || `角色 ${currentStep?.role}` || '他人'} 审批，您无权操作
                      </div>
                    </div>
                  )
                }
                return (
                  <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>审批操作</div>
                    <Input.TextArea value={comment} onChange={e => setComment(e.target.value)} placeholder="审批意见（可选）" rows={3} style={{ marginBottom: 12 }} />
                    <Space>
                      <Button type="primary" icon={<CheckOutlined />} loading={submitting} onClick={() => act('approve')}>通过</Button>
                      <Button danger icon={<CloseOutlined />} loading={submitting} onClick={() => act('reject')}>驳回</Button>
                    </Space>
                  </div>
                )
              })()
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
                        <Tag color={log.action === 'reject' ? 'red' : log.action === 'approve' ? 'green' : log.action === 'auto_skip' ? 'purple' : log.action === 'revoked' ? 'orange' : 'blue'}>
                          {log.action === 'submit' ? '提交审批' : log.action === 'approve' ? '已通过' : log.action === 'auto_skip' ? '自动通过(同人)' : log.action === 'revoked' ? '已撤回' : log.action === 'recall' ? '已撤回' : '已驳回'}
                        </Tag>
                        <span style={{ fontSize: 12, color: '#94a3b8' }}>{log.operated_at ? dayjs(log.operated_at).format('YYYY-MM-DD HH:mm') : ''}</span>
                      </div>
                      {log.comment && <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>{log.comment}</div>}
                    </div>
                  ),
                }))}
              />
            )}
          </div>
        </Tabs.TabPane>
      </Tabs>
      {/* 提交弹窗（自检高风险时上传凭证+行动项说明） */}
      <Modal title={null} open={scModal} width={640} onCancel={closeScModal}
        footer={
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              {scResult?.overall_status === 'high' ? '高风险项必须上传支撑凭证+填写说明才能提交' : '中风险项建议上传凭证说明'}
            </div>
            <Space>
              <Button onClick={closeScModal}>取消</Button>
              <Button type="primary" icon={<SendOutlined />} loading={scSaving}
                disabled={scResult?.overall_status === 'high' && (scEvidence.length === 0 && scEvidenceFiles.length === 0 || scActionNote.trim().length < 10)}
                onClick={submitWithEvidence}>确认提交</Button>
            </Space>
          </Space>
        }>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            {scResult?.overall_status === 'high'
              ? <WarningOutlined style={{ fontSize: 22, color: '#dc2626' }} />
              : <ExclamationCircleOutlined style={{ fontSize: 22, color: '#d97706' }} />}
            <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>价格自检异常</span>
            <Tag color={scResult?.overall_status === 'high' ? 'red' : 'orange'}>
              {scResult?.overall_status === 'high' ? '高风险' : '中风险'}
            </Tag>
          </div>
          {scResult?.summary && (
            <div style={{ background: scResult?.overall_status === 'high' ? '#fef2f2' : '#fffbeb', borderRadius: 6, padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: scResult?.overall_status === 'high' ? '#7f1d1d' : '#78350f' }}>{scResult.summary}</div>
            </div>
          )}
          <Divider style={{ margin: '12px 0' }} />
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 4 }}>
              行动项说明 {scResult?.overall_status === 'high' ? <span style={{ color: '#dc2626' }}>（必填，≥10字）</span> : <span style={{ color: '#d97706' }}>（建议填写）</span>}
            </div>
            <Input.TextArea rows={3} value={scActionNote} onChange={(e) => setScActionNote(e.target.value)}
              placeholder="请说明涨价原因、已采取的行动项。高风险必填，至少10字" />
            {scResult?.overall_status === 'high' && scActionNote.trim().length < 10 && (
              <div style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}>高风险需填写至少 10 字行动项说明</div>
            )}
          </div>
          <Divider style={{ margin: '12px 0' }} />
          <div style={{ marginBottom: 8 }} onPaste={(e) => {
            const items = e.clipboardData?.items
            if (!items) return
            for (const item of items) {
              if (item.type.startsWith('image/')) {
                const file = item.getAsFile()
                if (file) {
                  const uid = Date.now().toString()
                  setScEvidenceFiles(prev => [...prev, { uid, name: `截图_${uid}.png`, status: 'done', originFileObj: file, url: URL.createObjectURL(file) } as any])
                }
                break
              }
            }
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 4 }}>
              支撑凭证 {scResult?.overall_status === 'high' ? <span style={{ color: '#dc2626' }}>（必填）</span> : <span style={{ color: '#d97706' }}>（建议上传）</span>}
            </div>
            <Upload fileList={scEvidenceFiles} onChange={({fileList: fl}) => setScEvidenceFiles(fl)}
              beforeUpload={() => false} multiple
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
              showUploadList={{ showPreviewIcon: true, showRemoveIcon: true }}
              onPreview={(file) => setPreviewFile({ url: file.url || URL.createObjectURL(file.originFileObj as File), name: file.name })}>
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>支持 PDF、图片、Word、Excel，也可直接截图 Ctrl+V 粘贴上传</div>
          </div>
          {scEvidence.length > 0 && (
            <div style={{ marginTop: 8, background: '#f0fdf4', borderRadius: 6, padding: '6px 12px' }}>
              {scEvidence.map((f: any, i: number) => (
                <span key={i} style={{ display: 'inline-block', fontSize: 12, color: '#334155', marginRight: 8, background: '#fff', padding: '2px 8px', borderRadius: 4, border: '1px solid #d9d9d9' }}>
                  {f.name} <a onClick={() => setScEvidence(scEvidence.filter((_: any, j: number) => j !== i))} style={{ color: '#ef4444', marginLeft: 4 }}>x</a>
                </span>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* 凭证预览弹窗 */}
      <Modal title={previewFile?.name || '预览'} open={!!previewFile} onCancel={() => setPreviewFile(null)} width={700} footer={null}>
        {previewFile?.url && (
          <div style={{ textAlign: 'center' }}>
            <img src={previewFile.url} alt={previewFile.name} style={{ maxWidth: '100%', maxHeight: '70vh' }} />
          </div>
        )}
      </Modal>
    </div>
  )
}
