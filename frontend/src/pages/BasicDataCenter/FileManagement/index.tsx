import { useCallback, useEffect, useState } from 'react'
import { Table, Button, Input, message, Popconfirm, Modal, InputNumber, Image, Tooltip } from 'antd'
import {
  ReloadOutlined, SearchOutlined, DeleteOutlined,
  ClearOutlined, DownloadOutlined, FolderOutlined, DatabaseOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { fileApi } from '../../../services/api'
import PermButton from '../../../components/PermButton'
import { useAuthStore } from '../../../store/auth'
import KpiBand, { type KpiItem } from '../components/KpiBand'
import { useBdTable } from '../components/useBdTable'

interface FileRow {
  id: number
  key: string
  url: string
  name: string
  mime: string
  size: number
  namespace: string
  biz_ref?: string | null
  uploader_name?: string | null
  is_orphan: boolean
  uploaded_at: string
}

interface FileStats {
  total_count: number
  total_size: number
  orphan_count: number
  uploaded_last_7d: number
}

const namespaceLabel: Record<string, string> = {
  feedback: '问题反馈',
  quality: '品质异常',
  npi: 'NPI',
  price: '采购变更',
  misc: '其他',
}

const namespaceClass: Record<string, string> = {
  feedback: 'sys-ns-feedback',
  quality: 'sys-ns-quality',
  npi: 'sys-ns-npi',
  price: 'sys-ns-price',
  misc: 'sys-ns-misc',
}

const EXT_GRADIENTS: Record<string, string> = {
  pdf: 'linear-gradient(135deg,#f59e0b,#d97706)',
  xlsx: 'linear-gradient(135deg,#f43f5e,#e11d48)',
  xls: 'linear-gradient(135deg,#f43f5e,#e11d48)',
  docx: 'linear-gradient(135deg,#0ea5e9,#0284c7)',
  doc: 'linear-gradient(135deg,#0ea5e9,#0284c7)',
  zip: 'linear-gradient(135deg,#94a3b8,#64748b)',
  rar: 'linear-gradient(135deg,#94a3b8,#64748b)',
  dxf: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
  dwg: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
  mp4: 'linear-gradient(135deg,#5eead4,#2dd4bf)',
  mov: 'linear-gradient(135deg,#5eead4,#2dd4bf)',
  txt: 'linear-gradient(135deg,#64748b,#475569)',
  csv: 'linear-gradient(135deg,#64748b,#475569)',
  default: 'linear-gradient(135deg,#64748b,#475569)',
}

function extOf(name: string, mime: string): string {
  if (mime?.startsWith('image/')) return 'img'
  const m = name?.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : (mime || '').split('/')[1] || 'file'
}

function formatSize(bytes: number) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

const nsTag = (ns: string) => (
  <span className={`sc-tag ${namespaceClass[ns] || 'sc-tag-plain'}`}>{namespaceLabel[ns] || ns}</span>
)

const FileTile = ({ row }: { row: FileRow }) => {
  const ext = extOf(row.name, row.mime)
  if (ext === 'img') {
    return (
      <div className="sys-fx" style={{ background: 'linear-gradient(135deg,#a3a9f5,#7a7de6)', color: '#fff', overflow: 'hidden' }}>
        <Image
          src={row.url}
          alt={row.name}
          width={36}
          height={36}
          style={{ objectFit: 'cover', borderRadius: 8, cursor: 'zoom-in' }}
          preview={{ mask: null }}
        />
      </div>
    )
  }
  return (
    <div className="sys-fx" style={{ background: EXT_GRADIENTS[ext] || EXT_GRADIENTS.default }}>
      {ext.toUpperCase().slice(0, 4)}
    </div>
  )
}

export default function FileManagement() {
  const [stats, setStats] = useState<FileStats>({ total_count: 0, total_size: 0, orphan_count: 0, uploaded_last_7d: 0 })
  const [searchText, setSearchText] = useState('')
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleanupDays, setCleanupDays] = useState(90)
  const [cleaning, setCleaning] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<FileRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  const hasPermission = useAuthStore((s) => s.hasPermission)
  const canDelete = hasPermission('basicdata.files', 'delete')

  const {
    items, total, loading, page, pageSize,
    setKeywordInput, commitKeyword, chip, setChip,
    sortBy, sortOrder, onTableChange, reload,
  } = useBdTable<FileRow>({
    url: '/files',
    extraQuery: (c) => (c === 'all' || !c ? {} : { is_orphan: c === 'orphan' }),
    chipInit: 'all',
  })

  const fetchStats = useCallback(async () => {
    try {
      const res: any = await fileApi.stats()
      setStats({
        total_count: res.data?.total_count || 0,
        total_size: res.data?.total_size || 0,
        orphan_count: res.data?.orphan_count || 0,
        uploaded_last_7d: res.data?.uploaded_last_7d || 0,
      })
    } catch {
      // 错误已由全局拦截器提示
    }
  }, [])

  useEffect(() => { fetchStats() }, [fetchStats])

  // 输入即搜（300ms 防抖）
  useEffect(() => {
    const t = setTimeout(() => commitKeyword(), 300)
    return () => clearTimeout(t)
  }, [searchText]) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshAll = useCallback(() => { reload(); fetchStats() }, [reload, fetchStats])

  const onSearchChange = (v: string) => { setSearchText(v); setKeywordInput(v) }

  const handleDelete = async () => {    if (!deleteTarget) return
    setDeleting(true)
    try {
      await fileApi.remove(deleteTarget.id)
      message.success('文件已删除')
      setDeleteTarget(null)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setDeleting(false)
    }
  }

  const handleCleanup = async () => {
    setCleaning(true)
    try {
      const res: any = await fileApi.cleanupOrphans(cleanupDays)
      message.success(`已清理 ${res.data?.cleaned || 0} 个孤儿文件，释放 ${formatSize(res.data?.freed_bytes || 0)}`)
      setCleanupOpen(false)
      refreshAll()
    } catch {
      // 错误已由全局拦截器提示
    } finally {
      setCleaning(false)
    }
  }

  const kpiItems: KpiItem[] = [
    { label: '总文件数', value: stats.total_count.toLocaleString(), sub: '含各业务域上传文件', accent: 'brand', icon: <FolderOutlined />, onClick: () => setChip('all') },
    { label: '占用空间', value: formatSize(stats.total_size), sub: '图片 / 视频 / 文档', accent: 'purple', icon: <DatabaseOutlined />, onClick: () => setChip('all') },
    {
      label: '孤儿文件', value: stats.orphan_count.toLocaleString(),
      go: stats.orphan_count > 0 ? '上传后未被业务引用 · 查看 →' : '无待清理项',
      accent: 'warning', icon: <ClearOutlined />, onClick: () => setChip('orphan'),
    },
    { label: '近 7 天上传', value: stats.uploaded_last_7d.toLocaleString(), sub: '新增文件数', accent: 'success', icon: <DownloadOutlined />, onClick: () => setChip('all') },
  ]

  const orderOf = (field: string): 'ascend' | 'descend' | null =>
    sortBy === field ? (sortOrder === 'asc' ? 'ascend' : 'descend') : null

  const columns: any[] = [
    {
      title: '文件名', key: 'file', width: 340,
      render: (_: any, r: FileRow) => (
        <span className="sys-file">
          <FileTile row={r} />
          <span className="fname">
            <a className="link" href={fileApi.downloadUrl(r.key)} target="_blank" rel="noreferrer" title="新窗口打开/下载">
              <span style={{ color: r.is_orphan ? '#64748b' : undefined }}>{r.name}</span>
            </a>
            <div className="key">{r.key}</div>
          </span>
        </span>
      ),
    },
    {
      title: '大小', dataIndex: 'size', key: 'size', width: 100, sorter: true,
      sortOrder: orderOf('size'),
      className: 'sc-mono',
      render: (v: number) => <span style={{ color: '#475569' }}>{formatSize(v || 0)}</span>,
    },
    {
      title: '类型', dataIndex: 'mime', key: 'mime', width: 150, ellipsis: true, sorter: true,
      sortOrder: orderOf('mime'),
      render: (v: string) => <span className="sc-note" style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 'calc(11.5px * var(--font-size-scale))' }}>{v}</span>,
    },
    {
      title: '业务域', dataIndex: 'namespace', key: 'namespace', width: 110,
      render: (v: string) => nsTag(v),
    },
    {
      title: '业务引用 ID', dataIndex: 'biz_ref', key: 'biz_ref', width: 130, sorter: true,
      sortOrder: orderOf('biz_ref'),
      render: (v: string | null) =>
        v ? <span className="sc-mono" style={{ color: '#475569' }}>{v}</span> : <span className="sc-note">—（无引用）</span>,
    },
    {
      title: '上传人', dataIndex: 'uploader_name', key: 'uploader_name', width: 110, sorter: true,
      sortOrder: orderOf('uploader_name'),
      render: (v: string | null) => v || <span className="sc-note">—</span>,
    },
    {
      title: '上传时间', dataIndex: 'uploaded_at', key: 'uploaded_at', width: 160, sorter: true,
      sortOrder: orderOf('uploaded_at'),
      render: (v: string) => <span className="sc-mono">{v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—'}</span>,
    },
    {
      title: '状态', dataIndex: 'is_orphan', key: 'is_orphan', width: 100,
      render: (v: boolean) => v
        ? <span className="sc-tag sc-tag-warn"><span className="dot" />孤儿</span>
        : <span className="sc-tag sc-tag-done"><span className="dot" />已引用</span>,
    },
    {
      title: '操作', key: 'action', width: 130, fixed: 'right' as const,
      render: (_: any, r: FileRow) => (
        <span className="sc-row-act">
          <Tooltip title="下载 / 新窗口打开">
            <a href={fileApi.downloadUrl(r.key)} target="_blank" rel="noreferrer">
              <DownloadOutlined />
            </a>
          </Tooltip>
          <Popconfirm
            title={r.is_orphan ? '删除后文件不可恢复，确认删除？' : `删除后引用方（${r.biz_ref || '业务记录'}）附件将显示已失效，确认删除？`}
            okText="确认"
            cancelText="取消"
            disabled={!canDelete}
            onConfirm={() => setDeleteTarget(r)}
          >
            <PermButton permResource="basicdata.files" permAction="delete" type="text" size="small" danger icon={<DeleteOutlined />}>删除</PermButton>
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
            placeholder="文件名 / 上传人"
            style={{ width: 260 }}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            onPressEnter={commitKeyword}
          />
        </span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <span className={`sc-chip${chip === 'all' ? ' on' : ''}`} onClick={() => setChip('all')}>全部 <span className="n">{stats.total_count.toLocaleString()}</span></span>
          <span className={`sc-chip${chip === 'orphan' ? ' on' : ''}`} onClick={() => setChip('orphan')}>孤儿 <span className="n" style={stats.orphan_count > 0 ? { color: '#dc2626', opacity: 1 } : undefined}>{stats.orphan_count.toLocaleString()}</span></span>
          <span className={`sc-chip${chip === 'linked' ? ' on' : ''}`} onClick={() => setChip('linked')}>已引用 <span className="n">{(stats.total_count - stats.orphan_count).toLocaleString()}</span></span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span className="sc-toolbar-hint" style={{ marginRight: 4 }}>
            <FolderOutlined style={{ color: '#94a3b8', marginRight: 4 }} />全站统一文件服务 · 上传后未被业务引用即为孤儿
          </span>
          <Button icon={<ReloadOutlined />} onClick={refreshAll}>刷新</Button>
          <PermButton
            permResource="basicdata.files"
            permAction="delete"
            danger
            icon={<ClearOutlined />}
            onClick={() => setCleanupOpen(true)}
          >
            清理孤儿文件{stats.orphan_count > 0 ? `（${stats.orphan_count}）` : ''}
          </PermButton>
        </span>
      </div>

      <div className="sc-card" style={{ padding: '0 0 4px' }}>
        <Image.PreviewGroup>
          <Table
            rowKey="id"
            columns={columns}
            dataSource={items}
            loading={loading}
            size="small"
            scroll={{ x: 1300 }}
            onChange={onTableChange}
            rowClassName={(r: FileRow) => (r.is_orphan ? 'sc-unchecked' : '')}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              showTotal: (t: number) => `共 ${t} 条`,
              pageSizeOptions: ['20', '50', '100'],
            }}
          />
        </Image.PreviewGroup>
      </div>

      {/* 清理孤儿文件 */}
      <Modal
        title={<span style={{ color: '#dc2626' }}>清理孤儿文件</span>}
        open={cleanupOpen}
        onOk={handleCleanup}
        confirmLoading={cleaning}
        onCancel={() => setCleanupOpen(false)}
        okText="确认清理"
        okButtonProps={{ danger: true }}
        width={540}
        rootClassName="sc-page"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 12px' }}>
          <span style={{ fontWeight: 500 }}>清理范围</span>
          <InputNumber
            min={0}
            max={365}
            value={cleanupDays}
            onChange={(v) => setCleanupDays(Number(v) || 0)}
            style={{ width: 110 }}
          />
          <span>天前上传的孤儿文件</span>
        </div>
        <div className="f-note" style={{ background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b', marginBottom: 12 }}>
          <b>不可撤销。</b>孤儿 = 上传后从未被任何业务记录引用的文件（反馈删除遗留、未提交表单的附件等）。
          系统将跳过近 {cleanupDays} 天内的文件以防误删。
        </div>
        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ display: 'flex', gap: 10, padding: '8px 12px', borderBottom: '1px solid #f1f5f9', fontSize: 'calc(12.5px * var(--font-size-scale))' }}>
            <span className="sc-tag sc-tag-warn">预计清理</span>
            <span>{stats.orphan_count} 个文件</span>
            <span style={{ marginLeft: 'auto', color: '#94a3b8' }}>{formatSize(stats.total_size * (stats.orphan_count / Math.max(stats.total_count, 1)))}*</span>
          </div>
          <div style={{ padding: '6px 12px', fontSize: 'calc(11px * var(--font-size-scale))', color: '#94a3b8' }}>
            * 占用为按文件占比的估算值，实际以清理结果为准
          </div>
        </div>
      </Modal>

      {/* 删除确认 */}
      <Modal
        title={<span style={{ color: '#dc2626' }}>删除文件</span>}
        open={!!deleteTarget}
        onOk={handleDelete}
        confirmLoading={deleting}
        onCancel={() => setDeleteTarget(null)}
        okText="确认删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        width={460}
        rootClassName="sc-page"
      >
        <p style={{ fontSize: 'calc(13.5px * var(--font-size-scale))', color: '#475569', lineHeight: 1.8 }}>
          确认删除 <b>{deleteTarget?.name}</b>（{deleteTarget ? formatSize(deleteTarget.size) : ''}）？
          <br />
          删除后文件<b style={{ color: '#dc2626' }}>不可恢复</b>
          {deleteTarget?.biz_ref && <>，引用方 <b>{deleteTarget.biz_ref}</b> 中的附件将显示为已失效</>}
          。
        </p>
      </Modal>
    </div>
  )
}
