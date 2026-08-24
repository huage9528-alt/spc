import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Descriptions, Table, Spin, Button, message, Tabs, Popover, Checkbox, Tag, Progress, Tooltip, Row, Col, Card, Select, Input, InputNumber, DatePicker, Space } from 'antd'
import { ArrowLeftOutlined, SettingOutlined, PieChartOutlined, WarningOutlined, ExclamationCircleOutlined, CheckCircleOutlined, ReloadOutlined, SearchOutlined, FilterOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import RiskBadge from '../../../components/RiskBadge'
import StatusTag from '../../../components/StatusTag'
import { orderApi, materialApi } from '../../../services/api'
import { useUiPreferencesStore } from '../../../store/uiPreferences'

interface OrderDetailData {
  id: number
  order_no: string
  line_no: string | null
  customer: string | null
  customer_code: string | null
  product_code: string | null
  product_name: string | null
  product_model: string | null
  order_qty: number | null
  promised_date: string | null
  planned_start_date: string | null
  batch_no: string | null
  department: string | null
  audit_date: string | null
  owner: string | null
  status: string
  risk_level: string | null
  data_source: string | null
  lines: any[]
  material_demands: any[]
  bindings: any[]
  shortage_count: number
  in_transit_count: number
  latest_eta: string | null
  issues: any[]
}

interface BomDetailItem {
  material_id: string | null
  material_code: string | null
  material_name: string | null
  spec_model: string | null
  unit: string | null
  material_type: string | null
  material_property: number | null
  line_no: string | null
  standard_qty: number | null
  aux_qty: number | null
  config_type: string | null
  lead_offset_days: number | null
  back_flush: number | null
  scrap_rate: number | null
  oper_sn: string | null
  process_id: string | null
  warehouse_id: string | null
  valid_date: string | null
  invalid_date: string | null
  kit_flag: number | null
  req_qty: number | null
  level?: number
  bom_id?: string | null
  parent_material_id?: number | null
  has_sub_bom?: boolean
  children?: BomDetailItem[]
}

interface ProductMaterialGroup {
  line_no: string | null
  product_code: string | null
  product_name: string | null
  product_model: string | null
  bom_no?: string | null
  bom_id?: string | null
  order_qty: number | null
  promised_date: string | null
  total_materials: number
  materials: BomDetailItem[]
}

const BOM_COLUMN_KEYS = [
  'line_no', 'material_code', 'material_name', 'spec_model', 'material_property', 'material_type',
  'unit', 'standard_qty', 'req_qty', 'aux_qty', 'scrap_rate',
  'config_type', 'lead_offset_days', 'back_flush', 'oper_sn', 'kit_flag',
  'valid_date', 'invalid_date',
] as const

const BOM_COLUMN_LABELS: Record<string, string> = {
  line_no: 'BOM行号',
  material_code: '物料编码',
  material_name: '物料名称',
  spec_model: '规格型号',
  material_property: '物料属性',
  material_type: '物料分类',
  unit: '单位',
  standard_qty: '标准用量',
  req_qty: '需求量',
  aux_qty: '辅助数量',
  scrap_rate: '损耗率',
  config_type: '配置类型',
  lead_offset_days: '前期偏移',
  back_flush: '是否倒冲',
  oper_sn: '工序号',
  kit_flag: '套件',
  valid_date: '生效日期',
  invalid_date: '失效日期',
}

const ORDER_DETAIL_BOM_PAGE_KEY = 'order_detail_bom_columns'
const ORDER_DETAIL_KIT_PAGE_KEY = 'order_detail_kit_columns'

interface KitMaterialItem {
  material_code: string
  material_name: string | null
  material_property: number | null
  material_property_label: string | null
  material_type: string | null
  unit_name: string | null
  supplier_name: string | null
  order_qty: number | null
  mrp_qty: number | null
  po_qty: number | null
  stock_qty: number | null
  shortage_qty: number | null
  req_date: string | null
  po_no: string | null
  po_count: number
  received_qty: number | null
  eta: string | null
  first_eta: string | null
  latest_eta: string | null
  actual_arrival_date: string | null
  inspection_date: string | null
  status: string
  status_label: string | null
  is_stagnant: boolean
  stagnant_qty: number | null
  bill_type: number | null
  bill_type_label: string | null
  is_closed: number
}

interface KitAnalysisData {
  order_no: string
  total_materials: number
  received_materials: number
  partial_received_materials: number
  not_ordered_materials: number
  overdue_materials: number
  stagnant_materials: number
  kit_rate: number
  risk_level: string
  promised_date: string | null
}

const KIT_RISK_COLOR: Record<string, string> = { red: '#e11d48', yellow: '#f59e0b', green: '#16a34a' }
const KIT_RISK_LABEL: Record<string, string> = { red: '缺料严重', yellow: '部分齐套', green: '齐套' }

const MATERIAL_STATUS: Record<string, { label: string; color: string }> = {
  closed: { label: '已关闭', color: 'default' },
  not_ordered: { label: '未下单', color: 'volcano' },
  self_made_unlinked: { label: '自制未排产/未关联', color: 'blue' },
  partial_received: { label: '部分到', color: 'warning' },
  fully_received: { label: '已到齐', color: 'success' },
  overdue: { label: '逾期未到', color: 'error' },
  pending: { label: '待到料', color: 'cyan' },
}

const MATERIAL_PROPERTY_OPTIONS = [
  { value: 1, label: '外购' },
  { value: 2, label: '自制' },
  { value: 3, label: '委外加工' },
  { value: 5, label: '虚拟件' },
  { value: 6, label: '特征类' },
  { value: 7, label: '配置类' },
  { value: 8, label: '规划类' },
  { value: 9, label: '组装件' },
]
const MATERIAL_PROPERTY_MAP = Object.fromEntries(MATERIAL_PROPERTY_OPTIONS.map(item => [item.value, item.label]))
const MATERIAL_PROPERTY_COLOR: Record<number, string> = {
  1: 'blue', 2: 'purple', 3: 'cyan', 5: 'default', 6: 'geekblue', 7: 'magenta', 8: 'gold', 9: 'orange',
}

const KIT_MATERIAL_COLUMN_KEYS = [
  'material_code', 'material_name', 'status', 'is_closed', 'material_property',
  'material_type', 'unit_name', 'supplier_name', 'order_qty', 'mrp_qty', 'po_qty', 'stock_qty',
  'received_qty', 'shortage_qty', 'eta', 'first_eta', 'latest_eta',
  'actual_arrival_date', 'inspection_date', 'is_stagnant', 'bill_type', 'po_no', 'req_date',
] as const

const KIT_MATERIAL_COLUMN_LABELS: Record<string, string> = {
  material_code: '物料代码',
  material_name: '物料名称',
  status: '状态',
  is_closed: '是否关闭',
  material_property: '物料属性',
  material_type: '物料类型',
  unit_name: '单位',
  supplier_name: '供应商',
  order_qty: '需求数量',
  mrp_qty: 'MRP数量',
  po_qty: '下单数量',
  stock_qty: '库存',
  received_qty: '收料量',
  shortage_qty: '缺料数量',
  eta: 'ETA',
  first_eta: '最早ETA',
  latest_eta: '最晚ETA',
  actual_arrival_date: '实际到料时间',
  inspection_date: '检验日期',
  is_stagnant: '呆滞',
  bill_type: '单据类型',
  po_no: '采购单号',
  req_date: '需求日期',
}

const DEFAULT_KIT_MATERIAL_STATUS = 'not_ordered,self_made_unlinked,pending,overdue,partial_received'

export default function OrderDetail() {
  const { orderNo, lineNo } = useParams<{ orderNo: string; lineNo: string }>()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<OrderDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [productMaterials, setProductMaterials] = useState<ProductMaterialGroup[]>([])
  const [productMaterialsLoading, setProductMaterialsLoading] = useState(false)

  const [kitAnalysis, setKitAnalysis] = useState<KitAnalysisData | null>(null)
  const [kitMaterials, setKitMaterials] = useState<KitMaterialItem[]>([])
  const [kitMaterialsLoading, setKitMaterialsLoading] = useState(false)
  const [kitStatusFilter, setKitStatusFilter] = useState<string>(DEFAULT_KIT_MATERIAL_STATUS)

  const getColumnVisibility = useUiPreferencesStore(s => s.getColumnVisibility)
  const setColumnVisibility = useUiPreferencesStore(s => s.setColumnVisibility)
  const [bomColumnKeys, setBomColumnKeys] = useState<string[]>(
    () => getColumnVisibility(ORDER_DETAIL_BOM_PAGE_KEY, BOM_COLUMN_KEYS as unknown as string[])
  )
  const [kitMaterialColumnKeys, setKitMaterialColumnKeys] = useState<string[]>(
    () => getColumnVisibility(ORDER_DETAIL_KIT_PAGE_KEY, KIT_MATERIAL_COLUMN_KEYS as unknown as string[])
  )
  const [sortedKitMaterials, setSortedKitMaterials] = useState<KitMaterialItem[]>([])
  const [kitTableFilters, setKitTableFilters] = useState<Record<string, any>>({})

  const [activeTab, setActiveTab] = useState('kit')

  const handleTabChange = (key: string) => {
    setActiveTab(key)
    if (key === 'kit' && kitMaterials.length === 0 && !kitMaterialsLoading) {
      fetchKitMaterials()
    }
  }

  const handleKitTableChange = (pagination: any, filters: any, sorter: any) => {
    setKitTableFilters(filters)
    let result = [...kitMaterials]

    // 文本筛选
    const textFields = ['material_code', 'material_name', 'material_type', 'supplier_name']
    textFields.forEach(field => {
      const filterValue = filters[field]
      if (filterValue && filterValue[0]) {
        const keyword = String(filterValue[0]).toLowerCase()
        result = result.filter(item => {
          const val = (item as any)[field]
          return val && String(val).toLowerCase().includes(keyword)
        })
      }
    })

    // 状态筛选
    if (filters.status && filters.status.length > 0) {
      result = result.filter(item => filters.status.includes(item.status))
    }

    // 是否关闭筛选
    if (filters.is_closed && filters.is_closed.length > 0) {
      const closed = filters.is_closed[0] === 'true'
      result = result.filter(item => closed ? item.is_closed === 1 : item.is_closed !== 1)
    }

    // 物料属性筛选
    if (filters.material_property && filters.material_property.length > 0) {
      result = result.filter(item => item.material_property && filters.material_property.includes(String(item.material_property)))
    }

    // 数字范围筛选
    const numberRangeFields = ['po_qty', 'received_qty']
    numberRangeFields.forEach(field => {
      const filterValue = filters[field]
      if (filterValue && filterValue.length === 2) {
        const [min, max] = filterValue
        result = result.filter(item => {
          const val = (item as any)[field]
          if (val == null) return false
          if (min != null && val < min) return false
          if (max != null && val > max) return false
          return true
        })
      }
    })

    // 日期范围筛选
    const dateRangeFields = ['eta', 'actual_arrival_date', 'inspection_date']
    dateRangeFields.forEach(field => {
      const filterValue = filters[field]
      if (filterValue && filterValue.length === 2) {
        const [start, end] = filterValue
        result = result.filter(item => {
          const val = (item as any)[field]
          if (!val) return false
          return val >= start && val <= end
        })
      }
    })

    // 呆滞筛选
    if (filters.is_stagnant && filters.is_stagnant.length > 0) {
      const stagnant = filters.is_stagnant[0] === 'true'
      result = result.filter(item => stagnant ? item.is_stagnant : !item.is_stagnant)
    }

    // 排序
    if (sorter.field && sorter.order) {
      result.sort((a, b) => {
        const aVal = (a as any)[sorter.field]
        const bVal = (b as any)[sorter.field]
        if (aVal == null && bVal == null) return 0
        if (aVal == null) return 1
        if (bVal == null) return -1
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return sorter.order === 'ascend' ? aVal - bVal : bVal - aVal
        }
        return sorter.order === 'ascend'
          ? String(aVal).localeCompare(String(bVal))
          : String(bVal).localeCompare(String(aVal))
      })
    }

    setSortedKitMaterials(result)
  }

  useEffect(() => {
    setSortedKitMaterials(kitMaterials)
    setKitTableFilters({})
  }, [kitMaterials])

  const fetchKitAnalysis = useCallback(async () => {
    if (!orderNo) return
    try {
      const res: any = await materialApi.getKitAnalysis({ order_no: orderNo, page_size: 1 })
      if (res.data.items && res.data.items.length > 0) {
        setKitAnalysis(res.data.items[0])
      }
    } catch {
      // 齐套分析数据获取失败不影响主流程
    }
  }, [orderNo])

  const fetchKitMaterials = useCallback(async (statusFilter?: string) => {
    if (!orderNo) return
    setKitMaterialsLoading(true)
    try {
      const params: Record<string, any> = {}
      if (statusFilter) params.status = statusFilter
      const res: any = await materialApi.getOrderMaterials(orderNo, params)
      setKitMaterials(res.data || [])
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setKitMaterialsLoading(false)
    }
  }, [orderNo])

  const fetchDetail = async () => {
    if (!orderNo) return
    setLoading(true)
    try {
      const res: any = await orderApi.getDetail(orderNo, lineNo)
      setDetail(res.data)
      setProductMaterialsLoading(true)
      const materialRes: any = await orderApi.getProductMaterials(orderNo)
      setProductMaterials(materialRes.data || [])
      fetchKitAnalysis()
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
      setProductMaterialsLoading(false)
    }
  }

  useEffect(() => {
    fetchDetail()
  }, [orderNo, lineNo])

  useEffect(() => {
    if (activeTab === 'kit' && orderNo && kitMaterials.length === 0 && !kitMaterialsLoading) {
      fetchKitMaterials()
    }
  }, [activeTab, orderNo, kitMaterials.length, kitMaterialsLoading, fetchKitMaterials])

  const productColumns = [
    { title: '行号', dataIndex: 'line_no', key: 'line_no', width: 80 },
    { title: '产品编码', dataIndex: 'product_code', key: 'product_code', width: 130 },
    { title: 'BOM编号', dataIndex: 'bom_no', key: 'bom_no', render: (v: string | null) => v || '-' },
    { title: 'BOM ID', dataIndex: 'bom_id', key: 'bom_id', width: 100, render: (v: string | null) => v || '-' },
    { title: '产品名称', dataIndex: 'product_name', key: 'product_name', ellipsis: true },
    { title: '产品型号', dataIndex: 'product_model', key: 'product_model', width: 130, ellipsis: true },
    { title: '订单数量', dataIndex: 'order_qty', key: 'order_qty', width: 90, render: (v: number | null) => v?.toLocaleString() || '-' },
    { title: '交期', dataIndex: 'promised_date', key: 'promised_date', width: 105 },
  ]

  const getBomDetailColumns = useCallback(() => [
    { title: 'BOM行号', dataIndex: 'line_no', key: 'line_no', width: 90 },
    { title: '物料编码', dataIndex: 'material_code', key: 'material_code', width: 150,
      render: (v: string | null, r: BomDetailItem) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {v || '-'}
          {r.has_sub_bom && (
            <Tag color="blue" style={{ marginLeft: 6, fontSize: 11 }}>组件</Tag>
          )}
        </span>
      )
    },
    { title: '物料名称', dataIndex: 'material_name', key: 'material_name', width: 180, ellipsis: true },
    { title: '规格型号', dataIndex: 'spec_model', key: 'spec_model', width: 140, ellipsis: true },
    { title: '物料属性', dataIndex: 'material_property', key: 'material_property', width: 90,
      render: (v: number | null) => {
        if (!v) return <span style={{ color: '#cbd5e1' }}>-</span>
        return <Tag color={MATERIAL_PROPERTY_COLOR[v] || 'default'}>{MATERIAL_PROPERTY_MAP[v] || v}</Tag>
      }
    },
    { title: '物料分类', dataIndex: 'material_type', key: 'material_type', width: 100 },
    { title: '单位', dataIndex: 'unit', key: 'unit', width: 70 },
    { title: '标准用量', dataIndex: 'standard_qty', key: 'standard_qty', width: 100, render: (v: number | null) => v ?? '-' },
    { title: '需求量', dataIndex: 'req_qty', key: 'req_qty', width: 100, render: (v: number | null, r: BomDetailItem) => v != null ? `${v}${r.unit || ''}` : '-' },
    { title: '辅助数量', dataIndex: 'aux_qty', key: 'aux_qty', width: 90, render: (v: number | null) => v ?? '-' },
    { title: '损耗率', dataIndex: 'scrap_rate', key: 'scrap_rate', width: 90, render: (v: number | null) => v != null ? `${v}` : '-' },
    { title: '配置类型', dataIndex: 'config_type', key: 'config_type', width: 100, render: (v: string | null) => v || '-' },
    { title: '前期偏移', dataIndex: 'lead_offset_days', key: 'lead_offset_days', width: 100, render: (v: number | null) => v ?? '-' },
    { title: '是否倒冲', dataIndex: 'back_flush', key: 'back_flush', width: 90, render: (v: number | null) => v === 1 ? '是' : '否' },
    { title: '工序号', dataIndex: 'oper_sn', key: 'oper_sn', width: 90, render: (v: string | null) => v || '-' },
    { title: '套件', dataIndex: 'kit_flag', key: 'kit_flag', width: 80, render: (v: number | null) => v === 1 ? '是' : '否' },
    { title: '生效日期', dataIndex: 'valid_date', key: 'valid_date', width: 105, render: (v: string | null) => v || '-' },
    { title: '失效日期', dataIndex: 'invalid_date', key: 'invalid_date', width: 105, render: (v: string | null) => v || '-' },
  ]
    .map((col: any) => ({ ...col, key: col.key || col.dataIndex }))
    .filter((col: any) => bomColumnKeys.includes(col.key)), [bomColumnKeys])

  const textFilterDropdown = (placeholder: string) => ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
    <div style={{ padding: 8 }}>
      <Input
        placeholder={placeholder}
        value={selectedKeys[0]}
        onChange={e => setSelectedKeys(e.target.value ? [e.target.value] : [])}
        onPressEnter={confirm}
        style={{ width: 188, marginBottom: 8, display: 'block' }}
      />
      <Button type="primary" onClick={confirm} size="small" style={{ width: 90, marginRight: 8 }}>搜索</Button>
      <Button onClick={() => { clearFilters?.(); confirm() }} size="small" style={{ width: 90 }}>重置</Button>
    </div>
  )

  const numberRangeFilterDropdown = (minPlaceholder: string, maxPlaceholder: string) => ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
    <div style={{ padding: 8 }}>
      <Space direction="vertical" size={8}>
        <InputNumber placeholder={minPlaceholder} value={selectedKeys[0]} onChange={v => setSelectedKeys([v, selectedKeys[1]].filter(x => x !== undefined && x !== null && x !== ''))} style={{ width: 188 }} />
        <InputNumber placeholder={maxPlaceholder} value={selectedKeys[1]} onChange={v => setSelectedKeys([selectedKeys[0], v].filter(x => x !== undefined && x !== null && x !== ''))} style={{ width: 188 }} />
        <div>
          <Button type="primary" onClick={confirm} size="small" style={{ width: 90, marginRight: 8 }}>筛选</Button>
          <Button onClick={() => { clearFilters?.(); confirm() }} size="small" style={{ width: 90 }}>重置</Button>
        </div>
      </Space>
    </div>
  )

  const dateRangeFilterDropdown = () => ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
    <div style={{ padding: 8 }}>
      <DatePicker.RangePicker
        value={selectedKeys && selectedKeys.length === 2 ? [dayjs(selectedKeys[0]), dayjs(selectedKeys[1])] : null}
        onChange={(dates) => {
          if (dates && dates[0] && dates[1]) {
            setSelectedKeys([dates[0].format('YYYY-MM-DD'), dates[1].format('YYYY-MM-DD')])
          } else {
            setSelectedKeys([])
          }
        }}
        style={{ marginBottom: 8, display: 'block', width: 220 }}
      />
      <Button type="primary" onClick={confirm} size="small" style={{ width: 90, marginRight: 8 }}>确定</Button>
      <Button onClick={() => { clearFilters?.(); confirm() }} size="small" style={{ width: 90 }}>重置</Button>
    </div>
  )

  const getKitMaterialColumns = useCallback(() => [
    {
      title: '物料代码', dataIndex: 'material_code', width: 160, ellipsis: true, sorter: true, fixed: 'left' as const,
      filterDropdown: textFilterDropdown('物料代码'),
      filteredValue: kitTableFilters.material_code || null,
      filterIcon: (filtered: boolean) => <SearchOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span>,
    },
    {
      title: '物料名称', dataIndex: 'material_name', width: 180, ellipsis: true, sorter: true,
      filterDropdown: textFilterDropdown('物料名称'),
      filteredValue: kitTableFilters.material_name || null,
      filterIcon: (filtered: boolean) => <SearchOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    {
      title: '状态', dataIndex: 'status', width: 100, sorter: true,
      filters: [
        { text: '未下单', value: 'not_ordered' },
        { text: '自制未排产/未关联', value: 'self_made_unlinked' },
        { text: '已到齐', value: 'fully_received' },
        { text: '部分到', value: 'partial_received' },
        { text: '逾期未到', value: 'overdue' },
        { text: '待到料', value: 'pending' },
      ],
      filteredValue: kitTableFilters.status || null,
      filterMultiple: true,
      render: (v: string, row: KitMaterialItem) => {
        const s = MATERIAL_STATUS[v] || { label: v, color: 'default' }
        return <Tag color={s.color}>{row.status_label || s.label}</Tag>
      },
    },
    {
      title: '是否关闭', dataIndex: 'is_closed', width: 80, sorter: true,
      filters: [
        { text: '已关闭', value: 'true' },
        { text: '未关闭', value: 'false' },
      ],
      filteredValue: kitTableFilters.is_closed || null,
      filterMultiple: false,
      render: (v: number) => v === 1
        ? <span style={{ color: '#e11d48', fontWeight: 500 }}>已关闭</span>
        : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '物料属性', dataIndex: 'material_property', width: 90, sorter: true,
      filters: MATERIAL_PROPERTY_OPTIONS.map(opt => ({ text: opt.label, value: String(opt.value) })),
      filteredValue: kitTableFilters.material_property || null,
      filterMultiple: true,
      render: (v: number | null) => {
        if (!v) return <span style={{ color: '#cbd5e1' }}>-</span>
        return <Tag color={MATERIAL_PROPERTY_COLOR[v] || 'default'}>{MATERIAL_PROPERTY_MAP[v] || v}</Tag>
      },
    },
    {
      title: '物料类型', dataIndex: 'material_type', width: 100, ellipsis: true, sorter: true,
      filterDropdown: textFilterDropdown('物料类型'),
      filteredValue: kitTableFilters.material_type || null,
      filterIcon: (filtered: boolean) => <SearchOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    {
      title: '单位', dataIndex: 'unit_name', width: 60,
      render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '供应商', dataIndex: 'supplier_name', width: 130, ellipsis: true, sorter: true,
      filterDropdown: textFilterDropdown('供应商名称'),
      filteredValue: kitTableFilters.supplier_name || null,
      filterIcon: (filtered: boolean) => <SearchOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
    },
    {
      title: '需求数量', dataIndex: 'order_qty', width: 80, align: 'right' as const, sorter: true,
      render: (v: number | null) => v != null ? <span style={{ color: '#1e293b' }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: 'MRP数量', dataIndex: 'mrp_qty', width: 80, align: 'right' as const, sorter: true,
      render: (v: number | null) => v != null ? <span style={{ color: '#6366f1' }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '下单数量', dataIndex: 'po_qty', width: 80, align: 'right' as const, sorter: true,
      filterDropdown: numberRangeFilterDropdown('最小下单数量', '最大下单数量'),
      filteredValue: kitTableFilters.po_qty || null,
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      render: (v: number | null) => v != null ? <span style={{ color: '#0ea5e9' }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '库存', dataIndex: 'stock_qty', width: 70, align: 'right' as const, sorter: true,
      render: (v: number | null) => v != null ? <span style={{ color: '#0ea5e9' }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '收料量', dataIndex: 'received_qty', width: 70, align: 'right' as const, sorter: true,
      filterDropdown: numberRangeFilterDropdown('最小收料量', '最大收料量'),
      filteredValue: kitTableFilters.received_qty || null,
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      render: (v: number | null) => v != null ? <span style={{ color: '#16a34a' }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>0</span>,
    },
    {
      title: '缺料数量', dataIndex: 'shortage_qty', width: 80, align: 'right' as const, sorter: true,
      render: (v: number | null) => v != null && v > 0 ? <span style={{ color: '#e11d48', fontWeight: 600 }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>0</span>,
    },
    {
      title: 'ETA', dataIndex: 'eta', width: 100, sorter: true,
      filterDropdown: dateRangeFilterDropdown(),
      filteredValue: kitTableFilters.eta || null,
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '最早ETA', dataIndex: 'first_eta', width: 100, sorter: true,
      render: (v: string | null) => v ? <span style={{ color: '#16a34a' }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '最晚ETA', dataIndex: 'latest_eta', width: 100, sorter: true,
      render: (v: string | null) => v ? <span style={{ color: '#e11d48' }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '实际到料时间', dataIndex: 'actual_arrival_date', width: 110, sorter: true,
      filterDropdown: dateRangeFilterDropdown(),
      filteredValue: kitTableFilters.actual_arrival_date || null,
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      render: (v: string | null) => v ? <span style={{ color: '#16a34a' }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '检验日期', dataIndex: 'inspection_date', width: 90, sorter: true,
      filterDropdown: dateRangeFilterDropdown(),
      filteredValue: kitTableFilters.inspection_date || null,
      filterIcon: (filtered: boolean) => <FilterOutlined style={{ color: filtered ? '#1890ff' : undefined }} />,
      render: (v: string | null) => v ? <span style={{ color: '#6366f1' }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '需求日期', dataIndex: 'req_date', width: 90, sorter: true,
      render: (v: string | null) => v || <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '采购单号', dataIndex: 'po_no', width: 140, ellipsis: true,
      render: (v: string | null) => v ? <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span> : <span style={{ color: '#cbd5e1' }}>-</span>,
    },
    {
      title: '呆滞', dataIndex: 'is_stagnant', width: 70, sorter: true,
      filters: [
        { text: '呆滞', value: 'true' },
        { text: '非呆滞', value: 'false' },
      ],
      filteredValue: kitTableFilters.is_stagnant || null,
      filterMultiple: false,
      render: (v: boolean, row: KitMaterialItem) => {
        if (!v) return <span style={{ color: '#cbd5e1' }}>-</span>
        return <Tooltip title={`超量 ${row.stagnant_qty}，收料${row.received_qty} > 需求${row.order_qty}`}><Tag color="warning">呆滞 +{row.stagnant_qty}</Tag></Tooltip>
      },
    },
    {
      title: '单据类型', dataIndex: 'bill_type', width: 90, sorter: true,
      render: (v: number | null, row: KitMaterialItem) => {
        if (!v) return <span style={{ color: '#cbd5e1' }}>-</span>
        const label = row.bill_type_label || v
        const colorMap: Record<number, string> = { 11010: 'geekblue', 11011: 'purple', 11012: 'cyan' }
        return <Tag color={colorMap[v] || 'default'}>{label}</Tag>
      },
    },
  ]
    .map((col: any) => ({ ...col, key: col.key || col.dataIndex }))
    .filter((col: any) => kitMaterialColumnKeys.includes(col.key)), [kitMaterialColumnKeys, kitTableFilters])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  }

  if (!detail) {
    return <div style={{ textAlign: 'center', padding: 80, color: '#94a3b8' }}>订单不存在</div>
  }

  return (
    <div>
      <div
        style={{
          position: 'sticky',
          top: 56,
          zIndex: 8,
          background: '#f0f4f8',
          margin: '0 -24px 12px',
          padding: '8px 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/orders')} />
            <div>
              <h2 style={{ marginBottom: 0, fontSize: 18, fontWeight: 700 }}>{detail.order_no}</h2>
            </div>
          </div>
          <RiskBadge level={detail.risk_level} />
        </div>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          {
            key: 'info',
            label: '订单基本信息',
            children: (
              <div className="card-modern" style={{ padding: 20 }}>
                <Descriptions column={{ xs: 2, sm: 3, md: 4, lg: 5 }} size="small" bordered>
                  <Descriptions.Item label="客户">{detail.customer || '-'}</Descriptions.Item>
                  <Descriptions.Item label="产品">{detail.product_name || '-'}</Descriptions.Item>
                  <Descriptions.Item label="产品型号">{detail.product_model || '-'}</Descriptions.Item>
                  <Descriptions.Item label="数量">{detail.order_qty?.toLocaleString() || '-'}</Descriptions.Item>
                  <Descriptions.Item label="交期">
                    <span style={{ color: detail.promised_date && detail.promised_date < new Date().toISOString().slice(0, 10) ? '#e11d48' : undefined, fontWeight: 600 }}>
                      {detail.promised_date || '-'}
                    </span>
                  </Descriptions.Item>
                  <Descriptions.Item label="计划开工">{detail.planned_start_date || '-'}</Descriptions.Item>
                  <Descriptions.Item label="部门">{detail.department || '-'}</Descriptions.Item>
                  <Descriptions.Item label="责任人">{detail.owner || '-'}</Descriptions.Item>
                  <Descriptions.Item label="状态"><StatusTag status={detail.status} /></Descriptions.Item>
                  <Descriptions.Item label="批号">{detail.batch_no || '-'}</Descriptions.Item>
                  <Descriptions.Item label="来源">{detail.data_source || '-'}</Descriptions.Item>
                </Descriptions>
              </div>
            ),
          },
          {
            key: 'products',
            label: '产品列表',
            children: (
              <div className="card-modern" style={{ padding: '2px 0 0' }}>
                <div className="table-modern">
                  <Table
                    columns={productColumns}
                    dataSource={productMaterials}
                    rowKey={(row) => row.line_no || row.product_code || 'product'}
                    size="small"
                    loading={productMaterialsLoading}
                    scroll={{ x: 1200 }}
                    pagination={false}
                    locale={{ emptyText: '暂无产品数据' }}
                    expandable={{
                      expandedRowRender: (row: ProductMaterialGroup) => (
                        <div style={{ padding: '8px 0' }}>
                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4, paddingRight: 8 }}>
                            <Popover
                              trigger="click"
                              placement="bottomRight"
                              title="选择显示列"
                              content={
                                <Checkbox.Group
                                  value={bomColumnKeys}
                                  onChange={(checked) => {
                                    const next = checked as string[]
                                    if (next.length === 0) return
                                    setBomColumnKeys(next)
                                    setColumnVisibility(ORDER_DETAIL_BOM_PAGE_KEY, next)
                                  }}
                                >
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, auto)', gap: '4px 16px', maxWidth: 420 }}>
                                    {BOM_COLUMN_KEYS.map(key => (
                                      <Checkbox key={key} value={key}>{BOM_COLUMN_LABELS[key]}</Checkbox>
                                    ))}
                                  </div>
                                </Checkbox.Group>
                              }
                            >
                              <Button size="small" icon={<SettingOutlined />}>列设置</Button>
                            </Popover>
                          </div>
                          <Table
                            columns={getBomDetailColumns()}
                            dataSource={row.materials || []}
                            rowKey={(r: BomDetailItem) =>
                              `${r.bom_id || ''}|${r.line_no || ''}|${r.material_id || ''}|${r.level || 1}`
                            }
                            size="small"
                            pagination={false}
                            scroll={{ x: 1700 }}
                            locale={{ emptyText: '暂无BOM明细' }}
                            expandable={{
                              childrenColumnName: 'children',
                              defaultExpandAllRows: false,
                            }}
                          />
                        </div>
                      ),
                    }}
                  />
                </div>
              </div>
            ),
          },
          {
            key: 'kit',
            label: '齐套分析',
            children: (
              <div>
                {kitAnalysis ? (
                  <Row gutter={16} style={{ marginBottom: 16 }}>
                    <Col flex={1}>
                      <Card size="small" className="card-modern">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 44, height: 44, borderRadius: 10, background: `${KIT_RISK_COLOR[kitAnalysis.risk_level]}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: KIT_RISK_COLOR[kitAnalysis.risk_level] }}>
                            <PieChartOutlined />
                          </div>
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 700, color: '#1e293b' }}>{Math.round(kitAnalysis.kit_rate * 100)}%</div>
                            <div style={{ fontSize: 12, color: '#64748b' }}>齐套率</div>
                          </div>
                        </div>
                      </Card>
                    </Col>
                    <Col flex={1}>
                      <Card size="small" className="card-modern">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 44, height: 44, borderRadius: 10, background: '#6366f115', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#6366f1' }}>
                            <CheckCircleOutlined />
                          </div>
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 700, color: '#1e293b' }}>{kitAnalysis.total_materials}</div>
                            <div style={{ fontSize: 12, color: '#64748b' }}>总物料数</div>
                          </div>
                        </div>
                      </Card>
                    </Col>
                    <Col flex={1}>
                      <Card size="small" className="card-modern">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 44, height: 44, borderRadius: 10, background: '#16a34a15', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#16a34a' }}>
                            <CheckCircleOutlined />
                          </div>
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 700, color: '#16a34a' }}>{kitAnalysis.received_materials}</div>
                            <div style={{ fontSize: 12, color: '#64748b' }}>已到齐</div>
                          </div>
                        </div>
                      </Card>
                    </Col>
                    <Col flex={1}>
                      <Card size="small" className="card-modern">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 44, height: 44, borderRadius: 10, background: '#f59e0b15', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#f59e0b' }}>
                            <ExclamationCircleOutlined />
                          </div>
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b' }}>{kitAnalysis.partial_received_materials}</div>
                            <div style={{ fontSize: 12, color: '#64748b' }}>部分到</div>
                          </div>
                        </div>
                      </Card>
                    </Col>
                    <Col flex={1}>
                      <Card size="small" className="card-modern">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 44, height: 44, borderRadius: 10, background: '#e11d4815', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: '#e11d48' }}>
                            <WarningOutlined />
                          </div>
                          <div>
                            <div style={{ fontSize: 18, fontWeight: 700, color: '#e11d48' }}>
                              {kitAnalysis.total_materials - kitAnalysis.received_materials - kitAnalysis.partial_received_materials}
                            </div>
                            <div style={{ fontSize: 12, color: '#64748b' }}>未到</div>
                          </div>
                        </div>
                      </Card>
                    </Col>
                  </Row>
                ) : (
                  <div className="card-modern" style={{ padding: 40, textAlign: 'center', marginBottom: 16 }}>
                    <Spin tip="加载齐套分析数据中..." />
                  </div>
                )}

                <div className="card-modern" style={{ padding: '12px 16px', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ fontWeight: 600 }}>物料明细</span>
                      <Tag color="blue">共 {sortedKitMaterials.length} 条</Tag>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Button size="small" icon={<ReloadOutlined />} onClick={() => { fetchKitAnalysis(); fetchKitMaterials() }}>刷新</Button>
                      <Popover
                        trigger="click"
                        placement="bottomRight"
                        title="选择显示列"
                        content={
                          <Checkbox.Group
                            value={kitMaterialColumnKeys}
                            onChange={(checked) => {
                              const next = checked as string[]
                              if (next.length === 0) return
                              setKitMaterialColumnKeys(next)
                              setColumnVisibility(ORDER_DETAIL_KIT_PAGE_KEY, next)
                            }}
                          >
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, auto)', gap: '4px 16px', maxWidth: 420 }}>
                              {KIT_MATERIAL_COLUMN_KEYS.map(key => (
                                <Checkbox key={key} value={key}>{KIT_MATERIAL_COLUMN_LABELS[key]}</Checkbox>
                              ))}
                            </div>
                          </Checkbox.Group>
                        }
                      >
                        <Button size="small" icon={<SettingOutlined />}>列设置</Button>
                      </Popover>
                    </div>
                  </div>
                </div>

                <div style={{ background: '#ffffff', borderRadius: 8, overflow: 'hidden', height: 'calc(100vh - 340px)', minHeight: 500, display: 'flex', flexDirection: 'column' }}>
                  <Table
                    rowKey="material_code"
                    dataSource={sortedKitMaterials}
                    columns={getKitMaterialColumns()}
                    onChange={handleKitTableChange}
                    pagination={false}
                    size="small"
                    scroll={{ x: 2200, y: 'calc(100vh - 380px)' }}
                    loading={kitMaterialsLoading}
                    locale={{ emptyText: '暂无物料数据' }}
                  />
                </div>
              </div>
            ),
          },
        ]}
      />
    </div>
  )
}
