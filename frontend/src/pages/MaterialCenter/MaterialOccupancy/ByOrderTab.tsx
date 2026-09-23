import { useCallback, useEffect, useMemo, useState } from 'react'
import { AutoComplete, Button, Input, Table, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { SearchOutlined, DownloadOutlined, FileTextOutlined } from '@ant-design/icons'
import { materialApi } from '@/services/api'
import {
  duePill,
  exportCsv,
  fmt,
  getRecent,
  OccupancyMaterialRow,
  OrderLineOccupancy,
  OrderOccupancyData,
  pushRecent,
  statusTag,
  num,
} from './common'

const RECENT_KEY = 'occ_recent_orders'

const StatusLabel: Record<string, string> = { met: '满足', partial: '部分', shortage: '欠料' }

export default function ByOrderTab({
  refreshKey,
  onDrillMaterial,
}: {
  refreshKey: number
  onDrillMaterial: (materialCode: string) => void
}) {
  const [keyword, setKeyword] = useState('')
  const [options, setOptions] = useState<{ value: string; label: string }[]>([])
  const [data, setData] = useState<OrderOccupancyData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>(() => getRecent(RECENT_KEY))
  const [currentOrder, setCurrentOrder] = useState<string | null>(null)

  const doSearch = useCallback(async (orderNo: string) => {
    const trimmed = orderNo.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    try {
      const res = await materialApi.getOccupancyByOrder({ order_no: trimmed })
      setData(res.data.data)
      setCurrentOrder(trimmed)
      pushRecent(RECENT_KEY, trimmed)
      setRecents(getRecent(RECENT_KEY))
    } catch (e: any) {
      setData(null)
      setCurrentOrder(null)
      setError(e?.response?.data?.detail || e?.message || '查询失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (refreshKey > 0 && currentOrder) {
      doSearch(currentOrder)
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
        const res = await materialApi.searchOccupancyOrders({ keyword: kw })
        setOptions((res.data.data || []).map((o: string) => ({ value: o, label: o })))
      } catch {
        setOptions([])
      }
    }, 300)
    return () => clearTimeout(handle)
  }, [keyword])

  const buildColumns = useCallback(
    (line: OrderLineOccupancy): ColumnsType<OccupancyMaterialRow> => [
      {
        title: '层级',
        width: 56,
        render: (_: any, r: OccupancyMaterialRow) => <span className="occ-lv">L{r.level}</span>,
      },
      {
        title: '物料编码',
        width: 170,
        render: (_: any, r: OccupancyMaterialRow) => (
          <a className="occ-link occ-mono" onClick={() => onDrillMaterial(r.material_code)}>
            {r.material_code}
          </a>
        ),
      },
      {
        title: '名称',
        render: (_: any, r: OccupancyMaterialRow) => (
          <span style={{ color: 'var(--occ-t1)', fontWeight: 500 }}>
            {r.material_name || '-'}
            {r.spec_model ? <span style={{ color: 'var(--occ-t3)', fontWeight: 400, fontSize: 'calc(10.5px * var(--font-size-scale))' }}> / {r.spec_model}</span> : null}
            <span className="occ-unit-c">{r.unit_of_measure || ''}</span>
          </span>
        ),
      },
      { title: '单耗', dataIndex: 'unit_qty', align: 'right', width: 80, render: fmt },
      {
        title: '需求量',
        dataIndex: 'demand_qty',
        align: 'right',
        width: 96,
        render: (v: any) => <span style={{ color: 'var(--occ-t1)', fontWeight: 500 }}>{fmt(v)}</span>,
      },
      { title: '库存总量', dataIndex: 'stock_qty', align: 'right', width: 96, render: fmt },
      {
        title: '前序占用',
        dataIndex: 'prior_allocated_qty',
        align: 'right',
        width: 92,
        render: (v: any) => <span style={{ color: 'var(--occ-g500)' }}>{fmt(v)}</span>,
      },
      {
        title: '本单竞争（需求=100%）',
        width: 190,
        render: (_: any, r: OccupancyMaterialRow) => {
          const demand = num(r.demand_qty)
          const prior = num(r.prior_allocated_qty)
          const alloc = num(r.allocated_qty)
          const short = num(r.shortage_qty)
          const base = Math.max(demand, num(r.stock_qty))
          if (base <= 0) return <span className="occ-zero">—</span>
          const wPr = (prior / base) * 100
          const wAl = (alloc / base) * 100
          const wSp = Math.max(0, (num(r.stock_qty) - prior - alloc) / base * 100)
          return (
            <div
              className="occ-rival"
              title={`前序占用 ${fmt(prior)} / 本单占用 ${fmt(alloc)}${short > 0 ? ` / 欠 ${fmt(short)}` : ''} / 富余 ${fmt(Math.max(0, num(r.stock_qty) - prior - alloc))}`}
            >
              {prior > 0 && <div className="pr" style={{ width: `${wPr}%` }} />}
              {alloc > 0 && <div className="al" style={{ width: `${wAl}%` }} />}
              {wSp > 0.5 && <div className="sp" style={{ width: `${wSp}%` }} />}
            </div>
          )
        },
      },
      {
        title: '占用量',
        dataIndex: 'allocated_qty',
        align: 'right',
        width: 88,
        render: (v: any) => <span className="occ-alloc-b">{fmt(v)}</span>,
      },
      {
        title: '欠量',
        dataIndex: 'shortage_qty',
        align: 'right',
        width: 88,
        render: (v: any) =>
          num(v) > 0 ? <span className="occ-short-b">{fmt(v)}</span> : <span className="occ-zero">0</span>,
      },
      { title: '状态', dataIndex: 'status', width: 84, render: (s: string) => statusTag(s) },
    ],
    [onDrillMaterial],
  )

  const handleExport = () => {
    if (!data) return
    const rows: (string | number)[][] = []
    data.lines.forEach((l) => {
      l.rows.forEach((r) => {
        rows.push([
          data.order_no,
          l.line_no,
          l.product_code || '',
          l.product_name || '',
          `L${r.level}`,
          r.material_code,
          r.material_name || '',
          fmt(r.unit_qty),
          fmt(r.demand_qty),
          fmt(r.stock_qty),
          fmt(r.prior_allocated_qty),
          fmt(r.available_qty),
          fmt(r.allocated_qty),
          fmt(r.shortage_qty),
          StatusLabel[r.status] || r.status,
        ])
      })
    })
    exportCsv(
      `订单BOM占用_${data.order_no}.csv`,
      ['订单号', '行号', '产品编码', '产品名称', '层级', '物料编码', '物料名称', '单耗', '需求量', '库存总量', '前序占用', '本单可占量', '占用量', '欠量', '状态'],
      rows,
    )
    message.success(`已导出 ${rows.length} 行`)
  }

  const totalMats = useMemo(
    () => (data ? data.lines.reduce((s, l) => s + l.rows.length, 0) : 0),
    [data],
  )

  return (
    <div>
      <div className="occ-toolbar">
        <AutoComplete
          value={keyword}
          options={options}
          style={{ width: 280 }}
          onChange={setKeyword}
          onSelect={(v: string) => doSearch(v)}
        >
          <Input
            placeholder="输入销售订单号"
            prefix={<SearchOutlined style={{ color: 'var(--occ-g400)' }} />}
            allowClear
            onPressEnter={() => doSearch(keyword)}
          />
        </AutoComplete>
        {recents.length > 0 && <span className="note">最近：</span>}
        {recents.map((c) => (
          <span
            key={c}
            className={`occ-chip${c === currentOrder ? ' active' : ''}`}
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
              该订单有 {data.skipped_lines} 个产品行因缺 BOM / 数量异常未参与
            </span>
          </div>
        )}
      </div>

      <div className="occ-rule">
        <span style={{ flexShrink: 0, marginTop: 2 }}>ⓘ</span>
        <div>
          <b>竞争条</b>：以该物料在本订单的需求量为基准。<b>灰 = 前序订单占用</b>（交期更早的订单已吃掉的库存）·{' '}
          <b>靛 = 本单占用</b> · <b>黄斜纹 = 本单欠量</b> · 浅灰 = 库存富余。点物料编码可跳转「按物料」视角查看完整占用队列。
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
            <FileTextOutlined style={{ fontSize: 'calc(34px * var(--font-size-scale))', color: 'var(--occ-g300)' }} />
            <div>输入订单号，展开订单 BOM 查看每个物料的占用竞争结果</div>
            <div style={{ fontSize: 'calc(11.5px * var(--font-size-scale))' }}>看清楚库存被哪些更早交期的订单抢走、本单还能占到多少</div>
          </div>
        </div>
      )}

      {data && (
        <>
          <div className="occ-ident">
            <div className="ico">
              <FileTextOutlined />
            </div>
            <div className="who">
              <div className="nm">{data.order_no}</div>
              <div className="meta">
                {data.customer && (
                  <span>
                    客户 <b>{data.customer}</b>
                  </span>
                )}
                <span>
                  产品行 <b>{data.lines.length}</b>
                </span>
                <span>
                  物料 <b>{totalMats}</b>
                </span>
              </div>
            </div>
            <div className="spacer" />
            <div className="big">
              <div
                className="v"
                style={{ color: data.shortage_material_count > 0 ? 'var(--occ-danger)' : 'var(--occ-success)' }}
              >
                {data.shortage_material_count}
                <span className="u">项</span>
              </div>
              <div className="k">欠料物料数</div>
            </div>
            <div className="big">
              <div className="v" style={{ color: 'var(--occ-brand-500)' }}>
                <Button size="small" type="text" icon={<DownloadOutlined />} onClick={handleExport}>
                  导出 CSV
                </Button>
              </div>
              <div className="k" />
            </div>
          </div>

          {data.lines.map((line) => (
            <div className="occ-card" key={line.line_no}>
              <div className="occ-lhead">
                <span className="occ-lv">{line.line_no}</span>
                <span className="nm">{line.product_name || line.product_code || '未命名产品'}</span>
                <span className="cd">
                  {[line.product_code, line.bom_id ? `BOM ${line.bom_id}` : null].filter(Boolean).join(' · ')}
                </span>
                <div className="rt">
                  <span>
                    行数量 <b>{fmt(line.open_qty)}</b>
                  </span>
                  <span>交期 {duePill(line.promised_date)}</span>
                </div>
              </div>
              <Table
                className="occ-tbl"
                rowKey={(r: OccupancyMaterialRow) => `${line.line_no}-${r.material_id}`}
                size="small"
                loading={loading}
                columns={buildColumns(line)}
                dataSource={line.rows}
                pagination={false}
              />
            </div>
          ))}
        </>
      )}
    </div>
  )
}
