import { useEffect, useMemo, useState } from 'react'
import { Alert, DatePicker, Descriptions, Input, InputNumber, Modal, Space, Spin, Table, Tag, message } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { productionApi } from '../../../services/production'
import { formatDate } from '../../../utils'
import { EVENT_TYPE_MAP } from '../SchedulePlans/constants'

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
  manpower?: number
  daily_work_hours?: number
  upph?: number
  quantity?: number
}

interface MoveItem {
  plan_id: number
  order_no: string | null
  line_no: string | null
  product_code: string | null
  old_start: string | null
  old_end: string | null
  new_start: string | null
  new_end: string | null
  shift_days: number
  move_reason: string
  is_target: boolean
  in_frozen_zone: boolean
  warnings: string[]
  new_manpower?: number | null
  new_daily_work_hours?: number | null
  duration_changed?: boolean
}

interface PreviewResult {
  target_plan_id: number
  target_new_start: string | null
  target_new_end: string | null
  target_manpower?: number | null
  target_daily_work_hours?: number | null
  moves: MoveItem[]
  conflicts_in_frozen_zone: number[]
  has_warnings: boolean
  summary: string
}

interface RescheduleModalProps {
  open: boolean
  planData: ReschedulePlanData | null
  onClose: () => void
  onSuccess?: () => void
}

export default function RescheduleModal({ open, planData, onClose, onSuccess }: RescheduleModalProps) {
  const [targetDate, setTargetDate] = useState<Dayjs | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [breakFrozenReason, setBreakFrozenReason] = useState('')
  const [applying, setApplying] = useState(false)
  // 产能调整: 默认沿用原值, 用户可改
  const [manpower, setManpower] = useState<number | null>(null)
  const [dailyWorkHours, setDailyWorkHours] = useState<number | null>(null)

  // 弹窗打开时初始化默认值(沿用原计划)
  useEffect(() => {
    if (open && planData) {
      setManpower(planData.manpower ?? 10)
      setDailyWorkHours(planData.daily_work_hours ?? 8.5)
    }
  }, [open, planData])

  // 选日期 / 改人数 / 改工时 后自动调 preview 接口
  useEffect(() => {
    if (!open || !planData?.id || !targetDate) {
      setPreview(null)
      return
    }
    let cancelled = false
    const fetchPreview = async () => {
      setPreviewLoading(true)
      try {
        const originalManpower = planData.manpower ?? 10
        const originalHours = planData.daily_work_hours ?? 8.5
        // 只在值真的变了的时候传, 不然后端默认沿用
        const manpowerParam = manpower && manpower !== originalManpower ? manpower : undefined
        const hoursParam = dailyWorkHours && Math.abs(dailyWorkHours - originalHours) > 0.01 ? dailyWorkHours : undefined
        const res = await productionApi.reschedulePreview(
          planData.id,
          targetDate.format('YYYY-MM-DD'),
          manpowerParam,
          hoursParam,
        )
        if (!cancelled) {
          setPreview(res.data)
        }
      } catch (e: any) {
        if (!cancelled) {
          message.error(e.message || '获取预览失败')
          setPreview(null)
        }
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    }
    fetchPreview()
    return () => {
      cancelled = true
    }
  }, [open, planData?.id, planData?.manpower, planData?.daily_work_hours, targetDate, manpower, dailyWorkHours])

  const needBreakFrozen = !!preview?.conflicts_in_frozen_zone?.length

  const handleConfirm = async () => {
    if (!planData?.id) return
    if (!targetDate) {
      message.warning('请先选择目标日期')
      return
    }
    if (needBreakFrozen && !breakFrozenReason.trim()) {
      message.warning('本次重排涉及冷冻区计划, 必须填写破冻理由')
      return
    }
    setApplying(true)
    try {
      // 只有用户真的改了值才传
      const originalManpower = planData.manpower ?? 10
      const originalHours = planData.daily_work_hours ?? 8.5
      const manpowerParam = manpower && manpower !== originalManpower ? manpower : undefined
      const hoursParam = dailyWorkHours && Math.abs(dailyWorkHours - originalHours) > 0.01 ? dailyWorkHours : undefined
      await productionApi.reschedulePlan(
        planData.id,
        targetDate.format('YYYY-MM-DD'),
        breakFrozenReason || undefined,
        manpowerParam,
        hoursParam,
      )
      message.success('重排成功')
      handleClose()
      onSuccess?.()
    } catch (e: any) {
      message.error(e.message || '重排失败')
    } finally {
      setApplying(false)
    }
  }

  const handleClose = () => {
    setTargetDate(null)
    setPreview(null)
    setBreakFrozenReason('')
    setManpower(null)
    setDailyWorkHours(null)
    onClose()
  }

  // 分类展示
  const groupedMoves = useMemo(() => {
    if (!preview) return { target: null, pushed: [], pulled: [] }
    const target = preview.moves.find((m) => m.is_target) || null
    const pushed = preview.moves.filter((m) => m.move_reason === '冲突推后')
    const pulled = preview.moves.filter((m) => m.move_reason === '空档前挪')
    return { target, pushed, pulled }
  }, [preview])

  if (!planData) return null

  return (
    <Modal
      title={`重排预览${planData.order_no ? ` - ${planData.order_no}` : ''}`}
      open={open}
      destroyOnHidden
      onCancel={handleClose}
      onOk={handleConfirm}
      okText="确认重排"
      cancelText="取消"
      confirmLoading={applying}
      okButtonProps={{ disabled: !preview || previewLoading }}
      width={900}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {/* 当前计划信息 */}
        <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label="订单" span={2}>
            {planData.order_no || '-'} / {planData.line_no || '-'} (V{planData.plan_version || 1})
          </Descriptions.Item>
          <Descriptions.Item label="原计划日期" span={2}>
            <Tag color="blue">{formatDate(planData.start_date)}</Tag>
            {' ~ '}
            <Tag color="blue">{formatDate(planData.end_date)}</Tag>
          </Descriptions.Item>
          {planData.event_type && (
            <Descriptions.Item label="触发事件" span={2}>
              {EVENT_TYPE_MAP[planData.event_type]?.label || planData.event_type}
              {planData.reschedule_reason ? ` - ${planData.reschedule_reason}` : ''}
            </Descriptions.Item>
          )}
          <Descriptions.Item label="改到哪天" span={2}>
            <DatePicker
              value={targetDate}
              onChange={(date) => setTargetDate(date)}
              style={{ width: '100%' }}
              placeholder="选择目标开工日期"
              allowClear
            />
            <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
              选日期后会自动预览对其他计划的影响
            </div>
          </Descriptions.Item>
          <Descriptions.Item label="班组人数" span={1}>
            <InputNumber
              value={manpower ?? undefined}
              onChange={(v) => setManpower(v ?? null)}
              min={1}
              max={200}
              style={{ width: '100%' }}
            />
            <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
              原 {planData.manpower ?? '-'} 人
            </div>
          </Descriptions.Item>
          <Descriptions.Item label="每日工时" span={1}>
            <InputNumber
              value={dailyWorkHours ?? undefined}
              onChange={(v) => setDailyWorkHours(v ?? null)}
              min={1}
              max={24}
              step={0.5}
              style={{ width: '100%' }}
            />
            <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
              原 {planData.daily_work_hours ?? '-'} h
            </div>
          </Descriptions.Item>
          <Descriptions.Item label="产能公式" span={2}>
            <div style={{ color: '#595959', fontSize: 12 }}>
              UPPH <b>{planData.upph ? Number(planData.upph).toFixed(2) : '-'}</b>
              {' × '}人数 <b>{manpower ?? '-'}</b>
              {' × '}工时 <b>{dailyWorkHours ?? '-'}</b>
              {' = '}日产能 <b>{(planData.upph && manpower && dailyWorkHours) ? (planData.upph * manpower * dailyWorkHours).toFixed(0) : '-'} 件</b>
              {planData.quantity && (
                <span>（订单 {planData.quantity} 件, 约需 {
                  planData.upph && manpower && dailyWorkHours
                    ? Math.ceil(planData.quantity / (planData.upph * manpower * dailyWorkHours))
                    : '-'
                } 天）</span>
              )}
            </div>
          </Descriptions.Item>
        </Descriptions>

        {/* 预览结果 */}
        {previewLoading && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin tip="正在计算影响..." />
          </div>
        )}

        {preview && !previewLoading && (
          <>
            {preview.summary && (
              <Alert
                showIcon
                type={preview.has_warnings ? 'warning' : 'success'}
                message={preview.summary}
              />
            )}

            {/* 目标计划 */}
            {groupedMoves.target && (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8, color: '#1677ff' }}>
                  ★ 目标计划
                </div>
                <Descriptions bordered size="small" column={2}>
                  <Descriptions.Item label="订单" span={2}>
                    {groupedMoves.target.order_no || '-'} / {groupedMoves.target.line_no || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="原日期" span={1}>
                    {formatDate(groupedMoves.target.old_start)} ~ {formatDate(groupedMoves.target.old_end)}
                  </Descriptions.Item>
                  <Descriptions.Item label="新日期" span={1}>
                    <Tag color="green">{formatDate(groupedMoves.target.new_start)}</Tag>
                    {' ~ '}
                    <Tag color="green">{formatDate(groupedMoves.target.new_end)}</Tag>
                  </Descriptions.Item>
                </Descriptions>
              </div>
            )}

            {/* 被挤掉的 */}
            {groupedMoves.pushed.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8, color: '#fa541c' }}>
                  ⚠ 被挤掉的(共{groupedMoves.pushed.length}条, 自动推后)
                </div>
                <Table
                  size="small"
                  rowKey="plan_id"
                  dataSource={groupedMoves.pushed}
                  pagination={false}
                  columns={[
                    { title: '订单', dataIndex: 'order_no', width: 160, ellipsis: true },
                    {
                      title: '原日期',
                      width: 200,
                      render: (_, r) => `${formatDate(r.old_start)} ~ ${formatDate(r.old_end)}`,
                    },
                    {
                      title: '新日期',
                      width: 200,
                      render: (_, r) => (
                        <>
                          <Tag color="orange">{formatDate(r.new_start)}</Tag>
                          {' ~ '}
                          <Tag color="orange">{formatDate(r.new_end)}</Tag>
                        </>
                      ),
                    },
                    {
                      title: '挪动',
                      dataIndex: 'shift_days',
                      width: 80,
                      render: (v: number) => (
                        <Tag color={v > 0 ? 'red' : 'green'}>
                          {v > 0 ? `+${v}` : v} 天
                        </Tag>
                      ),
                    },
                  ]}
                />
              </div>
            )}

            {/* 前挪填补的 */}
            {groupedMoves.pulled.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8, color: '#52c41a' }}>
                  ✦ 自动前挪填补空档(共{groupedMoves.pulled.length}条)
                </div>
                <Table
                  size="small"
                  rowKey="plan_id"
                  dataSource={groupedMoves.pulled.slice(0, 5)}
                  pagination={groupedMoves.pulled.length > 5 ? { pageSize: 5, simple: true } : false}
                  columns={[
                    { title: '订单', dataIndex: 'order_no', width: 160, ellipsis: true },
                    {
                      title: '原开始',
                      dataIndex: 'old_start',
                      width: 110,
                      render: (v) => formatDate(v),
                    },
                    {
                      title: '新开始',
                      dataIndex: 'new_start',
                      width: 110,
                      render: (v) => <Tag color="green">{formatDate(v)}</Tag>,
                    },
                    {
                      title: '前挪',
                      dataIndex: 'shift_days',
                      width: 80,
                      render: (v: number) => (
                        <Tag color="blue">
                          {v} 天
                        </Tag>
                      ),
                    },
                  ]}
                />
                {groupedMoves.pulled.length > 5 && (
                  <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
                    还有 {groupedMoves.pulled.length - 5} 条前挪, 全部明细可看后端日志
                  </div>
                )}
              </div>
            )}

            {/* 冷冻区警告 + 破冻理由 */}
            {needBreakFrozen && (
              <Alert
                type="error"
                showIcon
                message={`本次重排涉及 ${preview.conflicts_in_frozen_zone.length} 条冷冻区计划`}
                description={
                  <Input.TextArea
                    placeholder="请填写破冻理由(必填)"
                    value={breakFrozenReason}
                    onChange={(e) => setBreakFrozenReason(e.target.value)}
                    rows={2}
                    style={{ marginTop: 8 }}
                  />
                }
              />
            )}

            {/* 其他警告 */}
            {preview.moves.some((m) => m.warnings.length > 0 && !m.in_frozen_zone) && (
              <Alert
                type="warning"
                showIcon
                message="有计划警告"
                description={
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {preview.moves
                      .filter((m) => m.warnings.length > 0)
                      .flatMap((m) => m.warnings.map((w, i) => (
                        <li key={`${m.plan_id}-${i}`}>
                          {m.order_no}: {w}
                        </li>
                      )))}
                  </ul>
                }
              />
            )}

            <div style={{ color: '#888', fontSize: 12 }}>
              确认后:旧版本计划保留为历史, 新建一个 V{Math.max(planData.plan_version || 1, 1) + 1} 版本生效.
            </div>
          </>
        )}
      </Space>
    </Modal>
  )
}
