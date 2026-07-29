import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Col, DatePicker, Form, Input, InputNumber, Modal, Progress, Row, Select, Switch, Tag, message } from 'antd'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/production'
import { useBaseConditionStore } from '../../../store/baseCondition'
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
  const { items: baseConditions, getItem, load: loadBaseConditions } = useBaseConditionStore()
  // 产能预览
  const [capacityUsage, setCapacityUsage] = useState<Array<{
    date: string; capacity: number; booked: number; available: number; utilization: number
  }> | null>(null)
  const [capacityLoading, setCapacityLoading] = useState(false)

  // 加载工作时间配置（工时相关字段还要走原接口；基础条件走 store 避免 4 个弹窗重复拉）
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
    loadBaseConditions()
  }, [loadBaseConditions])

  // 打开 Modal 时填表单
  useEffect(() => {
    if (open && orderData) {
      form.resetFields()
      const getRecommendedDailyWorkHours = (bucket?: string | null) => {
        if (bucket && workHoursByBucket[bucket]) return workHoursByBucket[bucket]
        return workHours
      }
      const base = getItem(orderData.schedule_bucket)
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
        manpower: base?.default_manpower ?? 10,
        // 预填工时：基础条件为准（保持空的话后端会自动试算）
        // Alert 里显示后端试算建议值作为提醒，让用户决定要不要改
        daily_work_hours: base?.daily_work_hours
          ?? (orderData.schedule_bucket === 'lean'
            ? undefined  // 精益基础条件空时，留空让后端试算
            : getRecommendedDailyWorkHours(orderData.schedule_bucket)),
        include_sunday: base?.include_sunday ?? false,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderData, form, workHours, workHoursByBucket, baseConditions])

  const getRecommendedDailyWorkHours = (bucket?: string | null) => {
    if (bucket && workHoursByBucket[bucket]) return workHoursByBucket[bucket]
    return workHours
  }

  // 监听人数/工时/数量/交期变化, 拉产能预览
  const formData = Form.useWatch([], form)
  useEffect(() => {
    if (!open || !orderData) return
    const bucket = orderData.schedule_bucket
    if (!bucket || !orderData.promised_date) {
      setCapacityUsage(null)
      return
    }
    const manpower = formData?.manpower || 10
    const dailyHours = formData?.daily_work_hours || getRecommendedDailyWorkHours(bucket)
    const endDate = dayjs(orderData.promised_date).subtract(readyOffsetDays, 'day')
    const startDate = endDate.subtract(30, 'day')
    let cancelled = false
    const fetchCapacity = async () => {
      setCapacityLoading(true)
      try {
        const res: any = await productionApi.getCapacityUsage({
          department: formData?.department || '生产',
          schedule_bucket: bucket === 'mixed' ? 'assembly' : bucket,
          start_date: startDate.format('YYYY-MM-DD'),
          end_date: endDate.format('YYYY-MM-DD'),
          daily_capacity: dailyHours,
        })
        if (!cancelled) setCapacityUsage(res.data || [])
      } catch {
        if (!cancelled) setCapacityUsage(null)
      } finally {
        if (!cancelled) setCapacityLoading(false)
      }
    }
    fetchCapacity()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderData, formData?.department, formData?.manpower, formData?.daily_work_hours, readyOffsetDays])

  // 计算订单总工时和预计占槽
  const schedulePreview = useMemo(() => {
    if (!orderData || !formData) return null
    const qty = Number(formData.quantity || orderData.order_qty || 0)
    const upph = Number(formData.upph || orderData.upph || 0)
    const mp = Number(formData.manpower || 10)
    const dailyHours = Number(formData?.daily_work_hours || getRecommendedDailyWorkHours(orderData.schedule_bucket) || 8.5)
    if (qty <= 0 || upph <= 0 || mp <= 0) return null
    const totalHours = qty / (upph * mp)
    const daysNeeded = Math.max(1, Math.ceil(totalHours / dailyHours))
    const dailyCapacity = upph * mp * dailyHours
    return { qty, upph, mp, dailyHours, totalHours, daysNeeded, dailyCapacity }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData?.quantity, formData?.upph, formData?.manpower, formData?.daily_work_hours, orderData])

  const handleAutoSchedule = async (confirmRisky: boolean = false) => {
    if (loading) return  // 防重复点击
    try {
      const values = await form.validateFields()
      const planDate = values.plan_date ? values.plan_date.format('YYYY-MM-DD') : null
      const payload = {
        order_no: values.order_no,
        line_no: values.line_no,
        department: values.department,
        plan_date: planDate,
        upph: orderData?.schedule_bucket === 'lean' ? values.upph : undefined,
        manpower: values.manpower || undefined,
        daily_work_hours: values.daily_work_hours ?? undefined,
        include_sunday: values.include_sunday ?? undefined,
        owner: values.owner,
        confirm_risky: confirmRisky,
      }
      setLoading(true)
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
          onOk: () => {
            setLoading(false)
            handleAutoSchedule(true)
          },
          onCancel: () => setLoading(false),
        })
        return
      }

      const result = res.data?.calculation_result || {}
      message.success(res.data?.message || '排产成功', 3)
      // 让用户看到成功提示再关弹窗
      setTimeout(() => {
        form.resetFields()
        onClose()
        onSuccess?.()
      }, 800)

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
          <Col span={12}><Form.Item name="promised_date" label="出货计划"><DatePicker disabled style={{ width: '100%' }} /></Form.Item></Col>
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
          <Col span={8}>
            <Form.Item
              name="upph"
              label="UPPH(每人每小时)"
              rules={orderData.schedule_bucket === 'lean' ? [{ required: true, type: 'number', min: 0.001 }] : []}
            >
              <InputNumber min={0.001} disabled={orderData.schedule_bucket !== 'lean'} style={{ width: '100%' }} placeholder={orderData.schedule_bucket === 'lean' ? '' : '装配由系统自动计算'} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="manpower"
              label="班组人数"
              tooltip="默认 10 人, 改后日产能 = UPPH × 人数 × 当日工时"
              rules={[{ required: true, type: 'number', min: 1, message: '人数必须 ≥ 1' }]}
            >
              <InputNumber min={1} max={200} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="daily_work_hours" label="每日工时">
              <InputNumber min={1} max={24} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="include_sunday" label="周日排产" valuePropName="checked">
              <Switch checkedChildren="开" unCheckedChildren="关" />
            </Form.Item>
          </Col>
          <Col span={24}><Form.Item name="owner" label="负责人"><Input /></Form.Item></Col>
        </Row>

        {/* 产能预览 */}
        {schedulePreview && (
          <div style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 6 }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: '#1677ff' }}>
              📊 产能预览(改参数实时更新)
            </div>
            <div style={{ fontSize: 13, color: '#595959', marginBottom: 8 }}>
              订单 <b>{schedulePreview.qty}</b> 件, UPPH <b>{schedulePreview.upph.toFixed(2)}</b> 件/人·小时,{' '}
              <b>{schedulePreview.mp}</b> 人
              <span style={{ marginLeft: 12 }}>
                → 总工时 <b style={{ color: schedulePreview.totalHours <= 8.5 ? '#52c41a' : '#fa541c' }}>{schedulePreview.totalHours.toFixed(2)}h</b>,
                需要 <b style={{ color: '#fa541c' }}>{schedulePreview.daysNeeded}</b> 天
                {schedulePreview.totalHours <= 8.5 && schedulePreview.daysNeeded === 1 && (
                  <span style={{ color: '#52c41a', marginLeft: 8 }}>
                    (单天 {schedulePreview.totalHours.toFixed(2)}h 即可, 剩 {(schedulePreview.dailyHours - schedulePreview.totalHours).toFixed(2)}h 空余)
                  </span>
                )}
              </span>
            </div>

            {/* 该工段最近 15 天的占用情况 */}
            {capacityLoading && <div style={{ color: '#888', fontSize: 12 }}>加载产能日历...</div>}
            {!capacityLoading && capacityUsage && capacityUsage.length > 0 && (
              <div>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                  {orderData.schedule_bucket === 'mixed' ? '组装段' : ''}最近 15 天产能占用(点击可放大):
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', fontSize: 11 }}>
                  {capacityUsage.slice(-15).map((u) => {
                    const pct = Math.round(u.utilization * 100)
                    const color = pct >= 100 ? '#ff4d4f' : pct >= 80 ? '#fa8c16' : pct > 0 ? '#52c41a' : '#d9d9d9'
                    return (
                      <Tag
                        key={u.date}
                        style={{ marginBottom: 4, fontSize: 11, padding: '2px 6px' }}
                        color={pct === 0 ? 'default' : (pct >= 100 ? 'red' : pct >= 80 ? 'orange' : 'green')}
                        title={`${u.date}: 已占 ${u.booked}h / ${u.capacity}h, 剩 ${u.available}h`}
                      >
                        {u.date.slice(5)} · {u.booked.toFixed(1)}/{u.capacity}h
                      </Tag>
                    )
                  })}
                </div>
                <div style={{ marginTop: 6, color: '#888', fontSize: 11 }}>
                  绿=有空位 · 橙=紧张 · 红=已满. 本订单会自动占用空位.
                </div>
              </div>
            )}
          </div>
        )}
      </Form>
    </Modal>
  )
}
