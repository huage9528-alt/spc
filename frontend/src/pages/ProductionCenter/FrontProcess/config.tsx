import type { ColumnsType } from 'antd/es/table'
import { productionApi } from '../../../services/api'
import { formatDate } from '../../../utils'
import type { ProcessCrudConfig } from '../components/ProcessCrudPage'

export interface FrontRow {
  id: number
  customer_code: string | null
  sale_order_no: string | null
  order_date: string | null
  model_code: string | null
  color_spec: string | null
  qty: number | null
  delivery_date: string | null
  by_style: number | null
  shell_status: string | null
  frame_status: string | null
  handle_status: string | null
  bracket_status: string | null
  product_name: string | null
  remark: string | null
  status: string
}

const columns: ColumnsType<FrontRow> = [
  { title: '客户代码', dataIndex: 'customer_code', width: 110, ellipsis: true },
  { title: '销售订单号', dataIndex: 'sale_order_no', width: 150, ellipsis: true },
  { title: '下单日期', dataIndex: 'order_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '型号', dataIndex: 'model_code', width: 180, ellipsis: true },
  { title: '颜色', dataIndex: 'color_spec', width: 120, ellipsis: true },
  { title: '数量', dataIndex: 'qty', width: 70, sorter: (a: FrontRow, b: FrontRow) => (a.qty || 0) - (b.qty || 0) },
  { title: '交期', dataIndex: 'delivery_date', width: 90, render: (v: string) => formatDate(v) },
  { title: '按款', dataIndex: 'by_style', width: 60 },
  { title: '壳体', dataIndex: 'shell_status', width: 80, ellipsis: true },
  { title: '框', dataIndex: 'frame_status', width: 80, ellipsis: true },
  { title: '手杆', dataIndex: 'handle_status', width: 80, ellipsis: true },
  { title: '支架圆盘', dataIndex: 'bracket_status', width: 90, ellipsis: true },
  { title: '产品名称', dataIndex: 'product_name', width: 200, ellipsis: true },
  { title: '备注', dataIndex: 'remark', width: 120, ellipsis: true },
]

export const frontProcessConfig: ProcessCrudConfig<FrontRow> = {
  editModalTitle: '编辑前道记录',
  editModalWidth: 700,
  tableScrollX: 1800,
  searchPlaceholder: '搜索型号/订单号/产品',
  api: {
    list: productionApi.listFrontProcess,
    update: productionApi.updateFrontProcess,
    importCsv: productionApi.importFrontProcess,
  },
  columns,
  rowClassName: (row) => row.status === 'overdue' ? 'ant-table-row-danger' : row.status === 'abnormal' ? 'ant-table-row-warning' : '',
  formFields: [
    { name: 'customer_code', label: '客户代码', type: 'text', span: 8 },
    { name: 'sale_order_no', label: '销售订单号', type: 'text', span: 8 },
    { name: 'model_code', label: '型号', type: 'text', span: 8 },
    { name: 'color_spec', label: '颜色', type: 'text', span: 8 },
    { name: 'qty', label: '数量', type: 'number', span: 8 },
    { name: 'delivery_date', label: '交期', type: 'date', span: 8 },
    { name: 'shell_status', label: '壳体', type: 'text', span: 6 },
    { name: 'frame_status', label: '框', type: 'text', span: 6 },
    { name: 'handle_status', label: '手杆', type: 'text', span: 6 },
    { name: 'bracket_status', label: '支架圆盘', type: 'text', span: 6 },
    { name: 'product_name', label: '产品名称', type: 'text', span: 16 },
    { name: 'remark', label: '备注', type: 'text', span: 8 },
  ],
}
