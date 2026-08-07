import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, message, Popconfirm, Space, Tag } from 'antd'
import { PlusOutlined, EyeOutlined, DownloadOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ProColumns, ActionType } from '@ant-design/pro-components'
import { ProTable } from '@ant-design/pro-components'
import dayjs from 'dayjs'
import { purchaseApi } from '../../../services/purchase'
import axios from 'axios'
import { useAuthStore } from '../../../store/auth'

const STATUS_MAP: Record<string, { text: string; color: string }> = {
  draft: { text: '草稿', color: 'default' }, pending: { text: '审批中', color: 'processing' },
  approved: { text: '已归档', color: 'success' }, rejected: { text: '已驳回', color: 'error' }, recalled: { text: '已撤回', color: 'warning' },
}

export default function PriceChangeList() {
  const navigate = useNavigate()
  const actionRef = useRef<ActionType>()
  const isAdmin = useAuthStore.getState().isAdmin()
  const canArchiveDelete = isAdmin || useAuthStore.getState().hasPermission('purchase.price_change.archive_delete', 'delete')

  const columns: ProColumns<any>[] = [
    { title: '调价单号', dataIndex: 'change_no', width: 180, fixed: 'left',
      render: (_, r) => <a onClick={() => navigate(`/purchase/price-change/${r.id}`)} style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.change_no}</a> },
    { title: '标题', dataIndex: 'title', width: 200, ellipsis: true, search: false },
    { title: '供应商', dataIndex: 'supplier_name', width: 180, ellipsis: true },
    { title: '类型', dataIndex: 'price_direction', width: 90,
      render: (_, r) => r.price_direction ? <Tag color={r.price_direction === '涨价' ? 'red' : r.price_direction === '降价' ? 'green' : 'blue'}>{r.price_direction}</Tag> : '-',
      valueType: 'select', valueEnum: { '涨价': '涨价', '降价': '降价', '新报价': '新报价' } },
    { title: '调价日期', dataIndex: 'change_date', width: 110, valueType: 'dateRange', search: { transform: (val: any) => ({ date_start: val[0], date_end: val[1] }) },
      render: (_: any, r: any) => r.change_date || '-' },
    { title: '状态', dataIndex: 'approval_status', width: 100,
      render: (_, r) => { const s = STATUS_MAP[r.approval_status] || STATUS_MAP.draft; return <Tag color={s.color}>{s.text}</Tag> },
      valueType: 'select', valueEnum: { draft: '草稿', pending: '审批中', approved: '已归档', rejected: '已驳回', recalled: '已撤回' } },
    { title: '自检', dataIndex: 'self_check_status', width: 90, search: false,
      render: (_, r) => {
        const sc: any = r.self_check_result
        let st = 'pending'
        try { st = (typeof sc === 'string' ? JSON.parse(sc) : sc)?.overall_status || r.self_check_status || 'pending' } catch { st = r.self_check_status || 'pending' }
        const map: Record<string, [string, string]> = { high: ['red', '高风险'], medium: ['orange', '中风险'], low: ['green', '通过'], pending: ['default', '未检'] }
        const [color, text] = map[st] || ['default', '-']
        return <Tag color={color} style={{ cursor: 'pointer' }} onClick={() => navigate(`/purchase/price-change/${r.id}`)}>{text}</Tag>
      } },
    { title: '申请人', dataIndex: 'applicant_display', width: 100,
      render: (_: any, r: any) => r.applicant_display || r.applicant || '-',
    },
    { title: '创建时间', dataIndex: 'created_at', width: 150, search: false,
      render: (_, r) => r.created_at ? dayjs(r.created_at).format('YYYY-MM-DD HH:mm') : '-' },
    { title: '操作', width: 120, fixed: 'right', search: false,
      render: (_, r) => (
        <Space>
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => navigate(`/purchase/price-change/${r.id}`)}>查看</Button>
          {(r.approval_status === 'draft' || r.approval_status === 'rejected' || r.approval_status === 'recalled' || (r.approval_status === 'approved' && canArchiveDelete)) && (
            <Popconfirm title="确认删除？" onConfirm={async () => { try { await purchaseApi.delete(r.id); message.success('已删除'); actionRef.current?.reload() } catch (e: any) { message.error(e.message || '删除失败') } }}>
              <Button size="small" type="link" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ) },
  ]

  return (
    <ProTable<any>
      actionRef={actionRef} columns={columns} rowKey="id"
      request={async (params) => {
        const res: any = await purchaseApi.list({
          page: params.current || 1, page_size: params.pageSize || 20,
          keyword: params.supplier_name || '',
          status: params.approval_status || '',
          applicant: params.applicant || '',
          date_start: params.date_start || '',
          date_end: params.date_end || '',
        })
        return { data: res.data?.items || [], total: res.data?.total || 0, success: true }
      }}
      search={{ labelWidth: 'auto', span: 6 }}
      scroll={{ x: 1300 }}
      pagination={{ pageSize: 20, showSizeChanger: true }}
      headerTitle="调价单管理"
      toolBarRender={() => [
        <Button key="export" icon={<DownloadOutlined />} onClick={async () => {
          try {
            const token = useAuthStore.getState().currentToken
            const res = await axios.get('/api/v1/purchase/price-change/export', {
              responseType: 'blob',
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            })
            const url = window.URL.createObjectURL(new Blob([res.data]))
            const a = document.createElement('a'); a.href = url; a.download = '调价单导出.csv'; a.click()
            window.URL.revokeObjectURL(url)
            message.success('导出成功')
          } catch (e: any) { message.error('导出失败') }
        }}>导出</Button>,
        <Button key="new" type="primary" icon={<PlusOutlined />} onClick={() => navigate('/purchase/price-change/new')}>新建调价单</Button>,
      ]}
      dateFormatter="string"
    />
  )
}
