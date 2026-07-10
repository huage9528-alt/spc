// SchedulePlans 渲染辅助函数（从 index.tsx 抽出，纯搬运，逻辑未变更）
// 这些函数都不依赖组件 state，只依赖外部 import + 常量

import { useState } from 'react'
import { Alert, Space, Tag, Tooltip, message } from 'antd'
import { ArrowUpOutlined, CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { formatDate } from '../../../utils'
import {
  BUCKET_COLOR_MAP,
  DELIVERY_STATUS_MAP,
  LEAN_CAPACITY_LOAD_MAP,
  ORDER_POOL_STATUS_COLOR_MAP,
} from './constants'

export const CopyableText = ({ value, label = '内容' }: { value?: string | number | null; label?: string }) => {
  const [copied, setCopied] = useState(false)
  if (value === null || value === undefined || value === '') return '-'

  const handleCopy = async () => {
    const text = String(value).trim()
    if (!text) return
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
          cursor: 'copy',
          userSelect: 'text',
          color: copied ? '#389e0d' : '#1677ff',
          textDecoration: copied ? 'none' : 'underline',
          textDecorationStyle: 'dotted',
          textUnderlineOffset: 3,
        }}
      >
        {value}
      </span>
    </Tooltip>
  )
}

export const renderCopyableText = (value?: string | number | null, label = '内容') => <CopyableText value={value} label={label} />

export const normalizePlanBoardBucket = (bucket?: string | null) => (
  bucket && ['lean', 'assembly', 'packaging'].includes(bucket) ? bucket : 'all'
)

export const buildScheduleBoardLink = (row?: any) => {
  const params = new URLSearchParams()
  params.set('source', 'schedule_plans')
  params.set('view', 'week')
  if (row?.id) params.set('planId', String(row.id))
  if (row?.order_no) params.set('keyword', row.order_no)
  if (row?.schedule_bucket && ['lean', 'assembly', 'packaging', 'mixed', 'pending'].includes(row.schedule_bucket)) {
    params.set('bucket', row.schedule_bucket)
  }
  const planDate = row?.start_date || row?.plan_date
  if (planDate) params.set('planDate', planDate)
  return `/schedule-board?${params.toString()}`
}

export const getTaskNo = (row: any) => {
  if (row?.task_no) return row.task_no
  if (!row?.id) return null
  const referenceDate = row?.created_at || row?.plan_date
  const datePart = referenceDate ? dayjs(referenceDate).format('YYYYMMDD') : '00000000'
  const versionPart = row?.plan_version || 1
  return `SC${datePart}-${String(row.id).padStart(6, '0')}-V${versionPart}`
}

export const getTargetReadyDateValue = (row: any) => {
  if (row?.target_ready_date) return row.target_ready_date
  if (row?.customer_due_date) return dayjs(row.customer_due_date).subtract(2, 'day').format('YYYY-MM-DD')
  if (row?.source_promised_date) return dayjs(row.source_promised_date).subtract(2, 'day').format('YYYY-MM-DD')
  return null
}

export const renderDeliveryStatusTag = (statusValue?: string, row?: any) => {
  const item = DELIVERY_STATUS_MAP[statusValue || 'unknown'] || DELIVERY_STATUS_MAP.unknown
  const targetReadyDate = getTargetReadyDateValue(row)
  if (statusValue === 'delayed') {
    return <Tag color={item.color} icon={<ExclamationCircleOutlined />}>{item.label}</Tag>
  }
  if (statusValue === 'upcoming') {
    return <Tag color={item.color} icon={<ClockCircleOutlined />}>{item.label}</Tag>
  }
  if (statusValue === 'early') {
    const aheadDays = targetReadyDate && row?.end_date
      ? Math.max(dayjs(targetReadyDate).startOf('day').diff(dayjs(row.end_date).startOf('day'), 'day'), 0)
      : 0
    return <Tag color={item.color} icon={<ArrowUpOutlined />}>{aheadDays > 0 ? `${item.label}${aheadDays}天` : item.label}</Tag>
  }
  if (statusValue === 'normal') {
    return <Tag color={item.color} icon={<CheckCircleOutlined />}>{item.label}</Tag>
  }
  return <Tag color={item.color}>{item.label}</Tag>
}

export const getDelayDaysDisplay = (row: any) => {
  const targetReadyDate = getTargetReadyDateValue(row)
  if (!targetReadyDate || !row?.end_date) return { text: '-', color: '#999' }
  const diffDays = dayjs(row.end_date).startOf('day').diff(dayjs(targetReadyDate).startOf('day'), 'day')
  if (diffDays > 0) return { text: `+${diffDays}天`, color: '#cf1322' }
  if (diffDays < 0) return { text: `提前${Math.abs(diffDays)}天`, color: '#389e0d' }
  return { text: '0天', color: '#1677ff' }
}

export const getProjectedRescheduleEndDate = (row: any) => {
  const targetReadyDate = getTargetReadyDateValue(row)
  if (!targetReadyDate || !row?.current_days_needed) return null
  let startDate = dayjs(targetReadyDate).startOf('day').subtract((row.current_days_needed || 1) - 1, 'day')
  const today = dayjs().startOf('day')
  if (startDate.isBefore(today)) startDate = today
  return startDate.add((row.current_days_needed || 1) - 1, 'day')
}

export const getProjectedRescheduleStartDate = (row: any) => {
  const targetReadyDate = getTargetReadyDateValue(row)
  if (!targetReadyDate || !row?.current_days_needed) return null
  let startDate = dayjs(targetReadyDate).startOf('day').subtract((row.current_days_needed || 1) - 1, 'day')
  const today = dayjs().startOf('day')
  if (startDate.isBefore(today)) startDate = today
  return startDate
}

export const renderBucketTag = (row: any) => {
  const label = row?.schedule_bucket_label || '未归类'
  const color = BUCKET_COLOR_MAP[row?.schedule_bucket || 'pending'] || 'default'
  return <Tag color={color}>{label}</Tag>
}

export const renderSchedulingStatusTag = (row: any) => {
  const label = row?.display_status_label || row?.scheduling_status_label || '待确认'
  const color = ORDER_POOL_STATUS_COLOR_MAP[row?.display_status || row?.scheduling_status || 'pending'] || 'default'
  return <Tag color={color}>{label}</Tag>
}

export const getReadableSchedulingReason = (row: any) => {
  const reasonCode = String(row?.scheduling_reason_code || '')
  const status = String(row?.display_status || row?.scheduling_status || '')

  if (reasonCode === 'no_capacity_match') return '未命中产能，请检查 BOM/产品编码'
  if (reasonCode === 'non_schedulable_workshop') return '命中其他车间，当前不参与自动排产'
  if (reasonCode === 'bucket_unclassified') return '工序未识别，暂未归类到精益/组装/包装'
  if (reasonCode === 'lean_missing_upph') return '已命中精益，但缺有效 UPPH'
  if (reasonCode === 'missing_upph') return '已命中产能，但缺有效 UPPH'
  if (reasonCode === 'assembly_rule_pending') {
    return status === 'ready' ? '已命中组装，满足排产条件' : '已命中组装，但组装阶段 UPPH 缺失'
  }
  if (reasonCode === 'packaging_rule_pending') {
    return status === 'ready' ? '已命中包装，满足排产条件' : '已命中包装，但包装阶段 UPPH 缺失'
  }
  if (reasonCode === 'mixed_bucket_pending') {
    return status === 'ready' ? '已识别组装+包装两段，满足排产条件' : '同时命中组装/包装，但阶段 UPPH 仍不完整'
  }
  if (reasonCode === 'zero_quantity') return '订单数量无效，当前不参与自动排产'
  if (reasonCode === 'already_scheduled') return '已存在有效排产计划'
  if (reasonCode === 'lean_ready') return '已命中精益，满足排产条件'
  if (reasonCode === 'ready') return '满足排产条件'
  return row?.scheduling_reason || '-'
}

export const renderSchedulingReasonCell = (row: any) => {
  const reason = getReadableSchedulingReason(row)
  return <span>{reason}</span>
}

export const renderWorkhourSuggestionCell = (row: any) => {
  if (!row?.recommended_daily_hours) return <span style={{ color: '#999' }}>待试算</span>
  const status = LEAN_CAPACITY_LOAD_MAP[row.capacity_load_status || 'normal'] || LEAN_CAPACITY_LOAD_MAP.normal
  return (
    <Tooltip title={row.work_hour_summary || undefined}>
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <span style={{ fontWeight: 600 }}>{Number(row.recommended_daily_hours).toFixed(2)} 小时/天</span>
        <Tag color={status.color}>{row.capacity_load_status_label || status.label}</Tag>
      </Space>
    </Tooltip>
  )
}

export const renderUpphDeltaTag = (row: any) => {
  const current = Number(row?.upph ?? row?.current_upph ?? 0)
  const source = Number(row?.source_upph ?? 0)
  if (!source || !current) return <Tag>待补快照</Tag>
  const deltaRatio = (current - source) / source
  if (Math.abs(deltaRatio) < 0.01) return <Tag>基本不变</Tag>
  if (deltaRatio > 0) return <Tag color="success">{`+${(deltaRatio * 100).toFixed(1)}%`}</Tag>
  return <Tag color="error">{`${(deltaRatio * 100).toFixed(1)}%`}</Tag>
}

export const hasConflictAvoidance = (row: any) => String(row?.remark || '').includes('产能避让')

export const renderPlanExplainSummaryCell = (row: any) => {
  const targetReadyDate = formatDate(getTargetReadyDateValue(row))
  const summaryParts = [
    targetReadyDate ? `备货目标日 ${targetReadyDate}` : '',
    row?.capacity_load_status_label || '',
    row?.needs_sunday_work ? '周日生产' : '',
    row?.needs_move_earlier ? `前挪 ${row?.move_earlier_days || 0} 天` : '',
    hasConflictAvoidance(row) ? '已避让冲突' : '',
  ].filter(Boolean)

  return (
    <span style={{ fontWeight: 500 }}>{summaryParts.join('；') || '按排产规则自动生成'}</span>
  )
}

export const renderPlanExplainPanel = (row: any) => {
  const summary = [
    row?.schedule_bucket_label ? `排产段：${row.schedule_bucket_label}` : '',
    row?.recommended_daily_hours ? `建议工时：${Number(row.recommended_daily_hours).toFixed(2)} 小时/天` : '',
    row?.capacity_load_status_label ? `负荷状态：${row.capacity_load_status_label}` : '',
    hasConflictAvoidance(row) ? '已执行冲突避让' : '',
    row?.remark ? '详细冲突备注已保留在后端调试链路' : '',
  ].filter(Boolean).join('；')

  return (
    <div style={{ padding: '4px 8px' }}>
      <Alert
        showIcon
        type={row?.delivery_status === 'delayed' || row?.needs_move_earlier ? 'warning' : 'info'}
        message="排产摘要"
        description={summary || `当前按 ${row?.schedule_bucket_label || '默认'} 规则生成计划。`}
      />
    </div>
  )
}
