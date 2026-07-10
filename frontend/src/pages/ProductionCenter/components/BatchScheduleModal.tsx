import { useEffect, useState } from 'react'
import { Alert, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Table, message } from 'antd'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/production'
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
  }, [])

  // 打开时填默认值
  useEffect(() => {
    if (open && orderRows.length > 0) {
      form.resetFields()
      const uniqueBuckets = Array.from(new Set(orderRows.map((r) => r.schedule_bucket).filter(Boolean)))
      const getRecommendedDailyWorkHours = (bucket?: string | null) => {
        if (bucket && workHoursByBucket[bucket]) return workHoursByBucket[bucket]
        return workHours
      }
      form.setFieldsValue({
        department: '生产',
        plan_date: null,
        daily_work_hours: uniqueBuckets.length === 1 && uniqueBuckets[0] !== 'lean'
          ? getRecommendedDailyWorkHours(uniqueBuckets[0])
          : undefined,
      })
    }
  }, [open, orderRows, form, workHours, workHoursByBucket])

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
        message.warning(`批量排产完成：成功 ${successCount} 条，失败 ${failedCount} 条`)
        failedItems.slice(0, 3).forEach((item: any) => {
          message.error(`${item.order_no}/${item.line_no}: ${item.message}`, 5)
        })
      } else {
        message.success(`批量排产完成：成功 ${successCount} 条`)
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

  return (
    <Modal
      title={`批量排产（${schedulableRows.length} 条）`}
      open={open}
      destroyOnHidden
      onOk={handleBatchSchedule}
      onCancel={() => { form.resetFields(); onClose() }}
      confirmLoading={loading}
      width={720}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert showIcon type="info" message={`仅勾选"可排产"的订单会执行批量排产，后端会统一处理并返回失败原因；精益默认自动试算工时，先按 ${leanStandardHours} 小时、必要时加班到 ${leanMaxHours} 小时。`} />
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
