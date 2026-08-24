import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Switch, ActionSheet, Toast, TextArea, Tag, SpinLoading } from 'antd-mobile'
import { materialApi } from '@/services/api'
import NavBarSimple from '../../components/NavBarSimple'
import DigitPad from '../../components/DigitPad'

interface CheckItem {
  id: number
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  wh_name?: string | null
  system_qty?: number | null
  actual_qty?: number | null
  diff_qty?: number | null
  is_checked?: number | null
  remark?: string | null
  version?: number | null
  checked_by?: string | null
  checked_at?: string | null
}

export default function StockCheckEntryPage() {
  const { checkId, itemId } = useParams()
  const navigate = useNavigate()
  const id = Number(checkId)
  const [item, setItem] = useState<CheckItem | null>(null)
  const [value, setValue] = useState('')
  const [remark, setRemark] = useState('')
  const [markChecked, setMarkChecked] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [conflict, setConflict] = useState<{ serverItem: CheckItem } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await materialApi.getStockCheck(id)
      const found: CheckItem | undefined = (res.data?.items || []).find((i: CheckItem) => i.id === Number(itemId))
      if (found) {
        setItem(found)
        setValue(found.actual_qty != null ? String(found.actual_qty) : '')
        setRemark(found.remark || '')
      }
    } finally {
      setLoading(false)
    }
  }, [id, itemId])

  useEffect(() => { load() }, [load])

  // 存在感：进入录入页即声明正在盘该物料（立即 + 30s 心跳续命），离开时清除
  useEffect(() => {
    const itemIdNum = Number(itemId)
    if (!itemIdNum || Number.isNaN(itemIdNum)) return
    materialApi.updateStockCheckPresence(id, itemIdNum).catch(() => {})
    const t = setInterval(() => {
      materialApi.updateStockCheckPresence(id, itemIdNum).catch(() => {})
    }, 30000)
    return () => {
      clearInterval(t)
      materialApi.updateStockCheckPresence(id, null).catch(() => {})
    }
  }, [id, itemId])

  const diff = useMemo(() => {
    if (!item || item.system_qty == null || value === '' || isNaN(Number(value))) return null
    return Number(value) - Number(item.system_qty)
  }, [item, value])

  async function save(force = false) {
    if (!item) return
    if (value !== '' && (isNaN(Number(value)) || Number(value) < 0)) {
      Toast.show('请输入有效数量')
      return
    }
    setSaving(true)
    try {
      await materialApi.updateStockCheckItem(item.id, {
        actual_qty: value === '' ? null : Number(value),
        is_checked: markChecked && value !== '' ? 1 : 0,
        ...(remark !== item.remark ? { remark } : {}),
        expected_version: item.version ?? undefined,
        ...(force ? { force_recount: true } : {}),
      })
      Toast.show({ icon: 'success', content: '已保存' })
      navigate(-1)
    } catch (e: any) {
      const status = e?.response?.status
      const msg = String(e?.response?.data?.detail || e?.message || '')
      if (status === 409 || msg.includes('版本') || msg.includes('冲突')) {
        try {
          const res: any = await materialApi.getStockCheck(id)
          const serverItem = (res.data?.items || []).find((i: CheckItem) => i.id === item.id)
          if (serverItem) setConflict({ serverItem })
          else Toast.show({ icon: 'fail', content: msg || '保存失败' })
        } catch {
          Toast.show({ icon: 'fail', content: msg || '保存失败' })
        }
      } else {
        Toast.show({ icon: 'fail', content: msg || '保存失败' })
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading || !item) {
    return <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><SpinLoading color="primary" /></div>
  }

  return (
    <div className="mobile-page" style={{ display: 'flex', flexDirection: 'column', height: '100vh', paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}>
      <NavBarSimple title={`${item.material_code || ''} 盘点`} onBack={() => navigate(-1)} />

      <div className="mobile-card">
        <div style={{ fontWeight: 600, fontSize: 15 }}>{item.material_name}</div>
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{[item.spec_model, item.wh_name, item.unit].filter(Boolean).join(' · ')}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>系统数量</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#475569' }}>{item.system_qty ?? '-'}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>差异</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: diff == null ? '#cbd5e1' : diff === 0 ? '#475569' : diff > 0 ? '#16a34a' : '#e11d48' }}>
              {diff == null ? '-' : diff > 0 ? `+${diff}` : diff}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>顺手标记已盘</div>
            <Switch checked={markChecked} onChange={setMarkChecked} />
          </div>
        </div>
      </div>

      <div className="mobile-card" style={{ textAlign: 'center', padding: '16px 0' }}>
        <div style={{ fontSize: 12, color: '#94a3b8' }}>实盘数量{item.unit ? `（${item.unit}）` : ''}</div>
        <div style={{ fontSize: 40, fontWeight: 700, color: value ? '#1e293b' : '#cbd5e1', minHeight: 52, fontFamily: 'monospace' }}>
          {value || '0'}
        </div>
        {item.is_checked === 1 && <Tag color="success" style={{ '--border-radius': '6px' } as any}>已盘</Tag>}
      </div>

      <div style={{ marginBottom: 10 }}>
        <TextArea placeholder="备注（可选）" value={remark} onChange={setRemark} maxLength={200} rows={1} />
      </div>

      <div style={{ marginTop: 'auto' }}>
        <DigitPad value={value} onChange={setValue} onSubmit={() => save(false)} disabled={saving} />
      </div>

      <ActionSheet
        visible={!!conflict}
        actions={[]}
        onClose={() => setConflict(null)}
        cancelText="取消"
        extra={
          conflict ? (
            <div style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>该物料刚被他人修改</div>
              <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                服务器当前实盘数：<b>{conflict.serverItem.actual_qty ?? '未盘'}</b>（{conflict.serverItem.checked_by || '他人'} 于{' '}
                {conflict.serverItem.checked_at ? new Date(conflict.serverItem.checked_at).toLocaleTimeString() : '刚刚'}）
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="adm-button adm-button-default adm-button-large" style={{ flex: 1, borderRadius: 10 }}
                  onClick={() => {
                    setValue(conflict.serverItem.actual_qty != null ? String(conflict.serverItem.actual_qty) : '')
                    setItem({ ...item, version: conflict.serverItem.version, is_checked: conflict.serverItem.is_checked ?? item.is_checked })
                    setConflict(null)
                  }}>改用服务器值</button>
                <button className="adm-button adm-button-primary adm-button-large" style={{ flex: 1, borderRadius: 10 }}
                  onClick={() => { setConflict(null); save(true) }}>以我的为准</button>
              </div>
            </div>
          ) : undefined
        }
      />
    </div>
  )
}
