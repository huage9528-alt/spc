import { useCallback, useState } from 'react'
import {
  Button, Empty, Input, message, Segmented, Select, Steps, Table, Tooltip, Upload,
  type TableColumnsType,
} from 'antd'
import {
  DownloadOutlined, InboxOutlined, ReloadOutlined, SearchOutlined,
  ShoppingCartOutlined, WarningOutlined,
} from '@ant-design/icons'
import { Link, useNavigate } from 'react-router-dom'
import api from '../../services/api'

interface MatchedSupplier {
  input_name: string
  supplier_id: number
  supplier_name: string
  supplier_code?: string
  supplier_short?: string
  erp_supply_id?: number | null
  ambiguous: boolean
}

interface MaterialRow {
  erp_material_id: number
  material_code: string
  material_name: string
  spec_model?: string
  material_type?: string
  brand?: string
  material_property?: number
  order_unit_price?: number
  data_source?: string
  supplier_name?: string
  supplier_code?: string
}

interface MatchRow extends MatchedSupplier {
  miss?: boolean
  missIdx?: number
}

interface RemoteOption {
  label: string
  value: number
  row: MatchedSupplier
}

const PROP_LABEL: Record<number, string> = { 1: '外购', 2: '自制', 3: '委外', 5: '虚拟件', 9: '组装件' }
const SOURCE_LABEL: Record<string, string> = { erp: 'ERP', manual: '手工', excel: 'Excel' }
const PROP_META: Record<number, [string, string]> = {
  1: ['#0284c7', '#f0f9ff'],
  2: ['#16a34a', '#f0fdf4'],
  3: ['#d97706', '#fffbeb'],
}
const SOURCE_META: Record<string, [string, string]> = {
  erp: ['#0284c7', '#f0f9ff'],
  manual: ['#64748b', '#f1f5f9'],
  excel: ['#d97706', '#fffbeb'],
}

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const renderErpId = (v?: number | null) =>
  v != null ? (
    <span className="sc-mono" style={{ fontWeight: 600 }}>{v}</span>
  ) : (
    <span style={{ fontSize: 10.5, fontWeight: 600, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 999, padding: '0 7px', lineHeight: '16px', whiteSpace: 'nowrap' }}>无 ERP ID</span>
  )

const renderProp = (v?: number) => {
  if (v == null) return <span className="sc-note">—</span>
  const label = PROP_LABEL[v] ?? String(v)
  const [c, bg] = PROP_META[v] ?? ['#4c4dc2', '#eef0fe']
  return <span className="sc-tag" style={{ color: c, background: bg }}>{label}</span>
}

const renderSource = (v?: string) => {
  if (!v) return <span className="sc-note">—</span>
  const label = SOURCE_LABEL[v] ?? v
  const [c, bg] = SOURCE_META[v] ?? ['#475569', '#f8fafc']
  return <span className="sc-tag" style={{ color: c, background: bg }}>{label}</span>
}

export default function SupplierMaterialMap() {
  const navigate = useNavigate()
  const [nameText, setNameText] = useState('')
  const [inputMode, setInputMode] = useState<'paste' | 'file'>('paste')
  const [matching, setMatching] = useState(false)
  const [matched, setMatched] = useState<MatchedSupplier[]>([])
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [unmatched, setUnmatched] = useState<string[]>([])
  const [totalNames, setTotalNames] = useState(0)
  const [resolvedNames, setResolvedNames] = useState<string[]>([])
  const [remoteOptions, setRemoteOptions] = useState<Record<string, RemoteOption[]>>({})
  const [queried, setQueried] = useState(false)
  const [loadingMaterials, setLoadingMaterials] = useState(false)
  const [materials, setMaterials] = useState<MaterialRow[]>([])
  const [supplierFilter, setSupplierFilter] = useState<number | null>(null)
  const [matSearch, setMatSearch] = useState('')
  const [priceFilter, setPriceFilter] = useState<'all' | 'priced' | 'unpriced'>('all')

  const handleMatch = useCallback(async () => {
    const names = nameText.split('\n').map(s => s.trim()).filter(Boolean)
    if (!names.length) { message.warning('请先粘贴供应商名单（每行一家）'); return }
    setMatching(true)
    try {
      const res: any = await api.post('/basicdata/suppliers/match', { names })
      const m: MatchedSupplier[] = res.data?.matched || []
      setMatched(m)
      setSelectedIds(m.filter(s => !s.ambiguous).map(s => s.supplier_id))
      setUnmatched(res.data?.unmatched || [])
      setTotalNames(names.length)
      setResolvedNames([])
      setRemoteOptions({})
      setQueried(false)
      setMaterials([])
      setSupplierFilter(null)
      setMatSearch('')
      setPriceFilter('all')
      if (!m.length) message.warning('名单中未匹配到任何供应商')
    } catch { /* 拦截器已提示 */ } finally { setMatching(false) }
  }, [nameText])

  const searchSupplierFor = useCallback(async (key: string, kw: string) => {
    if (!kw.trim()) return
    try {
      const res: any = await api.get('/basicdata/suppliers', { params: { page: 1, page_size: 20, keyword: kw.trim() } })
      const opts: RemoteOption[] = (res.data?.items || []).map((s: any) => ({
        label: `${s.supplier_name}（${s.supplier_code}）`,
        value: s.id,
        row: {
          input_name: '手动补选',
          supplier_id: s.id,
          supplier_name: s.supplier_name,
          supplier_code: s.supplier_code,
          supplier_short: s.supplier_short,
          erp_supply_id: s.erp_supply_id,
          ambiguous: false,
        } as MatchedSupplier,
      }))
      setRemoteOptions(prev => ({ ...prev, [key]: opts }))
    } catch { /* 拦截器已提示 */ }
  }, [])

  const clearRemoteOptions = (key: string) => {
    setRemoteOptions(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  const attachSupplier = useCallback((row: MatchedSupplier, fromName?: string) => {
    setMatched(prev => prev.some(x => x.supplier_id === row.supplier_id) ? prev : [...prev, row])
    setSelectedIds(ids => ids.includes(row.supplier_id) ? ids : [...ids, row.supplier_id])
    if (fromName) setResolvedNames(prev => prev.includes(fromName) ? prev : [...prev, fromName])
  }, [])

  const repickRow = useCallback((row: MatchedSupplier, next: MatchedSupplier) => {
    const nextMatched = matched
      .filter(x => x === row || x.supplier_id !== next.supplier_id)
      .map(x => (x === row ? next : x))
    setMatched(nextMatched)
    setSelectedIds(prev => {
      const remaining = new Set(nextMatched.map(m => m.supplier_id))
      const ids = prev.filter(id => remaining.has(id))
      return ids.includes(next.supplier_id) ? ids : [...ids, next.supplier_id]
    })
  }, [matched])

  const handleQueryMaterials = useCallback(async () => {
    const ids = matched.filter(s => selectedIds.includes(s.supplier_id) && s.erp_supply_id != null)
      .map(s => s.erp_supply_id as number)
    if (!ids.length) { message.warning('请至少勾选一家有 ERP ID 的供应商'); return }
    setLoadingMaterials(true)
    try {
      const res: any = await api.get('/basicdata/materials/by-suppliers', {
        params: { erp_supply_ids: ids.join(',') },
      })
      setMaterials(res.data?.items || [])
      setSupplierFilter(null)
      setMatSearch('')
      setPriceFilter('all')
      setQueried(true)
      const msg: string | undefined = res.message
      if (msg && msg !== 'success') message.warning(msg)
      const total = res.data?.total || 0
      if (!total) message.info('所选供应商名下暂无物料（物料主数据可能未维护供应商归属）')
    } catch { /* 拦截器已提示 */ } finally { setLoadingMaterials(false) }
  }, [matched, selectedIds])

  const exportCsv = useCallback(() => {
    const rows = materials
    if (!rows.length) { message.warning('没有可导出的数据'); return }
    const header = ['供应商编码', '供应商名称', '物料编码', '物料名称', '规格型号', '物料分类', '牌号', '物料属性', '单价', '数据来源']
    const lines = [header.join(',')]
    for (const m of rows) {
      lines.push([
        m.supplier_code, m.supplier_name, m.material_code, m.material_name,
        m.spec_model ?? '', m.material_type ?? '', m.brand ?? '',
        m.material_property != null ? (PROP_LABEL[m.material_property] ?? String(m.material_property)) : '',
        m.order_unit_price ?? '',
        m.data_source ? (SOURCE_LABEL[m.data_source] ?? m.data_source) : '',
      ].map(csvEscape).join(','))
    }
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `供应商物料对照_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [materials])

  const handleReset = useCallback(() => {
    setNameText('')
    setInputMode('paste')
    setMatched([])
    setSelectedIds([])
    setUnmatched([])
    setTotalNames(0)
    setResolvedNames([])
    setRemoteOptions({})
    setQueried(false)
    setMaterials([])
    setSupplierFilter(null)
    setMatSearch('')
    setPriceFilter('all')
  }, [])

  const namesCount = nameText.split('\n').map(s => s.trim()).filter(Boolean).length
  const unresolved = unmatched.filter(n => !resolvedNames.includes(n))
  const hitCount = matched.filter(m => !m.ambiguous).length
  const ambCount = matched.filter(m => m.ambiguous).length
  const matchDone = matched.length > 0 || unresolved.length > 0
  const confirmedRows = matched.filter(s => selectedIds.includes(s.supplier_id))
  const noErpConfirmed = confirmedRows.filter(s => s.erp_supply_id == null)
  const canQuery = matched.some(s => selectedIds.includes(s.supplier_id) && s.erp_supply_id != null)
  const stepCurrent = queried ? 2 : matchDone ? 1 : 0

  const countBySupplierCode = new Map<string, number>()
  for (const m of materials) {
    const k = m.supplier_code ?? ''
    countBySupplierCode.set(k, (countBySupplierCode.get(k) ?? 0) + 1)
  }
  const selectedRow = supplierFilter != null ? matched.find(s => s.supplier_id === supplierFilter) : undefined
  const baseMaterials = selectedRow
    ? materials.filter(m => m.supplier_code === selectedRow.supplier_code)
    : materials
  const kw = matSearch.trim().toLowerCase()
  const searchedMaterials = baseMaterials.filter(m =>
    !kw || [m.material_code, m.material_name, m.spec_model].some(v => v != null && String(v).toLowerCase().includes(kw)))
  const visibleMaterials = searchedMaterials.filter(m =>
    priceFilter === 'priced' ? m.order_unit_price != null
      : priceFilter === 'unpriced' ? m.order_unit_price == null
        : true)
  const pricedCount = baseMaterials.filter(m => m.order_unit_price != null).length

  const matchRows: MatchRow[] = [
    ...matched.map(m => ({ ...m })),
    ...unresolved.map((n, i) => ({
      input_name: n, supplier_id: -1, supplier_name: '', ambiguous: false, miss: true, missIdx: i,
    })),
  ]

  const renderMatchResult = (r: MatchRow) => {
    if (r.miss) {
      const key = `x-${r.missIdx}`
      return (
        <Select
          size="small"
          showSearch
          placeholder="手动补选：输入名称 / 编码搜索…"
          style={{ width: 260 }}
          filterOption={false}
          value={undefined}
          onSearch={v => searchSupplierFor(key, v)}
          options={remoteOptions[key] ?? []}
          onSelect={(_, opt) => {
            if (opt?.row) {
              attachSupplier({ ...opt.row, input_name: r.input_name }, r.input_name)
              clearRemoteOptions(key)
            }
          }}
        />
      )
    }
    if (r.ambiguous) {
      const key = `amb-${r.supplier_id}`
      const current: RemoteOption = {
        label: `${r.supplier_name}${r.supplier_code ? `（${r.supplier_code}）` : ''}`,
        value: r.supplier_id,
        row: r,
      }
      return (
        <Select
          size="small"
          showSearch
          style={{ width: 260 }}
          filterOption={false}
          value={r.supplier_id}
          options={[current, ...(remoteOptions[key] ?? []).filter(o => o.value !== r.supplier_id)]}
          onSearch={v => searchSupplierFor(key, v)}
          onSelect={(_, opt) => {
            if (opt?.row && opt.value !== r.supplier_id) {
              repickRow(r, { ...opt.row, input_name: r.input_name })
              clearRemoteOptions(key)
            }
          }}
        />
      )
    }
    return <span style={{ fontWeight: 600 }}>{r.supplier_name}</span>
  }

  const renderStatus = (r: MatchRow) => {
    if (r.miss) return <span className="sc-tag" style={{ color: '#dc2626', background: '#fef2f2' }}>✕ 未命中 · 可手动补选</span>
    if (r.ambiguous) {
      return (
        <Tooltip title="该名称模糊命中多家，请确认勾选">
          <span className="sc-tag sc-tag-warn" style={{ border: '1px solid #fde68a' }}>⚠ 多义 · 可重选</span>
        </Tooltip>
      )
    }
    return <span className="sc-tag sc-tag-done"><span className="dot" />命中</span>
  }

  const matchColumns: TableColumnsType<MatchRow> = [
    {
      title: '名单名称（原始输入）',
      dataIndex: 'input_name',
      ellipsis: true,
      render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
    },
    { title: '匹配结果', key: 'result', render: (_, r) => renderMatchResult(r) },
    {
      title: '供应商编码',
      dataIndex: 'supplier_code',
      width: 120,
      className: 'sc-mono',
      render: (v?: string) => v || <span className="sc-note">—</span>,
    },
    { title: 'ERP 供应商 ID', dataIndex: 'erp_supply_id', width: 130, render: (v?: number | null) => renderErpId(v) },
    { title: '状态', key: 'status', width: 175, render: (_, r) => renderStatus(r) },
  ]

  const materialColumns: TableColumnsType<MaterialRow> = [
    {
      title: '供应商',
      dataIndex: 'supplier_name',
      width: 180,
      ellipsis: true,
      render: (v?: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
    },
    {
      title: '物料',
      dataIndex: 'material_name',
      ellipsis: true,
      render: (v: string, r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{v}</div>
          <div className="sc-mono" style={{ fontSize: 11, color: '#94a3b8' }}>{r.material_code}</div>
        </div>
      ),
    },
    { title: '规格型号', dataIndex: 'spec_model', width: 150, ellipsis: true, render: (v?: string) => v || <span className="sc-note">—</span> },
    { title: '分类', dataIndex: 'material_type', width: 100, ellipsis: true, render: (v?: string) => v || <span className="sc-note">—</span> },
    { title: '属性', dataIndex: 'material_property', width: 90, render: (v?: number) => renderProp(v) },
    {
      title: '单价',
      dataIndex: 'order_unit_price',
      width: 110,
      align: 'right',
      render: (v?: number) => v != null
        ? <span className="sc-mono" style={{ fontWeight: 600 }}>¥{v}</span>
        : <span className="sc-mono sc-note">—</span>,
    },
    { title: '来源', dataIndex: 'data_source', width: 80, render: (v?: string) => renderSource(v) },
  ]

  const renderSupItem = (
    key: string, name: string, sub: string, count: number,
    active: boolean, danger: boolean, onClick: () => void, tip?: string,
  ) => {
    const pill = (
      <span style={{
        marginLeft: 'auto', flexShrink: 0, fontSize: 10.5, padding: '0 7px', lineHeight: '17px',
        borderRadius: 999, fontVariantNumeric: 'tabular-nums', fontWeight: 600,
        background: danger ? '#fef2f2' : active ? '#e2e4fb' : '#f1f5f9',
        color: danger ? '#dc2626' : active ? '#4c4dc2' : '#64748b',
      }}>{count}</span>
    )
    return (
      <div
        key={key}
        onClick={onClick}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
          borderRadius: 8, cursor: 'pointer', fontSize: 13,
          background: active ? '#eef0fe' : undefined,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{
            color: danger ? '#94a3b8' : active ? '#4c4dc2' : '#0f172a',
            fontWeight: active ? 600 : 400,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{name}</div>
          <div style={{
            fontSize: 11, color: '#94a3b8', fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{sub}</div>
        </div>
        {tip ? <Tooltip title={tip}>{pill}</Tooltip> : pill}
      </div>
    )
  }

  return (
    <div className="sc-page">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>供应商物料对照</h1>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>
            粘贴供应商名单 → 模糊匹配系统供应商 → 反查名下物料并导出对照表（一次性核对工具）
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
          <Button icon={<ShoppingCartOutlined />} onClick={() => navigate('/basicdata/suppliers')}>维护供应商档案</Button>
        </div>
      </div>

      <div className="sc-card" style={{ padding: '14px 20px', marginBottom: 12 }}>
        <Steps
          size="small"
          current={stepCurrent}
          items={[
            { title: '① 输入供应商名单', description: namesCount ? `${namesCount} 行 · 已载入` : '待粘贴或上传' },
            { title: '② 匹配确认', description: matchDone ? `命中 ${hitCount} · 多义 ${ambCount} · 未命中 ${unresolved.length}` : '执行①后确认' },
            { title: '③ 物料明细与导出', description: queried ? `${confirmedRows.length} 家供应商 · ${materials.length} 种物料` : '②确认后查询导出' },
          ]}
        />
      </div>

      <div className="sc-card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #f1f5f9' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>输入供应商名单</h3>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>每行一家供应商名称（支持简称 / 别名模糊匹配）</span>
          <Segmented
            style={{ marginLeft: 'auto' }}
            value={inputMode}
            onChange={v => setInputMode(v as 'paste' | 'file')}
            options={[{ label: '粘贴文本', value: 'paste' }, { label: '上传文件', value: 'file' }]}
          />
        </div>
        <div style={{ padding: 16 }}>
          {inputMode === 'paste' ? (
            <Input.TextArea
              rows={6}
              placeholder="粘贴供应商名单，每行一家供应商名称（支持全角/半角括号混用）"
              value={nameText}
              onChange={e => setNameText(e.target.value)}
            />
          ) : (
            <Upload.Dragger
              accept=".csv,.txt"
              maxCount={1}
              showUploadList={false}
              beforeUpload={(file) => {
                if (/\.xlsx?$/i.test(file.name)) {
                  message.error('请上传 .csv / .txt 文本文件（xlsx 解析组件未接入）')
                  return Upload.LIST_IGNORE
                }
                const reader = new FileReader()
                reader.onload = () => {
                  const text = String(reader.result ?? '')
                  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
                  if (!lines.length) { message.warning('文件中未解析到任何供应商名称'); return }
                  setNameText(lines.join('\n'))
                  message.success(`已载入 ${lines.length} 行供应商名单`)
                }
                reader.readAsText(file)
                return false
              }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">点击选择或拖拽文件到此处</p>
              <p className="ant-upload-hint">支持 .csv / .txt · 每行一家供应商名称</p>
            </Upload.Dragger>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <Button type="primary" icon={<SearchOutlined />} loading={matching} onClick={handleMatch}>
              匹配供应商
            </Button>
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>匹配按名称模糊进行；结果在下方②确认后进入③</span>
          </div>
        </div>
      </div>

      {matchDone && (
        <div className="sc-card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', padding: '12px 16px 0', fontSize: 13, flexWrap: 'wrap' }}>
            <span style={{ color: '#16a34a' }}>✓ 命中 <b>{hitCount}</b></span>
            <span style={{ color: '#d97706' }}>⚠ 多义待确认 <b>{ambCount}</b></span>
            <span style={{ color: '#dc2626' }}>✕ 未命中 <b>{unresolved.length}</b></span>
            <span style={{ color: '#94a3b8' }}>名单共 {totalNames} 行</span>
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#94a3b8' }}>多义 / 未命中行可在匹配结果中重选 / 补选</span>
          </div>
          <div style={{ padding: '10px 0 0' }}>
            <Table<MatchRow>
              rowKey={r => (r.miss ? `x-${r.missIdx}` : r.supplier_id)}
              size="small"
              pagination={false}
              dataSource={matchRows}
              scroll={{ x: 880 }}
              rowSelection={{
                selectedRowKeys: selectedIds,
                onChange: keys => setSelectedIds(keys.filter((k): k is number => typeof k === 'number')),
                getCheckboxProps: r => ({ disabled: !!r.miss }),
              }}
              columns={matchColumns}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: '1px solid #f1f5f9' }}>
            <Button
              type="primary"
              loading={loadingMaterials}
              disabled={!canQuery}
              onClick={handleQueryMaterials}
            >
              查询物料
            </Button>
            <span style={{ fontSize: 11.5, color: '#94a3b8' }}>仅勾选且具备 ERP 供应商 ID 的供应商参与查询</span>
          </div>
        </div>
      )}

      {queried && (
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 12, alignItems: 'start' }}>
          <div className="sc-card" style={{ padding: 8 }}>
            <div style={{ padding: '6px 10px 2px', fontSize: 12, color: '#94a3b8', fontWeight: 600, letterSpacing: '.05em' }}>
              已确认供应商（{confirmedRows.length}）
            </div>
            {renderSupItem(
              'all', '全部供应商',
              confirmedRows.map(s => s.supplier_code).filter(Boolean).join(' / ') || '—',
              materials.length,
              supplierFilter == null,
              false,
              () => setSupplierFilter(null),
            )}
            {confirmedRows.map(s => renderSupItem(
              `s-${s.supplier_id}`,
              s.supplier_name,
              `${s.supplier_code ?? '—'} · ${s.erp_supply_id != null ? `ERP ${s.erp_supply_id}` : '无 ERP ID'}`,
              s.supplier_code != null ? countBySupplierCode.get(s.supplier_code) ?? 0 : 0,
              supplierFilter === s.supplier_id,
              s.erp_supply_id == null,
              () => setSupplierFilter(prev => prev === s.supplier_id ? null : s.supplier_id),
              '物料主数据未维护供应商归属属正常情况',
            ))}
          </div>

          <div className="sc-card" style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid #f1f5f9', flexWrap: 'wrap' }}>
              <Input
                allowClear
                prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
                placeholder="物料编码 / 名称 / 规格"
                style={{ width: 220 }}
                value={matSearch}
                onChange={e => setMatSearch(e.target.value)}
              />
              <Segmented
                value={priceFilter}
                onChange={v => setPriceFilter(v as 'all' | 'priced' | 'unpriced')}
                options={[
                  { label: `全部 ${baseMaterials.length}`, value: 'all' },
                  { label: `有单价 ${pricedCount}`, value: 'priced' },
                  { label: `缺单价 ${baseMaterials.length - pricedCount}`, value: 'unpriced' },
                ]}
              />
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                <Button loading={loadingMaterials} onClick={handleQueryMaterials}>重新查询</Button>
                <Button type="primary" icon={<DownloadOutlined />} disabled={!materials.length} onClick={exportCsv}>
                  导出对照 CSV
                </Button>
              </div>
            </div>

            {noErpConfirmed.length > 0 && (
              <div style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8,
                padding: '10px 14px', fontSize: 12, color: '#92400e', lineHeight: 1.7, margin: '12px 16px',
              }}>
                <WarningOutlined style={{ fontSize: 14, marginTop: 3, flexShrink: 0 }} />
                <span>
                  「{noErpConfirmed.map(s => s.supplier_name).join('、')}」无 ERP 供应商 ID，名下物料无法关联导出 —— 请到{' '}
                  <Link to="/basicdata/suppliers" style={{ fontWeight: 600 }}>供应商档案</Link>{' '}
                  补全 ERP ID 后重试；其名单 0 条物料可能因<b>物料主数据未维护供应商归属</b>。
                </span>
              </div>
            )}

            <div style={{ padding: '0 0 4px' }}>
              <Table<MaterialRow>
                rowKey={r => `${r.erp_material_id}-${r.supplier_code}`}
                size="small"
                dataSource={visibleMaterials}
                loading={loadingMaterials}
                columns={materialColumns}
                scroll={{ x: 900 }}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选供应商名下暂无物料" /> }}
                pagination={{ pageSize: 20, showSizeChanger: false, showTotal: t => `共 ${t} 条` }}
                summary={pageRows => {
                  const sum = pageRows.reduce((a, m) => a + (m.order_unit_price ?? 0), 0)
                  return (
                    <Table.Summary.Row>
                      <Table.Summary.Cell index={0} colSpan={2}>
                        <span style={{ fontSize: 12 }}>
                          {confirmedRows.length} 家供应商 · 共 {visibleMaterials.length} 种物料 · 本页 {pageRows.length}
                        </span>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={2} colSpan={3} />
                      <Table.Summary.Cell index={5} align="right">
                        <span style={{ fontSize: 12 }}>本页合计 ¥{sum.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </Table.Summary.Cell>
                      <Table.Summary.Cell index={6} />
                    </Table.Summary.Row>
                  )
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
