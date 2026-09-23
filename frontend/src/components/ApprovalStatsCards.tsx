import { Card, Col, Row, Statistic, Tooltip } from 'antd'

export type StatCard = {
  key: string
  label: string
  value: number | string
  hint?: string
  tone?: 'default' | 'info' | 'warning' | 'danger' | 'success'
  onClick?: () => void
  active?: boolean
}

const TONE_COLOR: Record<string, string> = {
  default: '#5b5bd6',
  info: '#0284c7',
  warning: '#d97706',
  danger: '#dc2626',
  success: '#16a34a',
}

export default function ApprovalStatsCards({ cards }: { cards: StatCard[] }) {
  return (
    <Row gutter={12} style={{ marginBottom: 12 }}>
      {cards.map(c => (
        <Col span={6} key={c.key}>
          <Tooltip title={c.hint}>
            <Card
              size="small"
              hoverable={!!c.onClick}
              onClick={c.onClick}
              styles={{ body: { borderLeft: `3px solid ${TONE_COLOR[c.tone || 'default']}`, background: c.active ? '#eef0fe' : undefined } }}
            >
              <Statistic
                title={c.label}
                value={c.value}
                valueStyle={{ fontSize: 22, fontWeight: 600, color: TONE_COLOR[c.tone || 'default'] }}
              />
              {c.hint ? <div style={{ fontSize: 11, color: '#94a3b8' }}>{c.hint}</div> : null}
            </Card>
          </Tooltip>
        </Col>
      ))}
    </Row>
  )
}
