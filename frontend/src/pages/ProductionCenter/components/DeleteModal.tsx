import { useState } from 'react'
import { Alert, Button, Col, Empty, Input, Modal, Row, Space, Statistic, Table, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { productionApi } from '../../../services/production'
import { formatDate } from '../../../utils'
import { BUCKET_COLOR_MAP } from '../SchedulePlans/constants'
import { renderCopyableText } from '../SchedulePlans/helpers'
import { Tag } from 'antd'

interface DeletePlanData {
  id: number
  order_no?: string
  line_no?: string
  plan_date?: string
  schedule_bucket?: string
  schedule_bucket_label?: string
}

interface DeleteModalProps {
  open: boolean
  planData: DeletePlanData | null
  onClose: () => void
  onSuccess?: () => void
}

// v2 阶段 2：判断计划是否在冷冻区（plan_date 在 today+1 ~ today+3）
function isPlanInFrozenZone(planDateStr?: string | null): boolean {
  if (!planDateStr) return false
  const today = dayjs().startOf('day')
  const planDate = dayjs(planDateStr).startOf('day')
  if (!planDate.isValid()) return false
  const diff = planDate.diff(today, 'day')
  return diff >= 1 && diff <= 3
}

const backfillColumns: ColumnsType<any> = [
  { title: '订单号', dataIndex: 'order_no', width: 170, render: (v: string) => renderCopyableText(v, '订单号') },
  { title: '行号', dataIndex: 'line_no', width: 100, render: (v: string) => renderCopyableText(v, '行号') },
  {
    title: '排产段',
    dataIndex: 'schedule_bucket_label',
    width: 110,
    render: (v: string, row: any) => <Tag color={BUCKET_COLOR_MAP[row?.schedule_bucket || 'pending'] || 'default'}>{v || row?.schedule_bucket || '-'}</Tag>,
  },
  { title: '当前计划日', dataIndex: 'current_plan_date', width: 120, render: (v: string) => formatDate(v) },
  { title: '建议顶到', dataIndex: 'suggested_plan_date', width: 120, render: (v: string) => <Tag color="blue">{formatDate(v)}</Tag> },
  { title: '当前开始', dataIndex: 'current_start_date', width: 120, render: (v: string) => formatDate(v) },
  { title: '当前结束', dataIndex: 'current_end_date', width: 120, render: (v: string) => formatDate(v) },
]

export default function DeleteModal({ open, planData, onClose, onSuccess }: DeleteModalProps) {
  const [deleteReason, setDeleteReason] = useState('')
  const [breakFrozenReason, setBreakFrozenReason] = useState('')
  const [backfillPreview, setBackfillPreview] = useState<any>(null)
  const [backfillPreviewOpen, setBackfillPreviewOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const deletingInFrozen = isPlanInFrozenZone(planData?.plan_date)

  const handleClose = () => {
    setDeleteReason('')
    setBreakFrozenReason('')
    setBackfillPreview(null)
    setBackfillPreviewOpen(false)
    onClose()
  }

  // 第一步：填理由 → 调 preview 接口
  const handlePreview = async () => {
    if (!planData?.id) return
    if (deletingInFrozen && !breakFrozenReason.trim()) {
      message.warning('该计划在冷冻区（1-3 天内开工），必须填写破冻理由')
      return
    }
    setLoading(true)
    try {
      const res: any = await productionApi.getDeleteSchedulePlanPreview(planData.id, {
        reason: deleteReason?.trim() || undefined,
        break_frozen_reason: breakFrozenReason?.trim() || undefined,
      })
      const result = res.data || {}
      setBackfillPreview(result)
      setBackfillPreviewOpen(true)
      message.info(result.affected_count > 0 ? `已生成删除预览，并识别出 ${result.affected_count} 条候选补位计划` : '已生成删除预览，当前没有可补位计划')
    } catch (e: any) {
      message.error(e.message || '获取删除预览失败')
    } finally {
      setLoading(false)
    }
  }

  // 第二步：确认删除（只删 / 删+补位）
  const handleConfirmDelete = async (executeBackfill: boolean) => {
    if (!planData?.id) return
    setLoading(true)
    try {
      const res: any = await productionApi.confirmDeleteSchedulePlan(planData.id, {
        reason: backfillPreview?.reason || deleteReason?.trim() || '计划员手动删除计划',
        execute_backfill: executeBackfill,
        break_frozen_reason: breakFrozenReason?.trim() || undefined,
      })
      const result = res.data || {}
      const summary = executeBackfill
        ? `已删除计划，并完成 ${result.backfill_success_count || 0} 条补位前滚`
        : '已删除计划，已回到待处理工作台'
      message.success(summary)
      handleClose()
      onSuccess?.()
    } catch (e: any) {
      message.error(e.message || (executeBackfill ? '删除并补位失败' : '删除失败'))
    } finally {
      setLoading(false)
    }
  }

  if (!planData) return null

  return (
    <>
      {/* 第一步 Modal：填删除理由 + 破冻理由 */}
      <Modal
        title="删除计划"
        open={open && !backfillPreviewOpen}
        destroyOnHidden
        onOk={handlePreview}
        onCancel={handleClose}
        okText="下一步：预览删除影响"
        cancelText="取消"
        confirmLoading={loading}
        width={560}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            showIcon
            type="warning"
            message="先输入删除原因，再预览删除影响"
            description="本次只允许删除未开始、未投产且未锁定的当前有效计划。下一步会先展示释放窗口和补位候选，再由你决定是只删除，还是删除并补位。"
          />
          <div>
            <div style={{ marginBottom: 8, color: '#595959' }}>当前计划</div>
            <div style={{ lineHeight: 1.8 }}>
              <div>订单：{planData.order_no || '-'}/{planData.line_no || '-'}</div>
              <div>计划日：{formatDate(planData.plan_date)}</div>
              <div>排产段：{planData.schedule_bucket_label || '-'}</div>
            </div>
          </div>
          {deletingInFrozen && (
            <Alert
              showIcon
              type="error"
              message="⚠ 该计划在冷冻区（1-3 天内开工）"
              description="冷冻区计划受冷冻保护，必须填写破冻理由才能删除。破冻操作会记入操作日志（is_frozen_break=true），便于事后追溯。"
            />
          )}
          <div>
            <div style={{ marginBottom: 8, color: '#595959' }}>删除原因</div>
            <Input.TextArea
              value={deleteReason}
              onChange={(e) => setDeleteReason(e.target.value)}
              rows={4}
              placeholder="例如：客户改交期、客户暂缓、计划调整"
              maxLength={200}
              showCount
            />
          </div>
          {deletingInFrozen && (
            <div>
              <div style={{ marginBottom: 8, color: '#cf1322', fontWeight: 600 }}>破冻理由（必填）</div>
              <Input.TextArea
                value={breakFrozenReason}
                onChange={(e) => setBreakFrozenReason(e.target.value)}
                rows={3}
                placeholder="例如：客户紧急改交期、设备突发故障、临时插单"
                maxLength={200}
                showCount
              />
            </div>
          )}
        </Space>
      </Modal>

      {/* 第二步 Modal：预览补位 + 选只删/删+补位 */}
      <Modal
        title="删除预览与补位建议"
        open={backfillPreviewOpen}
        destroyOnHidden
        onCancel={() => { setBackfillPreviewOpen(false); setBackfillPreview(null) }}
        footer={[
          <Button key="close" onClick={() => { setBackfillPreviewOpen(false); setBackfillPreview(null) }}>关闭</Button>,
          <Button key="delete-only" type="primary" loading={loading} onClick={() => handleConfirmDelete(false)}>
            只删除，回待处理
          </Button>,
          <Button
            key="execute-backfill"
            danger
            disabled={(backfillPreview?.items || []).length === 0}
            loading={loading}
            onClick={() => handleConfirmDelete(true)}
          >
            删除并补位，保留在已排计划
          </Button>,
        ]}
        width={980}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            showIcon
            type="warning"
            message="请先确认删除后的去向"
            description={
              <div>
                <div>点"只删除，回待处理"：这张单据会离开已排计划，并回到待处理工作台。</div>
                <div>点"删除并补位，保留在已排计划"：系统会立即生成新的补位计划，不会回待处理。</div>
                <div>如果原释放计划日已经过去，系统只会从"最早可补位日"开始补位，不会把新计划前移到过去日期。</div>
              </div>
            }
          />
          <Row gutter={12}>
            <Col span={6}>
              <div className="card-modern" style={{ padding: 16 }}>
                <Statistic title="原释放计划日" value={backfillPreview?.release_plan_date || '-'} />
              </div>
            </Col>
            <Col span={6}>
              <div className="card-modern" style={{ padding: 16 }}>
                <Statistic title="最早可补位日" value={backfillPreview?.earliest_backfill_date || backfillPreview?.release_plan_date || '-'} />
              </div>
            </Col>
            <Col span={6}>
              <div className="card-modern" style={{ padding: 16 }}>
                <Statistic title="释放排产段" value={backfillPreview?.release_bucket_label || '-'} />
              </div>
            </Col>
            <Col span={6}>
              <div className="card-modern" style={{ padding: 16 }}>
                <Statistic title="候选补位数" value={backfillPreview?.affected_count || 0} />
              </div>
            </Col>
          </Row>
          <Table
            rowKey="plan_id"
            columns={backfillColumns}
            dataSource={backfillPreview?.items || []}
            size="small"
            pagination={false}
            scroll={{ x: 1100, y: 320 }}
            locale={{ emptyText: <Empty description="当前没有可前移的补位计划" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        </Space>
      </Modal>
    </>
  )
}
