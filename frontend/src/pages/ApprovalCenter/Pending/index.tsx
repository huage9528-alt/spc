import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Input, Modal, Space, Table, Tabs, Tag, message } from 'antd'
import { CheckOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { approvalApi, type ApprovalItem, type ApprovalStats } from '../../../services/approval'
import ApprovalStatsCards from '../../../components/ApprovalStatsCards'
import ApprovalDrawer from '../../../components/ApprovalDrawer'
import MyApprovedTab from './MyApprovedTab'
import MySubmittedTab from './MySubmittedTab'

const WAIT_TAG: Record<string, { color: string; text: (h?: number | null) => string }> = {
  overdue: { color: 'red', text: h => `${h} 小时 · 已超时` },
  soon: { color: 'orange', text: h => `${h} 小时 · 即将超时` },
  normal: { color: 'default', text: h => (h == null ? '-' : `${h} 小时`) },
}

function PendingTab() {
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [stats, setStats] = useState<ApprovalStats>({})
  const [bizNames, setBizNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [bizType, setBizType] = useState<string | undefined>(undefined)
  const [selected, setSelected] = useState<ApprovalItem[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchComment, setBatchComment] = useState('')
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [quickTarget, setQuickTarget] = useState<ApprovalItem | null>(null)
  const [quickComment, setQuickComment] = useState('')
  const [quickSubmitting, setQuickSubmitting] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [waitLevel, setWaitLevel] = useState<'soon' | 'overdue' | undefined>(undefined)
  const [todayOnly, setTodayOnly] = useState(false)
  const [drawer, setDrawer] = useState<{ bizType: string; id: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await approvalApi.pending({
        page, page_size: 20, keyword: keyword || undefined,
        biz_type: bizType, wait_level: waitLevel, today_only: todayOnly || undefined,
      })
      const list: ApprovalItem[] = res.data?.items || []
      const nextTotal = res.data?.total || 0
      // 末页条目被审批完后退回上一页，避免停在空白页
      if (page > 1 && list.length === 0 && nextTotal > 0) { setPage(page - 1); return }
      setItems(list)
      setTotal(nextTotal)
      setStats(res.data?.stats || {})
      // 业务名称只随条目返回，按业务筛选后其它业务的名称取不到，故累积；计数始终用全局 stats.by_biz
      setBizNames(prev => {
        const next = { ...prev }
        list.forEach(it => { next[it.biz_type] = it.biz_name || it.biz_type })
        return next
      })
      setSelected([])
    } catch { /* 全局拦截器已提示 */ } finally { setLoading(false) }
  }, [keyword, bizType, waitLevel, todayOnly, page])
  useEffect(() => { load() }, [load])

  const bizOptions = Object.entries(stats.by_biz || {}).map(([value, count]) => ({
    value, label: `${bizNames[value] || value} (${count})`,
  }))

  const hasFilter = !!keyword || !!bizType || !!waitLevel || todayOnly
  const pickCard = (next: 'today' | 'soon' | 'overdue') => {
    setPage(1)
    if (next === 'today') { setTodayOnly(v => !v); setWaitLevel(undefined); return }
    setTodayOnly(false)
    setWaitLevel(v => (v === next ? undefined : next))
  }

  const submitBatch = async () => {
    setBatchSubmitting(true)
    try {
      const res: any = await approvalApi.batchApprove({
        items: selected.map(r => ({ biz_type: r.biz_type, id: r.id, expected_version: r.version })),
        comment: batchComment.trim() || undefined,
      })
      const { passed = [], failed = [], skipped = [] } = res.data || {}
      const rowKey = (x: any) => `${x.biz_type}-${x.id}`
      Modal.info({
        title: '批量审批结果',
        width: 520,
        content: (
          <div style={{ fontSize: 12 }}>
            <div style={{ marginBottom: 6 }}>通过 {passed.length} 条 · 失败 {failed.length} 条 · 跳过 {skipped.length} 条</div>
            {passed.map((p: any) => (
              <div key={rowKey(p)} style={{ color: '#16a34a' }}>
                {p.biz_type} #{p.id}：已通过{p.finished ? '（单据已归档）' : ''}
              </div>
            ))}
            {failed.map((f: any) => (
              <div key={rowKey(f)} style={{ color: '#dc2626' }}>{f.biz_type} #{f.id}：{f.reason}</div>
            ))}
            {skipped.map((s: any) => (
              <div key={rowKey(s)} style={{ color: '#94a3b8' }}>{s.biz_type} #{s.id}：{s.reason}</div>
            ))}
            {failed.length + skipped.length > 0 ? (
              <div style={{ color: '#94a3b8', marginTop: 6 }}>失败与跳过的单据仍保留在待办列表中。</div>
            ) : null}
          </div>
        ),
      })
      setBatchOpen(false)
      setBatchComment('')
      load()
    } catch { /* 全局拦截器已提示 */ } finally { setBatchSubmitting(false) }
  }

  const submitQuick = async () => {
    if (!quickTarget) return
    setQuickSubmitting(true)
    try {
      const res: any = await approvalApi.approve(quickTarget.biz_type, quickTarget.id, {
        comment: quickComment.trim() || undefined, expected_version: quickTarget.version,
      })
      message.success(res.message || '已通过')
      setQuickTarget(null)
      setQuickComment('')
      load()
    } catch { /* 全局拦截器已提示 */ } finally { setQuickSubmitting(false) }
  }

  return (
    <>
      <ApprovalStatsCards
        cards={[
          { key: 'total', label: '待我审批', value: stats.total ?? 0, hint: '点击清除筛选',
            active: !hasFilter,
            onClick: () => { setPage(1); setWaitLevel(undefined); setTodayOnly(false); setKeyword(''); setBizType(undefined) } },
          { key: 'today', label: '今日新增', value: stats.today ?? 0, tone: 'info', hint: '点击只看今日提交',
            active: todayOnly, onClick: () => pickCard('today') },
          { key: 'soon', label: '即将超时', value: stats.soon ?? 0, tone: 'warning', hint: '已等待超过阈值一半 · 点击筛选',
            active: waitLevel === 'soon', onClick: () => pickCard('soon') },
          { key: 'overdue', label: '已超时', value: stats.overdue ?? 0, tone: 'danger', hint: '点击筛选',
            active: waitLevel === 'overdue', onClick: () => pickCard('overdue') },
        ]}
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search allowClear placeholder="单号 / 标题 / 申请人" style={{ width: 240 }}
          onSearch={v => { setPage(1); setKeyword(v) }} />
        <Tag.CheckableTag checked={!bizType} onChange={() => { setPage(1); setBizType(undefined) }}>全部</Tag.CheckableTag>
        {bizOptions.map(o => (
          <Tag.CheckableTag key={o.value} checked={bizType === o.value}
            onChange={checked => { setPage(1); setBizType(checked ? o.value : undefined) }}>
            {o.label}
          </Tag.CheckableTag>
        ))}
        <Tag.CheckableTag checked={waitLevel === 'overdue'}
          onChange={checked => { setPage(1); setWaitLevel(checked ? 'overdue' : undefined) }}>仅看超时</Tag.CheckableTag>
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        {selected.length > 0 ? (
          <Button type="primary" icon={<CheckOutlined />} onClick={() => setBatchOpen(true)}>
            批量通过（{selected.length}）
          </Button>
        ) : null}
      </Space>
      <Table<ApprovalItem>
        rowKey={r => `${r.biz_type}-${r.id}`} loading={loading} dataSource={items} scroll={{ x: 1200 }}
        locale={{ emptyText: hasFilter ? '没有符合筛选条件的待办' : '没有待你审批的单据' }}
        onRow={r => ({
          style: { cursor: 'pointer' },
          onClick: e => {
            const el = e.target as HTMLElement
            if (el.closest('input,button,a,label')) return
            setDrawer({ bizType: r.biz_type, id: r.id })
          },
        })}
        rowSelection={{ selectedRowKeys: selected.map(r => `${r.biz_type}-${r.id}`), onChange: (_k, rows) => setSelected(rows) }}
        pagination={{
          current: page, pageSize: 20, total, showSizeChanger: false,
          showTotal: t => `共 ${t} 条`, onChange: setPage,
        }}
        columns={[
          { title: '业务类型', width: 130, render: (_: any, r: ApprovalItem) => <Tag color="blue">{r.biz_name}</Tag> },
          { title: '单号', width: 170, render: (_: any, r: ApprovalItem) => (
            <a style={{ fontFamily: 'monospace', fontWeight: 600 }} onClick={() => setDrawer({ bizType: r.biz_type, id: r.id })}>{r.no}</a>
          ) },
          { title: '标题', dataIndex: 'title', ellipsis: true },
          { title: '摘要', dataIndex: 'summary', ellipsis: true, render: (v?: string) => v || '-' },
          { title: '申请人', dataIndex: 'applicant', width: 100 },
          { title: '提交时间', width: 150, render: (_: any, r: ApprovalItem) => r.submitted_at ? dayjs(r.submitted_at).format('YYYY-MM-DD HH:mm') : '-' },
          { title: '已等待', width: 140, render: (_: any, r: ApprovalItem) => {
            const cfg = WAIT_TAG[r.wait_level || 'normal'] || WAIT_TAG.normal
            return <Tag color={cfg.color}>{cfg.text(r.wait_hours)}</Tag>
          } },
          { title: '当前节点', dataIndex: 'current_node', width: 130, render: (v?: string, r?: ApprovalItem) => v || (r?.current_level ? `L${r.current_level}` : '-') },
          { title: '操作', width: 150, fixed: 'right', render: (_: any, r: ApprovalItem) => (
            <Space size={0}>
              {r.can_act ? <Button size="small" type="link" onClick={() => { setQuickTarget(r); setQuickComment('') }}>通过</Button> : null}
              <Button size="small" type="link" onClick={() => setDrawer({ bizType: r.biz_type, id: r.id })}>
                {r.can_act ? '去审批' : '去处理'}
              </Button>
            </Space>
          ) },
        ]} />

      <Modal title="通过审批" open={!!quickTarget} confirmLoading={quickSubmitting}
        onOk={submitQuick} onCancel={() => setQuickTarget(null)} okText="确认通过">
        {quickTarget ? (
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
            {quickTarget.biz_name} · {quickTarget.no} · {quickTarget.title}
          </div>
        ) : null}
        <Input.TextArea rows={3} value={quickComment} onChange={e => setQuickComment(e.target.value)}
          placeholder="审批意见（选填）" />
      </Modal>

      <Modal title={`批量通过审批（${selected.length} 条）`} open={batchOpen} confirmLoading={batchSubmitting}
        onOk={submitBatch} onCancel={() => setBatchOpen(false)} okText="确认通过">
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
          统一意见将写入所选单据；不支持中心内审批的业务会被自动跳过。
        </div>
        <Input.TextArea rows={3} value={batchComment} onChange={e => setBatchComment(e.target.value)}
          placeholder="统一审批意见（选填）" />
      </Modal>

      <ApprovalDrawer open={!!drawer} bizType={drawer?.bizType} itemId={drawer?.id}
        onClose={() => setDrawer(null)} onDone={load} />
    </>
  )
}

export default function ApprovalPending() {
  return (
    <Card>
      <Tabs
        items={[
          { key: 'pending', label: '待我审批', children: <PendingTab /> },
          { key: 'approved', label: '我已审批', children: <MyApprovedTab /> },
          { key: 'submitted', label: '我发起的', children: <MySubmittedTab /> },
        ]}
      />
    </Card>
  )
}
