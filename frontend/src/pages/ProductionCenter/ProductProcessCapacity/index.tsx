import React, { useState, useEffect, useCallback } from 'react'
import { Table, Button, Space, message, Popconfirm, Form, Input, Modal, InputNumber, Select, Tag } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { productionApi } from '@/services/api'

const { Option } = Select

const ProductProcessCapacity: React.FC = () => {
  const [form] = Form.useForm()
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [loading, setLoading] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)
  const [submitLoading, setSubmitLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingRecord, setEditingRecord] = useState<any>(null)
  const [searchProductCode, setSearchProductCode] = useState<string>('')
  const [searchBomCode, setSearchBomCode] = useState<string>('')
  const [searchProcessType, setSearchProcessType] = useState<string>('')
  const [searchStatus, setSearchStatus] = useState<'active' | 'inactive' | 'all'>('active')

  const fetchCapacities = useCallback(async () => {
    setLoading(true)
    try {
      const params = {
        page,
        page_size: pageSize,
        bom_code: searchBomCode || undefined,
        product_code: searchProductCode || undefined,
        process_type: searchProcessType || undefined,
        is_active: searchStatus === 'all' ? undefined : searchStatus === 'active',
      }
      const res = await productionApi.listProductProcessCapacities(params)
      setData(res.data.items)
      setTotal(res.data.total)
    } catch (error: any) {
      message.error(error.message || '获取产能数据失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, searchBomCode, searchProductCode, searchProcessType, searchStatus])

  useEffect(() => {
    fetchCapacities()
  }, [fetchCapacities])

  const handleSearch = () => {
    setPage(1)
    fetchCapacities()
  }

  const handleReset = () => {
    setSearchProductCode('')
    setSearchBomCode('')
    setSearchProcessType('')
    setSearchStatus('active')
    setPage(1)
    fetchCapacities()
  }

  const handleAdd = () => {
    setEditingRecord(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (record: any) => {
    setEditingRecord(record)
    form.setFieldsValue(record)
    setModalVisible(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await productionApi.deleteProductProcessCapacity(id)
      message.success('删除成功')
      fetchCapacities()
    } catch (error: any) {
      message.error(error.message || '删除失败')
    }
  }

  const handleSyncFromOA = async () => {
    try {
      setSyncLoading(true)
      const res = await productionApi.syncProductProcessCapacitiesFromOA()
      const syncResult = res.data
      message.success(
        `同步完成：抓取 ${syncResult.fetched} 条，新增 ${syncResult.created} 条，更新 ${syncResult.updated} 条，失效 ${syncResult.deactivated} 条`
      )
      fetchCapacities()
    } catch (error: any) {
      message.error(error.message || 'OA 同步失败')
    } finally {
      setSyncLoading(false)
    }
  }

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields()
      setSubmitLoading(true)
      if (editingRecord) {
        await productionApi.updateProductProcessCapacity(editingRecord.id, values)
        message.success('更新成功')
      } else {
        await productionApi.createProductProcessCapacity(values)
        message.success('创建成功')
      }
      setModalVisible(false)
      fetchCapacities()
    } catch (error: any) {
      message.error(error.message || '操作失败')
    } finally {
      setSubmitLoading(false)
    }
  }

  const columns = [
    { title: 'BOM编码', dataIndex: 'bom_code', key: 'bom_code', width: 150, render: (v: string) => v || '-' },
    { title: '产品编码', dataIndex: 'product_code', key: 'product_code', width: 150 },
    { title: '产品名称', dataIndex: 'product_name', key: 'product_name', width: 180, render: (v: string) => v || '-' },
    { title: '工序类型', dataIndex: 'process_type', key: 'process_type', width: 120 },
    { title: 'UPPH (每小时产能)', dataIndex: 'upph', key: 'upph', width: 150 },
    { title: '备注', dataIndex: 'remark', key: 'remark', width: 250, render: (v: string) => v || '-' },
    { title: '数据来源', dataIndex: 'source', key: 'source', width: 100 },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 90,
      render: (v: boolean) => v ? <Tag color="green">有效</Tag> : <Tag color="default">失效</Tag>,
    },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 180, render: (text: string) => new Date(text).toLocaleString() },
    {
      title: '操作', key: 'actions', width: 150,
      render: (_: any, record: any) => (
        <Space size="middle">
          <Button icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm title="确定删除吗?" onConfirm={() => handleDelete(record.id)}>
            <Button icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className="card-modern">
      <Space style={{ marginBottom: 16 }}>
        <Input
          placeholder="BOM编码"
          value={searchBomCode}
          onChange={e => setSearchBomCode(e.target.value)}
          style={{ width: 180 }}
        />
        <Input
          placeholder="产品编码"
          value={searchProductCode}
          onChange={e => setSearchProductCode(e.target.value)}
          style={{ width: 180 }}
        />
        <Input
          placeholder="工序类型"
          value={searchProcessType}
          onChange={e => setSearchProcessType(e.target.value)}
          style={{ width: 180 }}
        />
        <Select
          value={searchStatus}
          onChange={value => setSearchStatus(value)}
          style={{ width: 140 }}
          options={[
            { value: 'active', label: '仅有效' },
            { value: 'inactive', label: '仅失效' },
            { value: 'all', label: '全部' },
          ]}
          allowClear={false}
        />
        <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
        <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
        <Button loading={syncLoading} onClick={handleSyncFromOA}>从OA同步</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增产能</Button>
      </Space>

      <Table
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (p, ps) => { setPage(p); setPageSize(ps) },
        }}
      />

      <Modal
        title={editingRecord ? '编辑产能' : '新增产能'}
        open={modalVisible}
        onOk={handleModalOk}
        confirmLoading={submitLoading}
        onCancel={() => setModalVisible(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="oa_detail_id" label="OA明细ID">
            <Input />
          </Form.Item>
          <Form.Item name="bom_code" label="BOM编码">
            <Input />
          </Form.Item>
          <Form.Item name="product_code" label="产品编码" rules={[{ required: true, message: '请输入产品编码' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="product_name" label="产品名称">
            <Input />
          </Form.Item>
          <Form.Item name="process_type" label="工序类型" rules={[{ required: true, message: '请输入工序类型' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="upph" label="UPPH (每小时产能)" rules={[{ required: true, message: '请输入UPPH' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="source" label="数据来源">
            <Input />
          </Form.Item>
          <Form.Item name="sync_batch_no" label="同步批次号">
            <Input />
          </Form.Item>
          <Form.Item name="is_active" label="是否有效" initialValue={true}>
            <Select>
              <Option value={true}>有效</Option>
              <Option value={false}>失效</Option>
            </Select>
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default ProductProcessCapacity
