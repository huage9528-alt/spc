import { useCallback, useEffect, useState } from 'react'
import { Table, Input, Button, Tooltip } from 'antd'
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { auditApi } from '../../services/api'
import { useBdTable } from './components/useBdTable'
import ChipsFilter, { type ChipOption } from './components/ChipsFilter'
import BdDrawer, { DrawerSection, KvGrid } from './components/BdDrawer'

interface AuditRow {
  id: number
  table_name: string
  record_id: number
  action: string
  field_name?: string | null
  old_value?: string | null
  new_value?: string | null
  operator: string
  operated_at: string
}

interface AuditStats {
  total: number
  today: number
  action_counts: Record<string, number>
}

/* ---------- 动作 → 标签色 / 中文（原型 action 色板） ---------- */
const ACTION_META: Record<string, { label: string; cls: string }> = {
  create: { label: '创建', cls: 'sc-tag-done' },
  update: { label: '修改', cls: 'sc-tag-kit' },
  delete: { label: '删除', cls: 'sc-tag-danger' },
  import: { label: '导入', cls: 'sc-tag-purple' },
  login: { label: '登录', cls: 'sc-tag-wait' },
  export: { label: '导出', cls: 'sc-tag-amber' },
  auth: { label: '授权', cls: 'sc-tag-cyan' },
  logout: { label: '登出', cls: 'sc-tag-wait' },
  sync: { label: '同步', cls: 'sc-tag-cyan' },
  scan: { label: '扫描', cls: 'sc-tag-plain' },
  reschedule: { label: '重排', cls: 'sc-tag-amber' },
  batch_update: { label: '批量修改', cls: 'sc-tag-kit' },
  batch_create: { label: '批量创建', cls: 'sc-tag-done' },
  batch_delete: { label: '批量删除', cls: 'sc-tag-danger' },
  risk_assessment: { label: '风险扫描', cls: 'sc-tag-danger' },
}
const ACTION_PREFER = ['create', 'update', 'delete', 'auth', 'login', 'import', 'export', 'sync', 'risk_assessment']

const TABLE_ZH: Record<string, string> = {
  sys_user: '用户表',
  sys_user_role: '用户角色关系表',
  announcement: '公告表',
  notification: '通知表',
  sync_sql_config: '同步SQL配置表',
  risk_alert: '风险预警表',
  schedule_plan: '排产计划表',
  feedback: '问题反馈表',
  supplier: '供应商表',
  customer: '客户表',
  material: '物料表',
  file_asset: '文件表',
  share_link: '分享链接表',
  auth_event: '登录事件表',
  data_supply_key: '数据供给API Key表',
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#5b5bd6,#8b5cf6)',
  'linear-gradient(135deg,#0ea5e9,#14b8a6)',
  'linear-gradient(135deg,#f59e0b,#f43f5e)',
  'linear-gradient(135deg,#16a34a,#0ea5e9)',
  'linear-gradient(135deg,#8b5cf6,#5b5bd6)',
]

const opAvatarColor = (name: string) => {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length]
}

const timeAgo = (t?: string | null) => {
  if (!t) return ''
  const diff = dayjs().diff(dayjs(t), 'minute')
  if (diff < 1) return '刚刚'
  if (diff < 60) return `${diff} 分钟前`
  const h = Math.floor(diff / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

const renderOperator = (op: string) => {
  const isSys = op === 'system' || op === 'SYSTEM'
  const isApi = op.toLowerCase().includes('api')
  return (
    <span className="sys-op">
      <span
        className="um-avatar"
        style={{ background: isSys ? 'linear-gradient(135deg,#8b5cf6,#5b5bd6)' : opAvatarColor(op) }}
      >
        {op ? op.slice(0, 1).toUpperCase() : '?'}
      </span>
      <span>
        <div className="sys-op-name">{op || '—'}</div>
        <div className="sys-op-sub">
          {isSys && <span className="sc-tag sc-tag-purple" style={{ height: 16, lineHeight: '16px', padding: '0 6px', fontSize: 'calc(10px * var(--font-size-scale))' }}>system</span>}
          {isApi && <span className="api">api 调用</span>}
          {!isSys && !isApi && <span>账号操作</span>}
        </div>
      </span>
    </span>
  )
}

const renderChange = (row: AuditRow) => {
  const meta = ACTION_META[row.action] || { label: row.action, cls: 'sc-tag-plain' }
  if (row.field_name) {
    return (
      <span className="sys-chg">
        {row.old_value != null ? <span className="sys-val old">{row.old_value}</span> : null}
        {row.old_value != null && row.new_value != null && <span className="sys-arr">→</span>}
        {row.new_value != null ? (
          <span className={`sys-val new${row.action === 'delete' ? ' danger' : ''}`}>{row.new_value}</span>
        ) : null}
        {row.old_value == null && row.new_value == null && <span className="sys-val plain">—</span>}
        {meta.label === '删除' && row.field_name ? <span className="sys-arr" style={{ marginLeft: 2 }}>（{meta.label}）</span> : null}
      </span>
    )
  }
  // 无字段：整行级 / 批量操作
  const text =
    row.action === 'create' ? '整行新增'
      : row.action === 'delete' ? '整行删除'
      : row.action === 'update' ? '记录级更新（逐字段明细见详情）'
      : row.action === 'import' ? '批量导入'
      : row.action || '—'
  const cls = row.action === 'delete' ? 'sys-val danger' : row.action === 'create' || row.action === 'import' ? 'sys-val plain' : 'sys-val rec'
  return <span className={`sys-val ${cls}`}>{text}</span>
}

export default function AuditLog() {
  const [stats, setStats] = useState<AuditStats>({ total: 0, today: 0, action_counts: {} })
  const [searchText, setSearchText] = useState('')
  const [detail, setDetail] = useState<AuditRow | null>(null)
  const [history, setHistory] = useState<AuditRow[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<AuditRow>({
    url: '/basicdata/audit/logs',
    extraQuery: (c) => (c === 'all' || !c ? {} : { action: String(c) }),
    chipInit: 'all',
  })

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await auditApi.stats()
      setStats({ total: res.data?.total || 0, today: res.data?.today || 0, action_counts: res.data?.action_counts || {} })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  useEffect(() => { fetchStats() }, [fetchStats])

  const refreshAll = useCallback(() => { reload(); fetchStats() }, [reload, fetchStats])

  const onSearchChange = (v: string) => { setSearchText(v); setKeywordInput(v) }

  const openDetail = async (row: AuditRow) => {
    setDetail(row)
    setHistory([])
    setHistoryLoading(true)
    try {
      const res: any = await auditApi.list({ record_id: row.record_id, page: 1, page_size: 20 })
      setHistory((res.data?.items || []).filter((r: AuditRow) => r.id !== row.id).slice(0, 12))
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setHistoryLoading(false)
    }
  }

  const orderOf = (field: string): 'ascend' | 'descend' | null =>
    sortBy === field ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null

  // chips：从 stats 动作计数生成（按固定优先级排列 + 未知动作兜底）
  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    ...[...new Set([...ACTION_PREFER, ...Object.keys(stats.action_counts)])]
      .filter((k) => (stats.action_counts[k] ?? 0) > 0 || ACTION_META[k])
      .map((k) => ({
        label: (ACTION_META[k]?.label || k),
        value: k,
        count: stats.action_counts[k] || 0,
      })),
  ]

  const columns = [
    {
      title: '时间', dataIndex: 'operated_at', key: 'operated_at', width: 170, sorter: true,
      sortOrder: orderOf('operated_at'),
      render: (v: string) => (
        <span className="sys-tm">
          <div className="sc-mono" style={{ color: '#0f172a' }}>{v}</div>
          <div className="ago">{timeAgo(v)}</div>
        </span>
      ),
    },
    {
      title: '操作人', dataIndex: 'operator', key: 'operator', width: 200, sorter: true,
      sortOrder: orderOf('operator'),
      render: (v: string) => renderOperator(v),
    },
    {
      title: '动作', dataIndex: 'action', key: 'action', width: 90, sorter: true,
      sortOrder: orderOf('action'),
      render: (v: string) => {
        const meta = ACTION_META[v] || { label: v, cls: 'sc-tag-plain' }
        return <span className={`sc-tag ${meta.cls}`}><span className="dot" />{meta.label}</span>
      },
    },
    {
      title: '表名', dataIndex: 'table_name', key: 'table_name', width: 190, sorter: true,
      sortOrder: orderOf('table_name'),
      render: (v: string) => (
        <span>
          <div className="sc-mono" style={{ color: '#334155' }}>{v}</div>
          {TABLE_ZH[v] && <div className="sys-op-sub">{TABLE_ZH[v]}</div>}
        </span>
      ),
    },
    {
      title: '记录ID', dataIndex: 'record_id', key: 'record_id', width: 110, sorter: true,
      sortOrder: orderOf('record_id'),
      className: 'sc-mono',
    },
    {
      title: '字段', dataIndex: 'field_name', key: 'field_name', width: 150, sorter: true,
      sortOrder: orderOf('field_name'),
      render: (v: string | null) => v
        ? <span className="sc-mono" style={{ color: '#475569' }}>{v}</span>
        : <span className="sc-note">—</span>,
    },
    {
      title: '变更内容', key: 'change', width: 320,
      render: (_: any, row: AuditRow) => renderChange(row),
    },
    {
      title: '', key: 'action', width: 70, fixed: 'right' as const,
      render: (_: any, row: AuditRow) => (
        <span className="sc-row-act">
          <a onClick={() => openDetail(row)}>详情</a>
        </span>
      ),
    },
  ]

  return (
    <div className="sc-page">
      <div className="sys-strip">
        <span>覆盖<b>登录 / 增删改 / 授权变更 / 同步与系统配置</b>等写操作；ERP 同步、定时任务等系统行为标记为 <b>system</b>，API 调用标记为 <b>api</b></span>
        <span className="vsep" />
        <span>今日 <b>{stats.today.toLocaleString()}</b> 条</span>
        <span className="life">● 操作全程留痕</span>
      </div>

      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="操作人 / 表名 / 记录ID / 字段"
            style={{ width: 300 }}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            onPressEnter={commitKeyword}
          />
        </span>
        <ChipsFilter options={chipOptions} value={chip ?? 'all'} onChange={(v) => setChip(v)} />
        <span style={{ marginLeft: 'auto' }}>
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={refreshAll} />
          </Tooltip>
        </span>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          columns={columns as any}
          dataSource={items}
          loading={loading}
          size="small"
          scroll={{ x: 1300 }}
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

      <BdDrawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={560}
        title="审计详情"
        code={detail ? `#${detail.id} · ${detail.operated_at}` : ''}
        tags={detail && (
          <>
            <span className={`sc-tag ${(ACTION_META[detail.action] || { cls: 'sc-tag-plain' }).cls}`}><span className="dot" />{(ACTION_META[detail.action] || { label: detail.action }).label}</span>
            <span className="sc-tag sc-tag-kit">{detail.table_name}{TABLE_ZH[detail.table_name] ? ` · ${TABLE_ZH[detail.table_name]}` : ''}</span>
            <span className="sc-tag sc-tag-wait">记录 ID {detail.record_id}</span>
          </>
        )}
      >
        {detail && (
          <>
            <div style={{ marginTop: 12 }}>
              <DrawerSection title="操作上下文">
                <KvGrid
                  items={[
                    ['操作人', renderOperator(detail.operator)],
                    ['动作', (ACTION_META[detail.action] || { label: detail.action }).label],
                    ['表名', <span className="sc-mono" key="tb">{detail.table_name}</span>],
                    ['记录ID', <span className="sc-mono" key="rid">{detail.record_id}</span>],
                    ['操作时间', <span className="sc-mono" key="ts">{detail.operated_at}</span>],
                  ]}
                />
              </DrawerSection>
            </div>
            <DrawerSection title={detail.field_name ? `字段级变更 · ${detail.field_name}` : '变更内容'}>
              {detail.field_name ? (
                <div className="sys-ctx">
                  <div className="box">
                    <div className="hd old">改前</div>
                    <pre>{`"${detail.field_name}": `}{JSON.stringify(detail.old_value ?? null)}</pre>
                  </div>
                  <div className="box">
                    <div className="hd new">改后</div>
                    <pre>{`"${detail.field_name}": `}{JSON.stringify(detail.new_value ?? null)}</pre>
                  </div>
                </div>
              ) : (
                <div className="sys-val rec" style={{ maxWidth: '100%' }}>
                  {detail.action === 'create' ? '整行新增记录' : detail.action === 'delete' ? '整行删除记录' : '记录级更新（无字段明细）'}
                </div>
              )}
            </DrawerSection>
            <DrawerSection title={`同记录操作链路（${detail.table_name} #${detail.record_id}）`}>
              {historyLoading && <div className="sc-note">加载中…</div>}
              {!historyLoading && history.length === 0 && <div className="sc-note">暂无其它操作记录</div>}
              {!historyLoading && history.map((h) => (
                <div key={h.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px dashed #f1f5f9' }}>
                  <span className="sys-val old" style={{ flexShrink: 0, width: 132, textAlign: 'center' }}>{h.operated_at}</span>
                  <span className={`sc-tag ${(ACTION_META[h.action] || { cls: 'sc-tag-plain' }).cls}`} style={{ flexShrink: 0 }}>
                    {(ACTION_META[h.action] || { label: h.action }).label}
                  </span>
                  <span style={{ fontSize: 'calc(13px * var(--font-size-scale))', color: '#475569', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.operator}
                    {h.field_name ? ` · ${h.field_name}：` : ' · '}
                    {h.old_value != null && <span style={{ color: '#94a3b8' }}>{h.old_value} → </span>}
                    <span style={{ color: '#16a34a' }}>{h.new_value ?? '—'}</span>
                  </span>
                </div>
              ))}
            </DrawerSection>
          </>
        )}
      </BdDrawer>
    </div>
  )
}
