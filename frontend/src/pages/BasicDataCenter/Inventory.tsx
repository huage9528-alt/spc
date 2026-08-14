import { useState, useCallback, useEffect } from 'react'
import { Table, Button, Input, message, Space, Row, Col, Tabs, Tag, Tooltip, Popover, Checkbox } from 'antd'
import {
  ReloadOutlined, SearchOutlined, SettingOutlined, HolderOutlined,
  DatabaseOutlined, AuditOutlined, InboxOutlined, LockOutlined,
  FileDoneOutlined, CarOutlined, WalletOutlined,
} from '@ant-design/icons'
import api from '../../services/api'
import { useAuthStore } from '../../store/auth'

interface InventoryItem {
  id: number
  material_id: number
  material_code: string
  material_name: string
  wh_id: number
  wh_code: string
  wh_name: string
  location_id: number | null
  location_name: string
  qty_on_hand: number
  locked_qty: number
  balance_qty: number
  qty_in_transit: number
  unit_price: number
  ending_balance: number
  batch_no: string
  created_at: string
  updated_at: string
  recent_checked?: boolean
  recent_checked_date?: string | null
  recent_checked_check_no?: string | null
}

interface InventoryByWhItem {
  material_id: number
  material_code: string
  material_name: string
  wh_id: number
  wh_code: string
  wh_name: string
  qty_on_hand: number
  locked_qty: number
  balance_qty: number
  qty_in_transit: number
  unit_price: number
  ending_balance: number
  location_count: number
  recent_checked?: boolean
  recent_checked_date?: string | null
  recent_checked_check_no?: string | null
}

const numFmt = (v: number | null | undefined) => (v != null ? v.toLocaleString() : '-')
const priceFmt = (v: number | null | undefined) =>
  v != null ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '-'
const moneyFmt = (v: number | null | undefined) =>
  v != null ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'
const optList = (arr?: string[]) => (arr || []).map(v => ({ text: v, value: v }))

function ColumnSettings({
  columns, config, onChange,
}: {
  columns: { key: string; title: string }[]
  config: { order: string[]; hidden: Record<string, boolean> }
  onChange: (config: { order: string[]; hidden: Record<string, boolean> }) => void
}) {
  const allKeys = columns.map(c => c.key)
  const titleMap: Record<string, string> = {}
  columns.forEach(c => { titleMap[c.key] = c.title })
  const order = [...config.order, ...allKeys.filter(k => !config.order.includes(k))]
  const hiddenCount = order.filter(k => config.hidden[k] === true).length
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const move = (from: number, to: number) => {
    const next = [...order]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onChange({ ...config, order: next })
  }

  const toggle = (key: string, checked: boolean) => {
    onChange({ ...config, hidden: { ...config.hidden, [key]: !checked } })
  }

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      content={
        <div style={{ width: 260 }}>
          <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>拖动图标调整顺序</span>
            <Space>
              <Button size="small" onClick={() => onChange({ ...config, hidden: {} })}>全选</Button>
              <Button size="small" onClick={() => onChange({ order: allKeys, hidden: {} })}>重置</Button>
            </Space>
          </div>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            {order.map((key, i) => {
              const isOver = overIdx === i && dragIdx !== null && dragIdx !== i
              return (
                <div
                  key={key}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => { e.preventDefault(); if (overIdx !== i) setOverIdx(i) }}
                  onDragLeave={() => { if (overIdx === i) setOverIdx(null) }}
                  onDrop={() => {
                    if (dragIdx !== null && dragIdx !== i) move(dragIdx, i)
                    setDragIdx(null); setOverIdx(null)
                  }}
                  onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                    borderRadius: 6, cursor: 'grab',
                    background: isOver ? '#e6f4ff' : undefined,
                    border: isOver ? '1px dashed #1677ff' : '1px solid transparent',
                  }}
                >
                  <HolderOutlined style={{ color: '#94a3b8', cursor: 'grab' }} />
                  <Checkbox checked={config.hidden[key] !== true} onChange={(e) => toggle(key, e.target.checked)} style={{ flex: 1 }}>
                    {titleMap[key]}
                  </Checkbox>
                </div>
              )
            })}
          </div>
        </div>
      }
    >
      <Button icon={<SettingOutlined />}>列设置{hiddenCount ? `（${hiddenCount}）` : ''}</Button>
    </Popover>
  )
}

function StatSummary({
  totals, stats,
}: {
  totals: { onHand: number; locked: number; balance: number; inTransit: number; endingBalance: number }
  stats: { totalMaterials: number; countedMaterials: number }
}) {
  const num2 = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const cards = [
    { icon: <DatabaseOutlined />, color: '#6366f1', title: '总物料数', value: stats.totalMaterials.toLocaleString() },
    { icon: <AuditOutlined />, color: '#16a34a', title: '已盘数', value: stats.countedMaterials.toLocaleString() },
    { icon: <InboxOutlined />, color: '#f59e0b', title: '库存量合计', value: num2(totals.onHand) },
    { icon: <LockOutlined />, color: '#ef4444', title: '锁定数量合计', value: num2(totals.locked) },
    { icon: <FileDoneOutlined />, color: '#0ea5e9', title: '结存数量合计', value: num2(totals.balance) },
    { icon: <CarOutlined />, color: '#8b5cf6', title: '在途库存合计', value: num2(totals.inTransit) },
    { icon: <WalletOutlined />, color: '#10b981', title: '期末余额合计', value: num2(totals.endingBalance) },
  ]
  return (
    <Row gutter={[12, 8]} style={{ marginTop: 12 }}>
      {cards.map((c, i) => (
        <Col key={i}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 14px', background: `${c.color}10`, borderRadius: 8, border: `1px solid ${c.color}22`,
          }}>
            <div style={{
              width: 34, height: 34, borderRadius: 8, background: `${c.color}18`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, color: c.color,
            }}>{c.icon}</div>
            <div>
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: '16px' }}>{c.title}</div>
              <div style={{ fontSize: 'calc(1rem * var(--font-size-scale))', fontWeight: 700, color: '#1e293b', lineHeight: '22px' }}>{c.value}</div>
            </div>
          </div>
        </Col>
      ))}
    </Row>
  )
}

function SearchBar({
  keyword, setKeyword, onRefresh, onSearch, placeholder, extra,
}: {
  keyword: string
  setKeyword: (v: string) => void
  onRefresh: () => void
  onSearch: () => void
  placeholder: string
  extra?: React.ReactNode
}) {
  return (
    <Row gutter={[12, 12]} align="middle">
      <Col>
        <Input
          placeholder={placeholder}
          prefix={<SearchOutlined />}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={onSearch}
          style={{ width: 240 }}
          allowClear
        />
      </Col>
      <Col flex="auto" />
      <Col>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={onRefresh}>刷新</Button>
          {extra}
        </Space>
      </Col>
    </Row>
  )
}

/** 库存明细：物料 x 仓库 x 库位 */
function InventoryDetail() {
  const [data, setData] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [totals, setTotals] = useState({ onHand: 0, locked: 0, balance: 0, inTransit: 0, endingBalance: 0 })
  const [stats, setStats] = useState({ totalMaterials: 0, countedMaterials: 0 })
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [sortInfo, setSortInfo] = useState<{ sort_by?: string; sort_order?: string }>({})
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [colConfig, setColConfig] = useState<{ order: string[]; hidden: Record<string, boolean> }>(() => {
    try {
      const legacy = localStorage.getItem('inv_detail_col_keys')
      if (legacy) {
        localStorage.removeItem('inv_detail_col_keys')
        const legacyObj = JSON.parse(legacy)
        const hidden: Record<string, boolean> = {}
        Object.keys(legacyObj).forEach(k => { if (legacyObj[k] === false) hidden[k] = true })
        return { order: [], hidden }
      }
      const saved = JSON.parse(localStorage.getItem('inv_detail_cols') || '{}')
      if (saved && Array.isArray(saved.order) && saved.hidden && typeof saved.hidden === 'object') {
        return { order: saved.order, hidden: saved.hidden }
      }
    } catch { /* ignore */ }
    return { order: [], hidden: {} }
  })

  const fetchData = useCallback(async (
    page = 1,
    pageSize = 20,
    override?: { sort?: { sort_by?: string; sort_order?: string }; filters?: Record<string, string[]> },
  ) => {
    setLoading(true)
    try {
      const s = override?.sort ?? sortInfo
      const f = override?.filters ?? filters
      const params: any = { page, page_size: pageSize }
      if (keyword) params.keyword = keyword
      if (s.sort_by) params.sort_by = s.sort_by
      if (s.sort_order) params.sort_order = s.sort_order
      if (f.material_code?.length) params.material_code = f.material_code.join(',')
      if (f.wh_code?.length) params.wh_code = f.wh_code.join(',')
      if (f.wh_name?.length) params.wh_name = f.wh_name.join(',')
      if (f.batch_no?.length) params.batch_no = f.batch_no.join(',')
      if (f.recent_checked?.length === 1) params.recent_checked = f.recent_checked[0]
      const res: any = await api.get('/basicdata/inventory', { params })
      const items = res.data?.items || []
      setData(items)
      setPagination({
        current: res.data?.page || 1,
        pageSize: res.data?.page_size || 20,
        total: res.data?.total || 0,
      })

      const sums = res.data?.sums || {}
      setTotals({
        onHand: sums.qty_on_hand ?? 0,
        locked: sums.locked_qty ?? 0,
        balance: sums.balance_qty ?? 0,
        inTransit: sums.qty_in_transit ?? 0,
        endingBalance: sums.ending_balance ?? 0,
      })

      const s2 = res.data?.stats || {}
      setStats({
        totalMaterials: s2.total_materials ?? 0,
        countedMaterials: s2.counted_materials ?? 0,
      })
    } catch (error) {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [keyword, sortInfo, filters]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchData(1, pagination.pageSize)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/basicdata/inventory/filter-options')
      .then((res: any) => setFilterOptions(res.data || {}))
      .catch(() => {})
  }, [])

  useEffect(() => {
    localStorage.setItem('inv_detail_cols', JSON.stringify(colConfig))
  }, [colConfig])

  const handleTableChange = (_pag: any, tableFilters: any, sorter: any) => {
    const sortField = sorter.field
    const sortOrder = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : undefined
    const newFilters: Record<string, string[]> = {}
    if (tableFilters.material_code?.length) newFilters.material_code = tableFilters.material_code
    if (tableFilters.wh_code?.length) newFilters.wh_code = tableFilters.wh_code
    if (tableFilters.wh_name?.length) newFilters.wh_name = tableFilters.wh_name
    if (tableFilters.batch_no?.length) newFilters.batch_no = tableFilters.batch_no
    if (tableFilters.recent_checked?.length === 1) newFilters.recent_checked = tableFilters.recent_checked
    const sortChanged = sortField !== sortInfo.sort_by || sortOrder !== sortInfo.sort_order
    const filterChanged = JSON.stringify(newFilters) !== JSON.stringify(filters)
    const pageChanged = !!_pag?.current && _pag.current !== pagination.current
    if (!sortChanged && !filterChanged && !pageChanged) return
    const page = (sortChanged || filterChanged) ? 1 : (_pag.current || 1)
    setSortInfo({ sort_by: sortField, sort_order: sortOrder })
    setFilters(newFilters)
    fetchData(page, _pag.pageSize, { sort: { sort_by: sortField, sort_order: sortOrder }, filters: newFilters })
  }

  const allColumns = [
    { title: '物料编码', dataIndex: 'material_code', key: 'material_code', width: 120, sorter: true, filters: optList(filterOptions.material_codes), filterSearch: true },
    { title: '物料名称', dataIndex: 'material_name', key: 'material_name', width: 160, ellipsis: true, sorter: true },
    { title: '仓库编码', dataIndex: 'wh_code', key: 'wh_code', width: 100, sorter: true, filters: optList(filterOptions.wh_codes), filterSearch: true },
    { title: '仓库名称', dataIndex: 'wh_name', key: 'wh_name', width: 120, filters: optList(filterOptions.wh_names), filterSearch: true },
    { title: '库位名称', dataIndex: 'location_name', key: 'location_name', width: 120, ellipsis: true },
    { title: '库存量', dataIndex: 'qty_on_hand', key: 'qty_on_hand', width: 100, align: 'right' as const, sorter: true, render: numFmt },
    { title: '锁定数量', dataIndex: 'locked_qty', key: 'locked_qty', width: 100, align: 'right' as const, sorter: true, render: numFmt },
    { title: '结存数量', dataIndex: 'balance_qty', key: 'balance_qty', width: 100, align: 'right' as const, sorter: true, render: numFmt },
    { title: '在途库存', dataIndex: 'qty_in_transit', key: 'qty_in_transit', width: 100, align: 'right' as const, sorter: true, render: numFmt },
    { title: '库存单价', dataIndex: 'unit_price', key: 'unit_price', width: 110, align: 'right' as const, sorter: true, render: priceFmt },
    { title: '期末余额', dataIndex: 'ending_balance', key: 'ending_balance', width: 120, align: 'right' as const, sorter: true, render: moneyFmt },
    { title: '批次号', dataIndex: 'batch_no', key: 'batch_no', width: 100, sorter: true, filters: optList(filterOptions.batch_nos), filterSearch: true },
    {
      title: '近期已盘', dataIndex: 'recent_checked', key: 'recent_checked', width: 90, align: 'center' as const,
      filters: [{ text: '是', value: 'true' }, { text: '否', value: 'false' }],
      render: (v: boolean, r: InventoryItem) => v ? (
        <Tooltip title={`近期已盘${r.recent_checked_date ? ' · ' + r.recent_checked_date : ''}${r.recent_checked_check_no ? ' · ' + r.recent_checked_check_no : ''}`}>
          <Tag color="green" style={{ marginInlineEnd: 0 }}>是</Tag>
        </Tooltip>
      ) : <span style={{ color: '#94a3b8' }}>否</span>,
    },
    {
      title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 160, sorter: true,
      render: (v: string) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
  ]
  const allKeys = allColumns.map(c => c.key)
  const colOrder = [...colConfig.order, ...allKeys.filter(k => !colConfig.order.includes(k))]
  const columns = colOrder
    .filter(k => !colConfig.hidden[k])
    .map(k => allColumns.find(c => c.key === k)!)
    .filter(Boolean)

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <SearchBar
          keyword={keyword}
          setKeyword={setKeyword}
          onSearch={() => fetchData(1, pagination.pageSize)}
          onRefresh={() => fetchData(pagination.current, pagination.pageSize)}
          placeholder="搜索物料编码/名称/仓库"
          extra={<ColumnSettings columns={allColumns} config={colConfig} onChange={setColConfig} />}
        />
        <StatSummary totals={totals} stats={stats} />
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={data}
          loading={loading}
          scroll={{ x: 1700 }}
          size="small"
          onChange={handleTableChange}
          pagination={{
            ...pagination,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
            pageSizeOptions: ['20', '50', '100'],
          }}
        />
      </div>
    </div>
  )
}

/** 按物料 x 仓库 统计（合并库位维度） */
function InventoryByWarehouse() {
  const [data, setData] = useState<InventoryByWhItem[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [totals, setTotals] = useState({ onHand: 0, locked: 0, balance: 0, inTransit: 0, endingBalance: 0 })
  const [stats, setStats] = useState({ totalMaterials: 0, countedMaterials: 0 })
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [sortInfo, setSortInfo] = useState<{ sort_by?: string; sort_order?: string }>({})
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({})
  const [colConfig, setColConfig] = useState<{ order: string[]; hidden: Record<string, boolean> }>(() => {
    try {
      const legacy = localStorage.getItem('inv_bywh_col_keys')
      if (legacy) {
        localStorage.removeItem('inv_bywh_col_keys')
        const legacyObj = JSON.parse(legacy)
        const hidden: Record<string, boolean> = {}
        Object.keys(legacyObj).forEach(k => { if (legacyObj[k] === false) hidden[k] = true })
        return { order: [], hidden }
      }
      const saved = JSON.parse(localStorage.getItem('inv_bywh_cols') || '{}')
      if (saved && Array.isArray(saved.order) && saved.hidden && typeof saved.hidden === 'object') {
        return { order: saved.order, hidden: saved.hidden }
      }
    } catch { /* ignore */ }
    return { order: [], hidden: {} }
  })

  const fetchData = useCallback(async (
    page = 1,
    pageSize = 20,
    override?: { sort?: { sort_by?: string; sort_order?: string }; filters?: Record<string, string[]> },
  ) => {
    setLoading(true)
    try {
      const s = override?.sort ?? sortInfo
      const f = override?.filters ?? filters
      const params: any = { page, page_size: pageSize }
      if (keyword) params.keyword = keyword
      if (s.sort_by) params.sort_by = s.sort_by
      if (s.sort_order) params.sort_order = s.sort_order
      if (f.material_code?.length) params.material_code = f.material_code.join(',')
      if (f.wh_code?.length) params.wh_code = f.wh_code.join(',')
      if (f.wh_name?.length) params.wh_name = f.wh_name.join(',')
      if (f.recent_checked?.length === 1) params.recent_checked = f.recent_checked[0]
      const res: any = await api.get('/basicdata/inventory/by-warehouse', { params })
      setData(res.data?.items || [])
      setPagination({
        current: res.data?.page || 1,
        pageSize: res.data?.page_size || 20,
        total: res.data?.total || 0,
      })

      const sums = res.data?.sums || {}
      setTotals({
        onHand: sums.qty_on_hand ?? 0,
        locked: sums.locked_qty ?? 0,
        balance: sums.balance_qty ?? 0,
        inTransit: sums.qty_in_transit ?? 0,
        endingBalance: sums.ending_balance ?? 0,
      })

      const s2 = res.data?.stats || {}
      setStats({
        totalMaterials: s2.total_materials ?? 0,
        countedMaterials: s2.counted_materials ?? 0,
      })
    } catch (error) {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [keyword, sortInfo, filters]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchData(1, pagination.pageSize)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/basicdata/inventory/filter-options')
      .then((res: any) => setFilterOptions(res.data || {}))
      .catch(() => {})
  }, [])

  useEffect(() => {
    localStorage.setItem('inv_bywh_cols', JSON.stringify(colConfig))
  }, [colConfig])

  const handleTableChange = (_pag: any, tableFilters: any, sorter: any) => {
    const sortField = sorter.field
    const sortOrder = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : undefined
    const newFilters: Record<string, string[]> = {}
    if (tableFilters.material_code?.length) newFilters.material_code = tableFilters.material_code
    if (tableFilters.wh_code?.length) newFilters.wh_code = tableFilters.wh_code
    if (tableFilters.wh_name?.length) newFilters.wh_name = tableFilters.wh_name
    if (tableFilters.recent_checked?.length === 1) newFilters.recent_checked = tableFilters.recent_checked
    const sortChanged = sortField !== sortInfo.sort_by || sortOrder !== sortInfo.sort_order
    const filterChanged = JSON.stringify(newFilters) !== JSON.stringify(filters)
    const pageChanged = !!_pag?.current && _pag.current !== pagination.current
    if (!sortChanged && !filterChanged && !pageChanged) return
    const page = (sortChanged || filterChanged) ? 1 : (_pag.current || 1)
    setSortInfo({ sort_by: sortField, sort_order: sortOrder })
    setFilters(newFilters)
    fetchData(page, _pag.pageSize, { sort: { sort_by: sortField, sort_order: sortOrder }, filters: newFilters })
  }

  const allColumns = [
    { title: '物料编码', dataIndex: 'material_code', key: 'material_code', width: 120, sorter: true, filters: optList(filterOptions.material_codes), filterSearch: true },
    { title: '物料名称', dataIndex: 'material_name', key: 'material_name', width: 180, ellipsis: true, sorter: true },
    { title: '仓库编码', dataIndex: 'wh_code', key: 'wh_code', width: 100, sorter: true, filters: optList(filterOptions.wh_codes), filterSearch: true },
    { title: '仓库名称', dataIndex: 'wh_name', key: 'wh_name', width: 140, filters: optList(filterOptions.wh_names), filterSearch: true },
    {
      title: '库位数', dataIndex: 'location_count', key: 'location_count', width: 80, align: 'right' as const,
      render: (v: number) => (v != null ? v.toLocaleString() : '-'),
    },
    { title: '库存量', dataIndex: 'qty_on_hand', key: 'qty_on_hand', width: 110, align: 'right' as const, sorter: true, render: numFmt },
    { title: '锁定数量', dataIndex: 'locked_qty', key: 'locked_qty', width: 110, align: 'right' as const, sorter: true, render: numFmt },
    { title: '结存数量', dataIndex: 'balance_qty', key: 'balance_qty', width: 110, align: 'right' as const, sorter: true, render: numFmt },
    { title: '在途库存', dataIndex: 'qty_in_transit', key: 'qty_in_transit', width: 110, align: 'right' as const, sorter: true, render: numFmt },
    { title: '加权单价', dataIndex: 'unit_price', key: 'unit_price', width: 120, align: 'right' as const, render: priceFmt },
    { title: '期末余额', dataIndex: 'ending_balance', key: 'ending_balance', width: 130, align: 'right' as const, sorter: true, render: moneyFmt },
    {
      title: '近期已盘', dataIndex: 'recent_checked', key: 'recent_checked', width: 90, align: 'center' as const,
      filters: [{ text: '是', value: 'true' }, { text: '否', value: 'false' }],
      render: (v: boolean, r: InventoryByWhItem) => v ? (
        <Tooltip title={`近期已盘${r.recent_checked_date ? ' · ' + r.recent_checked_date : ''}${r.recent_checked_check_no ? ' · ' + r.recent_checked_check_no : ''}`}>
          <Tag color="green" style={{ marginInlineEnd: 0 }}>是</Tag>
        </Tooltip>
      ) : <span style={{ color: '#94a3b8' }}>否</span>,
    },
  ]
  const allKeys = allColumns.map(c => c.key)
  const colOrder = [...colConfig.order, ...allKeys.filter(k => !colConfig.order.includes(k))]
  const columns = colOrder
    .filter(k => !colConfig.hidden[k])
    .map(k => allColumns.find(c => c.key === k)!)
    .filter(Boolean)

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <SearchBar
          keyword={keyword}
          setKeyword={setKeyword}
          onSearch={() => fetchData(1, pagination.pageSize)}
          onRefresh={() => fetchData(pagination.current, pagination.pageSize)}
          placeholder="搜索物料编码/名称/仓库"
          extra={<ColumnSettings columns={allColumns} config={colConfig} onChange={setColConfig} />}
        />
        <StatSummary totals={totals} stats={stats} />
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey={(r) => `${r.material_id}-${r.wh_id}`}
          columns={columns}
          dataSource={data}
          loading={loading}
          scroll={{ x: 1300 }}
          size="small"
          onChange={handleTableChange}
          pagination={{
            ...pagination,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
            pageSizeOptions: ['20', '50', '100'],
          }}
        />
      </div>
    </div>
  )
}

export default function Inventory() {
  const [activeKey, setActiveKey] = useState('detail')

  return (
    <Tabs
      activeKey={activeKey}
      onChange={setActiveKey}
      destroyInactiveTabPane
      items={[
        { key: 'detail', label: '库存明细（物料/仓库/库位）', children: <InventoryDetail /> },
        { key: 'by-wh', label: '按物料/仓库统计', children: <InventoryByWarehouse /> },
      ]}
    />
  )
}
