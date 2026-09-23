import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AutoComplete, Input, Table, Button, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { SearchOutlined, DownloadOutlined, ExperimentOutlined } from '@ant-design/icons'
import { materialApi } from '@/services/api'
import {
  duePill,
  exportCsv,
  fmt,
  getRecent,
  MaterialOccupancyData,
  OccupancyOrderRow,
  pushRecent,
  statusTag,
  num,
} from './common'

const RECENT_KEY = 'occ_recent_materials'

const StatusLabel: Record<string, string> = { met: '满足', partial: '部分', shortage: '欠料' }

export default function ByMaterialTab({
  refreshKey,
  drillMaterialCode,
  onDrillConsumed,
}: {
  refreshKey: number
  drillMaterialCode: string | null
  onDrillConsumed: () => void
}) {
  const navigate = useNavigate()
  const [keyword, setKeyword] = useState('')
  const [options, setOptions] = useState<{ value: string; label: string }[]>([])
  const [data, setData] = useState<MaterialOccupancyData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const [recents, setRecents] = useState<string[]>(() => getRecent(RECENT_KEY))
  const [currentCode, setCurrentCode] = useState<string | null>(null)
  const searchedRef = useRef<string | null>(null)

  const doSearch = useCallback(async (code: string) => {
    const trimmed = code.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    try {
      const res = await materialApi.getOccupancyByMaterial({ material_code: trimmed })
      setData(res.data.data)
      setCurrentCode(trimmed)
      searchedRef.current = trimmed
      pushRecent(RECENT_KEY, trimmed)
      setRecents(getRecent(RECENT_KEY))
    } catch (e: any) {
      setData(null)
      setCurrentCode(null)
      setError(e?.response?.data?.detail || e?.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (drillMaterialCode && drillMaterialCode !== searchedRef.current) {
      setKeyword(drillMaterialCode)
      doSearch(drillMaterialCode)
      onDrillConsumed()
    }
  }, [drillMaterialCode, doSearch, onDrillConsumed])

  useEffect(() => {
    if (refreshKey > 0 && currentCode) {
      doSearch(currentCode)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  useEffect(() => {
    const handle = setTimeout(async () => {
      const kw = keyword.trim()
      if (!kw) {
        setOptions([])
        return
      }
      try {
        const res = await materialApi.searchOccupancyMaterials({ keyword: kw })
        setOptions(
          (res.data.data || []).map((m: any) => ({
            value: m.material_code,
            label: `${m.material_code} | ${m.material_name || ''}${m.spec_model ? ' / ' + m.spec_model : ''}`,
          })),
        )
      } catch {
        setOptions([])
      }
    }, 300)
    return () => clearTimeout(handle)
  }, [keyword])

  const wf = useMemo(() => {
    if (!data || data.rows.length === 0) return null
    const rows = data.rows
    const totD = rows.reduce((s, r) => s + num(r.demand_qty), 0)
    const totA = rows.reduce((s, r) => s + num(r.allocated_qty), 0)
    const totS = rows.reduce((s, r) => s + num(r.shortage_qty), 0)
    if (totD <= 0) return null
    const stock = num(data.stock_qty)
    const firstShort = rows.findIndex((r) => num(r.shortage_qty) > 0)
    let cum = 0
    const segs = rows.map((r, i) => {
      const demand = num(r.demand_qty)
      const left = ((cum + demand / 2) / totD) * 100
      cum += demand
      return { i, r, demand, left }
    })
    const brk =
      stock > 0 && stock < totD && firstShort >= 0
        ? { left: (stock / totD) * 100, label: `库存见底 · 第${firstShort + 1}行起欠量` }
        : stock === 0
          ? { left: 0, label: '无库存 · 全部欠料' }
          : null
    return { totD, totA, totS, stock, segs, brk }
  }, [data])

  const columns: ColumnsType<OccupancyOrderRow> = useMemo(
    () => [
      {
        title: '#',
        width: 44,
        render: (_: any, __: OccupancyOrderRow, i: number) => <span className="occ-ix">{i + 1}</span>,
      },
      {
        title: '合同交期',
        width: 128,
        render: (_: any, r: OccupancyOrderRow, i: number) => (
          <span>
            {duePill(r.promised_date)}
            {wf?.brk && i === (data?.rows.findIndex((x) => num(x.shortage_qty) > 0) ?? -1) && (
              <span className="occ-brk-flag">断点</span>
            )}
          </span>
        ),
      },
      {
        title: '订单 · 行',
        width: 190,
        render: (_: any, r: OccupancyOrderRow) => (
          <span>
            <a className="occ-link" onClick={() => navigate(`/orders/${r.order_no}`)}>
              {r.order_no}
            </a>
            <span style={{ color: 'var(--occ-t3)' }}> · {r.line_no}</span>
          </span>
        ),
      },
      {
        title: '产品',
        render: (_: any, r: OccupancyOrderRow) => (
          <div>
            <div style={{ color: 'var(--occ-t1)', fontWeight: 500 }}>{r.product_name || r.product_code || '-'}</div>
            <div style={{ fontSize: 'calc(10.5px * var(--font-size-scale))', color: 'var(--occ-t3)', fontWeight: 400 }}>
              {[r.product_code, r.customer].filter(Boolean).join(' · ')}
            </div>
          </div>
        ),
      },
      { title: '行数量', dataIndex: 'open_qty', align: 'right', width: 92, render: fmt },
      { title: '单耗', dataIndex: 'unit_qty', align: 'right', width: 76, render: fmt },
      {
        title: '需求量',
        dataIndex: 'demand_qty',
        align: 'right',
        width: 96,
        render: (v: any) => <span style={{ color: 'var(--occ-t1)', fontWeight: 500 }}>{fmt(v)}</span>,
      },
      {
        title: '可占量（剩余水位）',
        width: 190,
        render: (_: any, r: OccupancyOrderRow) => {
          const stock = num(data?.stock_qty)
          if (stock <= 0) return <span className="occ-zero">— 无库存 —</span>
          const avail = num(r.available_qty)
          const w = Math.min(100, Math.round((avail / stock) * 100))
          return (
            <span className="occ-drain">
              <span className="tr">
                <i className={avail <= 0 ? 'dry' : ''} style={{ width: `${Math.max(w, avail > 0 ? 4 : 0)}%` }} />
              </span>
              <span className="n">{fmt(r.available_qty)}</span>
            </span>
          )
        },
      },
      {
        title: '占用量',
        dataIndex: 'allocated_qty',
        align: 'right',
        width: 92,
        render: (v: any) => <span className="occ-alloc-b">{fmt(v)}</span>,
      },
      {
        title: '欠量',
        dataIndex: 'shortage_qty',
        align: 'right',
        width: 92,
        render: (v: any) =>
          num(v) > 0 ? <span className="occ-short-b">{fmt(v)}</span> : <span className="occ-zero">0</span>,
      },
      { title: '状态', dataIndex: 'status', width: 84, render: (s: string) => statusTag(s) },
    ],
    [navigate, data, wf],
  )

  const handleExport = () => {
    if (!data) return
    exportCsv(
      `物料占用_${data.material_code}.csv`,
      ['合同交期', '订单号', '行号', '客户', '产品编码', '产品名称', '行数量', '单耗', '需求量', '可占量', '占用量', '欠量', '状态'],
      data.rows.map((r) => [
        r.promised_date || '',
        r.order_no,
        r.line_no,
        r.customer || '',
        r.product_code || '',
        r.product_name || '',
        fmt(r.open_qty),
        fmt(r.unit_qty),
        fmt(r.demand_qty),
        fmt(r.available_qty),
        fmt(r.allocated_qty),
        fmt(r.shortage_qty),
        StatusLabel[r.status] || r.status,
      ]),
    )
    message.success(`已导出 ${data.rows.length} 行`)
  }

  const brkRowIx = useMemo(
    () => (data ? data.rows.findIndex((r) => num(r.shortage_qty) > 0) : -1),
    [data],
  )

  return (
    <div>
      <div className="occ-toolbar">
        <AutoComplete
          value={keyword}
          options={options}
          style={{ width: 320 }}
          onChange={setKeyword}
          onSelect={(v: string) => doSearch(v)}
        >
          <Input
            placeholder="输入物料编码 / 名称搜索"
            prefix={<SearchOutlined style={{ color: 'var(--occ-g400)' }} />}
            allowClear
            onPressEnter={() => doSearch(keyword)}
          />
        </AutoComplete>
        {recents.length > 0 && <span className="note">最近：</span>}
        {recents.map((c) => (
          <span
            key={c}
            className={`occ-chip${c === currentCode ? ' active' : ''}`}
            onClick={() => {
              setKeyword(c)
              doSearch(c)
            }}
          >
            {c}
          </span>
        ))}
        {data && data.skipped_lines > 0 && (
          <div className="right">
            <span style={{ fontSize: 'calc(11.5px * var(--font-size-scale))', color: '#92400e' }}>
              {data.skipped_lines} 个开放订单行因缺 BOM / 数量异常未参与
            </span>
          </div>
        )}
      </div>

      <div className="occ-rule">
        <span style={{ flexShrink: 0, marginTop: 2 }}>ⓘ</span>
        <div>
          <b>占用规则</b>：开放订单产品行按<b>合同交期从早到晚</b>串行占用库存；需求量 = 累计单耗 ×
          行数量；库存 = 全仓即时结存（不含在途）；轮到该订单行时的剩余量即「可占量」，占用量 =
          min(需求量, 可占量)。
        </div>
      </div>

      {error && (
        <div className="occ-warn">
          <span>⚠</span>
          <div>{error}</div>
        </div>
      )}

      {!data && !error && !loading && (
        <div className="occ-card">
          <div className="occ-empty">
            <ExperimentOutlined style={{ fontSize: 'calc(34px * var(--font-size-scale))', color: 'var(--occ-g300)' }} />
            <div>输入物料编码或名称，查看库存被哪些订单按交期占用</div>
            <div style={{ fontSize: 'calc(11.5px * var(--font-size-scale))' }}>先占的订单吃掉库存，后来的排队欠料 —— 瀑布图讲清整个分配过程</div>
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="occ-ident">
            <div className="ico">
              <ExperimentOutlined />
            </div>
            <div className="who">
              <div className="nm">{data.material_name || '未命名物料'}</div>
              <div className="meta">
                <span className="cd">{data.material_code}</span>
                {data.spec_model && (
                  <span>
                    规格 <b>{data.spec_model}</b>
                  </span>
                )}
                {data.material_property != null && (
                  <span>
                    属性 <b>{data.material_property === 1 ? '外购' : data.material_property === 2 ? '自制' : data.material_property === 3 ? '委外' : `属性${data.material_property}`}</b>
                  </span>
                )}
                {data.unit_of_measure && (
                  <span>
                    单位 <b>{data.unit_of_measure}</b>
                  </span>
                )}
              </div>
            </div>
            <div className="spacer" />
            <div className="big">
              <div className="v">
                {fmt(data.stock_qty)}
                <span className="u">{data.unit_of_measure || ''}</span>
              </div>
              <div className="k">库存总量（全仓结存）</div>
            </div>
            <div className="big">
              <div className="v" style={{ color: 'var(--occ-teal)' }}>
                {fmt(data.transit_qty)}
                <span className="u">{data.unit_of_measure || ''}</span>
              </div>
              <div className="k">在途量（不参与占用）</div>
            </div>
          </div>

          <div className="occ-kpis">
            <div className="occ-kpi" style={{ ['--kc' as any]: 'var(--occ-brand-500)', ['--kbg' as any]: 'var(--occ-brand-50)' }}>
              <div className="ic">
                <ExperimentOutlined />
              </div>
              <div>
                <div className="label">涉及订单行</div>
                <div className="value">
                  {data.order_count}
                  <small>行</small>
                </div>
              </div>
            </div>
            <div className="occ-kpi" style={{ ['--kc' as any]: 'var(--occ-teal)', ['--kbg' as any]: 'var(--occ-info-bg)' }}>
              <div className="ic">Σ</div>
              <div>
                <div className="label">总需求量</div>
                <div className="value">{fmt(data.total_demand_qty)}</div>
              </div>
            </div>
            <div className="occ-kpi" style={{ ['--kc' as any]: 'var(--occ-success)', ['--kbg' as any]: 'var(--occ-success-bg)' }}>
              <div className="ic">✓</div>
              <div>
                <div className="label">已占用</div>
                <div className="value">{fmt(data.total_allocated_qty)}</div>
                <div className="delta">
                  {num(data.stock_qty) > 0
                    ? `${Math.min(100, Math.round((num(data.total_allocated_qty) / num(data.stock_qty)) * 100))}% 库存`
                    : ''}
                </div>
              </div>
            </div>
            <div className="occ-kpi" style={{ ['--kc' as any]: 'var(--occ-danger)', ['--kbg' as any]: 'var(--occ-danger-bg)' }}>
              <div className="ic">!</div>
              <div>
                <div className="label">总欠量</div>
                <div className="value">{fmt(data.total_shortage_qty)}</div>
                <div className="delta">
                  {num(data.total_demand_qty) > 0
                    ? `${Math.round((num(data.total_shortage_qty) / num(data.total_demand_qty)) * 100)}% 需求`
                    : ''}
                </div>
              </div>
            </div>
          </div>

          <div className="occ-card">
            <div className="occ-card-head">
              <h3>库存占用瀑布</h3>
              <span className="hint">按合同交期排队 · 段宽 = 需求量占比 · 悬停联动下方表格</span>
            </div>
            <div className="occ-wf-body">
              {wf ? (
                <>
                  <div className="occ-wf-top">
                    <span className="t">
                      {data.material_code} · 需求总量 {fmt(data.total_demand_qty)} {data.unit_of_measure || ''}
                    </span>
                    <span className="h">
                      库存 {fmt(data.stock_qty)} · 占用 {fmt(data.total_allocated_qty)} · 欠{' '}
                      {fmt(data.total_shortage_qty)}
                    </span>
                  </div>
                  <div className="occ-wf-wrap">
                    <div className="occ-wf-bar">
                      {wf.segs.map(({ i, r, demand }) => {
                        const alloc = num(r.allocated_qty)
                        const short = num(r.shortage_qty)
                        const aw = demand > 0 ? (alloc / demand) * 100 : 0
                        return (
                          <div
                            key={i}
                            className={`occ-wf-seg${hovered === i ? ' hl' : ''}`}
                            style={{ width: `${(demand / wf.totD) * 100}%` }}
                            title={`${r.order_no} ${r.product_name || ''}：需求 ${fmt(demand)} / 占用 ${fmt(alloc)}${short > 0 ? ` / 欠 ${fmt(short)}` : ''}`}
                            onMouseEnter={() => setHovered(i)}
                            onMouseLeave={() => setHovered(null)}
                          >
                            {alloc > 0 && <div className={`ok${r.status === 'partial' ? ' part' : ''}`} style={{ width: `${aw}%` }} />}
                            {short > 0 && <div className="miss" style={{ width: `${100 - aw}%` }} />}
                          </div>
                        )
                      })}
                    </div>
                    {wf.segs.map(({ i, r, demand, left }) => (
                      <div key={i} className="occ-wf-lbl" style={{ left: `${left}%` }}>
                        <b>{r.promised_date ? r.promised_date.slice(5).replace('-', '/') : '-'}</b>
                        {fmt(demand)}
                      </div>
                    ))}
                    {wf.brk && (
                      <div className="occ-wf-break" style={{ left: `${wf.brk.left}%` }}>
                        <span className="bk">{wf.brk.label}</span>
                      </div>
                    )}
                  </div>
                  <div className="occ-wf-axis">
                    <span>0</span>
                    <span>{fmt(Math.round(wf.totD * 0.25))}</span>
                    <span>{fmt(Math.round(wf.totD * 0.5))}</span>
                    <span>{fmt(Math.round(wf.totD * 0.75))}</span>
                    <span>{fmt(wf.totD)}</span>
                  </div>
                  <div className="occ-wf-legend">
                    <span>
                      <i className="l-ok" />
                      满足（占用 = 需求）
                    </span>
                    <span>
                      <i className="l-part" />
                      部分占用
                    </span>
                    <span>
                      <i className="l-miss" />
                      欠量（库存不足）
                    </span>
                    <span>
                      <i className="l-brk" />
                      库存见底断点
                    </span>
                  </div>
                </>
              ) : (
                <div className="occ-empty">该物料当前无开放订单需求</div>
              )}
            </div>
          </div>

          <div className="occ-card">
            <div className="occ-card-head">
              <h3>占用队列</h3>
              <span className="hint">按合同交期升序 · 第 1 行最先占用</span>
              <span className="more">
                占用率{' '}
                {num(data.stock_qty) > 0
                  ? Math.min(100, Math.round((num(data.total_allocated_qty) / num(data.stock_qty)) * 100))
                  : 0}
                %
              </span>
              <Button size="small" type="text" icon={<DownloadOutlined />} onClick={handleExport}>
                导出 CSV
              </Button>
            </div>
            <Table
              className="occ-tbl"
              rowKey={(r: OccupancyOrderRow) => `${r.order_no}-${r.line_no}`}
              size="small"
              loading={loading}
              columns={columns}
              dataSource={data.rows}
              pagination={false}
              rowClassName={(_: OccupancyOrderRow, i: number) =>
                `${i === brkRowIx ? 'occ-brk' : ''}${hovered === i ? ' occ-hl' : ''}`
              }
              summary={() => {
                const rows = data.rows
                if (rows.length === 0) return null
                const remain = Math.max(0, num(data.stock_qty) - num(data.total_allocated_qty))
                return (
                  <Table.Summary fixed>
                    <Table.Summary.Row style={{ background: 'var(--occ-g50)', fontWeight: 600 }}>
                      <Table.Summary.Cell index={0} />
                      <Table.Summary.Cell index={1} colSpan={5}>
                        <span style={{ color: 'var(--occ-g500)', fontWeight: 500 }}>合计（{rows.length} 行）</span>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={2} align="right">
                        {fmt(data.total_demand_qty)}
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={3} align="right">
                        <span style={{ color: 'var(--occ-g500)', fontWeight: 500 }}>剩余 {fmt(remain)}</span>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={4} align="right">
                        {fmt(data.total_allocated_qty)}
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={5} align="right">
                        <span style={{ color: 'var(--occ-danger)' }}>{fmt(data.total_shortage_qty)}</span>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={6} />
                    </Table.Summary.Row>
                  </Table.Summary>
                )
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}
