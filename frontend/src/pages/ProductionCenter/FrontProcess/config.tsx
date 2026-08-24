import type { ColumnsType } from 'antd/es/table'
import { productionApi } from '../../../services/api'
import { formatDate } from '../../../utils'
import type { ProcessCrudConfig } from '../components/ProcessCrudPage'

export interface FrontRow {
  task_id: number | null
  task_no: string | null
  workshop: string | null
  material_code: string | null
  material_name: string | null
  sale_order_no: string | null
  task_qty: number | null
  planned_start_date: string | null
  planned_end_date: string | null
  actual_start_date: string | null
  actual_end_date: string | null
  is_closed: number | null
  customer_code: string | null
  customer: string | null
  order_date: string | null
  promised_date: string | null
  product_name: string | null
  product_model: string | null
  shell_status: string | null
  frame_status: string | null
  handle_status: string | null
  bracket_status: string | null
  remark: string | null
  status: string
}

const columns: ColumnsType<FrontRow> = [
  { title: '任务单号', dataIndex: 'task_no', width: 140 },
  { title: '车间', dataIndex: 'workshop', width: 100 },
  { title: '物料代码', dataIndex: 'material_code', width: 140 },
  { title: '物料名称', dataIndex: 'material_name', width: 200 },
  { title: '销售订单号', dataIndex: 'sale_order_no', width: 150 },
  { title: '客户代码', dataIndex: 'customer_code', width: 100, ellipsis: true },
  { title: '客户', dataIndex: 'customer', width: 140, ellipsis: true },
  { title: '下单日期', dataIndex: 'order_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '交期', dataIndex: 'promised_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '数量', dataIndex: 'task_qty', width: 80, sorter: (a: FrontRow, b: FrontRow) => (a.task_qty || 0) - (b.task_qty || 0) },
  { title: '计划开工', dataIndex: 'planned_start_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '计划完工', dataIndex: 'planned_end_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '产品名称', dataIndex: 'product_name', width: 180, ellipsis: true },
  { title: '产品型号', dataIndex: 'product_model', width: 140, ellipsis: true },
  { title: '壳体', dataIndex: 'shell_status', width: 80, ellipsis: true },
  { title: '框', dataIndex: 'frame_status', width: 80, ellipsis: true },
  { title: '手杆', dataIndex: 'handle_status', width: 80, ellipsis: true },
  { title: '支架圆盘', dataIndex: 'bracket_status', width: 90, ellipsis: true },
  { title: '备注', dataIndex: 'remark', width: 120, ellipsis: true },
]

export const frontProcessConfig: ProcessCrudConfig<FrontRow> = {
  editModalTitle: '编辑前道记录',
  editModalWidth: 700,
  tableScrollX: 2320,
  searchPlaceholder: '搜索任务单号/物料/订单号/客户',
  showImport: false,
  keyField: 'task_id',
  api: {
    list: productionApi.listFrontProcess,
    update: productionApi.updateFrontProcess,
  },
  columns,
  checkFields: ['shell_status', 'frame_status', 'handle_status', 'bracket_status'],
  extraFilters: [
    { name: 'sale_order_no', placeholder: '销售订单号', type: 'text', width: 150 },
    { name: 'year', placeholder: '计划开工年份', type: 'year', width: 130 },
    {
      name: 'workshop',
      placeholder: '车间',
      type: 'select',
      width: 130,
      options: [
        { label: '喷塑车间', value: '喷塑车间' },
        { label: '压铸车间', value: '压铸车间' },
      ],
    },
  ],
  rowClassName: (row) => row.status === 'overdue' ? 'ant-table-row-danger' : row.status === 'abnormal' ? 'ant-table-row-warning' : '',
  formFields: [
    { name: 'shell_status', label: '壳体', type: 'number', span: 6 },
    { name: 'frame_status', label: '框', type: 'number', span: 6 },
    { name: 'handle_status', label: '手杆', type: 'number', span: 6 },
    { name: 'bracket_status', label: '支架圆盘', type: 'number', span: 6 },
    { name: 'remark', label: '备注', type: 'text', span: 24 },
  ],
}

