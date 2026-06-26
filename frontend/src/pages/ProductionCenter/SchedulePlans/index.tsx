import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Badge, Button, Col, DatePicker, Empty, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Tooltip, message, notification } from 'antd'
import { ArrowUpOutlined, CheckCircleOutlined, ClockCircleOutlined, DeleteOutlined, EditOutlined, ExclamationCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, ThunderboltOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/api'
import { formatDate, formatDateTime } from '../../../utils'

const CopyableText = ({ value, label = '内容' }: { value?: string | number | null; label?: string }) => {
  const [copied, setCopied] = useState(false)

  if (value === null || value === undefined || value === '') {
    return '-'
  }

  const handleCopy = async () => {
    const text = String(value).trim()
    if (!text) {
      message.warning(`没有可复制的${label}`)
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      message.success(`已复制${label}`)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      message.error(`复制${label}失败，请手动复制`)
    }
  }

  return (
    <Tooltip title={copied ? `${label}已复制` : `点击复制${label}`}>
      <span
        role="button"
        tabIndex={0}
        onClick={handleCopy}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            handleCopy()
          }
        }}
        style={{
          display: 'inline-block',
          maxWidth: '100%',
          cursor: 'copy',
          userSelect: 'text',
          color: copied ? '#389e0d' : '#1677ff',
          background: copied ? '#f6ffed' : 'transparent',
          borderRadius: 6,
          padding: '1px 6px',
          lineHeight: 1.6,
          textDecoration: copied ? 'none' : 'underline',
          textDecorationStyle: 'dotted',
          textUnderlineOffset: 3,
          transition: 'all 0.2s ease',
        }}
      >
        {value}
      </span>
    </Tooltip>
  )
}

const DEPARTMENTS = ['计划', '采购', '生产', '品质', '仓储']

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  planned: { label: '已计划', color: 'blue' },
  in_progress: { label: '执行中', color: 'processing' },
  completed: { label: '已完成', color: 'success' },
  delayed: { label: '延期', color: 'warning' },
  cancelled: { label: '已取消', color: 'default' },
}

const PRIORITY_MAP: Record<string, { label: string; color: string }> = {
  low: { label: '低', color: 'default' },
  normal: { label: '普通', color: 'blue' },
  high: { label: '高', color: 'orange' },
  urgent: { label: '紧急', color: 'red' },
}

const RISK_MAP: Record<string, { label: string; color: string }> = {
  red: { label: '红色', color: 'red' },
  yellow: { label: '黄色', color: 'gold' },
  blue: { label: '蓝色', color: 'blue' },
  green: { label: '绿色', color: 'green' },
}

const IMPACT_MAP: Record<string, { label: string; color: string }> = {
  high: { label: '高', color: 'red' },
  medium: { label: '中', color: 'orange' },
  low: { label: '低', color: 'blue' },
}

const DELIVERY_STATUS_MAP: Record<string, { label: string; color: string }> = {
  delayed: { label: '已延期', color: 'red' },
  upcoming: { label: '临期', color: 'orange' },
  normal: { label: '正常', color: 'green' },
  early: { label: '提前', color: 'blue' },
  unknown: { label: '待确认', color: 'default' },
}

const OPERATION_TYPE_MAP: Record<string, string> = {
  create: '创建排产',
  update: '更新排产',
  delete: '删除排产',
  reschedule: '单条重排',
  batch_reschedule: '批量重排',
  check_changes: '检测变更',
}

export default function SchedulePlans() {
  const [activeTab, setActiveTab] = useState('orders')
  const [department, setDepartment] = useState(DEPARTMENTS[0])
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<string | undefined>()
  const [dateRange, setDateRange] = useState<[string, string] | null>(null)
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [selectedOrder, setSelectedOrder] = useState<any>(null)
  const [form] = Form.useForm()
  const [scheduleForm] = Form.useForm()
  const [year, setYear] = useState(dayjs().year())
  const [month, setMonth] = useState(dayjs().month() + 1)
  const [riskLevel, setRiskLevel] = useState<string | undefined>()
  const [onlyUnscheduled, setOnlyUnscheduled] = useState(false)
  const [orderData, setOrderData] = useState<any[]>([])
  const [orderTotal, setOrderTotal] = useState(0)
  const [orderPage, setOrderPage] = useState(1)
  const [workHours, setWorkHours] = useState(8)
  const [impactData, setImpactData] = useState<any[]>([])
  const [impactTotal, setImpactTotal] = useState(0)
  const [impactPage, setImpactPage] = useState(1)
  const [impactLevel, setImpactLevel] = useState<string | undefined>()
  const [selectedImpactKeys, setSelectedImpactKeys] = useState<number[]>([])
  const [batchPreviewOpen, setBatchPreviewOpen] = useState(false)
  const [missingUpphData, setMissingUpphData] = useState<any[]>([])
  const [missingUpphEmptyState, setMissingUpphEmptyState] = useState<any>(null)
  const [operationLogData, setOperationLogData] = useState<any[]>([])
  const [operationLogTotal, setOperationLogTotal] = useState(0)
  const [operationLogPage, setOperationLogPage] = useState(1)
  const [operationLogModalOpen, setOperationLogModalOpen] = useState(false)
  const [operationType, setOperationType] = useState<string | undefined>()
  const [logKeyword, setLogKeyword] = useState('')
  const [logOperator, setLogOperator] = useState('')
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({
    reschedule_needed: 0,
    capacity_impact: 0,
    missing_upph: 0,
  })

  const loadPlans = useCallback(async () => {
    if (!['active_plans', 'reschedule_needed', 'history_plans'].includes(activeTab)) return
    setLoading(true)
    try {
      const params: Record<string, any> = { page, page_size: pageSize, department }
      if (keyword.trim()) params.keyword = keyword.trim()
      if (status) params.status = status
      if (dateRange) {
        params.date_start = dateRange[0]
        params.date_end = dateRange[1]
      }
      
      if (activeTab === 'active_plans') {
        params.is_active = true
        params.needs_reschedule = false
      } else if (activeTab === 'reschedule_needed') {
        params.is_active = true
        params.needs_reschedule = true
      } else if (activeTab === 'history_plans') {
        params.is_active = false
      }

      const res: any = await productionApi.listSchedulePlans(params)
      setData(res.data.items || [])
      setTotal(res.data.total || 0)
    } catch (e: any) {
      message.error(e.message || '获取计划排产失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, dateRange, department, keyword, page, pageSize, status])

  const loadOrders = useCallback(async () => {
    if (activeTab !== 'orders') return
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page: orderPage,
        page_size: pageSize,
        year,
        month,
        only_unscheduled: onlyUnscheduled,
      }
      if (keyword.trim()) params.keyword = keyword.trim()
      if (riskLevel) params.risk_level = riskLevel
      const res: any = await productionApi.getOrdersForScheduling(params)
      setOrderData(res.data.items || [])
      setOrderTotal(res.data.total || 0)
    } catch (e: any) {
      message.error(e.message || '获取订单列表失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, keyword, month, onlyUnscheduled, orderPage, pageSize, riskLevel, year])

  const loadWorkHours = useCallback(async () => {
    try {
      const res: any = await productionApi.getWorkHoursConfig()
      setWorkHours(res.data?.daily_work_hours || 8)
    } catch (e: any) {
      console.error('获取工作时间配置失败', e)
    }
  }, [])

  const loadImpactPlans = useCallback(async () => {
    if (activeTab !== 'capacity_impact') return
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page: impactPage,
        page_size: pageSize,
        department,
      }
      if (keyword.trim()) params.keyword = keyword.trim()
      if (impactLevel) params.impact_level = impactLevel
      const res: any = await productionApi.listUpphImpactPlans(params)
      setImpactData(res.data.items || [])
      setImpactTotal(res.data.total || 0)
    } catch (e: any) {
      message.error(e.message || '获取产能变更影响失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, department, impactLevel, impactPage, keyword, pageSize])

  const loadMissingUpphProducts = useCallback(async () => {
    if (activeTab !== 'missing_upph') return
    setLoading(true)
    try {
      const params: Record<string, any> = { year, month }
      if (keyword.trim()) params.keyword = keyword.trim()
      const res: any = await productionApi.listMissingUpphProducts(params)
      setMissingUpphData(res.data?.items || [])
      setMissingUpphEmptyState(res.data?.empty_state || null)
    } catch (e: any) {
      message.error(e.message || '获取缺少UPPH的产品失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, keyword, month, year])

  const loadOperationLogs = useCallback(async () => {
    if (!operationLogModalOpen) return
    setLoading(true)
    try {
      const params: Record<string, any> = {
        page: operationLogPage,
        page_size: pageSize,
      }
      if (logKeyword.trim()) params.order_no = logKeyword.trim()
      if (logOperator.trim()) params.operator = logOperator.trim()
      if (operationType) params.operation_type = operationType
      const res: any = await productionApi.listOperationLogs(params)
      setOperationLogData(res.data?.items || [])
      setOperationLogTotal(res.data?.total || 0)
    } catch (e: any) {
      message.error(e.message || '获取操作日志失败')
    } finally {
      setLoading(false)
    }
  }, [logKeyword, logOperator, operationLogModalOpen, operationLogPage, operationType, pageSize])

  const loadTabCounts = useCallback(async () => {
    try {
      const [rescheduleRes, impactRes, missingRes] = await Promise.all([
        productionApi.listSchedulePlans({ page: 1, page_size: 1, is_active: true, needs_reschedule: true }),
        productionApi.listUpphImpactPlans({ page: 1, page_size: 1 }),
        productionApi.listMissingUpphProducts({ year, month }),
      ])
      setTabCounts({
        reschedule_needed: rescheduleRes.data?.total || 0,
        capacity_impact: impactRes.data?.total || 0,
        missing_upph: missingRes.data?.items?.length || 0,
      })
    } catch (e) {
      console.error('获取页签数量失败', e)
    }
  }, [month, year])

  useEffect(() => {
    if (activeTab === 'orders') loadOrders()
    else if (activeTab === 'capacity_impact') loadImpactPlans()
    else if (activeTab === 'missing_upph') loadMissingUpphProducts()
    else loadPlans()
  }, [activeTab, loadImpactPlans, loadMissingUpphProducts, loadOrders, loadPlans])

  useEffect(() => { loadWorkHours() }, [loadWorkHours])
  useEffect(() => { loadTabCounts() }, [loadTabCounts])
  useEffect(() => {
    if (operationLogModalOpen) loadOperationLogs()
  }, [loadOperationLogs, operationLogModalOpen])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ department, plan_date: dayjs(), priority: 'normal', status: 'planned', daily_work_hours: workHours })
    setModalOpen(true)
  }

  const openEdit = (row: any) => {
    setEditing(row)
    form.setFieldsValue({
      ...row,
      plan_date: row.plan_date ? dayjs(row.plan_date) : null,
      start_date: row.start_date ? dayjs(row.start_date) : null,
      end_date: row.end_date ? dayjs(row.end_date) : null,
    })
    setModalOpen(true)
  }

  const openSchedule = (row: any) => {
    setSelectedOrder(row)
    scheduleForm.resetFields()
    const upph = row.upph > 0 ? row.upph : undefined
    scheduleForm.setFieldsValue({
      order_no: row.order_no,
      line_no: row.line_no,
      product_code: row.product_code,
      model_code: row.product_model,
      quantity: row.order_qty,
      promised_date: row.promised_date ? dayjs(row.promised_date) : null,
      department: '生产',
      plan_date: dayjs(),
      upph,
      daily_work_hours: workHours,
    })
    setScheduleModalOpen(true)
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      const payload = {
        ...values,
        plan_date: values.plan_date ? values.plan_date.format('YYYY-MM-DD') : null,
        start_date: values.start_date ? values.start_date.format('YYYY-MM-DD') : null,
        end_date: values.end_date ? values.end_date.format('YYYY-MM-DD') : null,
      }
      if (editing) {
        await productionApi.updateSchedulePlan(editing.id, payload)
        message.success('更新成功')
      } else {
        await productionApi.createSchedulePlan(payload)
        message.success('创建成功')
      }
      setModalOpen(false)
      loadPlans()
    } catch (e: any) {
      if (!e?.errorFields) message.error(e.message || '保存失败')
    }
  }

  const handleAutoSchedule = async () => {
    try {
      const values = await scheduleForm.validateFields()
      const payload = {
        order_no: values.order_no,
        line_no: values.line_no,
        department: values.department,
        plan_date: values.plan_date ? values.plan_date.format('YYYY-MM-DD') : null,
        upph: values.upph,
        daily_work_hours: values.daily_work_hours,
        owner: values.owner,
      }
      const res: any = await productionApi.autoSchedule(payload)
      if (res.data?.success) {
        const result = res.data.calculation_result || {}
        message.success(res.data.message || '排产成功')
        if (result.total_hours) {
          message.info(`总工时: ${result.total_hours}小时, 需要: ${result.days_needed}天`)
        }
      }
      setScheduleModalOpen(false)
      loadOrders()
      if (['active_plans', 'reschedule_needed', 'history_plans'].includes(activeTab)) loadPlans()
      loadTabCounts()
    } catch (e: any) {
      message.error(e.message || '排产失败')
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await productionApi.deleteSchedulePlan(id)
      message.success('删除成功')
      loadPlans()
      loadTabCounts()
    } catch (e: any) {
      message.error(e.message || '删除失败')
    }
  }

  const handleDetectChanges = async () => {
    setLoading(true)
    try {
      const res: any = await productionApi.detectScheduleChanges()
      if (res.data && res.data.length > 0) {
        message.info(`检测到 ${res.data.length} 条订单行变更，已标记待重排。`)
      } else {
        message.info('未检测到订单行变更。')
      }
      loadPlans()
      loadTabCounts()
    } catch (e: any) {
      message.error(e.message || '检测变更失败')
    } finally {
      setLoading(false)
    }
  }

  const handleReschedule = async (id: number) => {
    setLoading(true)
    try {
      await productionApi.reschedulePlan(id)
      message.success('重排成功！')
      loadPlans()
      loadImpactPlans()
      loadTabCounts()
    } catch (e: any) {
      message.error(e.message || '重排失败')
    } finally {
      setLoading(false)
    }
  }

  const handleBatchReschedule = async () => {
    if (selectedImpactKeys.length === 0) {
      message.warning('请先选择需要重排的计划')
      return
    }
    setLoading(true)
    try {
      const res: any = await productionApi.batchReschedulePlans({ plan_ids: selectedImpactKeys })
      const result = res.data || {}
      const hasDelay = (result.delay_warning_count || 0) > 0
      const failedItems = (result.items || []).filter((item: any) => !item.success)
      const hasFailure = failedItems.length > 0
      const notificationType = hasFailure ? 'error' : (hasDelay ? 'warning' : 'success')
      
      notification[notificationType]({
        message: '批量重排完成',
        description: (
          <div>
            <div>✅ 成功：{result.success_count || 0} 条</div>
            {hasFailure && (
              <>
                <div>❌ 失败：{result.failed_count || 0} 条</div>
                {failedItems.slice(0, 3).map((item: any, index: number) => (
                  <div key={index} style={{ color: 'red', fontSize: '12px', marginTop: '4px' }}>
                    - {item.order_no}({item.line_no}): {item.message}
                  </div>
                ))}
                {failedItems.length > 3 && <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>... 还有 {failedItems.length - 3} 条</div>}
              </>
            )}
            {hasDelay && <div>⚠️ 影响交期：{result.delay_warning_count} 条（已延期预警）</div>}
          </div>
        ),
        duration: 8,
        placement: 'bottomRight',
      })
      setBatchPreviewOpen(false)
      setSelectedImpactKeys([])
      loadImpactPlans()
      loadPlans()
      loadTabCounts()
    } catch (e: any) {
      message.error(e.message || '批量重排失败')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenBatchPreview = () => {
    if (selectedImpactKeys.length === 0) {
      message.warning('请先选择需要重排的计划')
      return
    }
    setBatchPreviewOpen(true)
  }

  const renderCopyableText = (value?: string | number | null, label = '内容') => {
    return <CopyableText value={value} label={label} />
  }

  const getDelayDaysDisplay = (row: any) => {
    if (!row?.customer_due_date || !row?.end_date) {
      return { text: '-', color: '#999' }
    }

    const diffDays = dayjs(row.end_date).startOf('day').diff(dayjs(row.customer_due_date).startOf('day'), 'day')
    if (diffDays > 0) {
      return { text: `+${diffDays}天`, color: '#cf1322' }
    }
    if (diffDays < 0) {
      return { text: `提前${Math.abs(diffDays)}天`, color: '#389e0d' }
    }
    return { text: '0天', color: '#1677ff' }
  }

  const renderDeliveryStatusTag = (statusValue?: string, row?: any) => {
    const item = DELIVERY_STATUS_MAP[statusValue || 'unknown'] || DELIVERY_STATUS_MAP.unknown
    if (statusValue === 'delayed') {
      return <Tag color={item.color} icon={<ExclamationCircleOutlined />}>{item.label}</Tag>
    }
    if (statusValue === 'upcoming') {
      return <Tag color={item.color} icon={<ClockCircleOutlined />}>{item.label}</Tag>
    }
    if (statusValue === 'early') {
      const aheadDays = row?.customer_due_date && row?.end_date
        ? Math.max(dayjs(row.customer_due_date).startOf('day').diff(dayjs(row.end_date).startOf('day'), 'day'), 0)
        : 0
      return <Tag color={item.color} icon={<ArrowUpOutlined />}>{aheadDays > 0 ? `${item.label}${aheadDays}天` : item.label}</Tag>
    }
    if (statusValue === 'normal') {
      return <Tag color={item.color} icon={<CheckCircleOutlined />}>{item.label}</Tag>
    }
    return <Tag color={item.color}>{item.label}</Tag>
  }

  const getProjectedRescheduleEndDate = (row: any) => {
    if (!row?.source_promised_date || !row?.current_days_needed) return null
    let startDate = dayjs(row.source_promised_date).startOf('day').subtract((row.current_days_needed || 1) - 1, 'day')
    const today = dayjs().startOf('day')
    if (startDate.isBefore(today)) {
      startDate = today
    }
    return startDate.add((row.current_days_needed || 1) - 1, 'day')
  }

  const selectedImpactPreviewRows = impactData
    .filter((row: any) => selectedImpactKeys.includes(row.id))
    .map((row: any) => {
      const projectedEndDate = getProjectedRescheduleEndDate(row)
      const originalEndDate = row.end_date ? dayjs(row.end_date).startOf('day') : null
      const changeDays = projectedEndDate && originalEndDate ? projectedEndDate.diff(originalEndDate, 'day') : null
      const projectedStatus = projectedEndDate && row.source_promised_date
        ? (projectedEndDate.isAfter(dayjs(row.source_promised_date).startOf('day'))
          ? 'delayed'
          : (dayjs(row.source_promised_date).startOf('day').diff(projectedEndDate, 'day') >= 2 ? 'early' : 'normal'))
        : 'unknown'
      return {
        ...row,
        projected_end_date: projectedEndDate ? projectedEndDate.format('YYYY-MM-DD') : null,
        change_days: changeDays,
        projected_status: projectedStatus,
      }
    })

  const planColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 160, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 100, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: '型号', dataIndex: 'model_code', width: 250, render: (v: string) => v || '-' },
    { title: '数量', dataIndex: 'quantity', width: 90, render: (v: number) => <span style={{ fontWeight: 'bold' }}>{v ?? '-'}</span> },
    {
      title: '客户交期',
      dataIndex: 'customer_due_date',
      width: 120,
      render: (v: string, row: any) => formatDate(v || row.source_promised_date),
    },
    { title: '计划开始', dataIndex: 'start_date', width: 110, render: (v: string) => <Tag color="blue">{formatDate(v)}</Tag> },
    { title: '计划结束', dataIndex: 'end_date', width: 110, render: (v: string, row: any) => {
        const isDelayed = row.remark && row.remark.includes('延期预警');
        return <Tag color={isDelayed ? 'red' : 'green'}>{formatDate(v)}</Tag>;
    }},
    {
      title: '延期天数',
      width: 120,
      render: (_: any, row: any) => {
        const delayInfo = getDelayDaysDisplay(row)
        return <span style={{ color: delayInfo.color, fontWeight: 600 }}>{delayInfo.text}</span>
      },
    },
    {
      title: '延期状态',
      dataIndex: 'delivery_status',
      width: 100,
      render: (v: string, row: any) => renderDeliveryStatusTag(v, row),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 160,
      render: (v: string) => formatDateTime(v),
    },
    {
      title: '最近重排时间',
      dataIndex: 'latest_reschedule_at',
      width: 160,
      render: (v: string) => formatDateTime(v),
    },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (v: string) => <Tag color={STATUS_MAP[v]?.color || 'default'}>{STATUS_MAP[v]?.label || v}</Tag>,
    },
    {
      title: '优先级', dataIndex: 'priority', width: 90,
      render: (v: string) => <Tag color={PRIORITY_MAP[v]?.color || 'default'}>{PRIORITY_MAP[v]?.label || v}</Tag>,
    },
    { title: '负责人', dataIndex: 'owner', width: 100, render: (v: string) => v || '-' },
    {
      title: '需重排', dataIndex: 'needs_reschedule', width: 80,
      render: (v: boolean) => v ? <Tag color="red">是</Tag> : <Tag color="green">否</Tag>,
    },
    { title: '重排原因', dataIndex: 'reschedule_reason', width: 150, ellipsis: true, render: (v: string) => v || '-' },
    { title: '备注', dataIndex: 'remark', width: 200, ellipsis: true, render: (v: string) => {
        if (v && v.includes('延期预警')) {
            return <span style={{ color: 'red', fontWeight: 'bold' }}>{v}</span>;
        }
        return v || '-';
    }},
    {
      title: '操作', width: 100, fixed: 'right' as const,
      render: (_: any, row: any) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
          {row.needs_reschedule && (
            <Popconfirm title="确认重排？" onConfirm={() => handleReschedule(row.id)}>
              <Button size="small" icon={<ThunderboltOutlined />} type="primary">重排</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  const orderColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 160, fixed: 'left' as const, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 100, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '客户', dataIndex: 'customer', width: 140, ellipsis: true },
    { title: 'BOM编号', dataIndex: 'bom_no', width: 180, render: (v: string) => v || '-' },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: '数量', dataIndex: 'order_qty', width: 100, render: (v: number) => v ?? '-' },
    { title: '交期', dataIndex: 'promised_date', width: 110, render: (v: string) => formatDate(v) },
    {
      title: '风险等级', dataIndex: 'risk_level', width: 100,
      render: (v: string) => <Tag color={RISK_MAP[v]?.color || 'default'}>{RISK_MAP[v]?.label || v}</Tag>,
    },
    { title: 'UPPH', dataIndex: 'upph', width: 90, render: (v: number) => v > 0 ? v : <span style={{ color: '#999' }}>未设置</span> },
    {
      title: '排产状态', dataIndex: 'has_schedule', width: 100,
      render: (v: boolean) => v ? <Tag color="green">已排产</Tag> : <Tag color="orange">待排产</Tag>,
    },
    {
      title: '操作', width: 120, fixed: 'right' as const,
      render: (_: any, row: any) => (
        <Tooltip title={row.upph <= 0 ? '请先设置UPPH或手动输入' : '一键排产'}>
          <Button
            type={row.has_schedule ? 'default' : 'primary'}
            size="small"
            icon={<ThunderboltOutlined />}
            onClick={() => openSchedule(row)}
          >
            排产
          </Button>
        </Tooltip>
      ),
    },
  ]

  const impactColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 160, fixed: 'left' as const, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 100, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '产品编码', dataIndex: 'product_code', width: 220, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: '数量', dataIndex: 'quantity', width: 90, render: (v: number) => v ?? '-' },
    {
      title: '影响程度',
      dataIndex: 'impact_level',
      width: 100,
      render: (v: string) => <Tag color={IMPACT_MAP[v]?.color || 'default'}>{IMPACT_MAP[v]?.label || v}</Tag>,
    },
    { title: '影响分值', dataIndex: 'impact_score', width: 100, render: (v: number) => v ?? '-' },
    { title: '排产UPPH', dataIndex: 'source_upph', width: 100, render: (v: number) => v ?? '-' },
    { title: '当前UPPH', dataIndex: 'current_upph', width: 100, render: (v: number) => v ?? '-' },
    {
      title: '变化幅度',
      dataIndex: 'upph_delta_ratio',
      width: 110,
      render: (v: number) => {
        const percent = `${((v || 0) * 100).toFixed(1)}%`
        return <span style={{ color: (v || 0) < 0 ? '#cf1322' : '#1677ff', fontWeight: 600 }}>{percent}</span>
      },
    },
    { title: '原预计天数', dataIndex: 'planned_days_needed', width: 110, render: (v: number) => v ?? '-' },
    { title: '现预计天数', dataIndex: 'current_days_needed', width: 110, render: (v: number) => v ?? '-' },
    { title: '交期', dataIndex: 'source_promised_date', width: 110, render: (v: string) => formatDate(v) },
    { title: '负责人', dataIndex: 'owner', width: 100, render: (v: string) => v || '-' },
    { title: '原因说明', dataIndex: 'impact_reason', width: 320, ellipsis: true, render: (v: string) => v || '-' },
    {
      title: '待重排',
      dataIndex: 'needs_reschedule',
      width: 90,
      render: (v: boolean) => v ? <Tag color="red">是</Tag> : <Tag color="default">否</Tag>,
    },
  ]

  const missingUpphColumns = [
    { title: '产品编码', dataIndex: 'product_code', width: 220, fixed: 'left' as const, render: (v: string) => renderCopyableText(v, '产品编码') },
    { title: '产品型号', dataIndex: 'product_model', width: 220, ellipsis: true, render: (v: string) => v || '-' },
    { title: '订单数', dataIndex: 'order_count', width: 90, render: (v: number) => v ?? '-' },
    { title: '总数量', dataIndex: 'total_quantity', width: 120, render: (v: number) => v ?? '-' },
    { title: '最近交期', dataIndex: 'latest_promised_date', width: 120, render: (v: string) => formatDate(v) },
    { title: '首次出现订单号', dataIndex: 'first_order_no', width: 160, render: (v: string) => v || '-' },
    {
      title: '状态',
      width: 100,
      render: () => <Tag color="red">缺少UPPH</Tag>,
    },
  ]

  const operationLogColumns = [
    { title: '操作时间', dataIndex: 'operation_at', width: 180, render: (v: string) => formatDate(v) || '-' },
    { title: '操作人', dataIndex: 'operator', width: 120, render: (v: string) => v || '-' },
    {
      title: '操作类型',
      dataIndex: 'operation_type',
      width: 120,
      render: (v: string) => <Tag color="blue">{OPERATION_TYPE_MAP[v] || v || '-'}</Tag>,
    },
    { title: '订单号', dataIndex: 'order_no', width: 160, render: (v: string) => v || '-' },
    { title: '行号', dataIndex: 'line_no', width: 100, render: (v: string) => v || '-' },
    { title: '计划ID', dataIndex: 'plan_id', width: 100, render: (v: number) => v ?? '-' },
    { title: '版本', dataIndex: 'plan_version', width: 90, render: (v: number) => v ?? '-' },
    { title: '上一版本ID', dataIndex: 'previous_version_id', width: 110, render: (v: number) => v ?? '-' },
    { title: '备注', dataIndex: 'remark', width: 360, ellipsis: true, render: (v: string) => v || '-' },
  ]

  const renderTabLabel = (key: string, label: string) => {
    if (!(key in tabCounts)) return label
    return (
      <Badge count={tabCounts[key]} showZero overflowCount={99} offset={[8, -1]}>
        <span>{label}</span>
      </Badge>
    )
  }

  const missingUpphEmptyDescription =
    missingUpphEmptyState?.message || '当前没有缺少UPPH的产品。'

  const impactEmptyDescription = keyword.trim() || impactLevel
    ? '当前筛选条件下没有受UPPH变更影响的计划。'
    : '当前没有受UPPH变更影响的计划。'

  const operationLogEmptyDescription = logKeyword.trim() || logOperator.trim() || operationType
    ? '当前筛选条件下没有匹配的操作日志。'
    : '当前暂无排产操作日志。'

  const batchPreviewColumns = [
    { title: '订单号', dataIndex: 'order_no', width: 170, render: (v: string) => renderCopyableText(v, '订单号') },
    { title: '行号', dataIndex: 'line_no', width: 100, render: (v: string) => renderCopyableText(v, '行号') },
    { title: '原UPPH', dataIndex: 'source_upph', width: 100, render: (v: number) => v ?? '-' },
    { title: '新UPPH', dataIndex: 'current_upph', width: 100, render: (v: number) => v ?? '-' },
    { title: '原结束', dataIndex: 'end_date', width: 110, render: (v: string) => formatDate(v) },
    { title: '新结束', dataIndex: 'projected_end_date', width: 110, render: (v: string) => formatDate(v) || '-' },
    {
      title: '变化',
      dataIndex: 'change_days',
      width: 140,
      render: (v: number | null, row: any) => {
        if (v === null || v === undefined) {
          return <Tag color="default">无法预估</Tag>
        }
        if (v > 0) {
          return <Tag color="red">+{v}天</Tag>
        }
        if (v < 0) {
          return <Tag color="green">{v}天</Tag>
        }
        return <Tag color="blue">无变化</Tag>
      },
    },
    {
      title: '预估状态',
      dataIndex: 'projected_status',
      width: 120,
      render: (v: string, row: any) => renderDeliveryStatusTag(v, { customer_due_date: row.source_promised_date, end_date: row.projected_end_date }),
    },
  ]

  return (
    <div>
      <div className="card-modern" style={{ padding: '12px 20px', marginBottom: 16 }}>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => {
            setActiveTab(key)
            setPage(1)
            setOrderPage(1)
            setImpactPage(1)
            setOperationLogPage(1)
            setSelectedImpactKeys([])
          }}
          items={[
            { key: 'orders', label: '当月订单池' },
            { key: 'active_plans', label: '当前计划排产' },
            { key: 'reschedule_needed', label: renderTabLabel('reschedule_needed', '待重排') },
            { key: 'capacity_impact', label: renderTabLabel('capacity_impact', '产能变更影响') },
            { key: 'missing_upph', label: renderTabLabel('missing_upph', '缺少UPPH') },
            { key: 'history_plans', label: '历史排产' },
          ]}
        />

        {['active_plans', 'reschedule_needed', 'history_plans'].includes(activeTab) && (
          <>
            <Tabs
              activeKey={department}
              onChange={(key) => { setDepartment(key); setPage(1) }}
              items={DEPARTMENTS.map(d => ({ key: d, label: d }))}
              style={{ marginBottom: 12 }}
            />
            <Row gutter={12} align="middle">
              <Col>
                <Input
                  prefix={<SearchOutlined />}
                  value={keyword}
                  onChange={e => { setKeyword(e.target.value); setPage(1) }}
                  placeholder="搜索订单/产品/型号/负责人"
                  allowClear
                  style={{ width: 260 }}
                />
              </Col>
              <Col>
                <Select
                  allowClear
                  placeholder="状态"
                  value={status}
                  onChange={v => { setStatus(v); setPage(1) }}
                  style={{ width: 140 }}
                  options={Object.entries(STATUS_MAP).map(([value, item]) => ({ value, label: item.label }))}
                />
              </Col>
              <Col>
                <DatePicker.RangePicker
                  onChange={dates => {
                    setDateRange(dates && dates[0] && dates[1] ? [dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')] : null)
                    setPage(1)
                  }}
                />
              </Col>
              <Col flex="auto" />
              <Col>
                <Space>
                  <Button icon={<ReloadOutlined />} onClick={loadPlans}>刷新</Button>
                  {activeTab === 'active_plans' && (
                    <Button type="primary" onClick={handleDetectChanges}>检测变更</Button>
                  )}
                  <Button onClick={() => { setOperationLogPage(1); setOperationLogModalOpen(true) }}>查看操作日志</Button>
                  <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增计划</Button>
                </Space>
              </Col>
            </Row>
          </>
        )}

        {activeTab === 'orders' && (
          <Row gutter={12} align="middle">
            <Col>
              <Select value={year} onChange={v => { setYear(v); setOrderPage(1) }} style={{ width: 100 }} options={
                Array.from({ length: 10 }, (_, i) => ({ value: dayjs().year() - 5 + i, label: (dayjs().year() - 5 + i) + '年' }))
              } />
            </Col>
            <Col>
              <Select value={month} onChange={v => { setMonth(v); setOrderPage(1) }} style={{ width: 100 }} options={
                Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: (i + 1) + '月' }))
              } />
            </Col>
            <Col>
              <Input
                prefix={<SearchOutlined />}
                value={keyword}
                onChange={e => { setKeyword(e.target.value); setOrderPage(1) }}
                placeholder="搜索订单/客户/产品"
                allowClear
                style={{ width: 260 }}
              />
            </Col>
            <Col>
              <Select
                allowClear
                placeholder="风险等级"
                value={riskLevel}
                onChange={v => { setRiskLevel(v); setOrderPage(1) }}
                style={{ width: 120 }}
                options={Object.entries(RISK_MAP).map(([value, item]) => ({ value, label: item.label }))}
              />
            </Col>
            <Col>
              <Select
                allowClear
                placeholder="仅待排产"
                value={onlyUnscheduled}
                onChange={v => { setOnlyUnscheduled(v); setOrderPage(1) }}
                style={{ width: 120 }}
                options={[
                  { value: false, label: '全部' },
                  { value: true, label: '仅待排产' },
                ]}
              />
            </Col>
            <Col flex="auto" />
            <Col>
              <Button icon={<ReloadOutlined />} onClick={loadOrders}>刷新</Button>
            </Col>
          </Row>
        )}

        {activeTab === 'capacity_impact' && (
          <>
            <Tabs
              activeKey={department}
              onChange={(key) => { setDepartment(key); setImpactPage(1); setSelectedImpactKeys([]) }}
              items={DEPARTMENTS.map(d => ({ key: d, label: d }))}
              style={{ marginBottom: 12 }}
            />
            <Row gutter={12} align="middle">
              <Col>
                <Input
                  prefix={<SearchOutlined />}
                  value={keyword}
                  onChange={e => { setKeyword(e.target.value); setImpactPage(1) }}
                  placeholder="搜索订单/产品/型号/负责人"
                  allowClear
                  style={{ width: 260 }}
                />
              </Col>
              <Col>
                <Select
                  allowClear
                  placeholder="影响程度"
                  value={impactLevel}
                  onChange={v => { setImpactLevel(v); setImpactPage(1) }}
                  style={{ width: 140 }}
                  options={Object.entries(IMPACT_MAP).map(([value, item]) => ({ value, label: item.label }))}
                />
              </Col>
              <Col flex="auto" />
              <Col>
                <Space>
                  <Button icon={<ReloadOutlined />} onClick={loadImpactPlans}>刷新</Button>
                  <Button type="primary" icon={<ThunderboltOutlined />} disabled={selectedImpactKeys.length === 0} onClick={handleOpenBatchPreview}>预览并重排</Button>
                </Space>
              </Col>
            </Row>
          </>
        )}

        {activeTab === 'missing_upph' && (
          <Row gutter={12} align="middle">
            <Col>
              <Input
                prefix={<SearchOutlined />}
                value={keyword}
                onChange={e => { setKeyword(e.target.value) }}
                placeholder="搜索订单/产品/型号"
                allowClear
                style={{ width: 260 }}
              />
            </Col>
            <Col>
              <Select
                allowClear
                placeholder="年份"
                value={year}
                onChange={v => { setYear(v) }}
                style={{ width: 120 }}
                options={[dayjs().year() - 1, dayjs().year(), dayjs().year() + 1].map(y => ({ value: y, label: `${y}年` }))}
              />
            </Col>
            <Col>
              <Select
                allowClear
                placeholder="月份"
                value={month}
                onChange={v => { setMonth(v) }}
                style={{ width: 120 }}
                options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}月` }))}
              />
            </Col>
            <Col flex="auto" />
            <Col>
              <Button icon={<ReloadOutlined />} onClick={loadMissingUpphProducts}>刷新</Button>
            </Col>
          </Row>
        )}

      </div>

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        {['active_plans', 'reschedule_needed', 'history_plans'].includes(activeTab) && (
          <Table
            rowKey="id"
            columns={planColumns}
            dataSource={data}
            loading={loading}
            size="small"
            scroll={{ x: 2200 }}
            pagination={{
              total,
              current: page,
              pageSize,
              showSizeChanger: true,
              onChange: (p, ps) => { setPage(p); setPageSize(ps) },
              showTotal: t => `共 ${t} 条`,
            }}
            summary={(pageData) => {
              const totalQuantity = pageData.reduce((sum, row) => sum + (row.quantity || 0), 0)
              const uniqueOrders = new Set(pageData.map(row => row.order_no))
              const delayedCount = pageData.filter(row => row.delivery_status === 'delayed').length
              const upcomingCount = pageData.filter(row => row.delivery_status === 'upcoming').length
              const earlyCount = pageData.filter(row => row.delivery_status === 'early').length
              const normalCount = pageData.filter(row => row.delivery_status === 'normal').length
              const summaryCells: ReactNode[] = Array.from({ length: planColumns.length }, () => null)
              summaryCells[0] = '合计'
              summaryCells[1] = `${uniqueOrders.size}单`
              summaryCells[4] = totalQuantity
              summaryCells[9] = (
                <Space size={4} wrap>
                  <Tag color="green">正常 {normalCount}</Tag>
                  <Tag color="orange">临期 {upcomingCount}</Tag>
                  <Tag color="red">延期 {delayedCount}</Tag>
                  <Tag color="blue">提前 {earlyCount}</Tag>
                </Space>
              )
              return (
                <Table.Summary fixed>
                  <Table.Summary.Row style={{ backgroundColor: '#fafafa', fontWeight: 'bold' }}>
                    {summaryCells.map((cell, index) => (
                      <Table.Summary.Cell index={index} key={index}>
                        {cell}
                      </Table.Summary.Cell>
                    ))}
                  </Table.Summary.Row>
                </Table.Summary>
              )
            }}
          />
        )}

        {activeTab === 'orders' && (
          <Table
            rowKey={(row: any) => `${row.order_no}-${row.line_no}`}
            columns={orderColumns}
            dataSource={orderData}
            loading={loading}
            size="small"
            scroll={{ x: 1400 }}
            pagination={{
              total: orderTotal,
              current: orderPage,
              pageSize,
              showSizeChanger: true,
              onChange: (p, ps) => { setOrderPage(p); setPageSize(ps) },
              showTotal: t => `共 ${t} 条`,
            }}
          />
        )}

        {activeTab === 'capacity_impact' && (
          <Table
            rowKey="id"
            rowSelection={{
              selectedRowKeys: selectedImpactKeys,
              onChange: (keys) => setSelectedImpactKeys(keys as number[]),
              getCheckboxProps: (row: any) => ({ disabled: !row.id }),
            }}
            columns={impactColumns}
            dataSource={impactData}
            loading={loading}
            size="small"
            scroll={{ x: 1800 }}
            pagination={{
              total: impactTotal,
              current: impactPage,
              pageSize,
              showSizeChanger: true,
              onChange: (p, ps) => { setImpactPage(p); setPageSize(ps) },
              showTotal: t => `共 ${t} 条`,
            }}
            locale={{ emptyText: <Empty description={impactEmptyDescription} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        )}

        {activeTab === 'missing_upph' && (
          <Table
            rowKey="product_code"
            columns={missingUpphColumns}
            dataSource={missingUpphData}
            loading={loading}
            size="small"
            scroll={{ x: 1200 }}
            pagination={false}
            locale={{ emptyText: <Empty description={missingUpphEmptyDescription} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        )}

      </div>

      <Modal
        title={`批量重排预览（${selectedImpactPreviewRows.length} 条）`}
        open={batchPreviewOpen}
        onCancel={() => setBatchPreviewOpen(false)}
        onOk={handleBatchReschedule}
        okText="确认批量重排"
        cancelText="取消"
        width={1100}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ color: '#666' }}>
            先预览本次重排对 UPPH 与预计完工日期的影响，确认可接受后再执行。
          </div>
          <Table
            rowKey="id"
            columns={batchPreviewColumns}
            dataSource={selectedImpactPreviewRows}
            size="small"
            pagination={false}
            scroll={{ x: 1000, y: 360 }}
          />
        </Space>
      </Modal>

      <Modal
        title="排产操作日志"
        open={operationLogModalOpen}
        onCancel={() => setOperationLogModalOpen(false)}
        footer={null}
        width={1280}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Row gutter={12} align="middle">
            <Col>
              <Input
                prefix={<SearchOutlined />}
                value={logKeyword}
                onChange={e => { setLogKeyword(e.target.value); setOperationLogPage(1) }}
                placeholder="搜索订单号"
                allowClear
                style={{ width: 220 }}
              />
            </Col>
            <Col>
              <Input
                value={logOperator}
                onChange={e => { setLogOperator(e.target.value); setOperationLogPage(1) }}
                placeholder="操作人"
                allowClear
                style={{ width: 180 }}
              />
            </Col>
            <Col>
              <Select
                allowClear
                placeholder="操作类型"
                value={operationType}
                onChange={v => { setOperationType(v); setOperationLogPage(1) }}
                style={{ width: 180 }}
                options={Object.entries(OPERATION_TYPE_MAP).map(([value, label]) => ({ value, label }))}
              />
            </Col>
            <Col flex="auto" />
            <Col>
              <Button icon={<ReloadOutlined />} onClick={loadOperationLogs}>刷新</Button>
            </Col>
          </Row>

          <Table
            rowKey="id"
            columns={operationLogColumns}
            dataSource={operationLogData}
            loading={loading}
            size="small"
            scroll={{ x: 1500 }}
            pagination={{
              total: operationLogTotal,
              current: operationLogPage,
              pageSize,
              showSizeChanger: true,
              onChange: (p, ps) => { setOperationLogPage(p); setPageSize(ps) },
              showTotal: t => `共 ${t} 条`,
            }}
            locale={{ emptyText: <Empty description={operationLogEmptyDescription} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        </Space>
      </Modal>

      <Modal
        title={editing ? '编辑计划排产' : '新增计划排产'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        width={800}
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="department" label="部门" rules={[{ required: true }]}>
                <Select options={DEPARTMENTS.map(d => ({ value: d, label: d }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="plan_date" label="计划日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="状态">
                <Select options={Object.entries(STATUS_MAP).map(([value, item]) => ({ value, label: item.label }))} />
              </Form.Item>
            </Col>
            <Col span={8}><Form.Item name="order_no" label="订单号"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="product_code" label="产品编码"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="model_code" label="型号"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="quantity" label="数量"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="upph" label="UPPH"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="daily_work_hours" label="每日工作时长(h)"><InputNumber min={1} max={24} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="owner" label="负责人"><Input /></Form.Item></Col>
            <Col span={8}>
              <Form.Item name="priority" label="优先级">
                <Select options={Object.entries(PRIORITY_MAP).map(([value, item]) => ({ value, label: item.label }))} />
              </Form.Item>
            </Col>
            <Col span={8}><Form.Item name="start_date" label="开始日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="end_date" label="结束日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={24}><Form.Item name="remark" label="备注"><Input.TextArea rows={3} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title="一键排产"
        open={scheduleModalOpen}
        onOk={handleAutoSchedule}
        onCancel={() => setScheduleModalOpen(false)}
        width={640}
      >
        <Form form={scheduleForm} layout="vertical">
          <Row gutter={16}>
            <Col span={12}><Form.Item name="order_no" label="订单号"><Input disabled /></Form.Item></Col>
            <Col span={12}><Form.Item name="line_no" label="行号"><Input disabled /></Form.Item></Col>
            <Col span={12}><Form.Item name="product_code" label="产品编码"><Input disabled /></Form.Item></Col>
            <Col span={12}><Form.Item name="model_code" label="型号"><Input disabled /></Form.Item></Col>
            <Col span={12}><Form.Item name="quantity" label="数量"><InputNumber disabled style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="promised_date" label="交期"><DatePicker disabled style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}>
              <Form.Item name="department" label="部门" rules={[{ required: true }]}>
                <Select options={DEPARTMENTS.map(d => ({ value: d, label: d }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="plan_date" label="计划日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="upph" label="UPPH (每小时产能)" rules={[{ required: true, type: 'number', min: 0.001 }]}>
                <InputNumber min={0.001} style={{ width: '100%' }} placeholder="请输入UPPH" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="daily_work_hours" label="每日工作时长(h)" rules={[{ required: true }]}>
                <InputNumber min={1} max={24} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24}><Form.Item name="owner" label="负责人"><Input /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
