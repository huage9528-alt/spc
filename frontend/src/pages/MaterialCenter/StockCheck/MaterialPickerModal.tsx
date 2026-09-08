import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Input, Table, Button, Space, message, Pagination, Spin, Tabs, Empty, Popconfirm, Tag, Tooltip } from 'antd'
import { SearchOutlined, ClearOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { materialApi } from '@/services/api'
import { useStockCheckPoolStore, PoolMaterial, poolKey } from '@/store/stockCheckPool'
import RecentDaysPicker from './RecentDaysPicker'

interface MaterialCandidate {
  erp_material_id: number
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  system_qty?: number | null
  // wh_id === undefined 表示旧版池数据(整物料全仓库); null 表示未入库合成行
  wh_id?: number | null
  wh_code?: string | null
  wh_name?: string | null
  recent_checked_check_no?: string | null
  recent_checked_date?: string | null
}

interface Props {
  open: boolean
  onCancel: () => void
  onConfirm: (selected: MaterialCandidate[], source: 'search' | 'pool', recentDays: number | null) => void
  confirmLoading?: boolean
  /** true=显示「近期已盘」免盘范围面板(手动建单);不传=不显示(向已有单追加明细) */
  showRecentDays?: boolean
}

type TabKey = 'search' | 'pool'

function rowKey(row: Pick<MaterialCandidate, 'erp_material_id' | 'wh_id'>): string {
  return poolKey(row)
}

export default function MaterialPickerModal({ open, onCancel, onConfirm, confirmLoading, showRecentDays }: Props) {
  const [keyword, setKeyword] = useState('')
  const [whFilter, setWhFilter] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [items, setItems] = useState<MaterialCandidate[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedMap, setSelectedMap] = useState<Record<string, MaterialCandidate>>({})
  // null=未选择(不标记);99999=不限(全部历史);>=0=天数。手动建单默认不限。
  const [recentDays, setRecentDays] = useState<number | null>(showRecentDays ? 99999 : null)

  const [activeTab, setActiveTab] = useState<TabKey>('search')
  const [poolSelectedIds, setPoolSelectedIds] = useState<string[]>([])
  const [poolKeyword, setPoolKeyword] = useState('')

  const poolItems = useStockCheckPoolStore((s) => s.items)
  const poolAdd = useStockCheckPoolStore((s) => s.add)
  const poolRemove = useStockCheckPoolStore((s) => s.remove)
  const poolClear = useStockCheckPoolStore((s) => s.clear)
  const poolHas = useStockCheckPoolStore((s) => s.has)

  // ===== 表格高度自适应: 弹窗整体不超出视口,最外层不出滚动条 =====
  const rdpRef = useRef<HTMLDivElement>(null)
  const [tableY, setTableY] = useState<{ search: number; pool: number }>({ search: 360, pool: 360 })

  useEffect(() => {
    if (!open) return
    const calc = () => {
      const modalEl = document.querySelector('.material-picker-modal') as HTMLElement | null
      if (!modalEl) return
      const h = (sel: string, fb: number) => {
        const el = modalEl.querySelector(sel) as HTMLElement | null
        return el ? el.offsetHeight : fb
      }
      // 弹窗固定开销: 顶部偏移(默认 top:100)+标题+底部按钮+body内边距+Tabs导航+表头+底部余量
      const chrome = modalEl.getBoundingClientRect().top
        + h('.ant-modal-header', 57) + h('.ant-modal-footer', 60) + 40
        + h('.ant-tabs-nav', 46) + h('.ant-table-thead', 39) + 24
      const rdpH = (rdpRef.current?.offsetHeight ?? 0) + (rdpRef.current ? 12 : 0)
      const avail = window.innerHeight - chrome - rdpH
      setTableY({
        search: Math.max(160, avail - 88), // 搜索行 44 + 分页行 44
        pool: Math.max(160, avail - 44),   // 筛选行 44
      })
    }
    // 等弹窗内容渲染完成后再测量
    const t = setTimeout(calc, 0)
    window.addEventListener('resize', calc)
    return () => { clearTimeout(t); window.removeEventListener('resize', calc) }
  }, [open, activeTab, poolItems.length])

  useEffect(() => {
    if (!open || activeTab !== 'search') return
    let cancelled = false
    setLoading(true)
    materialApi
      .listMaterialCandidates({
        keyword: keyword || undefined,
        wh_id: whFilter || undefined,
        page,
        page_size: pageSize,
      })
      .then((res: any) => {
        if (cancelled) return
        const data = res?.data || {}
        const list = (data.items || []) as MaterialCandidate[]
        setItems(list)
        setTotal(Number(data.total || 0))
        // 搜索结果只有 1 条时自动勾选（累积，不覆盖已选），用户仍需手动点「确定」
        if (list.length === 1) {
          const only = list[0]
          const key = rowKey(only)
          setSelectedIds((prev) => prev.has(key) ? prev : new Set(prev).add(key))
          setSelectedMap((prev) => prev[key] ? prev : { ...prev, [key]: only })
        }
      })
      .catch((err: any) => {
        if (!cancelled) message.error(err?.message || '加载物料候选失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, activeTab, keyword, whFilter, page, pageSize])

  useEffect(() => {
    if (!open) {
      setSelectedIds(new Set())
      setSelectedMap({})
      setKeyword('')
      setWhFilter('')
      setPage(1)
      setActiveTab('search')
      setPoolSelectedIds([])
      setPoolKeyword('')
      setRecentDays(showRecentDays ? 99999 : null)
    }
  }, [open])

  const toggleRow = (row: MaterialCandidate) => {
    const key = rowKey(row)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
    setSelectedMap((prev) => {
      const next = { ...prev }
      if (selectedIds.has(key)) {
        delete next[key]
      } else {
        next[key] = row
      }
      return next
    })
  }

  const togglePageAll = () => {
    const allSelected = items.length > 0 && items.every((it) => selectedIds.has(rowKey(it)))
    setSelectedIds((prev) => {
      const next = new Set(prev)
      setSelectedMap((prevMap) => {
        const nextMap = { ...prevMap }
        items.forEach((it) => {
          const key = rowKey(it)
          if (allSelected) {
            next.delete(key)
            delete nextMap[key]
          } else {
            next.add(key)
            nextMap[key] = it
          }
        })
        return nextMap
      })
      return next
    })
  }

  const allOnPageSelected = useMemo(
    () => items.length > 0 && items.every((it) => selectedIds.has(rowKey(it))),
    [items, selectedIds],
  )

  const handleConfirm = () => {
    if (selectedIds.size === 0) {
      message.warning('请至少选择一个物料')
      return
    }
    onConfirm(Object.values(selectedMap), 'search', recentDays)
  }

  const handleAddToPool = (rows: MaterialCandidate[]) => {
    if (rows.length === 0) return
    const poolMaterials: PoolMaterial[] = rows.map((r) => ({
      erp_material_id: r.erp_material_id,
      material_code: r.material_code ?? null,
      material_name: r.material_name ?? null,
      spec_model: r.spec_model ?? null,
      unit: r.unit ?? null,
      system_qty: r.system_qty ?? null,
      wh_id: r.wh_id ?? null,
      wh_code: r.wh_code ?? null,
      wh_name: r.wh_name ?? null,
      added_at: new Date().toISOString(),
    }))
    poolAdd(poolMaterials)
    message.success(`已加入待盘点池，当前共 ${useStockCheckPoolStore.getState().items.length} 项`)
  }

  const handleBatchAddToPool = () => {
    if (selectedIds.size === 0) {
      message.warning('请先勾选要加入待盘点池的物料')
      return
    }
    handleAddToPool(Object.values(selectedMap))
    setSelectedIds(new Set())
    setSelectedMap({})
  }

  const handlePoolCreate = () => {
    if (poolSelectedIds.length === 0) {
      message.warning('请至少选择一个物料')
      return
    }
    if (poolSelectedIds.length > 500) {
      message.warning('一次最多创建 500 个物料的盘点单，请减少勾选数量')
      return
    }
    const selected: MaterialCandidate[] = poolSelectedIds.map((key) => {
      const row = poolItems.find((p) => poolKey(p) === key)
      return {
        erp_material_id: row?.erp_material_id ?? 0,
        material_code: row?.material_code ?? null,
        material_name: row?.material_name ?? null,
        spec_model: row?.spec_model ?? null,
        unit: row?.unit ?? null,
        system_qty: row?.system_qty ?? null,
        wh_id: row?.wh_id,
        wh_code: row?.wh_code ?? null,
        wh_name: row?.wh_name ?? null,
      }
    }).filter((s) => s.erp_material_id > 0)
    onConfirm(selected, 'pool', recentDays)
  }

  const renderWhName = (row: { wh_name?: string | null }) => {
    const name = (row.wh_name ?? '').trim()
    if (name === '(未入库)' || name === '未入库') {
      return <span style={{ color: '#999' }}>(未入库)</span>
    }
    return name || '—'
  }

  const searchColumns = [
    {
      title: (
        <input
          type="checkbox"
          checked={allOnPageSelected}
          onChange={togglePageAll}
          style={{ cursor: 'pointer' }}
        />
      ),
      key: 'select',
      width: 48,
      render: (_: any, row: MaterialCandidate) => (
        <input
          type="checkbox"
          checked={selectedIds.has(rowKey(row))}
          onChange={() => toggleRow(row)}
          style={{ cursor: 'pointer' }}
        />
      ),
    },
    { title: '物料编码', dataIndex: 'material_code', key: 'material_code', width: 140 },
    { title: '物料名称', dataIndex: 'material_name', key: 'material_name', width: 180, ellipsis: true },
    { title: '规格', dataIndex: 'spec_model', key: 'spec_model', width: 160, ellipsis: true },
    {
      title: '仓库',
      dataIndex: 'wh_name',
      key: 'wh_name',
      width: 140,
      render: (_: any, row: MaterialCandidate) => renderWhName(row),
    },
    { title: '单位', dataIndex: 'unit', key: 'unit', width: 70 },
    {
      title: '即时库存',
      dataIndex: 'system_qty',
      key: 'system_qty',
      width: 100,
      align: 'right' as const,
      render: (v: number | null | undefined) => (v == null ? '—' : Number(v).toFixed(2)),
    },
    {
      title: '最近盘点',
      dataIndex: 'recent_checked_check_no',
      key: 'recent_checked_check_no',
      width: 110,
      render: (_: any, row: MaterialCandidate) =>
        row.recent_checked_check_no ? (
          <Tooltip
            title={`近期已盘 ${row.recent_checked_check_no}${row.recent_checked_date ? ` · ${row.recent_checked_date}` : ''}`}
          >
            <Tag color="default">近期已盘</Tag>
          </Tooltip>
        ) : (
          '—'
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      fixed: 'right' as const,
      render: (_: any, row: MaterialCandidate) => {
        const inPool = poolHas({ erp_material_id: row.erp_material_id, wh_id: row.wh_id ?? null })
        return (
          <Button
            size="small"
            type={inPool ? 'default' : 'link'}
            icon={<PlusOutlined />}
            disabled={inPool}
            onClick={() => handleAddToPool([row])}
          >
            {inPool ? '已在池中' : '加入待盘点池'}
          </Button>
        )
      },
    },
  ]

  const poolColumns = [
    { title: '物料编码', dataIndex: 'material_code', key: 'material_code', width: 140 },
    { title: '物料名称', dataIndex: 'material_name', key: 'material_name', width: 180, ellipsis: true },
    { title: '规格', dataIndex: 'spec_model', key: 'spec_model', width: 160, ellipsis: true },
    {
      title: '仓库',
      dataIndex: 'wh_name',
      key: 'wh_name',
      width: 140,
      render: (_: any, row: PoolMaterial) => renderWhName(row),
    },
    { title: '单位', dataIndex: 'unit', key: 'unit', width: 70 },
    {
      title: '即时库存(快照)',
      dataIndex: 'system_qty',
      key: 'system_qty',
      width: 130,
      align: 'right' as const,
      render: (v: number | null | undefined) => (v == null ? '—' : Number(v).toFixed(2)),
    },
    {
      title: '加入时间',
      dataIndex: 'added_at',
      key: 'added_at',
      width: 160,
      render: (v: string) => (v ? new Date(v).toLocaleString() : '—'),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      fixed: 'right' as const,
      render: (_: any, row: PoolMaterial) => (
        <Button
          size="small"
          type="link"
          danger
          icon={<DeleteOutlined />}
          onClick={() => {
            poolRemove([{ erp_material_id: row.erp_material_id, wh_id: row.wh_id }])
            setPoolSelectedIds((prev) => prev.filter((id) => id !== poolKey(row)))
          }}
        >
          移除
        </Button>
      ),
    },
  ]

  const filteredPoolItems = useMemo(() => {
    if (!poolKeyword.trim()) return poolItems
    const kw = poolKeyword.trim().toLowerCase()
    return poolItems.filter(
      (p) =>
        (p.material_code ?? '').toLowerCase().includes(kw) ||
        (p.material_name ?? '').toLowerCase().includes(kw) ||
        (p.wh_name ?? '').toLowerCase().includes(kw),
    )
  }, [poolItems, poolKeyword])

  const searchTab = (
    <>
      <Space style={{ marginBottom: 12 }} size="middle" wrap>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索物料编码/名称/规格"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value)
            setPage(1)
          }}
          style={{ width: 260 }}
        />
        <Input.Search
          allowClear
          placeholder="仓库名称或ID"
          value={whFilter}
          onChange={(e) => setWhFilter(e.target.value)}
          onSearch={(v) => {
            setWhFilter(v)
            setPage(1)
          }}
          style={{ width: 180 }}
        />
        <Button icon={<ClearOutlined />} onClick={() => { setKeyword(''); setWhFilter(''); setPage(1) }}>
          清空
        </Button>
      </Space>
      <Spin spinning={loading}>
        <Table
          rowKey={rowKey}
          size="small"
          className="picker-modal-table"
          dataSource={items}
          columns={searchColumns as any}
          pagination={false}
          scroll={{ y: tableY.search, x: 1100 }}
        />
      </Spin>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <Pagination
          current={page}
          pageSize={pageSize}
          total={total}
          showSizeChanger
          pageSizeOptions={['10', '20', '50', '100']}
          onChange={(p, ps) => { setPage(p); setPageSize(ps) }}
          showTotal={(t) => `共 ${t} 项`}
        />
      </div>
    </>
  )

  const poolTab =
    poolItems.length === 0 ? (
      <Empty description="待盘点池为空，请到「搜索物料」标签添加物料" />
    ) : (
      <>
        <Input.Search
          allowClear
          prefix={<SearchOutlined />}
          placeholder="筛选物料编码/名称/仓库"
          value={poolKeyword}
          onChange={(e) => setPoolKeyword(e.target.value)}
          style={{ width: 260, marginBottom: 12 }}
        />
        <Table
          rowKey={(row: PoolMaterial) => poolKey(row)}
          size="small"
          className="picker-modal-table"
          dataSource={filteredPoolItems}
          columns={poolColumns as any}
          pagination={false}
          scroll={{ y: tableY.pool }}
          rowSelection={{
            selectedRowKeys: poolSelectedIds,
            onChange: (keys) => setPoolSelectedIds(keys as string[]),
            preserveSelectedRowKeys: true,
          }}
        />
      </>
    )

  const searchFooter = (
    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
      <span>
        已选 <b style={{ color: '#1677ff' }}>{selectedIds.size}</b> 项
      </span>
      <Space>
        <Button onClick={onCancel}>取消</Button>
        <Button onClick={handleBatchAddToPool}>加入待盘点池(已选{selectedIds.size}项)</Button>
        <Button type="primary" loading={confirmLoading} onClick={handleConfirm}>
          确定并创建盘点单
        </Button>
      </Space>
    </Space>
  )

  const poolFooter = (
    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
      <span>
        待盘点池共 <b style={{ color: '#1677ff' }}>{poolItems.length}</b> 项，已选{' '}
        <b style={{ color: '#1677ff' }}>{poolSelectedIds.length}</b> 项
      </span>
      <Space>
        <Button
          disabled={poolSelectedIds.length === 0}
          onClick={() => {
            poolRemove(poolSelectedIds.map((key) => {
              const row = poolItems.find((p) => poolKey(p) === key)
              return { erp_material_id: row?.erp_material_id ?? 0, wh_id: row?.wh_id }
            }))
            setPoolSelectedIds([])
          }}
        >
          移除选中
        </Button>
        <Popconfirm
          title="确定清空待盘点池？"
          okText="确定"
          cancelText="取消"
          onConfirm={() => {
            poolClear()
            setPoolSelectedIds([])
          }}
        >
          <Button disabled={poolItems.length === 0}>清空</Button>
        </Popconfirm>
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" loading={confirmLoading} onClick={handlePoolCreate}>
          创建盘点单(已选{poolSelectedIds.length}项)
        </Button>
      </Space>
    </Space>
  )

  return (
    <Modal
      title="选择盘点物料"
      className="material-picker-modal"
      open={open}
      onCancel={onCancel}
      width={1100}
      destroyOnClose
      footer={activeTab === 'search' ? searchFooter : poolFooter}
    >
      {showRecentDays && (
        <div ref={rdpRef}>
          <RecentDaysPicker value={recentDays} onChange={setRecentDays} />
        </div>
      )}
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as TabKey)}
        items={[
          { key: 'search', label: '搜索物料', children: searchTab },
          {
            key: 'pool',
            label: (
              <span data-tour="stock-check-pool-tab">
                待盘点池 ({poolItems.length})
              </span>
            ),
            children: poolTab,
          },
        ]}
      />
    </Modal>
  )
}
