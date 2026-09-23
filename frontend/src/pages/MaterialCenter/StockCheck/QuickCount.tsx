import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Input, InputNumber, message, Modal, Popconfirm, Select, Space, Spin, Tag, Tooltip, Typography,
} from 'antd'
import type { InputRef } from 'antd'
import {
  ArrowLeftOutlined, FileExcelOutlined, SearchOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import { materialApi } from '@/services/api'
import ExcelImportModal from './ExcelImportModal'

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
  recent_checked_check_no?: string | null
  recent_checked_date?: string | null
}

interface TodayItem {
  id: number
  material_id: number | null
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  wh_id?: number | null
  wh_name?: string | null
  system_qty: number
  actual_qty: number | null
  diff_qty: number
  counted_by?: string | null
  counted_at?: string | null
}

interface TodaySheet {
  check_id: number
  check_no: string
  title: string
  items: TodayItem[]
}

const CAND_BTN_BASE: React.CSSProperties = {
  borderRadius: 8, padding: '7px 16px', fontWeight: 500, background: '#fff',
}
const CAND_BTN_EVEN: React.CSSProperties = { ...CAND_BTN_BASE, color: '#1677ff', borderColor: '#bfdbfe', background: '#eff6ff' }
const CAND_BTN_SUR: React.CSSProperties = { ...CAND_BTN_BASE, color: '#16a34a', borderColor: '#bbf7d0', background: '#f0fdf4' }
const CAND_BTN_DEF: React.CSSProperties = { ...CAND_BTN_BASE, color: '#dc2626', borderColor: '#fecaca', background: '#fef2f2' }

function StatPill({ tone, children }: { tone?: 'g' | 'r' | 'b'; children: ReactNode }) {
  const toneStyle = tone === 'g'
    ? { color: '#16a34a', borderColor: '#bbf7d0', background: '#f0fdf4' }
    : tone === 'r'
      ? { color: '#dc2626', borderColor: '#fecaca', background: '#fef2f2' }
      : tone === 'b'
        ? { color: '#2563eb', borderColor: '#bfdbfe', background: '#eff6ff' }
        : { color: '#64748b' }
  return (
    <span style={{ borderRadius: 999, border: '1px solid #e2e8f0', padding: '2px 10px', fontSize: 12, whiteSpace: 'nowrap', ...toneStyle }}>
      {children}
    </span>
  )
}

const fmtQty = (v: number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmt2 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toFixed(2))
const signQty = (v: number | null | undefined) => {
  const n = Number(v || 0)
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`
}
const diffColor = (v: number | null | undefined) => {
  const n = Number(v || 0)
  return n > 0 ? '#16a34a' : n < 0 ? '#dc2626' : '#64748b'
}

export default function QuickCount() {
  const navigate = useNavigate()

  // ===== 仓库选择 =====
  const [warehouseOptions, setWarehouseOptions] = useState<{ value: number; label: string }[]>([])
  const [selectedWarehouses, setSelectedWarehouses] = useState<number[]>([])
  const [warehouseLoading, setWarehouseLoading] = useState(false)

  // 加载仓库列表
  const loadWarehouses = useCallback(async () => {
    setWarehouseLoading(true)
    try {
      const res: any = await materialApi.listCountedWarehouses()
      // 库存检查不良仓不纳入快捷盘点,不显示在筛选下拉
      const options = (res.data || [])
        .filter((wh: any) => (wh.wh_name || '').trim() !== '库存检查不良仓')
        .map((wh: any) => ({
          value: wh.wh_id,
          label: wh.wh_name,
        }))
      setWarehouseOptions(options)
      // 默认选中赠品仓库（如果存在）
      const giftWarehouse = options.find((opt: any) => 
        opt.label.includes('赠品') || opt.label.toLowerCase().includes('gift')
      )
      if (giftWarehouse) {
        setSelectedWarehouses([giftWarehouse.value])
      }
    } catch {
      /* 静默 */
    } finally {
      setWarehouseLoading(false)
    }
  }, [])

  useEffect(() => { loadWarehouses() }, [])

  // ===== 搜索(输入即搜,防抖 300ms;回车立即搜索=扫码枪模式) =====
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<Candidate[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<InputRef>(null)
  // 最近一次搜索是否由回车触发(扫码枪): 保存后清空+重新聚焦,支持连续扫码
  const lastSearchByEnter = useRef(false)

  const doSearch = useCallback(async (kw: string) => {
    const q = kw.trim()
    if (!q) { setResults([]); setSearched(false); return }
    setSearching(true)
    setSearched(true)
    try {
      const params: any = { keyword: q, page: 1, page_size: 20 }
      // 如果选中了仓库，添加仓库筛选条件
      if (selectedWarehouses.length > 0) {
        params.wh_id = selectedWarehouses.join(',')
      }
      const res: any = await materialApi.listMaterialCandidates(params)
      setResults(res.data?.items || [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '搜索物料失败')
    } finally {
      setSearching(false)
    }
  }, [selectedWarehouses])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(keyword), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [keyword, selectedWarehouses]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearchEnter = useCallback(() => {
    // 回车=立即搜索(不等待防抖),并离开输入框 → 后续数字键 1/2/3 触发快捷盘点
    if (debounceRef.current) clearTimeout(debounceRef.current)
    lastSearchByEnter.current = true
    doSearch(keyword)
    inputRef.current?.blur()
  }, [keyword, doSearch])

  // ===== 今日已录 =====
  const [today, setToday] = useState<TodaySheet | null>(null)
  const [todayLoading, setTodayLoading] = useState(false)

  const loadToday = useCallback(async () => {
    setTodayLoading(true)
    try {
      const res: any = await materialApi.getTodayQuickCheck()
      setToday(res.data || null)
      if (res.data) setFinishedInfo(null)
    } catch {
      /* 静默 */
    } finally {
      setTodayLoading(false)
    }
  }, [])

  useEffect(() => { loadToday() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ===== 完结当日单 / 移除已录行 =====
  const [finishing, setFinishing] = useState(false)
  const [removingId, setRemovingId] = useState<number | null>(null)
  const [finishedInfo, setFinishedInfo] = useState<{ id: number; no: string } | null>(null)
  const [excelOpen, setExcelOpen] = useState(false)

  const finishToday = useCallback(async () => {
    if (!today) return
    setFinishing(true)
    try {
      const res: any = await materialApi.completeStockCheck(today.check_id)
      const ws = res.data?.writeback_summary
      if (ws && Number(ws.total) > 0) {
        if (Number(ws.failed) > 0) {
          message.warning(`单 ${today.check_no} 已完结；K3 单据回写失败 ${ws.failed}/${ws.total} 张，请在盘点工作台重试`, 6)
        } else if (Number(ws.success) < Number(ws.total)) {
          message.info(`单 ${today.check_no} 已完结；K3 单据回写未完成（${ws.success}/${ws.total}），请在盘点工作台查看`, 6)
        } else {
          message.success(`单 ${today.check_no} 已完结；已生成 K3 盘盈/盘亏单据 ${ws.success}/${ws.total} 张，待仓管员在 K3 审核`, 6)
        }
      } else {
        message.success(`单 ${today.check_no} 已完结，下次录入将开新单`)
      }
      setFinishedInfo({ id: today.check_id, no: today.check_no })
      setToday(null)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '完结失败')
    } finally {
      setFinishing(false)
    }
  }, [today])

  const removeItem = useCallback(async (id: number) => {
    setRemovingId(id)
    try {
      await materialApi.removeQuickCountItem(id)
      message.success('已移除该行')
      await loadToday()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '移除失败')
    } finally {
      setRemovingId(null)
    }
  }, [loadToday])

  // ===== 盘平/盘盈/盘亏 =====
  const [modal, setModal] = useState<{ row: Candidate | TodayItem; action: 'surplus' | 'deficit' | 'recount' } | null>(null)
  const [modalQty, setModalQty] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const doCount = useCallback(async (row: Candidate | TodayItem, actualQty: number) => {
    setSaving(true)
    try {
      const mid = 'erp_material_id' in row ? row.erp_material_id : row.material_id
      const res: any = await materialApi.quickCountStockCheck({
        material_id: mid!,
        wh_id: row.wh_id ?? null,
        actual_qty: actualQty,
      })
      const d = res.data || {}
      message.success(`已录入 ${d.check_no}：${d.item?.material_code ?? ''} 实盘 ${d.item?.actual_qty} 差异 ${d.item?.diff_qty}`)
      await loadToday()
      // 扫码模式(回车搜索): 清空并重新聚焦,直接扫下一件
      if (lastSearchByEnter.current) {
        lastSearchByEnter.current = false
        setKeyword('')
        setTimeout(() => inputRef.current?.focus(), 50)
      } else if (keyword.trim()) {
        // 刷新搜索结果,让刚盘过的物料显示"已盘"标记
        doSearch(keyword)
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e.message || '快捷盘点失败')
    } finally {
      setSaving(false)
    }
  }, [loadToday, keyword, doSearch])

  const openModal = useCallback((row: Candidate | TodayItem, action: 'surplus' | 'deficit' | 'recount') => {
    if (action === 'recount' && 'actual_qty' in row && row.actual_qty != null) {
      setModalQty(Number(row.actual_qty))
    } else {
      setModalQty(row.system_qty != null ? Number(row.system_qty) : null)
    }
    setModal({ row, action })
  }, [])

  // ===== 搜索结果选中行(↑↓ 换行,1/2/3 作用于选中行) =====
  const [selectedIdx, setSelectedIdx] = useState(0)
  useEffect(() => { setSelectedIdx(0) }, [results])

  // ===== 布局: 严格铺满窗口剩余高度,整页不出现窗口滚动条 =====
  // Content 容器自带 24px 底部 padding,可用高度 = innerHeight - rowTop - 24 - 4(余量)
  const headerRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<{ cardH: number; narrow: boolean }>({ cardH: 480, narrow: false })

  useEffect(() => {
    const measure = () => {
      const row = rowRef.current
      if (!row) return
      setLayout({
        narrow: window.innerWidth < 1200,
        cardH: Math.max(240, window.innerHeight - row.getBoundingClientRect().top - 28),
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (headerRef.current) ro.observe(headerRef.current)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // 选中行变化时,将其滚动进候选列表可视区(方向键换行时跟随)
  useEffect(() => {
    const body = rowRef.current?.querySelector('.qc-cand-list') as HTMLElement | null
    const row = body?.querySelector('.qc-sel') as HTMLElement | null
    if (!body || !row) return
    const b = body.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    if (r.top < b.top) body.scrollTop -= b.top - r.top
    else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom
  }, [selectedIdx, results])

  // 键盘快捷键: 搜索结果存在且未在输入时,↑↓ 换行,1=盘平 2=盘盈 3=盘亏(作用于选中行)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modal || saving || results.length === 0) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => e.key === 'ArrowDown'
          ? Math.min(i + 1, results.length - 1)
          : Math.max(i - 1, 0))
        return
      }
      const row = results[Math.min(selectedIdx, results.length - 1)]
      if (e.key === '1') {
        e.preventDefault()
        if (row.system_qty != null) doCount(row, sysOf(row) ?? 0)
      } else if (e.key === '2') {
        e.preventDefault()
        openModal(row, 'surplus')
      } else if (e.key === '3') {
        e.preventDefault()
        openModal(row, 'deficit')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal, saving, results, selectedIdx, doCount, openModal])

  const confirmModal = useCallback(async () => {
    if (!modal) return
    const sys = modal.row.system_qty != null ? Number(modal.row.system_qty) : null
    if (modalQty == null || sys == null) { message.warning('请输入实盘数'); return }
    if (modal.action === 'surplus' && modalQty <= sys) { message.warning(`盘盈要求实盘数大于库存数 ${sys}`); return }
    if (modal.action === 'deficit' && modalQty >= sys) { message.warning(`盘亏要求实盘数小于库存数 ${sys}`); return }
    const ctx = { ...modal }
    setModal(null)
    await doCount(ctx.row, modalQty)
  }, [modal, modalQty, doCount])

  const sysOf = (r: Candidate | TodayItem) => r.system_qty != null ? Number(r.system_qty) : null

  // 今日已录索引: (material_id, wh_id) → 已录行,用于候选卡"已盘"标记
  const todayItems = today?.items ?? []
  const countedMap = useMemo(() => {
    const m = new Map<string, TodayItem>()
    todayItems.forEach((it) => {
      if (it.material_id != null) m.set(`${it.material_id}-${it.wh_id ?? ''}`, it)
    })
    return m
  }, [todayItems])

  const stats = {
    even: todayItems.filter((it) => Number(it.diff_qty) === 0).length,
    surplus: todayItems.filter((it) => Number(it.diff_qty) > 0).length,
    deficit: todayItems.filter((it) => Number(it.diff_qty) < 0).length,
  }
  const diffSum = todayItems.reduce((s, it) => s + Number(it.diff_qty || 0), 0)
  const distinctMats = useMemo(
    () => new Set(todayItems.map((it) => it.material_id).filter((v) => v != null)).size,
    [todayItems],
  )

  const selIdx = Math.min(selectedIdx, Math.max(results.length - 1, 0))

  const renderCandidate = (r: Candidate, i: number) => {
    const ckey = `${r.erp_material_id}-${r.wh_id ?? ''}`
    const counted = countedMap.get(ckey)
    return (
      <div
        key={ckey}
        className={`qc-cand${i === selIdx ? ' qc-sel' : ''}`}
        onClick={() => setSelectedIdx(i)}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>
            {r.material_code}
            {counted && (
              <Tooltip title={`今日已盘：实盘 ${fmt2(counted.actual_qty)} · 差异 ${signQty(counted.diff_qty)}`}>
                <Tag color="success" style={{ marginLeft: 6, marginInlineEnd: 0, fontSize: 11, lineHeight: '18px' }}>已盘</Tag>
              </Tooltip>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.material_name}{r.spec_model ? ` · ${r.spec_model}` : ''} · {r.wh_name}
            {r.recent_checked_check_no && (
              <Tooltip title={`近期已盘 ${r.recent_checked_check_no}${r.recent_checked_date ? ' · ' + r.recent_checked_date : ''}`}>
                <Tag style={{ marginLeft: 6, marginInlineEnd: 0, fontSize: 11, lineHeight: '18px' }}>近期已盘</Tag>
              </Tooltip>
            )}
          </div>
        </div>
        <div style={{ width: 110, textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>库存数</div>
          <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtQty(r.system_qty)}</div>
        </div>
        <Space size={8} style={{ flexShrink: 0 }}>
          <Button
            style={CAND_BTN_EVEN} disabled={saving || r.system_qty == null}
            onClick={() => doCount(r, sysOf(r) ?? 0)}
          >平</Button>
          <Button
            style={CAND_BTN_SUR} disabled={saving}
            onClick={() => openModal(r, 'surplus')}
          >盈</Button>
          <Button
            style={CAND_BTN_DEF} disabled={saving}
            onClick={() => openModal(r, 'deficit')}
          >亏</Button>
        </Space>
      </div>
    )
  }

  const renderTodayRow = (t: TodayItem) => (
    <div key={t.id} className="qc-today-row">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <b style={{ fontSize: 13 }}>{t.material_code}</b>
        <span style={{ marginLeft: 'auto', fontWeight: 600, color: diffColor(t.diff_qty), fontVariantNumeric: 'tabular-nums' }}>
          {signQty(t.diff_qty)}
        </span>
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {fmt2(t.system_qty)} → {fmt2(t.actual_qty)} · {t.wh_name} · {t.counted_at ? new Date(t.counted_at).toLocaleString('zh-CN', { hour12: false }) : '—'}
      </div>
      <div style={{ marginTop: 4, display: 'flex', gap: 10 }}>
        <Button
          type="link" size="small" style={{ padding: 0, height: 'auto' }} disabled={saving}
          onClick={() => openModal(t, 'recount')}
        >重录</Button>
        <Popconfirm
          title="移除该行？"
          description="移除后不可恢复"
          onConfirm={() => removeItem(t.id)}
          disabled={removingId != null}
        >
          <Button
            type="link" size="small" style={{ padding: 0, height: 'auto', color: '#dc2626' }}
            loading={removingId === t.id} disabled={removingId != null && removingId !== t.id}
          >移除</Button>
        </Popconfirm>
      </div>
    </div>
  )

  return (
    <div>
      {/* ===== 顶栏: 标题 + 今日统计 + 完结 ===== */}
      <div ref={headerRef} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/stock-check')}>返回</Button>
        <span style={{
          width: 30, height: 30, borderRadius: 8, color: '#fff', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'linear-gradient(135deg,#fbbf24,#f59e0b)',
        }}><ThunderboltOutlined /></span>
        <Typography.Title level={5} style={{ margin: 0 }}>快捷盘点</Typography.Title>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {todayItems.length > 0 && (
            <>
              <StatPill>平 {stats.even}</StatPill>
              <StatPill tone="g">盈 {stats.surplus}</StatPill>
              <StatPill tone="r">亏 {stats.deficit}</StatPill>
              <StatPill tone="b">差 {diffSum > 0 ? '+' : ''}{diffSum.toFixed(2)}</StatPill>
            </>
          )}
          {today && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{today.check_no}</Typography.Text>
          )}
          {!today && finishedInfo && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已完结 {finishedInfo.no} ·{' '}
              <Typography.Link onClick={() => navigate(`/stock-check?checkId=${finishedInfo.id}`)}>查看</Typography.Link>
            </Typography.Text>
          )}
          <Button icon={<FileExcelOutlined />} onClick={() => setExcelOpen(true)} disabled={finishing}>
            Excel导入
          </Button>
          <Popconfirm
            title="完结本单？"
            description="完结后本单锁定，下次录入自动开新单"
            onConfirm={finishToday}
            disabled={todayItems.length === 0 || finishing}
          >
            <Button type="primary" ghost disabled={todayItems.length === 0} loading={finishing}>
              完结本单
            </Button>
          </Popconfirm>
        </div>
      </div>

      {/* ===== 方案A 聚焦流式: 左侧大搜索+候选卡片流, 右侧窄栏收纳今日已录(整体收敛于视口,无窗口滚动条) ===== */}
      <div
        ref={rowRef}
        style={{
          display: 'flex', gap: 16, overflow: 'hidden',
          flexDirection: layout.narrow ? 'column' : 'row',
          height: layout.cardH,
        }}
      >
        <div style={{
          flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div className="card-modern" style={{ padding: '14px 16px', flexShrink: 0 }}>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>仓库筛选</div>
              <Select
                mode="multiple"
                style={{ width: '100%' }}
                placeholder="选择仓库筛选物料"
                loading={warehouseLoading}
                options={warehouseOptions}
                value={selectedWarehouses}
                onChange={setSelectedWarehouses}
                allowClear
                maxTagCount="responsive"
              />
            </div>
            <Input
              ref={inputRef}
              size="large"
              autoFocus
              style={{ height: 48, fontSize: 15, borderRadius: 10 }}
              placeholder="扫码 / 输入物料编码·名称·规格，回车立即搜索"
              value={keyword}
              onChange={(e) => { lastSearchByEnter.current = false; setKeyword(e.target.value) }}
              onPressEnter={handleSearchEnter}
              allowClear
              prefix={<SearchOutlined />}
            />
            <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
              <Typography.Text keyboard>↑</Typography.Text>
              <Typography.Text keyboard>↓</Typography.Text> 选行 ·{' '}
              <Typography.Text keyboard>1</Typography.Text> 平 ·{' '}
              <Typography.Text keyboard>2</Typography.Text> 盈 ·{' '}
              <Typography.Text keyboard>3</Typography.Text> 亏
            </div>
          </div>

          <div
            className="card-modern qc-results"
            style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            <Spin spinning={searching}>
              <div
                className="qc-cand-list"
                style={{
                  flex: 1, minHeight: 0, overflow: 'auto', padding: 8,
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}
              >
                {results.length > 0
                  ? results.map(renderCandidate)
                  : (
                    <div style={{ padding: '48px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                      {searched ? '无匹配物料' : '输入关键词搜索物料'}
                    </div>
                  )}
              </div>
            </Spin>
          </div>
        </div>

        <div
          className="card-modern"
          style={{
            width: layout.narrow ? '100%' : 330,
            flex: layout.narrow ? '0 0 36%' : undefined,
            flexShrink: 0,
            minHeight: 0,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid #e2e8f0', flexShrink: 0 }}>
            <b style={{ fontSize: 14 }}>今日已录 · {todayItems.length} 行 · {distinctMats} 种物料</b>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>重复录入会覆盖上次结果</div>
          </div>
          <div className="qc-today-list" style={{ flex: 1, overflow: 'auto', padding: 6 }}>
            {todayLoading ? (
              <div style={{ padding: '48px 0', textAlign: 'center' }}><Spin /></div>
            ) : todayItems.length > 0 ? (
              todayItems.map(renderTodayRow)
            ) : (
              <div style={{ padding: '48px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>今日暂无快捷盘点记录</div>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={!!modal}
        title={modal?.action === 'surplus' ? '盘盈 — 录入实盘数'
          : modal?.action === 'deficit' ? '盘亏 — 录入实盘数'
            : '重录 — 输入实盘数'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={confirmModal}
        onCancel={() => setModal(null)}
        destroyOnClose
      >
        {modal && (
          <div>
            <p style={{ marginBottom: 8 }}>
              {modal.row.material_code} · {modal.row.material_name} · {modal.row.wh_name}
            </p>
            <p style={{ marginBottom: 8, color: '#64748b' }}>
              库存数 {modal.row.system_qty != null ? Number(modal.row.system_qty) : '—'}
              {modal.action === 'surplus' ? '，实盘数需大于库存数（盘盈）'
                : modal.action === 'deficit' ? '，实盘数需小于库存数（盘亏）'
                  : '，输入新的实盘数覆盖上次结果'}
            </p>
            <InputNumber
              min={0}
              step={0.01}
              value={modalQty}
              onChange={(v) => setModalQty(v == null ? null : Number(v))}
              onPressEnter={confirmModal}
              style={{ width: 200 }}
              addonAfter="实盘数"
              autoFocus
              onFocus={(e) => e.target.select()}
            />
          </div>
        )}
      </Modal>

      <ExcelImportModal
        open={excelOpen}
        onClose={() => setExcelOpen(false)}
        onImported={loadToday}
      />
    </div>
  )
}
