import type { ColumnsType } from 'antd/es/table'
import { productionApi } from '../../../services/api'
import { formatDate } from '../../../utils'
import type { ProcessCrudConfig } from '../components/ProcessCrudPage'

export interface PackagingRow {
  id: number
  assembly_group: string | null
  seq_no: number | null
  plan_date: string | null
  order_no: string | null
  model_code: string | null
  color_spec: string | null
  planned_qty: number | null
  online_date: string | null
  daily_plan_qty: number | null
  daily_complete_qty: number | null
  completion_rate: string | null
  work_hours: number | null
  remark: string | null
  warehouse_in_qty: number | null
  status: string
}

const renderCompletionRate = (v: string | null) => {
  if (!v) return '-'
  const pct = parseFloat(v)
  if (isNaN(pct)) return v
  if (pct >= 100) return <span style={{ color: '#16a34a' }}>{v}</span>
  if (pct >= 80) return <span style={{ color: '#f59e0b' }}>{v}</span>
  return <span style={{ color: '#e11d48' }}>{v}</span>
}

const columns: ColumnsType<PackagingRow> = [
  { title: '总装', dataIndex: 'assembly_group', width: 60 },
  { title: '序号', dataIndex: 'seq_no', width: 60 },
  { title: '时间', dataIndex: 'plan_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '订单号', dataIndex: 'order_no', width: 80 },
  { title: '型号', dataIndex: 'model_code', width: 180, ellipsis: true },
  { title: '颜色', dataIndex: 'color_spec', width: 130, ellipsis: true },
  { title: '计划数量', dataIndex: 'planned_qty', width: 80, sorter: (a: PackagingRow, b: PackagingRow) => (a.planned_qty || 0) - (b.planned_qty || 0) },
  { title: '上线时间', dataIndex: 'online_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '当日排单', dataIndex: 'daily_plan_qty', width: 80 },
  { title: '当日完成', dataIndex: 'daily_complete_qty', width: 80 },
  { title: '完成率', dataIndex: 'completion_rate', width: 70, render: renderCompletionRate },
  { title: '工时', dataIndex: 'work_hours', width: 60 },
  { title: '备注', dataIndex: 'remark', width: 120, ellipsis: true },
  { title: '入库', dataIndex: 'warehouse_in_qty', width: 80, render: (v: number | null) => v ? <span style={{ color: '#6366f1', fontWeight: 500 }}>{v}</span> : '-' },
]

export const packagingConfig: ProcessCrudConfig<PackagingRow> = {
  editModalTitle: '编辑包装记录',
  editModalWidth: 600,
  tableScrollX: 1600,
  searchPlaceholder: '搜索型号/订单号',
  api: {
    list: productionApi.listPackaging,
    update: productionApi.updatePackaging,
    importCsv: productionApi.importPackaging,
  },
  columns,
  rowClassName: (row) => row.status === 'overdue' ? 'ant-table-row-danger' : row.status === 'abnormal' ? 'ant-table-row-warning' : '',
  formFields: [
    { name: 'model_code', label: '型号', type: 'text', span: 12 },
    { name: 'color_spec', label: '颜色', type: 'text', span: 12 },
    { name: 'planned_qty', label: '计划数量', type: 'number', span: 8 },
    { name: 'online_date', label: '上线时间', type: 'date', span: 8 },
    { name: 'warehouse_in_qty', label: '入库数量', type: 'number', span: 8 },
    { name: 'daily_plan_qty', label: '当日排单', type: 'number', span: 8 },
    { name: 'daily_complete_qty', label: '当日完成', type: 'number', span: 8 },
    { name: 'completion_rate', label: '完成率', type: 'text', span: 8 },
    { name: 'work_hours', label: '工时', type: 'number', span: 8 },
    { name: 'remark', label: '备注', type: 'text', span: 16 },
  ],
}
