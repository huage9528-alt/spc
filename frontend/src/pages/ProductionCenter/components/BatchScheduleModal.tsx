import { useEffect, useState } from 'react'
import { Alert, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Switch, Table, message } from 'antd'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/production'
import { useBaseConditionStore } from '../../../store/baseCondition'
import { DEPARTMENTS } from '../SchedulePlans/constants'
import { renderBucketTag, renderCopyableText } from '../SchedulePlans/helpers'

interface BatchOrderRow {
  order_no: string
  line_no: string
  schedule_bucket?: string
  schedule_bucket_label?: string
  bom_no?: string
  order_qty?: number
  upph?: number
  todo_kind?: string
}

interface BatchScheduleModalProps {
  open: boolean
  orderRows: BatchOrderRow[]
  onClose: () => void
  onSuccess?: () => void
}

export default function BatchScheduleModal({ open, orderRows, onClose, onSuccess }: BatchScheduleModalProps) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [leanStandardHours, setLeanStandardHours] = useState(8.5)
  const [leanMaxHours, setLeanMaxHours] = useState(12)
  const [workHours, setWorkHours] = useState(8)
  const [workHoursByBucket, setWorkHoursByBucket] = useState<Record<string, number>>({})
  const { items: baseConditions, getItem, load: loadBaseConditions } = useBaseConditionStore()

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const res: any = await productionApi.getWorkHoursConfig()
        setWorkHours(res.data?.daily_work_hours || 8)
        setWorkHoursByBucket(res.data?.work_hours_by_bucket || {})
        setLeanStandardHours(res.data?.lean_standard_daily_hours || 8.5)
        setLeanMaxHours(res.data?.lean_max_daily_hours || 12)
      } catch {
        // 用默认值
      }
    }
    loadConfig()
    loadBaseConditions()
  }, [loadBaseConditions])

  // 打开时填默认值
  useEffect(() => {
    if (open && orderRows.length > 0) {
      form.resetFields()
      const rawBuckets = Array.from(new Set(orderRows.map((r) => r.schedule_bucket).filter(Boolean))) as string[]
      // mixed 本质 = 组装+包装 两段独立计划，预填逻辑里也展开判断
      // 真正只有 1 种工序段时才预填；只要涉及多段就留空（让后端按各自基础条件排）
      const realBuckets: string[] = []
      for (const b of rawBuckets) {
        if (b === 'mixed') {
          if (!realBuckets.includes('assembly')) realBuckets.push('assembly')
          if (!realBuckets.includes('packaging')) realBuckets.push('packaging')
        } else if (!realBuckets.includes(b)) {
          realBuckets.push(b)
        }
      }
      const getRecommendedDailyWorkHours = (bucket?: string | null) => {
        if (bucket && workHoursByBucket[bucket]) return workHoursByBucket[bucket]
        return workHours
      }
      // 单一阶段时用该阶段的基础条件预填；多阶段留空让后端各自走默认
      const singleBucket: string | null = realBuckets.length === 1 ? (realBuckets[0] as string) : null
      const base = singleBucket ? getItem(singleBucket) : null
      form.setFieldsValue({
        department: '生产',
        plan_date: null,
        manpower: base?.default_manpower ?? undefined,
        daily_work_hours: singleBucket
          ? (base?.daily_work_hours ?? getRecommendedDailyWorkHours(singleBucket))
          : undefined,
        include_sunday: base?.include_sunday ?? undefined,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderRows, form, workHours, workHoursByBucket, baseConditions])

  const handleBatchSchedule = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)
      const planDate = values.plan_date ? values.plan_date.format('YYYY-MM-DD') : null
      const schedulableRows = orderRows.filter((row) => row.todo_kind === 'ready')
      const res: any = await productionApi.batchAutoSchedule({
        department: values.department,
        plan_date: planDate,
        daily_work_hours: values.daily_work_hours ?? undefined,
        manpower: values.manpower || undefined,
        include_sunday: values.include_sunday ?? undefined,
        owner: values.owner,
        items: schedulableRows.map((row) => ({
          order_no: row.order_no,
          line_no: row.line_no,
          upph: row.schedule_bucket === 'lean' ? row.upph : undefined,
        })),
      })
      const result = res.data || {}
      const failedItems = Array.isArray(result.items) ? result.items.filter((item: any) => !item.success) : []
      const successCount = result.success_count || 0
      const failedCount = result.failed_count || 0

      if (failedCount > 0) {
        message.warning(`批量排产完成：成功 ${successCount} 条，失败 ${failedCount} 条`, 6)
        failedItems.slice(0, 3).forEach((item: any) => {
          message.error(`${item.order_no}/${item.line_no}: ${item.message}`, 8)
        })
      } else {
        message.success(`批量排产完成：成功 ${successCount} 条`, 4)
      }
      form.resetFields()
      onClose()
      onSuccess?.()
    } catch (e: any) {
      if (!e?.errorFields) message.error(e.message || '批量排产失败')
    } finally {
      setLoading(false)
    }
  }

  // 只显示"待排产"的行
  const schedulableRows = orderRows.filter((row) => row.todo_kind === 'ready')
  // 混合订单数 (每条 mixed 排产比 lean 慢 5-10 倍, 用于估算耗时)
  const mixedCount = schedulableRows.filter((r) => r.schedule_bucket === 'mixed').length
  const leanCount = schedulableRows.filter((r) => r.schedule_bucket === 'lean').length
  const otherCount = schedulableRows.length - mixedCount - leanCount
  // 粗略估算: lean ~1s, mixed ~6s, 其他 ~3s
  const estimatedSeconds = leanCount * 1 + otherCount * 3 + mixedCount * 6

  return (
    <Modal
      title={`批量排产（${schedulableRows.length} 条）`}
      open={open}
      destroyOnHidden
      onOk={handleBatchSchedule}
      onCancel={() => { if (!loading) { form.resetFields(); onClose() } }}
      cancelButtonProps={{ disabled: loading }}
      okText={loading ? '排产中…请勿关闭' : '确定排产'}
      confirmLoading={loading}
      width={720}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert showIcon type="info" message={`仅勾选"可排产"的订单会执行批量排产，后端会统一处理并返回失败原因；精益默认自动试算工时，先按 ${leanStandardHours} 小时、必要时加班到 ${leanMaxHours} 小时。`} />
        {loading ? (
          <Alert
            showIcon
            type="warning"
            message="正在批量排产中…"
            description={
              <div>
                <div>后端正在逐条排产，每条订单约 1-6 秒（混合订单较慢），请耐心等待。</div>
                <div style={{ marginTop: 4, color: '#8c8c8c', fontSize: 12 }}>
                  预计总耗时约 {Math.ceil(estimatedSeconds / 5) * 5} 秒（{leanCount}精益 + {mixedCount}混合 + {otherCount}其他）。
                  请勿关闭弹窗或刷新页面。
                </div>
              </div>
            }
          />
        ) : null}
        {(() => {
          const schedulableRows2 = orderRows.filter((row) => row.todo_kind === 'ready')
          const rawBuckets = Array.from(new Set(schedulableRows2.map((r) => r.schedule_bucket).filter(Boolean))) as string[]
          // mixed 订单本质上 = 组装 + 包装 两条独立计划，展示时把 mixed 展开成 assembly + packaging
          // 这样工人看到的始终是真实的工序段（精益/组装/包装），不会出现"混合"这种虚拟分类
          const expandedBuckets: string[] = []
          for (const b of rawBuckets) {
            if (b === 'mixed') {
              if (!expandedBuckets.includes('assembly')) expandedBuckets.push('assembly')
              if (!expandedBuckets.includes('packaging')) expandedBuckets.push('packaging')
            } else if (!expandedBuckets.includes(b)) {
              expandedBuckets.push(b)
            }
          }
          // 多阶段：显示各自的基础条件，让用户知道每条会按什么排
          if (expandedBuckets.length > 1) {
            const lines = expandedBuckets.map((b) => {
              const base = getItem(b)
              const label = base?.bucket_label || b
              const mp = base?.default_manpower ?? 10
              const hours = base?.daily_work_hours ?? 8
              const sunday = base?.include_sunday ? '、周日开' : ''
              return `${label} ${mp}人/${hours}h${sunday}`
            })
            return (
              <Alert
                showIcon
                type="warning"
                message="选中订单涉及多个排产阶段，工时/周日将按各自基础条件排产"
                description={lines.join('　·　')}
              />
            )
          }
          return null
        })()}
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="department" label="部门" rules={[{ required: true }]}>
                <Select options={DEPARTMENTS.map((item) => ({ value: item, label: item }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="plan_date" label="计划日期（留空则按倒排开始日）">
                <DatePicker style={{ width: '100%' }} placeholder="不填则系统自动倒排" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="daily_work_hours" label="每日工时（留空则按订单自动试算）">
                <InputNumber min={1} max={24} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="manpower" label="班组人数（留空按基础条件）">
                <InputNumber min={1} max={200} style={{ width: '100%' }} placeholder="留空走默认" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="include_sunday" label="周日排产" valuePropName="checked">
                <Switch checkedChildren="开" unCheckedChildren="关" />
              </Form.Item>
            </Col>
            <Col span={24}><Form.Item name="owner" label="负责人"><Input placeholder="可选，批量写入负责人" /></Form.Item></Col>
          </Row>
        </Form>
        <Table
          rowKey={(row: any) => `${row.order_no}-${row.line_no}`}
          size="small"
          pagination={false}
          dataSource={schedulableRows}
          columns={[
            { title: '订单号', dataIndex: 'order_no', width: 150, render: (v: string) => renderCopyableText(v, '订单号') },
            { title: '行号', dataIndex: 'line_no', width: 90, render: (v: string) => renderCopyableText(v, '行号') },
            { title: '排产段', width: 110, render: (_: any, row: any) => renderBucketTag(row) },
            { title: 'BOM编码', dataIndex: 'bom_no', width: 180, render: (v: string) => renderCopyableText(v, 'BOM编码') },
            { title: '数量', dataIndex: 'order_qty', width: 90, render: (v: number) => v ?? '-' },
            { title: 'UPPH', dataIndex: 'upph', width: 90, render: (v: number) => v ? Number(v).toFixed(2) : '-' },
          ]}
          scroll={{ x: 900, y: 280 }}
        />
      </Space>
    </Modal>
  )
}
