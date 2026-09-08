import { useState, useEffect } from 'react'
import { Modal, Checkbox, Space, Button, message, Radio } from 'antd'

export interface ExportColumnOption {
  field: string
  label: string
}

export interface ExportColumnSelectorProps {
  open: boolean
  columns: ExportColumnOption[]
  /** 可选：提供时弹窗顶部显示 xlsx/csv 格式切换（默认 xlsx） */
  format?: 'xlsx' | 'csv'
  onFormatChange?: (format: 'xlsx' | 'csv') => void
  onConfirm: (selectedColumns: string[]) => void
  onCancel: () => void
}

export default function ExportColumnSelector({
  open,
  columns,
  format,
  onFormatChange,
  onConfirm,
  onCancel,
}: ExportColumnSelectorProps) {
  const [checkedValues, setCheckedValues] = useState<string[]>([])

  useEffect(() => {
    if (open) {
      setCheckedValues(columns.map(col => col.field))
    }
  }, [open, columns])

  const handleSelectAll = () => {
    setCheckedValues(columns.map(col => col.field))
  }

  const handleDeselectAll = () => {
    setCheckedValues([])
  }

  const handleConfirm = () => {
    if (checkedValues.length === 0) {
      message.warning('请至少选择一个导出字段')
      return
    }
    onConfirm(checkedValues as string[])
  }

  return (
    <Modal
      title="选择导出字段"
      open={open}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Space key="actions" style={{ marginRight: 'auto' }}>
          <Button size="small" onClick={handleSelectAll}>
            全选
          </Button>
          <Button size="small" onClick={handleDeselectAll}>
            取消全选
          </Button>
        </Space>,
        <Button key="confirm" type="primary" onClick={handleConfirm}>
          确定导出
        </Button>,
      ]}
      width={600}
    >
      {onFormatChange && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0 8px', borderBottom: '1px solid #f0f0f0', marginBottom: 8 }}>
          <span style={{ color: '#475569', fontSize: 13 }}>导出格式：</span>
          <Radio.Group
            size="small"
            value={format ?? 'xlsx'}
            onChange={(e) => onFormatChange(e.target.value as 'xlsx' | 'csv')}
          >
            <Radio.Button value="xlsx">Excel (.xlsx)</Radio.Button>
            <Radio.Button value="csv">CSV (.csv)</Radio.Button>
          </Radio.Group>
        </div>
      )}
      <div style={{ padding: '8px 0' }}>
        <Checkbox.Group
          value={checkedValues}
          onChange={(values) => setCheckedValues(values as string[])}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}
        >
          {columns.map((col) => (
            <Checkbox key={col.field} value={col.field} style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 14 }}>{col.label}</span>
            </Checkbox>
          ))}
        </Checkbox.Group>
      </div>
      <div style={{ marginTop: 16, textAlign: 'right', color: '#64748b', fontSize: 12 }}>
        已选择 {checkedValues.length} / {columns.length} 个字段
      </div>
    </Modal>
  )
}
