import { useState, useCallback, useEffect, useMemo, type Key } from 'react'
import {
  Table, Button, Modal, Form, Input, Select, InputNumber, message,
  Space, Popconfirm, Row, Col, Drawer,
  Popover, Checkbox, Tooltip, type TableColumnsType,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  QrcodeOutlined, SearchOutlined, ColumnHeightOutlined,
  SettingOutlined, ExportOutlined, ProfileOutlined, ClearOutlined,
} from '@ant-design/icons'
import api from '../../services/api'
import PermButton from '../../components/PermButton'
import { useAuthStore } from '../../store/auth'
import { useExport } from '../../hooks/useExport'
import MaterialQRCodePrintModal, { type LabelMaterial } from './MaterialQRCodePrintModal'

interface Material {
  id: number
  erp_material_id: number
  parent_id?: number | null
  material_code: string
  material_name: string
  spec_model?: string
  material_type: string
  unit_of_measure: string
  brand?: string
  is_purchase: number
  is_produce: number
  status: number
  erp_sync_flag: number
  is_deleted: number
  material_property?: number | null
  data_source?: string | null
  supplier_id?: number | null
  supplier_name?: string | null
  order_unit_price?: number | string | null
  last_outbound_date?: string | null
  create_time?: string | null
  update_time?: string | null
  children?: Material[]
}

interface MaterialStats {
  total: number
  disabled: number
  by_property: Record<string, number>
  types?: string[]
}

interface MaterialRefs {
  skus: Array<{ id: number; sku_code: string; sku_name: string }>
  child_count: number
}

const MATERIAL_PROPERTY_OPTIONS: Array<{ value: number; label: string; tag: string }> = [
  { value: 1, label: '外购', tag: 'sc-tag-kit' },
  { value: 2, label: '自制', tag: 'sc-tag-done' },
  { value: 3, label: '委外加工', tag: 'sc-tag-amber' },
  { value: 5, label: '虚拟件', tag: 'sc-tag-purple' },
  { value: 6, label: '特征类', tag: 'sc-tag-purple' },
  { value: 7, label: '配置类', tag: 'sc-tag-kit' },
  { value: 8, label: '规划类', tag: 'sc-tag-amber' },
  { value: 9, label: '组装件', tag: 'sc-tag-prod' },
]

const MATERIAL_PROPERTY_LABEL: Record<number, string> = MATERIAL_PROPERTY_OPTIONS.reduce(
  (acc, item) => {
    acc[item.value] = item.label
    return acc
  },
  {} as Record<number, string>,
)

const renderMaterialProperty = (v?: number | null) => {
  if (v === undefined || v === null) return <span className="sc-note">—</span>
  const opt = MATERIAL_PROPERTY_OPTIONS.find(o => o.value === v)
  return <span className={`sc-tag ${opt?.tag || 'sc-tag-plain'}`}><span className="dot" />{MATERIAL_PROPERTY_LABEL[v] ?? String(v)}</span>
}

const DATA_SOURCE_META: Record<string, { label: string; tag: string }> = {
  erp: { label: 'ERP', tag: 'sc-tag-kit' },
  manual: { label: '手工', tag: 'sc-tag-wait' },
  excel: { label: 'Excel', tag: 'sc-tag-amber' },
}

const renderDataSource = (v?: string | null) => {
  if (!v) return <span className="sc-note">—</span>
  const meta = DATA_SOURCE_META[v] || { label: v, tag: 'sc-tag-plain' }
  return <span className={`sc-tag ${meta.tag}`}>{meta.label}</span>
}

const renderStatus = (status: number) => (
  <span className={`sc-tag ${status === 1 ? 'sc-tag-done' : 'sc-tag-wait'}`}>
    <span className="dot" />{status === 1 ? '启用' : '停用'}
  </span>
)

const PpBadges = ({ record }: { record: Material }) => (
  <>
    <span className={`sc-pp ${record.is_purchase ? 'buy' : 'off'}`}>采</span>
    <span className={`sc-pp ${record.is_produce ? 'make' : 'off'}`}>产</span>
  </>
)

const formatPrice = (v?: number | string | null) => {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (Number.isNaN(n)) return '—'
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}

// 可隐藏列 key ↔ 标题（物料/状态/操作固定展示）
const OPTIONAL_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'spec_model', label: '规格型号' },
  { key: 'material_type', label: '分类' },
  { key: 'material_property', label: '属性' },
  { key: 'unit_of_measure', label: '单位' },
  { key: 'brand', label: '品牌/厂商' },
  { key: 'pp', label: '采/产' },
  { key: 'data_source', label: '数据来源' },
  { key: 'order_unit_price', label: '单价' },
  { key: 'last_outbound_date', label: '最近出库' },
]

const HIDDEN_COLS_KEY = 'materials.hiddenCols.v1'
const DENSITY_KEY = 'materials.density.v1'

function loadHiddenCols(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_COLS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function loadDensity(): 'small' | 'middle' {
  return localStorage.getItem(DENSITY_KEY) === 'middle' ? 'middle' : 'small'
}

interface MaterialFormProps {
  form: any
  seedParentId?: number | null
  excludeSelfId?: number | null
  isErpLocked: boolean
}

const MaterialForm = ({ form, seedParentId, excludeSelfId, isErpLocked }: MaterialFormProps) => {
  const [parentOptions, setParentOptions] = useState<Array<{ label: string; value: number }>>([])
  const [parentSearching, setParentSearching] = useState(false)

  // 编辑时回填当前上级（不依赖全量树接口）
  useEffect(() => {
    if (!seedParentId) {
      setParentOptions([])
      return
    }
    let alive = true
    api.get(`/basicdata/materials/${seedParentId}`)
      .then((res: any) => {
        const m = res.data
        if (alive && m) setParentOptions([{ label: `${m.material_code} - ${m.material_name}`, value: m.erp_material_id }])
      })
      .catch(() => { /* ignore */ })
    return () => { alive = false }
  }, [seedParentId])

  const handleParentSearch = async (kw: string) => {
    if (!kw.trim()) return
    setParentSearching(true)
    try {
      const res: any = await api.get('/basicdata/materials', {
        params: { page: 1, page_size: 20, keyword: kw.trim() },
      })
      const items: Material[] = (res.data?.items || []).filter((m: Material) => m.erp_material_id !== excludeSelfId)
      setParentOptions(items.map((m) => ({ label: `${m.material_code} - ${m.material_name}`, value: m.erp_material_id })))
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setParentSearching(false)
    }
  }

  return (
    <Form form={form} layout="vertical">
      {isErpLocked && (
        <div className="f-note" style={{ marginBottom: 16 }}>
          该物料由 ERP 同步维护，编码与分类不可在此修改；删除为逻辑删除，可由管理员恢复。
        </div>
      )}
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item name="erp_material_id" label="ERP物料ID" rules={[{ required: true }]}>
            <InputNumber placeholder="如 101002" style={{ width: '100%' }} disabled={isErpLocked} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name="parent_id" label="上级物料">
            <Select
              showSearch
              allowClear
              filterOption={false}
              placeholder="搜索编码 / 名称选择，不选则为顶级物料"
              notFoundContent={parentSearching ? '搜索中…' : undefined}
              onSearch={handleParentSearch}
              options={parentOptions}
            />
          </Form.Item>
        </Col>
      <Col span={12}>
        <Form.Item name="material_code" label="物料编码" rules={[{ required: true }]}>
          <Input placeholder="如 MAT-C1-1002" disabled={isErpLocked} />
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item name="material_name" label="物料名称" rules={[{ required: true }]}>
          <Input placeholder="请输入物料名称" />
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item name="spec_model" label="规格型号">
          <Input placeholder="如 10W / Eff.91%" />
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item name="material_type" label="物料分类" rules={[{ required: true }]}>
          <Input placeholder="如 电子元件" disabled={isErpLocked} />
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item name="material_property" label="物料属性">
          <Select allowClear placeholder="请选择物料属性">
            {MATERIAL_PROPERTY_OPTIONS.map(opt => (
              <Select.Option key={opt.value} value={opt.value}>{opt.label}</Select.Option>
            ))}
          </Select>
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item name="unit_of_measure" label="计量单位" rules={[{ required: true }]}>
          <Input placeholder="如 个" />
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item name="brand" label="品牌/厂商">
          <Input placeholder="选填" />
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item name="order_unit_price" label="订货单价">
          <InputNumber placeholder="0.0000" min={0} precision={4} style={{ width: '100%' }} />
        </Form.Item>
      </Col>
      <Col span={8}>
        <Form.Item name="is_purchase" label="可采购" initialValue={0}>
          <Select><Select.Option value={1}>是</Select.Option><Select.Option value={0}>否</Select.Option></Select>
        </Form.Item>
      </Col>
      <Col span={8}>
        <Form.Item name="is_produce" label="可生产" initialValue={0}>
          <Select><Select.Option value={1}>是</Select.Option><Select.Option value={0}>否</Select.Option></Select>
        </Form.Item>
      </Col>
      <Col span={8}>
        <Form.Item name="status" label="状态" initialValue={1}>
          <Select><Select.Option value={1}>启用</Select.Option><Select.Option value={0}>停用</Select.Option></Select>
        </Form.Item>
      </Col>
    </Row>
    </Form>
  )
}

export default function Materials() {
  const [data, setData] = useState<Material[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  // 跨页勾选快照：antd 翻页后 onChange 只带当前页行，靠 map 保留其它页已勾选的物料
  const [selectedMap, setSelectedMap] = useState<Record<number, Material>>({})
  const [qrMaterials, setQrMaterials] = useState<LabelMaterial[] | null>(null)
  const [editingItem, setEditingItem] = useState<Material | null>(null)
  const [form] = Form.useForm()
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })

  // 筛选状态（属性/停用 chips + 列级筛选 + 排序，均直连后端查询参数）
  const [keyword, setKeyword] = useState('')
  const [searchText, setSearchText] = useState('')
  const [propertyChip, setPropertyChip] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<number[]>([])
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  const [sourceFilter, setSourceFilter] = useState<string[]>([])
  const [sortBy, setSortBy] = useState<string | null>(null)
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')
  const [stats, setStats] = useState<MaterialStats>({ total: 0, disabled: 0, by_property: {} })

  // 表格个性化
  const [hiddenCols, setHiddenCols] = useState<string[]>(loadHiddenCols)
  const [density, setDensity] = useState<'small' | 'middle'>(loadDensity)

  // 详情抽屉
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<Material | null>(null)
  const [drawerRefs, setDrawerRefs] = useState<MaterialRefs | null>(null)
  const [drawerRefsLoading, setDrawerRefsLoading] = useState(false)
  const [drawerPath, setDrawerPath] = useState<Material[]>([])
  const [batchWorking, setBatchWorking] = useState(false)
  const { exporting, exportData } = useExport()

  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data.materials', 'delete')

  const buildParams = useCallback((page: number, pageSize: number) => {
    const p: Record<string, any> = { page, page_size: pageSize }
    if (keyword.trim()) p.keyword = keyword.trim()
    if (propertyChip !== 'all') p.material_property = propertyChip
    if (statusFilter.length) p.status = statusFilter.join(',')
    if (typeFilter.length) p.material_type = typeFilter.join(',')
    if (sourceFilter.length) p.data_source = sourceFilter.join(',')
    if (sortBy) {
      p.sort_by = sortBy
      p.sort_order = sortOrder
    }
    return p
  }, [keyword, propertyChip, statusFilter, typeFilter, sourceFilter, sortBy, sortOrder])

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/materials/stats')
      const d = res.data || {}
      setStats({ total: d.total || 0, disabled: d.disabled || 0, by_property: d.by_property || {}, types: d.types || [] })
    } catch {
      // ignore
    }
  }, [])

  const fetchData = useCallback(async (page = 1, pageSize = 20) => {
    setLoading(true)
    try {
      const res: any = await api.get('/basicdata/materials', { params: buildParams(page, pageSize) })
      setData(res.data?.items || [])
      setPagination({ current: res.data?.page || 1, pageSize: res.data?.page_size || 20, total: res.data?.total || 0 })
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [buildParams])

  // 搜索输入防抖
  useEffect(() => {
    const timer = setTimeout(() => setKeyword(searchText), 350)
    return () => clearTimeout(timer)
  }, [searchText])

  // 筛选/排序变化回到第 1 页
  useEffect(() => {
    fetchData(1, pagination.pageSize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, propertyChip, statusFilter, typeFilter, sourceFilter, sortBy, sortOrder])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  const refreshAll = useCallback(async () => {
    await fetchData(pagination.current, pagination.pageSize)
    await fetchStats()
  }, [fetchData, fetchStats, pagination])

  const clearSelection = () => {
    setSelectedRowKeys([])
    setSelectedMap({})
  }

  const handleAdd = () => {
    setEditingItem(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleBatchQrcode = () => {
    // 用快照 map 取全量勾选（含其它分页），而非仅当前页 data
    const rows = selectedRowKeys
      .map((k) => selectedMap[Number(k)])
      .filter((m): m is Material => m != null)
      .map((m) => ({ material_code: m.material_code, material_name: m.material_name, spec_model: m.spec_model }))
    if (rows.length === 0) return
    setQrMaterials(rows)
  }

  const handleEdit = (item: Material) => {
    setEditingItem(item)
    form.setFieldsValue(item)
    setModalVisible(true)
  }

  const openDrawer = async (item: Material) => {
    setDrawerItem(item)
    setDrawerOpen(true)
    setDrawerRefs(null)
    setDrawerRefsLoading(true)
    try {
      const res: any = await api.get(`/basicdata/materials/${item.erp_material_id}/references`)
      setDrawerRefs({ skus: res.data?.skus || [], child_count: res.data?.child_count || 0 })
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setDrawerRefsLoading(false)
    }
    // 层级路径：沿 parent 链逐级取（不依赖全量树接口），最多回溯 6 层
    setDrawerPath([])
    let pid = item.parent_id ?? null
    const path: Material[] = []
    const guard = new Set<number>()
    while (pid && !guard.has(pid) && path.length < 6) {
      guard.add(pid)
      try {
        const res: any = await api.get(`/basicdata/materials/${pid}`)
        const m: Material = res.data
        if (!m) break
        path.unshift(m)
        pid = m.parent_id ?? null
      } catch {
        break
      }
    }
    setDrawerPath(path)
  }

  const handleDelete = async (materialId: number) => {
    try {
      await api.delete(`/basicdata/materials/${materialId}`)
      message.success('删除成功')
      if (drawerOpen) setDrawerOpen(false)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  // 批量启用/停用：逐条 PUT（MaterialUpdate 支持部分字段）
  const handleBatchStatus = async (status: 0 | 1) => {
    const rows = selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((m): m is Material => m != null)
    const targets = rows.filter((m) => m.status !== status)
    if (targets.length === 0) {
      message.info(rows.length ? `所选物料均已是${status === 1 ? '启用' : '停用'}状态` : '请先勾选物料')
      return
    }
    setBatchWorking(true)
    const results = await Promise.allSettled(
      targets.map((m) => api.put(`/basicdata/materials/${m.erp_material_id}`, { status })),
    )
    setBatchWorking(false)
    const okCount = results.filter((r) => r.status === 'fulfilled').length
    const failCount = results.length - okCount
    if (failCount === 0) message.success(`已${status === 1 ? '启用' : '停用'} ${okCount} 项`)
    else message.warning(`成功 ${okCount} 项，失败 ${failCount} 项`)
    refreshAll()
  }

  const handleBatchDelete = () => {
    const rows = selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((m): m is Material => m != null)
    if (rows.length === 0) return
    Modal.confirm({
      title: `确认删除选中的 ${rows.length} 项物料？`,
      content: '删除为逻辑删除（is_deleted），不影响 ERP 侧数据。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setBatchWorking(true)
        const results = await Promise.allSettled(
          rows.map((m) => api.delete(`/basicdata/materials/${m.erp_material_id}`)),
        )
        setBatchWorking(false)
        const okCount = results.filter((r) => r.status === 'fulfilled').length
        const failCount = results.length - okCount
        if (failCount === 0) message.success(`已删除 ${okCount} 项`)
        else message.warning(`成功 ${okCount} 项，失败 ${failCount} 项`)
        clearSelection()
        refreshAll()
      },
    })
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      if (editingItem) {
        if (values.parent_id === editingItem.erp_material_id) {
          message.error('上级物料不能选择自身')
          return
        }
        await api.put(`/basicdata/materials/${editingItem.erp_material_id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/materials', values)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const handleExport = () => {
    const params = buildParams(1, 20)
    delete params.page
    delete params.page_size
    exportData('/api/v1/basicdata/import-export/materials', params, `materials_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  const toggleHiddenCol = (keys: string[]) => {
    setHiddenCols(keys)
    try {
      localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify(keys))
    } catch {
      // ignore
    }
  }

  const toggleDensity = () => {
    const next = density === 'small' ? 'middle' : 'small'
    setDensity(next)
    try {
      localStorage.setItem(DENSITY_KEY, next)
    } catch {
      // ignore
    }
  }

  // 分类筛选选项来自 stats 的 distinct 分类（不依赖全量树接口）
  const typeOptions = useMemo(
    () => (stats.types || []).map(t => ({ label: t, value: t })),
    [stats.types],
  )

  const chips: Array<{ key: string; label: string; count: number }> = [
    { key: 'all', label: '全部', count: stats.total },
    { key: '1', label: '外购', count: stats.by_property['1'] || 0 },
    { key: '2', label: '自制', count: stats.by_property['2'] || 0 },
    { key: '3', label: '委外加工', count: stats.by_property['3'] || 0 },
    { key: '9', label: '组装件', count: stats.by_property['9'] || 0 },
    { key: '5', label: '虚拟件', count: stats.by_property['5'] || 0 },
    { key: 'disabled', label: '停用', count: stats.disabled },
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[], rows: Material[]) => {
      setSelectedRowKeys(keys)
      const byKey = new Map(rows.map((r) => [r.id as number, r]))
      setSelectedMap((prev) => {
        const next: Record<number, Material> = {}
        for (const k of keys) {
          const m = byKey.get(Number(k)) ?? prev[Number(k)]
          if (m) next[Number(k)] = m
        }
        return next
      })
    },
  }

  // 列 key → 后端 sort_by 映射
  const SORT_KEY_MAP: Record<string, string> = {
    material: 'material_code',
    spec_model: 'spec_model',
    material_type: 'material_type',
    material_property: 'material_property',
    unit_of_measure: 'unit_of_measure',
    brand: 'brand',
    data_source: 'data_source',
    order_unit_price: 'order_unit_price',
    last_outbound_date: 'last_outbound_date',
    status: 'status',
  }

  const handleTableChange = (_pg: any, filters: Record<string, any>, sorter: any) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter
    if (s?.order && SORT_KEY_MAP[s.columnKey]) {
      setSortBy(SORT_KEY_MAP[s.columnKey])
      setSortOrder(s.order === 'ascend' ? 'asc' : 'desc')
    } else {
      setSortBy(null)
    }
    setTypeFilter((filters.material_type as string[]) || [])
    setSourceFilter((filters.data_source as string[]) || [])
    setStatusFilter(((filters.status as string[]) || []).map(Number).filter((n) => !Number.isNaN(n)))
    const prop = (filters.material_property as string[]) || []
    setPropertyChip(prop.length ? prop[prop.length - 1] : 'all')
  }

  const baseColumns: TableColumnsType<Material> = [
    {
      title: '物料',
      dataIndex: 'material_name',
      key: 'material',
      width: 260,
      sorter: true,
      sortOrder: sortBy === 'material_code' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (_: any, record: Material) => (
        <div>
          <div className="sc-mat-name">{record.material_name}</div>
          <div className="sc-mat-code">{record.material_code} · ERP {record.erp_material_id}</div>
        </div>
      ),
    },
    {
      title: '规格型号', dataIndex: 'spec_model', key: 'spec_model', width: 160, ellipsis: true,
      sorter: true,
      sortOrder: sortBy === 'spec_model' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '分类', dataIndex: 'material_type', key: 'material_type', width: 100,
      sorter: true,
      sortOrder: sortBy === 'material_type' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      filters: typeOptions.map(t => ({ text: t.label, value: t.value })),
      filteredValue: typeFilter.length ? typeFilter : null,
      render: (v: string) => <span className="sc-tag sc-tag-plain">{v}</span>,
    },
    {
      title: '属性', dataIndex: 'material_property', key: 'material_property', width: 95,
      sorter: true,
      sortOrder: sortBy === 'material_property' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      filters: MATERIAL_PROPERTY_OPTIONS.map(o => ({ text: o.label, value: String(o.value) })),
      filteredValue: propertyChip !== 'all' ? [propertyChip] : null,
      filterMultiple: false,
      render: (v: number | null | undefined) => renderMaterialProperty(v),
    },
    {
      title: '单位', dataIndex: 'unit_of_measure', key: 'unit_of_measure', width: 65,
      sorter: true,
      sortOrder: sortBy === 'unit_of_measure' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
    },
    {
      title: '品牌/厂商', dataIndex: 'brand', key: 'brand', width: 110, ellipsis: true,
      sorter: true,
      sortOrder: sortBy === 'brand' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '供应商', dataIndex: 'supplier_name', key: 'supplier_name', width: 160, ellipsis: true,
      render: (v: string | null | undefined) => v || <span className="sc-note">—</span>,
    },
    {
      title: '采/产', key: 'pp', width: 76,
      render: (_: any, record: Material) => <PpBadges record={record} />,
    },
    {
      title: '来源', dataIndex: 'data_source', key: 'data_source', width: 80,
      sorter: true,
      sortOrder: sortBy === 'data_source' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      filters: [
        { text: 'ERP', value: 'erp' },
        { text: '手工', value: 'manual' },
        { text: 'Excel', value: 'excel' },
      ],
      filteredValue: sourceFilter.length ? sourceFilter : null,
      render: (v: string) => renderDataSource(v),
    },
    {
      title: '单价', dataIndex: 'order_unit_price', key: 'order_unit_price', width: 95, align: 'right' as const, className: 'sc-mono',
      sorter: true,
      sortOrder: sortBy === 'order_unit_price' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (v: number | string | null) => formatPrice(v),
    },
    {
      title: '最近出库', dataIndex: 'last_outbound_date', key: 'last_outbound_date', width: 100, className: 'sc-mono',
      sorter: true,
      sortOrder: sortBy === 'last_outbound_date' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      render: (v: string) => v || <span className="sc-note">—</span>,
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 80,
      sorter: true,
      sortOrder: sortBy === 'status' ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null,
      filters: [
        { text: '启用', value: '1' },
        { text: '停用', value: '0' },
      ],
      filteredValue: statusFilter.length ? statusFilter.map(String) : null,
      filterMultiple: false,
      render: (status: number) => renderStatus(status),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      fixed: 'right' as const,
      render: (_: any, record: Material) => (
        <span className="sc-row-act">
          <PermButton permResource="basicdata.data.materials" permAction="read" type="text" size="small" icon={<ProfileOutlined />} onClick={() => openDrawer(record)}>详情</PermButton>
          <PermButton permResource="basicdata.data.materials" permAction="read" type="text" size="small" icon={<QrcodeOutlined />}
            onClick={() =>
              record.material_code &&
              setQrMaterials([{ material_code: record.material_code, material_name: record.material_name, spec_model: record.spec_model }])
            }
          >二维码</PermButton>
          <PermButton permResource="basicdata.data.materials" permAction="update" type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</PermButton>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.erp_material_id)} okText="确认" cancelText="取消" disabled={!canDelete}>
            <PermButton permResource="basicdata.data.materials" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
          </Popconfirm>
        </span>
      ),
    },
  ]

  const columns = baseColumns.filter((c) => !c.key || !hiddenCols.includes(String(c.key)))

  const summaryRow = (rows: Material[]) => {
    const propCount = (p: number) => rows.filter((m) => m.material_property === p).length
    const disabledCount = rows.filter((m) => m.status === 0).length
    const erpCount = rows.filter((m) => (m.data_source || '') === 'erp').length
    return `本页 ${rows.length} 项 · 外购 ${propCount(1)} / 自制 ${propCount(2)} / 委外 ${propCount(3)} · 停用 ${disabledCount} · 来源 ERP ${erpCount}`
  }

  const colSettingsContent = (
    <div style={{ minWidth: 160 }}>
      <Checkbox.Group
        value={OPTIONAL_COLUMNS.filter((c) => !hiddenCols.includes(c.key)).map((c) => c.key)}
        onChange={(keys) => toggleHiddenCol(OPTIONAL_COLUMNS.filter((c) => !keys.includes(c.key)).map((c) => c.key))}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {OPTIONAL_COLUMNS.map((c) => (
            <Checkbox key={c.key} value={c.key}>{c.label}</Checkbox>
          ))}
        </div>
      </Checkbox.Group>
      <div style={{ borderTop: '1px solid #f1f5f9', marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => toggleHiddenCol([])}>恢复默认</Button>
        <span className="sc-note">物料 / 状态 / 操作 固定展示</span>
      </div>
    </div>
  )

  const disabledChipOn = statusFilter.length === 1 && statusFilter[0] === 0

  const handleChipClick = (key: string) => {
    if (key === 'all') {
      setPropertyChip('all')
      setStatusFilter([])
    } else if (key === 'disabled') {
      setStatusFilter(disabledChipOn ? [] : [0])
    } else {
      setPropertyChip(propertyChip === key ? 'all' : key)
    }
  }

  const isChipOn = (key: string) => {
    if (key === 'all') return propertyChip === 'all' && statusFilter.length === 0
    if (key === 'disabled') return disabledChipOn
    return propertyChip === key
  }

  return (
    <div className="sc-page" style={{ paddingBottom: selectedRowKeys.length > 0 ? 72 : 0 }}>
      {/* ===== 工具栏（原型：无卡片平铺行） ===== */}
      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="物料编码 / 名称 / 规格"
            style={{ width: 240 }}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </span>
        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className={`sc-chip${isChipOn(chip.key) ? ' on' : ''}`}
              onClick={() => handleChipClick(chip.key)}
            >
              {chip.label} <span className="n">{chip.count.toLocaleString()}</span>
            </span>
          ))}
        </span>
        <span className="sc-toolbar-hint">ERP 每日同步 · 手工 / Excel 数据可自由编辑</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Tooltip title="紧凑密度">
            <Button icon={<ColumnHeightOutlined />} onClick={toggleDensity} type={density === 'middle' ? 'primary' : 'default'} />
          </Tooltip>
          <Popover content={colSettingsContent} trigger="click" placement="bottomRight" title="列设置">
            <Button icon={<SettingOutlined />} />
          </Popover>
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={refreshAll} />
          </Tooltip>
          <span style={{ width: 1, height: 20, background: '#e2e8f0' }} />
          <Button icon={<ExportOutlined />} loading={exporting} onClick={handleExport}>导出</Button>
          <PermButton permResource="basicdata.data.materials" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增物料</PermButton>
        </span>
      </div>

      {/* ===== 物料表 ===== */}
      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={data}
          loading={loading}
          scroll={{ x: 1500 }}
          size={density}
          rowSelection={rowSelection}
          onChange={handleTableChange}
          pagination={{
            ...pagination,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
            onChange: (page, pageSize) => fetchData(page, pageSize),
            pageSizeOptions: ['20', '50', '100'],
          }}
          summary={() =>
            data.length ? (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={columns.length}>{summaryRow(data)}</Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            ) : null
          }
        />
      </div>

      {/* ===== 批量操作条（勾选后浮起） ===== */}
      {selectedRowKeys.length > 0 && (
        <div className="sc-batch-bar">
          <span className="bb-n">已选 <b>{selectedRowKeys.length}</b> 项（跨页保留）</span>
          <span className="bb-sep" />
          <Button size="small" icon={<QrcodeOutlined />} onClick={handleBatchQrcode}>批量二维码</Button>
          <PermButton permResource="basicdata.data.materials" permAction="update" size="small" loading={batchWorking} onClick={() => handleBatchStatus(1)}>批量启用</PermButton>
          <PermButton permResource="basicdata.data.materials" permAction="update" size="small" loading={batchWorking} onClick={() => handleBatchStatus(0)}>批量停用</PermButton>
          <Button size="small" loading={batchWorking} icon={<DeleteOutlined />} style={{ background: '#fef2f2', color: '#dc2626', borderColor: '#fecaca' }} onClick={handleBatchDelete}>批量删除</Button>
          <span className="bb-sep" />
          <Button size="small" type="text" icon={<ClearOutlined />} onClick={clearSelection}>清除选择</Button>
        </div>
      )}

      <Modal
        title={editingItem ? '编辑物料' : '新增物料'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={720}
        rootClassName="sc-page"
      >
        <MaterialForm
          form={form}
          seedParentId={editingItem?.parent_id ?? null}
          excludeSelfId={editingItem?.erp_material_id ?? null}
          isErpLocked={!!editingItem && editingItem.data_source === 'erp'}
        />
      </Modal>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
        rootClassName="sc-page"
        className="sc-drawer"
        styles={{ body: { padding: 0 } }}
        title={
          drawerItem ? (
            <div>
              <div>{drawerItem.material_name}</div>
              <div className="sc-mat-code">{drawerItem.material_code} · ERP物料ID {drawerItem.erp_material_id}</div>
            </div>
          ) : '物料详情'
        }
        extra={
          drawerItem && (
            <Space size={0}>
              <PermButton permResource="basicdata.data.materials" permAction="update" type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(drawerItem)}>编辑</PermButton>
              <PermButton permResource="basicdata.data.materials" permAction="read" type="text" size="small" icon={<QrcodeOutlined />}
                onClick={() => setQrMaterials([{ material_code: drawerItem.material_code, material_name: drawerItem.material_name, spec_model: drawerItem.spec_model }])}
              >二维码</PermButton>
              <Popconfirm title="确认删除？" onConfirm={() => handleDelete(drawerItem.erp_material_id)} okText="确认" cancelText="取消" disabled={!canDelete}>
                <PermButton permResource="basicdata.data.materials" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
              </Popconfirm>
            </Space>
          )
        }
      >
        {drawerItem && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '12px 20px 0' }}>
              {renderMaterialProperty(drawerItem.material_property)}
              {renderStatus(drawerItem.status)}
              {renderDataSource(drawerItem.data_source)}
            </div>

            <div className="d-sec" style={{ marginTop: 12 }}>
              <h4>基本信息</h4>
              <dl className="d-kv">
                <dt>规格型号</dt><dd>{drawerItem.spec_model || '—'}</dd>
                <dt>物料分类</dt><dd>{drawerItem.material_type}</dd>
                <dt>计量单位</dt><dd>{drawerItem.unit_of_measure}</dd>
                <dt>品牌/厂商</dt><dd>{drawerItem.brand || '—'}</dd>
                <dt>采购 / 生产</dt>
                <dd>
                  <span style={{ color: drawerItem.is_purchase ? '#16a34a' : '#94a3b8' }}>可采购{drawerItem.is_purchase ? ' ✓' : ' ×'}</span>
                  <span style={{ marginInline: 8, color: '#e2e8f0' }}>|</span>
                  <span style={{ color: drawerItem.is_produce ? '#16a34a' : '#94a3b8' }}>可生产{drawerItem.is_produce ? ' ✓' : ' ×'}</span>
                </dd>
                <dt>订货单价</dt><dd className="sc-mono">{formatPrice(drawerItem.order_unit_price)}</dd>
                <dt>最近出库</dt><dd className="sc-mono">{drawerItem.last_outbound_date || '—'}</dd>
              </dl>
            </div>

            <div className="d-sec">
              <h4>ERP / 同步信息</h4>
              <dl className="d-kv">
                <dt>ERP物料ID</dt><dd className="sc-mono">{drawerItem.erp_material_id}</dd>
                <dt>同步标识</dt>
                <dd><span className={`sc-tag ${drawerItem.erp_sync_flag ? 'sc-tag-done' : 'sc-tag-wait'}`}><span className="dot" />{drawerItem.erp_sync_flag ? '已同步' : '未同步'}</span></dd>
                <dt>数据来源</dt><dd>{DATA_SOURCE_META[drawerItem.data_source || '']?.label || drawerItem.data_source || '—'}</dd>
                <dt>创建时间</dt><dd className="sc-mono">{drawerItem.create_time || '—'}</dd>
                <dt>最近更新</dt><dd className="sc-mono">{drawerItem.update_time || '—'}</dd>
              </dl>
            </div>

            <div className="d-sec">
              <h4>层级路径</h4>
              <div style={{ fontSize: 'calc(13.5px * var(--font-size-scale))', lineHeight: 1.8, color: '#475569' }}>
                物料库
                {drawerPath.map((m) => (
                  <span key={m.erp_material_id}>
                    {' / '}
                    <span style={{ color: m.erp_material_id === drawerItem.erp_material_id ? '#0f172a' : '#94a3b8', fontWeight: m.erp_material_id === drawerItem.erp_material_id ? 600 : 400 }}>
                      {m.material_name}
                    </span>
                  </span>
                ))}
                {drawerPath.length === 0 && <span style={{ color: '#94a3b8' }}> / {drawerItem.material_name}</span>}
              </div>
            </div>

            <div className="d-sec">
              <h4>
                被引用位置{drawerRefsLoading ? '（加载中…）' : drawerRefs ? `（SKU ${drawerRefs.skus.length}${drawerRefs.child_count ? ` · 子物料 ${drawerRefs.child_count}` : ''}）` : ''}
              </h4>
              {drawerRefs && drawerRefs.skus.length > 0 ? (
                drawerRefs.skus.map((sku) => (
                  <div key={sku.id} className="ref-item">
                    <span>{sku.sku_name}</span>
                    <span className="t">{sku.sku_code}</span>
                  </div>
                ))
              ) : (
                <div className="sc-note">{drawerRefsLoading ? '' : '暂无 SKU / BOM 引用'}</div>
              )}
            </div>
          </>
        )}
      </Drawer>

      <MaterialQRCodePrintModal
        open={qrMaterials != null}
        materials={qrMaterials ?? []}
        onClose={() => setQrMaterials(null)}
      />
    </div>
  )
}
