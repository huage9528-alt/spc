import { useState, useEffect, useCallback, useMemo } from 'react'
import { Button, Spin, Tooltip } from 'antd'
import { FullscreenOutlined, FullscreenExitOutlined } from '@ant-design/icons'
import { dashboardApi } from '@/services/api'
import dayjs from 'dayjs'

/*
 * 出货计划看板（精简版）— 复刻 docs/prototype/redesign/shipment-board.html
 * 顶栏（标题 + 关键数字 + 业务员 chips + 全屏 + 时钟）+ 5 列状态看板（7 日滚动窗口 + 近 7 日已完成）
 */

interface ShipmentItem {
  id: number
  order_no: string | null
  line_no: string | null
  shipping_plan: string | null
  is_overdue: boolean
  overdue_days: number
  customer: string | null
  customer_code: string | null
  product_code: string | null
  product_name: string | null
  order_qty: number | null
  completed_qty: number | null
  promised_date: string | null
  risk_level: string | null
  owner: string | null
  shipping_status_desc: string | null
  status: string | null
  is_done: boolean
  completed_date: string | null
}

interface ShipmentData {
  items: ShipmentItem[]
  last_updated: string
}

const REFRESH_INTERVAL = 60000
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const COLUMNS: { key: string; title: string; color: string; bg: string; dateOffset?: number }[] = [
  { key: 'overdue', title: '已逾期', color: '#e11d48', bg: '#fef2f5' },
  { key: 'today', title: '今日出货', color: '#ea580c', bg: '#fff7ed', dateOffset: 0 },
  { key: 'tomorrow', title: '明日出货', color: '#2563eb', bg: '#eff6ff', dateOffset: 1 },
  { key: 'future', title: '未来 7 日', color: '#6366f1', bg: '#eef2ff' },
  { key: 'done', title: '本周已完成', color: '#16a34a', bg: '#f0fdf4' },
]

const RISK_BADGES: Record<string, { text: string; color: string; bg: string }> = {
  red: { text: '高风险', color: '#e11d48', bg: '#fef2f5' },
  yellow: { text: '中风险', color: '#b45309', bg: '#fef3c7' },
  green: { text: '低风险', color: '#16a34a', bg: '#f0fdf4' },
}

const css = `
  .sbk-wrap { font-size: calc(0.9375rem * var(--font-size-scale, 1)); }
  .sbk-bar {
    display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
    padding: 10px 14px; background: #fff; border: 1px solid #e2e8f0;
    border-radius: 12px; margin-bottom: 10px;
  }
  .sbk-bar h1 { font-size: 1.05em; font-weight: 700; margin: 0; white-space: nowrap; }
  .sbk-bar h1 small { font-size: 0.68em; font-weight: 400; color: #94a3b8; margin-left: 7px; }
  .sbk-stats { display: flex; gap: 16px; flex-wrap: wrap; }
  .sbk-stat { display: flex; align-items: baseline; gap: 5px; font-size: 0.76em; color: #64748b; white-space: nowrap; }
  .sbk-stat b { font-size: 1.2em; font-weight: 700; font-variant-numeric: tabular-nums; color: #0f172a; }
  .sbk-stat.s-d b { color: #e11d48; }
  .sbk-stat.s-t b { color: #ea580c; }
  .sbk-stat.s-h b { color: #e11d48; }
  .sbk-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  .sbk-chips .lbl { font-size: 0.72em; color: #94a3b8; }
  .sbk-chip {
    border: 1px solid #e2e8f0; background: #fff; border-radius: 999px;
    padding: 2px 10px; font-size: 0.74em; color: #64748b; cursor: pointer; user-select: none;
    white-space: nowrap; transition: all .15s;
  }
  .sbk-chip:hover { border-color: #bae6fd; color: #0f172a; }
  .sbk-chip.on { background: #0284c7; border-color: #0284c7; color: #fff; }
  .sbk-clock { font-size: 0.82em; font-weight: 600; font-variant-numeric: tabular-nums; color: #64748b; white-space: nowrap; }
  .sbk-board { display: flex; gap: 10px; min-height: 0; overflow-x: auto; padding-bottom: 2px; }
  .sbk-col { flex: 1; min-width: 210px; display: flex; flex-direction: column; min-height: 0; }
  .sbk-col-head { display: flex; align-items: center; gap: 7px; padding: 0 4px 7px; flex: none; flex-wrap: wrap; }
  .sbk-dot { width: 9px; height: 9px; border-radius: 3px; flex: none; }
  .sbk-col-title { font-size: 0.84em; font-weight: 700; white-space: nowrap; }
  .sbk-col-sub { font-size: 0.66em; color: #94a3b8; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sbk-count {
    margin-left: auto; font-size: 0.72em; font-weight: 700; font-variant-numeric: tabular-nums;
    color: #64748b; background: #fff; border: 1px solid #e2e8f0; border-radius: 999px; padding: 1px 9px;
  }
  .sbk-cards {
    flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 7px; padding-bottom: 8px;
    scrollbar-width: thin; scrollbar-color: #cbd5e1 transparent;
  }
  .sbk-cards::-webkit-scrollbar { width: 5px; }
  .sbk-cards::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
  .sbk-empty { margin: auto; color: #94a3b8; font-size: 0.76em; padding: 18px 0; }
  .sbk-card {
    background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
    padding: 8px 10px 9px; position: relative;
  }
  .sbk-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--cc, #94a3b8); border-radius: 10px 0 0 10px; }
  .sbk-row1 { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; flex-wrap: wrap; }
  .sbk-date {
    font-size: 0.64em; font-weight: 600; color: #64748b; background: #f8fafc;
    border-radius: 4px; padding: 1px 5px; font-variant-numeric: tabular-nums; flex: none;
  }
  .sbk-doc {
    font-size: 0.74em; font-weight: 600; color: #64748b;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sbk-badge { margin-left: auto; font-size: 0.64em; font-weight: 700; border-radius: 4px; padding: 1px 6px; flex: none; color: var(--cc); background: var(--cb); }
  .sbk-cust { margin-bottom: 6px; min-width: 0; }
  .sbk-cust b {
    display: block; font-size: 0.84em; font-weight: 700;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sbk-cust small {
    display: block; font-size: 0.66em; color: #94a3b8; margin-top: 1px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sbk-row3 { display: flex; align-items: center; gap: 6px 10px; margin-bottom: 6px; flex-wrap: wrap; }
  .sbk-recv { font-size: 0.76em; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .sbk-recv small { color: #94a3b8; font-size: 0.84em; margin-right: 3px; }
  .sbk-recv b { font-weight: 700; }
  .sbk-recv b.ok { color: #16a34a; }
  .sbk-due { font-size: 0.66em; font-variant-numeric: tabular-nums; color: #94a3b8; white-space: nowrap; }
  .sbk-due.bad { color: #e11d48; font-weight: 700; }
  .sbk-owner {
    margin-left: auto; font-size: 0.66em; color: #64748b; background: #f8fafc;
    border-radius: 999px; padding: 2px 8px; flex: none; max-width: 6em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sbk-prog { height: 4px; background: #eef2f7; border-radius: 999px; overflow: hidden; }
  .sbk-prog i { display: block; height: 100%; border-radius: 999px; background: #16a34a; }
  .sbk-prog.part i { background: #f97316; }
  .sbk-prog.zero i { background: #a5b4fc; }
  .sbk-fullscreen { font-size: 1.15em; }
  .sbk-fullscreen .sbk-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
`

const ShipmentBoard: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ShipmentData | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [ownerFilter, setOwnerFilter] = useState<string>('全部')
  const [clock, setClock] = useState(dayjs().format('HH:mm'))

  const fetchData = useCallback(async () => {
    try {
      const res: any = await dashboardApi.getShipmentBoard()
      if (res?.code === 0) {
        setData(res.data)
      }
    } catch (err) {
      console.error('Failed to fetch shipment board data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    const timer = setInterval(fetchData, REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [fetchData])

  useEffect(() => {
    const timer = setInterval(() => setClock(dayjs().format('HH:mm')), 30000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && fullscreen) setFullscreen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [fullscreen])

  useEffect(() => {
    if (fullscreen) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = prev }
    }
  }, [fullscreen])

  const allItems = data?.items || []
  const todayStr = dayjs().format('YYYY-MM-DD')
  const tomorrowStr = dayjs().add(1, 'day').format('YYYY-MM-DD')

  const ownerOptions = useMemo(() => {
    const map = new Map<string, number>()
    allItems.forEach(i => {
      const name = (i.owner || '').trim()
      if (name) map.set(name, (map.get(name) || 0) + 1)
    })
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [allItems])

  const rawItems = useMemo(() => {
    if (ownerFilter === '全部') return allItems
    return allItems.filter(i => (i.owner || '').trim() === ownerFilter)
  }, [allItems, ownerFilter])

  const buckets = useMemo(() => {
    const b: Record<string, ShipmentItem[]> = { overdue: [], today: [], tomorrow: [], future: [], done: [] }
    rawItems.forEach(i => {
      const d = i.shipping_plan ? dayjs(i.shipping_plan).format('YYYY-MM-DD') : ''
      if (i.is_done) b.done.push(i)
      else if (d && d < todayStr) b.overdue.push(i)
      else if (d === todayStr) b.today.push(i)
      else if (d === tomorrowStr) b.tomorrow.push(i)
      else if (d > tomorrowStr) b.future.push(i)
      else b.today.push(i)
    })
    b.overdue.sort((a, b2) => (b2.overdue_days || 0) - (a.overdue_days || 0))
    const byDate = (a: ShipmentItem, b2: ShipmentItem) => (a.shipping_plan || '').localeCompare(b2.shipping_plan || '')
    b.today.sort(byDate)
    b.tomorrow.sort(byDate)
    b.future.sort(byDate)
    b.done.sort((a, b2) => (b2.completed_date || '').localeCompare(a.completed_date || ''))
    return b
  }, [rawItems, todayStr, tomorrowStr])

  const stats = useMemo(() => {
    const pending = allItems.filter(i => !i.is_done)
    return {
      pending: pending.length,
      overdue: pending.filter(i => i.shipping_plan && dayjs(i.shipping_plan).format('YYYY-MM-DD') < todayStr).length,
      today: pending.filter(i => i.shipping_plan && dayjs(i.shipping_plan).format('YYYY-MM-DD') === todayStr).length,
      high: pending.filter(i => i.risk_level === 'red').length,
    }
  }, [allItems, todayStr])

  if (loading && !data) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <Spin size="large" tip="加载出货计划看板..." />
      </div>
    )
  }

  if (!data) return null

  const renderCard = (item: ShipmentItem, colKey: string, colColor: string, colBg: string) => {
    const completed = item.completed_qty ?? 0
    const ordered = item.order_qty ?? 0
    const pct = ordered > 0 ? Math.min(100, Math.round((completed / ordered) * 100)) : 0
    const progCls = item.is_done ? '' : pct > 0 ? 'part' : 'zero'

    const risk = !item.is_done && !item.is_overdue ? RISK_BADGES[item.risk_level || ''] : undefined
    const color = risk?.color || colColor
    const bg = risk?.bg || colBg

    let badgeText: string
    if (item.is_overdue && !item.is_done) badgeText = `逾期 ${item.overdue_days}天`
    else if (item.is_done) badgeText = '已完成'
    else if (risk) badgeText = risk.text
    else if (colKey === 'today') badgeText = '今日'
    else if (colKey === 'tomorrow') badgeText = '明日'
    else {
      const d = item.shipping_plan ? dayjs(item.shipping_plan) : null
      badgeText = d ? `D+${d.diff(dayjs(), 'day')}` : '-'
    }

    const dateLabel = (item.is_done && item.completed_date ? dayjs(item.completed_date) : (item.shipping_plan ? dayjs(item.shipping_plan) : null))?.format('MM-DD') || '-'
    const docNo = [item.order_no, item.line_no].filter(Boolean).join(' · ') || '-'
    const prodDesc = [item.product_code, item.product_name].filter(Boolean).join(' ')
    const ownerName = (item.owner || '').trim()

    const promisedEarly = !!item.promised_date && !!item.shipping_plan
      && dayjs(item.promised_date).isBefore(dayjs(item.shipping_plan), 'day')
    const dueEl = item.promised_date ? (
      <Tooltip title={promisedEarly ? '交期早于出货计划，交付紧张' : undefined}>
        <span className={`sbk-due${promisedEarly ? ' bad' : ''}`}>
          交期 {dayjs(item.promised_date).format('MM-DD')}{promisedEarly ? ' !' : ''}
        </span>
      </Tooltip>
    ) : null

    return (
      <div
        key={item.id}
        className="sbk-card"
        style={{ '--cc': color, '--cb': bg } as React.CSSProperties}
        title={item.shipping_status_desc || undefined}
      >
        <div className="sbk-row1">
          <span className="sbk-date">{dateLabel}</span>
          <span className="sbk-doc" title={docNo}>{docNo}</span>
          <span className="sbk-badge">{badgeText}</span>
        </div>
        <div className="sbk-cust">
          <b title={item.customer || undefined}>{item.customer || '-'}</b>
          {prodDesc && <small title={prodDesc}>{prodDesc}</small>}
        </div>
        <div className="sbk-row3">
          <span className="sbk-recv">
            <small>完成</small>
            <b className={item.is_done ? 'ok' : ''}>
              {completed.toLocaleString()}{ordered > 0 ? `/${ordered.toLocaleString()}` : ''}
            </b>
          </span>
          {dueEl}
          {ownerName && <span className="sbk-owner">{ownerName}</span>}
        </div>
        <div className={`sbk-prog ${progCls}`}><i style={{ width: `${pct}%` }} /></div>
      </div>
    )
  }

  const content = (
    <div className="sbk-wrap">
      <style>{css}</style>
      <header className="sbk-bar">
        <h1>出货计划看板<small>7 日交付</small></h1>
        <div className="sbk-stats">
          <span className="sbk-stat">待出货 <b>{stats.pending}</b></span>
          <span className="sbk-stat s-d">逾期 <b>{stats.overdue}</b></span>
          <span className="sbk-stat s-t">今日 <b>{stats.today}</b></span>
          <span className="sbk-stat s-h">高风险 <b>{stats.high}</b></span>
        </div>
        <div className="sbk-chips">
          <span className="lbl">业务员</span>
          <span
            className={`sbk-chip${ownerFilter === '全部' ? ' on' : ''}`}
            onClick={() => setOwnerFilter('全部')}
          >全部 {allItems.length}</span>
          {ownerOptions.map(([name, count]) => (
            <span
              key={name}
              className={`sbk-chip${ownerFilter === name ? ' on' : ''}`}
              onClick={() => setOwnerFilter(name)}
            >{name} {count}</span>
          ))}
        </div>
        <Tooltip title={fullscreen ? '退出全屏 (ESC)' : '大屏模式'}>
          <Button
            size="small"
            type="text"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            onClick={() => setFullscreen(!fullscreen)}
          />
        </Tooltip>
        <Tooltip title={data.last_updated ? `数据截至 ${dayjs(data.last_updated).format('HH:mm:ss')}` : ''}>
          <span className="sbk-clock">{clock}</span>
        </Tooltip>
      </header>
      <div className="sbk-board" style={fullscreen ? { flex: 1, minHeight: 0 } : { height: 'calc(100vh - 20em)', minHeight: 400 }}>
        {COLUMNS.map(col => (
          <section className="sbk-col" key={col.key}>
            <div className="sbk-col-head">
              <span className="sbk-dot" style={{ background: col.color }} />
              <span className="sbk-col-title">{col.title}</span>
              {col.dateOffset !== undefined && (
                <span className="sbk-col-sub">
                  {dayjs().add(col.dateOffset, 'day').format('MM-DD')} 周{WEEKDAYS[dayjs().add(col.dateOffset, 'day').day()]}
                </span>
              )}
              <span className="sbk-count">{buckets[col.key].length}</span>
            </div>
            <div className="sbk-cards">
              {buckets[col.key].length > 0
                ? buckets[col.key].map(i => renderCard(i, col.key, col.color, col.bg))
                : <div className="sbk-empty">暂无</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  )

  if (fullscreen) {
    return (
      <div
        className="sbk-fullscreen"
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          zIndex: 9999, background: '#f4f6fa',
          padding: '1em 1.2em', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {content}
      </div>
    )
  }

  return content
}

export default ShipmentBoard
