import { useState, useCallback, useEffect } from 'react'
import type { Key } from 'react'
import { Modal, Table, Button, Space, Tag, DatePicker, Select, message, Alert, Checkbox } from 'antd'
import { CloudDownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs, { Dayjs } from 'dayjs'
import { materialApi } from '@/services/api'

interface K3BillRow {
  erp_bill_no: string
  erp_inter_id: number
  tran_type: number
  type_label: string
  bill_date?: string | null
  wh_name?: string | null
  item_count: number
  diff_total: string | number
  imported: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  onImported: () => void
}

const { RangePicker } = DatePicker

export default function K3ImportModal({ open, onClose, onImported }: Props) {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(29, 'day'), dayjs()])
  const [tranType, setTranType] = useState<string>('all')
  const [rows, setRows] = useState<K3BillRow[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await materialApi.listK3GainLossBills({
        date_from: range[0].format('YYYY-MM-DD'),
        date_to: range[1].format('YYYY-MM-DD'),
        tran_type: tranType,
      })
      setRows(res.data ?? [])
      setSelectedKeys([])
    } catch (e: any) {
      message.error(e?.message || '拉取 K3 单据失败')
    } finally {
      setLoading(false)
    }
  }, [range, tranType])

  // 条件挂载:每次打开都重新 mount,首次加载一次;后续由「查询」按钮触发
  useEffect(() => {
    load()
  }, [])

  const handleImport = useCallback(async () => {
    const billNos = selectedKeys.map(String)
    if (!billNos.length) return
    setImporting(true)
    try {
      const res: any = await materialApi.importK3Bills(billNos)
      const r = res.data ?? {}
      const parts: string[] = []
      if (r.created?.length) parts.push(`成功 ${r.created.length} 张`)
      if (r.skipped?.length) parts.push(`跳过(已导入) ${r.skipped.length} 张`)
      if (r.failed?.length) parts.push(`失败 ${r.failed.length} 张: ${r.failed.map((f: any) => `${f.erp_bill_no}(${f.reason})`).join('、')}`)
      if (r.created?.length) message.success(parts.join('，'))
      else message.warning(parts.join('，'))
      onImported()
      await load()
    } catch (e: any) {
      message.error(e?.message || '导入失败')
    } finally {
      setImporting(false)
    }
  }, [selectedKeys, onImported, load])

  // 可导入行/全选状态(跨页): 数据为全量加载,表头勾选框直接选择全部未导入单据
  const importableKeys = rows.filter((r) => !r.imported).map((r) => r.erp_bill_no)
  const allSelected = importableKeys.length > 0 && importableKeys.every((k) => selectedKeys.includes(k))
  const someSelected = selectedKeys.length > 0

  const columns = [
    { title: 'K3 单号', dataIndex: 'erp_bill_no', width: 130 },
    {
      title: '类型', dataIndex: 'type_label', width: 70,
      render: (v: string, r: K3BillRow) => (
        <Tag color={r.tran_type === 40 ? 'green' : 'red'}>{v}</Tag>
      ),
    },
    { title: '日期', dataIndex: 'bill_date', width: 105, render: (v: any) => v ? String(v).slice(0, 10) : '-' },
    { title: '仓库', dataIndex: 'wh_name', width: 110, ellipsis: true, render: (v: any) => v || '-' },
    { title: '物料数', dataIndex: 'item_count', width: 75, align: 'right' as const },
    {
      title: '差异合计', dataIndex: 'diff_total', width: 95, align: 'right' as const,
      render: (v: any) => Number(v ?? 0).toFixed(2),
    },
    {
      title: '状态', dataIndex: 'imported', width: 85,
      render: (v: boolean) => v ? <Tag>已导入</Tag> : <Tag color="processing">未导入</Tag>,
    },
  ]

  return (
    <Modal
      title="从 K3 导入盘盈盘亏单"
      open={open}
      width={860}
      onCancel={onClose}
      destroyOnClose
      footer={
        <Space>
          <span style={{ float: 'left', marginRight: 'auto', color: '#888' }}>
            已选 {selectedKeys.length} 张（跨页累计；表头勾选框=选择/取消全部未导入单据；已导入的单不可重复导入）
          </span>
          <Button onClick={onClose}>关闭</Button>
          <Button
            type="primary"
            icon={<CloudDownloadOutlined />}
            loading={importing}
            disabled={!selectedKeys.length}
            onClick={handleImport}
          >
            导入所选
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="仅显示 K3 中已审核、未作废的单据：盘盈入库单(盘盈)与调入「库存检查不良仓」的仓库调拨单(盘亏)。每张 K3 单生成一张直接完结的盘点单；盘亏行按 账面=调拨数/实盘=0/差异=-调拨数 记录，仓库显示调出仓库。"
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <RangePicker value={range} onChange={(v) => v && setRange(v as [Dayjs, Dayjs])} />
        <Select
          value={tranType}
          style={{ width: 100 }}
          onChange={setTranType}
          options={[
            { value: 'all', label: '全部' },
            { value: '40', label: '盘盈' },
            { value: '41', label: '盘亏调拨' },
          ]}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>查询</Button>
        <Button disabled={!selectedKeys.length} onClick={() => setSelectedKeys([])}>清空选择</Button>
      </Space>
      <Table
        rowKey="erp_bill_no"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 10, showSizeChanger: false }}
        columns={columns}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: setSelectedKeys,
          columnTitle: (
            <Checkbox
              checked={allSelected}
              indeterminate={someSelected && !allSelected}
              disabled={!importableKeys.length}
              onChange={(e) => setSelectedKeys(e.target.checked ? importableKeys : [])}
            />
          ),
          getCheckboxProps: (r: K3BillRow) => ({ disabled: r.imported }),
        }}
      />
    </Modal>
  )
}
