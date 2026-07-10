import { Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { productionApi } from '../../../services/api'
import { formatDate } from '../../../utils'
import type { ProcessCrudConfig } from '../components/ProcessCrudPage'

export interface LeanRow {
  id: number
  seq_no: number | null
  plan_date: string | null
  order_no: string | null
  model_code: string | null
  color_spec: string | null
  next_process: string | null
  qty: number | null
  kit_qty: number | null
  online_date: string | null
  daily_plan_qty: number | null
  daily_complete_qty: number | null
  completion_rate: string | null
  work_hours: number | null
  remark: string | null
  status: string
}

const columns: ColumnsType<LeanRow> = [
  { title: '序号', dataIndex: 'seq_no', width: 60 },
  { title: '计划日期', dataIndex: 'plan_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '订单号', dataIndex: 'order_no', width: 80 },
  { title: '型号', dataIndex: 'model_code', width: 180, ellipsis: true },
  { title: '颜色', dataIndex: 'color_spec', width: 120, ellipsis: true },
  { title: '下一工序', dataIndex: 'next_process', width: 100, render: (v: string | null) => v ? <Tag>{v}</Tag> : '-' },
  { title: '数量', dataIndex: 'qty', width: 70, sorter: (a: LeanRow, b: LeanRow) => (a.qty || 0) - (b.qty || 0) },
  { title: '齐套', dataIndex: 'kit_qty', width: 70 },
  { title: '上线时间', dataIndex: 'online_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '当日排单', dataIndex: 'daily_plan_qty', width: 80 },
  { title: '完成数量', dataIndex: 'daily_complete_qty', width: 80 },
  { title: '完成率', dataIndex: 'completion_rate', width: 70 },
  { title: '工时', dataIndex: 'work_hours', width: 60 },
  { title: '备注', dataIndex: 'remark', width: 120, ellipsis: true },
]

export const leanConfig: ProcessCrudConfig<LeanRow> = {
  editModalTitle: '编辑精益记录',
  editModalWidth: 600,
  tableScrollX: 1500,
  searchPlaceholder: '搜索型号/订单号',
  api: {
    list: productionApi.listLean,
    update: productionApi.updateLean,
    importCsv: productionApi.importLean,
  },
  columns,
  extraFilters: [
    { name: 'next_process', placeholder: '下一工序', width: 120 },
  ],
  formFields: [
    { name: 'model_code', label: '型号', type: 'text', span: 12 },
    { name: 'color_spec', label: '颜色', type: 'text', span: 12 },
    { name: 'next_process', label: '下一工序', type: 'text', span: 12 },
    { name: 'qty', label: '数量', type: 'number', span: 6 },
    { name: 'kit_qty', label: '齐套', type: 'number', span: 6 },
    { name: 'online_date', label: '上线时间', type: 'date', span: 12 },
    { name: 'daily_plan_qty', label: '当日排单', type: 'number', span: 8 },
    { name: 'daily_complete_qty', label: '完成数量', type: 'number', span: 8 },
    { name: 'completion_rate', label: '完成率', type: 'text', span: 8 },
    { name: 'work_hours', label: '工时', type: 'number', span: 8 },
    { name: 'remark', label: '备注', type: 'text', span: 16 },
  ],
}
