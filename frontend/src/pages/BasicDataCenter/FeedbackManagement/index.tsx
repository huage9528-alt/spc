import { useEffect, useRef, useState } from 'react'
import {
  Table, Tag, Button, Space, Input, Select, Row, Col, Card, Drawer, Form,
  message, Popconfirm, Descriptions, List, Image,
} from 'antd'
import { ReloadOutlined, SearchOutlined, EyeOutlined, DeleteOutlined, MessageOutlined } from '@ant-design/icons'
import { feedbackApi } from '../../../services/api'
import { useAuthStore } from '../../../store/auth'
import { useSearchParams } from 'react-router-dom'

const typeMap: Record<string, { label: string; color: string }> = {
  issue: { label: '问题', color: 'red' },
  suggestion: { label: '建议', color: 'blue' },
  inquiry: { label: '咨询', color: 'green' },
}
const severityMap: Record<string, { label: string; color: string }> = {
  low: { label: '低', color: 'default' },
  medium: { label: '中', color: 'gold' },
  high: { label: '高', color: 'red' },
}
const statusMap: Record<string, { label: string; color: string }> = {
  pending: { label: '待处理', color: 'orange' },
  processing: { label: '处理中', color: 'blue' },
  resolved: { label: '已解决', color: 'green' },
  closed: { label: '已关闭', color: 'default' },
}

export default function FeedbackManagement() {
  const hasPermission = useAuthStore(s => s.hasPermission)
  const canHandle = hasPermission('basicdata.feedback.handle', 'handle') || hasPermission('basicdata.feedback', 'update')
  const canDelete = hasPermission('basicdata.feedback', 'delete')
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<any>({ total: 0, pending: 0, processing: 0, resolved: 0, closed: 0 })
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [keyword, setKeyword] = useState<string>('')
  const [filterType, setFilterType] = useState<string | undefined>(undefined)
  const [filterSeverity, setFilterSeverity] = useState<string | undefined>(undefined)
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)

  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<any>(null)
  const [replyForm] = Form.useForm()
  const [replying, setReplying] = useState(false)
  const [sortInfo, setSortInfo] = useState<{ sort_by?: string; sort_order?: string }>({})

  const fetchData = async (
    page = pagination.current,
    pageSize = pagination.pageSize,
    overrides: { kw?: string; type?: string; severity?: string; status?: string } = {},
  ) => {
    setLoading(true)
    try {
      const params: any = { page, page_size: pageSize }
      const k = (overrides.kw !== undefined ? overrides.kw : keyword).trim()
      if (k) params.keyword = k
      const t = overrides.type !== undefined ? overrides.type : filterType
      const s = overrides.severity !== undefined ? overrides.severity : filterSeverity
      const st = overrides.status !== undefined ? overrides.status : filterStatus
      if (t) params.type = t
      if (s) params.severity = s
      if (st) params.status = st
      if (sortInfo.sort_by) params.sort_by = sortInfo.sort_by
      if (sortInfo.sort_order) params.sort_order = sortInfo.sort_order
      const res: any = await feedbackApi.list(params)
      setData(res.data?.items || [])
      setStats(res.data?.stats || stats)
      setPagination({ current: res.data?.page || 1, pageSize: res.data?.page_size || 20, total: res.data?.total || 0 })
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData(1) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 自动搜索（输入即搜，300ms 防抖）
  useEffect(() => {
    const t = setTimeout(() => { fetchData(1, pagination.pageSize) }, 300)
    return () => clearTimeout(t)
  }, [keyword, filterType, filterSeverity, filterStatus, sortInfo]) // eslint-disable-line react-hooks/exhaustive-deps

  const openDetail = async (record: any) => {
    setDetail(record)
    replyForm.setFieldsValue({ reply: record.reply || '', status: record.status })
    setDetailOpen(true)
  }

  const [searchParams, setSearchParams] = useSearchParams()
  const urlSearchAppliedRef = useRef(false)

  // 从通知中心跳转而来:读取 ?id= 并自动打开该条反馈详情
  useEffect(() => {
    if (urlSearchAppliedRef.current) return
    const idParam = searchParams.get('id')
    if (!idParam) return
    urlSearchAppliedRef.current = true
    const newParams = new URLSearchParams(searchParams)
    newParams.delete('id')
    setSearchParams(newParams, { replace: true })
    feedbackApi.get(Number(idParam)).then((res: any) => {
      if (res?.data) openDetail(res.data)
    }).catch(() => {
      // 错误已由全局拦截器提示
    })
  }, [searchParams, setSearchParams])

  const handleReply = async () => {
    try {
      const values = await replyForm.validateFields()
      if (!values.reply && !values.status) {
        message.warning('请填写回复内容或选择状态')
        return
      }
      setReplying(true)
      const res: any = await feedbackApi.reply(detail.id, values)
      message.success('已保存')
      setDetail(res.data)
      fetchData()
    } catch (e: any) {
      if (e?.errorFields) return
      // 错误已由全局拦截器提示
    } finally {
      setReplying(false)
    }
  }

  const changeStatus = async (status: string) => {
    try {
      const res: any = await feedbackApi.updateStatus(detail.id, status)
      message.success('状态已更新')
      setDetail(res.data)
      replyForm.setFieldsValue({ status: res.data?.status })
      fetchData()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await feedbackApi.remove(id)
      message.success('已删除')
      fetchData()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  const columns: any[] = [
    {
      title: '标题', dataIndex: 'title', key: 'title', ellipsis: true, width: 240, sorter: true,
    },
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 80, sorter: true,
      filters: Object.entries(typeMap).map(([k, v]) => ({ text: v.label, value: k })),
      render: (v: string) => <Tag color={typeMap[v]?.color}>{typeMap[v]?.label || v}</Tag>,
    },
    {
      title: '严重程度', dataIndex: 'severity', key: 'severity', width: 90, sorter: true,
      filters: Object.entries(severityMap).map(([k, v]) => ({ text: v.label, value: k })),
      render: (v: string) => <Tag color={severityMap[v]?.color}>{severityMap[v]?.label || v}</Tag>,
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 90, sorter: true,
      filters: Object.entries(statusMap).map(([k, v]) => ({ text: v.label, value: k })),
      render: (v: string) => <Tag color={statusMap[v]?.color}>{statusMap[v]?.label || v}</Tag>,
    },
    {
      title: '所在页面', dataIndex: 'page_path', key: 'page_path', width: 160, ellipsis: true, sorter: true,
    },
    {
      title: '提交人', dataIndex: 'submitter_name', key: 'submitter_name', width: 100, sorter: true,
    },
    {
      title: '提交时间', dataIndex: 'created_at', key: 'created_at', width: 160, sorter: true,
      render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
    {
      title: '回复人', dataIndex: 'replied_by', key: 'replied_by', width: 100, sorter: true,
    },
    {
      title: '操作', key: 'actions', width: 160, fixed: 'right',
      render: (_: any, record: any) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => openDetail(record)}>查看</Button>
          {canDelete && (
            <Popconfirm title="确定删除？" onConfirm={() => handleDelete(record.id)}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      {/* 统计卡 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card><div style={{ color: '#64748b' }}>总数</div><div style={{ fontSize: 24, fontWeight: 600 }}>{stats.total}</div></Card></Col>
        <Col span={6}><Card><div style={{ color: '#fa8c16' }}>待处理</div><div style={{ fontSize: 24, fontWeight: 600 }}>{stats.pending}</div></Card></Col>
        <Col span={6}><Card><div style={{ color: '#1677ff' }}>处理中</div><div style={{ fontSize: 24, fontWeight: 600 }}>{stats.processing}</div></Card></Col>
        <Col span={6}><Card><div style={{ color: '#52c41a' }}>已解决</div><div style={{ fontSize: 24, fontWeight: 600 }}>{stats.resolved}</div></Card></Col>
      </Row>

      {/* 搜索 */}
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col flex="auto">
            <Input
              prefix={<SearchOutlined />}
              placeholder="搜索标题/所在页面/提交人/回复人"
              allowClear
              size="middle"
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
            />
          </Col>
          <Col>
            <Select
              allowClear
              placeholder="类型"
              style={{ width: 120 }}
              value={filterType}
              onChange={v => setFilterType(v)}
              options={Object.entries(typeMap).map(([k, v]) => ({ label: v.label, value: k }))}
            />
          </Col>
          <Col>
            <Select
              allowClear
              placeholder="严重程度"
              style={{ width: 120 }}
              value={filterSeverity}
              onChange={v => setFilterSeverity(v)}
              options={Object.entries(severityMap).map(([k, v]) => ({ label: v.label, value: k }))}
            />
          </Col>
          <Col>
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 120 }}
              value={filterStatus}
              onChange={v => setFilterStatus(v)}
              options={Object.entries(statusMap).map(([k, v]) => ({ label: v.label, value: k }))}
            />
          </Col>
          <Col><Button icon={<ReloadOutlined />} onClick={() => fetchData()}>刷新</Button></Col>
        </Row>
      </div>

      <div className="card-modern">
        <Table
          columns={columns}
          dataSource={data}
          rowKey="id"
          loading={loading}
          size="small"
          scroll={{ x: 1280 }}
          onChange={(_pag: any, tableFilters: any, sorter: any) => {
            const sortField = sorter.field
            const sortOrder = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : undefined
            if (sortField !== sortInfo.sort_by || sortOrder !== sortInfo.sort_order) {
              setSortInfo({ sort_by: sortField, sort_order: sortOrder })
            }
            if (tableFilters.type?.length) setFilterType(tableFilters.type.join(','))
            else if (tableFilters.type !== undefined) setFilterType(undefined)
            if (tableFilters.severity?.length) setFilterSeverity(tableFilters.severity.join(','))
            else if (tableFilters.severity !== undefined) setFilterSeverity(undefined)
            if (tableFilters.status?.length) setFilterStatus(tableFilters.status.join(','))
            else if (tableFilters.status !== undefined) setFilterStatus(undefined)
          }}
          pagination={{
            ...pagination,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
            onChange: (page, pageSize) => fetchData(page, pageSize),
            pageSizeOptions: ['20', '50', '100'],
          }}
        />
      </div>

      {/* 详情抽屉 */}
      <Drawer
        title={<Space><MessageOutlined />反馈详情 #{detail?.id}</Space>}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={680}
      >
        {detail && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="类型"><Tag color={typeMap[detail.type]?.color}>{typeMap[detail.type]?.label}</Tag></Descriptions.Item>
              <Descriptions.Item label="严重程度"><Tag color={severityMap[detail.severity]?.color}>{severityMap[detail.severity]?.label}</Tag></Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={statusMap[detail.status]?.color}>{statusMap[detail.status]?.label}</Tag></Descriptions.Item>
              <Descriptions.Item label="提交人">{detail.submitter_name}</Descriptions.Item>
              <Descriptions.Item label="所在页面" span={2}>{detail.page_path || '-'}</Descriptions.Item>
              <Descriptions.Item label="提交时间" span={2}>{detail.created_at ? new Date(detail.created_at).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
              <Descriptions.Item label="标题" span={2}>{detail.title}</Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</div>
              </Descriptions.Item>
            </Descriptions>

            {detail.attachments?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>附件</div>
                <Image.PreviewGroup>
                  <List
                    size="small"
                    bordered
                    dataSource={detail.attachments}
                    renderItem={(a: any) => (
                      <List.Item
                        actions={[
                          <a key="dl" href={a.url} download={a.name} target="_blank" rel="noreferrer">下载</a>,
                        ]}
                      >
                        <Space>
                          {a.mime?.startsWith('image/') ? (
                            <Image
                              src={a.url}
                              alt={a.name}
                              width={48}
                              height={48}
                              style={{ objectFit: 'cover', borderRadius: 4, cursor: 'zoom-in' }}
                              preview={{ mask: '点击预览' }}
                            />
                          ) : (
                            <span style={{ width: 48, height: 48, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9', borderRadius: 4, color: '#94a3b8', fontSize: 12 }}>
                              {(a.name || '').split('.').pop()?.toUpperCase() || 'FILE'}
                            </span>
                          )}
                          <span>{a.name}</span>
                          <span style={{ color: '#94a3b8', fontSize: 12 }}>{(a.size / 1024).toFixed(1)} KB</span>
                        </Space>
                      </List.Item>
                    )}
                  />
                </Image.PreviewGroup>
              </div>
            )}

            {/* 状态流转 */}
            {(() => {
              const s = detail.status
              const btns: React.ReactNode[] = []
              if (canHandle) {
                if (s === 'pending') btns.push(
                  <Button key="p" onClick={() => changeStatus('processing')}>开始处理</Button>,
                  <Button key="r" type="primary" onClick={() => changeStatus('resolved')}>标记已解决</Button>,
                  <Button key="c" onClick={() => changeStatus('closed')}>关闭</Button>,
                )
                else if (s === 'processing') btns.push(
                  <Button key="r" type="primary" onClick={() => changeStatus('resolved')}>标记已解决</Button>,
                  <Button key="c" onClick={() => changeStatus('closed')}>关闭</Button>,
                )
                else if (s === 'resolved') btns.push(
                  <Button key="o" onClick={() => changeStatus('processing')}>重开处理</Button>,
                  <Button key="c" onClick={() => changeStatus('closed')}>关闭</Button>,
                )
                else if (s === 'closed') btns.push(
                  <Button key="o" onClick={() => changeStatus('pending')}>重新打开</Button>,
                )
              } else {
                if (s === 'resolved') btns.push(
                  <Popconfirm key="c" title="确认关闭这条反馈？" onConfirm={() => changeStatus('closed')}>
                    <Button type="primary">确认关闭</Button>
                  </Popconfirm>,
                )
                if (s === 'closed') btns.push(
                  <Button key="o" onClick={() => changeStatus('pending')}>重新打开</Button>,
                )
              }
              return btns.length ? (
                <div style={{ marginTop: 16, padding: 12, background: '#fafafa', borderRadius: 8 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>状态流转</div>
                  <Space wrap>{btns}</Space>
                </div>
              ) : null
            })()}

            {detail.reply && (
              <div style={{ marginTop: 16, padding: 12, background: '#f0f9ff', borderRadius: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  管理员回复（{detail.replied_by} · {detail.replied_at ? new Date(detail.replied_at).toLocaleString('zh-CN') : ''}）
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{detail.reply}</div>
              </div>
            )}

            {canHandle && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>处理回复</div>
                <Form form={replyForm} layout="vertical">
                  <Form.Item name="reply" label="回复内容（可选）" extra="留空则仅更新状态">
                    <Input.TextArea rows={4} maxLength={2000} showCount placeholder="请填写处理结论或回复内容" />
                  </Form.Item>
                  <Form.Item name="status" label="同步设置状态（可选）">
                    <Select
                      allowClear
                      placeholder="保持当前状态不变"
                      options={Object.entries(statusMap).map(([k, v]) => ({ label: v.label, value: k }))}
                    />
                  </Form.Item>
                  <Button type="primary" onClick={handleReply} loading={replying}>保存</Button>
                </Form>
              </div>
            )}
          </>
        )}
      </Drawer>
    </div>
  )
}
