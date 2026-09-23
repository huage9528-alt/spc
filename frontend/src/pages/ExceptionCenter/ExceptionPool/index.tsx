import { useEffect, useState, useCallback } from 'react'
import {
  Table, Tag, Input, Select, Button, Space, message, Row, Col,
} from 'antd'
import {
  SearchOutlined, ReloadOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import { exceptionApi, riskApi } from '../../../services/api'
import { formatDateTime } from '../../../utils'

const SOURCE_TYPE_MAP: Record<string, { label: string; color: string }> = {
  risk_issue: { label: '风险问题', color: 'red' },
  quality_issue: { label: '品质异常', color: 'orange' },
  process_exception: { label: '工序异常', color: 'purple' },
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  open: { label: '待处理', color: 'error' },
  in_progress: { label: '处理中', color: 'processing' },
  closed: { label: '已关闭', color: 'success' },
}

const SEVERITY_MAP: Record<string, { label: string; color: string }> = {
  red: { label: '高', color: 'red' },
  yellow: { label: '中', color: 'orange' },
  high: { label: '高', color: 'red' },
  medium: { label: '中', color: 'orange' },
  low: { label: '低', color: 'green' },
}

export default function ExceptionPool() {
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [filters, setFilters] = useState({ source_type: '', status: '', owner: '', keyword: '' })
  const [scanning, setScanning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = { page, page_size: pageSize }
      if (filters.source_type) params.source_type = filters.source_type
      if (filters.status) params.status = filters.status
      if (filters.owner) params.owner = filters.owner
      if (filters.keyword) params.keyword = filters.keyword
      const res: any = await exceptionApi.listPool(params)
      setData(res.data.items)
      setTotal(res.data.total)
    } catch (e: any) {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, filters])

  useEffect(() => { load() }, [load])

  const handleScan = async () => {
    setScanning(true)
    try {
      const res: any = await riskApi.scan()
      message.success(`风险扫描完成：新增 ${res.data.new_issues_count} 条风险问题`)
      load()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    } finally {
      setScanning(false)
    }
  }

  const columns = [
    {
      title: '来源', dataIndex: 'source_type', width: 100,
      render: (v: string) => {
        const m = SOURCE_TYPE_MAP[v] || { label: v, color: 'default' }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    { title: '编号', dataIndex: 'source_no', width: 130 },
    {
      title: '描述', dataIndex: 'title', ellipsis: true, width: 300,
      render: (v: string | null) => <span title={v || ''}>{v || '-'}</span>,
    },
    {
      title: '严重程度', dataIndex: 'severity', width: 90,
      render: (v: string | null) => {
        if (!v) return '-'
        const m = SEVERITY_MAP[v] || { label: v, color: 'default' }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) => {
        const m = STATUS_MAP[v] || { label: v, color: 'default' }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    { title: '责任人', dataIndex: 'owner', width: 90 },
    { title: '订单号', dataIndex: 'order_no', width: 120 },
    { title: '创建时间', dataIndex: 'created_at', width: 170,
      render: (v: string) => formatDateTime(v),
    },
  ]

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col>
            <Input
              prefix={<SearchOutlined />}
              placeholder="搜索编号/描述/订单号"
              value={filters.keyword}
              onChange={e => { setFilters(f => ({ ...f, keyword: e.target.value })); setPage(1) }}
              style={{ width: 240 }}
              allowClear
            />
          </Col>
          <Col>
            <Select
              placeholder="来源类型"
              value={filters.source_type || undefined}
              onChange={v => { setFilters(f => ({ ...f, source_type: v || '' })); setPage(1) }}
              allowClear
              style={{ width: 120 }}
            >
              {Object.entries(SOURCE_TYPE_MAP).map(([k, v]) => (
                <Select.Option key={k} value={k}>{v.label}</Select.Option>
              ))}
            </Select>
          </Col>
          <Col>
            <Select
              placeholder="状态"
              value={filters.status || undefined}
              onChange={v => { setFilters(f => ({ ...f, status: v || '' })); setPage(1) }}
              allowClear
              style={{ width: 110 }}
            >
              <Select.Option value="open">待处理</Select.Option>
              <Select.Option value="in_progress">处理中</Select.Option>
              <Select.Option value="closed">已关闭</Select.Option>
            </Select>
          </Col>
          <Col>
            <Input
              placeholder="责任人"
              value={filters.owner}
              onChange={e => { setFilters(f => ({ ...f, owner: e.target.value })); setPage(1) }}
              style={{ width: 120 }}
              allowClear
            />
          </Col>
          <Col flex="auto" />
          <Col>
            <Space>
              <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
              <Button icon={<ThunderboltOutlined />} onClick={handleScan} loading={scanning}>风险扫描</Button>
            </Space>
          </Col>
        </Row>
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey={r => `${r.source_type}-${r.source_id}`}
          dataSource={data}
          columns={columns}
          loading={loading}
          scroll={{ x: 1200 }}
          size="small"
          pagination={{
            total, current: page, pageSize,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            showSizeChanger: true, showTotal: t => `共 ${t} 条`,
          }}
        />
      </div>
    </div>
  )
}
