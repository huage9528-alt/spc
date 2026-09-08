import { useEffect, useMemo, useState } from 'react'
import { Modal, Table, Button, Space, message, Empty, Tag, Input } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { orderApi } from '@/services/api'
import RecentDaysPicker from './RecentDaysPicker'

export interface OrderProductLine {
  line_no?: string | null
  product_code?: string | null
  product_name?: string | null
  product_model?: string | null
  bom_no?: string | null
  order_qty?: number | null
  promised_date?: string | null
  total_materials?: number | null
  materials?: any[]
}

export interface OrderProductSelection {
  product_code: string | null
  bom_no: string | null
}

interface Props {
  open: boolean
  orderNo: string
  coveredKeys?: Set<string>
  onCancel: () => void
  onCreate: (selected: OrderProductSelection[], recentDays: number) => void
  confirmLoading?: boolean
}

const rowKey = (r: OrderProductLine) =>
  `${r.product_code ?? ''}__${r.bom_no ?? ''}`

export default function OrderProductPickerModal({
  open, orderNo, coveredKeys, onCancel, onCreate, confirmLoading,
}: Props) {
  const [items, setItems] = useState<OrderProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [recentDays, setRecentDays] = useState<number | null>(99999) // 默认不限(全部历史);null=未选择(强制)

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return items
    return items.filter((it) =>
      (it.product_code || '').toLowerCase().includes(kw) ||
      (it.product_name || '').toLowerCase().includes(kw) ||
      (it.bom_no || '').toLowerCase().includes(kw) ||
      (it.line_no || '').toLowerCase().includes(kw),
    )
  }, [items, keyword])

  // 搜索结果只有 1 条时自动勾选（累积，不覆盖已有选择）；用户仍点「确定」
  useEffect(() => {
    if (filtered.length === 1) {
      const only = rowKey(filtered[0])
      setSelectedKeys((prev) => (prev.includes(only) ? prev : [...prev, only]))
    }
  }, [filtered])

  useEffect(() => {
    if (!open || !orderNo) return
    let cancelled = false
    setLoading(true)
    orderApi
      .getProductMaterials(orderNo)
      .then((res: any) => {
        if (cancelled) return
        const list: OrderProductLine[] = res?.data || []
        setItems(list)
        setKeyword('')
        // 默认只勾选尚未盘点的产品;若全部已盘点则默认全选(允许重盘)
        const uncovered = list.filter((it) => !(coveredKeys ?? new Set()).has(rowKey(it)))
        setSelectedKeys((uncovered.length > 0 ? uncovered : list).map(rowKey))
      })
      .catch((err: any) => {
        if (!cancelled) {
          message.error(err?.response?.data?.detail || err?.message || '加载订单产品行失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, orderNo, coveredKeys])

  // 关闭时重置免盘天数为默认「不限(全部历史)」
  useEffect(() => {
    if (!open) setRecentDays(99999)
  }, [open])

  const handleCreate = () => {
    if (recentDays == null) {
      message.warning('「近期已盘」免盘天数为必填项')
      return
    }
    const selected = items
      .filter((it) => selectedKeys.includes(rowKey(it)))
      .map((it) => ({ product_code: it.product_code ?? null, bom_no: it.bom_no ?? null }))
    if (selected.length === 0) {
      message.warning('请至少选择一个产品')
      return
    }
    onCreate(selected, recentDays)
  }

  const columns = [
    { title: '行号', dataIndex: 'line_no', width: 90, render: (v: any) => v || '—' },
    { title: '产品编码', dataIndex: 'product_code', width: 150 },
    { title: '产品名称', dataIndex: 'product_name', ellipsis: true },
    { title: '规格型号', dataIndex: 'product_model', width: 140, ellipsis: true, render: (v: any) => v || '—' },
    { title: 'BOM号', dataIndex: 'bom_no', width: 130, render: (v: any) => v || '—' },
    {
      title: '订单数量', dataIndex: 'order_qty', width: 100, align: 'right' as const,
      render: (v: any) => (v != null ? v : '—'),
    },
    {
      title: '物料数', dataIndex: 'total_materials', width: 90, align: 'right' as const,
      render: (v: any) => (v != null ? v : 0),
    },
    {
      title: '盘点状态', width: 100,
      render: (_: any, r: OrderProductLine) =>
        (coveredKeys ?? new Set()).has(rowKey(r))
          ? <Tag color="default">已盘点</Tag>
          : <Tag color="warning">未盘点</Tag>,
    },
  ]

  return (
    <Modal
      title={`选择产品盘点 — ${orderNo}`}
      open={open}
      onCancel={onCancel}
      width={960}
      destroyOnClose
      footer={
        <Space>
          <Button onClick={onCancel}>取消</Button>
          <Button
            onClick={() => setSelectedKeys(items.map(rowKey))}
            disabled={items.length === 0}
          >全选</Button>
          <Button
            onClick={() => setSelectedKeys([])}
            disabled={items.length === 0}
          >清空</Button>
          <Button
            type="primary" loading={confirmLoading} onClick={handleCreate}
            disabled={recentDays == null}
          >
            确定创建（已选{selectedKeys.length}项）
          </Button>
        </Space>
      }
    >
      <RecentDaysPicker value={recentDays} onChange={setRecentDays} required />
      {items.length === 0 && !loading ? (
        <Empty description="该订单未展开出任何产品行" />
      ) : (
        <Table
          rowKey={rowKey}
          dataSource={items}
          loading={loading}
          columns={columns}
          pagination={false}
          size="small"
          scroll={{ y: 420 }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: (keys) => setSelectedKeys(keys as string[]),
          }}
        />
      )}
    </Modal>
  )
}
