import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Table, Tag, Card, Row, Col, Progress, Button, Space, message } from 'antd'
import {
  ToolOutlined, CheckCircleOutlined,
  WarningOutlined, ExclamationCircleOutlined, BarChartOutlined,
} from '@ant-design/icons'
import { productionApi } from '../../../services/api'

interface ProcessTypeStat {
  process_type: string
  total: number
  completed: number
  in_progress: number
  overdue: number
  abnormal: number
}

interface ProductProcessItem {
  product_code: string | null
  model_code: string | null
  color_spec: string | null
  qty: number | null
  front_process_status: string | null
  smt_status: string | null
  lean_status: string | null
  assembly_status: string | null
  packaging_status: string | null
  current_process: string | null
  block_reason: string | null
}

interface OrderProcessItem {
  order_no: string
  products: ProductProcessItem[]
  current_process: string | null
  block_reason: string | null
}

interface OverviewData {
  process_stats: ProcessTypeStat[]
  orders: OrderProcessItem[]
  total_orders: number
  blocked_orders: number
}

const PROCESS_LABELS: Record<string, string> = {
  front_process: '前道', smt: '贴片', lean: '精益', assembly: '组装', packaging: '包装',
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  completed: { label: '已完成', color: 'success' },
  pending: { label: '进行中', color: 'processing' },
  overdue: { label: '逾期', color: 'error' },
  abnormal: { label: '异常', color: 'warning' },
}

const renderStatus = (v: string | null) =>
  v ? <Tag color={(STATUS_MAP[v] || {}).color || 'default'}>{(STATUS_MAP[v] || {}).label || v}</Tag> : <span style={{ color: '#cbd5e1' }}>-</span>

export default function ProductionOverview() {
  const navigate = useNavigate()
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await productionApi.getOverview()
      setData(res.data)
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const statCards = [
    { title: '订单总数', value: data?.total_orders ?? 0, icon: <ToolOutlined />, color: '#6366f1' },
    { title: '卡点订单', value: data?.blocked_orders ?? 0, icon: <WarningOutlined />, color: '#e11d48' },
    { title: '已完成', value: data?.process_stats.reduce((s, p) => s + p.completed, 0) ?? 0, icon: <CheckCircleOutlined />, color: '#16a34a' },
    { title: '逾期/异常', value: data?.process_stats.reduce((s, p) => s + p.overdue + p.abnormal, 0) ?? 0, icon: <ExclamationCircleOutlined />, color: '#f59e0b' },
  ]

  const processColumns = [
    { title: '工序', dataIndex: 'process_type', width: 80, render: (v: string) => PROCESS_LABELS[v] || v },
    { title: '总数', dataIndex: 'total', width: 70 },
    { title: '已完成', dataIndex: 'completed', width: 80, render: (v: number) => <span style={{ color: '#16a34a' }}>{v}</span> },
    { title: '进行中', dataIndex: 'in_progress', width: 80, render: (v: number) => <span style={{ color: '#3b82f6' }}>{v}</span> },
    { title: '逾期', dataIndex: 'overdue', width: 70, render: (v: number) => v > 0 ? <span style={{ color: '#e11d48', fontWeight: 600 }}>{v}</span> : v },
    { title: '异常', dataIndex: 'abnormal', width: 70, render: (v: number) => v > 0 ? <span style={{ color: '#f59e0b', fontWeight: 600 }}>{v}</span> : v },
    {
      title: '完成率', width: 140,
      render: (_: any, row: ProcessTypeStat) => {
        const pct = row.total > 0 ? Math.round(row.completed / row.total * 100) : 0
        return <Progress percent={pct} size="small" status={pct >= 100 ? 'success' : pct < 50 ? 'exception' : 'active'} />
      },
    },
  ]

  // 产品级展开子表列
  const productColumns = [
    { title: '产品编码', dataIndex: 'product_code', width: 120, render: (v: string | null) => v || '-' },
    { title: '型号', dataIndex: 'model_code', width: 160, ellipsis: true },
    { title: '颜色', dataIndex: 'color_spec', width: 100, ellipsis: true },
    { title: '数量', dataIndex: 'qty', width: 80 },
    { title: '前道', dataIndex: 'front_process_status', width: 80, render: renderStatus },
    { title: '贴片', dataIndex: 'smt_status', width: 80, render: renderStatus },
    { title: '精益', dataIndex: 'lean_status', width: 80, render: renderStatus },
    { title: '组装', dataIndex: 'assembly_status', width: 80, render: renderStatus },
    { title: '包装', dataIndex: 'packaging_status', width: 80, render: renderStatus },
    {
      title: '当前卡点', dataIndex: 'current_process', width: 100,
      render: (v: string | null) => v ? PROCESS_LABELS[v] || v : <span style={{ color: '#16a34a' }}>✓</span>,
    },
    {
      title: '卡点原因', dataIndex: 'block_reason', width: 180, ellipsis: true,
      render: (v: string | null) => v ? <span style={{ color: '#e11d48' }}>{v}</span> : '-',
    },
  ]

  // 订单级列（简化，详情在展开行）
  const orderColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 140, fixed: 'left' as const },
    {
      title: '产品数', width: 80,
      render: (_: any, row: OrderProcessItem) => <span style={{ fontWeight: 600 }}>{row.products.length}</span>,
    },
    {
      title: '前道', width: 80,
      render: (_: any, row: OrderProcessItem) => {
        const worst = row.products.reduce((a: string | null, p: ProductProcessItem) => {
          if (!a) return p.front_process_status
          const order: Record<string, number> = { overdue: 4, abnormal: 3, pending: 2, completed: 1 }
          return (order[p.front_process_status || ''] || 0) >= (order[a || ''] || 0) ? p.front_process_status : a
        }, null)
        return renderStatus(worst)
      },
    },
    {
      title: '贴片', width: 80,
      render: (_: any, row: OrderProcessItem) => {
        const worst = row.products.reduce((a: string | null, p: ProductProcessItem) => {
          if (!a) return p.smt_status
          const order: Record<string, number> = { overdue: 4, abnormal: 3, pending: 2, completed: 1 }
          return (order[p.smt_status || ''] || 0) >= (order[a || ''] || 0) ? p.smt_status : a
        }, null)
        return renderStatus(worst)
      },
    },
    {
      title: '精益', width: 80,
      render: (_: any, row: OrderProcessItem) => {
        const worst = row.products.reduce((a: string | null, p: ProductProcessItem) => {
          if (!a) return p.lean_status
          const order: Record<string, number> = { overdue: 4, abnormal: 3, pending: 2, completed: 1 }
          return (order[p.lean_status || ''] || 0) >= (order[a || ''] || 0) ? p.lean_status : a
        }, null)
        return renderStatus(worst)
      },
    },
    {
      title: '组装', width: 80,
      render: (_: any, row: OrderProcessItem) => {
        const worst = row.products.reduce((a: string | null, p: ProductProcessItem) => {
          if (!a) return p.assembly_status
          const order: Record<string, number> = { overdue: 4, abnormal: 3, pending: 2, completed: 1 }
          return (order[p.assembly_status || ''] || 0) >= (order[a || ''] || 0) ? p.assembly_status : a
        }, null)
        return renderStatus(worst)
      },
    },
    {
      title: '包装', width: 80,
      render: (_: any, row: OrderProcessItem) => {
        const worst = row.products.reduce((a: string | null, p: ProductProcessItem) => {
          if (!a) return p.packaging_status
          const order: Record<string, number> = { overdue: 4, abnormal: 3, pending: 2, completed: 1 }
          return (order[p.packaging_status || ''] || 0) >= (order[a || ''] || 0) ? p.packaging_status : a
        }, null)
        return renderStatus(worst)
      },
    },
    {
      title: '当前卡点', dataIndex: 'current_process', width: 100,
      render: (v: string | null) => v ? PROCESS_LABELS[v] || v : <span style={{ color: '#16a34a' }}>✓</span>,
    },
    {
      title: '卡点原因', dataIndex: 'block_reason', width: 180, ellipsis: true,
      render: (v: string | null) => v ? <span style={{ color: '#e11d48' }}>{v}</span> : '-',
    },
  ]

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Space wrap size={12} style={{ width: '100%', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>生产中心快捷入口</div>
            <div style={{ color: '#64748b' }}>排产主操作继续走原有计划排产，新增的排产看板独立承接周视图、负荷和进度观察。</div>
          </div>
          <Space>
            <Button onClick={() => navigate('/schedule-plans')}>进入计划排产</Button>
            <Button type="primary" icon={<BarChartOutlined />} onClick={() => navigate('/schedule-board')}>
              打开排产看板
            </Button>
          </Space>
        </Space>
      </div>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        {statCards.map((card, i) => (
          <Col span={6} key={i}>
            <Card size="small" className="card-modern" style={{ padding: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: `${card.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'calc(1.25rem * var(--font-size-scale))', color: card.color }}>
                  {card.icon}
                </div>
                <div>
                  <div style={{ fontSize: 'calc(1.375rem * var(--font-size-scale))', fontWeight: 700, color: '#1e293b' }}>{card.value}</div>
                  <div style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', color: '#64748b' }}>{card.title}</div>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>各工序统计</h3>
        <Table
          rowKey="process_type"
          dataSource={data?.process_stats || []}
          columns={processColumns}
          loading={loading}
          pagination={false}
          size="small"
        />
      </div>

      <div className="card-modern" style={{ padding: '16px 20px' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>订单工序进度</h3>
        <Table
          rowKey="order_no"
          dataSource={data?.orders || []}
          columns={orderColumns}
          loading={loading}
          scroll={{ x: 1200 }}
          size="small"
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
          rowClassName={(row) => row.block_reason ? 'ant-table-row-danger' : ''}
          expandable={{
            rowExpandable: (row) => row.products.length > 1,
            expandedRowRender: (row) => (
              <Table
                rowKey={(r: ProductProcessItem) => r.product_code || r.model_code || Math.random().toString()}
                dataSource={row.products}
                columns={productColumns}
                pagination={false}
                size="small"
                scroll={{ x: 1100 }}
                style={{ margin: '8px 0' }}
              />
            ),
          }}
        />
      </div>
    </div>
  )
}
