import { useEffect, useMemo, useRef, useState } from 'react'
import type { Key, RefObject } from 'react'
import { Button, Drawer, Input, Segmented, Table, Upload, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { RcFile } from 'antd/es/upload'
import {
  SearchOutlined, InboxOutlined, FileExcelOutlined, FileTextOutlined,
  ReloadOutlined, ColumnHeightOutlined, FileOutlined,
  AppstoreOutlined, ClockCircleOutlined, CloseOutlined, FileTextFilled,
} from '@ant-design/icons'
import { materialApi } from '../../services/api'
import { useExport } from '../../hooks/useExport'

/** 报废物料库存查询 — 按 docs/prototype/redesign/scrap-inventory.html 复刻，
 * 视觉/字体接入 .sc-page 统一体系（同物料盘点 / 物料主数据页），页面补充样式在 index.css si-* 段。 */

const STATUS_HAS = '有库存'
const STATUS_ZERO = '库存为零'
const STATUS_NF = '中台无此物料'

type Flt = 'all' | 'has' | 'zero' | 'nf'
type Mode = 'paste' | 'file'

interface WhRow {
  wh_id: number
  wh_code: string | null
  wh_name: string | null
  qty: number
  locked_qty: number
  qty_in_transit: number
  last_inbound_at: string | null
  last_outbound_at: string | null
}

interface Row {
  material_code: string
  material_name: string
  total_qty: number
  status: string
  warehouses: WhRow[]
}

interface Stats {
  total: number
  has_stock: number
  zero_stock: number
  not_found: number
  total_qty: number
}

interface LoadInfo {
  source: string
  parsed: number
  dup: number
  invalid: number
}

const STATUS_CLS: Record<string, string> = {
  [STATUS_HAS]: 'sc-tag-done',
  [STATUS_ZERO]: 'sc-tag-warn',
  [STATUS_NF]: 'sc-tag-danger',
}

/** 粘贴文本 → 去重保持顺序的代码列表 + 重复数（换行/逗号/分号/空白分隔） */
const parsePastedCodes = (text: string): { list: string[]; dup: number } => {
  const raw = text.split(/[\s,;，；]+/).map(s => s.trim()).filter(Boolean)
  const list = Array.from(new Set(raw))
  return { list, dup: raw.length - list.length }
}

const numFmt = (v: number) => v.toLocaleString()

/** 实测容器高度，扣除表头/分页实测高度，得出表格体 scroll.y，保证窗口不出现滚动条（同 Inventory 页模式） */
function useTableScrollY(wrapRef: RefObject<HTMLDivElement | null>, deps: unknown[] = []) {
  const [scrollY, setScrollY] = useState<number>(400)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      const thead = el.querySelector('.ant-table-thead') as HTMLElement | null
      const pag = el.querySelector('.ant-pagination') as HTMLElement | null
      const theadH = thead ? thead.offsetHeight : 39
      // 分页: 自身高度 + 上外距16; 卡片: 底部内边距4 + 边框2; 无分页时仅卡片部分
      const extra = pag ? pag.offsetHeight + 16 + 4 + 2 : 4 + 2
      const y = el.clientHeight - theadH - extra
      setScrollY(Math.max(y, 120))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild as HTMLElement)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapRef, ...deps])
  return scrollY
}

export default function ScrapInventory() {
  const [mode, setMode] = useState<Mode>('paste')
  const [inputText, setInputText] = useState('')
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [codes, setCodes] = useState<string[]>([])
  const [loadInfo, setLoadInfo] = useState<LoadInfo | null>(null)
  const [flt, setFlt] = useState<Flt>('all')
  const [kw, setKw] = useState('')
  const [dense, setDense] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [drawerRow, setDrawerRow] = useState<Row | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([])
  const { exporting, exportPostData } = useExport()
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  const scrollY = useTableScrollY(tableWrapRef, [rows.length])

  const applyResult = (payload: any, info: LoadInfo) => {
    setRows(payload.items || [])
    setStats(payload.stats || null)
    setCodes(payload.codes || [])
    setLoadInfo(info)
    setSelectedKeys([])
    setFlt('all')
    setKw('')
    setCollapsed(true)
    if (info.invalid > 0) {
      const first = payload.invalid_rows?.[0] ? `：${payload.invalid_rows[0]}` : ''
      message.warning(`已忽略 ${info.invalid} 行无效数据${first}${info.invalid > 1 ? ' 等' : ''}`)
    }
  }

  const handleQuery = async () => {
    const { list, dup } = parsePastedCodes(inputText)
    if (!list.length) {
      message.warning('请先粘贴物料代码')
      return
    }
    setLoading(true)
    try {
      const res: any = await materialApi.queryScrapInventory(list)
      applyResult(res.data, { source: '粘贴输入', parsed: list.length + dup, dup, invalid: (res.data.invalid_rows || []).length })
    } catch (e: any) {
      if (e?.response?.status === 400) {
        message.error(e?.response?.data?.detail || '查询失败')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleFile = async (file: RcFile) => {
    setLoading(true)
    try {
      const res: any = await materialApi.queryScrapInventoryFile(file)
      applyResult(res.data, {
        source: file.name,
        parsed: (res.data.codes || []).length + (res.data.duplicated || 0),
        dup: res.data.duplicated || 0,
        invalid: (res.data.invalid_rows || []).length,
      })
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '文件解析或查询失败')
    } finally {
      setLoading(false)
    }
    return false
  }

  const handleRequery = async () => {
    if (!codes.length) return
    setLoading(true)
    try {
      const res: any = await materialApi.queryScrapInventory(codes)
      applyResult(res.data, loadInfo || { source: '粘贴输入', parsed: codes.length, dup: 0, invalid: 0 })
    } catch {
      /* 拦截器已提示 */
    } finally {
      setLoading(false)
    }
  }

  const handleClear = () => {
    setRows([])
    setStats(null)
    setCodes([])
    setLoadInfo(null)
    setSelectedKeys([])
    setFlt('all')
    setKw('')
    setCollapsed(false)
  }

  /** 导出：默认跟随当前筛选结果（状态 chips + 关键字），可显式指定目标（选中/仅有库存） */
  const doExport = async (format: 'xlsx' | 'csv', target?: string[]) => {
    const list = target && target.length ? target : filteredCodes
    if (!list.length) {
      message.warning('当前筛选下没有可导出的数据')
      return
    }
    await exportPostData('/api/v1/materials/scrap-inventory/export', { codes: list, format }, `报废物料库存.${format}`)
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      message.success(`已复制 ${code}`)
    } catch {
      message.error('复制失败')
    }
  }

  const kwLower = kw.trim().toLowerCase()
  const filtered = useMemo(() => rows.filter(r => {
    if (flt === 'has' && r.status !== STATUS_HAS) return false
    if (flt === 'zero' && r.status !== STATUS_ZERO) return false
    if (flt === 'nf' && r.status !== STATUS_NF) return false
    if (kwLower && !r.material_code.toLowerCase().includes(kwLower) && !(r.material_name || '').toLowerCase().includes(kwLower)) return false
    return true
  }), [rows, flt, kwLower])

  const hasStockCodes = useMemo(
    () => rows.filter(r => r.status === STATUS_HAS).map(r => r.material_code),
    [rows],
  )
  /** 当前筛选（状态 chips + 搜索关键字）下的代码列表，导出默认口径 */
  const filteredCodes = useMemo(() => filtered.map(r => r.material_code), [filtered])
  const whTotal = useMemo(() => {
    const s = new Set<string>()
    rows.filter(r => r.status === STATUS_HAS).forEach(r => r.warehouses.forEach(w => s.add(w.wh_name || w.wh_code || `#${w.wh_id}`)))
    return s.size
  }, [rows])

  const whCell = (r: Row) => {
    const ws = r.warehouses
    if (!ws.length) return <span className="si-wh-mini none">— 无在库记录</span>
    const firstName = ws[0].wh_name || ws[0].wh_code || `仓库#${ws[0].wh_id}`
    if (ws.length === 1) {
      return <span className="si-wh-mini"><AppstoreOutlined />{firstName} · 单仓</span>
    }
    return (
      <a className="si-wh-link si-wh-mini" onClick={() => setDrawerRow(r)}>
        <AppstoreOutlined />{firstName} 等 <span className="n">{ws.length}</span> 仓
      </a>
    )
  }

  const columns: ColumnsType<Row> = [
    { title: '#', width: 44, render: (_v, _r, i) => <span style={{ color: '#94a3b8' }}>{i + 1}</span> },
    {
      title: '物料',
      render: (_v, r) => (
        <div style={{ minWidth: 250 }}>
          <div className="sc-mat-name">{r.material_name || <span style={{ color: '#94a3b8', fontWeight: 400 }}>（清单未提供名称）</span>}</div>
          <div className="sc-mat-code" style={r.status === STATUS_NF ? { color: '#dc2626' } : undefined}>
            {r.material_code}{r.status === STATUS_NF ? ' · 未在中台找到' : ''}
          </div>
        </div>
      ),
    },
    { title: '仓库分布', render: (_v, r) => whCell(r) },
    {
      title: '库存数（合计）', align: 'right',
      render: (_v, r) => r.status === STATUS_NF
        ? <span style={{ color: '#94a3b8' }}>—</span>
        : <span style={{ color: r.total_qty > 0 ? '#0f172a' : '#94a3b8', fontWeight: r.total_qty > 0 ? 500 : 400 }}>{numFmt(r.total_qty)}</span>,
    },
    {
      title: '状态', width: 132,
      render: (_v, r) => <span className={`sc-tag ${STATUS_CLS[r.status] || 'sc-tag-plain'}`}><span className="dot" />{r.status}</span>,
    },
    {
      title: '', width: 140,
      render: (_v, r) => (
        <span className="sc-row-act">
          {r.warehouses.length > 0 && <a onClick={() => setDrawerRow(r)}>库存明细</a>}
          <a onClick={() => copyCode(r.material_code)}>复制代码</a>
        </span>
      ),
    },
  ]

  const chips: { key: Flt; label: string; n: number; cls?: string; hot?: boolean }[] = [
    { key: 'all', label: '全部', n: stats?.total ?? 0 },
    { key: 'has', label: '有库存', n: stats?.has_stock ?? 0, cls: 'si-has' },
    { key: 'zero', label: '库存为零', n: stats?.zero_stock ?? 0, cls: 'si-zero' },
    { key: 'nf', label: '未匹配', n: stats?.not_found ?? 0, cls: 'si-nf', hot: (stats?.not_found ?? 0) > 0 },
  ]

  const drawer = drawerRow
  const drawerTotal = drawer ? drawer.warehouses.reduce((s, w) => s + w.qty, 0) : 0
  const drawerLocked = drawer ? drawer.warehouses.reduce((s, w) => s + w.locked_qty, 0) : 0
  const drawerTransit = drawer ? drawer.warehouses.reduce((s, w) => s + w.qty_in_transit, 0) : 0
  const lastIn = drawer ? maxStr(drawer.warehouses.map(w => w.last_inbound_at)) : null
  const lastOut = drawer ? maxStr(drawer.warehouses.map(w => w.last_outbound_at)) : null

  return (
    <div className="sc-page" style={{ height: 'calc(100vh - 104px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ============ 载入清单卡（查询成功后自动收起为单行摘要，点「展开编辑」恢复） ============ */}
      {collapsed && loadInfo ? (
        <div className="sc-card si-load-mini" style={{ flexShrink: 0 }}>
          <span className="ttl"><FileTextFilled />载入报废物料清单</span>
          <span className="si-file-chip"><FileOutlined />{loadInfo.source}</span>
          <span className="sep" />
          <span>解析 <b>{numFmt(loadInfo.parsed)}</b> 项</span>
          <span>重复 <b>{numFmt(loadInfo.dup)}</b> 项已合并</span>
          <span>无效 <b>{numFmt(loadInfo.invalid)}</b> 行</span>
          <span style={{ marginLeft: 'auto' }} />
          <span className={`act${loading ? ' dim' : ''}`} onClick={() => { if (!loading) handleRequery() }}><ReloadOutlined />重新查询</span>
          <span className="act" onClick={() => setCollapsed(false)}>展开编辑</span>
          <span className="act dim" onClick={handleClear}>清空</span>
        </div>
      ) : (
      <div className="sc-card" style={{ flexShrink: 0 }}>
        <div className="si-card-head">
          <h3>载入报废物料清单</h3>
          <span className="hint">一次性核对工具 — 不落库、不留痕；库存为即时库存跨仓合计</span>
          <span className="more">支持 GBK / UTF-8</span>
        </div>
        <div className="si-card-body">
          <div className="si-load-mode">
            <Segmented
              value={mode}
              onChange={v => setMode(v as Mode)}
              options={[
                { label: '粘贴代码', value: 'paste' },
                { label: '上传文件', value: 'file' },
              ]}
            />
          </div>
          <div className="si-load-grid">
            <div>
              {mode === 'paste' ? (
                <textarea
                  className="si-paste-box"
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  placeholder={'粘贴物料代码（换行 / 逗号 / 分号分隔均可，自动去重），如：\n1.3.3.JFW41-03-01\n1.6.3.JFW41-100W'}
                />
              ) : (
                <Upload.Dragger
                  className="si-dropzone"
                  accept=".csv,.xlsx,.xlsm"
                  showUploadList={false}
                  beforeUpload={f => { void handleFile(f); return false }}
                  disabled={loading}
                >
                  <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                  <p className="ant-upload-text">点击或拖拽上传清单文件</p>
                  <p className="ant-upload-hint">CSV（GBK / UTF-8 自动识别）或 Excel · 第 1 列物料代码、第 2 列名称（可选）</p>
                </Upload.Dragger>
              )}
            </div>
            <div className="si-load-side">
              <Button type="primary" size="large" icon={<SearchOutlined />} loading={loading} onClick={handleQuery}>查询库存</Button>
              <div className="si-hint-list">
                · 换行 / 逗号 / 分号分隔均可，<b>自动去重</b><br />
                · 多行表头（标题行 + 列头行）自动跳过<br />
                · 单次上限 <b>2,000</b> 项，超长行忽略并提示<br />
                · 库存为即时库存，跨仓库合计
              </div>
            </div>
          </div>
        </div>
        {loadInfo && (
          <div className="si-load-foot">
            <span className="si-file-chip"><FileOutlined />{loadInfo.source}</span>
            <span className="sep" />
            <span>解析 <b>{numFmt(loadInfo.parsed)}</b> 项</span>
            <span>重复 <b>{numFmt(loadInfo.dup)}</b> 项已合并</span>
            <span>无效 <b>{numFmt(loadInfo.invalid)}</b> 行</span>
            <span style={{ marginLeft: 'auto' }} />
            <span className="act" onClick={handleRequery}>重新查询</span>
            <span className="act dim" onClick={handleClear}>清空</span>
          </div>
        )}
      </div>
      )}

      {/* ============ KPI 带 ============ */}
      {stats && (
        <div className="si-kpi-band" style={{ flexShrink: 0 }}>
          <div className="sc-card sc-stat-card" style={{ ['--accent' as any]: '#5b5bd6', ['--accent-bg' as any]: '#eef0fe' }}>
            <div className="sc-stat-icon"><FileTextFilled /></div>
            <div className="sc-stat-main">
              <div className="sc-stat-label">清单条目</div>
              <div className="sc-stat-value">{numFmt(stats.total)}<small>项</small></div>
              <div className={`sc-stat-delta ${loadInfo && loadInfo.dup > 0 ? 'up' : 'flat'}`}>
                {loadInfo && loadInfo.dup > 0 ? `${numFmt(loadInfo.dup)} 项重复已合并` : '一次性核对 · 不落库'}
              </div>
            </div>
          </div>
          <div className="sc-card sc-stat-card" style={{ ['--accent' as any]: '#16a34a', ['--accent-bg' as any]: '#f0fdf4' }}>
            <div className="sc-stat-icon"><AppstoreOutlined /></div>
            <div className="sc-stat-main">
              <div className="sc-stat-label">有库存物料</div>
              <div className="sc-stat-value">{numFmt(stats.has_stock)}<small>项</small></div>
              <div className="sc-stat-delta up">在库合计 {numFmt(stats.total_qty)} 件</div>
            </div>
          </div>
          <div className="sc-card sc-stat-card" style={{ ['--accent' as any]: '#d97706', ['--accent-bg' as any]: '#fffbeb' }}>
            <div className="sc-stat-icon"><ClockCircleOutlined /></div>
            <div className="sc-stat-main">
              <div className="sc-stat-label">库存为零</div>
              <div className="sc-stat-value">{numFmt(stats.zero_stock)}<small>项</small></div>
              <div className="sc-stat-delta flat">中台有物料 · 无在库</div>
            </div>
          </div>
          <div className="sc-card sc-stat-card" style={{ ['--accent' as any]: '#dc2626', ['--accent-bg' as any]: '#fef2f2' }}>
            <div className="sc-stat-icon"><CloseOutlined /></div>
            <div className="sc-stat-main">
              <div className="sc-stat-label">中台无此物料</div>
              <div className="sc-stat-value">{numFmt(stats.not_found)}<small>项</small></div>
              <div className={`sc-stat-delta ${stats.not_found > 0 ? 'down' : 'flat'}`}>
                {stats.not_found > 0 ? '建议核对代码拼写' : '清单全部匹配'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ 工具栏 ============ */}
      <div className="si-toolbar" style={{ flexShrink: 0 }}>
        <Input
          className="sc-search"
          style={{ width: 220 }}
          prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
          placeholder="在结果中搜索代码 / 名称"
          allowClear
          value={kw}
          onChange={e => setKw(e.target.value)}
          disabled={!rows.length}
        />
        <div className="chips">
          {chips.map(c => (
            <span
              key={c.key}
              className={`sc-chip${flt === c.key ? ' on' : ''}${flt === c.key && c.cls ? ` ${c.cls}` : ''}`}
              onClick={() => setFlt(c.key)}
            >
              {c.label} <span className="n" style={c.hot ? { color: '#dc2626', opacity: 1, fontWeight: 600 } : undefined}>{numFmt(c.n)}</span>
            </span>
          ))}
        </div>
        <div className="right">
          <span
            className={`si-icon-btn${dense ? ' on' : ''}`}
            title="紧凑密度（点击生效）"
            onClick={() => setDense(d => !d)}
          >
            <ColumnHeightOutlined />
          </span>
          <span className="si-icon-btn" title="重新查询（以最新库存刷新）" onClick={handleRequery}>
            <ReloadOutlined />
          </span>
          <span className="vsep" />
          <Button
            icon={<FileTextOutlined />} size="small"
            disabled={!filteredCodes.length} loading={exporting}
            title={`导出当前筛选结果（${filteredCodes.length} 项）`}
            onClick={() => doExport('csv')}
          >导出 CSV</Button>
          <Button
            type="primary" size="small" icon={<FileExcelOutlined />}
            disabled={!filteredCodes.length} loading={exporting}
            title={`导出当前筛选结果（${filteredCodes.length} 项）`}
            onClick={() => doExport('xlsx')}
          >导出 Excel</Button>
        </div>
      </div>

      {/* ============ 结果表 ============ */}
      <div ref={tableWrapRef} className="sc-card" style={{ flex: 1, minHeight: 0, padding: '0 0 4px', overflow: 'hidden' }}>
        <Table<Row>
          className={dense ? 'si-dense' : undefined}
          rowKey="material_code"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          size="small"
          scroll={{ x: 900, y: scrollY }}
          rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys, columnWidth: 36 }}
          pagination={{
            pageSize: 50,
            showSizeChanger: true,
            showTotal: t => `共 ${t} 条 · 每页 50 条`,
          }}
          locale={{ emptyText: '载入清单并查询后，结果将在这里展示' }}
          summary={() => {
            if (!rows.length) return null
            return (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} />
                  <Table.Summary.Cell index={1} colSpan={2}>合计 · 有库存 {numFmt(stats?.has_stock ?? 0)} 项</Table.Summary.Cell>
                  <Table.Summary.Cell index={3}>分布于 {whTotal} 个仓库</Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">{numFmt(stats?.total_qty ?? 0)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={5} colSpan={2}><span style={{ fontWeight: 500, color: '#64748b' }}>仅统计有库存行</span></Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            )
          }}
        />
      </div>

      {/* ============ 勾选批量条 ============ */}
      <div className="sc-batch-bar" style={{ opacity: selectedKeys.length > 0 ? 1 : 0, pointerEvents: selectedKeys.length > 0 ? 'auto' : 'none', transform: selectedKeys.length > 0 ? 'translateX(-50%)' : 'translateX(-50%) translateY(10px)', transition: '.18s' }}>
        <span className="bb-n">已选 <b>{numFmt(selectedKeys.length)}</b> 项</span>
        <span className="bb-sep" />
        <Button size="small" icon={<FileExcelOutlined />} onClick={() => doExport('xlsx', selectedKeys as string[])}>导出选中</Button>
        <Button size="small" type="text" onClick={() => doExport('xlsx', hasStockCodes)}>仅导出有库存</Button>
        <span style={{ fontSize: 'calc(12px * var(--font-size-scale))', color: '#94a3b8', cursor: 'pointer', padding: '2px 6px', borderRadius: 5 }} onClick={() => setSelectedKeys([])}>清空选择</span>
      </div>

      {/* ============ 库存明细抽屉 ============ */}
      <Drawer
        open={!!drawer}
        onClose={() => setDrawerRow(null)}
        width={460}
        rootClassName="sc-page sc-drawer"
        styles={{ header: { padding: '16px 20px 14px', borderBottom: '1px solid #f1f5f9' } }}
        title={drawer && (
          <div>
            <div style={{ fontSize: 'calc(16.5px * var(--font-size-scale))', fontWeight: 600, lineHeight: 1.4 }}>{drawer.material_name || '（清单未提供名称）'}</div>
            <div className="sc-mat-code" style={{ marginTop: 2 }}>{drawer.material_code}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <span className={`sc-tag ${STATUS_CLS[drawer.status] || 'sc-tag-plain'}`}><span className="dot" />{drawer.status}</span>
              <span className="sc-tag sc-tag-kit">即时库存</span>
            </div>
          </div>
        )}
      >
        {drawer && (
          <>
            <div className="d-sec">
              <h4>仓库分布 <span style={{ float: 'right', fontWeight: 500, color: '#475569', letterSpacing: 0 }}>{drawer.warehouses.length} 个仓库</span></h4>
              {drawer.warehouses.map(w => {
                const pct = drawerTotal > 0 ? (w.qty / drawerTotal) * 100 : 0
                return (
                  <div className="si-wh-row" key={`${w.wh_id}-${w.wh_code || ''}`}>
                    <div className="t">
                      <b>{w.wh_name || w.wh_code || `仓库#${w.wh_id}`}</b>
                      {w.wh_code && <span className="whc">{w.wh_code}</span>}
                      <span className="q">{numFmt(w.qty)}</span>
                      <span className="pct">{pct.toFixed(1)}%</span>
                    </div>
                    <div className="si-wh-bar"><i style={{ width: `${Math.min(pct, 100)}%` }} /></div>
                  </div>
                )
              })}
              <div className="si-d-total">
                合计在库 <b>{numFmt(drawerTotal)}</b>
                <span className="sub">件 · 锁定 {numFmt(drawerLocked)} · 在途 {numFmt(drawerTransit)}</span>
              </div>
            </div>
            <div className="d-sec">
              <h4>物料信息</h4>
              <dl className="d-kv">
                <dt>物料代码</dt><dd>{drawer.material_code}</dd>
                <dt>物料名称</dt><dd>{drawer.material_name || '—'}</dd>
                <dt>仓库数</dt><dd>{drawer.warehouses.length} 个</dd>
                <dt>在库合计</dt><dd>{numFmt(drawerTotal)} 件</dd>
              </dl>
            </div>
            <div className="d-sec">
              <h4>报废核对建议</h4>
              <dl className="d-kv">
                <dt>在库合计</dt><dd>{numFmt(drawerTotal)} 件</dd>
                <dt>锁定数量</dt>
                <dd>{numFmt(drawerLocked)} 件{drawerLocked === 0 && drawerTotal > 0 ? '（可全量报废）' : ''}</dd>
                <dt>最近出库</dt><dd>{lastOut || '—'}</dd>
                <dt>最近入库</dt><dd>{lastIn || '—'}</dd>
              </dl>
            </div>
          </>
        )}
      </Drawer>
    </div>
  )
}

function maxStr(list: (string | null)[]): string | null {
  const vals = list.filter((v): v is string => !!v)
  if (!vals.length) return null
  return vals.reduce((a, b) => (a > b ? a : b))
}
