import { useEffect, useState } from 'react'
import { Button, Card, Form, Input, message, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Timeline, InputNumber } from 'antd'
import { PlusOutlined, DeleteOutlined, SaveOutlined, EditOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons'
import api from '../../../services/api'

interface ApprovalNode { seq: number; label: string; role: string; condition?: { field: string; op: string; value: string[] } }
interface Config { biz_type: string; biz_name?: string; nodes: ApprovalNode[]; is_active: boolean; updated_by?: string; updated_at?: string }

const DIR_VALUES = ['涨价', '降价', '新报价']

// 自检规则阈值配置卡片（读/写 /rule-config）
function RuleConfigCard() {
  const [rules, setRules] = useState<{ config_key: string; config_value: string; description?: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const load = async () => {
    setLoading(true)
    try {
      const res: any = await api.get('/purchase/price-change/rule-config')
      setRules(res.data?.items || [])
    } catch { message.error('规则加载失败') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])
  const update = (k: string, v: string) => setRules(rs => rs.map(r => r.config_key === k ? { ...r, config_value: v } : r))
  const save = async () => {
    setSaving(true)
    try {
      await api.put('/purchase/price-change/rule-config', { items: rules.map(r => ({ config_key: r.config_key, config_value: r.config_value })) })
      message.success('规则阈值已保存')
    } catch (e: any) { message.error(e.message || '保存失败') } finally { setSaving(false) }
  }
  const labelMap: Record<string, string> = {
    compare_over_max_high: '新价超历史最高价倍数 → high',
    compare_over_avg_medium: '新价超历史均价倍数 → medium',
    surge_no_history_high: '无历史时涨幅% → high',
    surge_no_history_medium: '无历史时涨幅% → medium',
    surge_over_hist_high: '有历史时涨幅超均值倍数 → high',
    surge_over_hist_medium: '有历史时涨幅超均值倍数 → medium',
    erp_price_lookback_months: 'ERP采购价回溯月数',
    require_action_note_min_len: '高风险行动项最少字数',
  }
  return (
    <Card title="自检规则阈值" size="small" style={{ marginTop: 16 }} loading={loading}
      extra={<Button type="primary" size="small" icon={<SaveOutlined />} loading={saving} onClick={save}>保存</Button>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {rules.map(r => (
          <div key={r.config_key}>
            <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>{labelMap[r.config_key] || r.description || r.config_key}</div>
            <InputNumber value={r.config_value} onChange={(v) => update(r.config_key, String(v ?? ''))} style={{ width: '100%' }} step={r.config_key.startsWith('compare') || r.config_key.startsWith('surge_over') ? 0.1 : 1} />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: '#94a3b8' }}>调整后对新提交的自检生效，不影响已审批单。倍数类阈值如 1.1 = 超出10%。</div>
    </Card>
  )
}

export default function ApprovalConfigCenter() {
  const [configs, setConfigs] = useState<Config[]>([])
  const [loading, setLoading] = useState(false)
  const [roles, setRoles] = useState<{ role_code: string; role_name: string }[]>([])
  const [editing, setEditing] = useState<Config | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newBizType, setNewBizType] = useState('')
  const [search, setSearch] = useState('')

  const load = async () => {
    setLoading(true)
    try { const res: any = await api.get('/purchase/price-change/approval-configs'); setConfigs(res.data?.items || []) } catch { message.error('加载失败') } finally { setLoading(false) }
  }
  useEffect(() => { load(); (async () => { try { const r: any = await api.get('/basicdata/users/roles'); setRoles((r.data?.items || r.data || []).map((x: any) => ({ role_code: x.role_code || x.id || '', role_name: x.role_name || x.role_code || x.name || '' }))) } catch { } })() }, [])

  const openEdit = (cfg: Config) => {
    setEditing({ ...cfg, nodes: (cfg.nodes || []).map((n, i) => ({ ...n, seq: n.seq || i + 1 })) })
    setModalOpen(true)
  }
  const openNew = () => { setEditing(null); setNewBizType(''); setModalOpen(true) }
  const createAndEdit = async () => {
    if (!newBizType.trim()) return message.error('请输入标识')
    await api.put(`/purchase/price-change/approval-configs/${newBizType}`, { biz_name: '', nodes: [], is_active: true })
    message.success('已创建')
    const cfg: Config = { biz_type: newBizType.trim(), biz_name: '', nodes: [], is_active: true }
    setEditing(cfg); setNewBizType('')
  }

  const upNode = (idx: number, f: string, v: any) => {
    if (!editing) return
    setEditing({ ...editing, nodes: editing.nodes.map((n, i) => i === idx ? { ...n, [f]: v } : n) })
  }
  const addNode = () => {
    if (!editing) return
    const maxSeq = editing.nodes.reduce((m, n) => Math.max(m, n.seq), 0)
    setEditing({ ...editing, nodes: [...editing.nodes, { seq: maxSeq + 1, label: '', role: '' }] })
  }
  const rmNode = (idx: number) => {
    if (!editing) return
    setEditing({ ...editing, nodes: editing.nodes.filter((_, i) => i !== idx).map((n, i) => ({ ...n, seq: i + 1 })) })
  }
  const moveNode = (idx: number, dir: number) => {
    if (!editing) return
    const ns = [...editing.nodes]
    const target = idx + dir
    if (target < 0 || target >= ns.length) return;
    [ns[idx], ns[target]] = [ns[target], ns[idx]]
    setEditing({ ...editing, nodes: ns.map((n, i) => ({ ...n, seq: i + 1 })) })
  }

  const saveEditing = async () => {
    if (!editing) return
    if (editing.nodes.length === 0) return message.error('至少需要一个审批节点')
    if (editing.nodes.some(n => !n.label || !n.role)) return message.error('每个节点需填写名称和角色')
    setSaving(true)
    try {
      await api.put(`/purchase/price-change/approval-configs/${editing.biz_type}`, {
        biz_name: editing.biz_name || '',
        nodes: editing.nodes.map(n => {
          const item: any = { seq: n.seq, label: n.label, role: n.role }
          if (n.condition && n.condition.value && n.condition.value.length > 0) item.condition = n.condition
          return item
        }),
        is_active: editing.is_active,
      })
      message.success('保存成功')
      setModalOpen(false); setEditing(null); load()
    } catch (e: any) { message.error(e.message || '保存失败') } finally { setSaving(false) }
  }

  const delConfig = async (bt: string) => { try { await api.delete(`/purchase/price-change/approval-configs/${bt}`); message.success('已删除'); load() } catch (e: any) { message.error(e.message || '删除失败') } }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>审批流程配置中心</div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>新建单据类型</Button>
      </div>
      <Input.Search placeholder="搜索" value={search} onChange={e => setSearch(e.target.value)} style={{ marginBottom: 12, maxWidth: 400 }} allowClear />
      <Table rowKey="biz_type" dataSource={configs.filter(c => !search || c.biz_type.includes(search) || (c.biz_name || '').includes(search))} loading={loading} size="small" pagination={false}
        columns={[
          { title: '单据类型', dataIndex: 'biz_type', width: 130, render: (v: string) => <Tag color="blue">{v}</Tag> },
          { title: '名称', dataIndex: 'biz_name', width: 130, render: (v: string) => v || <span style={{ color: '#cbd5e1' }}>-</span> },
          { title: '审批流', dataIndex: 'nodes', render: (nodes: ApprovalNode[]) => <Space wrap size={[4, 2]}>{(nodes || []).map((n, i) => <span key={i} style={{ fontSize: 12 }}>{i > 0 && ' → '}{n.label}{n.condition?.value?.length ? <Tag style={{ fontSize: 10, marginLeft: 4 }} color="orange">{n.condition.value.join('/')}</Tag> : null}</span>)}</Space> },
          { title: '状态', dataIndex: 'is_active', width: 60, render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '停用'}</Tag> },
          { title: '操作', width: 100, render: (_: any, r: Config) => <Space><Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(r)}>编辑</Button><Popconfirm title="删除？" onConfirm={() => delConfig(r.biz_type)}><Button size="small" type="link" danger icon={<DeleteOutlined />} /></Popconfirm></Space> },
        ]} />

      <Modal title="新建单据类型" open={!editing && modalOpen} onCancel={() => setModalOpen(false)} footer={null}>
        <Input placeholder="标识，如 purchase_order" value={newBizType} onChange={e => setNewBizType(e.target.value)} onPressEnter={createAndEdit} style={{ marginBottom: 12 }} />
        <Button type="primary" block onClick={createAndEdit}>创建并配置</Button>
      </Modal>

      <RuleConfigCard />

      <Modal title={editing ? `编辑审批流 - ${editing.biz_name || editing.biz_type}` : ''} open={!!editing && modalOpen} width={900}
        onCancel={() => { setModalOpen(false); setEditing(null) }}
        footer={<Space><Button onClick={() => { setModalOpen(false); setEditing(null) }}>取消</Button><Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={saveEditing}>保存</Button></Space>}>
        {editing && (<div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <Input size="small" style={{ width: 180 }} value={editing.biz_name || ''} onChange={e => setEditing({ ...editing, biz_name: e.target.value })} placeholder="名称如 调价单审批" />
            <span style={{ fontSize: 13, lineHeight: '24px' }}>启用: <Switch checked={editing.is_active} onChange={v => setEditing({ ...editing, is_active: v })} /></span>
            <div style={{ flex: 1 }} />
            <Button icon={<PlusOutlined />} onClick={addNode}>添加节点</Button>
          </div>

          {/* 可视化审批流 */}
          <div style={{ background: '#f8fafc', borderRadius: 8, padding: 24, minHeight: 300 }}>
            <Timeline
              items={[
                { color: '#3b82f6', dot: <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>起</span></div>, children: <span style={{ fontSize: 14, fontWeight: 600, color: '#3b82f6' }}>开始</span> },
                ...editing.nodes.map((n, idx) => ({
                  color: n.condition?.value?.length ? '#fa8c16' : '#52c41a',
                  children: (
                    <Card size="small" style={{ marginBottom: 0, width: '100%', maxWidth: 600, borderColor: n.condition?.value?.length ? '#ffd591' : '#b7eb8f' }}
                      title={<span style={{ fontSize: 13 }}>{n.label || '未命名'}</span>}
                      extra={
                        <Space size={4}>
                          <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={idx === 0} onClick={() => moveNode(idx, -1)} />
                          <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={idx === editing.nodes.length - 1} onClick={() => moveNode(idx, 1)} />
                          <Popconfirm title="删除节点？" onConfirm={() => rmNode(idx)}><Button size="small" type="text" danger icon={<DeleteOutlined />} /></Popconfirm>
                        </Space>
                      }>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Input size="small" placeholder="节点名称" value={n.label} onChange={e => upNode(idx, 'label', e.target.value)} style={{ width: 160 }} />
                        <Select size="small" placeholder="角色" value={n.role || undefined} onChange={v => upNode(idx, 'role', v)} style={{ width: 220 }} showSearch
                          options={[
                            { value: '__dept_manager__', label: '👥 动态：申请人部门经理（按直接上级解析）' },
                            ...roles.map(r => ({ value: r.role_code, label: `${r.role_name} (${r.role_code})` })),
                          ]} />
                        <Select size="small" mode="multiple" placeholder="类型条件（可选）" value={n.condition?.value || undefined}
                          onChange={v => upNode(idx, 'condition', v?.length ? { field: 'price_direction', op: 'in', value: v } : undefined)}
                          style={{ width: 200 }} options={DIR_VALUES.map(v => ({ value: v, label: v }))} allowClear />
                      </div>
                    </Card>
                  ),
                })),
                { color: '#94a3b8', dot: <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>终</span></div>, children: <span style={{ fontSize: 14, fontWeight: 600, color: '#94a3b8' }}>结束</span> },
              ]}
            />
            {editing.nodes.length === 0 && <div style={{ textAlign: 'center', color: '#cbd5e1', padding: 40 }}>点击「添加节点」配置审批流程</div>}
          </div>
        </div>)}
      </Modal>
    </div>
  )
}
