import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Toast, SpinLoading } from 'antd-mobile'
import { materialApi } from '@/services/api'
import NavBarSimple from '../../components/NavBarSimple'
import DigitPad from '../../components/DigitPad'
import MDialog from '../../components/MDialog'
import { SkeletonCards } from '../../components/Feedback'

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

interface CheckHead {
  co_checkers?: Array<{ user_id: number; name: string }> | null
  items?: CheckItem[] | null
}

function fmtQty(v: number | null | undefined): string {
  if (v == null) return '—'
  const n = Number(v)
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

export default function StockCheckEntryPage() {
  const { checkId, itemId } = useParams()
  const navigate = useNavigate()
  const id = Number(checkId)
  const [head, setHead] = useState<CheckHead | null>(null)
  const [items, setItems] = useState<CheckItem[]>([])
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
      const all: CheckItem[] = res.data?.items || []
      setHead(res.data)
      setItems(all)
      const found: CheckItem | undefined = all.find((i) => i.id === Number(itemId))
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

  const idx = item ? items.findIndex((i) => i.id === item.id) + 1 : 0
  const doneCount = items.filter((i) => i.is_checked === 1 || i.actual_qty != null).length

  const diff = useMemo(() => {
    if (!item || item.system_qty == null || value === '' || isNaN(Number(value))) return null
    return Math.round((Number(value) - Number(item.system_qty)) * 100) / 100
  }, [item, value])

  // 保存成功后跳到下一个未盘项（从当前项之后循环找），全部盘完返回详情
  function goNext(after: string) {
    if (!item) return
    const cur = items.findIndex((i) => i.id === item.id)
    let next: CheckItem | undefined
    for (let i = cur + 1; i < items.length; i++) {
      if (!items[i].is_checked && items[i].actual_qty == null) { next = items[i]; break }
    }
    if (!next) {
      for (let i = 0; i < cur; i++) {
        if (!items[i].is_checked && items[i].actual_qty == null) { next = items[i]; break }
      }
    }
    if (next) {
      Toast.show(after)
      navigate(`/stock-check/${id}/items/${next.id}`, { replace: true })
    } else {
      Toast.show('该盘点单已全部盘完')
      setTimeout(() => navigate(`/stock-check/${id}`, { replace: true }), 600)
    }
  }

  async function save(force = false, next = false): Promise<boolean> {
    if (!item) return false
    if (value !== '' && (isNaN(Number(value)) || Number(value) < 0)) {
      Toast.show('请输入有效数量')
      return false
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
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? { ...it, actual_qty: value === '' ? null : Number(value), is_checked: markChecked && value !== '' ? 1 : 0, remark }
            : it,
        ),
      )
      if (next) {
        goNext('已保存，进入下一项')
      } else {
        Toast.show({ icon: 'success', content: '已保存' })
        setTimeout(() => navigate(-1), 400)
      }
      return true
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
      return false
    } finally {
      setSaving(false)
    }
  }

  if (loading && !item) {
    return (
      <div className="m-page m-page--full">
        <NavBarSimple title="物料盘点" />
        <div className="m-page__scroll"><SkeletonCards count={2} /></div>
      </div>
    )
  }
  if (!item) {
    return (
      <div className="m-page m-page--full" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <SpinLoading color="primary" />
      </div>
    )
  }

  const coCheckers = head?.co_checkers || []

  return (
    <div className="m-page m-page--full">
      <NavBarSimple
        title={`${item.material_code || ''} 盘点`}
        onBack={() => navigate(-1)}
        right={
          coCheckers.length > 0 ? (
            <div className="avs">
              {coCheckers.slice(0, 3).map((c, i) => (
                <div className={`av${i > 0 ? ` g${(i % 3) + 2}` : ''}`} key={c.user_id} title={c.name}
                  style={{ width: 24, height: 24, fontSize: 9, marginLeft: i === 0 ? 0 : -6 }}>
                  {(c.name || '?').slice(0, 1)}
                  <i className="on-dot" />
                </div>
              ))}
            </div>
          ) : undefined
        }
      />

      <div className="m-page__scroll">
        <div className="m-card en-mat">
          <div className="en-head">
            {idx > 0 && <span className="en-pos">第 {idx} / {items.length} 项</span>}
            <span className="m-chip m-chip--progress" style={{ fontSize: 10 }}>
              {items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0}%
            </span>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div className="en-name">{item.material_name || item.material_code}</div>
            <div className="en-spec">{[item.spec_model, item.wh_name, item.unit ? `单位 ${item.unit}` : null].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="m-progress">
            <i style={{ width: `${items.length > 0 ? (doneCount / items.length) * 100 : 0}%` }} />
          </div>
          <div className="en-nums">
            <div>
              <div className="nl">系统数量</div>
              <div className="nv">{fmtQty(item.system_qty)}</div>
            </div>
            <div>
              <div className="nl">差异</div>
              <div className={`nv${diff == null || diff === 0 ? '' : diff > 0 ? ' green' : ' red'}`}>
                {diff == null ? '—' : diff === 0 ? '±0' : `${diff > 0 ? '+' : ''}${fmtQty(diff)}`}
              </div>
            </div>
          </div>
        </div>

        <div className="m-card en-actual">
          <div className="ah">
            <span>实盘数量{item.unit ? `（${item.unit}）` : ''}</span>
            {(item.is_checked === 1 || (markChecked && value !== '')) && (
              <span className="m-chip m-chip--done">已盘</span>
            )}
          </div>
          <div className={`en-num${value === '' && item.actual_qty == null ? ' ph' : ''}`}>
            {value !== '' ? value : item.actual_qty != null ? fmtQty(item.actual_qty) : '—'}
          </div>
          <div className="en-diff">
            {diff == null ? (
              <span className="m-chip m-chip--zero">待录入后计算</span>
            ) : diff === 0 ? (
              <span className="m-chip m-chip--zero">与系统一致</span>
            ) : (
              <span className={`m-chip ${diff > 0 ? 'm-chip--pos' : 'm-chip--neg'}`}>
                较系统 {diff > 0 ? '+' : ''}{fmtQty(diff)}
              </span>
            )}
          </div>
        </div>

        <div className="en-sw">
          <span>顺手标记已盘</span>
          <button className={`mswitch${markChecked ? ' on' : ''}`} onClick={() => setMarkChecked((v) => !v)} />
        </div>

        <div className="en-remark">
          <textarea
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            maxLength={200}
            placeholder="备注（可选）"
          />
        </div>
        <div style={{ height: 8 }} />
      </div>

      <DigitPad
        value={value}
        onChange={setValue}
        onSubmit={() => save(false, false)}
        onSubmitNext={() => save(false, true)}
        disabled={saving}
      />

      <MDialog
        visible={!!conflict}
        title="保存冲突（409）"
        onClose={() => setConflict(null)}
        actions={[
          {
            label: '改用服务器值',
            onClick: () => {
              if (!conflict || !item) return
              setValue(conflict.serverItem.actual_qty != null ? String(conflict.serverItem.actual_qty) : '')
              setItem({ ...item, version: conflict.serverItem.version, is_checked: conflict.serverItem.is_checked ?? item.is_checked })
              setConflict(null)
            },
          },
          {
            label: '以我的为准（force_recount）',
            kind: 'primary',
            onClick: () => {
              setConflict(null)
              void save(true, false)
            },
          },
        ]}
      >
        <div style={{ textAlign: 'center', marginBottom: 4 }}>「{item.material_name || item.material_code}」已被他人抢先录入</div>
        <div className="cmp">
          <div className="server">
            <div className="cl">服务器当前值</div>
            <div className="cv">{conflict ? fmtQty(conflict.serverItem.actual_qty) : '—'}</div>
            <div className="cs">
              {conflict?.serverItem.checked_by || '他人'} ·{' '}
              {conflict?.serverItem.checked_at ? new Date(conflict.serverItem.checked_at).toLocaleTimeString() : '刚刚'}
            </div>
          </div>
          <div className="mine">
            <div className="cl">我的录入</div>
            <div className="cv">{value === '' ? '—' : value}</div>
            <div className="cs">刚刚</div>
          </div>
        </div>
        <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--spc-text3)' }}>
          乐观锁：expected_version 不一致，请选择处理方式
        </div>
      </MDialog>
    </div>
  )
}
