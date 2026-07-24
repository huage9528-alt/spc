import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Space, Table, Tabs, Tag, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { purchaseApi } from '../../../services/purchase'
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

  useEffect(() => { load() }, [tab])

  const pendingCount = data.length
  const highRiskCount = data.filter((row) => row.ai_summary?.ai_risk_level === 'high').length
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
          dataSource={data}
          loading={loading}
          size="small"
          pagination={false}
          scroll={{ x: 1180 }}
          columns={[
            {
              title: '任务',
              width: 280,
              render: (_: any, row: any) => (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{row.change_no}</span>
                    <Tag color={row.price_direction === '涨价' ? 'red' : row.price_direction === '降价' ? 'green' : 'blue'}>{row.price_direction || '-'}</Tag>
                  </div>
                  <div style={{ fontSize: 14, color: '#0f172a', fontWeight: 600, marginBottom: 4 }}>{row.supplier_name || '-'}</div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>{row.title || '未填写标题'}</div>
                </div>
              ),
            },
            { title: '类型', dataIndex: 'price_direction', width: 80, render: (v: string) => v ? <Tag color={v === '涨价' ? 'red' : 'green'}>{v}</Tag> : '-' },
            {
              title: '当前节点',
              width: 170,
              render: (_: any, row: any) => {
                const snap = row.approval_snapshot || []
                const currentNode = snap[(row.approval_level || 1) - 1]
                return (
                  <div>
                    <div style={{ fontWeight: 600, color: '#0f172a' }}>{currentNode?.label || `第${row.approval_level || 1}级`}</div>
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{currentNode?.role || '未配置角色'}</div>
                  </div>
                )
              },
            },
            { title: '申请人', dataIndex: 'applicant_display', width: 100,
              render: (_: any, row: any) => row.applicant_display || row.applicant || '-',
            },
            {
              title: '提交时间',
              width: 160,
              render: (_: any, row: any) => (
                <div>
                  <div style={{ color: '#0f172a' }}>{row.submitted_at ? dayjs(row.submitted_at).format('MM-DD HH:mm') : '-'}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{getElapsedText(row.submitted_at)}</div>
                </div>
              ),
            },
            {
              title: 'AI 判断',
              width: 240,
              render: (_: any, row: any) => {
                const aiMeta = getAiMeta(row.ai_summary)
                return (
                  <div>
                    <Tag color={aiMeta.color}>{aiMeta.label}</Tag>
                    <div style={{ marginTop: 6, fontSize: 12, color: '#475569', lineHeight: 1.6 }}>{aiMeta.text}</div>
                  </div>
                )
              },
            },
            {
              title: '操作', width: 140,
              render: (_: any, row: any) => (
                <Space>
                  <Button size="small" onClick={() => navigate(`/purchase/price-change/${row.id}`)}>查看</Button>
                  {tab === 'pending' && <Button size="small" type="primary" onClick={() => navigate(`/purchase/price-change/${row.id}`)}>审批</Button>}
                </Space>
              ),
            },
          ]}
          expandable={{
            expandedRowRender: (row: any) => {
              const ai = getAiMeta(row.ai_summary)
              const snap = row.approval_snapshot || []
              const currentNode = snap[(row.approval_level || 1) - 1]
              return (
                <div style={{ padding: '8px 0', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 220 }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>审批提示</div>
                    <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.7 }}>
                      当前单据由 <strong>{currentNode?.label || `第${row.approval_level || 1}级`}</strong> 处理，
                      提交人 <strong>{row.applicant_display || row.applicant || '-'}</strong>。
                    </div>
                  </div>
                  <div style={{ minWidth: 320 }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>AI 摘要</div>
                    <Tag color={ai.color}>{ai.label}</Tag>
                    <div style={{ marginTop: 8, fontSize: 13, color: '#334155', lineHeight: 1.7 }}>{ai.text}</div>
                  </div>
                </div>
              )
            },
          }}
        />
      </div>
    </div>
  )
}
