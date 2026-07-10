import { Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { productionApi } from '../../../services/api'
import { formatDate } from '../../../utils'
import type { ProcessCrudConfig } from '../components/ProcessCrudPage'

export interface SMTRow {
  id: number
  material_long_code: string | null
  material_name: string | null
  order_no: string | null
  qty: number | null
  material_confirm: string | null
  plan_date: string | null
  daily_plan_qty: number | null
  daily_complete_qty: number | null
  unit_price: number | null
  daily_amount: number | null
  completion_rate: string | null
  work_hours: number | null
  remark: string | null
  complete_time: string | null
  hour_capacity: number | null
  demand_time: string | null
  total_plan_complete: number | null
  status: string
}

const columns: ColumnsType<SMTRow> = [
  { title: '物料长代码', dataIndex: 'material_long_code', width: 180, ellipsis: true, render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span> },
  { title: '物料名称', dataIndex: 'material_name', width: 200, ellipsis: true },
  { title: '订单号', dataIndex: 'order_no', width: 100 },
  { title: '订单数量', dataIndex: 'qty', width: 80, sorter: (a: SMTRow, b: SMTRow) => (a.qty || 0) - (b.qty || 0) },
  { title: '物料确认', dataIndex: 'material_confirm', width: 80, render: (v: string | null) => v === 'OK' ? <Tag color="success">OK</Tag> : v || '-' },
  { title: '计划日期', dataIndex: 'plan_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '当日排单', dataIndex: 'daily_plan_qty', width: 80 },
  { title: '当日完成', dataIndex: 'daily_complete_qty', width: 80 },
  { title: '单价', dataIndex: 'unit_price', width: 70 },
  { title: '当日金额', dataIndex: 'daily_amount', width: 90 },
  { title: '完成率', dataIndex: 'completion_rate', width: 70 },
  { title: '工时', dataIndex: 'work_hours', width: 60 },
  { title: '备注', dataIndex: 'remark', width: 120, ellipsis: true },
  { title: '完成时间', dataIndex: 'complete_time', width: 90 },
  { title: '小时产能', dataIndex: 'hour_capacity', width: 80 },
  { title: '需求时间', dataIndex: 'demand_time', width: 90 },
  { title: '总计划完成', dataIndex: 'total_plan_complete', width: 100 },
]

export const smtConfig: ProcessCrudConfig<SMTRow> = {
  editModalTitle: '编辑贴片记录',
  editModalWidth: 700,
  tableScrollX: 2200,
  searchPlaceholder: '搜索物料/订单号',
  api: {
    list: productionApi.listSMT,
    update: productionApi.updateSMT,
    importCsv: productionApi.importSMT,
  },
  columns,
  formFields: [
    { name: 'material_name', label: '物料名称', type: 'text', span: 12 },
    { name: 'qty', label: '订单数量', type: 'number', span: 6 },
    { name: 'material_confirm', label: '物料确认', type: 'text', span: 6 },
    { name: 'plan_date', label: '计划日期', type: 'date', span: 8 },
    { name: 'daily_plan_qty', label: '当日排单', type: 'number', span: 8 },
    { name: 'daily_complete_qty', label: '当日完成', type: 'number', span: 8 },
    { name: 'unit_price', label: '单价', type: 'number', span: 6 },
    { name: 'daily_amount', label: '当日金额', type: 'number', span: 6 },
    { name: 'completion_rate', label: '完成率', type: 'text', span: 6 },
    { name: 'work_hours', label: '工时', type: 'number', span: 6 },
    { name: 'complete_time', label: '完成时间', type: 'text', span: 8 },
    { name: 'hour_capacity', label: '小时产能', type: 'number', span: 8 },
    { name: 'demand_time', label: '需求时间', type: 'text', span: 8 },
    { name: 'total_plan_complete', label: '总计划完成', type: 'number', span: 8 },
    { name: 'remark', label: '备注', type: 'text', span: 16 },
  ],
}
