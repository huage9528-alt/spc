import { useEffect, useState } from 'react'
import { Empty, Row, Col, Tag, Spin, message, Tooltip } from 'antd'
import {
  ClockCircleOutlined, CheckCircleOutlined, ExclamationCircleOutlined,
  ThunderboltOutlined, TeamOutlined, FireOutlined, ScheduleOutlined,
} from '@ant-design/icons'
import { productionApi } from '../../../services/production'
import { formatDate } from '../../../utils'
import dayjs from 'dayjs'

interface PlanItem {
  id: number
  order_no: string | null
  line_no: string | null
  product_code: string | null
  model_code: string | null
  quantity: number | null
  plan_date: string | null
  start_date: string | null
  end_date: string | null
  status: string
  source_order_qty: number | null
  source_promised_date?: string | null
  owner: string | null
  daily_work_hours: number | null
  upph: number | null
  priority?: string | null
}

interface WorkshopFrontViewProps {
  processType: 'lean' | 'assembly' | 'packaging'
  workshopLabel: string
}

const THEME = {
  lean: { primary: '#3b82f6', gradient: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', soft: '#eff6ff', tag: 'blue' },
  assembly: { primary: '#8b5cf6', gradient: 'linear-gradient(135deg, #8b5cf6, #6d28d9)', soft: '#f5f3ff', tag: 'purple' },
  packaging: { primary: '#06b6d4', gradient: 'linear-gradient(135deg, #06b6d4, #0891b2)', soft: '#ecfeff', tag: 'cyan' },
}

const PRIORITY_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  urgent: { label: '紧急', color: '#dc2626', bg: '#fef2f2' },
  high: { label: '优先', color: '#ea580c', bg: '#fff7ed' },
  normal: { label: '正常', color: '#64748b', bg: '#f8fafc' },
  low: { label: '一般', color: '#94a3b8', bg: '#f8fafc' },
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; dot: string; icon: React.ReactNode }> = {
  in_progress: { label: '生产中', color: '#16a34a', bg: '#f0fdf4', dot: '#16a34a', icon: <ThunderboltOutlined /> },
  planned: { label: '待开始', color: '#2563eb', bg: '#eff6ff', dot: '#2563eb', icon: <ClockCircleOutlined /> },
  completed: { label: '已完成', color: '#6b7280', bg: '#f9fafb', dot: '#9ca3af', icon: <CheckCircleOutlined /> },
  delayed: { label: '延期', color: '#dc2626', bg: '#fef2f2', dot: '#dc2626', icon: <ExclamationCircleOutlined /> },
  cancelled: { label: '已取消', color: '#9ca3af', bg: '#f3f4f6', dot: '#d1d5db', icon: null },
}

// 优先级排序
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
// 状态排序（生产中 > 待开始 > 延期 > 已完成）
const STATUS_ORDER: Record<string, number> = { in_progress: 0, delayed: 1, planned: 2, completed: 3, cancelled: 4 }

export default function WorkshopFrontView({ processType, workshopLabel }: WorkshopFrontViewProps) {
  const [todayPlans, setTodayPlans] = useState<PlanItem[]>([])
  const [tomorrowPlans, setTomorrowPlans] = useState<PlanItem[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const today = dayjs().format('YYYY-MM-DD')
      const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD')

      const resToday: any = await productionApi.listSchedulePlans({
        page: 1, page_size: 100, is_active: true,
        schedule_bucket: processType, date_start: today, date_end: today,
      })
      setTodayPlans(resToday.data?.items || [])

      const resTomorrow: any = await productionApi.listSchedulePlans({
        page: 1, page_size: 50, is_active: true,
        schedule_bucket: processType, date_start: tomorrow, date_end: tomorrow,
      })
      setTomorrowPlans(resTomorrow.data?.items || [])
    } catch (e: any) {
      message.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [processType])

  const theme = THEME[processType]
  const todayStr = dayjs().format('M月D日')
  const weekDay = ['日', '一', '二', '三', '四', '五', '六'][dayjs().day()]

  // 排序：优先级 > 状态
  const sortedPlans = [...todayPlans].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority || 'normal'] ?? 2
    const pb = PRIORITY_ORDER[b.priority || 'normal'] ?? 2
    if (pa !== pb) return pa - pb
    return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
  })

  // 汇总数据
  const totalQty = todayPlans.reduce((sum, p) => sum + (Number(p.source_order_qty) || 0), 0)
  // 实际工时: 每条计划的当天实际占用 = 总工时 / 天数(不是 daily_work_hours 直接累加)
  const getActualHours = (p: any) => {
    const qty = Number(p.quantity || p.source_order_qty || 0)
    const upph = Number(p.upph || 0)
    const mp = Number(p.manpower || 10)
    if (qty > 0 && upph > 0 && mp > 0) {
      const totalH = qty / (upph * mp)
      const start = p.start_date ? new Date(p.start_date) : null
      const end = p.end_date ? new Date(p.end_date) : null
      const days = start && end ? Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1) : 1
      return totalH / days
    }
    return Number(p.daily_work_hours) || 0
  }
  const totalHours = todayPlans.reduce((sum, p) => sum + getActualHours(p), 0)
  const inProgressCount = todayPlans.filter(p => p.status === 'in_progress').length
  const completedCount = todayPlans.filter(p => p.status === 'completed').length
  const urgentCount = todayPlans.filter(p => p.priority === 'urgent' || p.priority === 'high').length
  const isBusy = totalHours > 12

  // 明日汇总
  const tomorrowQty = tomorrowPlans.reduce((sum, p) => sum + (Number(p.source_order_qty) || 0), 0)
  const tomorrowHours = tomorrowPlans.reduce((sum, p) => sum + getActualHours(p), 0)

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* ===== 顶部 Banner ===== */}
      <div style={{
        background: theme.gradient,
        borderRadius: 16, padding: '24px 32px', marginBottom: 16,
        color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
      }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>{workshopLabel}</div>
          <div style={{ fontSize: 15, opacity: 0.85 }}>
            {todayStr} 周{weekDay} · 今日任务 {todayPlans.length} 单
            {urgentCount > 0 && <span style={{ marginLeft: 8, background: 'rgba(255,255,255,0.2)', padding: '2px 10px', borderRadius: 10 }}>⚠ {urgentCount} 单紧急</span>}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 36, fontWeight: 800, lineHeight: 1 }}>{totalHours.toFixed(1)}</div>
          <div style={{ fontSize: 13, opacity: 0.8 }}>今日总工时（小时）</div>
        </div>
      </div>

      {/* ===== 指标条 ===== */}
      <Row gutter={12} style={{ marginBottom: 16 }}>
        {[
          { icon: <ThunderboltOutlined />, label: '应产总量', value: totalQty, unit: '件', color: theme.primary },
          { icon: <FireOutlined />, label: '预计工时', value: totalHours.toFixed(1), unit: 'h', color: isBusy ? '#dc2626' : '#16a34a', sub: isBusy ? '需加班' : '正常' },
          { icon: <CheckCircleOutlined />, label: '生产中', value: inProgressCount, unit: '单', color: '#16a34a' },
          { icon: <ClockCircleOutlined />, label: '已完成', value: completedCount, unit: '单', color: '#6b7280' },
        ].map((m, i) => (
          <Col key={i} xs={12} md={6}>
            <div style={{
              background: '#fff', borderRadius: 12, padding: '16px 20px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: `${m.color}15`, color: m.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                flexShrink: 0,
              }}>
                {m.icon}
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 2 }}>{m.label}</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                  <span style={{ fontSize: 22, fontWeight: 700, color: m.color }}>{typeof m.value === 'number' ? m.value.toLocaleString() : m.value}</span>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>{m.unit}</span>
                  {m.sub && <span style={{ fontSize: 11, color: m.color, fontWeight: 600, marginLeft: 4 }}>({m.sub})</span>}
                </div>
              </div>
            </div>
          </Col>
        ))}
      </Row>

      {/* ===== 任务卡片列表 ===== */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : sortedPlans.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 48, textAlign: 'center' }}>
          <Empty description="今日暂无生产任务" />
        </div>
      ) : (
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          {sortedPlans.map((plan, idx) => {
            const meta = STATUS_CONFIG[plan.status] || STATUS_CONFIG.planned
            const prio = PRIORITY_CONFIG[plan.priority || 'normal'] || PRIORITY_CONFIG.normal
            const qty = Number(plan.source_order_qty || plan.quantity || 0)
            const workHours = Number(plan.daily_work_hours) || 8.5
            const upph = Number(plan.upph) || 0
            const isOverflow = workHours > 12
            const dailyCapacity = upph > 0 ? Math.round(upph * Math.min(workHours, 12)) : null
            const daysNeeded = dailyCapacity && dailyCapacity > 0 ? Math.ceil(qty / dailyCapacity) : null
            const customerDue = plan.source_promised_date || plan.plan_date
            const daysToDue = customerDue ? dayjs(customerDue).diff(dayjs().startOf('day'), 'day') : null

            return (
              <Col key={plan.id} xs={24} sm={12} lg={8} xl={6}>
                <div style={{
                  background: '#fff', borderRadius: 12, overflow: 'hidden',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                  border: `1px solid ${meta.color}20`,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 6px 20px rgba(0,0,0,0.12)' }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.08)' }}
                >
                  {/* 顶部色条 + 序号 + 优先级 + 状态 */}
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 16px', background: prio.bg, borderBottom: `2px solid ${prio.color}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        width: 22, height: 22, borderRadius: '50%',
                        background: theme.primary, color: '#fff',
                        fontSize: 12, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>{idx + 1}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700, color: '#1e293b' }}>
                        {plan.order_no || '-'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <Tag style={{ background: prio.bg, color: prio.color, border: `1px solid ${prio.color}30`, fontSize: 11, borderRadius: 8 }}>
                        {prio.label}
                      </Tag>
                      <Tag style={{ background: meta.bg, color: meta.color, border: 'none', fontSize: 11, borderRadius: 8 }}>
                        {meta.icon} {meta.label}
                      </Tag>
                    </div>
                  </div>

                  <div style={{ padding: 16 }}>
                    {/* 型号 + 产品 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: '#334155' }}>
                        {plan.model_code || '-'}
                      </span>
                      {plan.product_code && (
                        <span style={{ fontSize: 11, color: '#cbd5e1' }}>{plan.product_code}</span>
                      )}
                    </div>

                    {/* 应产 + 每天目标 */}
                    <div style={{
                      display: 'flex', gap: 0, marginBottom: 14,
                      background: theme.soft, borderRadius: 10, padding: '12px 16px',
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>应产数量</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                          <span style={{ fontSize: 24, fontWeight: 800, color: theme.primary, lineHeight: 1 }}>
                            {qty.toLocaleString()}
                          </span>
                          <span style={{ fontSize: 13, color: '#94a3b8' }}>件</span>
                        </div>
                      </div>
                      {dailyCapacity && (
                        <div style={{ flex: 1, borderLeft: '1px solid #e2e8f0', paddingLeft: 16 }}>
                          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>每天目标</div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                            <span style={{ fontSize: 18, fontWeight: 700, color: '#334155' }}>
                              {dailyCapacity.toLocaleString()}
                            </span>
                            <span style={{ fontSize: 12, color: '#94a3b8' }}>件/天</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 关键信息行 */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {/* 工时 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                        <ClockCircleOutlined style={{ color: '#94a3b8', fontSize: 12 }} />
                        <span style={{ color: '#64748b' }}>工时</span>
                        <span style={{
                          fontWeight: 600,
                          color: isOverflow ? '#dc2626' : workHours > 10 ? '#f59e0b' : '#334155',
                        }}>
                          {workHours.toFixed(1)}h/天
                        </span>
                        {isOverflow && <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>⚠ 超限</span>}
                        {daysNeeded && (
                          <span style={{ color: '#94a3b8', fontSize: 12, marginLeft: 'auto' }}>预计 {daysNeeded} 天</span>
                        )}
                      </div>

                      {/* 交期 */}
                      {customerDue && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                          <ScheduleOutlined style={{ color: '#94a3b8', fontSize: 12 }} />
                          <span style={{ color: '#64748b' }}>交期</span>
                          <span style={{ fontWeight: 600, color: daysToDue !== null && daysToDue <= 2 ? '#dc2626' : '#334155' }}>
                            {formatDate(customerDue)}
                          </span>
                          {daysToDue !== null && daysToDue <= 2 && daysToDue >= 0 && (
                            <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>剩 {daysToDue} 天</span>
                          )}
                          {daysToDue !== null && daysToDue < 0 && (
                            <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>已逾期</span>
                          )}
                        </div>
                      )}

                      {/* 生产周期 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                        <ThunderboltOutlined style={{ color: '#94a3b8', fontSize: 12 }} />
                        <span style={{ color: '#64748b' }}>周期</span>
                        <span style={{ fontWeight: 500, color: '#334155' }}>
                          {formatDate(plan.start_date)} → {formatDate(plan.end_date)}
                        </span>
                      </div>

                      {/* 负责人 */}
                      {plan.owner && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                          <TeamOutlined style={{ color: '#94a3b8', fontSize: 12 }} />
                          <span style={{ color: '#64748b' }}>负责人</span>
                          <span style={{ fontWeight: 500, color: '#334155' }}>{plan.owner}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </Col>
            )
          })}
        </Row>
      )}

      {/* ===== 明日预告 ===== */}
      {!loading && tomorrowPlans.length > 0 && (
        <div style={{
          background: '#fff', borderRadius: 12, padding: '16px 24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12,
            paddingBottom: 10, borderBottom: '1px solid #f1f5f9',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ClockCircleOutlined style={{ color: theme.primary }} />
              <span style={{ fontSize: 15, fontWeight: 600, color: '#1e293b' }}>明日预告</span>
            </div>
            <span style={{ fontSize: 13, color: '#64748b' }}>
              {tomorrowPlans.length} 单 · {tomorrowQty.toLocaleString()} 件 · {tomorrowHours.toFixed(1)}h
            </span>
            <Tag color={tomorrowHours > tomorrowPlans.length * 10 ? 'red' : tomorrowHours > tomorrowPlans.length * 8.5 ? 'orange' : 'green'}
              style={{ fontSize: 11, borderRadius: 10 }}>
              {tomorrowHours > tomorrowPlans.length * 10 ? '较忙' : tomorrowHours > tomorrowPlans.length * 8.5 ? '适中' : '轻松'}
            </Tag>
          </div>
          <Row gutter={[8, 8]}>
            {tomorrowPlans.map(plan => (
              <Col key={plan.id} xs={12} sm={8} md={6} lg={4}>
                <Tooltip title={`${plan.model_code || '-'} · ${plan.owner || '-'}`}>
                  <div style={{
                    padding: '8px 12px', background: theme.soft, borderRadius: 8,
                    display: 'flex', alignItems: 'center', gap: 6,
                    transition: 'background 0.2s', cursor: 'pointer',
                    border: `1px solid ${theme.primary}10`,
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#fff'}
                  onMouseLeave={(e) => e.currentTarget.style.background = theme.soft}
                  >
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: theme.primary, flexShrink: 0 }} />
                    <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>
                      {plan.order_no || '-'}
                    </span>
                    <span style={{ fontSize: 11, color: '#64748b' }}>
                      {(Number(plan.source_order_qty) || 0).toLocaleString()}件
                    </span>
                  </div>
                </Tooltip>
              </Col>
            ))}
          </Row>
        </div>
      )}
    </div>
  )
}
