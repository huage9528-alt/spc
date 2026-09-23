import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Select, Space, Table, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { approvalApi, type ApprovalItem, type ApprovalStats } from '../../../services/approval'
import ApprovalStatsCards from '../../../components/ApprovalStatsCards'
import ApprovalDrawer from '../../../components/ApprovalDrawer'

export default function MyApprovedTab() {
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [stats, setStats] = useState<ApprovalStats>({})
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [action, setAction] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [drawer, setDrawer] = useState<{ bizType: string; id: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await approvalApi.approved({ page, page_size: 20, keyword: keyword || undefined, action })
      setItems(res.data?.items || [])
      setTotal(res.data?.total || 0)
      setStats(res.data?.stats || {})
    } catch { /* 全局拦截器已提示 */ } finally { setLoading(false) }
  }, [keyword, action, page])
  useEffect(() => { load() }, [load])

  return (
    <Card>
      <ApprovalStatsCards cards={[
        { key: 'processed', label: '已处理', value: stats.processed ?? 0, hint: '默认近 90 天' },
        { key: 'passed', label: '通过', value: stats.passed ?? 0, tone: 'success' },
        { key: 'rejected', label: '驳回', value: stats.rejected ?? 0, tone: 'danger' },
        { key: 'avg', label: '平均处理时长', value: stats.avg_hours ?? '-', hint: '小时（提交→审批）' },
      ]} />
      <Space style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="单号 / 标题 / 申请人" style={{ width: 240 }}
          onSearch={v => { setPage(1); setKeyword(v) }} />
        <Select allowClear placeholder="我的动作" style={{ width: 140 }} value={action}
          onChange={v => { setPage(1); setAction(v) }}
          options={[{ value: 'approve', label: '通过' }, { value: 'reject', label: '驳回' }]} />
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </Space>
      <Table<ApprovalItem> rowKey={r => `${r.biz_type}-${r.id}`} loading={loading} dataSource={items}
        scroll={{ x: 1200 }} locale={{ emptyText: '暂无审批记录' }}
        pagination={{
          current: page, pageSize: 20, total, showSizeChanger: false,
          showTotal: t => `共 ${t} 条`, onChange: setPage,
        }}
        columns={[
          { title: '业务类型', width: 130, render: (_: any, r: ApprovalItem) => <Tag color="blue">{r.biz_name}</Tag> },
          { title: '单号', width: 170, render: (_: any, r: ApprovalItem) => <span style={{ fontFamily: 'monospace' }}>{r.no}</span> },
          { title: '标题', dataIndex: 'title', ellipsis: true },
          { title: '申请人', dataIndex: 'applicant', width: 100 },
          { title: '我的动作', width: 90, render: (_: any, r: ApprovalItem) => (
            <Tag color={r.my_action === 'approve' ? 'green' : 'red'}>{r.my_action === 'approve' ? '通过' : '驳回'}</Tag>
          ) },
          { title: '我的意见', dataIndex: 'my_comment', ellipsis: true, render: (v?: string) => v || '-' },
          { title: '审批时间', width: 150, render: (_: any, r: ApprovalItem) => r.acted_at ? dayjs(r.acted_at).format('YYYY-MM-DD HH:mm') : '-' },
          { title: '单据状态', width: 100, render: (_: any, r: ApprovalItem) => <Tag>{r.status || '-'}</Tag> },
          { title: '操作', width: 80, fixed: 'right', render: (_: any, r: ApprovalItem) => (
            <Button size="small" type="link" onClick={() => setDrawer({ bizType: r.biz_type, id: r.id })}>查看</Button>
          ) },
        ]} />
      <ApprovalDrawer open={!!drawer} bizType={drawer?.bizType} itemId={drawer?.id}
        onClose={() => setDrawer(null)} onDone={load} />
    </Card>
  )
}
