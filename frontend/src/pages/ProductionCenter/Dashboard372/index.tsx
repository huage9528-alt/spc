import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Col, Row, Space, Statistic, Tag, DatePicker, Segmented, Empty, Progress, Button, Alert, message } from 'antd'
import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons'
import dayjs, { Dayjs } from 'dayjs'
import { productionApi } from '../../../services/api'

interface ZoneKpi {
  targetQty?: number
  completedQty?: number
  completionRate?: number
  inProgressCount?: number
  lockedCount?: number
  frozenBreakCount?: number
  kitReadyRate?: number
  shortageCount?: number
  etaDelayCount?: number
  pendingKitCount?: number
}

interface AnomalyItem {
  severity: 'high' | 'medium' | 'low'
  category: 'shortage' | 'eta_delay' | 'frozen_break' | 'capacity_overflow'
  order_no: string
  text: string
  link?: string
}

interface DashboardCard {
  id: string
  orderNo: string
  bucket: 'lean' | 'assembly' | 'packaging' | 'mixed'
  dateLabel: string
  progress?: number
  hint?: string
  warnings?: string[]
}

// 今日在产计划真实数据结构（后端 /production/kpi-summary/today-cards 返回）
interface TodayCard {
  id: string
  order_no: string
  line_no: string | null
  product_code: string | null
  model_code: string | null
  bucket: 'lean' | 'assembly' | 'packaging' | 'mixed'
  plan_date: string | null
  start_date: string | null
  end_date: string | null
  target_qty: number | null
  status: string
  needs_reschedule: boolean
}

const BUCKET_LABELS: Record<string, string> = {
  lean: '精益', assembly: '组装', packaging: '包装', mixed: '组装+包装',
}

const BUCKET_COLORS: Record<string, string> = {
  lean: 'blue', assembly: 'purple', packaging: 'cyan', mixed: 'gold',
}

function _resolveBucket(sourceProcessType?: string | null): 'lean' | 'assembly' | 'packaging' | 'mixed' {
  if (!sourceProcessType) return 'mixed'
  const pt = sourceProcessType.toLowerCase()
  if (pt === 'lean') return 'lean'
  if (pt === 'assembly') return 'assembly'
  if (pt === 'packaging') return 'packaging'
  return 'mixed'
}

// mock 数据 —— 仅作为 kpi 接口失败时的 fallback；卡片已全部接真实接口
const MOCK_KPI = {
  today: { targetQty: 2300, completedQty: 1490, completionRate: 0.65, inProgressCount: 3 },
  frozen: { lockedCount: 8, frozenBreakCount: 0 },
  material: {},
  pending: { todoCount: 12, missingUpphCount: 4, unprocessedChangeCount: 2 },
  anomalies: [
    { severity: 'high' as const, category: 'shortage' as const, order_no: 'SO-2026-0007', text: '缺料 X，ETA 延期至 07-09' },
    { severity: 'medium' as const, category: 'eta_delay' as const, order_no: 'SO-2026-0008', text: '采购订单 ETA 延期 2 天' },
  ],
}

const renderCard = (card: DashboardCard, zone: 'today' | 'frozen' | 'material') => {
  const tagColor = BUCKET_COLORS[card.bucket] || 'default'
  return (
    <Card
      key={card.id}
      size="small"
      style={{ marginBottom: 8 }}
      bodyStyle={{ padding: 12 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 13 }}>{card.orderNo}</span>
        <Tag color={tagColor}>{BUCKET_LABELS[card.bucket]}</Tag>
      </div>
      <div style={{ color: '#64748b', fontSize: 12, marginBottom: 6 }}>{card.dateLabel} · {card.hint}</div>
      {card.progress !== undefined && (
        <Progress percent={card.progress} size="small" status={card.progress >= 100 ? 'success' : 'active'} />
      )}
      {card.warnings && card.warnings.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {card.warnings.map((w, i) => (
            <div key={i} style={{ color: '#e11d48', fontSize: 12 }}>⚠ {w}</div>
          ))}
        </div>
      )}
    </Card>
  )
}

const renderTodayCard = (card: TodayCard, navigate?: (path: string) => void) => {
  const tagColor = BUCKET_COLORS[card.bucket] || 'default'
  const dateRange = [card.start_date, card.end_date].filter(Boolean).join(' ~ ') || '今日'
  const warnings: string[] = []
  if (card.needs_reschedule) warnings.push('需重排')
  return (
    <Card
      key={card.id}
      size="small"
      hoverable={!!navigate}
      style={{ marginBottom: 8, cursor: navigate ? 'pointer' : 'default' }}
      bodyStyle={{ padding: 12 }}
      onClick={navigate ? () => navigate(`/schedule-plans?workspace=plan_board&planId=${card.id}`) : undefined}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontFamily: 'monospace', fontSize: 13 }}>
          {card.order_no}{card.line_no ? ` / ${card.line_no}` : ''}
        </span>
        <Tag color={tagColor}>{BUCKET_LABELS[card.bucket]}</Tag>
      </div>
      <div style={{ color: '#64748b', fontSize: 12, marginBottom: 4 }}>
        {dateRange} · 应产 {card.target_qty ?? '-'}
      </div>
      {card.model_code && (
        <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 4 }}>型号：{card.model_code}</div>
      )}
      <div>
        <Tag color={card.status === 'completed' ? 'success' : card.status === 'in_progress' ? 'processing' : 'default'}>
          {card.status}
        </Tag>
      </div>
      {warnings.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ color: '#e11d48', fontSize: 12 }}>⚠ {w}</div>
          ))}
        </div>
      )}
    </Card>
  )
}

const renderZoneStat = (label: string, value: number | string | undefined, suffix?: string, danger?: boolean) => (
  <div style={{ flex: 1, minWidth: 80 }}>
    <div style={{ fontSize: 11, color: '#94a3b8' }}>{label}</div>
    <div style={{ fontSize: 18, fontWeight: 700, color: danger ? '#e11d48' : '#1e293b' }}>
      {value === undefined || value === null ? <span style={{ color: '#cbd5e1' }}>--</span> : value}{suffix}
    </div>
  </div>
)

const renderAnomalies = (anomalies: AnomalyItem[]) => {
  if (anomalies.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无异常" />
  }
  return (
    <div>
      {anomalies.map((a, i) => {
        const color = a.severity === 'high' ? '#e11d48' : a.severity === 'medium' ? '#f59e0b' : '#3b82f6'
        return (
          <div key={i} style={{ padding: '6px 0', borderBottom: i < anomalies.length - 1 ? '1px solid #f1f5f9' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' }} />
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#64748b' }}>{a.order_no}</span>
            </div>
            <div style={{ fontSize: 13, color: '#334155', marginTop: 2, paddingLeft: 14 }}>{a.text}</div>
          </div>
        )
      })}
    </div>
  )
}

export default function Dashboard372() {
  const navigate = useNavigate()
  const [currentDate, setCurrentDate] = useState<Dayjs>(dayjs())
  const [bucketFilter, setBucketFilter] = useState<string>('all')
  const [kpi, setKpi] = useState<typeof MOCK_KPI | null>(null)
  const [todayCards, setTodayCards] = useState<TodayCard[]>([])
  const [frozenCards, setFrozenCards] = useState<TodayCard[]>([])
  const [materialCards, setMaterialCards] = useState<TodayCard[]>([])
  const [loading, setLoading] = useState(false)

  const loadTodayCards = async () => {
    try {
      const res: any = await productionApi.getTodayCards()
      if (res?.data) {
        setTodayCards(res.data as TodayCard[])
      }
    } catch {
      // 失败留空数组，今日栏显示"暂无在产单"
      setTodayCards([])
    }
  }

  // 阶段 2：冷冻/配料区卡片直接调 listSchedulePlans（用 time_zone 参数）
  const loadZoneCards = async (timeZone: 'frozen' | 'material', setter: (v: TodayCard[]) => void) => {
    try {
      const res: any = await productionApi.listSchedulePlans({
        page: 1,
        page_size: 50,
        is_active: true,
        time_zone: timeZone,
      })
      const items = res?.data?.items || []
      setter(items.map((r: any): TodayCard => ({
        id: String(r.id),
        order_no: r.order_no || '-',
        line_no: r.line_no,
        product_code: r.product_code,
        model_code: r.model_code,
        bucket: _resolveBucket(r.source_process_type),
        plan_date: r.plan_date,
        start_date: r.start_date,
        end_date: r.end_date,
        target_qty: r.source_order_qty != null ? Number(r.source_order_qty) : null,
        status: r.status,
        needs_reschedule: !!r.needs_reschedule,
      })))
    } catch {
      setter([])
    }
  }

  const loadKpi = async () => {
    setLoading(true)
    try {
      const res: any = await productionApi.getKpiSummary()
      if (res?.data) {
        const d = res.data
        setKpi({
          today: {
            targetQty: d.today?.target_qty ?? 0,
            completedQty: d.today?.completed_qty ?? 0,
            completionRate: d.today?.completion_rate ?? null,
            inProgressCount: d.today?.in_progress_count ?? 0,
          },
          frozen: {
            lockedCount: d.frozen?.locked_count ?? undefined,
            frozenBreakCount: d.frozen?.frozen_break_count ?? undefined,
          },
          material: {
            kitReadyRate: d.material?.kit_ready_rate ?? undefined,
            shortageCount: d.material?.shortage_count ?? undefined,
            etaDelayCount: d.material?.eta_delay_count ?? undefined,
            pendingKitCount: d.material?.pending_kit_count ?? undefined,
          },
          pending: {
            todoCount: d.pending?.todo_count ?? 0,
            missingUpphCount: d.pending?.missing_upph_count ?? 0,
            unprocessedChangeCount: d.pending?.unprocessed_change_count ?? 0,
          },
          anomalies: (d.anomalies || []).map((a: any) => ({
            severity: a.severity,
            category: a.category,
            order_no: a.order_no,
            text: a.text,
            link: a.link,
          })),
        })
      }
    } catch (e: any) {
      // 接口失败时退回 mock，开发阶段保护，不阻塞页面
      message.warning('KPI 接口暂不可用，显示演示数据')
      setKpi(MOCK_KPI)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadKpi()
    loadTodayCards()
    loadZoneCards('frozen', setFrozenCards)
    loadZoneCards('material', setMaterialCards)
  }, [])

  const dateLabel = useMemo(() => currentDate.format('YYYY-MM-DD'), [currentDate])

  const filterByBucket = (cards: DashboardCard[]) =>
    bucketFilter === 'all' ? cards : cards.filter(c => c.bucket === bucketFilter)

  const filterTodayByBucket = (cards: TodayCard[]) =>
    bucketFilter === 'all' ? cards : cards.filter(c => c.bucket === bucketFilter)

  const filteredTodayCards = filterTodayByBucket(todayCards)
  const filteredFrozenCards = filterTodayByBucket(frozenCards)
  const filteredMaterialCards = filterTodayByBucket(materialCards)

  const k = kpi || MOCK_KPI
  const today = k.today
  const frozen = k.frozen
  const material = k.material as ZoneKpi
  const pending = k.pending
  const anomalies = k.anomalies as AnomalyItem[]

  return (
    <div>
      {/* 顶部：标题 + 日期切换 + bucket 筛选 */}
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row align="middle" justify="space-between" gutter={16}>
          <Col>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>生产驾驶舱</div>
            <div style={{ color: '#64748b', fontSize: 12 }}>
              🔴 今日执行（在产） · 🟡 冷冻区（1-3 天锁定） · 🟢 配料区（4-10 天备料）
            </div>
          </Col>
          <Col>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <a onClick={() => setCurrentDate(d => d.subtract(1, 'day'))}><ArrowLeftOutlined /></a>
              <DatePicker value={currentDate} onChange={(v) => v && setCurrentDate(v)} allowClear={false} />
              <a onClick={() => setCurrentDate(d => d.add(1, 'day'))}><ArrowRightOutlined /></a>
            </div>
          </Col>
          <Col>
            <Segmented
              value={bucketFilter}
              onChange={(v) => setBucketFilter(v as string)}
              options={[
                { value: 'all', label: '全部' },
                { value: 'lean', label: '精益' },
                { value: 'assembly', label: '组装' },
                { value: 'packaging', label: '包装' },
              ]}
            />
          </Col>
        </Row>
      </div>

      {/* 快速入口：4 个页面直达 */}
      <div className="card-modern" style={{ padding: '12px 20px', marginBottom: 16 }}>
        <Space wrap>
          <span style={{ color: '#64748b', fontSize: 13, fontWeight: 600 }}>快速入口：</span>
          <Button size="small" type="primary" onClick={() => navigate('/todo-workbench')}>📋 待排工作台</Button>
          <Button size="small" onClick={() => navigate('/change-events')}>🔄 变更事件中心</Button>
          <Button size="small" onClick={() => navigate('/schedule-plans')}>📊 排产台账</Button>
          <Button size="small" onClick={() => navigate('/schedule-board')}>📅 排产看板</Button>
        </Space>
      </div>

      {/* 三栏驾驶舱 */}
      <Row gutter={12}>
        {/* 🔴 今日执行 */}
        <Col xs={24} md={8}>
          <Card
            size="small"
            title={<span>🔴 今日执行 · 在产</span>}
            extra={<span style={{ color: '#94a3b8', fontSize: 12 }}>产线视角</span>}
            style={{ marginBottom: 16 }}
          >
            <div style={{ display: 'flex', gap: 12, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f1f5f9' }}>
              {renderZoneStat('应产', today.targetQty)}
              {renderZoneStat('已完成', today.completedQty)}
              {renderZoneStat('完成率', today.completionRate !== undefined ? Math.round(today.completionRate * 100) : undefined, '%')}
              {renderZoneStat('在产', today.inProgressCount)}
            </div>
            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
              {filteredTodayCards.length === 0
                ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今日暂无在产单" />
                : filteredTodayCards.map(c => renderTodayCard(c, navigate))}            </div>
          </Card>
        </Col>

        {/* 🟡 冷冻区 */}
        <Col xs={24} md={8}>
          <Card
            size="small"
            title={<span>🟡 冷冻区 · 1-3 天</span>}
            extra={<span style={{ color: '#94a3b8', fontSize: 12 }}>计划员视角</span>}
            style={{ marginBottom: 16 }}
          >
            <div style={{ display: 'flex', gap: 12, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f1f5f9' }}>
              {renderZoneStat('锁定', frozen.lockedCount, ' 单')}
              {renderZoneStat('干预', frozen.frozenBreakCount, ' 次', (frozen.frozenBreakCount || 0) > 0)}
            </div>
            {filteredFrozenCards.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="冷冻区已锁定"
                description="此区计划受冷冻保护，删除/修改需提供破冻理由（留痕可追溯）。"
                style={{ marginBottom: 8 }}
              />
            )}
            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
              {filteredFrozenCards.length === 0
                ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="冷冻区暂无锁定计划" />
                : filteredFrozenCards.map(c => renderTodayCard(c, navigate))}
            </div>
          </Card>
        </Col>

        {/* 🟢 配料区 */}
        <Col xs={24} md={8}>
          <Card
            size="small"
            title={<span>🟢 配料区 · 4-10 天</span>}
            extra={<span style={{ color: '#94a3b8', fontSize: 12 }}>仓库/采购视角</span>}
            style={{ marginBottom: 16 }}
          >
            <div style={{ display: 'flex', gap: 12, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f1f5f9' }}>
              {renderZoneStat('待备料', material.pendingKitCount, ' 单')}
              {renderZoneStat('齐套率', material.kitReadyRate !== undefined ? Math.round((material.kitReadyRate || 0) * 100) : undefined, '%')}
              {renderZoneStat('缺料', material.shortageCount, ' 单', (material.shortageCount || 0) > 0)}
              {renderZoneStat('ETA延期', material.etaDelayCount, ' 单', (material.etaDelayCount || 0) > 0)}
            </div>
            <Alert
              type="info"
              showIcon
              message="齐套率暂为占位（假设全部齐套）"
              description="齐套中心完善后接入真实缺料/ETA 数据（v2 阶段 3）。当前「待备料」为配料区真实计划数。"
              style={{ marginBottom: 8 }}
            />
            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
              {filteredMaterialCards.length === 0
                ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="配料区暂无备料计划" />
                : filteredMaterialCards.map(c => renderTodayCard(c, navigate))}
            </div>
          </Card>
        </Col>
      </Row>

      {/* 底部：待排/变更 + 异常清单 */}
      <Row gutter={12}>
        <Col xs={24} md={8}>
          <Card size="small" title="📋 待排 / 变更" extra={<Button type="link" size="small" onClick={() => navigate('/todo-workbench')}>进待排工作台 →</Button>} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              {renderZoneStat('待排', pending.todoCount, ' 单')}
              {renderZoneStat('缺UPPH', pending.missingUpphCount)}
              {renderZoneStat('未处理变更', pending.unprocessedChangeCount)}
            </div>
          </Card>
        </Col>
        <Col xs={24} md={16}>
          <Card size="small" title={`⚠ 异常提醒（${anomalies.length}）`} extra={<Button type="link" size="small" onClick={() => navigate('/change-events')}>进变更事件中心 →</Button>} style={{ marginBottom: 16 }}>
            {renderAnomalies(anomalies)}
          </Card>
        </Col>
      </Row>

      <div style={{ color: '#94a3b8', fontSize: 11, textAlign: 'center', padding: '8px 0' }}>
        当前日期：{dateLabel} · 今日/冷冻/配料/待排均来自真实接口 · 配料的物料齐套率等指标待阶段 3 接通
      </div>
    </div>
  )
}
