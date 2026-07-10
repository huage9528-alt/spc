import { useState } from 'react'
import { DownOutlined, RightOutlined } from '@ant-design/icons'

interface CollapsibleStatsProps {
  title: string
  storageKey: string
  summary?: string
  children: React.ReactNode
}

export default function CollapsibleStats({ title, storageKey, summary, children }: CollapsibleStatsProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(`stats_collapsed_${storageKey}`)
      // 首次访问（没存过值）默认收起
      return stored === null ? true : stored === 'true'
    } catch {
      return true
    }
  })

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(`stats_collapsed_${storageKey}`, String(next))
    } catch {
      // ignore
    }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        onClick={toggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          padding: '8px 0',
          userSelect: 'none',
          borderBottom: collapsed ? '1px solid #f0f0f0' : 'none',
        }}
      >
        {collapsed ? <RightOutlined style={{ fontSize: 12, color: '#999' }} /> : <DownOutlined style={{ fontSize: 12, color: '#999' }} />}
        <span style={{ fontSize: 14, fontWeight: 600, color: '#1e293b' }}>{title}</span>
        {collapsed && summary && (
          <span style={{ fontSize: 13, color: '#64748b' }}>{summary}</span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94a3b8' }}>{collapsed ? '展开' : '收起'}</span>
      </div>
      {!collapsed && <div style={{ paddingTop: 4 }}>{children}</div>}
    </div>
  )
}
