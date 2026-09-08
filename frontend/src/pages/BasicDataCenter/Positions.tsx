import { useCallback, useEffect, useState } from 'react'
import { Button, Input, message, Modal, Table, Tooltip, type TableColumnsType } from 'antd'
import {
  InfoCircleOutlined, ReloadOutlined, SearchOutlined, ExportOutlined,
  FileTextOutlined, SyncOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../../services/api'
import PermButton from '../../components/PermButton'
import KpiBand, { type KpiItem } from './components/KpiBand'
import ChipsFilter, { type ChipOption } from './components/ChipsFilter'
import { useBdTable } from './components/useBdTable'

interface Position {
  id: number
  position_code?: string | null
  oa_position_id?: string | null
  position_name: string
  status: number
  data_source?: string | null
  create_time: string
}

interface PositionStats {
  total: number
  enabled: number
  disabled: number
}

interface SyncStatusEntry {
  timestamp?: string | null
  status?: string | null
  message?: string | null
}

interface SyncTask {
  task_id: string
  sync_type: string
  trigger_mode?: string | null
  status: string
  started_at?: string | null
  finished_at?: string | null
  synced_count?: number | null
  created_count?: number | null
  updated_count?: number | null
  failed_count?: number | null
  message?: string | null
  created_at?: string | null
}

const SYNC_STATUS_META: Record<string, { text: string; color: string; bg: string }> = {
  success: { text: '成功', color: '#16a34a', bg: '#f0fdf4' },
  failed: { text: '失败', color: '#dc2626', bg: '#fef2f2' },
  running: { text: '进行中', color: '#0284c7', bg: '#f0f9ff' },
  pending: { text: '排队中', color: '#64748b', bg: '#f1f5f9' },
}

const renderStatus = (status: number) =>
  status === 1 ? (
    <span className="sc-tag sc-tag-done"><span className="dot" />启用</span>
  ) : (
    <span className="sc-tag" style={{ color: '#94a3b8', background: '#f1f5f9' }}><span className="dot" />停用</span>
  )

const renderSource = (v?: string | null) =>
  v === 'erp' ? (
    <span className="sc-tag" style={{ color: '#0284c7', background: '#f0f9ff' }}>ERP</span>
  ) : (
    <span className="sc-tag" style={{ color: '#8b5cf6', background: '#f5f3ff' }}>OA 同步</span>
  )

const CSV_HEADER = ['OA岗位ID', '岗位名称', '状态', '来源', '创建时间']

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const exportPositionsCsv = (rows: Position[], filename: string) => {
  if (rows.length === 0) return
  const lines = [
    CSV_HEADER,
    ...rows.map((r) => [
      r.oa_position_id || '',
      r.position_name,
      r.status === 1 ? '启用' : '停用',
      r.data_source === 'erp' ? 'ERP' : 'OA 同步',
      r.create_time ? dayjs(r.create_time).format('YYYY-MM-DD') : '',
    ]),
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

const logColumns: TableColumnsType<SyncTask> = [
  {
    title: '状态',
    dataIndex: 'status',
    key: 'status',
    width: 80,
    render: (v: string) => {
      const meta = SYNC_STATUS_META[v] || { text: v, color: '#64748b', bg: '#f1f5f9' }
      return <span className="sc-tag" style={{ color: meta.color, background: meta.bg }}><span className="dot" />{meta.text}</span>
    },
  },
  {
    title: '触发',
    dataIndex: 'trigger_mode',
    key: 'trigger_mode',
    width: 70,
    render: (v?: string | null) =>
      v === 'manual' ? '手动' : v === 'scheduled' ? '定时' : v || '—',
  },
  {
    title: '开始时间',
    dataIndex: 'started_at',
    key: 'started_at',
    width: 120,
    className: 'sc-mono',
    render: (v?: string | null) => (v ? dayjs(v).format('MM-DD HH:mm:ss') : '—'),
  },
  {
    title: '结束时间',
    dataIndex: 'finished_at',
    key: 'finished_at',
    width: 120,
    className: 'sc-mono',
    render: (v?: string | null) => (v ? dayjs(v).format('MM-DD HH:mm:ss') : '—'),
  },
  {
    title: '结果摘要',
    key: 'summary',
    render: (_: unknown, r: SyncTask) => (
      <span className="sc-mono" style={{ fontSize: 12 }}>
        处理 {r.synced_count ?? 0} · 新增 {r.created_count ?? 0} · 更新 {r.updated_count ?? 0} · 失败 {r.failed_count ?? 0}
      </span>
    ),
  },
]

export default function Positions() {
  const [stats, setStats] = useState<PositionStats>({ total: 0, enabled: 0, disabled: 0 })
  const [lastSync, setLastSync] = useState<SyncStatusEntry | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [logTasks, setLogTasks] = useState<SyncTask[]>([])
  const [logLoading, setLogLoading] = useState(false)
  const [searchText, setSearchText] = useState('')

  const extraQuery = useCallback((chip: string | number | null): Record<string, any> => {
    if (chip === 'on') return { status: '1' }
    if (chip === 'off') return { status: '0' }
    return {}
  }, [])

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<Position>({ url: '/basicdata/positions', extraQuery, chipInit: 'all' })

  const onSearchChange = (v: string) => {
    setSearchText(v)
    setKeywordInput(v)
  }

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/positions/stats')
      setStats({
        total: res.data?.total || 0,
        enabled: res.data?.enabled || 0,
        disabled: res.data?.disabled || 0,
      })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res: any = await api.get('/basicdata/sync/status', { skipErrorToast: true })
      setLastSync(res.data?.last_sync?.positions ?? null)
    } catch {
      // 无 settings 读权限时静默降级为「暂无记录」
    }
  }, [])

  useEffect(() => {
    fetchStats()
    fetchSyncStatus()
  }, [fetchStats, fetchSyncStatus])

  const refreshAll = useCallback(() => {
    reload()
    fetchStats()
    fetchSyncStatus()
  }, [reload, fetchStats, fetchSyncStatus])

  const handleManualSync = async () => {
    setSyncing(true)
    try {
      await api.post('/basicdata/sync/positions')
      message.success('已触发同步，稍后自动刷新')
      setTimeout(() => {
        fetchSyncStatus()
        fetchStats()
        reload()
      }, 5000)
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setSyncing(false)
    }
  }

  const openSyncLog = async () => {
    setLogOpen(true)
    setLogLoading(true)
    try {
      const res: any = await api.get('/basicdata/sync/tasks', { params: { sync_type: 'positions', limit: 5 } })
      setLogTasks(res.data || [])
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setLogLoading(false)
    }
  }

  const lastSyncTime = lastSync?.timestamp ? dayjs(lastSync.timestamp).format('MM-DD HH:mm') : '暂无记录'

  const kpiItems: KpiItem[] = [
    { label: '岗位总数', value: stats.total.toLocaleString(), accent: 'brand', sub: 'OA 同步' },
    { label: '启用', value: stats.enabled.toLocaleString(), accent: 'success', sub: '可在员工档案中选择' },
    { label: '停用 · 历史保留', value: stats.disabled.toLocaleString(), accent: 'gray', go: '查看 →', onClick: () => setChip('off') },
  ]

  const chipOptions: ChipOption[] = [
    { label: '全部', value: 'all', count: stats.total },
    { label: '启用', value: 'on', count: stats.enabled },
    { label: '停用', value: 'off', count: stats.disabled },
  ]

  const orderOf = (field: string): 'ascend' | 'descend' | null =>
    sortBy === field ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null

  const columns: TableColumnsType<Position> = [
    {
      title: 'OA 岗位 ID',
      dataIndex: 'oa_position_id',
      key: 'oa_position_id',
      width: 150,
      sorter: true,
      sortOrder: orderOf('oa_position_id'),
      render: (v?: string | null) =>
        v ? <span className="sc-mono" style={{ fontWeight: 600 }}>{v}</span> : <span className="sc-note">—</span>,
    },
    {
      title: '岗位名称',
      dataIndex: 'position_name',
      key: 'position_name',
      sorter: true,
      sortOrder: orderOf('position_name'),
      render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: number) => renderStatus(v),
    },
    {
      title: '来源',
      dataIndex: 'data_source',
      key: 'data_source',
      width: 110,
      render: (v?: string | null) => renderSource(v),
    },
    {
      title: '创建时间',
      dataIndex: 'create_time',
      key: 'create_time',
      width: 120,
      className: 'sc-mono',
      render: (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD') : '—'),
    },
  ]

  return (
    <div className="sc-page">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          marginBottom: 12,
          background: '#f0f9ff',
          border: '1px solid #bae6fd',
          borderRadius: 10,
          fontSize: 13,
          color: '#075985',
          flexWrap: 'wrap',
        }}
      >
        <InfoCircleOutlined style={{ fontSize: 16, flexShrink: 0 }} />
        <span>
          岗位字典由 <b>组织人事系统（OA）</b>单向同步维护，本页面为只读 —— 新增 / 变更岗位请前往 OA 发起。
        </span>
        <span className="sc-mono" style={{ whiteSpace: 'nowrap' }}>
          上次同步：<b>{lastSyncTime}</b>
          {lastSync?.status === 'failed' && <span style={{ color: '#d97706' }}>（上次失败）</span>}
          {' '}· 每日一次
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <PermButton
            permResource="settings"
            permAction="create"
            size="small"
            icon={<SyncOutlined />}
            loading={syncing}
            onClick={handleManualSync}
          >
            手动同步
          </PermButton>
          <Button type="text" size="small" icon={<FileTextOutlined />} style={{ color: '#075985' }} onClick={openSyncLog}>
            同步日志
          </Button>
        </span>
      </div>

      <KpiBand items={kpiItems} />

      <div className="sc-toolbar">
        <span className="sc-search">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="岗位名称 / OA 岗位 ID"
            style={{ width: 240 }}
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
            onClick={() => exportPositionsCsv(items, `岗位字典_${dayjs().format('YYYY-MM-DD')}.csv`)}
          >
            导出
          </Button>
        </span>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          size="small"
          scroll={{ x: 800 }}
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

      <Modal
        title="岗位同步日志（最近 5 次）"
        open={logOpen}
        onCancel={() => setLogOpen(false)}
        footer={null}
        width={640}
        rootClassName="sc-page"
      >
        <Table
          rowKey="task_id"
          size="small"
          columns={logColumns}
          dataSource={logTasks}
          loading={logLoading}
          pagination={false}
          style={{ marginTop: 8 }}
        />
      </Modal>
    </div>
  )
}
