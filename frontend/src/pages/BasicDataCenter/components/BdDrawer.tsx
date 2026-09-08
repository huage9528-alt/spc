import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { Drawer, Space } from 'antd'

interface BdDrawerProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  code?: ReactNode
  tags?: ReactNode
  actions?: ReactNode
  width?: number
  children?: ReactNode
}

export function DrawerSection({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="d-sec">
      <h4>{title}</h4>
      {children}
    </div>
  )
}

export function KvGrid({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="d-kv">
      {items.map(([term, desc], i) => (
        <Fragment key={i}>
          <dt>{term}</dt>
          <dd>{desc}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

export function RefItem({
  icon,
  main,
  extra,
  right,
}: {
  icon?: ReactNode
  main: ReactNode
  extra?: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="ref-item">
      {icon}
      <span>{main}</span>
      {extra != null && (
        <span style={{ color: '#94a3b8', fontSize: 'calc(11.5px * var(--font-size-scale))' }}>{extra}</span>
      )}
      {right != null && <span className="t">{right}</span>}
    </div>
  )
}

export default function BdDrawer({
  open,
  onClose,
  title,
  code,
  tags,
  actions,
  width = 480,
  children,
}: BdDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={width}
      rootClassName="sc-page"
      className="sc-drawer"
      styles={{ body: { padding: 0 } }}
      title={
        <div>
          <div>{title}</div>
          {code != null && <div className="sc-mat-code">{code}</div>}
        </div>
      }
      extra={actions != null ? <Space size={0}>{actions}</Space> : undefined}
    >
      {tags != null && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '12px 20px' }}>{tags}</div>
      )}
      {children}
    </Drawer>
  )
}
