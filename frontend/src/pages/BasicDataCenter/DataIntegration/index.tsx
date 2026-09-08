import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Button, message, Modal, Segmented, Tooltip, Spin, Empty,
} from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { importExportApi } from '../../../services/api'
import PermButton from '../../../components/PermButton'
import dayjs from 'dayjs'

interface TypeCfg {
  label: string
  configured: boolean
  is_active: boolean
  has_sql: boolean
  has_mapping: boolean
  sync_enabled?: boolean
}

interface ConfigStatus {
  enabled: boolean
  erp_db_configured: boolean
  types: Record<string, TypeCfg>
}

interface LastSync {
  timestamp: string | null
  status: string
  message: string | null
}

interface SyncStatus {
  enabled: boolean
  erp_db_configured: boolean
  last_sync: Record<string, LastSync | null>
}

interface FeedItem {
  task_id: string
  sync_type: string
  trigger_mode: string
  triggered_by: string | null
  status: string
  started_at: string | null
  finished_at: string | null
  duration_seconds: number | null
  created_count: number | null
  updated_count: number | null
  failed_count: number | null
  message: string | null
  created_at: string | null
}

interface ErpOrder {
  order_no: string | null
  line_no: any
  customer: string | null
  product_name: string | null
  promised_date: string | null
}

const HOURS_OPTIONS = [
  { label: '1小时', value: 1 },
  { label: '4小时', value: 4 },
  { label: '24小时', value: 24 },
  { label: '3天', value: 72 },
]

const COLORS = { ok: '#16a34a', err: '#dc2626', warn: '#d97706', gray: '#c3cbd8', acc: '#1668dc', sub: '#8a94a6' }

const dotStyle = (color: string): React.CSSProperties => ({
  width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
  background: color, flexShrink: 0,
})

const fs = (px: number): string => `calc(${px}px * var(--font-size-scale, 1))`

function relTime(ts: string | null | undefined): string | null {
  if (!ts) return null
  const d = dayjs(ts)
  if (!d.isValid()) return null
  const min = dayjs().diff(d, 'minute')
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.round(min / 60)} 小时前`
  return `${Math.round(min / 1440)} 天前`
}

function feedTime(ts: string | null | undefined): string {
  if (!ts) return '--:--'
  const d = dayjs(ts)
  if (!d.isValid()) return '--:--'
  return d.isSame(dayjs(), 'day') ? d.format('HH:mm') : d.format('MM-DD HH:mm')
}

export default function DataIntegration() {
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [selectedType, setSelectedType] = useState<string>('')
  const [hours, setHours] = useState<number>(24)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [syncing, setSyncing] = useState(false)
  const [now, setNow] = useState(dayjs())

  const [orderModalOpen, setOrderModalOpen] = useState(false)
  const [erpOrders, setErpOrders] = useState<ErpOrder[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [pickedRows, setPickedRows] = useState<Set<string>>(new Set())
  const [selectedOrders, setSelectedOrders] = useState<string[]>([])

  const trackedRef = useRef<Map<string, string>>(new Map())

  const labelOf = useCallback((type: string): string => {
    return configStatus?.types?.[type]?.label || type
  }, [configStatus])

  const loadConfig = useCallback(async () => {
    try {
      const res: any = await importExportApi.getSyncConfigStatus()
      const cfg: ConfigStatus = res.data
      setConfigStatus(cfg)
      setSelectedType(prev => (prev && cfg.types[prev] ? prev : (Object.keys(cfg.types)[0] || '')))
    } catch { /* 静默 */ }
    try {
      const res: any = await importExportApi.getSyncStatus()
      setSyncStatus(res.data)
    } catch { /* 静默 */ }
  }, [])

  const fetchFeed = useCallback(async () => {
    try {
      const res: any = await importExportApi.listSyncTasks({ limit: 50 })
      const list: FeedItem[] = res.data || []
      setFeed(list)
      const tracked = trackedRef.current
      if (tracked.size > 0) {
        let finished = false
        list.forEach(item => {
          const label = tracked.get(item.task_id)
          if (!label) return
          if (item.status === 'success') {
            tracked.delete(item.task_id)
            finished = true
            message.success(`${label} 同步完成：新增 ${item.created_count ?? 0}，更新 ${item.updated_count ?? 0}`)
          } else if (item.status === 'failed') {
            tracked.delete(item.task_id)
            finished = true
            message.warning({ content: `${label} 同步失败：${(item.message || '未知错误').slice(0, 80)}`, duration: 6 })
          }
        })
        if (finished) {
          setSyncing(trackedRef.current.size > 0)
          loadConfig()
        }
      }
    } catch { /* 静默 */ }
  }, [loadConfig])

  useEffect(() => { loadConfig(); fetchFeed() }, [loadConfig, fetchFeed])

  useEffect(() => {
    const hasActive = trackedRef.current.size > 0 || feed.some(f => f.status === 'running' || f.status === 'pending')
    if (!hasActive) return
    const timer = setInterval(fetchFeed, 3000)
    return () => clearInterval(timer)
  }, [feed, fetchFeed])

  useEffect(() => {
    const timer = setInterval(() => setNow(dayjs()), 1000)
    return () => clearInterval(timer)
  }, [])

  const typeEntries = useMemo(() => {
    return Object.entries(configStatus?.types || {}).map(([key, cfg]) => {
      const last = syncStatus?.last_sync?.[key] || null
      let dot = COLORS.gray
      let tip = '尚未同步'
      if (!cfg.has_sql) { dot = COLORS.warn; tip = '同步 SQL 未配置' }
      else if (last?.status === 'failed') { dot = COLORS.err; tip = '上次同步失败' }
      else if (last?.timestamp) { dot = COLORS.ok; tip = '正常' }
      return { key, label: cfg.label || key, dot, tip, rel: relTime(last?.timestamp) }
    })
  }, [configStatus, syncStatus])

  const selectedCfg = configStatus?.types?.[selectedType] || null
  const selectedLast = syncStatus?.last_sync?.[selectedType] || null
  const selectedDot = !selectedCfg ? COLORS.gray
    : !selectedCfg.has_sql ? COLORS.warn
    : selectedLast?.status === 'failed' ? COLORS.err
    : COLORS.ok
  const selectedNote = useMemo(() => {
    if (!selectedCfg) return ''
    if (!selectedCfg.has_sql) return '同步 SQL 未配置，请前往「同步SQL配置」完成配置'
    if (selectedLast?.status === 'failed') return `上次同步失败：${selectedLast.message || '未知错误'}`
    return ''
  }, [selectedCfg, selectedLast])

  const handleSync = async () => {
    if (!selectedType) return
    if (!selectedCfg?.has_sql) {
      message.warning('该类型 SQL 未配置，无法同步')
      return
    }
    const params: { hours: number; order_numbers?: string[] } = { hours }
    if ((selectedType === 'orders' || selectedType === 'materials') && selectedOrders.length > 0) {
      params.order_numbers = selectedOrders
    }
    setSyncing(true)
    try {
      const res: any = await importExportApi.syncData(selectedType, params)
      const taskId = res.data?.task_id
      if (taskId) {
        trackedRef.current.set(taskId, labelOf(selectedType))
        message.success(`已提交同步：${labelOf(selectedType)}`)
        fetchFeed()
      } else {
        const data = res.data || {}
        const errors = data.errors || []
        if (errors.length > 0) message.warning(`${labelOf(selectedType)} 完成，但有 ${errors.length} 条错误`)
        else message.success(`${labelOf(selectedType)} 同步完成：新增 ${data.created ?? 0}，更新 ${data.updated ?? 0}`)
        setSyncing(false)
        loadConfig()
      }
    } catch {
      setSyncing(trackedRef.current.size > 0)
    }
  }

  const openOrderModal = async () => {
    setOrderModalOpen(true)
    setOrdersLoading(true)
    try {
      const res: any = await importExportApi.getErpOrders()
      setErpOrders(res.data || [])
    } catch { /* 拦截器已提示 */ } finally {
      setOrdersLoading(false)
    }
  }

  const toggleRow = (rowKey: string) => {
    setPickedRows(prev => {
      const next = new Set(prev)
      next.has(rowKey) ? next.delete(rowKey) : next.add(rowKey)
      return next
    })
  }

  const confirmOrders = () => {
    const chosen = erpOrders.filter(o => pickedRows.has(`${o.order_no}-${o.line_no}`))
    setSelectedOrders([...new Set(chosen.map(o => o.order_no).filter(Boolean) as string[])])
    setOrderModalOpen(false)
  }

  const runningFeed = feed.filter(f => f.status === 'running' || f.status === 'pending')

  return (
    <div style={{ height: 'calc(100vh - 108px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`
        @keyframes di-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
        @keyframes di-indet { 0% { left: -40%; width: 40%; } 50% { left: 30%; width: 55%; } 100% { left: 100%; width: 40%; } }
      `}</style>

      {configStatus && (!configStatus.enabled || !configStatus.erp_db_configured) && (
        <div style={{ background: '#fffbeb', border: '1px solid #fbe6b6', borderRadius: 10, padding: '10px 16px', fontSize: fs(13), color: '#92400e', flexShrink: 0 }}>
          ⚠ {configStatus.enabled ? 'ERP 数据库未配置（ERP_DB_URL）' : 'ERP 同步未启用（ERP_SYNC_ENABLED）'}，同步功能不可用
        </div>
      )}

      <div style={{ display: 'flex', gap: 18, flex: 1, minHeight: 0, marginTop: configStatus && (!configStatus.enabled || !configStatus.erp_db_configured) ? 14 : 0 }}>
        {/* ============ 左：发起同步 ============ */}
        <div className="card-modern" style={{ flex: 1.1, minWidth: 0, padding: '18px 20px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ fontSize: fs(13), color: COLORS.sub, fontWeight: 600, marginBottom: 10, flexShrink: 0 }}>发起同步</div>

          {configStatus == null ? (
            <div style={{ padding: '80px 0', textAlign: 'center', flex: 1 }}><Spin /></div>
          ) : (
            <>
              <div style={{ flex: 1, minHeight: 100, overflowY: 'auto', border: '1px solid #f0f2f6', borderRadius: 8 }}>
                {typeEntries.map((e, idx) => (
                  <Tooltip key={e.key} title={e.tip} mouseEnterDelay={0.4}>
                    <div
                      onClick={() => setSelectedType(e.key)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', fontSize: fs(13),
                        borderBottom: idx === typeEntries.length - 1 ? 'none' : '1px solid #f5f7fa',
                        cursor: 'pointer',
                        background: selectedType === e.key ? '#eef4fd' : undefined,
                        color: selectedType === e.key ? COLORS.acc : undefined,
                        fontWeight: selectedType === e.key ? 600 : 400,
                      }}
                      onMouseEnter={ev => { if (selectedType !== e.key) ev.currentTarget.style.background = '#f8fafd' }}
                      onMouseLeave={ev => { if (selectedType !== e.key) ev.currentTarget.style.background = '' }}
                    >
                      <span style={dotStyle(e.dot)} />
                      <span>{e.label}</span>
                      <span style={{ marginLeft: 'auto', color: COLORS.sub, fontSize: fs(11.5), fontWeight: 400 }}>
                        {e.rel || '未同步'}
                      </span>
                    </div>
                  </Tooltip>
                ))}
              </div>

              <div style={{ marginTop: 16, borderTop: '1px solid #f0f2f6', paddingTop: 16, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: fs(15), fontWeight: 700, marginBottom: 12 }}>
                  <span style={dotStyle(selectedDot)} />
                  {labelOf(selectedType)}
                  {selectedNote && (
                    <span style={{ fontSize: fs(12), color: COLORS.err, fontWeight: 400 }}>⚠ {selectedNote}</span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: fs(12.5), color: COLORS.sub }}>同步范围：最近</span>
                  <Segmented size="small" options={HOURS_OPTIONS} value={hours} onChange={v => setHours(v as number)} />
                  <span style={{ fontSize: fs(12.5), color: COLORS.sub }}>内的变动数据</span>
                  <PermButton
                    type="primary"
                    permResource="basicdata.import" permAction="import"
                    disabled={!!selectedCfg && !selectedCfg.has_sql}
                    loading={syncing}
                    onClick={handleSync}
                    style={{ marginLeft: 'auto', padding: '9px 28px', fontSize: fs(14), borderRadius: 8, height: 'auto' }}
                  >
                    {selectedCfg && !selectedCfg.has_sql ? 'SQL 未配置' : syncing ? '同步中…' : '▶ 同步'}
                  </PermButton>
                </div>

                {(selectedType === 'orders' || selectedType === 'materials') && (
                  <div style={{ marginTop: 10, fontSize: fs(12), color: COLORS.sub }}>
                    💡 需要只同步指定订单？
                    <a onClick={openOrderModal} style={{ marginLeft: 4 }}>
                      指定订单号{selectedOrders.length > 0 ? `（已选 ${selectedOrders.length} 单）` : ''}
                    </a>
                    {selectedOrders.length > 0 && (
                      <a style={{ marginLeft: 8, color: '#94a3b8' }} onClick={() => setSelectedOrders([])}>清除</a>
                    )}
                  </div>
                )}
              </div>

              {runningFeed.length > 0 && (
                <div style={{ marginTop: 16, flexShrink: 0 }}>
                  <div style={{ fontSize: fs(13), color: COLORS.sub, fontWeight: 600, marginBottom: 2 }}>正在同步</div>
                  {runningFeed.map(f => {
                    const started = dayjs(f.started_at || f.created_at)
                    const elapsed = started.isValid() ? now.diff(started, 'second') : null
                    return (
                      <div key={f.task_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px dashed #f0f2f6', fontSize: fs(12.5) }}>
                        <span style={{ ...dotStyle(COLORS.acc), animation: 'di-pulse 1.1s infinite' }} />
                        <b style={{ fontWeight: 600 }}>{labelOf(f.sync_type)}</b>
                        <span style={{ flex: 1, height: 4, borderRadius: 2, background: '#eef1f5', overflow: 'hidden', position: 'relative', display: 'block' }}>
                          <span style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 2, background: COLORS.acc, animation: 'di-indet 1.4s ease-in-out infinite' }} />
                        </span>
                        {elapsed != null && (
                          <span style={{ color: COLORS.acc, fontSize: fs(12), fontFamily: 'Consolas, monospace', width: 40, textAlign: 'right' }}>{elapsed}s</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* ============ 右：同步动态 ============ */}
        <div className="card-modern" style={{ flex: 1, minWidth: 0, padding: '18px 20px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ fontSize: fs(13), color: COLORS.sub, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            同步动态
            <div style={{ flex: 1 }} />
            <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => { fetchFeed(); loadConfig() }} title="刷新" />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {feed.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无同步记录" style={{ marginTop: 60 }} />
            ) : (
              feed.map((f, idx) => {
              const isOk = f.status === 'success'
              const isFail = f.status === 'failed'
              const isRun = f.status === 'running' || f.status === 'pending'
              const dot = isOk ? COLORS.ok : isFail ? COLORS.err : COLORS.acc
              const txt = isRun ? '同步中…'
                : isFail ? `同步失败 · ${f.message || '未知错误'}`
                : f.trigger_mode === 'manual' ? `手动同步${f.triggered_by ? ` · ${f.triggered_by}` : ''}`
                : '同步完成'
              return (
                <div key={f.task_id} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: idx === feed.length - 1 ? 'none' : '1px solid #f5f7fa', fontSize: fs(12.5), alignItems: 'baseline' }}>
                  <span style={{ color: COLORS.sub, fontSize: fs(11.5), fontFamily: 'Consolas, monospace', width: 44, flexShrink: 0 }}>
                    {feedTime(f.created_at)}
                  </span>
                  <span style={{ ...dotStyle(isRun ? COLORS.acc : dot), alignSelf: 'center', ...(isRun ? { animation: 'di-pulse 1.1s infinite' } : {}) }} />
                  <span style={{ color: '#1e2532' }}>
                    {labelOf(f.sync_type)}{' '}
                    <Tooltip title={isFail ? (f.message || '同步失败') : undefined}>
                      <span style={{ color: isFail ? COLORS.err : COLORS.sub, fontSize: fs(12), cursor: isFail ? 'pointer' : undefined }}>
                        {isFail ? txt.slice(0, 40) + (txt.length > 40 ? '…' : '') : txt}
                      </span>
                    </Tooltip>{' '}
                    {isOk && (
                      <span style={{ color: COLORS.sub, fontFamily: 'Consolas, monospace', fontSize: fs(11.5) }}>
                        +{f.created_count ?? 0} ~{f.updated_count ?? 0}
                        {f.failed_count ? <span style={{ color: COLORS.err }}> ✗{f.failed_count}</span> : null}
                      </span>
                    )}
                  </span>
                </div>
              )
            })
          )}
          </div>
        </div>
      </div>

      <Modal
        title="从 ERP 选择订单"
        open={orderModalOpen}
        onCancel={() => setOrderModalOpen(false)}
        width={520}
        footer={[
          <Button key="clear" onClick={() => setPickedRows(new Set())}>清除选择</Button>,
          <Button key="cancel" onClick={() => setOrderModalOpen(false)}>取消</Button>,
          <Button key="ok" type="primary" onClick={confirmOrders}>确定（已选 {pickedRows.size} 行）</Button>,
        ]}
      >
        <div style={{ marginBottom: 8, fontSize: fs(12), color: COLORS.sub }}>最近 30 天 ERP 订单（行级），确认后按所选行归属的订单号同步</div>
        {ordersLoading ? (
          <div style={{ padding: '40px 0', textAlign: 'center' }}><Spin /></div>
        ) : (
          <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #f0f2f6', borderRadius: 8 }}>
            {erpOrders.map((o, idx) => {
              const rowKey = `${o.order_no}-${o.line_no}`
              return (
                <div
                  key={rowKey}
                  onClick={() => toggleRow(rowKey)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', fontSize: fs(12.5), cursor: 'pointer',
                    borderBottom: idx === erpOrders.length - 1 ? 'none' : '1px solid #f5f7fa',
                    background: pickedRows.has(rowKey) ? '#eef4fd' : undefined,
                  }}
                >
                  <input type="checkbox" checked={pickedRows.has(rowKey)} onChange={() => toggleRow(rowKey)} onClick={e => e.stopPropagation()} />
                  <span style={{ fontFamily: 'Consolas, monospace', width: 110 }}>{o.order_no}</span>
                  <span style={{ flex: 1, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.customer}</span>
                  <span style={{ color: COLORS.sub, fontSize: fs(11.5) }}>{o.promised_date}</span>
                </div>
              )
            })}
          </div>
        )}
      </Modal>
    </div>
  )
}
