import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Card, Checkbox, DatePicker, Form, Input, InputNumber, message, Radio, Select, Space, Upload } from 'antd'
import { ArrowLeftOutlined, InboxOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { qualityApi, CLAIM_REASON_OPTIONS, CLAIM_ITEM_OPTIONS, CLAIM_RETURN_OPTIONS } from '../../../services/quality'
import { fileApi } from '../../../services/api'

type SupplierOption = { id: number; supplier_code: string; supplier_name: string }

export default function SupplierClaimNew() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editId = searchParams.get('edit')
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [supplierOpts, setSupplierOpts] = useState<SupplierOption[]>([])
  const [attachments, setAttachments] = useState<any[]>([])

  useEffect(() => {
    if (!editId) return
    ;(async () => {
      try {
        const res: any = await qualityApi.get(parseInt(editId))
        const r = res.data
        form.setFieldsValue({ ...r, claim_date: r.claim_date ? dayjs(r.claim_date) : undefined })
        setAttachments(r.attachments || [])
      } catch { /* 全局拦截器已提示 */ }
    })()
  }, [editId])

  const searchSuppliers = async (keyword: string) => {
    if (!keyword) return
    try {
      const res: any = await qualityApi.searchSuppliers(keyword)
      setSupplierOpts(res.data?.items || [])
    } catch { /* 全局拦截器已提示 */ }
  }

  const save = async (submit: boolean) => {
    const values = await form.validateFields()
    const payload = {
      ...values,
      claim_date: values.claim_date ? values.claim_date.format('YYYY-MM-DD') : undefined,
      attachments: attachments.map(f => f.response || f),
      submit,
    }
    setSaving(true)
    try {
      if (editId) await qualityApi.update(parseInt(editId), { ...payload, submit: false })
      else await qualityApi.create(payload)
      if (editId && submit) await qualityApi.submit(parseInt(editId))
      message.success(submit ? '已提交审批' : '保存成功')
      navigate('/quality/supplier-claims')
    } catch { /* 全局拦截器已提示 */ } finally { setSaving(false) }
  }

  return (
    <Card title={
      <Space>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/quality/supplier-claims')} />
        {editId ? '编辑索赔单' : '新建供应商索赔单'}
      </Space>
    }>
      <Form form={form} layout="vertical" style={{ maxWidth: 860 }} initialValues={{ claim_date: dayjs(), claim_reason: 'field_customer_claim', return_requirement: 'no_return', claim_items: [] }}>
        <Form.Item name="supplier_name" label="供应商 Supplier" rules={[{ required: true, message: '请选择供应商' }]}>
          <Select showSearch filterOption={false} placeholder="输入关键词搜索供应商" onSearch={searchSuppliers} options={supplierOpts.map(s => ({ value: s.supplier_name, label: `${s.supplier_name}（${s.supplier_code}）` }))} />
        </Form.Item>
        <Form.Item name="claim_reason" label="索赔原因 Claim reason" rules={[{ required: true }]}>
          <Radio.Group options={CLAIM_REASON_OPTIONS} />
        </Form.Item>
        <Form.Item name="claim_items" label="索赔细项 Details claimed" rules={[{ required: true, message: '请至少勾选一项' }]}>
          <Checkbox.Group options={CLAIM_ITEM_OPTIONS} />
        </Form.Item>
        <Space size="large" wrap>
          <Form.Item name="claim_amount" label="索赔金额（元）" rules={[{ required: true, message: '请填写索赔金额' }]}>
            <InputNumber min={0} precision={2} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="claim_date" label="开单日期 Issue date" rules={[{ required: true }]}>
            <DatePicker />
          </Form.Item>
        </Space>
        <Form.Item name="claim_method" label="索赔方式 Explanation of claim method">
          <Input.TextArea rows={2} placeholder="如：本公司财务部直接扣款" />
        </Form.Item>
        <Form.Item name="calc_explanation" label="索赔金额计算说明">
          <Input.TextArea rows={5} placeholder="描述索赔事实、计算过程（如工时×单价）及依据的质量协议条款" />
        </Form.Item>
        <Form.Item name="return_requirement" label="退回要求 About parts returned from field">
          <Radio.Group options={CLAIM_RETURN_OPTIONS} />
        </Form.Item>
        <Form.Item name="remarks" label="备注">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item label="附件（检验报告/照片等）">
          <Upload.Dragger multiple fileList={attachments} onChange={({ fileList }: any) => setAttachments(fileList)}
            customRequest={async (options: any) => {
              try {
                const res: any = await fileApi.upload(options.file, 'supplier-claim')
                options.onSuccess(res.data || res, options.file)
              } catch (e) { options.onError(e as any) }
            }}>
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">点击或拖拽上传附件</p>
          </Upload.Dragger>
        </Form.Item>
        <Space>
          <Button type="primary" loading={saving} onClick={() => save(true)}>保存并提交审批</Button>
          <Button loading={saving} onClick={() => save(false)}>仅存草稿</Button>
        </Space>
      </Form>
    </Card>
  )
}
