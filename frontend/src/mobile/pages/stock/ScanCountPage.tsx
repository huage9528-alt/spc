import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Toast } from 'antd-mobile'
import type { Html5Qrcode } from 'html5-qrcode'
import { materialApi } from '@/services/api'
import {
  currentJsapiUrl,
  isInWecom,
  scanViaWecom,
  wxConfig,
} from '../../services/wecomScan'
import NavBarSimple from '../../components/NavBarSimple'
import DigitPad from '../../components/DigitPad'
import MIcon from '../../components/MIcon'
import MDialog from '../../components/MDialog'

interface ScanWh { wh_id: number; wh_code?: string | null; wh_name?: string | null }
interface ResolvedWh extends ScanWh { system_qty?: number | null }
interface Resolved {
  erp_material_id: number
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  resolved_by?: string | null
  wh_id?: number | null
  wh_code?: string | null
  wh_name?: string | null
  system_qty?: number | null
  warehouses?: ResolvedWh[] | null
}
interface Today { check_id: number; check_no?: string | null; items?: Array<{ id: number }> | null }

const WH_STORE_KEY = 'm_scan_wh'

function fmtQty(v: number | null | undefined): string {
  if (v == null) return '—'
  const n = Number(v)
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

export default function ScanCountPage() {
  const navigate = useNavigate()
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const whIdRef = useRef<number | null>(null)
  const lastHitRef = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const resolvingRef = useRef(false)

  const [whList, setWhList] = useState<ScanWh[]>([])
  const [whId, setWhId] = useState<number | null>(null)
  const [whPicking, setWhPicking] = useState(false)
  const [camRequested, setCamRequested] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [mat, setMat] = useState<Resolved | null>(null)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [today, setToday] = useState<Today | null>(null)
  const [camState, setCamState] = useState<'init' | 'on' | 'error'>('init')

  // 企微内置 H5：getUserMedia 视频流可显示但不可解码，必须走 wx.scanQRCode JSAPI
  const [scanMode, setScanMode] = useState<'camera' | 'wecom' | null>(null)
  const [wecomReady, setWecomReady] = useState(false)
  const [wecomInitializing, setWecomInitializing] = useState(false)
  const [wecomScanning, setWecomScanning] = useState(false)
  const [wecomError, setWecomError] = useState<string | null>(null)
  const [continuous, setContinuous] = useState(false)

  useEffect(() => { whIdRef.current = whId }, [whId])

  useEffect(() => {
    void (async () => {
      try {
        const [w, t]: any[] = await Promise.all([
          materialApi.listScanWarehouses(),
          materialApi.getTodayQuickCheck(),
        ])
        const list: ScanWh[] = w.data || []
        setWhList(list)
        // localStorage 缺省时 Number(null)===0，而库里真实存在 wh_id=0 的仓库，须显式判空
        const raw = localStorage.getItem(WH_STORE_KEY)
        const saved = raw == null || raw === '' ? null : Number(raw)
        setWhId(saved != null && list.some((x) => x.wh_id === saved) ? saved : list[0]?.wh_id ?? null)
        setToday(t.data)
        // 进页先弹仓库选择，选中(用户手势)后再开摄像头，避免 iOS 无手势时相机黑屏/不弹权限
        if (list.length > 0) setWhPicking(true)
      } catch {
        /* 拦截器已 toast */
      }
    })()
  }, [])

  // 探测运行环境：企微内置 H5 → 走 wx.scanQRCode；其它 → 走 html5-qrcode
  useEffect(() => {
    if (!isInWecom()) {
      setScanMode('camera')
      return
    }
    setScanMode('wecom')
    setWecomInitializing(true)
    wxConfig(currentJsapiUrl())
      .then(() => setWecomReady(true))
      .catch((e) => {
        const msg = e?.message || '企微扫一扫初始化失败'
        // 后端签名 endpoint 503/超时 / JSSDK 加载失败 都归到 wecomError；
        // axios 拦截器已 toast 通用网络错误，这里只显示 JSAPI 域相关提示。
        setWecomError(msg.includes('网络') ? `${msg}\n（首次调用需后端向企微拉取 ticket，若长时间未恢复请联系管理员）` : msg)
      })
      .finally(() => setWecomInitializing(false))
  }, [])

  // 摄像头生命周期：选完仓库(camRequested)才启动、卸载释放；解码回调只走 ref，避免闭包过期
  useEffect(() => {
    if (!camRequested) return
    let stopped = false
    let startPromise: Promise<unknown> | null = null
    void (async () => {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode')
        if (stopped) return
        const scanner = new Html5Qrcode('scan-viewport', {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.QR_CODE,
          ],
          verbose: false,
        })
        scannerRef.current = scanner
        startPromise = scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 160 } },
          (text) => { void handleCode(text) },
          () => { /* 每帧未识别,忽略 */ },
        )
        await startPromise
        if (!stopped) setCamState('on')
      } catch {
        if (!stopped) setCamState('error')
      }
    })()
    return () => {
      stopped = true
      const sc = scannerRef.current
      scannerRef.current = null
      if (sc) {
        // html5-qrcode 的 stop() 在启动未完成时会同步抛错；等 start 落定后再停，避免摄像头流泄漏
        Promise.resolve(startPromise)
          .catch(() => {})
          .then(() => {
            try {
              void sc.stop().then(() => sc.clear()).catch(() => {})
            } catch { /* 已释放则忽略 */ }
          })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camRequested])

  function resumeCamera() {
    const sc = scannerRef.current
    if (!sc) return
    // 库的 resume() 类型声明为 void(运行时实际返回 Promise)，用 Promise.resolve 统一接住拒绝
    try { Promise.resolve(sc.resume()).catch(() => {}) } catch { /* camera 已释放则忽略 */ }
  }

  // 弹窗里选中仓库 → 记住选择并立刻启动摄像头扫码（WeCom 环境下不启摄像头，等用户点扫一扫）
  function confirmWh(w: ScanWh) {
    pickWh(w)
    setWhPicking(false)
    if (scanMode !== 'wecom') setCamRequested(true)
  }

  function clearCard() {
    setMat(null)
    setValue('')
    if (scanMode === 'camera') resumeCamera()
  }

  async function doWecomScan() {
    if (!wecomReady || wecomScanning) return
    setWecomScanning(true)
    try {
      const text = await scanViaWecom()
      if (text) await handleCode(text)
    } catch (e: any) {
      Toast.show({ icon: 'fail', content: e?.message || '企微扫一扫失败' })
    } finally {
      setWecomScanning(false)
    }
  }

  // 连续扫码：扫完一张且卡片关闭后，自动再拉起企微扫一扫
  useEffect(() => {
    if (scanMode !== 'wecom' || !continuous || !wecomReady) return
    if (mat || wecomScanning) return
    void doWecomScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mat, continuous, wecomReady, scanMode])

  async function handleCode(raw: string) {
    const code = raw.trim()
    if (!code || resolvingRef.current) return
    const now = Date.now()
    if (lastHitRef.current.code === code && now - lastHitRef.current.at < 2000) return
    lastHitRef.current = { code, at: now }
    resolvingRef.current = true
    setResolving(true)
    try { scannerRef.current?.pause(true) } catch { /* ignore */ }
    navigator.vibrate?.(50)
    try {
      const res: any = await materialApi.resolveStockCheckCode(code, whIdRef.current)
      setMat(res.data)
      setValue('')
    } catch {
      resumeCamera()
    } finally {
      resolvingRef.current = false
      setResolving(false)
    }
  }

  function pickWh(w: ScanWh | ResolvedWh) {
    setWhId(w.wh_id)
    whIdRef.current = w.wh_id
    localStorage.setItem(WH_STORE_KEY, String(w.wh_id))
    setMat((m) => {
      if (!m) return m
      // 优先用解析结果里该仓库的真实库存；仓库无库存行时按后端口径记 0
      const known = (m.warehouses || []).find((x) => x.wh_id === w.wh_id)
      const sys = known?.system_qty ?? (w as ResolvedWh).system_qty ?? 0
      return {
        ...m,
        wh_id: w.wh_id,
        wh_code: (w as ResolvedWh).wh_code ?? known?.wh_code ?? null,
        wh_name: w.wh_name ?? known?.wh_name ?? null,
        system_qty: sys,
      }
    })
  }

  const diff = useMemo(() => {
    if (!mat || mat.system_qty == null || value === '' || isNaN(Number(value))) return null
    return Math.round((Number(value) - Number(mat.system_qty)) * 100) / 100
  }, [mat, value])

  // 后端口径(quick_count_material): wh_id≠null 且该物料在此仓库无库存行时无法快捷盘点。
  // warehouses 列表 = 该物料有库存行的仓库，故扫码/切仓时即可预判，不等保存才报错。
  const noStockRow =
    mat != null && whId != null && !(mat.warehouses || []).some((w) => w.wh_id === whId)

  async function refreshToday() {
    try {
      const res: any = await materialApi.getTodayQuickCheck()
      setToday(res.data)
    } catch { /* ignore */ }
  }

  async function save() {
    if (!mat) return
    // 注意用 == null 判空：库里存在真实的 wh_id=0(线边仓)，!whId 会误判
    if (whId == null) {
      Toast.show('请先在顶部选择仓库')
      return
    }
    if (noStockRow) {
      Toast.show({ icon: 'fail', content: '该物料在此仓库无库存行，无法快捷盘点' })
      return
    }
    if (value === '' || isNaN(Number(value)) || Number(value) < 0) {
      Toast.show('请输入有效数量')
      return
    }
    setSaving(true)
    try {
      const res: any = await materialApi.quickCountStockCheck({
        material_id: mat.erp_material_id,
        wh_id: whId,
        actual_qty: Number(value),
      })
      const d = res.data?.item ? Number(res.data.item.diff_qty) : null
      Toast.show({
        icon: 'success',
        content: d == null ? '已保存' : `已保存 · 差异 ${d > 0 ? '+' : ''}${fmtQty(d)}`,
      })
      setMat(null)
      setValue('')
      resumeCamera()
      void refreshToday()
    } catch {
      /* 拦截器已 toast，保留卡片供重试 */
    } finally {
      setSaving(false)
    }
  }

  const todayCount = today?.items?.length ?? 0

  return (
    <div className="m-page m-page--full scan-page">
      <NavBarSimple title="扫码盘点" onBack={() => navigate(-1)} />

      <div className="m-page__scroll">
        <div className="m-card scan-wh">
          <span className="scan-wh__label">仓库</span>
          {whList.length > 0 ? (
            <select
              className="scan-wh__sel"
              value={whId ?? ''}
              onChange={(e) => {
                const w = whList.find((x) => x.wh_id === Number(e.target.value))
                if (w) pickWh(w)
              }}
            >
              {whList.map((w) => (
                <option key={w.wh_id} value={w.wh_id}>
                  {w.wh_name || w.wh_code || `WH#${w.wh_id}`}
                </option>
              ))}
            </select>
          ) : (
            <span className="scan-wh__empty">暂无仓库数据</span>
          )}
        </div>

        {scanMode === 'wecom' ? (
          <div className="m-card scan-cam scan-cam--wecom">
            <div className="scan-cam__idle">
              <MIcon name="scan" size={26} />
              {wecomInitializing && <div>企微扫一扫初始化中…</div>}
              {wecomError && (
                <div className="scan-cam__err">
                  <MIcon name="warn" size={26} />
                  <div>{wecomError}<br />请确认企微管理后台已为本应用配置 JSAPI 域名。</div>
                </div>
              )}
              {wecomReady && !wecomError && (
                <>
                  <button
                    className="scan-cam__scanbtn"
                    onClick={() => void doWecomScan()}
                    disabled={wecomScanning}
                  >
                    <MIcon name="scan" size={18} />
                    <span>{wecomScanning ? '已调起企微扫一扫…' : '点击调起企微扫一扫'}</span>
                  </button>
                  <label className="scan-cam__continuous">
                    <input
                      type="checkbox"
                      checked={continuous}
                      onChange={(e) => setContinuous(e.target.checked)}
                    />
                    <span>连续扫码（每扫完一张自动再拉起）</span>
                  </label>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="m-card scan-cam">
            <div id="scan-viewport" className={`scan-cam__viewport ${!camRequested || camState === 'error' ? 'scan-cam__hide' : ''}`} />
            {!camRequested && (
              <button
                className="scan-cam__idle"
                onClick={() => (whList.length > 0 ? setWhPicking(true) : Toast.show('暂无仓库数据'))}
              >
                <MIcon name="scan" size={26} />
                <div>点击选择仓库，开启摄像头扫码</div>
              </button>
            )}
            {camRequested && camState === 'init' && <div className="scan-cam__tip scan-cam__tip--overlay">相机启动中…</div>}
            {camRequested && camState === 'error' && (
              <div className="scan-cam__err">
                <MIcon name="warn" size={26} />
                <div>相机不可用（需 HTTPS 并授权摄像头）。请用下方手动输入编码。</div>
              </div>
            )}
            {resolving && <div className="scan-cam__tip scan-cam__tip--overlay">识别中…</div>}
          </div>
        )}

        <div className="m-card scan-manual">
          <input
            className="scan-manual__input"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const c = manualCode.trim()
                if (c) {
                  void handleCode(c)
                  setManualCode('')
                }
              }
            }}
            placeholder="手动输入 / 扫码枪输入物料编码"
            enterKeyHint="done"
          />
        </div>

        {mat && (
          <div className="m-card scan-mat">
            <button className="scan-mat__close" onClick={clearCard}>
              <MIcon name="close" size={16} />
            </button>
            <div className="scan-mat__code">
              {mat.material_code}
              {mat.resolved_by === 'sku_barcode' && <span className="m-chip m-chip--progress">条码</span>}
            </div>
            <div className="scan-mat__name">{mat.material_name || '—'}</div>
            <div className="scan-mat__spec">
              {[mat.spec_model, mat.unit ? `单位 ${mat.unit}` : null].filter(Boolean).join(' · ')}
            </div>
            {noStockRow ? (
              <div className="scan-mat__sys scan-mat__sys--err">
                该物料在此仓库无库存行，无法快捷盘点
                {mat.warehouses && mat.warehouses.length > 0 ? '（点下方仓库切换）' : ''}
              </div>
            ) : mat.system_qty != null ? (
              <div className="scan-mat__sys">
                系统数 <b>{fmtQty(mat.system_qty)}</b>
                {mat.wh_name ? `（${mat.wh_name}）` : ''}
              </div>
            ) : (
              <div className="scan-mat__sys scan-mat__sys--warn">未选仓库，保存前请选择</div>
            )}
            {mat.warehouses && (mat.warehouses.length > 1 || noStockRow) && (
              <div className="scan-mat__whs">
                {mat.warehouses.map((w) => (
                  <button
                    key={w.wh_id}
                    className={`scan-whchip${w.wh_id === whId ? ' on' : ''}`}
                    onClick={() => pickWh(w)}
                  >
                    {w.wh_name || w.wh_code}
                  </button>
                ))}
              </div>
            )}
            <div className="scan-mat__qty">
              实盘{mat.unit ? `（${mat.unit}）` : ''} <b className="scan-mat__num">{value === '' ? '—' : value}</b>
              {diff != null && (
                <span className={`m-chip ${diff === 0 ? 'm-chip--zero' : diff > 0 ? 'm-chip--pos' : 'm-chip--neg'}`}>
                  {diff === 0 ? '±0' : `${diff > 0 ? '+' : ''}${fmtQty(diff)}`}
                </span>
              )}
            </div>
          </div>
        )}

        <button
          className="m-card scan-today"
          onClick={() => {
            if (today?.check_id) navigate(`/stock-check/${today.check_id}`)
            else Toast.show('今天还没有快捷盘点记录')
          }}
        >
          <span>今日已盘 <b>{todayCount}</b> 条</span>
          {today?.check_no && <span className="scan-today__no">{today.check_no}</span>}
          <MIcon name="chev" size={16} />
        </button>
      </div>

      {mat ? (
        <DigitPad value={value} onChange={setValue} onSubmit={() => void save()} disabled={saving} />
      ) : (
        <div className="scan-idle">扫码或输入编码后录入实盘数</div>
      )}

      <MDialog visible={whPicking} title="选择盘点仓库" onClose={() => setWhPicking(false)}>
        <div className="scan-pick">
          {whList.map((w) => (
            <button
              key={w.wh_id}
              className={`scan-pick__item${w.wh_id === whId ? ' on' : ''}`}
              onClick={() => confirmWh(w)}
            >
              <span className="scan-pick__name">{w.wh_name || w.wh_code || `WH#${w.wh_id}`}</span>
              {w.wh_name && w.wh_code ? <span className="scan-pick__code">{w.wh_code}</span> : null}
            </button>
          ))}
        </div>
      </MDialog>
    </div>
  )
}
