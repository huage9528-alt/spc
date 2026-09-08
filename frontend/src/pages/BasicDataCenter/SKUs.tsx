import { useCallback, useEffect, useState, type CSSProperties, type Key } from 'react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Select, message,
  Popconfirm, Row, Col, Tooltip, type TableColumnsType,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  SearchOutlined, ExportOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../../services/api'
import PermButton from '../../components/PermButton'
import { useAuthStore } from '../../store/auth'
import KpiBand, { type KpiItem } from './components/KpiBand'
import ChipsFilter, { type ChipOption } from './components/ChipsFilter'
import BatchBar, { batchBarPad } from './components/BatchBar'
import BdDrawer, { DrawerSection, KvGrid } from './components/BdDrawer'
import { useBdTable } from './components/useBdTable'

interface SKU {
  id: number
  sku_code: string
  material_id: number
  sku_name: string
  attr_json?: string | null
  barcode?: string | null
  gross_weight?: number | null
  net_weight?: number | null
  volume?: number | null
  create_time: string
}

interface SkuStats {
  total: number
  with_barcode: number
  without_barcode: number
}

interface MaterialBrief {
  material_name: string
  material_code: string
  spec_model?: string | null
  unit_of_measure?: string | null
}

const DELETE_CONFIRM = '确认删除该 SKU？删除前系统将校验是否存在关联订单。'

const FORM_NOTE = '提示：条码用于 PDA 扫码出入库与盘点快速定位。缺少条码的 SKU 将在「缺条码」筛选中持续提示，建议在打样确认后立即补录。'

const CSV_HEADER = ['SKU编码', 'SKU名称', '物料编码', '物料名称', '条形码', '毛重(KG)', '净重(KG)', '体积(CBM)', '创建时间']

const ATTR_BOX_STYLE: CSSProperties = {
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 'calc(11.5px * var(--font-size-scale))',
  fontFamily: 'ui-monospace, Consolas, monospace',
  color: '#475569',
  lineHeight: 1.7,
  wordBreak: 'break-all',
  whiteSpace: 'pre-wrap',
}

const SkuTag = () => (
  <span
    style={{
      flexShrink: 0,
      width: 34,
      height: 20,
      borderRadius: 5,
      background: '#eef0fe',
      color: '#5b5bd6',
      border: '1px solid #c6cbfa',
      fontSize: 9.5,
      fontWeight: 700,
      letterSpacing: '.03em',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    SKU
  </span>
)

const NoBarcodeTag = () => (
  <span
    style={{
      display: 'inline-block',
      fontSize: 11,
      fontWeight: 600,
      color: '#d97706',
      background: '#fffbeb',
      border: '1px solid #fde68a',
      borderRadius: 999,
      padding: '0 7px',
      lineHeight: '16px',
      whiteSpace: 'nowrap',
    }}
  >
    缺条码
  </span>
)

const toBrief = (m: any): MaterialBrief => ({
  material_name: m.material_name,
  material_code: m.material_code,
  spec_model: m.spec_model ?? null,
  unit_of_measure: m.unit_of_measure ?? null,
})

const formatNum = (v?: number | string | null) =>
  v === null || v === undefined || v === '' ? (
    <span className="sc-note">—</span>
  ) : (
    <span className="sc-mono">{v}</span>
  )

const prettyAttr = (v?: string | null) => {
  if (!v) return null
  try {
    return JSON.stringify(JSON.parse(v), null, 2)
  } catch {
    return v
  }
}

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const exportSkusCsv = (rows: SKU[], matMap: Record<number, MaterialBrief>, filename: string) => {
  if (rows.length === 0) return
  const lines = [
    CSV_HEADER,
    ...rows.map((r) => {
      const m = matMap[r.material_id]
      return [
        r.sku_code,
        r.sku_name,
        m?.material_code || '',
        m?.material_name || '',
        r.barcode || '',
        r.gross_weight ?? '',
        r.net_weight ?? '',
        r.volume ?? '',
        r.create_time ? dayjs(r.create_time).format('YYYY-MM-DD') : '',
      ]
    }),
  ]
  const csv = '\ufeff' + lines.map((l) => l.map(csvEscape).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function SKUs() {
  const [stats, setStats] = useState<SkuStats>({ total: 0, with_barcode: 0, without_barcode: 0 })
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<SKU | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<SKU | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([])
  const [selectedMap, setSelectedMap] = useState<Record<number, SKU>>({})
  const [searchText, setSearchText] = useState('')
  const [matMap, setMatMap] = useState<Record<number, MaterialBrief>>({})
  const [materialOptions, setMaterialOptions] = useState<Array<{ label: string; value: number }>>([])
  const [materialSearching, setMaterialSearching] = useState(false)
  const [form] = Form.useForm()

  const watchMaterialId = Form.useWatch('material_id', form)
  const selectedMaterial = watchMaterialId != null ? matMap[watchMaterialId] : undefined

  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data.skus', 'delete')

  const extraQuery = useCallback((chip: string | number | null): Record<string, any> => {
    if (chip === 'bc') return { has_barcode: true }
    if (chip === 'nobc') return { has_barcode: false }
    return {}
  }, [])

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<SKU>({ url: '/basicdata/skus', extraQuery, chipInit: 'all' })

  const onSearchChange = (v: string) => {
    setSearchText(v)
    setKeywordInput(v)
  }

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/skus/stats')
      setStats({
        total: res.data?.total || 0,
        with_barcode: res.data?.with_barcode || 0,
        without_barcode: res.data?.without_barcode || 0,
      })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  useEffect(() => {
    const ids = Array.from(new Set(items.map((it) => it.material_id).filter((v) => v != null))).slice(0, 200)
    if (ids.length === 0) {
      setMatMap({})
      return
    }
    let alive = true
    const next: Record<number, MaterialBrief> = {}
    const missing = new Set<number>(ids)
    const chunks: number[][] = []
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100))
    ;(async () => {
      await Promise.allSettled(
        chunks.map(async (c) => {
          const res: any = await api.get('/basicdata/materials', {
            params: { page: 1, page_size: 100, ids: c.join(',') },
          })
          for (const m of res.data?.items || []) {
            if (missing.has(m.id)) {
              next[m.id] = toBrief(m)
              missing.delete(m.id)
            }
          }
        }),
      )
      await Promise.allSettled(
        Array.from(missing).map(async (mid) => {
          const res: any = await api.get(`/basicdata/materials/${mid}`, { skipErrorToast: true } as any)
          if (res.data) next[mid] = toBrief(res.data)
        }),
      )
      if (alive) setMatMap(next)
    })()
    return () => {
      alive = false
    }
  }, [items])

  const refreshAll = useCallback(() => {
    reload()
    fetchStats()
  }, [reload, fetchStats])

  const clearSelection = () => {
    setSelectedRowKeys([])
    setSelectedMap({})
  }

  const handleAdd = () => {
    setEditingItem(null)
    form.resetFields()
    setMaterialOptions([])
    setModalVisible(true)
  }

  const handleEdit = (item: SKU) => {
    setEditingItem(item)
    form.resetFields()
    form.setFieldsValue({ ...item })
    const brief = matMap[item.material_id]
    if (brief) {
      setMaterialOptions([{ label: `${brief.material_name} · ${brief.material_code}`, value: item.material_id }])
    } else {
      api.get(`/basicdata/materials/${item.material_id}`, { skipErrorToast: true } as any)
        .then((res: any) => {
          if (!res.data) return
          const nb = toBrief(res.data)
          setMatMap((prev) => ({ ...prev, [item.material_id]: nb }))
          setMaterialOptions([{ label: `${nb.material_name} · ${nb.material_code}`, value: item.material_id }])
        })
        .catch(() => {
          // 错误已由全局拦截器提示
        })
    }
    setModalVisible(true)
  }

  const openDrawer = (item: SKU) => {
    setDrawerItem(item)
    setDrawerOpen(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/basicdata/skus/${id}`)
      message.success('删除成功')
      if (drawerOpen && drawerItem?.id === id) setDrawerOpen(false)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      if (editingItem) {
        await api.put(`/basicdata/skus/${editingItem.id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/skus', values)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const handleMaterialSearch = async (kw: string) => {
    if (!kw.trim()) return
    setMaterialSearching(true)
    try {
      const res: any = await api.get('/basicdata/materials', {
        params: { page: 1, page_size: 20, keyword: kw.trim() },
      })
      const list: any[] = res.data?.items || []
      setMatMap((prev) => {
        const merged = { ...prev }
        for (const m of list) {
          if (m.erp_material_id != null && !merged[m.erp_material_id]) merged[m.erp_material_id] = toBrief(m)
        }
        return merged
      })
      setMaterialOptions(list.map((m) => ({ label: `${m.material_name} · ${m.material_code}`, value: m.erp_material_id })))
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setMaterialSearching(false)
    }
  }

  const getSelectedRows = () =>
    selectedRowKeys.map((k) => selectedMap[Number(k)]).filter((r): r is SKU => r != null)

  const handleExportSelected = () => {
    exportSkusCsv(getSelectedRows(), matMap, `SKU主数据_${dayjs().format('YYYY-MM-DD')}.csv`)
  }

  const barcodeRate = stats.total > 0 ? `${Math.round((stats.with_barcode / stats.total) * 100)}%` : '—'

  const kpiItems: KpiItem[] = [
    { label: 'SKU 总数', value: stats.total.toLocaleString(), sub: `条码完善率 ${barcodeRate}`, accent: 'brand' },
    { label: '有条码', value: stats.with_barcode.toLocaleString(), sub: '支持扫码出入库 / 盘点', accent: 'success' },
    { label: '缺条码', value: stats.without_barcode.toLocaleString(), go: '点击筛选待维护 →', accent: 'danger', onClick: () => setChip('nobc') },
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    { label: '有条码', value: 'bc', count: stats.with_barcode },
    { label: '缺条码', value: 'nobc', count: stats.without_barcode, hot: true },
  ]

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: Key[], rows: SKU[]) => {
      setSelectedRowKeys(keys)
      const byKey = new Map(rows.map((r) => [r.id, r]))
      setSelectedMap((prev) => {
        const next: Record<number, SKU> = {}
        for (const k of keys) {
          const m = byKey.get(Number(k)) ?? prev[Number(k)]
          if (m) next[Number(k)] = m
        }
        return next
      })
    },
  }

  const orderOf = (field: string): 'ascend' | 'descend' | null =>
    sortBy === field ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null

  const columns: TableColumnsType<SKU> = [
    {
      title: 'SKU',
      dataIndex: 'sku_code',
      key: 'sku_code',
      width: 250,
      sorter: true,
      sortOrder: orderOf('sku_code'),
      render: (_: any, record: SKU) => (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SkuTag />
            <span className="sc-mat-name" style={{ cursor: 'pointer' }} onClick={() => openDrawer(record)}>
              {record.sku_name}
            </span>
          </div>
          <div className="sc-mat-code" style={{ marginTop: 1 }}>{record.sku_code}</div>
        </div>
      ),
    },
    {
      title: '关联物料',
      dataIndex: 'material_id',
      key: 'material_id',
      width: 220,
      sorter: true,
      sortOrder: orderOf('material_id'),
      render: (v: number) => {
        const m = matMap[v]
        if (!m) return <span className="sc-mono" style={{ color: '#94a3b8' }}>#{v}</span>
        return (
          <div>
            <div className="sc-mat-name">{m.material_name}</div>
            <div className="sc-mat-code">{m.material_code}</div>
          </div>
        )
      },
    },
    {
      title: '条形码',
      dataIndex: 'barcode',
      key: 'barcode',
      width: 150,
      sorter: true,
      sortOrder: orderOf('barcode'),
      render: (v: string) => (v ? <span className="sc-mono">{v}</span> : <NoBarcodeTag />),
    },
    {
      title: '毛重 KG',
      dataIndex: 'gross_weight',
      key: 'gross_weight',
      width: 95,
      align: 'right',
      render: (v: number | null) => formatNum(v),
    },
    {
      title: '净重 KG',
      dataIndex: 'net_weight',
      key: 'net_weight',
      width: 95,
      align: 'right',
      render: (v: number | null) => formatNum(v),
    },
    {
      title: '体积 CBM',
      dataIndex: 'volume',
      key: 'volume',
      width: 100,
      align: 'right',
      render: (v: number | null) => formatNum(v),
    },
    {
      title: '创建时间',
      dataIndex: 'create_time',
      key: 'create_time',
      width: 110,
      render: (v: string) => (v ? <span className="sc-mono">{dayjs(v).format('YYYY-MM-DD')}</span> : <span className="sc-note">—</span>),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: any, record: SKU) => (
        <span className="sc-row-act">
          <Button type="text" size="small" onClick={() => openDrawer(record)}>详情</Button>
          <PermButton permResource="basicdata.data.skus" permAction="update" type="text" size="small" onClick={() => handleEdit(record)}>编辑</PermButton>
          <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(record.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
            <PermButton permResource="basicdata.data.skus" permAction="delete" type="text" size="small" danger>删除</PermButton>
          </Popconfirm>
        </span>
      ),
    },
  ]

  return (
    <div className="sc-page" style={{ paddingBottom: batchBarPad(selectedRowKeys.length) }}>
      <KpiBand items={kpiItems} />

      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="SKU 编码 / 名称 / 条码 / 物料"
            style={{ width: 250 }}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            onPressEnter={commitKeyword}
          />
        </span>
        <ChipsFilter options={chipOptions} value={chip ?? 'all'} onChange={(v) => setChip(v)} />
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={refreshAll} />
          </Tooltip>
          <span style={{ width: 1, height: 20, background: '#e2e8f0' }} />
          <Button
            icon={<ExportOutlined />}
            onClick={() => exportSkusCsv(items, matMap, `SKU主数据_${dayjs().format('YYYY-MM-DD')}.csv`)}
          >
            导出
          </Button>
          <PermButton permResource="basicdata.data.skus" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增 SKU
          </PermButton>
        </span>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          size="small"
          rowSelection={rowSelection}
          scroll={{ x: 1050 }}
          onChange={onTableChange}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t: number) => `共 ${t} 条`,
            pageSizeOptions: ['20', '50', '100'],
          }}
        />
      </div>

      <BatchBar count={selectedRowKeys.length} onClear={clearSelection}>
        <Tooltip title="待打码设备接入">
          <span>
            <Button size="small" disabled>批量生成条码</Button>
          </span>
        </Tooltip>
        <Button size="small" icon={<ExportOutlined />} onClick={handleExportSelected}>导出所选</Button>
      </BatchBar>

      <BdDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={drawerItem?.sku_name}
        code={drawerItem?.sku_code}
        tags={drawerItem && (drawerItem.barcode
          ? <span className="sc-tag sc-tag-done"><span className="dot" />有条码</span>
          : <span className="sc-tag sc-tag-warn"><span className="dot" />缺条码</span>)}
        actions={drawerItem && (
          <>
            <PermButton permResource="basicdata.data.skus" permAction="update" type="primary" size="small" icon={<EditOutlined />} onClick={() => handleEdit(drawerItem)}>编辑</PermButton>
            <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(drawerItem.id)} okText="确认" cancelText="取消" disabled={!canDelete}>
              <PermButton permResource="basicdata.data.skus" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
            </Popconfirm>
          </>
        )}
      >
        {drawerItem && (
          <div style={{ marginTop: 12 }}>
            <DrawerSection title="关联物料">
              <KvGrid
                items={[
                  ['物料名称', matMap[drawerItem.material_id]
                    ? matMap[drawerItem.material_id].material_name
                    : <span className="sc-mono" key="mi">#{drawerItem.material_id}</span>],
                  ['物料编码', <span className="sc-mono" key="mc">{matMap[drawerItem.material_id]?.material_code || '—'}</span>],
                  ['规格型号', matMap[drawerItem.material_id]?.spec_model || '—'],
                  ['计量单位', matMap[drawerItem.material_id]?.unit_of_measure || '—'],
                ]}
              />
            </DrawerSection>
            <DrawerSection title="包装与条码">
              <KvGrid
                items={[
                  ['条形码', drawerItem.barcode
                    ? <span className="sc-mono" key="bc">{drawerItem.barcode}</span>
                    : <NoBarcodeTag key="nobc" />],
                  ['毛重', drawerItem.gross_weight != null ? <span className="sc-mono" key="gw">{drawerItem.gross_weight} KG</span> : '—'],
                  ['净重', drawerItem.net_weight != null ? <span className="sc-mono" key="nw">{drawerItem.net_weight} KG</span> : '—'],
                  ['体积', drawerItem.volume != null ? <span className="sc-mono" key="vol">{drawerItem.volume} CBM</span> : '—'],
                ]}
              />
            </DrawerSection>
            <DrawerSection title="扩展属性（attr_json）">
              {drawerItem.attr_json
                ? <div style={ATTR_BOX_STYLE}>{prettyAttr(drawerItem.attr_json)}</div>
                : <span className="sc-note">—</span>}
            </DrawerSection>
          </div>
        )}
      </BdDrawer>

      <Modal
        title={editingItem ? '编辑 SKU' : '新增 SKU'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={680}
        rootClassName="sc-page"
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="sku_code" label="SKU 编码" rules={[{ required: true }]}>
                <Input placeholder="如 SKU-TC100-T3（唯一）" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="sku_name" label="SKU 名称" rules={[{ required: true }]}>
                <Input placeholder="如 TC-100 温控器 · 新版本" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="material_id" label="关联物料" rules={[{ required: true }]}>
                <Select
                  showSearch
                  allowClear
                  filterOption={false}
                  placeholder="搜索物料编码 / 名称选择"
                  notFoundContent={materialSearching ? '搜索中…' : undefined}
                  loading={materialSearching}
                  onSearch={handleMaterialSearch}
                  options={materialOptions}
                />
              </Form.Item>
              {selectedMaterial && (
                <div style={{ fontSize: 'calc(11.5px * var(--font-size-scale))', color: '#16a34a', marginTop: -18, marginBottom: 8 }}>
                  ✓ 已选中 · {selectedMaterial.material_name} · {selectedMaterial.material_code}
                </div>
              )}
            </Col>
            <Col span={12}>
              <Form.Item name="barcode" label="条形码">
                <Input placeholder="13 位 EAN-13 · 选填" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="gross_weight" label="毛重 KG">
                <InputNumber style={{ width: '100%' }} placeholder="0.000" min={0} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="net_weight" label="净重 KG">
                <InputNumber style={{ width: '100%' }} placeholder="0.000" min={0} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="volume" label="体积 CBM">
                <InputNumber style={{ width: '100%' }} placeholder="0.0000" min={0} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="attr_json" label="扩展属性 JSON">
                <Input.TextArea placeholder='{ "key": "value" }' rows={3} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <div className="f-note">{FORM_NOTE}</div>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
