import { useEffect, useState } from 'react'
import { Alert, Button, Col, Drawer, Form, InputNumber, Row, Space, Switch, Table, Typography, message } from 'antd'
import { productionApi } from '../../../services/api'
import { useBaseConditionStore, type BaseConditionItem } from '../../../store/baseCondition'

interface BaseConditionDrawerProps {
  open: boolean
  onClose: () => void
  onSaved?: () => void
}

const { Text } = Typography

export default function BaseConditionDrawer({ open, onClose, onSaved }: BaseConditionDrawerProps) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const { items, loading, load, setItems } = useBaseConditionStore()

  // 抽屉打开时确保 store 有数据（5 分钟缓存命中不发请求）
  useEffect(() => {
    if (!open) return
    load()
  }, [open, load])

  // store 数据变化时同步到表单
  useEffect(() => {
    if (!open || items.length === 0) return
    const formValues: Record<string, any> = {}
    items.forEach((it: BaseConditionItem) => {
      formValues[`manpower_${it.schedule_bucket}`] = it.default_manpower
      formValues[`hours_${it.schedule_bucket}`] = it.daily_work_hours
      formValues[`sunday_${it.schedule_bucket}`] = it.include_sunday
    })
    form.setFieldsValue(formValues)
  }, [open, items, form])

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      const newItems = items.map((r: BaseConditionItem) => ({
        schedule_bucket: r.schedule_bucket,
        default_manpower: values[`manpower_${r.schedule_bucket}`],
        daily_work_hours: values[`hours_${r.schedule_bucket}`],
        include_sunday: values[`sunday_${r.schedule_bucket}`],
      }))
      setSaving(true)
      await productionApi.saveBaseConditions({ items: newItems })
      // 同步更新 store（下次打开秒显示新值，5 分钟内不再拉）
      const labeledItems: BaseConditionItem[] = newItems.map((it) => ({
        ...it,
        bucket_label: items.find((r) => r.schedule_bucket === it.schedule_bucket)?.bucket_label || it.schedule_bucket,
      }))
      setItems(labeledItems)
      message.success('基础条件已保存，后续新排产将自动套用')
      onSaved?.()
      onClose()
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    {
      title: '排产阶段',
      dataIndex: 'bucket_label',
      key: 'bucket_label',
      width: 90,
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '班组人数',
      key: 'manpower',
      width: 130,
      render: (_: any, r: BaseConditionItem) => (
        <Form.Item name={`manpower_${r.schedule_bucket}`} noStyle rules={[{ required: true, message: '' }]}>
          <InputNumber min={1} max={200} style={{ width: '100%' }} />
        </Form.Item>
      ),
    },
    {
      title: '每日工时(h)',
      key: 'hours',
      width: 140,
      render: (_: any, r: BaseConditionItem) => (
        <Form.Item name={`hours_${r.schedule_bucket}`} noStyle rules={[{ required: true, message: '' }]}>
          <InputNumber min={1} max={24} step={0.5} style={{ width: '100%' }} />
        </Form.Item>
      ),
    },
    {
      title: '周日排产',
      key: 'sunday',
      width: 110,
      render: (_: any, r: BaseConditionItem) => (
        <Form.Item name={`sunday_${r.schedule_bucket}`} noStyle valuePropName="checked">
          <Switch checkedChildren="开" unCheckedChildren="关" />
        </Form.Item>
      ),
    },
  ]

  return (
    <Drawer
      title="车间排产基础条件"
      placement="right"
      width={620}
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="设一次，后续新排产自动套用"
        description="排产弹窗会预填这里的值；偶尔要改时仍可在弹窗里临时覆盖。已排产的历史计划不受影响。"
      />
      <Form form={form} layout="vertical">
        <Table
          rowKey="schedule_bucket"
          dataSource={items}
          columns={columns}
          pagination={false}
          loading={loading}
          size="middle"
          bordered
        />
        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={24}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              说明：日产能 = UPPH × 人数 × 工时；「周日排产」关闭时，若交期紧迫，系统仍可能在排产弹窗里提示建议开启。
            </Text>
          </Col>
        </Row>
      </Form>
    </Drawer>
  )
}

