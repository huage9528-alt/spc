import { useEffect, useState } from 'react'
import { Alert, Button, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, message } from 'antd'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/production'
import { DEPARTMENTS } from '../SchedulePlans/constants'

interface ScheduleOrderData {
  order_no: string
  line_no: string
  product_code?: string
  product_model?: string
  order_qty?: number
  promised_date?: string
  schedule_bucket?: string
  schedule_bucket_label?: string
  upph?: number
  recommended_daily_hours?: number
  capacity_load_status_label?: string
  needs_sunday_work?: boolean
}

interface ScheduleModalProps {
  open: boolean
  orderData: ScheduleOrderData | null
  onClose: () => void
  onSuccess?: () => void
}

export default function ScheduleModal({ open, orderData, onClose, onSuccess }: ScheduleModalProps) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [workHours, setWorkHours] = useState(8)
  const [workHoursByBucket, setWorkHoursByBucket] = useState<Record<string, number>>({})
  const [readyOffsetDays, setReadyOffsetDays] = useState(2)
  const [leanStandardHours, setLeanStandardHours] = useState(8.5)
  const [leanMaxHours, setLeanMaxHours] = useState(12)

  // 加载工作时间配置
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const res: any = await productionApi.getWorkHoursConfig()
        setWorkHours(res.data?.daily_work_hours || 8)
        setWorkHoursByBucket(res.data?.work_hours_by_bucket || {})
        setReadyOffsetDays(res.data?.ready_offset_days || 2)
        setLeanStandardHours(res.data?.lean_standard_daily_hours || 8.5)
        setLeanMaxHours(res.data?.lean_max_daily_hours || 12)
      } catch {
        // 用默认值
      }
    }
    loadConfig()
  }, [])

  // 打开 Modal 时填表单
  useEffect(() => {
    if (open && orderData) {
      form.resetFields()
      const getRecommendedDailyWorkHours = (bucket?: string | null) => {
        if (bucket && workHoursByBucket[bucket]) return workHoursByBucket[bucket]
        return workHours
      }
      form.setFieldsValue({
        order_no: orderData.order_no,
        line_no: orderData.line_no,
        product_code: orderData.product_code,
        model_code: orderData.product_model,
        quantity: orderData.order_qty,
        promised_date: orderData.promised_date ? dayjs(orderData.promised_date) : null,
        department: '生产',
        plan_date: null,
        upph: (orderData.upph && orderData.upph > 0) ? orderData.upph : undefined,
        daily_work_hours: orderData.schedule_bucket === 'lean'
          ? orderData.recommended_daily_hours
          : getRecommendedDailyWorkHours(orderData.schedule_bucket),
      })
    }
  }, [open, orderData, form, workHours, workHoursByBucket])

  const getRecommendedDailyWorkHours = (bucket?: string | null) => {
    if (bucket && workHoursByBucket[bucket]) return workHoursByBucket[bucket]
    return workHours
  }

  const handleAutoSchedule = async (confirmRisky: boolean = false) => {
    try {
      const values = await form.validateFields()
      const planDate = values.plan_date ? values.plan_date.format('YYYY-MM-DD') : null
      const payload = {
        order_no: values.order_no,
        line_no: values.line_no,
        department: values.department,
        plan_date: planDate,
        upph: orderData?.schedule_bucket === 'lean' ? values.upph : undefined,
        daily_work_hours: values.daily_work_hours ?? undefined,
        owner: values.owner,
        confirm_risky: confirmRisky,
      }
      const res: any = await productionApi.autoSchedule(payload)

      // v2 阶段 4：周日生产/前挪强制人工确认
      if (res.data?.needs_confirm && !confirmRisky) {
        const calcResult = res.data?.calculation_result || {}
        const warningText = res.data?.message || '此排产需要人工确认'
        Modal.confirm({
          title: '⚠ 排产风险确认',
          content: (
            <div>
              <p style={{ color: '#cf1322', fontWeight: 600 }}>{warningText}</p>
              {calcResult.work_hour_summary && <p>{calcResult.work_hour_summary}</p>}
              <p style={{ color: '#595959' }}>确认后将按此方案落库。取消则不排产。</p>
            </div>
          ),
          okText: '确认排产',
          cancelText: '取消',
          okButtonProps: { danger: true },
          onOk: () => handleAutoSchedule(true),
        })
        return
      }

      const result = res.data?.calculation_result || {}
      message.success(res.data?.message || '排产成功')
      form.resetFields()
      onClose()
      onSuccess?.()

      // 弹通知（精简版）
      const descriptionParts: string[] = []
      if (result.schedule_bucket === 'mixed') {
        descriptionParts.push(`组装 ${result.assembly_start_date || '-'} ~ ${result.assembly_end_date || '-'}`)
        descriptionParts.push(`包装 ${result.packaging_start_date || '-'} ~ ${result.packaging_end_date || '-'}`)
      } else if (res.data?.schedule_plan?.plan_date) {
        descriptionParts.push(`计划日 ${res.data.schedule_plan.plan_date}`)
      }
      if (result.work_hour_summary) descriptionParts.push(result.work_hour_summary)
      if (descriptionParts.length > 0) {
        message.info(descriptionParts.join('；'), 5)
      }
    } catch (e: any) {
      if (!e?.errorFields) message.error(e.message || '排产失败')
    } finally {
      setLoading(false)
    }
  }

  if (!orderData) return null

  return (
    <Modal
      title={`单条排产${orderData.schedule_bucket_label ? ` - ${orderData.schedule_bucket_label}` : ''}`}
      open={open}
      destroyOnHidden
      onOk={() => handleAutoSchedule()}
      onCancel={() => { form.resetFields(); onClose() }}
      confirmLoading={loading}
      width={640}
    >
      <Alert
        showIcon
        type="info"
        style={{ marginBottom: 12 }}
        message={orderData.schedule_bucket === 'lean'
          ? `精益会自动试算建议工时：先按 ${leanStandardHours} 小时、必要时加班到 ${leanMaxHours} 小时；当前建议 ${orderData.recommended_daily_hours ? Number(orderData.recommended_daily_hours).toFixed(2) : '-'} 小时/天。`
          : orderData.schedule_bucket === 'mixed'
            ? `当前订单会自动拆成"组装 + 包装"两条计划；包装按组装前一日释放量滚动承接，不再手填 UPPH。`
            : orderData.recommended_daily_hours
              ? `${orderData.schedule_bucket_label || '当前阶段'}会自动试算建议工时；当前建议 ${Number(orderData.recommended_daily_hours).toFixed(2)} 小时/天，当前负荷为 ${orderData.capacity_load_status_label || '正常'}${orderData.needs_sunday_work ? '，已启用周日生产' : ''}。`
              : `系统默认按交期前 ${readyOffsetDays} 天备货完成倒排；当前排产段默认工时 ${getRecommendedDailyWorkHours(orderData.schedule_bucket)} 小时/天，UPPH按明细单价汇总自动计算。`}
      />
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col span={12}><Form.Item name="order_no" label="订单号"><Input disabled /></Form.Item></Col>
          <Col span={12}><Form.Item name="line_no" label="行号"><Input disabled /></Form.Item></Col>
          <Col span={12}><Form.Item name="product_code" label="产品编码"><Input disabled /></Form.Item></Col>
          <Col span={12}><Form.Item name="model_code" label="型号"><Input disabled /></Form.Item></Col>
          <Col span={12}><Form.Item name="quantity" label="数量"><InputNumber disabled style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={12}><Form.Item name="promised_date" label="交期"><DatePicker disabled style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={12}>
            <Form.Item name="department" label="部门" rules={[{ required: true }]}>
              <Select options={DEPARTMENTS.map((item) => ({ value: item, label: item }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="plan_date" label="计划日期（留空则按倒排开始日）">
              <DatePicker style={{ width: '100%' }} placeholder="不填则系统自动倒排" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="upph"
              label="UPPH"
              rules={orderData.schedule_bucket === 'lean' ? [{ required: true, type: 'number', min: 0.001 }] : []}
            >
              <InputNumber min={0.001} disabled={orderData.schedule_bucket !== 'lean'} style={{ width: '100%' }} placeholder={orderData.schedule_bucket === 'lean' ? '' : '装配由系统自动计算'} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="daily_work_hours" label="每日工时（可留空自动）">
              <InputNumber min={1} max={24} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={24}><Form.Item name="owner" label="负责人"><Input /></Form.Item></Col>
        </Row>
      </Form>
    </Modal>
  )
}
