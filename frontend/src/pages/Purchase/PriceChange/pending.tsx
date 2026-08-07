import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Input, Modal, Space, Table, Tabs, Tag, message } from 'antd'
import { ReloadOutlined, DownloadOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { purchaseApi } from '../../../services/purchase'
import { useAuthStore } from '../../../store/auth'
import axios from 'axios'
import dayjs from 'dayjs'

export default function PriceChangePending() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'pending' | 'approved'>('pending')
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res: any = tab === 'pending'
        ? await purchaseApi.pending()
        : await purchaseApi.myApproved({ page: 1, page_size: 50 })
      const payload = res.data
      setData(Array.isArray(payload) ? payload : (payload?.items || []))
    } catch (e: any) {
      message.error(e.message || '加载失败')
    } finally {
      setLoading(false)
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
      a.href = url; a.download = name; a.click()
      window.URL.revokeObjectURL(url)
    } catch { message.warning('下载失败') }
  }

  // 预览：走带鉴权的 preview 接口
  const openPreview = async (f: any) => {
    try {
      if (f.url && f.url.startsWith('blob:')) {
        setPreviewFile({ url: f.url, name: f.name || '预览' })
        return
      }
      if (!f.key) {
        if (f.url) setPreviewFile({ url: f.url, name: f.name || '预览' })
        return
      }
      const token = useAuthStore.getState().currentToken
      const res = await axios.get(`/api/v1/files/preview/${f.key}`, {
        responseType: 'blob',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const url = window.URL.createObjectURL(new Blob([res.data]))
      setPreviewFile({ url, name: f.name || '预览' })
    } catch { message.warning('预览失败') }
  }

  const [previewFile, setPreviewFile] = useState<{ url: string; name: string } | null>(null)

  const getEvidenceItems = (row: any): any[] => {
    try {
      const e = typeof row.self_check_evidence === 'string'
        ? JSON.parse(row.self_check_evidence) : (row.self_check_evidence || [])
      return Array.isArray(e) ? e : []
    } catch { return [] }
  }

  // 判断当前用户能否审批当前行
  const canApproveRow = (row: any): boolean => {
    const user = useAuthStore.getState().currentUser
    if (!user) return false
    if ('role_code' in user && user.role_code === 'admin') return true
    const snap = row.approval_snapshot || []
    const node = snap[(row.approval_level || 1) - 1]
    if (!node) return false
    const approvers = node.approvers
    if (Array.isArray(approvers)) {
      return approvers.some((a: any) => a.username === (user as any).username || String(a.user_id) === String((user as any).id))
    }
    const role = node.role
    if (role && role !== '__dept_manager__') {
      return 'role_code' in user && (user as any).role_code === role
    }
    return false
  }

  const actInline = async (row: any, action: 'approve' | 'reject') => {
    try {
      if (action === 'approve') await purchaseApi.approve(row.id, '', row.version)
      else await purchaseApi.reject(row.id, '', row.version)
      message.success(action === 'approve' ? '已通过' : '已驳回')
      load()
    } catch (e: any) {
      message.error(e.message || '操作失败')
    }
  }

  useEffect(() => { load() }, [tab])

  const pendingCount = data.length
  const getRowStatus = (row: any): string => {
    let st = 'low'
    try {
      const sc: any = row.self_check_result
      st = (typeof sc === 'string' ? JSON.parse(sc) : sc)?.overall_status || row.self_check_status || 'low'
    } catch { st = row.self_check_status || 'low' }
    return st
  }
  const riskRank = (st: string) => (st === 'high' ? 2 : st === 'medium' ? 1 : 0)
  // 待审批 tab：高风险置顶
  const sortedData = tab === 'pending'
    ? [...data].sort((a, b) => riskRank(getRowStatus(b)) - riskRank(getRowStatus(a)))
    : data
  const highRiskCount = tab === 'pending' ? data.filter((row) => getRowStatus(row) === 'high').length : 0
  const todayCount = data.filter((row) => row.submitted_at && dayjs(row.submitted_at).isSame(dayjs(), 'day')).length

  const getAiMeta = (ai: any) => {
    if (!ai) return { color: 'default', label: '未分析', text: '暂无 AI 分析' }
    if (ai.ai_status === 'error') return { color: 'red', label: '分析失败', text: ai.ai_error_msg || 'AI 分析失败，但不影响审批' }
    if (ai.ai_status === 'pending' || ai.ai_status === 'analyzing') return { color: 'blue', label: '分析中', text: 'AI 正在生成价格判断' }
    return {
      color: ai.ai_risk_level === 'high' ? 'red' : ai.ai_risk_level === 'medium' ? 'orange' : 'green',
      label: ai.ai_risk_level === 'high' ? '高风险' : ai.ai_risk_level === 'medium' ? '中风险' : '低风险',
      text: ai.ai_conclusion || '已生成 AI 分析',
    }
  }

  const getElapsedText = (submittedAt?: string) => {
    if (!submittedAt) return '-'
    const submitted = dayjs(submittedAt)
    const hours = dayjs().diff(submitted, 'hour')
    if (hours < 1) {
      const minutes = Math.max(dayjs().diff(submitted, 'minute'), 1)
      return `${minutes} 分钟前`
    }
    if (hours < 24) return `${hours} 小时前`
    return `${dayjs().diff(submitted, 'day')} 天前`
  }

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>待我审批 · 调价单</div>
            <div style={{ marginTop: 6, color: '#64748b', fontSize: 12 }}>按任务优先级查看待审批单，先看风险和当前节点，再进入详情处理。</div>
          </div>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </div>
      </div>
      {tab === 'pending' && highRiskCount > 0 && (
        <Alert type="error" showIcon banner
          message={`当前有 ${highRiskCount} 条高风险调价单待您审批，请优先处理（已自动置顶）`}
          style={{ marginBottom: 16 }} />
      )}
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            { label: '待审批总数', value: `${pendingCount} 条`, color: '#2563eb' },
            { label: '高风险', value: `${highRiskCount} 条`, color: '#dc2626' },
            { label: '今日提交', value: `${todayCount} 条`, color: '#0f766e' },
          ].map((item) => (
            <div key={item.label} style={{ minWidth: 180, flex: '1 1 180px', padding: '10px 12px', borderRadius: 8, background: '#f8fafc' }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>{item.label}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: item.color }}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Tabs activeKey={tab} onChange={(k) => setTab(k as 'pending' | 'approved')} style={{ paddingLeft: 16 }} items={[
          { key: 'pending', label: `待我审批 (${pendingCount})` },
          { key: 'approved', label: '我已审批' },
        ]} />
        <Table
          rowKey="id"
          dataSource={sortedData}
          loading={loading}
          size="small"
          pagination={false}
          scroll={{ x: 1400 }}
          rowClassName={(row: any) => getRowStatus(row) === 'high' ? 'pc-pending-risk-high' : ''}
          columns={[
            {
              title: '任务',
              width: 200,
              render: (_: any, row: any) => (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{row.change_no}</span>
                    <Tag color={row.price_direction === '涨价' ? 'red' : row.price_direction === '降价' ? 'green' : 'blue'}>{row.price_direction || '-'}</Tag>
                  </div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>{row.title || '未填写标题'}</div>
                </div>
              ),
            },
            { title: '供应商', dataIndex: 'supplier_name', width: 130, ellipsis: true },
            { title: '申请人', dataIndex: 'applicant_display', width: 90,
              render: (_: any, row: any) => row.applicant_display || row.applicant || '-',
            },
            {
              title: '物料',
              width: 180,
              render: (_: any, row: any) => {
                try {
                  const checks = row.self_check_result?.checks || []
                  return (
                    <div>
                      {checks.map((c: any, i: number) => (
                        <div key={i} style={{ fontSize: 12, lineHeight: 1.8, color: '#334155' }}>
                          <Tag style={{ fontSize: 10 }}>{c.material_code}</Tag>
                          <span>{c.material_name}</span>
                        </div>
                      ))}
                      {checks.length === 0 && <span style={{ color: '#94a3b8' }}>-</span>}
                    </div>
                  )
                } catch { return <span style={{ color: '#94a3b8' }}>-</span> }
              },
            },
            {
              title: '涨幅',
              width: 90,
              render: (_: any, row: any) => {
                let maxPct: number = NaN
                try {
                  const checks = row.self_check_result?.checks || []
                  checks.forEach((c: any) => {
                    const o = parseFloat(c.old_price), n = parseFloat(c.new_price)
                    if (o && n && o !== 0) { const p = ((n / o) - 1) * 100; if (isNaN(maxPct) || p > maxPct) maxPct = p }
                  })
                } catch {}
                return !isNaN(maxPct)
                  ? <span style={{ color: maxPct > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{maxPct > 0 ? '+' : ''}{maxPct.toFixed(1)}%</span>
                  : <span style={{ color: '#94a3b8' }}>-</span>
              },
            },
            {
              title: '自检',
              width: 100,
              render: (_: any, row: any) => {
                const status = getRowStatus(row)
                const ev = getEvidenceItems(row)
                const colorMap: Record<string, string> = { high: 'red', medium: 'orange', low: 'green', pending: 'default' }
                const labelMap: Record<string, string> = { high: '高风险', medium: '中风险', low: '通过', pending: '未检' }
                return (
                  <div>
                    <Tag color={colorMap[status] || 'default'}>{labelMap[status] || '-'}</Tag>
                    {ev.length > 0 && <Tag color="green" style={{ marginLeft: 2 }}>凭证{ev.length}</Tag>}
                  </div>
                )
              },
            },
            {
              title: '凭证',
              width: 120,
              render: (_: any, row: any) => {
                const ev = getEvidenceItems(row)
                if (ev.length === 0) return <span style={{ color: '#94a3b8' }}>-</span>
                return (
                  <Space size={2} wrap>
                    {ev.slice(0, 3).map((f: any, i: number) => (
                      <Button key={i} size="small" type="link" icon={<DownloadOutlined />}
                        onClick={() => {
                          if (f.url && (f.url.match(/\.(png|jpg|jpeg|gif|webp)$/i) || /\.pdf$/i.test(f.name || ''))) {
                            openPreview(f)
                          } else if (f.key) {
                            downloadAtt(f.key, f.name || '凭证')
                          }
                        }}
                        style={{ fontSize: 11, padding: 0 }}>
                        {f.name?.length > 8 ? f.name.slice(0, 8) + '..' : (f.name || '文件')}
                      </Button>
                    ))}
                    {ev.length > 3 && <span style={{ fontSize: 11, color: '#94a3b8' }}>+{ev.length - 3}</span>}
                  </Space>
                )
              },
            },
            {
              title: '提交时间',
              width: 150,
              render: (_: any, row: any) => (
                <div>
                  <div style={{ color: '#0f172a' }}>{row.submitted_at ? dayjs(row.submitted_at).format('MM-DD HH:mm') : '-'}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{getElapsedText(row.submitted_at)}</div>
                </div>
              ),
            },
            {
              title: '操作', width: 180, fixed: 'right',
              render: (_: any, row: any) => (
                <Space size={2}>
                  <Button size="small" onClick={() => navigate(`/purchase/price-change/${row.id}`)}>查看</Button>
                  {tab === 'pending' && canApproveRow(row) && (
                    <>
                      <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => actInline(row, 'approve')}>通过</Button>
                      <Button size="small" danger icon={<CloseOutlined />} onClick={() => actInline(row, 'reject')}>驳回</Button>
                    </>
                  )}
                  {tab === 'pending' && !canApproveRow(row) && (
                    <Button size="small" type="primary" onClick={() => navigate(`/purchase/price-change/${row.id}`)}>审批</Button>
                  )}
                </Space>
              ),
            },
          ]}
          expandable={{
            expandedRowRender: (row: any) => {
              const snap = row.approval_snapshot || []
              const currentNode = snap[(row.approval_level || 1) - 1]
              const checks = row.self_check_result?.checks || []
              return (
                <div style={{ padding: '8px 0', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 200 }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>审批提示</div>
                    <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.7 }}>
                      当前单据由 <strong>{currentNode?.label || `第${row.approval_level || 1}级`}</strong> 处理
                    </div>
                  </div>
                  <div style={{ minWidth: 200 }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>自检明细</div>
                    {checks.map((c: any, i: number) => (
                      <div key={i} style={{ fontSize: 12, color: '#334155', lineHeight: 1.7 }}>
                        <Tag color={c.risk_level === 'high' ? 'red' : c.risk_level === 'medium' ? 'orange' : 'green'}>{c.material_code}</Tag>
                        {c.material_name} | {c.old_price}→{c.new_price}
                      </div>
                    ))}
                    {checks.length === 0 && <span style={{ color: '#94a3b8' }}>无自检数据</span>}
                  </div>
                </div>
              )
            },
          }}
        />
      </div>

      {/* 凭证预览 */}
      <Modal title={previewFile?.name || '凭证预览'} open={!!previewFile} onCancel={() => setPreviewFile(null)} width={800} footer={null}>
        {previewFile?.url && (() => {
          const isPdf = /\.pdf$/i.test(previewFile.name || '')
          return isPdf ? (
            <iframe src={previewFile.url} title={previewFile.name} style={{ width: '100%', height: '70vh', border: 'none' }} />
          ) : (
            <div style={{ textAlign: 'center' }}>
              <img src={previewFile.url} alt={previewFile.name} style={{ maxWidth: '100%', maxHeight: '70vh' }} />
            </div>
          )
        })()}
      </Modal>
      <style>{`.pc-pending-risk-high > td{background:#fef2f2 !important}.pc-pending-risk-high:hover > td{background:#fee2e2 !important}`}</style>
    </div>
  )
}
