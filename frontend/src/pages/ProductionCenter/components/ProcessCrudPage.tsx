import { useCallback, useEffect, useState } from 'react'
import { Button, Col, DatePicker, Form, Input, message, Modal, Row, Space, Table, Tag, Upload } from 'antd'
import type { ColumnsType, TableProps } from 'antd/es/table'
import { EditOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { PROCESS_STATUS_MAP } from '../constants'

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
  importCsv: (file: File) => Promise<any>
}

export interface ProcessExtraFilter {
  name: string
  placeholder: string
  width?: number
}

export interface ProcessCrudConfig<T> {
  editModalTitle: string
  editModalWidth?: number
  tableScrollX: number
  searchPlaceholder?: string
  api: ProcessCrudApi
  columns: ColumnsType<T>
  formFields: ProcessFormField[]
  rowClassName?: (record: T) => string
  extraFilters?: ProcessExtraFilter[]
}

export default function ProcessCrudPage<T extends { id: number; status: string }>({
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
    rowClassName,
    extraFilters,
  } = config

  const [data, setData] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [keyword, setKeyword] = useState('')
  const [extraValues, setExtraValues] = useState<Record<string, string>>({})
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
        if (v) params[f.name] = v
      }
      const res: any = await api.list(params)
      setData(res.data.items)
      setTotal(res.data.total)
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, keyword, extraValues, api, extraFilters])

  useEffect(() => { load() }, [load])

  const handleImport = async (file: File) => {
    try {
      const res: any = await api.importCsv(file)
      message.success(`导入完成：新增 ${res.data.created}，更新 ${res.data.updated}，跳过 ${res.data.skipped}`)
      load()
    } catch (e: any) {
      message.error(`导入失败：${e.message}`)
    }
    return false
  }

  const openEdit = (row: T) => {
    setEditRecord(row)
    const values: Record<string, any> = {}
    for (const f of formFields) {
      const v = (row as any)[f.name]
      values[f.name] = f.type === 'date' ? (v ? dayjs(v) : null) : v
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
        payload[f.name] = f.type === 'date' ? (v ? dayjs(v).format('YYYY-MM-DD') : null) : v
      }
      await api.update(editRecord.id, payload)
      message.success('保存成功')
      setEditModal(false)
      load()
    } catch (e: any) {
      message.error(e.message)
    }
  }

  const finalColumns: ColumnsType<T> = [
    ...columns,
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: string) => {
        const s = PROCESS_STATUS_MAP[v] || { label: v, color: 'default' }
        return <Tag color={s.color}>{s.label}</Tag>
      },
    },
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
    rowKey: 'id',
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
              <Input
                placeholder={f.placeholder}
                value={extraValues[f.name] || ''}
                onChange={e => { setExtraValues(v => ({ ...v, [f.name]: e.target.value })); setPage(1) }}
                style={{ width: f.width ?? 120 }}
                allowClear
              />
            </Col>
          ))}
          <Col flex="auto" />
          <Col>
            <Space>
              <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
              <Upload beforeUpload={(f) => { handleImport(f); return false }} showUploadList={false} accept=".csv">
                <Button icon={<UploadOutlined />}>导入CSV</Button>
              </Upload>
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
                <Form.Item name={f.name} label={f.label}>
                  {f.type === 'date' ? (
                    <DatePicker style={{ width: '100%' }} />
                  ) : f.type === 'number' ? (
                    <Input type="number" />
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
