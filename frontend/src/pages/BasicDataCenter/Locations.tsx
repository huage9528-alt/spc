import { useCallback, useEffect, useMemo, useState, Fragment, type Key } from 'react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Switch, TreeSelect, message,
  Popconfirm, Row, Col, Tooltip, type TableColumnsType,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import api from '../../services/api'
import PermButton from '../../components/PermButton'
import { useAuthStore } from '../../store/auth'
import KpiBand, { type KpiItem } from './components/KpiBand'
import ChipsFilter, { type ChipOption } from './components/ChipsFilter'
import BdDrawer, { DrawerSection, KvGrid } from './components/BdDrawer'

interface LocNode {
  id: number
  location_id: number
  location_code?: string | null
  location_name?: string | null
  location_full_name?: string | null
  depth?: number | null
  detail_flag?: number | null
  parent_id?: number | string | null
  data_source?: string | null
  system_type?: number | null
  is_deleted?: number | null
  children?: LocNode[]
}

interface LocStats {
  total: number
  by_depth: Record<string, number>
  deleted: number
  by_source: Record<string, number>
}

const DEPTH_META: Record<number, { label: string; color: string; bg: string }> = {
  0: { label: 'L0 仓', color: '#ffffff', bg: '#334155' },
  1: { label: 'L1 区', color: '#4c4dc2', bg: '#eef0fe' },
  2: { label: 'L2 架', color: '#0284c7', bg: '#f0f9ff' },
  3: { label: 'L3 位', color: '#16a34a', bg: '#f0fdf4' },
}

const renderDepthBadge = (depth?: number | null) => {
  const meta = DEPTH_META[depth ?? -1]
  if (!meta) return <span className="sc-note">—</span>
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '.03em',
        borderRadius: 5,
        padding: '1px 7px',
        lineHeight: '16px',
        color: meta.color,
        background: meta.bg,
      }}
    >
      {meta.label}
    </span>
  )
}

const renderDetail = (flag?: number | null) =>
  flag === 1 ? (
    <span className="sc-tag sc-tag-kit">明细</span>
  ) : (
    <span className="sc-tag sc-tag-wait">结构节点</span>
  )

const renderSource = (source?: string | null) =>
  source === 'erp' ? (
    <span className="sc-tag sc-tag-kit">ERP</span>
  ) : (
    <span className="sc-tag sc-tag-wait">手工</span>
  )

const renderStatus = (deleted?: number | null) =>
  deleted === 1 ? (
    <span className="sc-tag" style={{ color: '#94a3b8', background: '#f1f5f9' }}>软删</span>
  ) : (
    <span className="sc-tag sc-tag-done"><span className="dot" />启用</span>
  )

const countDescendants = (node: LocNode): number =>
  (node.children || []).reduce((sum, child) => sum + 1 + countDescendants(child), 0)

const countNodes = (nodes: LocNode[]): number =>
  nodes.reduce((sum, node) => sum + 1 + countNodes(node.children || []), 0)

const DELETE_CONFIRM = '确认删除该库位？若当前存放物料需先移库清空。删除后不可恢复，历史库存与盘点记录将失去库位归属。'

const FORM_NOTE =
  '层级规则：L0 仓 → L1 区 → L2 架 → L3 位，最多四级；ERP 来源的结构节点由每日同步维护，手工仅在非 ERP 仓库下可新增。删除为物理删除，删除后不可恢复，历史库存与盘点记录将失去库位归属。'

export default function Locations() {
  const [tree, setTree] = useState<LocNode[]>([])
  const [stats, setStats] = useState<LocStats>({ total: 0, by_depth: {}, deleted: 0, by_source: {} })
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [chip, setChip] = useState<string>('all')
  const [showDeleted, setShowDeleted] = useState(false)
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([])
  const [modalVisible, setModalVisible] = useState(false)
  const [editingItem, setEditingItem] = useState<LocNode | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerItem, setDrawerItem] = useState<LocNode | null>(null)
  const [form] = Form.useForm()

  const navigate = useNavigate()
  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data.locations', 'delete')

  const nodeIndex = useMemo(() => {
    const byId = new Map<number, LocNode>()
    const walk = (nodes: LocNode[]) => {
      nodes.forEach((n) => {
        byId.set(n.location_id, n)
        walk(n.children || [])
      })
    }
    walk(tree)
    return byId
  }, [tree])

  const filteredTree = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const depthFilter = chip !== 'all' ? Number(chip) : null
    const matchesKw = (n: LocNode) =>
      [n.location_id, n.location_code, n.location_name, n.location_full_name].some((v) =>
        String(v ?? '').toLowerCase().includes(kw))
    const filterNodes = (nodes: LocNode[]): LocNode[] => {
      const out: LocNode[] = []
      for (const n of nodes) {
        if (!showDeleted && n.is_deleted === 1) continue
        const keptChildren = filterNodes(n.children || [])
        const selfMatch =
          (depthFilter == null || n.depth === depthFilter) && (!kw || matchesKw(n))
        if (selfMatch || keptChildren.length > 0) {
          out.push(keptChildren.length > 0 ? { ...n, children: keptChildren } : { ...n, children: undefined })
        }
      }
      return out
    }
    return filterNodes(tree)
  }, [tree, keyword, chip, showDeleted])

  useEffect(() => {
    const collect = (nodes: LocNode[], acc: Key[]) => {
      nodes.forEach((n) => {
        if ((n.children?.length ?? 0) > 0) {
          acc.push(n.location_id)
          collect(n.children || [], acc)
        }
      })
    }
    if (keyword.trim() || chip !== 'all') {
      const keys: Key[] = []
      collect(filteredTree, keys)
      setExpandedKeys(keys)
    } else {
      setExpandedKeys(tree.filter((n) => (n.children?.length ?? 0) > 0).map((n) => n.location_id))
    }
  }, [keyword, chip, filteredTree, tree])

  const visibleCount = useMemo(() => countNodes(filteredTree), [filteredTree])

  const parentTreeData = useMemo(() => {
    const toOption = (n: LocNode): Record<string, unknown> => {
      const opt: Record<string, unknown> = {
        value: n.location_id,
        title: `${n.location_name ?? n.location_id} · ${n.location_id}`,
      }
      const kids = (n.children || []).filter((c) => c.is_deleted !== 1).map(toOption)
      if (kids.length > 0) opt.children = kids
      return opt
    }
    return tree.filter((n) => n.is_deleted !== 1).map(toOption)
  }, [tree])

  const fetchTree = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await api.get('/basicdata/locations/tree')
      setTree(res.data?.tree || [])
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/locations/stats')
      setStats({
        total: res.data?.total || 0,
        by_depth: res.data?.by_depth || {},
        deleted: res.data?.deleted || 0,
        by_source: res.data?.by_source || {},
      })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  useEffect(() => {
    fetchTree()
    fetchStats()
  }, [fetchTree, fetchStats])

  const refreshAll = useCallback(() => {
    fetchTree()
    fetchStats()
  }, [fetchTree, fetchStats])

  const expandAll = () => {
    const keys: Key[] = []
    const collect = (nodes: LocNode[]) => {
      nodes.forEach((n) => {
        if ((n.children?.length ?? 0) > 0) {
          keys.push(n.location_id)
          collect(n.children || [])
        }
      })
    }
    collect(filteredTree)
    setExpandedKeys(keys)
  }

  const collapseAll = () => setExpandedKeys([])

  const handleAdd = () => {
    setEditingItem(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (item: LocNode) => {
    setEditingItem(item)
    form.resetFields()
    form.setFieldsValue({
      location_id: item.location_id,
      location_code: item.location_code,
      location_name: item.location_name,
      location_full_name: item.location_full_name,
      location_group_id: undefined,
      parent_id: item.parent_id != null && item.parent_id !== '' ? Number(item.parent_id) : undefined,
      depth: item.depth ?? 0,
      detail_flag: item.detail_flag === 1,
      system_type: item.system_type ?? 0,
      is_deleted: item.is_deleted ?? 0,
    })
    setModalVisible(true)
  }

  const openDrawer = (item: LocNode) => {
    setDrawerItem(item)
    setDrawerOpen(true)
  }

  const handleDelete = async (item: LocNode) => {
    try {
      await api.delete(`/basicdata/locations/${item.id}`)
      message.success('删除成功')
      if (drawerOpen && drawerItem?.id === item.id) setDrawerOpen(false)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const watchParent = Form.useWatch('parent_id', form)
  const watchCode = Form.useWatch('location_code', form)
  const watchName = Form.useWatch('location_name', form)

  const fullPreview = useMemo(() => {
    const parent = watchParent != null ? nodeIndex.get(Number(watchParent)) : undefined
    const self = String(watchCode || watchName || '').trim()
    const prefix = parent?.location_full_name || (parent ? String(parent.location_id) : '')
    return prefix ? `${prefix}/${self}` : self
  }, [watchParent, watchCode, watchName, nodeIndex])

  useEffect(() => {
    if (modalVisible) form.setFieldValue('location_full_name', fullPreview)
  }, [fullPreview, modalVisible, form])

  const handleParentChange = (value: unknown) => {
    const parentId = value == null ? null : Number(value)
    const parent = parentId != null ? nodeIndex.get(parentId) : undefined
    form.setFieldValue('depth', (parent?.depth ?? -1) + 1)
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      const payload = {
        ...values,
        detail_flag: values.detail_flag ? 1 : 0,
        is_deleted: values.is_deleted ?? 0,
      }
      if (editingItem) {
        const { location_id: _omit, ...rest } = payload
        await api.put(`/basicdata/locations/${editingItem.id}`, rest)
        message.success('更新成功')
      } else {
        await api.post('/basicdata/locations', payload)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    }
  }

  const erpCount = stats.by_source['erp'] || 0
  const kpiItems: KpiItem[] = [
    { label: '库位总数', value: stats.total.toLocaleString(), sub: '四级树 仓/区/架/位', accent: 'brand' },
    { label: '明细库位', value: (stats.by_depth['3'] || 0).toLocaleString(), sub: '可存放物料 · 其余为结构节点', accent: 'success' },
    { label: 'ERP 同步', value: erpCount.toLocaleString(), sub: `手工新增 ${Math.max(stats.total - erpCount, 0).toLocaleString()} · 每日增量同步`, accent: 'info' },
    {
      label: '软删（历史保留）',
      value: stats.deleted.toLocaleString(),
      sub: '不可再存放 · 盘点跳过',
      accent: 'gray',
      onClick: () => setShowDeleted((v) => !v),
    },
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    { label: 'L0 仓', value: '0', count: stats.by_depth['0'] || 0 },
    { label: 'L1 区', value: '1', count: stats.by_depth['1'] || 0 },
    { label: 'L2 架', value: '2', count: stats.by_depth['2'] || 0 },
    { label: 'L3 位', value: '3', count: stats.by_depth['3'] || 0 },
  ]

  const ancestorChain = useMemo(() => {
    if (!drawerItem) return []
    const chain: LocNode[] = []
    let cur: LocNode | undefined = drawerItem
    while (cur && cur.parent_id != null && cur.parent_id !== '') {
      const parent: LocNode | undefined = nodeIndex.get(Number(cur.parent_id))
      if (!parent || chain.includes(parent)) break
      chain.unshift(parent)
      cur = parent
    }
    return chain
  }, [drawerItem, nodeIndex])

  const columns: TableColumnsType<LocNode> = [
    {
      title: '库位（仓 → 区 → 架 → 位）',
      dataIndex: 'location_name',
      key: 'loc',
      render: (_: unknown, record: LocNode) => {
        const deleted = record.is_deleted === 1
        return (
          <div style={deleted ? { opacity: 0.72 } : undefined}>
            <div
              className="sc-mat-name"
              style={{
                cursor: 'pointer',
                color: deleted ? '#94a3b8' : undefined,
                fontWeight: deleted ? 400 : undefined,
              }}
              onClick={() => openDrawer(record)}
            >
              {record.location_name || <span className="sc-note">未命名</span>}
            </div>
            <div className="sc-mat-code">
              {record.location_id}
              {record.location_code ? ` · ${record.location_code}` : ''}
            </div>
          </div>
        )
      },
    },
    {
      title: '层级',
      dataIndex: 'depth',
      key: 'depth',
      width: 84,
      render: (_: unknown, record: LocNode) => renderDepthBadge(record.depth),
    },
    {
      title: '库位全称',
      dataIndex: 'location_full_name',
      key: 'location_full_name',
      width: 260,
      ellipsis: true,
      render: (v: string) =>
        v ? (
          <Tooltip title={v}>
            <span style={{ fontSize: 12, color: '#64748b' }}>{v}</span>
          </Tooltip>
        ) : (
          <span className="sc-note">—</span>
        ),
    },
    {
      title: '明细',
      dataIndex: 'detail_flag',
      key: 'detail_flag',
      width: 92,
      render: (_: unknown, record: LocNode) => renderDetail(record.detail_flag),
    },
    {
      title: '子库位数',
      key: 'children_count',
      width: 90,
      align: 'right',
      className: 'sc-mono',
      render: (_: unknown, record: LocNode) =>
        record.depth === 3 ? (
          <span style={{ color: '#cbd5e1' }}>—</span>
        ) : (
          <span style={{ fontWeight: 500 }}>{countDescendants(record)}</span>
        ),
    },
    {
      title: '来源',
      dataIndex: 'data_source',
      key: 'data_source',
      width: 80,
      render: (_: unknown, record: LocNode) => renderSource(record.data_source),
    },
    {
      title: '状态',
      dataIndex: 'is_deleted',
      key: 'is_deleted',
      width: 80,
      render: (_: unknown, record: LocNode) => renderStatus(record.is_deleted),
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: unknown, record: LocNode) => (
        <span className="sc-row-act">
          <Button type="text" size="small" onClick={() => openDrawer(record)}>详情</Button>
          <PermButton permResource="basicdata.data.locations" permAction="update" type="text" size="small" onClick={() => handleEdit(record)}>编辑</PermButton>
          <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(record)} okText="确认" cancelText="取消" disabled={!canDelete}>
            <PermButton permResource="basicdata.data.locations" permAction="delete" type="text" size="small" danger>删除</PermButton>
          </Popconfirm>
        </span>
      ),
    },
  ]

  return (
    <div className="sc-page">
      <KpiBand items={kpiItems} />

      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="库位 ID / 编码 / 名称 / 全称"
            style={{ width: 240 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </span>
        <ChipsFilter options={chipOptions} value={chip} onChange={(v) => setChip(String(v))} />
        <span
          className={`sc-chip${showDeleted ? ' on' : ''}`}
          onClick={() => setShowDeleted((v) => !v)}
        >
          软删 <span className="n">{stats.deleted.toLocaleString()}</span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={refreshAll} />
          </Tooltip>
          <span style={{ width: 1, height: 20, background: '#e2e8f0' }} />
          <Button size="small" onClick={expandAll}>全部展开</Button>
          <Button size="small" onClick={collapseAll}>全部收起</Button>
          <PermButton permResource="basicdata.data.locations" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增库位
          </PermButton>
        </span>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table<LocNode>
          rowKey="location_id"
          columns={columns}
          dataSource={filteredTree}
          loading={loading}
          size="small"
          scroll={{ x: 1000 }}
          pagination={false}
          footer={() => `共 ${visibleCount} 节点 · 树形模式按仓库根节点组织`}
          expandable={{
            expandedRowKeys: expandedKeys,
            onExpand: (expanded: boolean, record: LocNode) =>
              setExpandedKeys((prev) =>
                expanded
                  ? [...prev, record.location_id]
                  : prev.filter((k) => Number(k) !== record.location_id)),
            childrenColumnName: 'children',
            indentSize: 22,
          }}
        />
      </div>

      <BdDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={drawerItem?.location_name || drawerItem?.location_id}
        code={drawerItem?.location_id}
        tags={drawerItem && (
          <>
            {renderDepthBadge(drawerItem.depth)}
            {renderDetail(drawerItem.detail_flag)}
            {renderSource(drawerItem.data_source)}
            {renderStatus(drawerItem.is_deleted)}
          </>
        )}
        actions={drawerItem && (
          <>
            <PermButton permResource="basicdata.data.locations" permAction="update" type="primary" size="small" icon={<EditOutlined />} onClick={() => handleEdit(drawerItem)}>编辑</PermButton>
            <Button size="small" onClick={() => navigate('/basicdata/inventory')}>查看库存</Button>
            <Popconfirm title={DELETE_CONFIRM} onConfirm={() => handleDelete(drawerItem)} okText="确认" cancelText="取消" disabled={!canDelete}>
              <PermButton permResource="basicdata.data.locations" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
            </Popconfirm>
          </>
        )}
      >
        {drawerItem && (
          <div style={{ marginTop: 12 }}>
            <DrawerSection title="层级路径">
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: 13 }}>
                {ancestorChain.map((a) => (
                  <Fragment key={a.location_id}>
                    <span style={{ color: '#475569' }}>{a.location_name ?? a.location_id}</span>
                    <span style={{ margin: '0 4px', color: '#cbd5e1' }}>›</span>
                  </Fragment>
                ))}
                <b>{drawerItem.location_name ?? drawerItem.location_id}</b>
              </div>
            </DrawerSection>
            <DrawerSection title="基本信息">
              <KvGrid
                items={[
                  ['库位 ID', <span className="sc-mono" key="lid">{drawerItem.location_id}</span>],
                  ['库位编码', <span className="sc-mono" key="lc">{drawerItem.location_code || '—'}</span>],
                  ['库位全称', drawerItem.location_full_name || '—'],
                  ['系统类型', <span className="sc-mono" key="st">{drawerItem.system_type ?? '—'}</span>],
                  [
                    '明细标识',
                    drawerItem.detail_flag === 1 ? (
                      <span style={{ color: '#16a34a', fontWeight: 500 }}>是 · 可存放物料</span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>否 · 结构节点</span>
                    ),
                  ],
                ]}
              />
            </DrawerSection>
          </div>
        )}
      </BdDrawer>

      <Modal
        title={editingItem ? '编辑库位' : '新增库位'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText="保存"
        cancelText="取消"
        width={640}
        rootClassName="sc-page"
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="parent_id" label="父库位（树选择器）">
                <TreeSelect
                  treeData={parentTreeData}
                  showSearch
                  treeNodeFilterProp="title"
                  allowClear
                  treeDefaultExpandAll
                  placeholder="不选则为仓库根节点"
                  onChange={handleParentChange}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location_id" label="库位 ID" rules={[{ required: true }]}>
                <Input placeholder="如 LOC-WH01-A-01-37（唯一）" disabled={!!editingItem} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location_code" label="库位编码">
                <Input placeholder="如 A-01-37" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location_name" label="库位名称">
                <Input placeholder="如 芯片柜 37" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="location_full_name"
                label="库位全称（自动生成）"
                extra={<span style={{ color: '#16a34a', fontSize: 11 }}>✓ 由父级路径自动拼接，不可手改</span>}
              >
                <Input disabled placeholder="WH-01 / A 区 / A-01 / A-01-37" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location_group_id" label="库位分组 ID">
                <Input placeholder="选填 · 如 GRP-CHIP-01" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="depth" label="层级深度" initialValue={0}>
                <InputNumber style={{ width: '100%' }} min={0} max={3} placeholder="由父库位自动建议" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="detail_flag" label="明细标识" valuePropName="checked" initialValue={false} extra="明细库位（可存放物料）">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="system_type" label="系统类型" initialValue={0}>
                <InputNumber style={{ width: '100%' }} placeholder="0 · 本系统" />
              </Form.Item>
            </Col>
            <Form.Item name="is_deleted" hidden initialValue={0}>
              <Input />
            </Form.Item>
            <Col span={24}>
              <div className="f-note">{FORM_NOTE}</div>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
