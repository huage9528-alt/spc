import type { ReactNode } from 'react'
import { Button } from 'antd'
import { ClearOutlined } from '@ant-design/icons'

export function batchBarPad(count: number) {
  return count > 0 ? 72 : 0
}

interface BatchBarProps {
  count: number
  onClear: () => void
  children?: ReactNode
}

export default function BatchBar({ count, onClear, children }: BatchBarProps) {
  if (count === 0) return null
  return (
    <div className="sc-batch-bar">
      <span className="bb-n">已选 <b>{count}</b> 项（跨页保留）</span>
      {children != null && (
        <>
          <span className="bb-sep" />
          {children}
        </>
      )}
      <span className="bb-sep" />
      <Button size="small" type="text" icon={<ClearOutlined />} onClick={onClear}>清除选择</Button>
    </div>
  )
}
