import { Select } from 'antd'

interface Props {
  /** >=0 的天数;null=未选/未填 */
  value: number | null
  onChange: (v: number | null) => void
  /** true=必填(订单盘点):未选时禁止继续; false=选填(手动盘点):留空=不标记 */
  required?: boolean
}

const PRESETS = [
  { value: 1, label: '1 天' },
  { value: 3, label: '3 天' },
  { value: 7, label: '7 天' },
  { value: 15, label: '15 天' },
  { value: 30, label: '30 天' },
  { value: 90, label: '90 天' },
  { value: 99999, label: '不限（全部历史）' },
]

function fmt(v: number): string {
  return v === 99999 ? '不限（全部历史）' : `${v} 天`
}

/**
 * 「近期已盘」免盘天数 — 可选可输的下拉框。
 * 预置常用天数 + 不限(全部历史);也可手动键入任意天数(0=仅当天)。
 * 订单盘点: 必选/必填,未选不能创建; 手动盘点: 可留空=不标记(全部都盘)。
 */
export default function RecentDaysPicker({ value, onChange, required = false }: Props) {
  const filled = value != null
  const options = [...PRESETS]
  if (filled && !PRESETS.some((p) => p.value === value)) {
    options.push({ value, label: fmt(value) })
  }
  return (
    <div
      style={{
        background: filled || !required ? '#f6ffed' : '#fffbe6',
        border: `1px solid ${filled || !required ? '#b7eb8f' : '#ffe58f'}`,
        borderRadius: 8,
        padding: '10px 14px',
        marginBottom: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ color: filled || !required ? undefined : '#d48806' }}>
          {required ? '必选' : '选填'}：近期已盘免盘天数
        </strong>
        <Select
          showSearch
          value={filled ? value : undefined}
          placeholder="选择或输入天数"
          status={required && !filled ? 'error' : undefined}
          style={{ width: 200 }}
          options={options}
          // 弹层挂到自身父容器: 随弹窗内容一起滚动,避免 Modal 滚动时下拉列表漂移/消失
          getPopupContainer={(node) => node.parentElement}
          onSelect={(v) => onChange(Number(v))}
          onSearch={(text) => {
            const t = text.replace(/[^\d]/g, '')
            if (t === '') { onChange(null); return }
            onChange(Math.max(0, Math.min(99999, Number(t))))
          }}
          searchValue={undefined}
          filterOption={() => true}
          allowClear={!required}
          onClear={() => onChange(null)}
        />
      </div>
      <div style={{ fontSize: 12, color: filled ? '#389e0d' : (required ? '#d48806' : '#8c8c8c'), marginTop: 6 }}>
        {filled
          ? value === 0
            ? '仅当天盘点过的物料免盘'
            : value === 99999
              ? '全部历史盘点过的（物料×仓库）将标记「近期已盘」免盘，可点「重盘」重新盘点'
              : `近 ${value} 天内盘点过的（物料×仓库）将标记「近期已盘」免盘，可点「重盘」重新盘点`
          : required
            ? '必选：从下拉选择常用天数/不限，或直接输入任意天数（0=仅当天）'
            : '留空 = 不标记近期已盘，所有物料都需盘点；0=仅当天；也可选「不限」'}
      </div>
    </div>
  )
}
