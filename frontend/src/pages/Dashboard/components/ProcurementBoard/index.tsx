import { useState, useEffect, useCallback, useMemo } from 'react'
import { Button, Spin, Tooltip } from 'antd'
import { FullscreenOutlined, FullscreenExitOutlined } from '@ant-design/icons'
import { dashboardApi } from '@/services/api'
import dayjs from 'dayjs'

/*
 * 采购看板（精简版）— 复刻 docs/prototype/redesign/procurement-board.html
 * 顶栏（标题 + 关键数字 + 责任人 chips + 全屏 + 时钟）+ 5 列状态看板（7 日滚动窗口）
 */

interface BoardItem {
  id: number
  board_date: string | null
  doc_no: string | null
  material_code: string
  material_name: string | null
  spec_model: string | null
  qty: number | null
  received_qty: number | null
  stock_qty: number | null
  mrp_qty: number | null
  is_ready: boolean
  shortage_qty: number | null
  is_shortage: boolean
  is_overdue: boolean
  overdue_days: number
  owner: string | null
  responsible: string | null
  workstation: string | null
  remark: string | null
}

interface BoardData {
  items: BoardItem[]
  last_updated: string
}

const REFRESH_INTERVAL = 60000
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const COLUMNS: { key: string; title: string; color: string; bg: string; dateOffset?: number }[] = [
  { key: 'overdue', title: '已逾期', color: '#e11d48', bg: '#fef2f5' },
  { key: 'today', title: '今日到料', color: '#ea580c', bg: '#fff7ed', dateOffset: 0 },
  { key: 'tomorrow', title: '明日到料', color: '#2563eb', bg: '#eff6ff', dateOffset: 1 },
  { key: 'future', title: '未来 7 日', color: '#6366f1', bg: '#eef2ff' },
  { key: 'ready', title: '已齐套', color: '#16a34a', bg: '#f0fdf4' },
]

const css = `
  .pcb-wrap { font-size: calc(0.9375rem * var(--font-size-scale, 1)); }
  .pcb-bar {
    display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
    padding: 10px 14px; background: #fff; border: 1px solid #e2e8f0;
    border-radius: 12px; margin-bottom: 10px;
  }
  .pcb-bar h1 { font-size: 1.05em; font-weight: 700; margin: 0; white-space: nowrap; }
  .pcb-bar h1 small { font-size: 0.68em; font-weight: 400; color: #94a3b8; margin-left: 7px; }
  .pcb-stats { display: flex; gap: 16px; flex-wrap: wrap; }
  .pcb-stat { display: flex; align-items: baseline; gap: 5px; font-size: 0.76em; color: #64748b; white-space: nowrap; }
  .pcb-stat b { font-size: 1.2em; font-weight: 700; font-variant-numeric: tabular-nums; color: #0f172a; }
  .pcb-stat.s-d b { color: #e11d48; }
  .pcb-stat.s-t b { color: #ea580c; }
  .pcb-stat.s-r b { color: #16a34a; }
  .pcb-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  .pcb-chips .lbl { font-size: 0.72em; color: #94a3b8; }
  .pcb-chip {
    border: 1px solid #e2e8f0; background: #fff; border-radius: 999px;
    padding: 2px 10px; font-size: 0.74em; color: #64748b; cursor: pointer; user-select: none;
    white-space: nowrap; transition: all .15s;
  }
  .pcb-chip:hover { border-color: #c7d2fe; color: #0f172a; }
  .pcb-chip.on { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  .pcb-clock { font-size: 0.82em; font-weight: 600; font-variant-numeric: tabular-nums; color: #64748b; white-space: nowrap; }
  .pcb-board { display: flex; gap: 10px; min-height: 0; overflow-x: auto; padding-bottom: 2px; }
  .pcb-col { flex: 1; min-width: 210px; display: flex; flex-direction: column; min-height: 0; }
  .pcb-col-head { display: flex; align-items: center; gap: 7px; padding: 0 4px 7px; flex: none; flex-wrap: wrap; }
  .pcb-dot { width: 9px; height: 9px; border-radius: 3px; flex: none; }
  .pcb-col-title { font-size: 0.84em; font-weight: 700; white-space: nowrap; }
  .pcb-col-sub { font-size: 0.66em; color: #94a3b8; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pcb-count {
    margin-left: auto; font-size: 0.72em; font-weight: 700; font-variant-numeric: tabular-nums;
    color: #64748b; background: #fff; border: 1px solid #e2e8f0; border-radius: 999px; padding: 1px 9px;
  }
  .pcb-cards {
    flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 7px; padding-bottom: 8px;
    scrollbar-width: thin; scrollbar-color: #cbd5e1 transparent;
  }
  .pcb-cards::-webkit-scrollbar { width: 5px; }
  .pcb-cards::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
  .pcb-empty { margin: auto; color: #94a3b8; font-size: 0.76em; padding: 18px 0; }
  .pcb-card {
    background: #fff; border: 1px solid #e2e8f0; border-radius: 10px;
    padding: 8px 10px 9px; position: relative;
  }
  .pcb-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--cc, #94a3b8); border-radius: 10px 0 0 10px; }
  .pcb-row1 { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; flex-wrap: wrap; }
  .pcb-date {
    font-size: 0.64em; font-weight: 600; color: #64748b; background: #f8fafc;
    border-radius: 4px; padding: 1px 5px; font-variant-numeric: tabular-nums; flex: none;
  }
  .pcb-doc {
    font-size: 0.74em; font-weight: 600; color: #64748b;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pcb-badge { margin-left: auto; font-size: 0.64em; font-weight: 700; border-radius: 4px; padding: 1px 6px; flex: none; color: var(--cc); background: var(--cb); }
  .pcb-mat { margin-bottom: 6px; min-width: 0; }
  .pcb-code {
    display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.86em; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pcb-mat small {
    display: block; font-size: 0.66em; color: #94a3b8; margin-top: 1px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pcb-row3 { display: flex; align-items: center; gap: 6px 10px; margin-bottom: 6px; flex-wrap: wrap; }
  .pcb-recv { font-size: 0.76em; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .pcb-recv small { color: #94a3b8; font-size: 0.84em; margin-right: 3px; }
  .pcb-recv b { font-weight: 700; }
  .pcb-recv b.ok { color: #16a34a; }
  .pcb-recv b.bad { color: #e11d48; }
  .pcb-owner {
    margin-left: auto; font-size: 0.66em; color: #64748b; background: #f8fafc;
    border-radius: 999px; padding: 2px 8px; flex: none; max-width: 6em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pcb-prog { height: 4px; background: #eef2f7; border-radius: 999px; overflow: hidden; }
  .pcb-prog i { display: block; height: 100%; border-radius: 999px; background: #16a34a; }
  .pcb-prog.part i { background: #f97316; }
  .pcb-prog.zero i { background: #a5b4fc; }
  .pcb-fullscreen { font-size: 1.15em; }
  .pcb-fullscreen .pcb-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; }
`

const ProcurementBoard: React.FC = () => {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<BoardData | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [ownerFilter, setOwnerFilter] = useState<string>('全部')
  const [clock, setClock] = useState(dayjs().format('HH:mm'))

  const fetchData = useCallback(async () => {
    try {
      const res: any = await dashboardApi.getProcurementBoard()
      if (res?.code === 0) {
        setData(res.data)
      }
    } catch (err) {
      console.error('Failed to fetch procurement board data:', err)
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
      const name = (i.responsible || i.owner || '').trim()
      if (name) map.set(name, (map.get(name) || 0) + 1)
    })
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [allItems])

  const rawItems = useMemo(() => {
    if (ownerFilter === '全部') return allItems
    return allItems.filter(i => (i.responsible || i.owner || '').trim() === ownerFilter)
  }, [allItems, ownerFilter])

  const buckets = useMemo(() => {
    const b: Record<string, BoardItem[]> = { overdue: [], today: [], tomorrow: [], future: [], ready: [] }
    rawItems.forEach(i => {
      if (i.is_ready) b.ready.push(i)
      else if (i.is_overdue) b.overdue.push(i)
      else {
        const d = i.board_date ? dayjs(i.board_date).format('YYYY-MM-DD') : ''
        if (d === todayStr) b.today.push(i)
        else if (d === tomorrowStr) b.tomorrow.push(i)
        else if (d && d > tomorrowStr) b.future.push(i)
        else b.today.push(i)
      }
    })
    b.overdue.sort((a, b2) => (b2.overdue_days || 0) - (a.overdue_days || 0))
    const byDate = (a: BoardItem, b2: BoardItem) => (a.board_date || '').localeCompare(b2.board_date || '')
    b.today.sort(byDate)
    b.tomorrow.sort(byDate)
    b.future.sort(byDate)
    return b
  }, [rawItems, todayStr, tomorrowStr])

  const stats = useMemo(() => {
    const total = allItems.length
    const ready = allItems.filter(i => i.is_ready).length
    return {
      total,
      overdue: allItems.filter(i => i.is_overdue && !i.is_ready).length,
      today: allItems.filter(i => !i.is_ready && !i.is_overdue && i.board_date && dayjs(i.board_date).format('YYYY-MM-DD') === todayStr).length,
      readyPct: total > 0 ? Math.round((ready / total) * 100) : 0,
    }
  }, [allItems, todayStr])

  if (loading && !data) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <Spin size="large" tip="加载看板数据..." />
      </div>
    )
  }

  if (!data) return null

  const renderCard = (item: BoardItem, colKey: string, color: string, bg: string) => {
    const received = item.received_qty ?? 0
    const ordered = item.qty ?? 0
    const pct = ordered > 0 ? Math.min(100, Math.round((received / ordered) * 100)) : 0
    const progCls = item.is_ready ? '' : pct > 0 ? 'part' : 'zero'

    let badgeText: string
    if (item.is_overdue && !item.is_ready) badgeText = `逾期 ${item.overdue_days}天`
    else if (item.is_ready) badgeText = '已齐套'
    else if (colKey === 'today') badgeText = '今日'
    else if (colKey === 'tomorrow') badgeText = '明日'
    else {
      const d = item.board_date ? dayjs(item.board_date) : null
      badgeText = d ? `D+${d.diff(dayjs(), 'day')}` : '-'
    }

    const dateLabel = item.board_date ? dayjs(item.board_date).format('MM-DD') : '-'
    const ownerName = (item.responsible || item.owner || '').trim()
    const matDesc = [item.material_name, item.spec_model].filter(Boolean).join(' | ')
    const recvCls = item.is_ready ? 'ok' : (received > 0 ? '' : 'bad')

    return (
      <div key={item.id} className="pcb-card" style={{ '--cc': color, '--cb': bg } as React.CSSProperties}>
        <div className="pcb-row1">
          <span className="pcb-date">{dateLabel}</span>
          <span className="pcb-doc" title={item.doc_no || undefined}>{item.doc_no || '-'}</span>
          <span className="pcb-badge">{badgeText}</span>
        </div>
        <div className="pcb-mat">
          <span className="pcb-code" title={item.material_code}>{item.material_code}</span>
          {matDesc && <small title={matDesc}>{matDesc}</small>}
        </div>
        <div className="pcb-row3">
          <span className="pcb-recv">
            <small>到料</small>
            <b className={recvCls}>
              {received.toLocaleString()}{ordered > 0 ? `/${ordered.toLocaleString()}` : ''}
            </b>
          </span>
          {ownerName && <span className="pcb-owner">{ownerName}</span>}
        </div>
        <div className={`pcb-prog ${progCls}`}><i style={{ width: `${pct}%` }} /></div>
      </div>
    )
  }

  const content = (
    <div className="pcb-wrap">
      <style>{css}</style>
      <header className="pcb-bar">
        <h1>采购看板<small>7 日备料</small></h1>
        <div className="pcb-stats">
          <span className="pcb-stat">在途 <b>{stats.total}</b></span>
          <span className="pcb-stat s-d">逾期 <b>{stats.overdue}</b></span>
          <span className="pcb-stat s-t">今日 <b>{stats.today}</b></span>
          <span className="pcb-stat s-r">齐套率 <b>{stats.readyPct}%</b></span>
        </div>
        <div className="pcb-chips">
          <span className="lbl">责任人</span>
          <span
            className={`pcb-chip${ownerFilter === '全部' ? ' on' : ''}`}
            onClick={() => setOwnerFilter('全部')}
          >全部 {allItems.length}</span>
          {ownerOptions.map(([name, count]) => (
            <span
              key={name}
              className={`pcb-chip${ownerFilter === name ? ' on' : ''}`}
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
          <span className="pcb-clock">{clock}</span>
        </Tooltip>
      </header>
      <div className="pcb-board" style={fullscreen ? { flex: 1, minHeight: 0 } : { height: 'calc(100vh - 20em)', minHeight: 400 }}>
        {COLUMNS.map(col => (
          <section className="pcb-col" key={col.key}>
            <div className="pcb-col-head">
              <span className="pcb-dot" style={{ background: col.color }} />
              <span className="pcb-col-title">{col.title}</span>
              {col.dateOffset !== undefined && (
                <span className="pcb-col-sub">
                  {dayjs().add(col.dateOffset, 'day').format('MM-DD')} 周{WEEKDAYS[dayjs().add(col.dateOffset, 'day').day()]}
                </span>
              )}
              <span className="pcb-count">{buckets[col.key].length}</span>
            </div>
            <div className="pcb-cards">
              {buckets[col.key].length > 0
                ? buckets[col.key].map(i => renderCard(i, col.key, col.color, col.bg))
                : <div className="pcb-empty">暂无</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  )

  if (fullscreen) {
    return (
      <div
        className="pcb-fullscreen"
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

export default ProcurementBoard
