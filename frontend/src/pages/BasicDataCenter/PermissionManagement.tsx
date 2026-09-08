import { useState, useCallback, useEffect } from 'react'
import {
  Table, Button, Modal, Form, Input, InputNumber, Select, TreeSelect,
  message, Space, Switch, Tooltip,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, KeyOutlined } from '@ant-design/icons'
import { permissionApi } from '../../services/api'
import PermButton from '../../components/PermButton'
import { useAuthStore } from '../../store/auth'

interface PermNode {
  code: string
  name: string
  module: string
  parent_code: string | null
  actions: string[]
  route_path: string | null
  sort_order: number
  is_active?: boolean
  children: PermNode[]
}

const PROTECTED_CODES = ['permissions', 'roles', 'users']
const STANDARD_ACTIONS = ['create', 'read', 'update', 'delete', 'import', 'handle']

const ACTION_TAG_CLASS: Record<string, string> = {
  create: 'sc-tag-done',
  read: 'sc-tag-kit',
  update: 'sc-tag-warn',
  delete: 'sc-tag-danger',
  import: 'sc-tag-purple',
  handle: 'sc-tag-prod',
}

function flatten(nodes: PermNode[], acc: PermNode[] = []): PermNode[] {
  for (const n of nodes) {
    acc.push(n)
    if (n.children?.length) flatten(n.children, acc)
  }
  return acc
}

function buildTreeSelectData(nodes: PermNode[]): any[] {
  return nodes.map(n => ({
    value: n.code,
    title: `${n.name} (${n.code})`,
    children: n.children?.length ? buildTreeSelectData(n.children) : undefined,
  }))
}

export default function PermissionManagement() {
  const [tree, setTree] = useState<PermNode[]>([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingCode, setEditingCode] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PermNode | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [form] = Form.useForm()
  const hasPermission = useAuthStore(s => s.hasPermission)
  const canCreate = hasPermission('permissions', 'create')
  const canUpdate = hasPermission('permissions', 'update')
  const canDelete = hasPermission('permissions', 'delete')

  const fetchTree = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await permissionApi.tree(true)
      setTree(res?.data || [])
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchTree() }, [fetchTree])

  const flatList = flatten(tree)
  const treeSelectData = buildTreeSelectData(tree)

  const handleAdd = (parentCode?: string) => {
    setEditingCode(null)
    form.resetFields()
    form.setFieldsValue({
      actions: ['create', 'read', 'update', 'delete'],
      sort_order: 0,
      parent_code: parentCode || null,
      module: '',
    })
    setModalVisible(true)
  }

  const handleEdit = (node: PermNode) => {
    setEditingCode(node.code)
    form.setFieldsValue({
      code: node.code,
      name: node.name,
      module: node.module,
      parent_code: node.parent_code,
      actions: node.actions,
      route_path: node.route_path,
      sort_order: node.sort_order,
    })
    setModalVisible(true)
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      if (editingCode) {
        await permissionApi.update(editingCode, {
          name: values.name,
          module: values.module,
          parent_code: values.parent_code || null,
          actions: values.actions,
          route_path: values.route_path || null,
          sort_order: values.sort_order ?? 0,
        })
        message.success('更新成功')
      } else {
        await permissionApi.create({
          code: values.code,
          name: values.name,
          module: values.module || values.code.split('.')[0],
          parent_code: values.parent_code || null,
          actions: values.actions,
          route_path: values.route_path || null,
          sort_order: values.sort_order ?? 0,
        })
        message.success('创建成功')
      }
      setModalVisible(false)
      fetchTree()
    } catch (e: any) {
      if (e?.errorFields) return
      // 错误已由全局拦截器提示
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await permissionApi.remove(deleteTarget.code)
      message.success('删除成功')
      setDeleteTarget(null)
      fetchTree()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    } finally {
      setDeleting(false)
    }
  }

  const handleToggleActive = async (node: PermNode, active: boolean) => {
    try {
      await permissionApi.update(node.code, { is_active: active })
      message.success(active ? '已启用' : '已停用')
      fetchTree()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  const renderName = (name: string, record: PermNode) => (
    <span style={{ fontWeight: record.children?.length ? 600 : 400, color: record.is_active === false ? '#64748b' : '#0f172a' }}>
      <span>{name}</span>
      {PROTECTED_CODES.includes(record.code) && <span className="sc-tag sc-tag-warn" style={{ marginLeft: 8, height: 18, fontSize: 'calc(11px * var(--font-size-scale))' }}>系统</span>}
      {record.is_active === false && <span className="sc-tag sc-tag-danger" style={{ marginLeft: 6, height: 18, fontSize: 'calc(11px * var(--font-size-scale))' }}>停用</span>}
    </span>
  )

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 300,
      render: renderName,
    },
    {
      title: '编码', dataIndex: 'code', key: 'code', width: 240,
      render: (v: string) => <span className="sc-mono" style={{ color: '#475569', fontFamily: 'Consolas, Menlo, monospace', fontSize: 'calc(12px * var(--font-size-scale))' }}>{v}</span>,
    },
    {
      title: '路由', dataIndex: 'route_path', key: 'route_path', width: 200,
      render: (v: string | null) => v
        ? <span className="sc-mono" style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 'calc(12px * var(--font-size-scale))' }}>{v}</span>
        : <span className="sc-note">—</span>,
    },
    {
      title: '操作集',
      dataIndex: 'actions',
      key: 'actions',
      width: 240,
      render: (acts: string[]) => (
        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
          {(acts || []).map(a => (
            <span key={a} className={`sc-tag ${ACTION_TAG_CLASS[a] || 'sc-tag-plain'}`} style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 'calc(11px * var(--font-size-scale))', height: 20 }}>{a}</span>
          ))}
          {(!acts || acts.length === 0) && <span className="sc-note">—</span>}
        </span>
      ),
    },
    {
      title: '排序', dataIndex: 'sort_order', key: 'sort_order', width: 70,
      className: 'sc-mono',
      render: (v: number) => <span style={{ color: '#94a3b8' }}>{v}</span>,
    },
    {
      title: '启用',
      key: 'is_active',
      width: 90,
      render: (_: any, record: PermNode) => {
        const protectedNode = PROTECTED_CODES.includes(record.code)
        const sw = (
          <Switch
            size="small"
            checked={record.is_active !== false}
            disabled={protectedNode || !canUpdate}
            onChange={(v) => handleToggleActive(record, v)}
          />
        )
        return protectedNode ? <Tooltip title="受保护权限不可停用">{sw}</Tooltip> : sw
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 170,
      fixed: 'right' as const,
      render: (_: any, record: PermNode) => (
        <span className="sc-row-act">
          <PermButton permResource="permissions" permAction="create" type="text" size="small" onClick={() => handleAdd(record.code)}>子级</PermButton>
          <PermButton permResource="permissions" permAction="update" type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <PermButton
            permResource="permissions"
            permAction="delete"
            type="text"
            size="small"
            danger
            disabled={PROTECTED_CODES.includes(record.code)}
            icon={<DeleteOutlined />}
            onClick={() => setDeleteTarget(record)}
          />
        </span>
      ),
    },
  ]

  const activeCount = flatList.filter(n => n.is_active !== false).length
  const inactiveCount = flatList.filter(n => n.is_active === false).length
  const protectedCount = flatList.filter(n => PROTECTED_CODES.includes(n.code)).length

  return (
    <div className="sc-page">
      <div className="sys-strip">
        <KeyOutlined style={{ color: '#5b5bd6' }} />
        <span>
          本页维护权限树的<b>节点定义</b>（编码 / 路由 / 可用动作），是「角色管理」权限矩阵与按钮级权限的数据来源。
          新增或停用权限将<b>全局生效</b>；<b>users / roles / permissions</b> 系统保护节点不可停用或删除。
        </span>
      </div>

      <div className="sc-toolbar">
        <span className="sc-toolbar-hint">
          共 <b style={{ color: '#334155' }}>{flatList.length}</b> 个权限节点 · 启用 {activeCount} · 停用 {inactiveCount} · 系统保护 {protectedCount}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <Button icon={<ReloadOutlined />} onClick={fetchTree}>刷新</Button>
          <PermButton permResource="permissions" permAction="create" type="primary" icon={<PlusOutlined />} onClick={() => handleAdd()}>新增顶级权限</PermButton>
        </span>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="code"
          columns={columns as any}
          dataSource={tree}
          loading={loading}
          pagination={false}
          scroll={{ x: 1300 }}
          size="small"
          expandable={{ defaultExpandedRowKeys: flatList.filter(n => !n.parent_code).map(n => n.code) }}
        />
      </div>

      {/* 新增 / 编辑权限 */}
      <Modal
        title={editingCode ? `编辑权限：${editingCode}` : '新增权限'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        width={680}
        destroyOnClose
        okText="保存"
        rootClassName="sc-page"
      >
        <Form form={form} layout="vertical">
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="code" label="权限编码" rules={[{ required: true, message: '请输入权限编码' }]} style={{ flex: 1 }}>
              <Input placeholder="如 production.schedule_plans" disabled={!!editingCode} />
            </Form.Item>
            <Form.Item name="name" label="权限名称" rules={[{ required: true, message: '请输入权限名称' }]} style={{ flex: 1 }}>
              <Input placeholder="如 计划排产" />
            </Form.Item>
          </div>
          <Form.Item name="parent_code" label="父级权限">
            <TreeSelect
              treeData={treeSelectData}
              placeholder="无（顶级权限）"
              allowClear
              treeDefaultExpandAll
            />
          </Form.Item>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="module" label="所属模块" style={{ flex: 1 }}>
              <Input placeholder="如 production（默认取编码首段）" />
            </Form.Item>
            <Form.Item name="route_path" label="前端路由" style={{ flex: 1 }}>
              <Input placeholder="如 /schedule-plans（按钮级权限可留空）" />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="actions" label="操作集（可自定义动作）" style={{ flex: 1 }}>
              <Select mode="tags" placeholder="选择或输入操作">
                {STANDARD_ACTIONS.map(a => <Select.Option key={a} value={a}>{a}</Select.Option>)}
              </Select>
            </Form.Item>
            <Form.Item name="sort_order" label="排序号" style={{ width: 140 }}>
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <div className="f-note">
            注意：新增 / 删除 / 停用权限属于<b>全局性变更</b>——删除权限会清除所有角色中对该权限的引用；停用后相关菜单与按钮将立即对所有用户隐藏，请谨慎操作。
          </div>
        </Form>
      </Modal>

      {/* 删除确认 */}
      <Modal
        title={<span style={{ color: '#dc2626' }}>删除权限</span>}
        open={!!deleteTarget}
        onOk={handleDelete}
        confirmLoading={deleting}
        onCancel={() => setDeleteTarget(null)}
        okText="删除权限"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        width={500}
        rootClassName="sc-page"
      >
        <p style={{ fontSize: 'calc(13.5px * var(--font-size-scale))', color: '#475569', lineHeight: 1.8 }}>
          确认删除权限 <b style={{ color: '#0f172a' }}>{deleteTarget?.name}（{deleteTarget?.code}）</b>？
          <br />
          删除将<b style={{ color: '#dc2626' }}>清除所有角色中对该权限的引用</b>，相关菜单入口立即隐藏。系统保护权限（users / roles / permissions）不允许删除。
        </p>
      </Modal>
    </div>
  )
}
