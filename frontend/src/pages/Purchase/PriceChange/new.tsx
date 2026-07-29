import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Alert, Button, DatePicker, Divider, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, message, AutoComplete, Upload } from 'antd'
import { PlusOutlined, DeleteOutlined, SaveOutlined, SendOutlined, ArrowLeftOutlined, SearchOutlined, CloseOutlined, WarningOutlined, ExclamationCircleOutlined, CheckCircleOutlined, UploadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { purchaseApi } from '../../../services/purchase'
import { fileApi } from '../../../services/api'
import { useAuthStore } from '../../../store/auth'

export default function PriceChangeNew() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editId = searchParams.get('edit')
  const isEdit = !!editId
  const currentUser = useAuthStore(s => s.currentUser)
  const applicantName = (currentUser as any)?.display_name || (currentUser as any)?.username || '当前用户'
  const todayStr = dayjs().format('YYYY-MM-DD')
  const [form] = Form.useForm()
  const watchedDirection = Form.useWatch('price_direction', form)
  const watchedTaxRate = Form.useWatch('tax_rate', form)

  const [items, setItems] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [loadingData, setLoadingData] = useState(false)

  const [formKey, setFormKey] = useState(0)

  // 编辑模式：加载已有数据
  useEffect(() => {
    if (!editId) return
    ;(async () => {
      setLoadingData(true)
      try {
        const res: any = await purchaseApi.get(parseInt(editId))
        const d = res.data
        if (!d) return
        setTitle(d.title || '')
        setRemark(d.remark || '')
        if (d.attachments) {
          const atts = typeof d.attachments === 'string' ? JSON.parse(d.attachments) : d.attachments
          setUploadedFiles(atts || [])
        }
        form.setFieldsValue({
          supplier_code: d.supplier_code,
          contact_person: d.contact_person, phone: d.phone, fax: d.fax, address: d.address,
          change_date: d.change_date ? dayjs(d.change_date) : undefined,
          purchase_contact: d.purchase_contact,
          customer: d.customer, customer_phone: d.customer_phone, customer_fax: d.customer_fax,
          price_direction: d.price_direction, payment_method: d.payment_method,
          settlement_method: d.settlement_method, tax_rate: d.tax_rate,
        })
        setSupName(d.supplier_name || '')
        setItems((d.items || []).map((i: any) => ({ ...i, key: i.id || Date.now() + Math.random() })))
        setFormKey(k => k + 1)
      } catch (e: any) { message.error('加载失败: ' + (e.message || '')) }
      finally { setLoadingData(false) }
    })()
  }, [editId])
  const [remark, setRemark] = useState('')
  const [fileList, setFileList] = useState<any[]>([])
  const [uploadedFiles, setUploadedFiles] = useState<any[]>([])
  const [title, setTitle] = useState(`调价单 - ${applicantName} - ${todayStr}`)

  // 员工选择（类似供应商）
  const [empModal, setEmpModal] = useState(false)
  const [empList, setEmpList] = useState<any[]>([])
  const [empTotal, setEmpTotal] = useState(0)
  const [empKw, setEmpKw] = useState('')
  const [empPage, setEmpPage] = useState(1)
  const [empOpts, setEmpOpts] = useState<{value:string,label:string}[]>([])

  const loadEmp = async (kw = '', page = 1) => {
    try { const r: any = await purchaseApi.searchEmployees(kw, page); setEmpList(r.data?.items||[]); setEmpTotal(r.data?.total||0); setEmpKw(kw); setEmpPage(page) } catch {}
  }

  const searchEmp = useCallback(async (kw: string) => {
    if (!kw) { setEmpOpts([]); return }
    try { const r: any = await purchaseApi.searchEmployees(kw, 1); setEmpOpts((r.data?.items||[]).map((e:any)=>({value:e.display_name||e.emp_code,label:`${e.display_name||e.username} ${e.emp_code||''}`}))) } catch {}
  }, [])

  // 供应商两种选择方式
  const [supKw, setSupKw] = useState('')
  const [supOpts, setSupOpts] = useState<{value:string,label:string,data:any}[]>([])
  const [supModal, setSupModal] = useState(false)
  const [supList, setSupList] = useState<any[]>([])
  const [supTotal, setSupTotal] = useState(0)
  const [supPage, setSupPage] = useState(1)
  const supTimer = useRef<any>(null)

  const [supName, setSupName] = useState('')

  // 模糊搜索（AutoComplete，带防抖）
  const onSupSearch = useCallback((kw: string) => {
    setSupKw(kw)
    if (kw) setSupName(kw)
    if (supTimer.current) clearTimeout(supTimer.current)
    if (!kw) { setSupOpts([]); return }
    supTimer.current = setTimeout(async () => {
      try { const r: any = await purchaseApi.searchSuppliers(kw); setSupOpts((r.data?.items||[]).map((s:any)=>({value:s.supplier_name,label:`${s.supplier_code}  ${s.supplier_name}`,data:s}))) } catch {}
    }, 300)
  }, [])

  // 选中供应商（模糊搜索或弹窗都会调用）
  const onSupSelect = (val: string) => {
    const found = supOpts.find(o => o.value === val)
    if (found) fillSupplier(found.data)
  }
  
  // 弹窗搜索
  const loadSupTable = async (kw = '', page = 1) => {
    try { const r: any = await purchaseApi.searchSuppliers(kw || '', page); setSupList(r.data?.items||[]); setSupTotal(r.data?.total||0); setSupKw(kw); setSupPage(page) } catch {}
  }

  const clearSupplier = () => {
    setSupName('')
    form.setFieldsValue({ supplier_code: '', contact_person: '', phone: '', fax: '', address: '' })
  }

  const fillSupplier = (s: any) => {
    form.setFieldsValue({
      supplier_code: s.supplier_code || '',
      contact_person: s.contact_person || '', phone: s.contact_phone || '',
      address: s.address || '',
    })
    setSupName(s.supplier_name || '')
    setTitle(`调价单 - ${applicantName} - ${todayStr} - ${s.supplier_name || ''}`)
  }

  // 物料行
  const addItem = () => setItems(prev => [...prev, { key: Date.now(), unit: '个' }])
  const rmItem = (k: number) => setItems(prev => prev.filter(i => i.key !== k))
  const upItem = (k: number, f: string, v: any) => setItems(prev => prev.map(i => i.key === k ? { ...i, [f]: v } : i))
  const lookPrice = async (key: number, mc: string) => {
    try {
      const h: any = await purchaseApi.materialPriceHistory(mc)
      const prices = h.data?.prices || []
      upItem(key, '_otherPrices', prices)
      const sc = form.getFieldValue('supplier_code') || ''
      const cur = prices.find((p: any) => p.supplier_code === sc)
      if (cur) {
        upItem(key, 'old_price', cur.price)
        upItem(key, 'old_price_date', cur.start_date || '')
      }
    } catch {}
  }
  const selectMat = (key: number, val: string, option: any) => {
    const m = option?.data
    if (!m) return
    upItem(key, 'material_code', m.material_code || '')
    upItem(key, 'material_name', m.material_name || '')
    upItem(key, 'spec', m.spec || '')
    upItem(key, 'unit', m.unit || '个')
    // ERP报价直接填入原价
    if (m.purchase_price) {
      upItem(key, 'old_price', m.purchase_price)
    }
    lookPrice(key, m.material_code)
    setMatOptsMap((prev) => ({ ...prev, [key]: [] }))
  }
  const matTimer = useRef<any>(null)
  const [matOptsMap, setMatOptsMap] = useState<Record<number, {value:string,label:string,data:any}[]>>({})
  const onMatSearch = (key: number, val: string) => {
    if (!val) {
      setMatOptsMap((prev) => ({ ...prev, [key]: [] }))
      return
    }
    if (matTimer.current) clearTimeout(matTimer.current)
    matTimer.current = setTimeout(async () => {
      try {
        const r: any = await purchaseApi.searchMaterials(val, 1, 6)
        const list = (r.data?.items || []).map((m: any) => ({
          value: m.material_code,
          label: `${m.material_code}  ${m.material_name}${m.purchase_price ? '  ¥' + m.purchase_price : ''}`,
          data: m,
        }))
        setMatOptsMap((prev) => ({ ...prev, [key]: list }))
      } catch {
        setMatOptsMap((prev) => ({ ...prev, [key]: [] }))
      }
    }, 300)
  }
  // 物料弹窗
  const [matModal, setMatModal] = useState(false)
  const [matKw, setMatKw] = useState('')
  const [matList, setMatList] = useState<any[]>([])
  const [matTotal, setMatTotal] = useState(0)
  const [matPage, setMatPage] = useState(1)
  const openMatModal = () => { setMatModal(true); loadMatTable('', 1) }
  const loadMatTable = async (kw = '', page = 1) => {
    try { const r: any = await purchaseApi.searchMaterials(kw, page); setMatList(r.data?.items||[]); setMatTotal(r.data?.total||0); setMatKw(kw); setMatPage(page) } catch {}
  }
  const [curMatRow, setCurMatRow] = useState<number>(0)
  const onMatRowClick = (r: any) => {
    selectMat(curMatRow, r.material_code, { data: r })
    setMatModal(false)
  }

  const save = async (submit: boolean) => {
    try {
      const v = await form.validateFields()
      if (!supName && !v.supplier_name && !v.supplier_code) { message.error('请选择供应商'); return }
      setSaving(true)

      // 如果是要提交审批，先运行自检预览
      if (submit) {
        try {
          const previewPayload = {
            items: items.map(i => ({
              seq: i.seq || 0, material_code: i.material_code, material_name: i.material_name,
              old_price: i.old_price, new_price: i.new_price,
            })),
            supplier_code: v.supplier_code || '',
          }
          const scRes: any = await purchaseApi.selfCheckPreview(previewPayload)
          const scData = scRes.data
          if (scData?.overall_status === 'high' || scData?.overall_status === 'medium') {
            setScResult(scData)
            setScEvidence([])
            setScEvidenceFiles([])
            setScPendingSubmit(true)
            setScModal(true)
            setSaving(false)
            return  // 阻断：显示弹窗，等待用户上传凭证
          }
        } catch (scErr: any) {
          // 自检失败不应阻断提交流程
          console.warn('自检预览失败，将直接提交:', scErr)
        }
      }

      // 上传新添加的文件
      const newUploads: any[] = []
      const pendingFiles = fileList.filter((f: any) => !f.url && (f.originFileObj || f))
      for (const f of pendingFiles) {
        try {
          const rawFile = f.originFileObj || f
          const upRes: any = await fileApi.upload(rawFile, 'purchase-price-change')
          newUploads.push({ id: upRes.data.id, key: upRes.data.key, name: upRes.data.name, url: upRes.data.url })
        } catch (err: any) { console.error('upload error details:', err?.response?.data || err); message.warning(`上传失败: ${f.name || f.originFileObj?.name}: ${err?.message || err}`) }
      }
      const allAttachments = [...uploadedFiles, ...newUploads]

      const payload = {
        ...v, supplier_name: supName || v.supplier_name, remark, title,
        change_date: v.change_date ? dayjs(v.change_date).format('YYYY-MM-DD') : null,
        attachments: allAttachments,
        erp_price_snapshot: items.flatMap(i => i._otherPrices || []).filter((p: any, idx: number, arr: any[]) => arr.findIndex((x: any) => x.supplier_code === p.supplier_code && x.price === p.price) === idx),
        submit,
        items: items.map(i => ({
          material_code: i.material_code, material_name: i.material_name, spec: i.spec, unit: i.unit,
          order_qty: i.order_qty, delivery_qty: i.delivery_qty,
          old_price: i.old_price, old_price_date: i.old_price_date,
          new_price: i.new_price, remark: i.remark,
        })),
      }

      if (isEdit) {
        await purchaseApi.update(parseInt(editId!), payload)
      } else {
        await purchaseApi.create(payload)
      }
      message.success(submit ? '已提交审批' : (isEdit ? '已更新' : '草稿已保存'))
      navigate('/purchase/price-change')
    } catch (e: any) { if (!e?.errorFields) message.error(e.message || '保存失败') }
    finally { setSaving(false) }
  }

  const totalItems = items.length
  const pricedItems = items.filter((item) => item.new_price != null && item.new_price !== '').length
  const autoFilledItems = items.filter((item) => item.old_price_date).length
  const maxAbsChange = items.reduce((max, item) => {
    const oldPrice = Number(item.old_price || 0)
    const newPrice = Number(item.new_price || 0)
    if (!oldPrice || !newPrice) return max
    const pct = Math.abs(((newPrice / oldPrice) - 1) * 100)
    return pct > max ? pct : max
  }, 0)
  const changeSummary = maxAbsChange > 0 ? `${maxAbsChange.toFixed(1)}%` : '--'
  const supplierCode = form.getFieldValue('supplier_code')

  const itemCols = [
    { title:'#',width:35,render:(_:any,__:any,i:number)=>i+1 },
    { title:'物料代码',width:140,render:(_:any,r:any)=>
      <AutoComplete options={matOptsMap[r.key] || []} style={{ width: '100%' }} value={r.material_code}
        onSearch={(val) => { upItem(r.key, 'material_code', val); setCurMatRow(r.key); onMatSearch(r.key, val) }}
        onSelect={(val, opt) => selectMat(r.key, val, opt)}
        popupMatchSelectWidth={false} dropdownStyle={{ minWidth: 360 }}>
        <Input size="small" bordered={false} placeholder="输入搜索"
            suffix={<Space size={0}>
              {r.material_code && <Button size="small" type="text" icon={<CloseOutlined />} style={{ color: '#94a3b8', fontSize: 12, opacity: 0.5 }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '1'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '0.5'}
                onClick={(e) => { e.stopPropagation(); upItem(r.key, 'material_code', ''); upItem(r.key, 'material_name', ''); upItem(r.key, 'spec', ''); upItem(r.key, 'unit', '个'); upItem(r.key, 'old_price', undefined); upItem(r.key, 'old_price_date', ''); upItem(r.key, '_otherPrices', []) }} />}
            <span style={{cursor:'pointer',color:'#3b82f6',fontSize:14,fontWeight:700}} onClick={(e)=>{e.stopPropagation();setCurMatRow(r.key);openMatModal()}}>...</span>
          </Space>}
          style={{background:'#fff',border:'1px solid #d9d9d9',borderRadius:4}} />
      </AutoComplete>
    },
    { title:'物料名称',width:120,render:(_:any,r:any)=><span style={{fontSize:12,color:r.material_name?'#334155':'#cbd5e1'}}>{r.material_name||'-'}</span> },
    { title:'规格',width:90,render:(_:any,r:any)=><span style={{fontSize:12,color:r.spec?'#334155':'#cbd5e1'}}>{r.spec||'-'}</span> },
    { title:'单位',width:50,render:(_:any,r:any)=><Input size="small" value={r.unit} readOnly style={{width:50,background:'#f5f5f5',border:'1px solid #d9d9d9',borderRadius:4}} /> },
    { title:'订货量',width:80,render:(_:any,r:any)=><InputNumber size="small" value={r.order_qty} min={0} precision={4} style={{width:'100%',background:'#fff',border:'1px solid #d9d9d9',borderRadius:4}} onChange={v=>upItem(r.key,'order_qty',v)} /> },
    { title:'到货量',width:80,render:(_:any,r:any)=><InputNumber size="small" value={r.delivery_qty} min={0} precision={4} style={{width:'100%',background:'#fff',border:'1px solid #d9d9d9',borderRadius:4}} onChange={v=>upItem(r.key,'delivery_qty',v)} /> },
    { title:'原价',width:85,render:(_:any,r:any)=><InputNumber size="small" value={r.old_price} min={0} precision={4} readOnly style={{width:'100%',background:'#f5f5f5',border:'1px solid #d9d9d9',borderRadius:4}} /> },
    { title:'现价',width:85,render:(_:any,r:any)=><InputNumber size="small" value={r.new_price} min={0} precision={4} style={{width:'100%',background:'#fff',border:'1px solid #d9d9d9',borderRadius:4}} onChange={v=>upItem(r.key,'new_price',v)} /> },
    { title:'涨幅',width:75,render:(_:any,r:any)=>{const o=parseFloat(r.old_price),n=parseFloat(r.new_price);if(!o||!n||o===0)return<span style={{color:'#cbd5e1'}}>--</span>;const p=((n/o)-1)*100;return<span style={{color:p>=0?'#dc2626':'#16a34a',fontWeight:600}}>{p>=0?'+':''}{p.toFixed(1)}%</span>}},
    { title:'备注',width:90,render:(_:any,r:any)=><Input size="small" value={r.remark} style={{background:'#fff',border:'1px solid #d9d9d9',borderRadius:4}} onChange={e=>upItem(r.key,'remark',e.target.value)} /> },
    { title:'',width:40,render:(_:any,r:any)=><Button size="small" type="text" danger icon={<DeleteOutlined/>} onClick={()=>rmItem(r.key)} /> },
  ]

  // 自检弹窗
  const [scModal, setScModal] = useState(false)
  const [scResult, setScResult] = useState<any>(null)
  const [scEvidence, setScEvidence] = useState<any[]>([])
  const [scEvidenceFiles, setScEvidenceFiles] = useState<any[]>([])
  const [scPendingSubmit, setScPendingSubmit] = useState(false)
  const [scSaving, setScSaving] = useState(false)

  const closeScModal = () => {
    setScModal(false)
    setScResult(null)
    setScEvidence([])
    setScEvidenceFiles([])
    setScPendingSubmit(false)
  }

  const uploadScEvidence = async (file: File): Promise<any> => {
    try {
      const upRes: any = await fileApi.upload(file, 'purchase-price-change-evidence')
      return { id: upRes.data.id, key: upRes.data.key, name: upRes.data.name, url: upRes.data.url }
    } catch (err: any) {
      message.warning(`上传失败: ${file.name}: ${err?.message || err}`)
      return null
    }
  }

  const submitWithEvidence = async () => {
    setScSaving(true)
    try {
      const v = await form.validateFields()
      if (!supName && !v.supplier_name && !v.supplier_code) { message.error('请选择供应商'); setScSaving(false); return }
      // 上传凭证文件
      const evidenceItems: any[] = []
      for (const ef of scEvidenceFiles) {
        const rawFile = ef.originFileObj || ef
        const uploaded = await uploadScEvidence(rawFile)
        if (uploaded) {
          evidenceItems.push(uploaded)
        }
      }
      for (const existing of scEvidence) {
        if (existing.id) evidenceItems.push(existing)
      }

      const allAttachments = [...uploadedFiles, ...fileList.map((f: any) => f.originFileObj || f).filter(Boolean).map((f: any) => f)]
      const pendingFiles = fileList.filter((f: any) => !f.url && (f.originFileObj || f))
      const newUploads: any[] = []
      for (const f of pendingFiles) {
        try {
          const rawFile = f.originFileObj || f
          const upRes: any = await fileApi.upload(rawFile, 'purchase-price-change')
          newUploads.push({ id: upRes.data.id, key: upRes.data.key, name: upRes.data.name, url: upRes.data.url })
        } catch (err: any) { message.warning(`上传失败: ${f.name}: ${err?.message || err}`) }
      }
      const finalAttachments = [...uploadedFiles, ...newUploads]

      const payload = {
        ...v, supplier_name: supName || v.supplier_name, remark, title,
        change_date: v.change_date ? dayjs(v.change_date).format('YYYY-MM-DD') : null,
        attachments: finalAttachments,
        erp_price_snapshot: items.flatMap(i => i._otherPrices || []).filter((p: any, idx: number, arr: any[]) => arr.findIndex((x: any) => x.supplier_code === p.supplier_code && x.price === p.price) === idx),
        submit: true,
        self_check_evidence: evidenceItems,
        items: items.map(i => ({
          material_code: i.material_code, material_name: i.material_name, spec: i.spec, unit: i.unit,
          order_qty: i.order_qty, delivery_qty: i.delivery_qty,
          old_price: i.old_price, old_price_date: i.old_price_date,
          new_price: i.new_price, remark: i.remark,
        })),
      }

      if (isEdit) {
        await purchaseApi.update(parseInt(editId!), payload)
      } else {
        await purchaseApi.create(payload)
      }
      message.success('已提交审批')
      closeScModal()
      navigate('/purchase/price-change')
    } catch (e: any) {
      if (!e?.errorFields) message.error(e.message || '提交失败')
    } finally {
      setScSaving(false)
    }
  }

  // 自动检测调价类型
  useEffect(() => {
    const filled = items.filter(i => i.old_price && parseFloat(i.old_price) > 0)
    if (filled.length === 0) {
      form.setFieldsValue({ price_direction: '新报价' })
      return
    }
    const withNew = filled.filter(i => i.new_price && parseFloat(i.new_price) > 0)
    if (withNew.length === 0) return
    const hasUp = withNew.some(i => parseFloat(i.new_price) > parseFloat(i.old_price))
    const hasDown = withNew.some(i => parseFloat(i.new_price) < parseFloat(i.old_price))
    if (hasUp) form.setFieldsValue({ price_direction: '涨价' })
    else if (hasDown) form.setFieldsValue({ price_direction: '降价' })
  }, [items])

  const sectionStyle = {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    padding: '16px 18px',
    marginBottom: 12,
  } as const

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }} key={formKey}>
      {/* 顶部：标题 + 操作按钮（和详情页风格一致） */}
      <div style={{ ...sectionStyle, padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/purchase/price-change')} style={{ paddingLeft: 0, marginBottom: 4 }}>
              返回调价单列表
            </Button>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
              {isEdit ? '[编辑] ' : ''}{title}
            </div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
              {todayStr} · {applicantName} 发起
            </div>
          </div>
          <Space>
            <Button icon={<SaveOutlined />} loading={saving} onClick={() => save(false)}>保存草稿</Button>
            <Button type="primary" icon={<SendOutlined />} loading={saving} onClick={() => save(true)}>提交审批</Button>
          </Space>
        </div>
      </div>

      {/* 表单主体（和详情页风格一致） */}
      <div style={sectionStyle}>
        <Form form={form} layout="vertical" initialValues={{
          price_direction: '涨价', tax_rate: '13%',
          purchase_contact: applicantName,
          customer: '宁波恒剑光电科技有限公司', customer_phone: '057463777196', customer_fax: '0574-63775448',
          change_date: dayjs(),
        }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {/* 供应商：模糊搜索 + 弹窗选择 */}
            <Form.Item label="供应商" required style={{ width: 310, marginBottom: 0 }}>
              <AutoComplete
                options={supOpts}
                onSearch={onSupSearch}
                onSelect={onSupSelect}
                value={supName}
                onChange={setSupName}
                style={{ width: '100%' }}
              >
                <Input
                  placeholder="输入供应商名称搜索"
                  suffix={<Space size={0}>
                    {supName && <Button size="small" type="text" icon={<CloseOutlined />} style={{ color: '#94a3b8', opacity: 0.5 }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '1'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '0.5'}
                      onClick={(e) => { e.stopPropagation(); clearSupplier() }} />}
                    <Button size="small" type="link" icon={<SearchOutlined />} style={{ color: '#3b82f6' }}
                      onClick={(e) => { e.stopPropagation(); loadSupTable('', 1); setSupModal(true) }} />
                  </Space>}
                />
              </AutoComplete>
            </Form.Item>
            <Form.Item name="supplier_name" hidden><Input /></Form.Item>
            <Form.Item name="supplier_code" label="供应商代码" style={{ width: 130, marginBottom: 0 }}><Input placeholder="自动填充" /></Form.Item>
            <Form.Item name="contact_person" label="联系人" style={{ width: 130, marginBottom: 0 }}><Input placeholder="自动填充" /></Form.Item>
            <Form.Item name="phone" label="电话" style={{ width: 140, marginBottom: 0 }}><Input placeholder="自动填充" /></Form.Item>
            <Form.Item name="fax" label="传真" style={{ width: 140, marginBottom: 0 }}><Input /></Form.Item>
            <Form.Item name="address" label="地址" style={{ width: 300, marginBottom: 0 }}><Input placeholder="自动填充" /></Form.Item>
            <Form.Item name="change_date" label="调价日期" rules={[{ required: true }]} style={{ width: 160, marginBottom: 0 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="purchase_contact" label="采购联系人" style={{ width: 170, marginBottom: 0 }}>
              <AutoComplete options={empOpts} onSearch={searchEmp} style={{ width: '100%' }}>
                <Input placeholder="选人员" suffix={<Button size="small" type="link" icon={<SearchOutlined />} style={{ color: '#3b82f6' }} onClick={(e) => { e.stopPropagation(); loadEmp('', 1); setEmpModal(true) }} />} />
              </AutoComplete>
            </Form.Item>
            <Form.Item name="customer" label="顾客" style={{ width: 200, marginBottom: 0 }}><Input /></Form.Item>
            <Form.Item name="customer_phone" label="顾客电话" style={{ width: 140, marginBottom: 0 }}><Input /></Form.Item>
            <Form.Item name="customer_fax" label="顾客传真" style={{ width: 140, marginBottom: 0 }}><Input /></Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
            <Form.Item name="price_direction" label="类型" rules={[{ required: true }]} style={{ width: 120, marginBottom: 0 }}>
              <Select options={['涨价','降价','新报价'].map(v=>({value:v,label:v}))} />
            </Form.Item>
            <Form.Item name="payment_method" label="付款方式" rules={[{ required: true, message: '请选择' }]} style={{ width: 120, marginBottom: 0 }}>
              <Select options={['网银','承兑'].map(v=>({value:v,label:v}))} placeholder="选择" />
            </Form.Item>
            <Form.Item name="settlement_method" label="结算方式" rules={[{ required: true, message: '请选择' }]} style={{ width: 160, marginBottom: 0 }}>
              <Select options={['票到付款','票到30天','票到60天','票到90天','票到120天','款到发货'].map(v=>({value:v,label:v}))} placeholder="选择" />
            </Form.Item>
            <Form.Item name="tax_rate" label="税率" rules={[{ required: true, message: '请选择' }]} style={{ width: 100, marginBottom: 0 }}>
              <Select options={['3%','6%','13%'].map(v=>({value:v,label:v}))} placeholder="选择" />
            </Form.Item>
          </div>

        </Form>
      </div>

      {/* 物料明细（和详情页风格一致） */}
      <div style={{ ...sectionStyle, marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#0f172a' }}>物料明细</span>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={addItem}>添加行</Button>
        </div>
        <Table rowKey="key" dataSource={items} columns={itemCols} pagination={false} size="small" scroll={{ x: 1200 }}
          locale={{ emptyText: '点击「添加行」添加调价物料' }}
          expandable={{
            expandedRowRender: (r: any) => {
              const prices = r._otherPrices
              if (!prices || prices.length === 0) return <span style={{ color: '#cbd5e1', fontSize: 12 }}>暂无其他供应商报价</span>
              return (
                <div style={{ padding: '4px 0' }}>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>ERP供应商报价（{prices.length}条）：</div>
                  <Table size="small" dataSource={prices} pagination={false} rowKey="supplier_code"
                    columns={[
                      { title: '供应商', dataIndex: 'supplier_name', width: 150 },
                      { title: '单价', dataIndex: 'price', width: 80 },
                      { title: '起订量', dataIndex: 'qty_min', width: 70 },
                      { title: '上限量', dataIndex: 'qty_max', width: 70 },
                      { title: '报价日期', dataIndex: 'start_date', width: 100 },
                      { title: '失效日期', dataIndex: 'end_date', width: 100 },
                    ]} />
                </div>
              )
            },
            expandIcon: ({ expanded, onExpand, record }: any) => (
              <Button size="small" type="link" style={{ fontSize: 12, color: '#3b82f6' }}
                onClick={(e: any) => onExpand(record, e)}>
                {expanded ? '收起' : '比价'}
              </Button>
            ),
          }} />
      </div>

      {/* 附件 + 备注（和详情页风格一致） */}
      <div style={{ ...sectionStyle, marginTop: 12 }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#334155' }}>附件</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Upload fileList={fileList} onChange={({fileList:fl}) => setFileList(fl)}
              beforeUpload={() => false} multiple
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
              showUploadList={false}>
              <Button icon={<PlusOutlined />}>上传文件</Button>
            </Upload>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>支持 PDF、图片、Word、Excel，单文件 ≤10MB</span>
          </div>
          {uploadedFiles.length > 0 && (
            <div style={{ marginBottom: 8, background: '#f0fdf4', borderRadius: 6, padding: '6px 12px' }}>
              <div style={{ fontSize: 12, color: '#16a34a', marginBottom: 4 }}>已上传附件（{uploadedFiles.length} 个）</div>
              {uploadedFiles.map((f: any, i: number) => (
                <span key={i} style={{ display: 'inline-block', fontSize: 12, color: '#334155', marginRight: 8, background: '#fff', padding: '2px 8px', borderRadius: 4, border: '1px solid #d9d9d9' }}>
                  {f.name} <a onClick={(e) => { e.stopPropagation(); setUploadedFiles(uploadedFiles.filter((_: any, j: number) => j !== i)) }} style={{ color: '#ef4444', marginLeft: 4 }}>x</a>
                </span>
              ))}
            </div>
          )}
          {fileList.length > 0 && (
            <div style={{ marginTop: 8, background: '#f8fafc', borderRadius: 6, padding: '8px 12px' }}>
              {fileList.map((f: any, i: number) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderBottom: i < fileList.length - 1 ? '1px solid #f1f5f9' : 'none' }}>
                  <span style={{ fontSize: 13, color: '#334155' }}>{f.name}</span>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>{f.size ? (f.size / 1024).toFixed(0) + 'KB' : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <Input.TextArea rows={2} placeholder="备注：调价原因说明" value={remark} onChange={e => setRemark(e.target.value)} />
      </div>

      {/* 供应商选择弹窗 */}
      <Modal title="选择供应商" open={supModal} width={950} onCancel={() => setSupModal(false)} footer={null}>
        <Input prefix={<SearchOutlined />} placeholder="搜索供应商名称或代码" value={supKw}
          onChange={e => setSupKw(e.target.value)}
          onPressEnter={() => loadSupTable(supKw, 1)}
          suffix={<Button size="small" type="primary" onClick={() => loadSupTable(supKw, 1)}>搜索</Button>}
          style={{ marginBottom: 12 }} allowClear />
        <Table rowKey="id" dataSource={supList} size="small" scroll={{ y: 400 }}
          pagination={{ total: supTotal, current: supPage, pageSize: 10, onChange: (p) => loadSupTable(supKw, p), showTotal: t => `共 ${t} 条` }}
          onRow={r => ({ onClick: () => { fillSupplier(r); setSupModal(false) }, style: { cursor: 'pointer' } })}
          columns={[
            { title: '供应商代码', dataIndex: 'supplier_code', width: 130, render: (v: string) => <span style={{ fontFamily: 'monospace', color: '#3b82f6' }}>{v}</span> },
            { title: 'ID', dataIndex: 'id', width: 60, render: (v: number) => <span style={{ color: '#94a3b8', fontSize: 12 }}>{v}</span> },
            { title: '供应商名称', dataIndex: 'supplier_name', width: 200, ellipsis: true },
            { title: '联系人', dataIndex: 'contact_person', width: 90 },
            { title: '联系方式', dataIndex: 'contact_phone', width: 130 },
            { title: '传真', width: 100, render: () => <span style={{ color: '#cbd5e1' }}>-</span> },
            { title: '地址', width: 150, ellipsis: true, render: (_: any, r: any) => <span style={{ color: r.address ? '#334155' : '#cbd5e1' }}>{r.address || '-'}</span> },
          ]} />
      </Modal>

      {/* 员工选择弹窗 */}
      <Modal title="选择采购联系人" open={empModal} width={700} onCancel={() => setEmpModal(false)} footer={null}>
        <Input prefix={<SearchOutlined />} placeholder="搜索人员姓名或工号" value={empKw}
          onChange={e => setEmpKw(e.target.value)}
          onPressEnter={() => loadEmp(empKw, 1)}
          suffix={<Button size="small" type="primary" onClick={() => loadEmp(empKw, 1)}>搜索</Button>}
          style={{ marginBottom: 12 }} allowClear />
        <Table rowKey="id" dataSource={empList} size="small" scroll={{ y: 400 }}
          pagination={{ total: empTotal, current: empPage, pageSize: 10, onChange: (p) => loadEmp(empKw, p), showTotal: t => `共 ${t} 条` }}
          onRow={r => ({ onClick: () => { form.setFieldsValue({ purchase_contact: r.display_name || r.emp_code || r.username }); setEmpModal(false) }, style: { cursor: 'pointer' } })}
          columns={[
            { title: '姓名', dataIndex: 'display_name', width: 100 },
            { title: '工号', dataIndex: 'emp_code', width: 120 },
            { title: '岗位', dataIndex: 'position_name', width: 180, ellipsis: true },
          ]} />
      </Modal>

      {/* 自检阻断弹窗 */}
      <Modal title={null} open={scModal} width={640} onCancel={closeScModal}
        footer={
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              {scResult?.overall_status === 'high' ? '高风险项必须上传支撑凭证才能提交' : '中风险项建议上传凭证说明'}
            </div>
            <Space>
              <Button onClick={closeScModal}>取消提交</Button>
              <Button type="primary" icon={<SendOutlined />} loading={scSaving}
                disabled={scResult?.overall_status === 'high' && scEvidence.length === 0 && scEvidenceFiles.length === 0}
                onClick={submitWithEvidence}>
                确认提交
              </Button>
            </Space>
          </Space>
        }>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            {scResult?.overall_status === 'high'
              ? <WarningOutlined style={{ fontSize: 22, color: '#dc2626' }} />
              : <ExclamationCircleOutlined style={{ fontSize: 22, color: '#d97706' }} />}
            <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>价格自检异常</span>
            <Tag color={scResult?.overall_status === 'high' ? 'red' : 'orange'}>
              {scResult?.overall_status === 'high' ? '高风险' : '中风险'}
            </Tag>
          </div>

          {/* 自检摘要 */}
          <div style={{ background: scResult?.overall_status === 'high' ? '#fef2f2' : '#fffbeb', borderRadius: 6, padding: '12px 16px', marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: scResult?.overall_status === 'high' ? '#991b1b' : '#92400e', marginBottom: 4 }}>自检摘要</div>
            <div style={{ fontSize: 13, color: scResult?.overall_status === 'high' ? '#7f1d1d' : '#78350f' }}>{scResult?.summary || '-'}</div>
          </div>

          {/* 明细风险列表 */}
          {scResult?.checks?.map((check: any, idx: number) => {
            const highRisks = check.risks?.filter((r: any) => r.severity === 'high') || []
            const medRisks = check.risks?.filter((r: any) => r.severity === 'medium') || []
            const hasIssue = highRisks.length > 0 || medRisks.length > 0
            if (!hasIssue) return null
            return (
              <div key={idx} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 16px', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Tag color={check.risk_level === 'high' ? 'red' : 'orange'}>{check.risk_level === 'high' ? '高风险' : '中风险'}</Tag>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{check.material_code} {check.material_name}</span>
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#64748b', marginBottom: 6 }}>
                  <span>原价: <b>{check.old_price}</b></span>
                  <span>新价: <b>{check.new_price}</b></span>
                </div>
                {[...highRisks, ...medRisks].map((risk: any, ri: number) => (
                  <div key={ri} style={{ fontSize: 12, color: risk.severity === 'high' ? '#dc2626' : '#d97706', padding: '2px 0' }}>
                    • {risk.detail}
                  </div>
                ))}
              </div>
            )
          })}

          {/* 凭证上传 */}
          <Divider style={{ margin: '12px 0' }} />
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 4 }}>
              支撑凭证 {scResult?.overall_status === 'high' ? <span style={{ color: '#dc2626' }}>（必填）</span> : <span style={{ color: '#d97706' }}>（建议上传）</span>}
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
              请上传供应商报价单、大宗商品指数截图、物流成本调整函等证明材料
            </div>
            <Upload fileList={scEvidenceFiles} onChange={({fileList: fl}) => setScEvidenceFiles(fl)}
              beforeUpload={() => false} multiple
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
              showUploadList={true}>
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>支持 PDF、图片、Word、Excel</div>
          </div>

          {/* 已上传的凭证列表占位（实际在上传后显示）*/}
          {scEvidence.length > 0 && (
            <div style={{ marginTop: 8, background: '#f0fdf4', borderRadius: 6, padding: '6px 12px' }}>
              <div style={{ fontSize: 12, color: '#16a34a', marginBottom: 4 }}>已上传凭证（{scEvidence.length} 个）</div>
              {scEvidence.map((f: any, i: number) => (
                <span key={i} style={{ display: 'inline-block', fontSize: 12, color: '#334155', marginRight: 8, background: '#fff', padding: '2px 8px', borderRadius: 4, border: '1px solid #d9d9d9' }}>
                  {f.name} <a onClick={() => setScEvidence(scEvidence.filter((_: any, j: number) => j !== i))} style={{ color: '#ef4444', marginLeft: 4 }}>x</a>
                </span>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* 物料选择弹窗 */}
      <Modal title="搜索物料" open={matModal} width={900} onCancel={() => setMatModal(false)} footer={null}>
        <Input prefix={<SearchOutlined />} placeholder="搜索物料代码或名称" value={matKw}
          onChange={e => setMatKw(e.target.value)}
          onPressEnter={() => loadMatTable(matKw, 1)}
          suffix={<Button size="small" type="primary" onClick={() => loadMatTable(matKw, 1)}>搜索</Button>}
          style={{ marginBottom: 12 }} allowClear />
        <Table rowKey="id" dataSource={matList} size="small" scroll={{ y: 400 }}
          pagination={{ total: matTotal, current: matPage, pageSize: 15, onChange: (p) => loadMatTable(matKw, p), showTotal: t => `共 ${t} 条` }}
          onRow={r => ({ onClick: () => onMatRowClick(r), style: { cursor: 'pointer' } })}
          columns={[
            { title: '物料代码', dataIndex: 'material_code', width: 150, render: (v: string) => <span style={{ fontFamily: 'monospace', color: '#3b82f6' }}>{v}</span> },
            { title: '物料名称', dataIndex: 'material_name', width: 200, ellipsis: true },
            { title: '规格', dataIndex: 'spec', width: 120, ellipsis: true },
            { title: '单位', dataIndex: 'unit', width: 60 },
          ]} />
      </Modal>
    </div>
  )
}
