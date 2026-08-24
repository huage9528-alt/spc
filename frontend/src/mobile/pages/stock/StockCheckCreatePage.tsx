import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tabs, Input, Button, List, Toast, Checkbox, TextArea, Dialog, SpinLoading } from 'antd-mobile'
import { materialApi } from '@/services/api'
import { useStockCheckPoolStore, poolKey, PoolMaterial } from '@/store/stockCheckPool'
import NavBarSimple from '../../components/NavBarSimple'

interface Candidate {
  erp_material_id: number
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  system_qty?: number | null
  wh_id?: number | null
  wh_code?: string | null
  wh_name?: string | null
}

export default function StockCheckCreatePage() {
  const navigate = useNavigate()
  const pool = useStockCheckPoolStore()
  const [tab, setTab] = useState<'order' | 'materials'>('order')
  const [orderNo, setOrderNo] = useState('')
  const [title, setTitle] = useState('')
  const [remark, setRemark] = useState('')
  const [creating, setCreating] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [searching, setSearching] = useState(false)

  async function search() {
    if (!keyword.trim()) return
    setSearching(true)
    try {
      const res: any = await materialApi.listMaterialCandidates({ keyword: keyword.trim(), page: 1, page_size: 30 })
      setCandidates(res.data?.items || [])
    } catch {
      Toast.show('搜索失败')
    } finally {
      setSearching(false)
    }
  }

  function toggleCandidate(c: Candidate) {
    const m: PoolMaterial = {
      erp_material_id: c.erp_material_id,
      material_code: c.material_code ?? null,
      material_name: c.material_name ?? null,
      spec_model: c.spec_model ?? null,
      unit: c.unit ?? null,
      system_qty: c.system_qty ?? null,
      added_at: new Date().toISOString(),
      wh_id: c.wh_id ?? null,
      wh_code: c.wh_code ?? null,
      wh_name: c.wh_name ?? null,
    }
    if (pool.items.some((it) => poolKey(it) === poolKey(m))) {
      pool.remove([m])
    } else {
      pool.add([m])
    }
  }

  async function createFromOrder() {
    if (!orderNo.trim()) { Toast.show('请输入订单号'); return }
    setCreating(true)
    try {
      const res: any = await materialApi.createStockCheckFromOrder(orderNo.trim(), {
        title: title.trim() || undefined,
        remark: remark.trim() || undefined,
      })
      Toast.show({ icon: 'success', content: '已创建' })
      navigate(`/stock-check/${res.data.id}`, { replace: true })
    } catch (e: any) {
      Toast.show(e?.response?.data?.detail || e?.message || '创建失败')
    } finally {
      setCreating(false)
    }
  }

  async function createFromPool() {
    if (pool.items.length === 0) { Toast.show('请先搜索并加入物料'); return }
    setCreating(true)
    try {
      const res: any = await materialApi.createStockCheckFromMaterials({
        items: pool.items.map((m) => ({ material_id: m.erp_material_id, wh_id: m.wh_id ?? undefined })),
        title: title.trim() || undefined,
        remark: remark.trim() || undefined,
      })
      pool.clear()
      Toast.show({ icon: 'success', content: '已创建' })
      navigate(`/stock-check/${res.data.id}`, { replace: true })
    } catch (e: any) {
      Toast.show(e?.response?.data?.detail || e?.message || '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const inPool = (c: Candidate) => pool.items.some((it) => poolKey(it) === poolKey({ erp_material_id: c.erp_material_id, wh_id: c.wh_id ?? null }))

  return (
    <div className="mobile-page">
      <NavBarSimple title="新建盘点" onBack={() => navigate(-1)} />
      <Tabs activeKey={tab} onChange={(k) => setTab(k as typeof tab)}>
        <Tabs.Tab title="从订单" key="order" />
        <Tabs.Tab title={`从物料${pool.items.length ? `(${pool.items.length})` : ''}`} key="materials" />
      </Tabs>

      <div className="mobile-card">
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>标题（可选）</div>
          <Input value={title} onChange={setTitle} placeholder="如：3号线电子仓周盘" clearable />
        </div>
        {tab === 'order' ? (
          <>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>订单号</div>
            <Input value={orderNo} onChange={setOrderNo} placeholder="请输入订单号" clearable />
            <Button block color="primary" size="large" loading={creating} disabled={creating} style={{ marginTop: 16, '--border-radius': '10px' } as any} onClick={createFromOrder}>
              按订单建盘（自动载入 BOM 物料）
            </Button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <Input value={keyword} onChange={setKeyword} placeholder="搜索物料编码/名称" clearable onEnterPress={search} />
              </div>
              <Button color="primary" fill="outline" onClick={search}>搜索</Button>
            </div>
            {searching && <div style={{ textAlign: 'center', padding: 16 }}><SpinLoading color="primary" /></div>}
            <List style={{ '--border-top': 'none' } as any}>
              {candidates.map((c) => (
                <List.Item
                  key={`${c.erp_material_id}-${c.wh_id ?? 'all'}`}
                  clickable
                  onClick={() => toggleCandidate(c)}
                  extra={<Checkbox checked={inPool(c)} onChange={() => toggleCandidate(c)} />}
                  description={<span style={{ fontSize: 12, color: '#64748b' }}>{[c.spec_model, c.wh_name, c.system_qty != null ? `库存 ${c.system_qty}` : null].filter(Boolean).join(' · ')}</span>}
                >
                  {c.material_code} {c.material_name}
                </List.Item>
              ))}
            </List>
            {pool.items.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>已加入 {pool.items.length} 项</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {pool.items.map((m) => (
                    <span key={poolKey(m)} style={{ fontSize: 12, background: '#eef0ff', color: '#4f46e5', borderRadius: 6, padding: '3px 8px' }}
                      onClick={() => pool.remove([m])}>
                      {m.material_code || m.material_name} ✕
                    </span>
                  ))}
                </div>
                <Button block color="primary" size="large" loading={creating} disabled={creating} style={{ '--border-radius': '10px' } as any}
                  onClick={() => {
                    void Dialog.confirm({ title: `创建盘点单（${pool.items.length} 项物料）`, onConfirm: createFromPool })
                  }}>
                  按暂存池建盘
                </Button>
              </div>
            )}
          </>
        )}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>备注（可选）</div>
          <TextArea value={remark} onChange={setRemark} rows={2} maxLength={200} placeholder="盘点原因/范围说明" />
        </div>
      </div>
    </div>
  )
}
