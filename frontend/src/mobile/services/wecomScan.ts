import { wecomApi } from '@/services/api'

// 企微 JSSDK：res.wx.qq.com/open/js/jweixin-1.2.0.js 同时覆盖公众号与企微 H5，
// 加载后挂载全局 `wx` 对象（与 WeCom 文档一致）。
const WECOM_JSSDK_URL = 'https://res.wx.qq.com/open/js/jweixin-1.2.0.js'

interface WxConfigPayload {
  appId: string
  timestamp: number
  nonceStr: string
  signature: string
  jsApiList: string[]
}

interface WxScanResult {
  resultStr: string
}

declare global {
  interface Window {
    wx?: {
      config: (cfg: WxConfigPayload) => void
      ready: (cb: () => void) => void
      error: (cb: (err: { errMsg: string }) => void) => void
      scanQRCode: (cfg: {
        needResult: 0 | 1
        scanType: ('qrCode' | 'barCode')[]
        success?: (res: WxScanResult) => void
        fail?: (err: { errMsg: string }) => void
      }) => void
    }
  }
}

export function isInWecom(): boolean {
  if (typeof navigator === 'undefined') return false
  return navigator.userAgent.toLowerCase().includes('wxwork')
}

let sdkLoadingPromise: Promise<void> | null = null

export function loadWecomJSSDK(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR no window'))
  if (window.wx) return Promise.resolve()
  if (sdkLoadingPromise) return sdkLoadingPromise
  sdkLoadingPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = WECOM_JSSDK_URL
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      sdkLoadingPromise = null
      reject(new Error('企业微信 JSSDK 加载失败'))
    }
    document.head.appendChild(s)
  })
  return sdkLoadingPromise
}

export async function wxConfig(currentUrl: string): Promise<void> {
  await loadWecomJSSDK()
  const res: any = await wecomApi.jsapiConfig(currentUrl)
  const cfg: WxConfigPayload = res.data
  return new Promise<void>((resolve, reject) => {
    if (!window.wx) {
      reject(new Error('wx 未挂载'))
      return
    }
    window.wx.config({
      appId: cfg.appId,
      timestamp: cfg.timestamp,
      nonceStr: cfg.nonceStr,
      signature: cfg.signature,
      jsApiList: cfg.jsApiList,
    })
    window.wx.ready(() => resolve())
    window.wx.error((err) => reject(new Error(err?.errMsg || 'wx.config 失败')))
  })
}

// 拉起企微原生扫一扫；needResult=1 时用户确认扫码 → success 回调；用户取消 → 视为 null。
// WeCom 客户端内 H5 不会回调 fail，故不做超时取消（用户取消 = UI 直接关闭）。
export function scanViaWecom(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (!window.wx?.scanQRCode) {
      reject(new Error('wx.scanQRCode 不可用，请先调用 wxConfig'))
      return
    }
    try {
      window.wx.scanQRCode({
        needResult: 1,
        scanType: ['qrCode', 'barCode'],
        success: (res) => resolve(res.resultStr || null),
        fail: () => resolve(null),
      })
    } catch (e) {
      reject(e)
    }
  })
}

export function currentJsapiUrl(): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}${window.location.pathname}${window.location.search}`
}