import { useCallback, useEffect, useState } from 'react'
import { Button, Col, DatePicker, Form, Input, InputNumber, message, Modal, Row, Select, Space, Table, Upload } from 'antd'
import type { ColumnsType, TableProps } from 'antd/es/table'
import { EditOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'

export type ProcessFieldType = 'text' | 'number' | 'date'

export interface ProcessFormField {
  name: string
  label: string
  type: ProcessFieldType
  span?: number
}

export interface ProcessCrudApi {
  list: (params: Record<string, any>) => Promise<any>
  update: (id: number, payload: Record<string, any>) => Promise<any>
  importCsv?: (file: File) => Promise<any>
}

export interface ProcessExtraFilter {
  name: string
  placeholder: string
  type?: 'text' | 'select' | 'year'
  width?: number
  options?: Array<{ label: string; value: string }>
}

export interface ProcessCrudConfig<T> {
  editModalTitle: string
  editModalWidth?: number
  tableScrollX: number
  searchPlaceholder?: string
  api: ProcessCrudApi
  columns: ColumnsType<T>
  formFields: ProcessFormField[]
  /** dataIndex 列表：这些列在表格中渲染为可编辑数量输入框，失焦即保存 */
  checkFields?: string[]
  rowClassName?: (record: T) => string
  extraFilters?: ProcessExtraFilter[]
  showImport?: boolean
  keyField?: string
}

export default function ProcessCrudPage<T extends { status: string }>({
  config,
}: {
  config: ProcessCrudConfig<T>
}) {
  const {
    editModalTitle,
    editModalWidth = 700,
    tableScrollX,
    searchPlaceholder = '搜索',
    api,
    columns,
    formFields,
    checkFields,
    rowClassName,
    extraFilters,
    showImport = true,
    keyField = 'id',
  } = config

  const [data, setData] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [extraValues, setExtraValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {}
    for (const f of extraFilters || []) {
      if (f.type === 'year') init[f.name] = dayjs()
    }
    return init
  })
  const [editModal, setEditModal] = useState(false)
  const [editRecord, setEditRecord] = useState<T | null>(null)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, any> = { page, page_size: pageSize }
      if (keyword) params.keyword = keyword
      for (const f of extraFilters || []) {
        const v = extraValues[f.name]
        if (v !== undefined && v !== null && v !== '') {
          params[f.name] = f.type === 'year' ? dayjs(v).format('YYYY') : v
        }
      }
      const res: any = await api.list(params)
      setData(res.data.items)
      setTotal(res.data.total)
    } catch (e: any) {
      // 错误已由全局拦截器提示
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, keyword, extraValues, api, extraFilters])

  useEffect(() => { load() }, [load])

  const handleImport = async (file: File) => {
    if (!api.importCsv) return
    try {
      const res: any = await api.importCsv(file)
      message.success(`导入完成：新增 ${res.data.created}，更新 ${res.data.updated}，跳过 ${res.data.skipped}`)
      load()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
    return false
  }

  const openEdit = (row: T) => {
    setEditRecord(row)
    const values: Record<string, any> = {}
    for (const f of formFields) {
      const v = (row as any)[f.name]
      values[f.name] = f.type === 'date' ? (v ? dayjs(v) : null) : f.type === 'number' ? (v ? Number(v) : null) : v
    }
    form.setFieldsValue(values)
    setEditModal(true)
  }

  const handleEdit = async (values: any) => {
    if (!editRecord) return
    try {
      const payload: Record<string, any> = {}
      for (const f of formFields) {
        const v = values[f.name]
        payload[f.name] = f.type === 'date' ? (v ? dayjs(v).format('YYYY-MM-DD') : null) : f.type === 'number' ? (v != null ? String(v) : '') : v
      }
      await api.update((editRecord as any)[keyField], payload)
      message.success('保存成功')
      setEditModal(false)
      load()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  const finalColumns: ColumnsType<T> = [
    ...columns.map(col => {
      const di = (col as any).dataIndex
      if (di && checkFields?.includes(di)) {
        return {
          ...col,
          onCell: () => ({ style: { padding: 0 } }),
          render: (v: any, row: T) => {
            const numVal = v ? Number(v) : null
            return (
              <div
                style={{
                  minHeight: 38,
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '4px 6px',
                }}
              >
                <InputNumber
                  size="small"
                  min={0}
                  value={numVal}
                  placeholder="—"
                  style={{ width: 64, textAlign: 'center' }}
                  variant="borderless"
                  controls={false}
                  onBlur={(e) => {
                    const raw = (e.target as HTMLInputElement).value
                    const newVal = raw === '' ? '' : raw
                    if (newVal !== (v || '')) {
                      const key = (row as any)[keyField]
                      setData(prev => prev.map(r => ((r as any)[keyField] === key ? { ...r, [di]: newVal } : r)))
                      api.update(key, { [di]: newVal }).catch(() => load())
                    }
                  }}
                  onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
                />
              </div>
            )
          },
        }
      }
      return col
    }),
    {
      title: '操作',
      width: 60,
      fixed: 'right' as const,
      render: (_: any, row: T) => (
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
      ),
    },
  ]

  const tableProps: TableProps<T> = {
    rowKey: keyField,
    dataSource: data,
    columns: finalColumns,
    loading,
    scroll: { x: tableScrollX },
    size: 'small',
    pagination: {
      total,
      current: page,
      pageSize,
      onChange: (p, ps) => { setPage(p); setPageSize(ps) },
      showSizeChanger: true,
      showTotal: (t: number) => `共 ${t} 条`,
    },
  }
  if (rowClassName) tableProps.rowClassName = rowClassName

  return (
    <div>
      <div className="card-modern" style={{ padding: '16px 20px', marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col>
            <Input
              prefix={<SearchOutlined />}
              placeholder={searchPlaceholder}
              value={keyword}
              onChange={e => { setKeyword(e.target.value); setPage(1) }}
              style={{ width: 220 }}
              allowClear
            />
          </Col>
          {(extraFilters || []).map(f => (
            <Col key={f.name}>
              {f.type === 'select' ? (
                <Select
                  placeholder={f.placeholder}
                  value={extraValues[f.name] || undefined}
                  options={f.options}
                  onChange={(v) => { setExtraValues(ev => ({ ...ev, [f.name]: v })); setPage(1) }}
                  style={{ width: f.width ?? 120 }}
                  allowClear
                />
              ) : f.type === 'year' ? (
                <DatePicker
                  picker="year"
                  placeholder={f.placeholder}
                  value={extraValues[f.name] || null}
                  onChange={(v) => { setExtraValues(ev => ({ ...ev, [f.name]: v })); setPage(1) }}
                  style={{ width: f.width ?? 120 }}
                  allowClear
                />
              ) : (
                <Input
                  placeholder={f.placeholder}
                  value={extraValues[f.name] || ''}
                  onChange={e => { setExtraValues(v => ({ ...v, [f.name]: e.target.value })); setPage(1) }}
                  style={{ width: f.width ?? 120 }}
                  allowClear
                />
              )}
            </Col>
          ))}
          <Col flex="auto" />
          <Col>
            <Space>
              <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
              {showImport && api.importCsv && (
                <Upload beforeUpload={(f) => { handleImport(f); return false }} showUploadList={false} accept=".csv">
                  <Button icon={<UploadOutlined />}>导入CSV</Button>
                </Upload>
              )}
            </Space>
          </Col>
        </Row>
      </div>

      <div className="card-modern" style={{ padding: '0 0 4px' }}>
        <Table {...tableProps} />
      </div>

      <Modal
        title={editModalTitle}
        open={editModal}
        onCancel={() => { setEditModal(false); form.resetFields() }}
        onOk={() => form.submit()}
        width={editModalWidth}
      >
        <Form form={form} layout="vertical" onFinish={handleEdit}>
          <Row gutter={16}>
            {formFields.map(f => (
              <Col key={f.name} span={f.span ?? 8}>
                <Form.Item
                  name={f.name}
                  label={f.label}
                >
                  {f.type === 'date' ? (
                    <DatePicker style={{ width: '100%' }} />
                  ) : f.type === 'number' ? (
                    <InputNumber min={0} style={{ width: '100%' }} />
                  ) : (
                    <Input />
                  )}
                </Form.Item>
              </Col>
            ))}
          </Row>
        </Form>
      </Modal>
    </div>
  )
}

