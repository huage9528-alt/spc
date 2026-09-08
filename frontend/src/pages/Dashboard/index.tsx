import { useEffect, useState, useCallback, useRef } from 'react'
import { message, Modal } from 'antd'
import StatCards from './components/StatCards'
import RollingRiskChart from './components/RollingRiskChart'
import RiskDonut from './components/RiskDonut'
import DueOrdersTable from './components/DueOrdersTable'
import ClosureSparkline from './components/ClosureSparkline'
import PendingItems from './components/PendingItems'
import ProcurementBoard from './components/ProcurementBoard'
import ShipmentBoard from './components/ShipmentBoard'
import { dashboardApi, riskApi } from '../../services/api'
import './dashboard.css'

type DashboardTab = 'today' | 'procurement' | 'shipment'

const REFRESH_INTERVAL = 30 * 60 * 1000

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<DashboardTab>('today')
  const [scanning, setScanning] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  // 今日总览
  const [todayOverview, setTodayOverview] = useState<any>(null)
  const [todayDueOrders, setTodayDueOrders] = useState<any[]>([])
  const [todayLoading, setTodayLoading] = useState(false)

  // 14天滚动风险
  const [rollingRisk, setRollingRisk] = useState<any>(null)
  const [rollingLoading, setRollingLoading] = useState(false)

  // 订单风险分布
  const [riskDistribution, setRiskDistribution] = useState<any>(null)
  const [distributionLoading, setDistributionLoading] = useState(false)

  // 闭环达成
  const [closureData, setClosureData] = useState<any>(null)
  const [closureLoading, setClosureLoading] = useState(false)

  // ===== 数据获取 =====

  const fetchTodayOverview = useCallback(async () => {
    setTodayLoading(true)
    try {
      const [overviewRes, ordersRes]: any[] = await Promise.all([
        dashboardApi.getTodayOverview(),
        dashboardApi.getTodayDueOrders({ page: 1, page_size: 50 }),
      ])
      setTodayOverview(overviewRes.data)
      setTodayDueOrders(ordersRes.data.items || [])
      setLastUpdated(new Date().toTimeString().slice(0, 5))
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setTodayLoading(false)
    }
  }, [])

  const fetchRollingRisk = useCallback(async () => {
    setRollingLoading(true)
    try {
      const res: any = await dashboardApi.getRollingRisk()
      setRollingRisk(res.data)
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setRollingLoading(false)
    }
  }, [])

  const fetchRiskDistribution = useCallback(async () => {
    setDistributionLoading(true)
    try {
      const res: any = await dashboardApi.getOrderRiskDistribution()
      setRiskDistribution(res.data)
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setDistributionLoading(false)
    }
  }, [])

  const fetchClosureAchievement = useCallback(async () => {
    setClosureLoading(true)
    try {
      const res: any = await dashboardApi.getClosureAchievement()
      setClosureData(res.data)
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setClosureLoading(false)
    }
  }, [])

  const fetchAllToday = useCallback(async () => {
    await Promise.all([
      fetchTodayOverview(),
      fetchRollingRisk(),
      fetchRiskDistribution(),
      fetchClosureAchievement(),
    ])
  }, [fetchTodayOverview, fetchRollingRisk, fetchRiskDistribution, fetchClosureAchievement])

  // 按Tab懒加载
  useEffect(() => {
    if (activeTab === 'today' && !todayOverview) fetchAllToday()
  }, [activeTab])

  // 30 分钟自动刷新
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (activeTab === 'today') fetchAllToday()
    }, REFRESH_INTERVAL)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [activeTab, fetchAllToday])

  // ===== 操作 =====

  const handleScan = () => {
    Modal.confirm({
      title: '确认触发风险扫描',
      content: '将对所有活跃订单执行风险扫描并生成异常记录，确认继续？',
      okText: '确认扫描',
      cancelText: '取消',
      onOk: async () => {
        setScanning(true)
        try {
          const res: any = await riskApi.scan()
          message.success(`扫描完成: ${res.data.new_issues} 个新问题, ${res.data.updated_orders} 个订单更新`)
          if (activeTab === 'today') fetchAllToday()
        } catch {
          // 错误已由全局拦截器提示
        } finally {
          setScanning(false)
        }
      },
    })
  }

  const handleRefresh = async () => {
    if (activeTab === 'today') {
      setRefreshing(true)
      await fetchAllToday()
      setRefreshing(false)
    }
  }

  // ===== 渲染 =====

  return (
    <div className="spc-dash">
      {/* ===== Tab + 工具条 ===== */}
      <div className="card mb12">
        <div className="tabs" style={{ padding: '0 8px' }}>
          <div className={`tab ${activeTab === 'today' ? 'active' : ''}`} onClick={() => setActiveTab('today')}>
            今日总览
          </div>
          <div className={`tab ${activeTab === 'procurement' ? 'active' : ''}`} onClick={() => setActiveTab('procurement')}>
            采购看板
          </div>
          <div className={`tab ${activeTab === 'shipment' ? 'active' : ''}`} onClick={() => setActiveTab('shipment')}>
            出货计划看板
          </div>
          <div className="toolbar">
            {activeTab === 'today' && (
              <>
                <span className="meta">数据截至 {lastUpdated ?? '—'} · 每 30 分钟刷新</span>
                <button
                  className={`icon-btn ${refreshing ? 'spinning' : ''}`}
                  title="刷新"
                  onClick={handleRefresh}
                  disabled={refreshing}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                    <path d="M20 12a8 8 0 1 1-2.5-5.8" />
                    <path d="M20 3.5V8h-4.5" />
                  </svg>
                </button>
              </>
            )}
            <button className="btn btn-secondary btn-sm" onClick={handleScan} disabled={scanning}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
                <path d="M4 12h16" />
              </svg>
              {scanning ? '扫描中…' : '立即扫描'}
            </button>
          </div>
        </div>
      </div>

      {activeTab === 'today' ? (
        <>
          {/* KPI */}
          <div className="grid g4">
            <StatCards
              overview={todayOverview}
              closureRate={closureData?.closure_rate ?? 0}
              overdueIssues={closureData?.overdue_issues ?? 0}
              loading={todayLoading || closureLoading}
            />
          </div>

          {/* 主图 + 环形 */}
          <div className="grid g2-1 mt12">
            <RollingRiskChart data={rollingRisk} loading={rollingLoading} />
            <RiskDonut data={riskDistribution} loading={distributionLoading} />
          </div>

          {/* 到期订单 + 右列 */}
          <div className="grid g2-1 mt12">
            <DueOrdersTable orders={todayDueOrders} loading={todayLoading} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <ClosureSparkline
                trend={closureData?.trend ?? []}
                rate={closureData?.closure_rate ?? 0}
              />
              <PendingItems overview={todayOverview} />
            </div>
          </div>
        </>
      ) : activeTab === 'procurement' ? (
        <ProcurementBoard />
      ) : (
        <ShipmentBoard />
      )}
    </div>
  )
}
