import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SpinLoading, Toast, Dialog } from 'antd-mobile'
import { materialApi } from '@/services/api'
import { useStockCheckPoolStore, poolKey, PoolMaterial } from '@/store/stockCheckPool'
import NavBarSimple from '../../components/NavBarSimple'
import SegTabs from '../../components/SegTabs'
import MIcon from '../../components/MIcon'
import { EmptyState } from '../../components/Feedback'
import MDialog from '../../components/MDialog'

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
  const [searched, setSearched] = useState(false)
  const [confirmOrder, setConfirmOrder] = useState(false)
  const [confirmPool, setConfirmPool] = useState(false)

  async function search() {
    if (!keyword.trim()) return
    setSearching(true)
    try {
      const res: any = await materialApi.listMaterialCandidates({ keyword: keyword.trim(), page: 1, page_size: 30 })
      setCandidates(res.data?.items || [])
      setSearched(true)
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
    setConfirmOrder(false)
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
    setConfirmPool(false)
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

  const inPool = (c: Candidate) =>
    pool.items.some((it) => poolKey(it) === poolKey({ erp_material_id: c.erp_material_id, wh_id: c.wh_id ?? null }))

  return (
    <div className="m-page m-page--full">
      <NavBarSimple title="新建盘点" onBack={() => navigate(-1)} />

      <div className="m-page__scroll">
        <div className="lk-tabs" style={{ padding: '12px 14px' }}>
          <SegTabs
            items={[
              { key: 'order', label: '从订单' },
              { key: 'materials', label: '从物料', count: pool.items.length || undefined },
            ]}
            active={tab}
            onChange={(k) => setTab(k as typeof tab)}
          />
        </div>

        <div className="m-card">
          <div className="m-field">
            <label>盘点单标题</label>
            <div className="inp">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：8月末主材盘点" />
            </div>
          </div>
          <div className="m-field" style={{ marginBottom: 0 }}>
            <label>备注（可选）</label>
            <textarea value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={200} placeholder="补充说明…" />
          </div>
        </div>

        {tab === 'order' ? (
          <div className="m-card">
            <div className="m-field">
              <label>订单号</label>
              <div className="inp">
                <input value={orderNo} onChange={(e) => setOrderNo(e.target.value)} placeholder="请输入销售订单号" />
              </div>
            </div>
            <button
              className="mbtn mbtn--primary mbtn--block"
              disabled={creating}
              onClick={() => {
                if (!orderNo.trim()) { Toast.show('请输入订单号'); return }
                setConfirmOrder(true)
              }}
            >
              <MIcon name="box" size={17} />按订单建盘（自动载入 BOM 物料）
            </button>
          </div>
        ) : (
          <>
            <div className="m-card">
              <div className="lk-search" style={{ padding: '0 0 10px' }}>
                <div className="lk-search__box" style={{ border: '1.5px solid var(--spc-border)', background: '#fff' }}>
                  <MIcon name="search" size={17} />
                  <input
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') search() }}
                    placeholder="搜索物料编码 / 名称 / 规格"
                  />
                </div>
                <button className="mbtn mbtn--primary mbtn--sm" onClick={search}>搜索</button>
              </div>
              {searching && <div style={{ textAlign: 'center', padding: 16 }}><SpinLoading color="primary" /></div>}
              {!searching && candidates.length === 0 && (
                <EmptyState icon="search" text={searched ? '没有匹配的物料' : '输入关键词搜索物料'} />
              )}
              {!searching && candidates.map((c) => (
                <div className="cand" key={`${c.erp_material_id}-${c.wh_id ?? 'all'}`} onClick={() => toggleCandidate(c)}>
                  <span className={`cbx${inPool(c) ? ' on' : ''}`}><MIcon name="check" size={12} /></span>
                  <div className="c1">
                    <div className="cc">
                      {c.material_name || c.material_code || `物料${c.erp_material_id}`}
                      <i>{c.material_code}</i>
                    </div>
                    <div className="cs">
                      {[c.spec_model, c.wh_name, c.system_qty != null ? `库存 ${c.system_qty}` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="m-card">
              <div className="m-card__title">
                已加入物料
                <span className="m-chip m-chip--progress" style={{ marginLeft: 8 }}>{pool.items.length} 项</span>
              </div>
              {pool.items.length === 0 ? (
                <div className="pool-empty">暂无物料，从上方候选列表点选加入（与 PC 端暂存池互通）</div>
              ) : (
                <div className="pool">
                  {pool.items.map((m) => (
                    <span className="pchip" key={poolKey(m)}>
                      {m.material_code || m.material_name}
                      <button onClick={() => pool.remove([m])}><MIcon name="close" size={12} /></button>
                    </span>
                  ))}
                </div>
              )}
              <button
                className="mbtn mbtn--primary mbtn--block"
                style={{ marginTop: 12 }}
                disabled={creating || pool.items.length === 0}
                onClick={() => setConfirmPool(true)}
              >
                {pool.items.length ? `按暂存池建盘（${pool.items.length}）` : '按暂存池建盘'}
              </button>
            </div>
          </>
        )}
        <div style={{ height: 20 }} />
      </div>

      <MDialog
        visible={confirmOrder}
        title="按订单创建盘点"
        onClose={() => setConfirmOrder(false)}
        actions={[
          { label: '取消' },
          { label: '确认创建', kind: 'primary', onClick: createFromOrder },
        ]}
      >
        将按订单 <b>{orderNo.trim()}</b> 自动载入 BOM 物料创建盘点单，创建后即可开始协同盘点。
      </MDialog>

      <MDialog
        visible={confirmPool}
        title="按暂存池创建盘点"
        onClose={() => setConfirmPool(false)}
        actions={[
          { label: '取消' },
          { label: '确认创建', kind: 'primary', onClick: createFromPool },
        ]}
      >
        将使用暂存池中的 <b>{pool.items.length}</b> 项物料创建盘点单，创建成功后暂存池将清空。
      </MDialog>
    </div>
  )
}
