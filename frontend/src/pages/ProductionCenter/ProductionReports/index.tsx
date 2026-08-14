import { useEffect, useState, useCallback } from 'react'
import { Table, Button, Input, InputNumber, DatePicker, Select, Space, message, Modal, Tag, Row, Col, Alert, Card, Descriptions, Tabs } from 'antd'
import { PlusOutlined, ReloadOutlined, FileSearchOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { productionApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'

interface ReportPlan {
  id: number
  department: string | null
  plan_date: string | null
  order_no: string | null
  product_code: string | null
  model_code: string | null
  quantity: number
  planned_qty: number
  completed_qty: number
  process_type: string | null
  start_date: string | null
  end_date: string | null
  upph: number
}

const PROCESS_TYPE_MAP: Record<string, string> = {
  lean: '精益',
  assembly: '组装',
  packaging: '包装',
  mixed: '组装+包装',
}

const fmtProcess = (v: string | null) => (v ? PROCESS_TYPE_MAP[v] || v : '-')

interface ReportItem {
  id: number
  schedule_plan_id: number
  report_date: string | null
  order_no: string | null
  product_code: string | null
  process_type: string | null
  report_qty: number | null
  warehouse_name: string | null
  work_hours: number | null
  unit_price: number | null
  amount: number | null
  is_overflow: boolean
  reporter: string | null
  reported_at: string | null
}

export default function ProductionReports() {
  const [plans, setPlans] = useState<ReportPlan[]>([])
  const [planTotal, setPlanTotal] = useState(0)
  const [planPage, setPlanPage] = useState(1)
  const [planDate, setPlanDate] = useState<Dayjs>(dayjs())
  const [planLoading, setPlanLoading] = useState(false)

  const [reports, setReports] = useState<ReportItem[]>([])
  const [reportTotal, setReportTotal] = useState(0)
  const [reportPage, setReportPage] = useState(1)
  const [reportDate, setReportDate] = useState<Dayjs | null>(null)
  const [reportLoading, setReportLoading] = useState(false)

  const [warehouses, setWarehouses] = useState<{ id: number; wh_name: string }[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [curPlan, setCurPlan] = useState<ReportPlan | null>(null)
  const [reportQty, setReportQty] = useState<number | null>(null)
  const [reportWh, setReportWh] = useState<number | null>(null)
  const [reportHours, setReportHours] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const [draftModal, setDraftModal] = useState<{ open: boolean; date: string | null; data: any }>({ open: false, date: null, data: null })
  const [draftLoading, setDraftLoading] = useState(false)

  const hasPermission = useAuthStore((s) => s.hasPermission)
  const canCreate = hasPermission('production.daily_report', 'create')

  const loadPlans = useCallback(async () => {
    setPlanLoading(true)
    try {
      const params: Record<string, any> = { page: planPage, page_size: 15 }
      params.report_date = planDate.format('YYYY-MM-DD')
      const res: any = await productionApi.reportablePlans(params)
      setPlans(res.data.items || [])
      setPlanTotal(res.data.total || 0)
    } catch {
      setPlans([])
    } finally {
      setPlanLoading(false)
    }
  }, [planPage, planDate])

  const loadReports = useCallback(async () => {
    setReportLoading(true)
    try {
      const params: Record<string, any> = { page: reportPage, page_size: 15 }
      if (reportDate) {
        params.report_date_from = reportDate.format('YYYY-MM-DD')
        params.report_date_to = reportDate.format('YYYY-MM-DD')
      }
      const res: any = await productionApi.listReports(params)
      setReports(res.data.items || [])
      setReportTotal(res.data.total || 0)
    } catch {
      setReports([])
    } finally {
      setReportLoading(false)
    }
  }, [reportPage, reportDate])

  useEffect(() => {
    loadPlans()
    loadReports()
    productionApi.reportVirtualWarehouses().then((res: any) => setWarehouses(res.data || [])).catch(() => {})
  }, [loadPlans, loadReports])

  const openReport = (p: ReportPlan) => {
    setCurPlan(p)
    setReportQty(null)
    setReportWh(warehouses[0]?.id || null)
    setReportHours(null)
    setModalOpen(true)
  }

  const handleSave = async () => {
    if (!curPlan || !reportQty || reportQty <= 0) {
      message.warning('请填写报工数量')
      return
    }
    if (!reportWh) {
      message.warning('请选择入库仓')
      return
    }
    setSaving(true)
    try {
      await productionApi.createReport({
        schedule_plan_id: curPlan.id,
        report_date: dayjs().format('YYYY-MM-DD'),
        report_qty: reportQty,
        warehouse_id: reportWh,
        work_hours: reportHours ?? undefined,
      })
      message.success('报工成功')
      setModalOpen(false)
      loadPlans()
      loadReports()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '报工失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDraft = async (date: Dayjs) => {
    setDraftLoading(true)
    try {
      const res: any = await productionApi.dailyReportDraft({ report_date: date.format('YYYY-MM-DD') })
      setDraftModal({ open: true, date: date.format('YYYY-MM-DD'), data: res.data })
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '生成日报失败')
    } finally {
      setDraftLoading(false)
    }
  }

  const planColumns = [
    { title: '车间', dataIndex: 'department', width: 90, render: (v: string | null) => v || '-' },
    {
      title: '计划日期', dataIndex: 'plan_date', width: 100,
      render: (v: string | null) => v ? dayjs(v).format('MM-DD') : '-',
    },
    { title: '订单号', dataIndex: 'order_no', width: 160 },
    { title: '产品', dataIndex: 'product_code', width: 170 },
    { title: '工序', dataIndex: 'process_type', width: 70, render: (v: string | null) => fmtProcess(v) },
    {
      title: '排产量', dataIndex: 'planned_qty', width: 80, align: 'right' as const,
      render: (v: number) => v || 0,
    },
    {
      title: '已完成', dataIndex: 'completed_qty', width: 80, align: 'right' as const,
      render: (v: number, r: ReportPlan) => {
        const remain = (r.planned_qty || 0) - (r.completed_qty || 0)
        return <span>{v || 0}{remain > 0 ? <span style={{ color: '#999', marginLeft: 4 }}>/剩{remain}</span> : <Tag color="green" style={{ marginLeft: 4 }}>完成</Tag>}</span>
      },
    },
    {
      title: '操作', key: 'action', width: 80, fixed: 'right' as const,
      render: (_: any, r: ReportPlan) => (
        <Button size="small" type="primary" disabled={!canCreate} onClick={() => openReport(r)}>报工</Button>
      ),
    },
  ]

  const reportColumns = [
    { title: '日期', dataIndex: 'report_date', width: 100, render: (v: string | null) => v ? dayjs(v).format('YYYY-MM-DD') : '-' },
    { title: '订单号', dataIndex: 'order_no', width: 160 },
    { title: '产品', dataIndex: 'product_code', width: 170 },
    { title: '工序', dataIndex: 'process_type', width: 70, render: (v: string | null) => fmtProcess(v) },
    {
      title: '报工数', dataIndex: 'report_qty', width: 90, align: 'right' as const,
      render: (v: number | null, r: ReportItem) => (
        <span>{v || 0}{r.is_overflow ? <Tag color="orange" style={{ marginLeft: 4 }}>超额</Tag> : null}</span>
      ),
    },
    { title: '入库仓', dataIndex: 'warehouse_name', width: 90, render: (v: string | null) => v || '-' },
    { title: '工时', dataIndex: 'work_hours', width: 70, render: (v: number | null) => v ?? '-' },
    { title: '单价', dataIndex: 'unit_price', width: 80, align: 'right' as const, render: (v: number | null) => v ?? '-' },
    { title: '金额', dataIndex: 'amount', width: 90, align: 'right' as const, render: (v: number | null) => v != null ? Number(v).toFixed(2) : '-' },
    { title: '报工人', dataIndex: 'reporter', width: 90 },
  ]

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col>
            <span style={{ fontWeight: 600, fontSize: 16 }}>报工管理</span>
          </Col>
          <Col flex="auto" />
          <Col>
            <Space>
              <DatePicker value={draftModal.date ? dayjs(draftModal.date) : null} onChange={() => {}} style={{ width: 150, display: 'none' }} />
              <DatePicker placeholder="选择日期生成日报" onChange={handleDraft} style={{ width: 180 }} />
              <Button icon={<FileSearchOutlined />} onClick={() => setDraftModal({ open: true, date: dayjs().format('YYYY-MM-DD'), data: null })}>查看今日日报草稿</Button>
              <Button icon={<ReloadOutlined />} onClick={() => { loadPlans(); loadReports() }}>刷新</Button>
            </Space>
          </Col>
        </Row>
      </div>

      <TabsBar
        planTab={(
          <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
            <Row gutter={12} align="middle">
              <Col>
                <span style={{ fontWeight: 500, marginRight: 8 }}>报工日期</span>
                <DatePicker value={planDate} onChange={(d) => { if (d) { setPlanDate(d); setPlanPage(1) } }} style={{ width: 150 }} />
                <Button size="small" style={{ marginLeft: 8 }} onClick={() => { setPlanDate(dayjs()); setPlanPage(1) }}>今日</Button>
              </Col>
              <Col>
                <span style={{ color: '#888', fontSize: 13 }}>当日生产完 → 直接在此报工（默认显示今日未完成的计划）</span>
              </Col>
            </Row>
          </div>
        )}
        plansTable={(
          <Table
            rowKey="id"
            dataSource={plans}
            columns={planColumns}
            loading={planLoading}
            size="small"
            scroll={{ x: 1000 }}
            pagination={{ total: planTotal, current: planPage, pageSize: 15, onChange: setPlanPage }}
          />
        )}
        reportsTable={(
          <Table
            rowKey="id"
            dataSource={reports}
            columns={reportColumns}
            loading={reportLoading}
            size="small"
            scroll={{ x: 1000 }}
            pagination={{ total: reportTotal, current: reportPage, pageSize: 15, onChange: setReportPage }}
          />
        )}
      />

      <Modal
        title={`报工 - 订单 ${curPlan?.order_no || ''}`}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        destroyOnClose
      >
        <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
          <Descriptions.Item label="产品">{curPlan?.product_code}</Descriptions.Item>
          <Descriptions.Item label="排产量">{curPlan?.planned_qty || 0}（已完成 {curPlan?.completed_qty || 0}）</Descriptions.Item>
          <Descriptions.Item label="工序">{fmtProcess(curPlan?.process_type || null)}</Descriptions.Item>
          <Descriptions.Item label="计划日期">{curPlan?.plan_date}</Descriptions.Item>
        </Descriptions>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <span style={{ display: 'inline-block', width: 80 }}>报工数量</span>
            <InputNumber value={reportQty} onChange={setReportQty} min={1} style={{ width: 200 }} placeholder="实际完工量" />
          </div>
          <div>
            <span style={{ display: 'inline-block', width: 80 }}>入库仓</span>
            <Select
              value={reportWh}
              onChange={setReportWh}
              style={{ width: 200 }}
              placeholder="选择线边仓/成品仓"
              options={warehouses.map(w => ({ value: w.id, label: w.wh_name }))}
            />
          </div>
          <div>
            <span style={{ display: 'inline-block', width: 80 }}>工时</span>
            <InputNumber value={reportHours} onChange={setReportHours} min={0} precision={1} style={{ width: 200 }} placeholder="可选" />
          </div>
        </Space>
      </Modal>

      <Modal
        title={`日报草稿 - ${draftModal.date || ''}`}
        open={draftModal.open}
        onCancel={() => setDraftModal({ open: false, date: null, data: null })}
        footer={null}
        width={640}
        destroyOnClose
      >
        {!draftModal.data ? (
          <Alert type="info" message="该日期暂无报工记录，无法生成日报草稿" style={{ marginBottom: 8 }} />
        ) : (
          <>
            <Alert
              type="info"
              message={draftModal.data.note || '报工自动汇总草稿'}
              showIcon
              style={{ marginBottom: 12 }}
            />
            <Table
              size="small"
              rowKey="product_code"
              pagination={false}
              dataSource={draftModal.data.draft || []}
              columns={[
                { title: '车间', dataIndex: 'department', render: (v: string | null) => v || '-' },
                { title: '产品', dataIndex: 'product_code', render: (v: string | null) => v || '-' },
                { title: '完工量', dataIndex: 'completed_qty', align: 'right' as const },
                { title: '金额', dataIndex: 'amount', align: 'right' as const, render: (v: number) => Number(v).toFixed(2) },
                { title: '报工数', dataIndex: 'report_count', align: 'right' as const },
              ]}
            />
            <div style={{ marginTop: 12, fontWeight: 600, textAlign: 'right' }}>
              合计：完工 {draftModal.data.total_qty} | 金额 ¥ {draftModal.data.total_amount}
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}

function TabsBar(props: { planTab: React.ReactNode; plansTable: React.ReactNode; reportsTable: React.ReactNode }) {
  return (
    <Tabs
      defaultActiveKey="plans"
      items={[
        { key: 'plans', label: '排产计划报工', children: <>{props.planTab}<div className="card-modern" style={{ padding: '0 0 4px' }}>{props.plansTable}</div></> },
        { key: 'reports', label: '报工记录', children: <div className="card-modern" style={{ padding: '0 0 4px' }}>{props.reportsTable}</div> },
      ]}
    />
  )
}
