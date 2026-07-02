import React, { useState, useEffect, useCallback } from 'react'
import { Table, Button, Space, message, Popconfirm, Form, Input, Modal, InputNumber, Select, Tag, Tabs, Tooltip } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { productionApi } from '@/services/api'

const { Option } = Select

const WORKSHOP_TABS = [
  { key: 'lean', label: '精益车间' },
  { key: 'assembly', label: '装配-组装' },
  { key: 'packaging', label: '装配-包装' },
  { key: 'others', label: '其他/待确认' },
] as const

const UPPH_SOURCE_MAP: Record<string, { label: string; color: string }> = {
  formula: { label: '自动计算', color: 'blue' },
  oa: { label: '沿用OA', color: 'green' },
  manual: { label: '手工覆盖', color: 'gold' },
  none: { label: '待确认', color: 'default' },
}

type WorkshopTabKey = typeof WORKSHOP_TABS[number]['key']

interface CapacityStats {
  all: number
  lean: number
  assembly: number
  packaging: number
  others: number
}

const formatValue = (value?: number | string | null) => {
  if (value === null || value === undefined || value === '') {
    return '-'
  }
  return value
}

const buildUpphExplanation = (record: any) => {
  const source = record.upph_source || 'none'
  const upph = formatValue(record.upph)
  const manpower = formatValue(record.manpower)
  const hourPrice = formatValue(record.hour_price)
  const gjje = formatValue(record.gjje)
  const formulaUpph = formatValue(record.formula_upph)
  const oaUpph = formatValue(record.oa_raw_upph)

  if (source === 'manual') {
    return `当前使用手工覆盖值 ${upph}，不随公式自动变化。`
  }

  if (source === 'formula') {
    return `自动计算：${manpower} 人 x ${hourPrice} 元/小时 / ${gjje} = ${formulaUpph}`
  }

  if (source === 'oa') {
    return `当前沿用 OA 原始 UPPH ${oaUpph}。原因通常是未匹配到“车间+工序”配置，或工价金额无法用于公式计算。`
  }

  return '缺少有效配置或工价金额，暂无法自动计算，请先维护 UPPH 配置。'
}

const ProductProcessCapacity: React.FC = () => {
  const [form] = Form.useForm()
  const [configForm] = Form.useForm()
  const [data, setData] = useState<any[]>([])
  const [configData, setConfigData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [configLoading, setConfigLoading] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)
  const [submitLoading, setSubmitLoading] = useState(false)
  const [configSubmitLoading, setConfigSubmitLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [configModalVisible, setConfigModalVisible] = useState(false)
  const [configEditVisible, setConfigEditVisible] = useState(false)
  const [editingRecord, setEditingRecord] = useState<any>(null)
  const [editingConfig, setEditingConfig] = useState<any>(null)
  const [searchProductCode, setSearchProductCode] = useState<string>('')
  const [searchBomCode, setSearchBomCode] = useState<string>('')
  const [searchProcessType, setSearchProcessType] = useState<string>('')
  const [searchStatus, setSearchStatus] = useState<'active' | 'inactive' | 'all'>('active')
  const [searchSchedulable, setSearchSchedulable] = useState<'all' | 'yes' | 'no'>('all')
  const [activeTab, setActiveTab] = useState<WorkshopTabKey>('lean')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [stats, setStats] = useState<CapacityStats>({ all: 0, lean: 0, assembly: 0, packaging: 0, others: 0 })

  const fetchCapacities = useCallback(async () => {
    setLoading(true)
    try {
      const params = {
        page,
        page_size: pageSize,
        bom_code: searchBomCode || undefined,
        product_code: searchProductCode || undefined,
        process_type: searchProcessType || undefined,
        workshop_tab: activeTab,
        is_active: searchStatus === 'all' ? undefined : searchStatus === 'active',
        schedulable: searchSchedulable === 'all' ? undefined : searchSchedulable === 'yes',
      }
      const res = await productionApi.listProductProcessCapacities(params)
      setData(res.data.items)
      setTotal(res.data.total)
      setStats(res.data.stats || { all: 0, lean: 0, assembly: 0, packaging: 0, others: 0 })
    } catch (error: any) {
      message.error(error.message || '获取产能数据失败')
    } finally {
      setLoading(false)
    }
  }, [activeTab, page, pageSize, searchBomCode, searchProductCode, searchProcessType, searchStatus, searchSchedulable])

  const fetchConfigs = useCallback(async () => {
    setConfigLoading(true)
    try {
      const res = await productionApi.listUpphFormulaConfigs()
      setConfigData(res.data || [])
    } catch (error: any) {
      message.error(error.message || '获取UPPH配置失败')
    } finally {
      setConfigLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCapacities()
  }, [fetchCapacities])

  useEffect(() => {
    fetchConfigs()
  }, [fetchConfigs])

  const handleSearch = () => {
    if (page !== 1) {
      setPage(1)
      return
    }
    fetchCapacities()
  }

  const handleReset = () => {
    const alreadyDefault =
      searchProductCode === '' &&
      searchBomCode === '' &&
      searchProcessType === '' &&
      searchStatus === 'active' &&
      searchSchedulable === 'all' &&
      activeTab === 'lean' &&
      page === 1 &&
      pageSize === 20

    setSearchProductCode('')
    setSearchBomCode('')
    setSearchProcessType('')
    setSearchStatus('active')
    setSearchSchedulable('all')
    setActiveTab('lean')
    setPage(1)
    setPageSize(20)
    if (alreadyDefault) {
      fetchCapacities()
    }
  }

  const handleAdd = () => {
    setEditingRecord(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleAddConfig = () => {
    setEditingConfig(null)
    configForm.resetFields()
    configForm.setFieldsValue({ is_active: true, process_type: '*' })
    setConfigEditVisible(true)
  }

  const handleEdit = (record: any) => {
    setEditingRecord(record)
    form.setFieldsValue(record)
    setModalVisible(true)
  }

  const handleEditConfig = (record: any) => {
    setEditingConfig(record)
    configForm.setFieldsValue(record)
    setConfigEditVisible(true)
  }

  const handleDelete = async (id: number) => {
    try {
      await productionApi.deleteProductProcessCapacity(id)
      message.success('删除成功')
      if (page !== 1) {
        setPage(1)
      } else {
        fetchCapacities()
      }
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
      if (page !== 1) {
        setPage(1)
      } else {
        fetchCapacities()
      }
      fetchConfigs()
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
      if (page !== 1) {
        setPage(1)
      } else {
        fetchCapacities()
      }
    } catch (error: any) {
      message.error(error.message || '操作失败')
    } finally {
      setSubmitLoading(false)
    }
  }

  const handleConfigModalOk = async () => {
    try {
      const values = await configForm.validateFields()
      setConfigSubmitLoading(true)
      if (editingConfig) {
        await productionApi.updateUpphFormulaConfig(editingConfig.id, values)
        message.success('配置更新成功')
      } else {
        await productionApi.createUpphFormulaConfig(values)
        message.success('配置创建成功')
      }
      setConfigEditVisible(false)
      fetchConfigs()
      fetchCapacities()
    } catch (error: any) {
      message.error(error.message || '配置保存失败')
    } finally {
      setConfigSubmitLoading(false)
    }
  }

  const handleDeleteConfig = async (id: number) => {
    try {
      await productionApi.deleteUpphFormulaConfig(id)
      message.success('配置删除成功，已触发重算')
      fetchConfigs()
      fetchCapacities()
    } catch (error: any) {
      message.error(error.message || '配置删除失败')
    }
  }

  const columns = [
    { title: 'BOM编码', dataIndex: 'bom_code', key: 'bom_code', width: 150, render: (v: string) => v || '-' },
    { title: '产品编码', dataIndex: 'product_code', key: 'product_code', width: 150 },
    { title: '产品名称', dataIndex: 'product_name', key: 'product_name', width: 180, render: (v: string) => v || '-' },
    { title: 'OA车间', dataIndex: 'oa_workshop_name', key: 'oa_workshop_name', width: 140, render: (v: string) => v || '-' },
    { title: '工序类型', dataIndex: 'process_type', key: 'process_type', width: 120 },
    { title: '工价金额', dataIndex: 'gjje', key: 'gjje', width: 120, render: (v: number) => v ?? '-' },
    {
      title: '计算方式',
      dataIndex: 'upph_source',
      key: 'upph_source',
      width: 110,
      render: (v: string) => {
        const source = UPPH_SOURCE_MAP[v] || UPPH_SOURCE_MAP.none
        return <Tag color={source.color}>{source.label}</Tag>
      },
    },
    {
      title: 'UPPH (每小时产能)',
      dataIndex: 'upph',
      key: 'upph',
      width: 170,
      render: (value: number, record: any) => (
        <Tooltip title={buildUpphExplanation(record)}>
          <span style={{ cursor: 'help' }}>{value ?? '-'}</span>
        </Tooltip>
      ),
    },
    {
      title: '排产准入',
      dataIndex: 'is_schedulable',
      key: 'is_schedulable',
      width: 110,
      render: (v: boolean) => v ? <Tag color="green">参与排产</Tag> : <Tag color="orange">待确认</Tag>,
    },
    { title: '未准入原因', dataIndex: 'exclude_reason', key: 'exclude_reason', width: 220, render: (v: string) => v || '-' },
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

  const configColumns = [
    { title: '车间', dataIndex: 'workshop_name', key: 'workshop_name', width: 140 },
    { title: '工序', dataIndex: 'process_type', key: 'process_type', width: 140, render: (v: string) => v === '*' ? '全部工序' : v },
    { title: '人数', dataIndex: 'manpower', key: 'manpower', width: 90 },
    { title: '小时单价', dataIndex: 'hour_price', key: 'hour_price', width: 100 },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 90,
      render: (v: boolean) => v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
    },
    { title: '备注', dataIndex: 'remark', key: 'remark', width: 180, render: (v: string) => v || '-' },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 180, render: (v: string) => v ? new Date(v).toLocaleString() : '-' },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: any, record: any) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEditConfig(record)} />
          <Popconfirm title="确定删除该配置吗?" onConfirm={() => handleDeleteConfig(record.id)}>
            <Button size="small" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const tabItems = WORKSHOP_TABS.map(tab => ({
    key: tab.key,
    label: `${tab.label} (${stats[tab.key]})`,
  }))

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
        <Select
          value={searchSchedulable}
          onChange={value => setSearchSchedulable(value)}
          style={{ width: 160 }}
          options={[
            { value: 'all', label: '全部准入状态' },
            { value: 'yes', label: '仅参与排产' },
            { value: 'no', label: '仅待确认' },
          ]}
          allowClear={false}
        />
        <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
        <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
        <Button onClick={() => setConfigModalVisible(true)}>UPPH配置</Button>
        <Button loading={syncLoading} onClick={handleSyncFromOA}>从OA同步</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增产能</Button>
      </Space>

      <div style={{ marginBottom: 12, color: '#666' }}>
        当前标签共 {total} 条，全部符合条件共 {stats.all} 条。页码可切换查看剩余数据，标签数量为后端真实统计。
      </div>

      <Tabs
        activeKey={activeTab}
        items={tabItems}
        onChange={key => {
          setActiveTab(key as WorkshopTabKey)
          setPage(1)
        }}
        style={{ marginBottom: 12 }}
      />

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
          showTotal: value => `当前标签共 ${value} 条`,
          onChange: (nextPage, nextPageSize) => {
            setPage(nextPage)
            setPageSize(nextPageSize)
          },
        }}
        scroll={{ x: 2200 }}
      />

      <Modal
        title={editingRecord ? '编辑产能' : '新增产能'}
        open={modalVisible}
        onOk={handleModalOk}
        confirmLoading={submitLoading}
        onCancel={() => setModalVisible(false)}
        destroyOnHidden
      >
        {editingRecord && (
          <div style={{ marginBottom: 12, padding: 12, background: '#fafafa', borderRadius: 6, color: '#666' }}>
            当前计算说明：{buildUpphExplanation(editingRecord)}
          </div>
        )}
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
          <Form.Item name="upph" label="手工UPPH覆盖(可选)">
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

      <Modal
        title="UPPH配置表"
        open={configModalVisible}
        onCancel={() => setConfigModalVisible(false)}
        footer={null}
        width={980}
        destroyOnHidden
      >
        <div style={{ marginBottom: 12, color: '#666' }}>
          推荐按“车间 + 工序”配置人数和小时单价。保存后会自动重算相关产能并标记受影响排产。
        </div>
        <Space style={{ marginBottom: 12 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAddConfig}>新增配置</Button>
          <Button icon={<ReloadOutlined />} onClick={fetchConfigs}>刷新</Button>
        </Space>
        <Table
          rowKey="id"
          columns={configColumns}
          dataSource={configData}
          loading={configLoading}
          pagination={false}
          scroll={{ x: 900, y: 420 }}
        />
      </Modal>

      <Modal
        title={editingConfig ? '编辑UPPH配置' : '新增UPPH配置'}
        open={configEditVisible}
        onOk={handleConfigModalOk}
        confirmLoading={configSubmitLoading}
        onCancel={() => setConfigEditVisible(false)}
        destroyOnHidden
      >
        <Form form={configForm} layout="vertical" initialValues={{ is_active: true, process_type: '*' }}>
          <Form.Item name="workshop_name" label="车间" rules={[{ required: true, message: '请输入车间名称' }]}>
            <Input placeholder="如：精益车间、装配车间" />
          </Form.Item>
          <Form.Item name="process_type" label="工序" rules={[{ required: true, message: '请输入工序类型' }]}>
            <Input placeholder="如：组装、包装，填 * 表示该车间全部工序" />
          </Form.Item>
          <Form.Item name="manpower" label="人数" rules={[{ required: true, message: '请输入人数' }]}>
            <InputNumber min={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="hour_price" label="小时单价" rules={[{ required: true, message: '请输入小时单价' }]}>
            <InputNumber min={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="is_active" label="是否启用" initialValue={true}>
            <Select options={[{ value: true, label: '启用' }, { value: false, label: '停用' }]} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default ProductProcessCapacity
