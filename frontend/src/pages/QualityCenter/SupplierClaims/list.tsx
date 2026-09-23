import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, message, Popconfirm, Space, Tag } from 'antd'
import { PlusOutlined, EyeOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ProColumns, ActionType } from '@ant-design/pro-components'
import { ProTable } from '@ant-design/pro-components'
import dayjs from 'dayjs'
import { qualityApi, CLAIM_STATUS_MAP, CLAIM_REASON_OPTIONS } from '../../../services/quality'
import { useAuthStore } from '../../../store/auth'

const ITEM_LABELS: Record<string, string> = {
  replacement: '替代件', packing_fee: '包装', transporting_fee: '运输', man_hour_fee: '人工',
  additional_fee: '额外', punishment: '处罚', downgrade_use: '降级使用', direct_loss: '直接损失',
}

export default function SupplierClaimList() {
  const navigate = useNavigate()
  const actionRef = useRef<ActionType>()
  const isAdmin = useAuthStore.getState().isAdmin()
  const canArchiveDelete = isAdmin || useAuthStore.getState().hasPermission('quality.supplier_claim.archive_delete', 'delete')

  const columns: ProColumns<any>[] = [
    { title: '索赔单号', dataIndex: 'claim_no', width: 160, fixed: 'left',
      render: (_, r) => <a onClick={() => navigate(`/quality/supplier-claims/${r.id}`)} style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.claim_no}</a> },
    { title: '供应商', dataIndex: 'supplier_name', width: 200, ellipsis: true },
    { title: '索赔原因', dataIndex: 'claim_reason', width: 130,
      render: (_, r) => <Tag color={r.claim_reason === 'field_customer_claim' ? 'red' : 'blue'}>{CLAIM_REASON_OPTIONS.find(o => o.value === r.claim_reason)?.label?.split(' ')[0] || '-'}</Tag>,
      valueType: 'select', valueEnum: Object.fromEntries(CLAIM_REASON_OPTIONS.map(o => [o.value, o.label.split(' ')[0]])) },
    { title: '索赔细项', dataIndex: 'claim_items', width: 200, search: false,
      render: (_, r) => <Space size={4} wrap>{(r.claim_items || []).map((i: string) => <Tag key={i}>{ITEM_LABELS[i] || i}</Tag>)}</Space> },
    { title: '索赔金额(元)', dataIndex: 'claim_amount', width: 120, search: false, align: 'right',
      render: (_, r) => r.claim_amount != null ? Number(r.claim_amount).toLocaleString() : '-' },
    { title: '开单日期', dataIndex: 'claim_date', width: 110, valueType: 'dateRange',
      search: { transform: (val: any) => ({ date_start: val[0], date_end: val[1] }) },
      render: (_: any, r: any) => r.claim_date || '-' },
    { title: '状态', dataIndex: 'approval_status', width: 100,
      render: (_, r) => { const s = CLAIM_STATUS_MAP[r.approval_status] || CLAIM_STATUS_MAP.draft; return <Tag color={s.color}>{s.text}</Tag> },
      valueType: 'select', valueEnum: { draft: '草稿', pending: '审批中', approved: '已归档', rejected: '已驳回', recalled: '已撤回' } },
    { title: '申请人', dataIndex: 'applicant_display', width: 100,
      render: (_: any, r: any) => r.applicant_display || r.applicant || '-' },
    { title: '创建时间', dataIndex: 'created_at', width: 150, search: false,
      render: (_, r) => r.created_at ? dayjs(r.created_at).format('YYYY-MM-DD HH:mm') : '-' },
    { title: '操作', width: 110, fixed: 'right', search: false,
      render: (_, r) => (
        <Space>
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => navigate(`/quality/supplier-claims/${r.id}`)}>查看</Button>
          {(r.approval_status === 'draft' || r.approval_status === 'rejected' || r.approval_status === 'recalled' || (r.approval_status === 'approved' && canArchiveDelete)) && (
            <Popconfirm title="确认删除？" onConfirm={async () => {
              try { await qualityApi.delete(r.id, canArchiveDelete); message.success('已删除'); actionRef.current?.reload() } catch { /* 全局拦截器已提示 */ }
            }}>
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
        const res: any = await qualityApi.list({
          page: params.current || 1, page_size: params.pageSize || 20,
          status: params.approval_status || '',
          applicant: params.applicant || '', supplier: params.supplier_name || '',
          date_start: params.date_start || '', date_end: params.date_end || '',
        })
        return { data: res.data?.items || [], total: res.data?.total || 0, success: true }
      }}
      search={{ labelWidth: 'auto', span: 6 }}
      scroll={{ x: 1300 }}
      pagination={{ pageSize: 20, showSizeChanger: true }}
      headerTitle="供应商索赔单"
      toolBarRender={() => [
        <Button key="new" type="primary" icon={<PlusOutlined />} onClick={() => navigate('/quality/supplier-claims/new')}>新建索赔单</Button>,
      ]}
      dateFormatter="string"
    />
  )
}
