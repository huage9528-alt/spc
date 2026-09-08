import { useState, useEffect, useCallback } from 'react'
import { Table, Button, Modal, Form, Input, Select, message, Progress, Typography } from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SendOutlined,
  ReloadOutlined, SearchOutlined, FileTextOutlined,
} from '@ant-design/icons'
import { announcementApi } from '../../../services/api'
import PermButton from '../../../components/PermButton'
import { useAuthStore } from '../../../store/auth'
import ChipsFilter, { type ChipOption } from '../components/ChipsFilter'

const { TextArea } = Input
const { Text } = Typography

const typeOptions = [
  { label: '通知', value: 'notice' },
  { label: '系统更新', value: 'system_update' },
  { label: '维护公告', value: 'maintenance' },
]

const priorityOptions = [
  { label: '普通', value: 'normal' },
  { label: '重要', value: 'important' },
  { label: '紧急', value: 'urgent' },
]

const typeLabelMap: Record<string, string> = { notice: '通知', system_update: '系统更新', maintenance: '维护公告' }
const priorityLabelMap: Record<string, string> = { normal: '普通', important: '重要', urgent: '紧急' }

const typeTag: Record<string, string> = { notice: 'sc-tag-kit', system_update: 'sc-tag-done', maintenance: 'sc-tag-warn' }
const priorityTag: Record<string, string> = { normal: 'sc-tag-plain', important: 'sc-tag-amber', urgent: 'sc-tag-danger' }

interface AnnouncementRow {
  id: number
  title: string
  content?: string | null
  type: string
  priority: string
  is_published: boolean
  published_at?: string | null
  created_by: string
  created_at: string
  updated_at?: string
  notified_count?: number
  read_count?: number
}

interface AnnStats {
  total: number
  published: number
  draft: number
  by_type: Record<string, number>
  by_priority: Record<string, number>
  recent30: { published: number; notified: number; read: number; avg_read_rate: number }
}

const EmptyStats: AnnStats = { total: 0, published: 0, draft: 0, by_type: {}, by_priority: {}, recent30: { published: 0, notified: 0, read: 0, avg_read_rate: 0 } }

const readRate = (r: AnnouncementRow) =>
  r.notified_count ? Math.round(((r.read_count || 0) * 100) / r.notified_count) : 0

export default function AnnouncementManagement() {
  const hasPermission = useAuthStore((s: any) => s.hasPermission)
  const canCreate = hasPermission('announcements', 'create')
  const canUpdate = hasPermission('announcements', 'update')
  const canDelete = hasPermission('announcements', 'delete')

  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<AnnouncementRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [chip, setChip] = useState<string | number>('all')
  const [typeSel, setTypeSel] = useState<string | undefined>()
  const [prioSel, setPrioSel] = useState<string | undefined>()
  const [kwInput, setKwInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [sortInfo, setSortInfo] = useState<{ sort_by?: string; sort_order?: string }>({})

  const [stats, setStats] = useState<AnnStats>(EmptyStats)
  const [urgent, setUrgent] = useState<AnnouncementRow | null>(null)

  const [viewItem, setViewItem] = useState<AnnouncementRow | null>(null)
  const [publishItem, setPublishItem] = useState<AnnouncementRow | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [deleteItem, setDeleteItem] = useState<AnnouncementRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = { page, page_size: pageSize }
      if (sortInfo.sort_by) params.sort_by = sortInfo.sort_by
      if (sortInfo.sort_order) params.sort_order = sortInfo.sort_order
      if (chip === 'published') params.is_published = true
      else if (chip === 'draft') params.is_published = false
      else if (chip === 'urgent') params.priority = 'urgent'
      if (typeSel) params.type = typeSel
      if (prioSel) params.priority = prioSel
      if (keyword.trim()) params.keyword = keyword.trim()
      const res: any = await announcementApi.list(params)
      setData(res.data?.items || [])
      setTotal(res.data?.total || 0)
    } catch {
      // handled by interceptor
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, sortInfo, chip, typeSel, prioSel, keyword])

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await announcementApi.stats()
      setStats(res.data || EmptyStats)
    } catch {
      // handled by interceptor
    }
    try {
      const res: any = await announcementApi.list({ is_published: true, priority: 'urgent', page: 1, page_size: 1, sort_by: 'published_at', sort_order: 'desc' })
      const rows: AnnouncementRow[] = res.data?.items || []
      setUrgent(rows[0] || null)
    } catch {
      // handled by interceptor
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchStats() }, [fetchStats])
  useEffect(() => {
    const t = setTimeout(() => { setKeyword(kwInput.trim()); setPage(1) }, 300)
    return () => clearTimeout(t)
  }, [kwInput])

  const refreshAll = useCallback(() => { fetchData(); fetchStats() }, [fetchData, fetchStats])

  const handleTableChange = (pag: any, _filters: any, sorter: any) => {
    const sortField = sorter.field
    const sortOrder = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : undefined
    setSortInfo({ sort_by: sortField, sort_order: sortOrder })
    setPage(pag?.current || 1)
    if (pag?.pageSize) setPageSize(pag.pageSize)
  }

  const openCreate = () => {
    setEditingId(null)
    form.resetFields()
    form.setFieldsValue({ type: 'notice', priority: 'normal' })
    setModalOpen(true)
  }

  const openEdit = (record: AnnouncementRow) => {
    setEditingId(record.id)
    form.setFieldsValue({ title: record.title, content: record.content, type: record.type, priority: record.priority })
    setModalOpen(true)
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      setSubmitting(true)
      if (editingId) {
        await announcementApi.update(editingId, values)
        message.success('公告已更新')
      } else {
        await announcementApi.create(values)
        message.success('公告已创建（草稿）')
      }
      setModalOpen(false)
      refreshAll()
    } catch (e: any) {
      if (e?.errorFields) return
      // 错误已由全局拦截器提示
    } finally {
      setSubmitting(false)
    }
  }

  const handlePublish = async () => {
    if (!publishItem) return
    setPublishing(true)
    try {
      const res: any = await announcementApi.publish(publishItem.id)
      const count = res.data?.notified_users || 0
      message.success(`公告已发布，已通知 ${count} 位用户`)
      setPublishItem(null)
      refreshAll()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    } finally {
      setPublishing(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteItem) return
    setDeleting(true)
    try {
      await announcementApi.remove(deleteItem.id)
      message.success('公告已删除')
      setDeleteItem(null)
      refreshAll()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    } finally {
      setDeleting(false)
    }
  }

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    { label: '已发布', value: 'published', count: stats.published },
    { label: '草稿', value: 'draft', count: stats.draft },
    { label: '紧急', value: 'urgent', count: stats.by_priority.urgent || 0, hot: true },
  ]

  const renderReadCell = (r: AnnouncementRow) => {
    if (!r.is_published) return <span className="sc-note">—</span>
    if (!r.notified_count) return <span className="sc-note">已发布（通知记录保留期内）</span>
    return (
      <span className="sys-read-cell">
        <Progress percent={readRate(r)} size="small" strokeColor={readRate(r) >= 90 ? '#16a34a' : '#d97706'} />
        <span className="n">{r.read_count} / {r.notified_count}</span>
      </span>
    )
  }

  const columns: any[] = [
    {
      title: '标题', key: 'title', width: 340,
      render: (_: any, r: AnnouncementRow) => (
        <span>
          <span
            style={{ color: r.is_published ? '#0f172a' : '#64748b', fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => setViewItem(r)}
          >
            {r.title}
            {!r.is_published && <span className="sc-tag sc-tag-wait" style={{ height: 16, lineHeight: '16px', padding: '0 6px', fontSize: 'calc(10px * var(--font-size-scale))' }}>草稿</span>}
          </span>
          <div className="sys-op-sub">{r.is_published ? `已发布 ${r.published_at || '—'}` : `上次编辑 ${r.updated_at || r.created_at || ''}`}</div>
        </span>
      ),
    },
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 110,
      render: (v: string) => <span className={`sc-tag ${typeTag[v] || 'sc-tag-plain'}`}>{typeLabelMap[v] || v}</span>,
    },
    {
      title: '优先级', dataIndex: 'priority', key: 'priority', width: 100,
      render: (v: string) => <span className={`sc-tag ${priorityTag[v] || 'sc-tag-plain'}`}>{v === 'urgent' && <span className="dot" />}{priorityLabelMap[v] || v}</span>,
    },
    {
      title: '状态', dataIndex: 'is_published', key: 'is_published', width: 100,
      render: (v: boolean) => v
        ? <span className="sc-tag sc-tag-done"><span className="dot" />已发布</span>
        : <span className="sc-tag sc-tag-wait">草稿</span>,
    },
    {
      title: '创建人', dataIndex: 'created_by', key: 'created_by', width: 100,
      render: (v: string) => v || '—',
    },
    {
      title: '已读 / 通知', key: 'read', width: 190,
      render: (_: any, r: AnnouncementRow) => renderReadCell(r),
    },
    {
      title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 150,
      render: (v: string) => <span className="sc-mono" style={{ color: '#64748b' }}>{v}</span>,
    },
    {
      title: '操作', key: 'actions', width: 200, fixed: 'right' as const,
      render: (_: any, r: AnnouncementRow) => (
        <span className="sc-row-act">
          <a onClick={() => setViewItem(r)}>查看</a>
          {canUpdate && !r.is_published && <a onClick={() => openEdit(r)}>编辑</a>}
          {canUpdate && !r.is_published && <a style={{ color: '#16a34a' }} onClick={() => setPublishItem(r)}>发布</a>}
          {canDelete && <a style={{ color: '#dc2626' }} onClick={() => setDeleteItem(r)}>删除</a>}
        </span>
      ),
    },
  ]

  return (
    <div className="sc-page">
      {/* 页头 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 'calc(20px * var(--font-size-scale))', fontWeight: 600, letterSpacing: '-0.01em' }}>公告管理</div>
          <div className="sc-toolbar-hint" style={{ marginTop: 3 }}>
            发布即向全部用户推送站内通知 · 已发布公告不可修改，仅可删除或发补充公告
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button icon={<ReloadOutlined />} onClick={refreshAll} />
          <PermButton permResource="announcements" permAction="create" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建公告
          </PermButton>
        </div>
      </div>

      {/* 紧急横幅 */}
      {urgent && (
        <div className="sys-urgent">
          <span className="sys-urgent-ico"><SendOutlined /></span>
          <div className="sys-urgent-body">
            <div className="sys-urgent-title">
              <span onClick={() => setViewItem(urgent)} style={{ cursor: 'pointer' }}>{urgent.title}</span>
              <span className="sc-tag sc-tag-danger">紧急</span>
              <span className={`sc-tag ${typeTag[urgent.type] || 'sc-tag-plain'}`}>{typeLabelMap[urgent.type] || urgent.type}</span>
            </div>
            <div className="sys-urgent-desc">{urgent.content || '（无正文）'}</div>
          </div>
          <span className="sys-urgent-time">发布于 {urgent.published_at || '—'} · 通知 {urgent.notified_count ?? '—'} 人 · 已读 {readRate(urgent)}%</span>
          <Button type="text" size="small" icon={<FileTextOutlined />} onClick={() => setViewItem(urgent)} />
        </div>
      )}

      {/* 工具栏 */}
      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="标题 / 正文关键字"
            style={{ width: 240 }}
            value={kwInput}
            onChange={(e) => setKwInput(e.target.value)}
          />
        </span>
        <Select
          allowClear
          placeholder="全部类型"
          style={{ width: 130 }}
          value={typeSel}
          onChange={(v) => { setTypeSel(v); setPage(1) }}
          options={typeOptions}
        />
        <Select
          allowClear
          placeholder="全部优先级"
          style={{ width: 130 }}
          value={prioSel}
          onChange={(v) => { setPrioSel(v); setPage(1) }}
          options={priorityOptions}
        />
        <ChipsFilter options={chipOptions} value={chip} onChange={(v) => { setChip(v); setPage(1) }} />
        <span className="sc-toolbar-hint" style={{ marginLeft: 'auto' }}>
          近 30 天发布 {stats.recent30.published} 条 · 平均已读率 {stats.recent30.avg_read_rate}%
        </span>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={data}
          onChange={handleTableChange}
          size="small"
          scroll={{ x: 1300 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
        />
      </div>

      {/* 详情弹窗 */}
      <Modal
        title="公告详情"
        open={!!viewItem}
        onCancel={() => setViewItem(null)}
        footer={<Button onClick={() => setViewItem(null)}>关闭</Button>}
        width={680}
        rootClassName="sc-page"
      >
        {viewItem && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className={`sc-tag ${typeTag[viewItem.type] || 'sc-tag-plain'}`}>{typeLabelMap[viewItem.type] || viewItem.type}</span>
              <span className={`sc-tag ${priorityTag[viewItem.priority] || 'sc-tag-plain'}`}>{viewItem.priority === 'urgent' && <span className="dot" />}{priorityLabelMap[viewItem.priority] || viewItem.priority}</span>
              {viewItem.is_published
                ? <span className="sc-tag sc-tag-done"><span className="dot" />已发布</span>
                : <span className="sc-tag sc-tag-wait">草稿</span>}
            </div>
            <h3 style={{ fontSize: 'calc(18px * var(--font-size-scale))', fontWeight: 600, margin: '12px 0 4px' }}>{viewItem.title}</h3>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'calc(11.5px * var(--font-size-scale))', color: '#94a3b8' }}>
              <span>创建人：{viewItem.created_by}</span>
              <span>创建：{viewItem.created_at}</span>
              {viewItem.is_published && <span>发布：{viewItem.published_at}</span>}
              {viewItem.is_published && viewItem.notified_count ? <span>已读 {viewItem.read_count} / {viewItem.notified_count} 人</span> : null}
            </div>
            <div style={{ margin: '14px 0', borderTop: '1px solid #f1f5f9' }} />
            <Text style={{ whiteSpace: 'pre-wrap', fontSize: 'calc(14px * var(--font-size-scale))', lineHeight: 2, color: '#0f172a' }}>
              {viewItem.content || '（无正文内容）'}
            </Text>
            {viewItem.is_published && (
              <div className="f-note" style={{ marginTop: 14, background: '#fffbeb', borderColor: '#fde68a', color: '#92400e' }}>
                已发布公告不可修改；如需补充请另行发布公告，历史公告保留不改。
              </div>
            )}
          </>
        )}
      </Modal>

      {/* 发布确认 */}
      <Modal
        title={<span style={{ color: '#d97706' }}>发布公告</span>}
        open={!!publishItem}
        onOk={handlePublish}
        confirmLoading={publishing}
        onCancel={() => setPublishItem(null)}
        okText="确认发布并通知"
        cancelText="取消"
        width={520}
        rootClassName="sc-page"
      >
        <p style={{ fontSize: 'calc(13.5px * var(--font-size-scale))', color: '#475569' }}>
          确认发布 <b style={{ color: '#0f172a' }}>「{publishItem?.title}」</b>？
        </p>
        <div className="sys-pub-est">
          <div className="pe"><div className="v">全部在职账号</div><div className="k">通知对象（员工 + 供应商）</div></div>
          <div className="pe"><div className="v">站内通知</div><div className="k">推送方式 · 通知中心</div></div>
          <div className="pe"><div className="v" style={{ color: '#dc2626' }}>不可逆</div><div className="k">发布后仅可删除</div></div>
        </div>
        <div className="f-note" style={{ background: '#fffbeb', borderColor: '#fde68a', color: '#92400e' }}>
          <b>重要：</b>发布为不可逆操作，正文将以站内通知送达全部用户（含未读红点）。发布后内容仅能删除、不能修改。
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        title={<span style={{ color: '#dc2626' }}>删除公告</span>}
        open={!!deleteItem}
        onOk={handleDelete}
        confirmLoading={deleting}
        onCancel={() => setDeleteItem(null)}
        okText="删除公告"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        width={480}
        rootClassName="sc-page"
      >
        <p style={{ fontSize: 'calc(13.5px * var(--font-size-scale))', color: '#475569', lineHeight: 1.8 }}>
          确认删除公告 <b style={{ color: '#0f172a' }}>「{deleteItem?.title}」</b>？
          {deleteItem?.is_published
            ? <>该公告<b style={{ color: '#dc2626' }}>已发布并通知用户</b>（已读 {deleteItem.read_count ?? 0} / {deleteItem.notified_count ?? 0}）。删除后用户将无法再查看，通知记录同步清除。</>
            : '该公告为草稿，删除后不可恢复。'}
        </p>
      </Modal>

      {/* 新建 / 编辑 */}
      <Modal
        title={editingId ? '编辑公告' : '新建公告'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        confirmLoading={submitting}
        width={660}
        okText={editingId ? '保存' : '保存草稿'}
        rootClassName="sc-page"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入公告标题' }]}>
            <Input placeholder="一句话说清「发生了什么 + 需要谁做什么」（≤ 200 字）" maxLength={200} showCount />
          </Form.Item>
          <Form.Item name="content" label="正文（≤ 5000 字）">
            <TextArea rows={7} placeholder="通知对象、背景说明、影响范围、行动要求 / 生效时间…" maxLength={5000} showCount />
          </Form.Item>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="type" label="类型" rules={[{ required: true, message: '请选择类型' }]} style={{ flex: 1 }}>
              <Select options={typeOptions} />
            </Form.Item>
            <Form.Item name="priority" label="优先级" rules={[{ required: true, message: '请选择优先级' }]} style={{ flex: 1 }}>
              <Select options={priorityOptions} />
            </Form.Item>
          </div>
          <div className="f-note">
            当前保存为草稿，可在列表「发布」；已发布公告不可再编辑。发布即推送全部用户站内通知。
          </div>
        </Form>
      </Modal>
    </div>
  )
}
