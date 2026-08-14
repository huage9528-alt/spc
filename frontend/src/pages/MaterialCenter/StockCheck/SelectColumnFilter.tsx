import { Select, Button, Space } from 'antd'

interface SelectColumnFilterProps {
  setSelectedKeys?: (keys: React.Key[]) => void
  selectedKeys?: React.Key[]
  confirm?: () => void
  clearFilters?: () => void
  close?: () => void
}

interface SelectColumnFilterOptions {
  placeholder?: string
  width?: number
  options?: { label: string; value: string | number }[]
}

/**
 * 下拉选择列筛选工厂：返回一个 antd `filterDropdown`。
 *
 * 用法：
 *   filterDropdown: selectColumnFilter({ placeholder: '请选择仓库', options }),
 *   filterIcon: textFilterIcon,
 *
 * 筛选值以 `string[]` 形式存入 column filter state（首元素为所选值）；
 * 通过 `useAntTableQuery` 的 `filterToQuery` 映射到请求参数。
 */
export function selectColumnFilter(opts: SelectColumnFilterOptions = {}) {
  const { placeholder = '请选择', width = 220, options = [] } = opts
  return function SelectColumnFilterDropdown({
    setSelectedKeys, selectedKeys = [], confirm, clearFilters,
  }: SelectColumnFilterProps) {
    return (
      <div style={{ padding: 8 }} onClick={(e) => e.stopPropagation()}>
        <Select
          autoFocus
          allowClear
          showSearch
          placeholder={placeholder}
          value={(selectedKeys[0] as string | number | undefined) ?? undefined}
          onChange={(v) => setSelectedKeys?.(v == null ? [] : [v])}
          options={options}
          optionFilterProp="label"
          style={{ width, marginBottom: 8, display: 'block' }}
        />
        <Space>
          <Button type="primary" size="small" onClick={() => confirm?.()}>筛选</Button>
          <Button
            size="small"
            onClick={() => {
              setSelectedKeys?.([])
              clearFilters?.()
              confirm?.()
            }}
          >
            重置
          </Button>
        </Space>
      </div>
    )
  }
}
