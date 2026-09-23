import { useState } from 'react'
import { Button, Card, Form, Input, InputNumber, Modal, Radio, Select, Space, Table, Tag, Timeline } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import type { ApprovalCondition, ApprovalNodeConfig, ApprovalUserOption } from '../services/approval'

// 与后端 approval_metrics.DEFAULT_TIMEOUT_HOURS 对齐：未配置超时的节点按 48 小时提醒
const DEFAULT_TIMEOUT_HOURS = 48

const OP_OPTIONS = [
  { value: '>=', label: '≥ 大于等于' },
  { value: '<=', label: '≤ 小于等于' },
  { value: '>', label: '> 大于' },
  { value: '<', label: '< 小于' },
  { value: '==', label: '= 等于' },
  { value: '!=', label: '≠ 不等于' },
  { value: 'in', label: 'in 属于（逗号分隔）' },
]

type FormValues = {
  label: string
  approverMode: 'role' | 'users'
  role?: string
  approvers?: number[]
  timeout_hours?: number | null
  conditions?: Array<{ field: string; op: string; value?: string }>
}

export default function ApprovalChainEditor({ nodes, onChange, roleOptions, userOptions, fieldOptions }: {
  nodes: ApprovalNodeConfig[]
  onChange: (nodes: ApprovalNodeConfig[]) => void
  roleOptions: { value: string; label: string }[]
  userOptions: ApprovalUserOption[]
  fieldOptions: Array<{ value: string; label: string }>
}) {
  const [editing, setEditing] = useState<ApprovalNodeConfig | null>(null)
  const [isEdit, setIsEdit] = useState(false)
  const [form] = Form.useForm<FormValues>()

  const userLabel = (username?: string, userId?: number) => {
    const hit = userOptions.find(u => u.username === username || u.id === userId)
    return hit ? `${hit.display_name || hit.username}（${hit.username}）` : username || String(userId ?? '')
  }
  const roleLabel = (v?: string) => roleOptions.find(o => o.value === v)?.label || v || '-'
  const fieldLabel = (v: string) => fieldOptions.find(o => o.value === v)?.label || v

  const condsOf = (node: ApprovalNodeConfig): ApprovalCondition[] =>
    node.conditions?.length ? node.conditions : (node.condition ? [node.condition] : [])

  const condText = (c: ApprovalCondition) => {
    const op = OP_OPTIONS.find(o => o.value === c.op)?.label?.split(' ')[0] || c.op
    const val = Array.isArray(c.value) ? c.value.join(', ') : c.value
    return `${fieldLabel(c.field)} ${op} ${val}`
  }

  const openNew = () => {
    setIsEdit(false)
    setEditing({ label: '', role: '' })
    form.setFieldsValue({ label: '', approverMode: 'role', role: undefined, approvers: [], timeout_hours: DEFAULT_TIMEOUT_HOURS, conditions: [] })
  }

  const openEdit = (row: ApprovalNodeConfig) => {
    setIsEdit(true)
    setEditing(row)
    form.setFieldsValue({
      label: row.label,
      approverMode: row.approvers?.length ? 'users' : 'role',
      role: row.role,
      approvers: (row.approvers || []).map(a => a.user_id).filter(Boolean) as number[],
      // 历史节点未配超时时后端按默认 48 小时提醒，回填默认值避免「只改别的字段」被静默改成不提醒
      timeout_hours: row.timeout_hours ?? DEFAULT_TIMEOUT_HOURS,
      conditions: condsOf(row).map(c => ({
        field: c.field,
        op: c.op,
        value: Array.isArray(c.value) ? c.value.join(',') : String(c.value ?? ''),
      })),
    })
  }

  const saveNode = async () => {
    const v = await form.validateFields()
    const node: ApprovalNodeConfig = { label: v.label.trim() }
    if (v.approverMode === 'users') {
      node.role = ''
      node.approvers = (v.approvers || []).map(id => {
        const hit = userOptions.find(u => u.id === id)
        return { user_id: id, username: hit?.username }
      })
    } else {
      node.role = v.role
    }
    node.timeout_hours = v.timeout_hours ?? 0
    const conditions: ApprovalCondition[] = (v.conditions || [])
      .filter(c => c && c.field && c.op && c.value !== undefined && c.value !== '')
      .map(c => ({
        field: c.field,
        op: c.op as ApprovalCondition['op'],
        value: c.op === 'in' ? String(c.value).split(',').map(s => s.trim()).filter(Boolean) : Number(c.value),
      }))
    if (conditions.length) node.conditions = conditions
    const next = isEdit
      ? nodes.map(n => (n === editing ? node : n))
      : [...nodes, node]
    onChange(next.map((n, i) => ({ ...n, seq: i + 1 })))
    setEditing(null)
  }

  const removeNode = (row: ApprovalNodeConfig) => onChange(nodes.filter(n => n !== row).map((n, i) => ({ ...n, seq: i + 1 })))

  const move = (index: number, dir: -1 | 1) => {
    const next = [...nodes]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next.map((n, i) => ({ ...n, seq: i + 1 })))
  }

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button icon={<PlusOutlined />} onClick={openNew}>新增节点</Button>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>节点按顺序执行；触发条件不满足的节点自动跳过；超时 0 表示不提醒</span>
      </div>
      <Table<ApprovalNodeConfig> rowKey={(_, i) => String(i)} dataSource={nodes} pagination={false}
        columns={[
          { title: '顺序', width: 60, render: (_: any, __: any, i: number) => i + 1 },
          { title: '节点名称', dataIndex: 'label' },
          { title: '审批人', width: 220, render: (_: any, r: ApprovalNodeConfig) => r.approvers?.length
            ? <Space size={4} wrap>{r.approvers.map(a => <Tag key={a.user_id || a.username} color="purple">{userLabel(a.username, a.user_id)}</Tag>)}</Space>
            : <Tag color="blue">{roleLabel(r.role)}</Tag> },
          { title: '触发条件', render: (_: any, r: ApprovalNodeConfig) => {
            const conds = condsOf(r)
            return conds.length
              ? <Space size={4} wrap>{conds.map((c, i) => <Tag key={i} color="orange">{condText(c)}</Tag>)}</Space>
              : <Tag>始终</Tag>
          } },
          { title: '超时提醒', width: 100, render: (_: any, r: ApprovalNodeConfig) =>
            r.timeout_hours ? `${r.timeout_hours} 小时` : <span style={{ color: '#94a3b8' }}>不提醒</span> },
          { title: '操作', width: 210, render: (_: any, row: ApprovalNodeConfig, i: number) => (
            <Space size={0}>
              <Button size="small" type="link" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => move(i, -1)} />
              <Button size="small" type="link" icon={<ArrowDownOutlined />} disabled={i === nodes.length - 1} onClick={() => move(i, 1)} />
              <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(row)}>编辑</Button>
              <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => removeNode(row)} />
            </Space>
          ) },
        ]} />
      <div style={{ marginTop: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>链路预览</div>
        {nodes.length === 0 ? <div style={{ color: '#94a3b8' }}>暂无节点，保存会被拒绝</div> : (
          <Timeline
            items={nodes.map((n, i) => ({
              children: (
                <Space size={8} wrap>
                  <span style={{ fontWeight: 600 }}>{i + 1}. {n.label}</span>
                  {n.approvers?.length
                    ? n.approvers.map(a => <Tag key={a.user_id || a.username} color="purple">{userLabel(a.username, a.user_id)}</Tag>)
                    : <Tag>{roleLabel(n.role)}</Tag>}
                  {condsOf(n).map((c, ci) => <Tag key={ci} color="orange">{condText(c)}</Tag>)}
                  {n.timeout_hours ? <Tag color="red">超时 {n.timeout_hours}h</Tag> : null}
                </Space>
              ),
            }))}
          />
        )}
      </div>

      <Modal title={isEdit ? '编辑节点' : '新增节点'} open={!!editing} onOk={saveNode}
        onCancel={() => setEditing(null)} destroyOnClose width={640}>
        <Form form={form} layout="vertical">
          <Form.Item name="label" label="节点名称" rules={[{ required: true, message: '请输入节点名称' }]}>
            <Input placeholder="如：采购经理审批" maxLength={32} />
          </Form.Item>
          <Form.Item name="approverMode" label="审批人" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio.Button value="role">按角色</Radio.Button>
              <Radio.Button value="users">指定人员</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.approverMode !== c.approverMode}>
            {({ getFieldValue }) => getFieldValue('approverMode') === 'users' ? (
              <Form.Item name="approvers" label="指定审批人（可多选，任一通过即推进）"
                rules={[{ required: true, message: '请至少选择一位审批人' }]}>
                <Select mode="multiple" showSearch optionFilterProp="label" placeholder="搜索姓名 / 用户名"
                  options={userOptions.map(u => ({ value: u.id, label: `${u.display_name || u.username}（${u.username}${u.role_name ? ' · ' + u.role_name : ''}）` }))} />
              </Form.Item>
            ) : (
              <Form.Item name="role" label="审批角色" rules={[{ required: true, message: '请选择审批角色' }]}>
                <Select options={roleOptions} placeholder="选择审批角色" />
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item name="timeout_hours" label="超时提醒（小时，0 = 不提醒；到时推送站内信 + 企微，同一节点 24h 去重）">
            <InputNumber min={0} max={720} precision={0} style={{ width: 200 }} />
          </Form.Item>
          <Form.List name="conditions">
            {(fields, { add, remove }) => (
              <Card size="small" title="触发条件（全部满足才进入本节点，留空 = 无条件）"
                extra={<Button size="small" type="link" icon={<PlusOutlined />} onClick={() => add({ field: fieldOptions[0]?.value, op: '>=', value: '' })}>添加条件</Button>}>
                {fields.length === 0 ? <span style={{ color: '#94a3b8', fontSize: 12 }}>无条件：任何金额都会进入本节点</span> : null}
                {fields.map(f => (
                  <Space key={f.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }} wrap>
                    <Form.Item {...f} name={[f.name, 'field']} rules={[{ required: true, message: '选择字段' }]} style={{ marginBottom: 0 }}>
                      <Select style={{ width: 180 }} options={fieldOptions} placeholder="条件字段" />
                    </Form.Item>
                    <Form.Item {...f} name={[f.name, 'op']} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
                      <Select style={{ width: 170 }} options={OP_OPTIONS} />
                    </Form.Item>
                    <Form.Item {...f} name={[f.name, 'value']} rules={[{ required: true, message: '填写阈值' }]} style={{ marginBottom: 0 }}>
                      <Input style={{ width: 160 }} placeholder="阈值 / 逗号分隔" />
                    </Form.Item>
                    <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => remove(f.name)} />
                  </Space>
                ))}
              </Card>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  )
}
