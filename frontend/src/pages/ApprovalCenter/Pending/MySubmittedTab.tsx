import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Select, Space, Table, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { approvalApi, type ApprovalItem, type ApprovalStats } from '../../../services/approval'
import ApprovalStatsCards from '../../../components/ApprovalStatsCards'
import ApprovalDrawer from '../../../components/ApprovalDrawer'

const STATUS_TEXT: Record<string, string> = { pending: '审批中', approved: '已通过', rejected: '已驳回', recalled: '已撤回' }
const STATUS_COLOR: Record<string, string> = { pending: 'blue', approved: 'green', rejected: 'red', recalled: 'default' }

export default function MySubmittedTab() {
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [stats, setStats] = useState<ApprovalStats>({})
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [drawer, setDrawer] = useState<{ bizType: string; id: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await approvalApi.submitted({ page, page_size: 20, keyword: keyword || undefined, status })
      setItems(res.data?.items || [])
      setTotal(res.data?.total || 0)
      setStats(res.data?.stats || {})
    } catch { /* 全局拦截器已提示 */ } finally { setLoading(false) }
  }, [keyword, status, page])
  useEffect(() => { load() }, [load])

  return (
    <Card>
      <ApprovalStatsCards cards={[
        { key: 'pending', label: '审批中', value: stats.pending ?? 0, tone: 'info' },
        { key: 'approved', label: '已通过', value: stats.approved ?? 0, tone: 'success' },
        { key: 'rejected', label: '已驳回', value: stats.rejected ?? 0, tone: 'danger' },
        { key: 'recalled', label: '已撤回', value: stats.recalled ?? 0 },
      ]} />
      <Space style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="单号 / 标题" style={{ width: 240 }}
          onSearch={v => { setPage(1); setKeyword(v) }} />
        <Select allowClear placeholder="整体状态" style={{ width: 140 }} value={status}
          onChange={v => { setPage(1); setStatus(v) }}
          options={Object.entries(STATUS_TEXT).map(([value, label]) => ({ value, label }))} />
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </Space>
      <Table<ApprovalItem> rowKey={r => `${r.biz_type}-${r.id}`} loading={loading} dataSource={items}
        scroll={{ x: 1100 }} locale={{ emptyText: '暂无我发起的单据' }}
        pagination={{
          current: page, pageSize: 20, total, showSizeChanger: false,
          showTotal: t => `共 ${t} 条`, onChange: setPage,
        }}
        columns={[
          { title: '业务类型', width: 130, render: (_: any, r: ApprovalItem) => <Tag color="blue">{r.biz_name}</Tag> },
          { title: '单号', width: 170, render: (_: any, r: ApprovalItem) => <span style={{ fontFamily: 'monospace' }}>{r.no}</span> },
          { title: '标题', dataIndex: 'title', ellipsis: true },
          { title: '提交时间', width: 150, render: (_: any, r: ApprovalItem) => r.submitted_at ? dayjs(r.submitted_at).format('YYYY-MM-DD HH:mm') : '-' },
          { title: '当前节点', width: 130, render: (_: any, r: ApprovalItem) => r.current_node || '-' },
          { title: '整体状态', width: 100, render: (_: any, r: ApprovalItem) => (
            <Tag color={STATUS_COLOR[r.status || '']}>{STATUS_TEXT[r.status || ''] || r.status}</Tag>
          ) },
          { title: '操作', width: 110, fixed: 'right', render: (_: any, r: ApprovalItem) => (
            <Space size={0}>
              <Button size="small" type="link" onClick={() => setDrawer({ bizType: r.biz_type, id: r.id })}>查看</Button>
              {r.can_recall ? <Button size="small" type="link" danger onClick={() => window.open(r.deep_link, '_self')}>撤回</Button> : null}
            </Space>
          ) },
        ]} />
      <ApprovalDrawer open={!!drawer} bizType={drawer?.bizType} itemId={drawer?.id}
        onClose={() => setDrawer(null)} onDone={load} />
    </Card>
  )
}
