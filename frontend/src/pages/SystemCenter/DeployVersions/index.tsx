import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, Card, Drawer, Input, Modal, Space, Table, Tag, Tooltip, Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiOutlined, CheckCircleOutlined, ClockCircleOutlined, CloudUploadOutlined,
  DatabaseOutlined, DownloadOutlined, HistoryOutlined, ReloadOutlined,
  RocketOutlined, RollbackOutlined, SyncOutlined,
} from '@ant-design/icons'
import {
  deployApi, openDeployJobStream,
  type DeployEventHandler, type DeployStatus, type DeployVersionRow,
  type VersionDetail, type JobCreated,
} from '../../../services/deployVersions'
import { useAuthStore } from '../../../store/auth'
import './deploy-versions.css'

const { Text, Title } = Typography
const { TextArea } = Input

const STEPS = [
  '拉取 Git',
  '构建后端',
  '构建前端',
  '打包上传',
  '加载镜像',
  '健康检查',
  '切换并清理',
]

type ChipKey = 'all' | 'current' | 'ok' | 'missing'

interface StreamState {
  steps: Record<number, 'pending' | 'running' | 'ok' | 'fail'>
  phase: string
  logs: Array<{ ts: string; level: string; msg: string }>
  currentStep: number | null
  status: 'running' | 'ok' | 'fail' | null
  finalVersion?: string
}

const PHASE_LABEL: Record<string, string> = {
  load_env: '恢复 .env 快照',
  tag_image: '切换镜像 latest 标签',
  compose_up: 'docker compose up -d',
  health_check: '健康检查（后端 ping + 前端 200）',
  write_current: '更新 current.txt',
}

const EMPTY_STREAM: StreamState = { steps: {}, phase: '', logs: [], currentStep: null, status: null }

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '-'
  const mb = n / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

function fmtHumanSize(n?: number | null): string {
  if (n === null || n === undefined || n <= 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtRunTime(created: string): string {
  const ts = new Date(created.replace(' ', 'T'))
  if (isNaN(ts.getTime())) return ''
  const diff = Math.floor((Date.now() - ts.getTime()) / 1000)
  if (diff < 0) return ''
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (h > 0) return `已运行 ${h}h ${m}m`
  if (m > 0) return `已运行 ${m}m`
  return '刚刚部署'
}

export default function DeployVersionsPage() {
  const hasPermission = useAuthStore((s: any) => s.hasPermission) as (r: string, a: string) => boolean
  const canManage = hasPermission('deploy_versions', 'manage')
  const canView = hasPermission('deploy_versions', 'read')

  const [versions, setVersions] = useState<DeployVersionRow[]>([])
  const [status, setStatus] = useState<DeployStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [chip, setChip] = useState<ChipKey>('all')
  const [syncedAt, setSyncedAt] = useState<Date | null>(null)

  // 抽屉
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerVer, setDrawerVer] = useState<string>('')
  const [detail, setDetail] = useState<VersionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [deployModal, setDeployModal] = useState(false)
  const [switchModal, setSwitchModal] = useState<{ open: boolean; row: DeployVersionRow | null }>({ open: false, row: null })
  const [rollbackModal, setRollbackModal] = useState(false)
  const [progressModal, setProgressModal] = useState<{ open: boolean; title: string; mode: 'deploy' | 'switch'; jobId?: string }>(
    { open: false, title: '', mode: 'deploy' },
  )

  const [deployNote, setDeployNote] = useState('')
  const [autoRollback, setAutoRollback] = useState(true)
  const [skipBuild, setSkipBuild] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const elapsedTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM)
  const streamCloseRef = useRef<(() => void) | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [v, s] = await Promise.all([deployApi.list(), deployApi.status()])
      setVersions(v || [])
      setStatus(s || null)
      setSyncedAt(new Date())
    } catch {
      /* interceptor handles errors */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30000)
    return () => clearInterval(t)
  }, [refresh])

  const startStream = useCallback((jobId: string, title: string, mode: 'deploy' | 'switch' = 'deploy') => {
    setStream(EMPTY_STREAM)
    setElapsed(0)
    setProgressModal({ open: true, title, mode, jobId })
    if (elapsedTimer.current) clearInterval(elapsedTimer.current)
    elapsedTimer.current = setInterval(() => setElapsed((e) => e + 1), 1000)

    const onEv: DeployEventHandler = ({ name, data }) => {
      setStream((prev) => {
        if (name === 'step') {
          const next = { ...prev.steps }
          const idx = Number(data.step ?? Object.keys(next).length)
          next[idx] = data.status
          return {
            ...prev,
            steps: next,
            currentStep: data.status === 'running' ? idx : prev.currentStep,
            logs: [...prev.logs, { ts: data.ts || now(), level: 'INF', msg: `[STEP ${data.name || idx + 1}] ${data.name ?? ''} ${data.status}` }],
          }
        }
        if (name === 'phase') {
          return {
            ...prev,
            phase: PHASE_LABEL[data.phase] || data.phase || prev.phase,
            logs: [...prev.logs, { ts: data.ts || now(), level: 'INF', msg: `→ ${PHASE_LABEL[data.phase] || data.phase || ''}` }],
          }
        }
        if (name === 'log') {
          return {
            ...prev,
            logs: [...prev.logs, { ts: data.ts || now(), level: (data.level || 'INF').toUpperCase(), msg: data.msg || '' }].slice(-600),
          }
        }
        if (name === 'error') {
          return { ...prev, status: 'fail', logs: [...prev.logs, { ts: data.ts || now(), level: 'ERR', msg: data.detail || 'stream error' }] }
        }
        if (name === 'end' || name === 'message') {
          const ok = data?.status === 'ok'
          return {
            ...prev,
            status: ok ? 'ok' : 'fail',
            finalVersion: data?.version,
            logs: [...prev.logs, { ts: data.ts || now(), level: ok ? 'OK' : 'ERR', msg: `job end: status=${data?.status}` }],
          }
        }
        return prev
      })
    }
    streamCloseRef.current = openDeployJobStream(jobId, onEv)
  }, [])

  useEffect(() => () => {
    streamCloseRef.current?.()
    streamCloseRef.current = null
    if (elapsedTimer.current) clearInterval(elapsedTimer.current)
  }, [])

  const openDrawer = useCallback(async (ver: string) => {
    setDrawerVer(ver)
    setDetail(null)
    setDrawerOpen(true)
    setDetailLoading(true)
    try {
      const d = await deployApi.detail(ver)
      setDetail(d || null)
    } catch {
      /* handled */
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const triggerRollback = useCallback(async () => {
    setRollbackModal(false)
    try {
      const job = (await deployApi.rollback('')) as JobCreated
      startStream(job.job_id, '回退到上一版本', 'switch')
      setTimeout(refresh, 1500)
    } catch { /* toast by interceptor */ }
  }, [refresh, startStream])

  const triggerSwitch = useCallback(async (row: DeployVersionRow) => {
    setSwitchModal({ open: false, row: null })
    try {
      const job = (await deployApi.switch(row.version)) as JobCreated
      startStream(job.job_id, `切换到 ${row.version}`, 'switch')
      setTimeout(refresh, 1500)
    } catch { /* toast by interceptor */ }
  }, [refresh, startStream])

  const triggerDeployNew = useCallback(async () => {
    setDeployModal(false)
    try {
      const job = (await deployApi.deployNew(deployNote, { auto_rollback: autoRollback, skip_build: skipBuild })) as JobCreated
      startStream(job.job_id, '部署新版本', 'deploy')
      setDeployNote('')
      setTimeout(refresh, 2500)
    } catch { /* toast by interceptor */ }
  }, [deployNote, autoRollback, skipBuild, refresh, startStream])

  const closeProgress = useCallback(() => {
    streamCloseRef.current?.()
    streamCloseRef.current = null
    if (elapsedTimer.current) { clearInterval(elapsedTimer.current); elapsedTimer.current = null }
    setProgressModal({ open: false, title: '', mode: 'deploy' })
    refresh()
  }, [refresh])

  const chipsCount = useMemo(() => ({
    all: versions.length,
    current: versions.filter((v) => v.current).length,
    ok: versions.filter((v) => !v.current && v.images === 'OK').length,
    missing: versions.filter((v) => v.images !== 'OK').length,
  }), [versions])

  const filtered = useMemo(() => {
    if (chip === 'current') return versions.filter((v) => v.current)
    if (chip === 'ok') return versions.filter((v) => !v.current && v.images === 'OK')
    if (chip === 'missing') return versions.filter((v) => v.images !== 'OK')
    return versions
  }, [versions, chip])

  const columns: ColumnsType<DeployVersionRow> = [
    {
      title: '版本号', dataIndex: 'version', width: 200,
      render: (v: string) => <span className="strong mono">{v}</span>,
    },
    {
      title: '创建时间', dataIndex: 'created', width: 172,
      render: (v: string) => <span className="mono">{v || '-'}</span>,
    },
    {
      title: 'Git', dataIndex: 'git', width: 96,
      render: (v: string) => <span className="mono" style={{ color: 'var(--brand-600)' }}>{v || '-'}</span>,
    },
    {
      title: '备注', dataIndex: 'note', ellipsis: true,
      render: (v: string) => <Tooltip title={v} mouseEnterDelay={1}>{v || <Text type="secondary">-</Text>}</Tooltip>,
    },
    {
      title: '镜像', dataIndex: 'images', width: 120,
      render: (s: string) =>
        s === 'OK'
          ? <span className="dv-img ok"><CheckCircleOutlined /> OK ×2</span>
          : <span className="dv-img bad">× 已清理</span>,
    },
    {
      title: '状态', dataIndex: 'current', width: 110,
      render: (current: boolean, r: DeployVersionRow) =>
        current
          ? <span className="dv-pill running"><span className="d" />当前运行</span>
          : r.images === 'MISSING'
            ? <span className="dv-pill miss"><span className="d" />不可用</span>
            : <span className="dv-pill ok"><span className="d" />可部署</span>,
    },
    {
      title: '操作', width: 170, fixed: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openDrawer(r.version)}>查看详情</Button>
          {!r.current && r.images === 'OK' && canManage && (
            <Button type="link" size="small" onClick={() => setSwitchModal({ open: true, row: r })}>部署此版本</Button>
          )}
          {!r.current && r.images !== 'OK' && (
            <Tooltip title="镜像已被清理，无法部署此版本">
              <Button type="link" size="small" disabled>部署此版本</Button>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ]

  if (!canView) {
    return (
      <Card>
        <Alert type="warning" showIcon message="无权限" description="您没有「部署版本管理」的 view 权限。请在「角色管理」中为您的角色授予 deploy_versions 权限。" />
      </Card>
    )
  }

  const currentRow = versions.find((v) => v.current)
  const previousRow = versions.find((v) => !v.current && v.images === 'OK')
  const barMax = Math.max(1, ...(status?.deploy_history_last7?.days ?? []).map((d) => d.count))
  const diskFree = status?.disk?.free
  const progressRunning = stream.status !== 'ok' && stream.status !== 'fail'

  return (
    <div className="dv-page">
      {/* 页头 */}
      <div className="dv-header">
        <div>
          <Title level={4} style={{ margin: 0 }}>部署版本</Title>
          <div className="desc">管理生产主机的远程版本：可看版本 / 回退上一版 / 切换任意历史版本为当前 / 一键部署新版本。需「部署版本管理」权限（角色管理授予 view/manage）。</div>
        </div>
        <div className="right">
          <Space>
            <Text type="secondary" style={{ fontSize: 11 }}>数据截至 {syncedAt ? syncedAt.toLocaleTimeString('zh-CN') : '-'} · 每 30s 自动同步</Text>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>刷新状态</Button>
          </Space>
        </div>
      </div>

      {/* 服务器健康条 */}
      <div className="dv-healthbar">
        <div className="dv-stat" style={{ ['--accent' as any]: 'var(--success)', ['--accent-bg' as any]: 'var(--success-bg)' }}>
          <div className="ico"><ApiOutlined /></div>
          <div className="main">
            <div className="label">当前运行版本 <span className="dv-pulse ok"><span className="d" />运行中</span></div>
            <div className="ver">{currentRow?.version || status?.current || '-'}<small>{status?.current ? fmtRunTime(status.current_created) : ''}</small></div>
            <div className="meta">
              Git <code>{currentRow?.git || status?.current_git || '-'}</code>
              {status?.current_deployer ? ` · 由 ${status.current_deployer} 部署` : ''}
              {status?.current_note ? ` · 备注「${truncate(status.current_note, 18)}」` : ''}
            </div>
          </div>
        </div>

        <div className="dv-stat" style={{ ['--accent' as any]: 'var(--brand-500)', ['--accent-bg' as any]: 'var(--brand-50)' }}>
          <div className="ico"><DatabaseOutlined /></div>
          <div className="main">
            <div className="label">远程已保留版本 <Tag bordered={false} color="default" style={{ marginLeft: 2 }}>策略：保留最近 {status?.retain_count ?? 5} 个</Tag></div>
            <div className="ver">{versions.length} <small>/ {status?.retain_count ?? 5}</small></div>
            <div className="meta">最早 {versions[versions.length - 1]?.version || '-'} · 最晚 {versions[0]?.version || '-'}</div>
          </div>
        </div>

        <div className="dv-stat" style={{ ['--accent' as any]: 'var(--info)', ['--accent-bg' as any]: 'var(--info-bg)' }}>
          <div className="ico"><HistoryOutlined /></div>
          <div className="main">
            <div className="label">最近 7 天部署</div>
            <div className="ver">{status?.deploy_history_last7?.count ?? 0} <small>次</small></div>
            <div className="dv-bar" title="最近 7 天每日部署次数">
              {(status?.deploy_history_last7?.days ?? []).map((d) => (
                <i key={d.date} className={d.idle ? 'idle' : ''}
                   style={{ height: d.count ? Math.max(8, Math.round((d.count / barMax) * 22)) : 8 }}
                   title={`${d.date} ${d.count ? `部署 ${d.count} 次` : '无部署'}`} />
              ))}
            </div>
          </div>
        </div>

        <div className="dv-stat" style={{ ['--accent' as any]: 'var(--warning)', ['--accent-bg' as any]: 'var(--warning-bg)' }}>
          <div className="ico"><CloudUploadOutlined /></div>
          <div className="main">
            <div className="label">远程镜像占用 <span className="dv-pulse warn"><span className="d" />磁盘</span></div>
            <div className="ver">{status?.image_usage || '-'}</div>
            <div className="meta">
              全部 spc-v2 镜像 · {diskFree ? `服务器可用 ${fmtBytes(diskFree)}` : '磁盘信息不可用'}
            </div>
          </div>
        </div>
      </div>

      {/* 主操作卡 */}
      <div className="dv-actions">
        <div className="dv-act primary">
          <div className="ico"><RocketOutlined /></div>
          <div className="main">
            <div className="title">部署新版本 <Tag color="blue" style={{ marginLeft: 2 }}>推荐</Tag></div>
            <div className="desc">远程自动 <code>git pull</code> → 构建双镜像 → 打包 → 加载 → 健康检查 → 切换为当前 → 自动分配新版本号。</div>
          </div>
          <div className="cta">
            <Tooltip title={!status?.git_url && canManage ? '未配置 git_url，无法从远程拉取源码部署' : ''}>
              <Button type="primary" icon={<RocketOutlined />} disabled={!canManage || !status?.git_url} onClick={() => setDeployModal(true)}>部署新版本</Button>
            </Tooltip>
          </div>
        </div>

        <div className="dv-act warn">
          <div className="ico"><RollbackOutlined /></div>
          <div className="main">
            <div className="title">回退到上一版本</div>
            <div className="desc">
              目标 {previousRow ? <code>{previousRow.version}</code> : '(无)'} · Git <code>{previousRow?.git || '-'}</code>
              {previousRow?.note ? ` · ${truncate(previousRow.note, 16)}` : ''} · 镜像 {previousRow?.images || '-'}
            </div>
          </div>
          <div className="cta">
            <Button danger icon={<RollbackOutlined />} disabled={!canManage || !previousRow} onClick={() => setRollbackModal(true)}>回退</Button>
          </div>
        </div>

        <div className="dv-act muted">
          <div className="ico"><SyncOutlined /></div>
          <div className="main">
            <div className="title">立即刷新状态</div>
            <div className="desc">连接远程服务器重新读取 current.txt / versions/ + docker image inspect · 默认每 30s 自动同步</div>
          </div>
          <div className="cta">
            <Button icon={<ReloadOutlined spin={loading} />} onClick={refresh} loading={loading}>刷新</Button>
          </div>
        </div>
      </div>

      {/* 版本管理主表 */}
      <Card bodyStyle={{ padding: 0 }}>
        <div className="dv-tools">
          <div className="chips">
            <a className={`dv-chip ${chip === 'all' ? 'on-all' : ''}`} onClick={() => setChip('all')}><span className="n">{chipsCount.all}</span>全部</a>
            <a className={`dv-chip ${chip === 'current' ? 'on-current' : ''}`} onClick={() => setChip('current')}><span className="n">{chipsCount.current}</span>当前运行</a>
            <a className={`dv-chip ${chip === 'ok' ? 'on-ok' : ''}`} onClick={() => setChip('ok')}><span className="n">{chipsCount.ok}</span>可部署</a>
            <a className={`dv-chip ${chip === 'missing' ? 'on-miss' : ''}`} onClick={() => setChip('missing')}><span className="n">{chipsCount.missing}</span>镜像已清理</a>
          </div>
          <div className="right">
            <CheckCircleOutlined style={{ color: 'var(--success)' }} />
            已同步 {syncedAt ? syncedAt.toLocaleString('zh-CN') : '--'} · 自动 30s
          </div>
        </div>
        <Table<DeployVersionRow>
          rowKey="version"
          columns={columns}
          dataSource={filtered}
          loading={loading}
          pagination={false}
          size="middle"
          rowClassName={(r) => r.current ? 'dv-row-current' : (r.images !== 'OK' ? 'dv-row-missing' : '')}
        />
        <div className="dv-footline">
          <span>共 {filtered.length} 个版本（显示当前筛选） · 保留策略：最近 {status?.retain_count ?? 5} 个 · 超出自动清理</span>
        </div>
      </Card>

      {/* ================= 详情抽屉 ================= */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={720}
        destroyOnClose
        title={
          <Space size={8}>
            <span>版本详情</span>
            <code style={{ fontFamily: 'Consolas, Menlo, monospace', color: 'var(--brand-600)', background: 'var(--brand-50)', border: '1px solid var(--brand-200)', padding: '0 8px', borderRadius: 4 }}>{drawerVer}</code>
            {detail && (
              detail.images_state === 'OK'
                ? <span className="dv-pill ok"><span className="d" />可部署</span>
                : <span className="dv-pill miss"><span className="d" />不可用</span>
            )}
          </Space>
        }
      >
        {!detail && detailLoading && <div className="dv-empty">加载详情…</div>}
        {!detail && !detailLoading && <div className="dv-empty">无详情数据（deploy-agent 不可达或版本不存在）。</div>}
        {detail && (
          <>
            {/* 元信息 */}
            <div className="dv-drawer-section">
              <div className="dv-sec-title">元信息</div>
              <div className="dv-meta-grid">
                <div>
                  <div className="k">版本号</div>
                  <div className="v"><code>{detail.version}</code></div>
                </div>
                <div>
                  <div className="k">创建时间</div>
                  <div className="v">{detail.created || '-'} {detail.created_rel ? <span className="rel">(· {detail.created_rel})</span> : null}</div>
                </div>
                <div>
                  <div className="k">Git 提交</div>
                  <div className="v"><code>{detail.git || '-'}</code></div>
                </div>
                <div>
                  <div className="k">部署人 / 操作</div>
                  <div className="v">{detail.deployer || '脚本'} <span style={{ fontWeight: 400, color: 'var(--text-3)', fontSize: 12 }}>· 脚本触发</span></div>
                </div>
                <div className="col2">
                  <div className="k">备注</div>
                  <div className="v plain">{detail.note || '-'}</div>
                </div>
              </div>
            </div>

            {/* 镜像清单 */}
            <div className="dv-drawer-section">
              <div className="dv-sec-title">镜像清单 <span className="n">{detail.images.length} 个</span></div>
              {(detail.images || []).map((img) => (
                <div className="dv-imgrow" key={img.name}>
                  {img.ok
                    ? <span className="dv-img ok"><CheckCircleOutlined /> 完整</span>
                    : <span className="dv-img bad">× 已清理</span>}
                  <span className="name">{img.name}</span>
                  <span className="sha">{img.id_short ? `sha256:${img.id_short}…` : ''}</span>
                  <span className="size">{img.size_mb ? `${img.size_mb} MB` : ''}</span>
                </div>
              ))}
            </div>

            {/* 配置快照 */}
            <div className="dv-drawer-section">
              <div className="dv-sec-title">配置快照 <span className="n">{detail.snapshots.length} 个文件</span></div>
              <div className="dv-snap">
                {(detail.snapshots || []).map((f) => (
                  <div className="row" key={f.name}>
                    <span className="nm">{f.name}</span>
                    <span className="st">{f.exists ? f.desc : '(缺失)'}</span>
                    <span className="sz">{fmtHumanSize(f.size)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 活动日志 */}
            <div className="dv-drawer-section">
              <div className="dv-sec-title">活动日志 <span className="n">{detail.activity.length} 条</span></div>
              <div className="dv-timeline">
                {(detail.activity || []).map((ev, i) => (
                  <div className={`dv-tl ${ev.kind}`} key={i}>
                    <span className="ic">{ev.kind === 'deploy' ? <RocketOutlined /> : ev.kind === 'replaced' ? <DownloadOutlined /> : ev.kind === 'current' ? <CheckCircleOutlined /> : <ClockCircleOutlined />}</span>
                    <div className="t">{ev.ts || ev.ts_rel}</div>
                    <div className="what"><b>{ev.title}</b></div>
                    <div className="detail">{ev.detail}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* 底部操作 */}
            {!detail.current && detail.images_state === 'OK' && canManage && (
              <div className="dv-drawer-foot">
                <Button type="primary" danger icon={<RocketOutlined />} onClick={() => {
                  const row = versions.find((v) => v.version === detail.version)
                  setDrawerOpen(false)
                  if (row) setSwitchModal({ open: true, row })
                }}>部署此版本为当前</Button>
                <Text type="secondary" style={{ fontSize: 11.5 }}>该操作不可中止，请确认安全后再点击</Text>
              </div>
            )}
          </>
        )}
      </Drawer>

      {/* ================= 部署新版本弹窗 ================= */}
      <Modal
        title={<><RocketOutlined style={{ color: 'var(--brand-500)' }} /> 部署新版本 <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>将产生新版本号 v{status?.version_count ? status.version_count + 1 : ''} · 自动激活为当前</Text></>}
        open={deployModal}
        onCancel={() => setDeployModal(false)}
        onOk={triggerDeployNew}
        okText="确认部署"
        cancelText="取消"
        width={600}
        footer={[
          <span key="perm" className="dv-perm-note">权限校验：deploy_versions.manage <b>✓</b></span>,
          <Button key="c" onClick={() => setDeployModal(false)}>取消</Button>,
          <Button key="ok" type="primary" icon={<RocketOutlined />} onClick={triggerDeployNew}>确认部署</Button>,
        ]}
      >
        <Alert
          className="dv-alert" type="info" showIcon
          message={<span>部署步骤：远程 <code style={{ fontFamily: 'Consolas,Menlo,monospace' }}>git pull origin {status?.git_branch || 'main'}</code> → 构建双镜像 → 打包上传 → 加载 → 健康检查 → 切为当前。预计 5–15 分钟。</span>}
        />
        <div className="dv-field">
          <label>新版本备注 <Text type="secondary" style={{ fontWeight: 400 }}>（将写入 meta.txt，全站可搜索）</Text></label>
          <TextArea value={deployNote} onChange={(e) => setDeployNote(e.target.value)} rows={3} placeholder="例如：齐套分析口径优化 + 订单风险自动扫描" />
        </div>
        <div className="dv-field">
          <label>部署选项</label>
          <div className="dv-opts">
            <label className="dv-opt"><input type="checkbox" checked={autoRollback} onChange={(e) => setAutoRollback(e.target.checked)} /> 健康检查失败自动回滚（推荐）</label>
            <label className="dv-opt"><input type="checkbox" checked={skipBuild} onChange={(e) => setSkipBuild(e.target.checked)} /> 跳过镜像构建（用本地 latest 快推）</label>
          </div>
        </div>
        <Alert
          type="warning" showIcon
          message={<span>当前运行 <b>{currentRow?.version || '-'}</b> 会被取代。该版本不会丢失——会作为镜像 + 配置快照保留在 <code style={{ fontFamily: 'Consolas,Menlo,monospace' }}>versions/{currentRow?.version?.split('-')[0]}-…</code> 中，后续可回退。</span>}
        />
      </Modal>

      {/* ================= 切换版本弹窗 ================= */}
      <Modal
        title={<><RollbackOutlined style={{ color: 'var(--warning)' }} /> 切换到历史版本 <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>仅切换镜像 + .env，不重新构建</Text></>}
        open={switchModal.open}
        onCancel={() => setSwitchModal({ open: false, row: null })}
        onOk={() => switchModal.row && triggerSwitch(switchModal.row)}
        okText="确认切换"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        width={560}
      >
        {switchModal.row && (
          <>
            <Alert
              type="warning" showIcon className="dv-alert"
              message={<span>即将切换 <code style={{ fontFamily: 'Consolas,Menlo,monospace' }}>spc-v2-backend</code> / <code style={{ fontFamily: 'Consolas,Menlo,monospace' }}>spc-v2-frontend</code> 的 <code style={{ fontFamily: 'Consolas,Menlo,monospace' }}>:latest</code> 指针到目标版本。健康检查通过才更新 current.txt。</span>}
            />
            <div className="dv-cmp">
              <div className="side cur">
                <div className="lab">当前运行</div>
                <div className="v">{currentRow?.version || '-'}</div>
                <div className="git">{currentRow?.git || '-'} · {currentRow?.note || '-'}</div>
              </div>
              <div className="arr">→</div>
              <div className="side tar">
                <div className="lab">切换目标</div>
                <div className="v">{switchModal.row.version}</div>
                <div className="git">{switchModal.row.git} · {switchModal.row.note}</div>
              </div>
            </div>
            <ul className="dv-bullets">
              <li>当前版本镜像与归档保留不变（{currentRow?.version || '-'} 不会丢失）。</li>
              <li>远程 health check 通过才会把 <code>current.txt</code> 切换到目标版本。</li>
              <li>该操作会向「审计日志」写入记录。</li>
            </ul>
          </>
        )}
      </Modal>

      {/* ================= 回退确认弹窗 ================= */}
      <Modal
        title={<><RollbackOutlined style={{ color: 'var(--warning)' }} /> 回退到上一版本 <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>仅切换镜像 + .env，不重新构建</Text></>}
        open={rollbackModal}
        onCancel={() => setRollbackModal(false)}
        onOk={triggerRollback}
        okText="确认回退"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        width={560}
      >
        <Alert
          type="warning" showIcon className="dv-alert"
          message={<span>即将切换 <code style={{ fontFamily: 'Consolas,Menlo,monospace' }}>spc-v2-backend</code> / <code style={{ fontFamily: 'Consolas,Menlo,monospace' }}>spc-v2-frontend</code> 的 <code style={{ fontFamily: 'Consolas,Menlo,monospace' }}>:latest</code> 指针到上一版本，并使用其归档的 <code style={{ fontFamily: 'Consolas,Menlo,monospace' }}>.env</code>。预计 30 秒内完成。</span>}
        />
        <div className="dv-cmp">
          <div className="side cur">
            <div className="lab">当前运行</div>
            <div className="v">{currentRow?.version || '-'}</div>
            <div className="git">{currentRow?.git || '-'}</div>
          </div>
          <div className="arr">→</div>
          <div className="side tar">
            <div className="lab">回退目标（上一版）</div>
            <div className="v">{previousRow?.version || '-'}</div>
            <div className="git">{previousRow?.git || '-'} · {previousRow?.note || '-'}</div>
          </div>
        </div>
        <ul className="dv-bullets">
          <li>当前版本镜像与归档保留不变（{currentRow?.version || '-'} 不会丢失）。</li>
          <li>远程 health check 通过才会把 <code>current.txt</code> 切换到目标版本。</li>
          <li>该操作会向「审计日志」写入记录。</li>
        </ul>
      </Modal>

      {/* ================= 部署进行中（实时步骤 + 日志流） ================= */}
      <Modal
        title={<Space><RocketOutlined style={{ color: 'var(--brand-500)' }} />{progressModal.title}</Space>}
        open={progressModal.open}
        onCancel={closeProgress}
        footer={
          <Space>
            <Button onClick={closeProgress}>后台查看（关闭弹窗）</Button>
            <Button type="primary" disabled={progressRunning} onClick={closeProgress}>
              {stream.status === 'ok' ? '已完成' : stream.status === 'fail' ? '已失败' : '进行中'}
            </Button>
          </Space>
        }
        width={820}
        maskClosable={false}
      >
        <div className="dv-progress-head">
          <span>远程服务器：deploy-agent（本机 {status?.git_branch || ''} 分支）</span>
          <span className="hint">已耗时 <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtElapsed(elapsed)}</b></span>
        </div>
        <div className="dv-progress-bar">
          <span className="vb">
            当前进度：
            {progressModal.mode === 'deploy'
              ? (stream.currentStep != null
                ? <>第 <b>{stream.currentStep + 1}</b> / {STEPS.length} 步「{STEPS[stream.currentStep] || stream.phase}」</>
                : '准备中…')
              : (stream.phase || '正在执行版本切换…')}
          </span>
          <Tag color={stream.status === 'ok' ? 'success' : stream.status === 'fail' ? 'error' : 'processing'}>
            {stream.status === 'ok' ? '成功' : stream.status === 'fail' ? '失败' : '进行中'}
          </Tag>
        </div>
        {progressModal.mode === 'deploy' ? (
          <div className="dv-step-track">
            {STEPS.map((name, i) => {
              const st = stream.steps[i] || 'pending'
              const cls = st === 'running' ? 'cur' : st === 'ok' ? 'done' : st === 'fail' ? 'fail' : ''
              return (
                <div key={i} className={`dv-step ${cls}`}>
                  <div className="d">{st === 'ok' ? '✓' : st === 'fail' ? '✗' : st === 'running' ? '…' : i + 1}</div>
                  <div className="nm">{name}</div>
                </div>
              )
            })}
          </div>
        ) : (
          <Alert
            type={stream.status === 'fail' ? 'error' : stream.status === 'ok' ? 'success' : 'info'}
            showIcon style={{ marginBottom: 10 }}
            message={stream.status === 'ok'
              ? `已切换完成，当前版本 ${stream.finalVersion || ''}`
              : stream.status === 'fail'
                ? '版本切换失败，请查看下方日志定位原因'
                : `正在执行版本切换：${stream.phase || '恢复 .env 快照 → 切换镜像 → compose up → 健康检查 → 更新 current.txt'}`}
          />
        )}
        <div className="dv-log">
          {stream.logs.length === 0
            ? <div className="lbl">等待日志…</div>
            : stream.logs.map((l, i) => (
              <div key={i}>
                <span className="ts">[{l.ts}]</span>
                <span className={
                  l.level === 'OK' ? 'ok' : l.level === 'ERR' || l.level === 'ERROR' ? 'err' :
                  l.level === 'WARN' ? 'err' : l.level === 'INFO' || l.level === 'INF' ? 'inf' : 'n'
                }>{l.msg}</span>
              </div>
            ))
          }
        </div>
      </Modal>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s && s.length > n ? `${s.slice(0, n)}…` : s || ''
}

function now(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\..+/, '')
}
