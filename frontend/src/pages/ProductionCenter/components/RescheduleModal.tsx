import { useMemo, useState } from 'react'
import { Alert, Descriptions, Modal, Space, message } from 'antd'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/production'
import { formatDate } from '../../../utils'
import { EVENT_TYPE_MAP } from '../SchedulePlans/constants'
import {
  getTargetReadyDateValue,
  getProjectedRescheduleStartDate,
  getProjectedRescheduleEndDate,
  renderDeliveryStatusTag,
} from '../SchedulePlans/helpers'

interface ReschedulePlanData {
  id: number
  order_no?: string
  line_no?: string
  plan_version?: number
  event_type?: string
  before_value_text?: string
  after_value_text?: string
  impact_reason?: string
  reschedule_reason?: string
  start_date?: string
  end_date?: string
  current_days_needed?: number
  target_ready_date?: string
}

interface RescheduleModalProps {
  open: boolean
  planData: ReschedulePlanData | null
  onClose: () => void
  onSuccess?: () => void
}

export default function RescheduleModal({ open, planData, onClose, onSuccess }: RescheduleModalProps) {
  const [loading, setLoading] = useState(false)

  // 计算重排预览数据（和巨无霸里的 useMemo 逻辑一致）
  const previewData = useMemo(() => {
    if (!planData) return null
    const targetReadyDate = getTargetReadyDateValue(planData)
    const projectedStartDate = getProjectedRescheduleStartDate(planData)
    const projectedEndDate = getProjectedRescheduleEndDate(planData)
    const originalEndDate = planData.end_date ? dayjs(planData.end_date).startOf('day') : null
    const changeDays = projectedEndDate && originalEndDate ? projectedEndDate.diff(originalEndDate, 'day') : null
    const projectedStatus = projectedEndDate && targetReadyDate
      ? (projectedEndDate.isAfter(dayjs(targetReadyDate).startOf('day'))
        ? 'delayed'
        : (dayjs(targetReadyDate).startOf('day').diff(projectedEndDate, 'day') >= 2 ? 'early' : 'normal'))
      : 'unknown'
    return {
      ...planData,
      target_ready_date: targetReadyDate,
      projected_start_date: projectedStartDate ? projectedStartDate.format('YYYY-MM-DD') : null,
      projected_end_date: projectedEndDate ? projectedEndDate.format('YYYY-MM-DD') : null,
      change_days: changeDays,
      projected_status: projectedStatus,
    }
  }, [planData])

  const handleConfirm = async () => {
    if (!planData?.id) return
    setLoading(true)
    try {
      await productionApi.reschedulePlan(planData.id)
      message.success('重排成功')
      onClose()
      onSuccess?.()
    } catch (e: any) {
      message.error(e.message || '重排失败')
    } finally {
      setLoading(false)
    }
  }

  if (!planData) return null

  return (
    <Modal
      title={`重排预览${previewData?.order_no ? ` - ${previewData.order_no}` : ''}`}
      open={open}
      destroyOnHidden
      onCancel={onClose}
      onOk={handleConfirm}
      okText="确认重排"
      cancelText="取消"
      confirmLoading={loading}
      width={820}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          showIcon
          type={(previewData?.change_days || 0) > 0 ? 'warning' : 'info'}
          message="先看影响，再决定是否重排"
          description="这里展示触发重排的变更原因，以及按最新订单快照和当前能力口径预估后的日期影响。"
        />
        <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label="这是什么" span={2}>
            {previewData?.order_no || '-'} / {previewData?.line_no || '-'}，当前版本 V{previewData?.plan_version || 1}
          </Descriptions.Item>
          <Descriptions.Item label="为什么弹出来" span={2}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <span>触发事件：{EVENT_TYPE_MAP[previewData?.event_type || 'upph_change']?.label || '变更事件'}</span>
              <span>变更前：{previewData?.before_value_text || '-'}</span>
              <span>变更后：{previewData?.after_value_text || '-'}</span>
              <span>{previewData?.impact_reason || previewData?.reschedule_reason || 'UPPH 变化后建议重排'}</span>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="如果我做了会怎样" span={2}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <span>旧计划：{formatDate(previewData?.start_date)} 至 {formatDate(previewData?.end_date)}</span>
              <span>新计划：{formatDate(previewData?.projected_start_date)} 至 {formatDate(previewData?.projected_end_date)}</span>
              <span>变化天数：{previewData?.change_days === null || previewData?.change_days === undefined ? '无法预估' : `${previewData.change_days > 0 ? '+' : ''}${previewData.change_days} 天`}</span>
              <span>交期影响：{renderDeliveryStatusTag(previewData?.projected_status, { target_ready_date: previewData?.target_ready_date, end_date: previewData?.projected_end_date })}</span>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="我现在可以做什么" span={2}>
            <span>确认后将按最新订单快照与当前能力重新生成新版本计划，旧版本保留为历史记录。</span>
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </Modal>
  )
}
