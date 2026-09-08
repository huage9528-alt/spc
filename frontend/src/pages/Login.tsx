import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import { Form, Input, Button, Spin, message, Switch } from 'antd'
import {
  UserOutlined,
  LockOutlined,
  FileDoneOutlined,
  DatabaseOutlined,
  ToolOutlined,
  SafetyCertificateOutlined,
  ApiOutlined,
} from '@ant-design/icons'
import { authApi, REDIRECT_AFTER_LOGIN_KEY } from '../services/api'
import { useAuthStore } from '../store/auth'
import { SUPPLIER_PORTAL_PATHS } from '../constants/permissions'

type LoginType = 'employee' | 'supplier'
type LoginMode = 'password' | 'qr'

interface LoginFormValues {
  username: string
  password: string
}

interface WecomQrConfig {
  enabled: boolean
  corp_id: string
  agent_id: string
  state: string
}

const WECOM_STATE_KEY = 'wecom_login_state'

function genWecomState(): string {
  const s = Math.random().toString(36).slice(2) + Date.now().toString(36)
  try {
    sessionStorage.setItem(WECOM_STATE_KEY, s)
  } catch {
    // sessionStorage 不可用时退化为不校验
  }
  return s
}

function consumeWecomState(returned: string | null | undefined): boolean {
  let saved: string | null = null
  try {
    saved = sessionStorage.getItem(WECOM_STATE_KEY)
    sessionStorage.removeItem(WECOM_STATE_KEY)
  } catch {
    // ignore
  }
  return !!returned && !!saved && returned === saved
}

const PATH_TO_PERMISSION: Record<string, string> = {
  '/purchase-plan': 'materials.purchase_plan',
  '/long-lead-materials': 'materials.long_lead',
  '/supplier-risk': 'materials.supplier_risk',
  '/supplier-payment': 'materials.supplier_payment',
}

const LOGIN_TYPE_OPTIONS: Array<{ label: string; value: LoginType }> = [
  { label: '员工登录', value: 'employee' },
  { label: '供应商登录', value: 'supplier' },
]

const LOGIN_FEATURES: Array<{ icon: ReactNode; label: string }> = [
  { icon: <FileDoneOutlined />, label: '订单总控' },
  { icon: <DatabaseOutlined />, label: '物料协同' },
  { icon: <ToolOutlined />, label: '生产排程' },
  { icon: <SafetyCertificateOutlined />, label: '质量闭环' },
  { icon: <ApiOutlined />, label: '系统集成' },
]

function QrCornerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 14h3v3h-3z" />
      <path d="M20 14v1" />
      <path d="M14 20h1" />
      <path d="M18 18h3v3h-3z" />
    </svg>
  )
}

function WecomQrPanel({ config }: { config: WecomQrConfig }) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    if (!config.enabled || !config.corp_id || !config.agent_id) return
    // 自渲染企微纯二维码页（不引入 createWWLoginPanel，避免桌面端 localhost 检测）。
    // state nonce 随 URL 带出，扫码确认后顶层跳回 /login?code=&state= 由既有回调校验。
    const params = new URLSearchParams({
      login_type: 'CorpApp',
      appid: config.corp_id,
      agentid: config.agent_id,
      redirect_uri: `${window.location.origin}/login`,
      state: genWecomState(),
      lang: 'zh',
    })
    setSrc(`https://login.work.weixin.qq.com/wwlogin/sso/login?${params.toString()}`)
  }, [config])

  if (!src) return null

  return (
    <div className="lb-qr-view">
      <div id="wecom-qr-container">
        <iframe src={src} title="企业微信扫码登录" scrolling="no" />
      </div>
      <p className="qr-tag">
        仅支持已绑定的内部员工
        <br />
        点击右上角返回密码登录
      </p>
    </div>
  )
}

export default function Login() {
  const [form] = Form.useForm<LoginFormValues>()
  const [loading, setLoading] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [qrConfig, setQrConfig] = useState<WecomQrConfig | null>(null)
  const [loginType, setLoginType] = useState<LoginType>('employee')
  const [loginMode, setLoginMode] = useState<LoginMode>('password')
  const [rememberMe, setRememberMe] = useState(false)
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const currentToken = useAuthStore((s) => s.currentToken)
  const [searchParams] = useSearchParams()
  const location = useLocation()
  // 登录后回跳：优先取路由 state（PrivateRoute 透传），其次取 sessionStorage（401 全页刷新场景），最后兜底首页
  const from =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname
    || (() => { try { return sessionStorage.getItem(REDIRECT_AFTER_LOGIN_KEY) } catch { return null } })()
    || ''
  useEffect(() => {
    try { sessionStorage.removeItem(REDIRECT_AFTER_LOGIN_KEY) } catch {}
  }, [])
  const code = searchParams.get('code')
  const isInWecom =
    typeof navigator !== 'undefined' &&
    navigator.userAgent.toLowerCase().includes('wxwork')

  // 企微 code → JWT → 登录（扫码 onLoginSuccess 与静默 OAuth ?code= 回调共用）
  const loginWithWecomCode = useCallback(async (wecomCode: string, opts?: { clearUrl?: boolean }) => {
    setLoggingIn(true)
    try {
      // 渠道区分：企微客户端内 = wecom 渠道，浏览器扫码 = web 渠道（与账密登录互斥）
      const channel = isInWecom ? 'wecom' : 'web'
      const res: any = await authApi.wecomLogin(wecomCode, channel)
      const token = res.data.access_token
      useAuthStore.getState().setAuth(token, null)
      const meRes: any = await authApi.getMe()
      setAuth(token, meRes.data)
      message.success('登录成功')
      navigate(from || '/dashboard', { replace: true })
    } catch {
      // /wecom-login 失败由全局拦截器 toast；此处仅结束 loading
    } finally {
      setLoggingIn(false)
      if (opts?.clearUrl) window.history.replaceState({}, '', window.location.pathname)
    }
  }, [setAuth, navigate, from, isInWecom])

  // PC 浏览器：拉取扫码配置（企微客户端内不需要）
  useEffect(() => {
    if (isInWecom) return
    let cancelled = false
    ;(async () => {
      try {
        const res: any = await authApi.wecomQrConfig()
        if (!cancelled) setQrConfig((res?.data ?? null) as WecomQrConfig | null)
      } catch {
        // 企微未配置或网络异常：静默，保持纯账密
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isInWecom])

  // 静默 OAuth 回调：?code= → 校验 state nonce → 换 JWT
  useEffect(() => {
    if (!code) return
    if (!consumeWecomState(searchParams.get('state'))) {
      message.error('登录状态校验失败，请重新登录')
      window.history.replaceState({}, '', window.location.pathname)
      return
    }
    loginWithWecomCode(code, { clearUrl: true })
  }, [code, searchParams, loginWithWecomCode])

  // 企微客户端内：无 code 且未登录时静默跳转 OAuth
  useEffect(() => {
    if (code || !isInWecom || currentToken) return
    ;(async () => {
      try {
        const state = genWecomState()
        const res: any = await authApi.wecomOauthUrl(state)
        const url = res?.data?.oauth_url
        if (url) window.location.href = url
      } catch {
        // 企微未配置等：静默，保留账密表单
      }
    })()
  }, [code, isInWecom, currentToken])

  // 已登录用户访问 /login：自动跳转（OAuth ?code= 回调中途除外）
  useEffect(() => {
    if (!currentToken || code) return
    if (useAuthStore.getState().isSupplierUser()) {
      const firstAllowedPath = SUPPLIER_PORTAL_PATHS.find((path) => {
        const permission = PATH_TO_PERMISSION[path]
        return permission && useAuthStore.getState().hasPermission(permission, 'read')
      })
      navigate(firstAllowedPath || '/purchase-plan', { replace: true })
    } else {
      navigate(from || '/dashboard', { replace: true })
    }
  }, [currentToken, code, from, navigate])

  const onFinish = async (values: LoginFormValues) => {
    setLoading(true)
    try {
      // 渠道区分：企微客户端内 = wecom 渠道，浏览器 = web 渠道（同渠道互斥、跨渠道并存）
      const channel = isInWecom ? 'wecom' : 'web'
      const res: any = await authApi.login(values.username, values.password, loginType, channel, rememberMe)
      const token = res.data.access_token

      useAuthStore.getState().setAuth(token, null)
      const meRes: any = await authApi.getMe()
      const user = meRes.data
      const isSupplierAccount = user?.role_code === 'supplier'
      if (loginType === 'supplier' && !isSupplierAccount) {
        useAuthStore.getState().logout()
        message.warning('当前为内部员工账号，请切换到员工登录')
        return
      }
      if (loginType === 'employee' && isSupplierAccount) {
        useAuthStore.getState().logout()
        message.warning('当前为供应商账号，请切换到供应商登录')
        return
      }

      setAuth(token, user)
      message.success('登录成功')
      if (isSupplierAccount) {
        const firstAllowedPath = SUPPLIER_PORTAL_PATHS.find(path => {
          const permission = PATH_TO_PERMISSION[path]
          return permission && useAuthStore.getState().hasPermission(permission, 'read')
        })
        navigate(firstAllowedPath || '/purchase-plan')
      } else {
        navigate(from || '/dashboard', { replace: true })
      }
    } catch (error: any) {
      message.error(error?.message || '登录失败，请检查用户名和密码')
    } finally {
      setLoading(false)
    }
  }

  const showQr = !isInWecom && !!qrConfig?.enabled

  return (
    <div className="lb-page">
      {/* 左：系统简介 + 功能图标 */}
      <div className="lb-intro">
        <div className="lb-brand">
          <div className="lb-logo">SPC</div>
          <div className="lb-name">SPC SUPPLY CHAIN</div>
        </div>
        <h1 className="lb-h1">供应链中台</h1>
        <div className="lb-slogan">从订单到交付，让每一张订单准时闭环</div>
        <p className="lb-desc">
          数据驱动的一体化供应链协同平台，覆盖订单、物料、生产、质量与系统集成，
          让计划、采购与制造在同一条数据链路上协同运转。
        </p>
        <div className="lb-features">
          {LOGIN_FEATURES.map((feature) => (
            <div key={feature.label} className="lb-feature">
              <span className="ic">{feature.icon}</span>
              <span className="k">{feature.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 右：登录卡片（单卡两态：密码 / 扫码） */}
      <div className="lb-right">
        <div className="lb-card">
          {showQr && (
            <button
              type="button"
              className={`lb-qr-toggle${loginMode === 'qr' ? ' qr-on' : ''}`}
              onClick={() => setLoginMode(loginMode === 'qr' ? 'password' : 'qr')}
              title={loginMode === 'qr' ? '返回密码登录' : '切换扫码登录'}
              aria-label={loginMode === 'qr' ? '返回密码登录' : '切换扫码登录'}
            >
              <QrCornerIcon />
              <span className="lb-back-ico">✕</span>
            </button>
          )}

          {showQr && loginMode === 'qr' ? (
            <WecomQrPanel config={qrConfig as WecomQrConfig} />
          ) : (
            <div className="lb-pw-view">
              <h2 className="lb-h2">欢迎回来</h2>
              <div className="lb-sub2">登录 SPC 供应链协同平台，继续今天的工作</div>
              <div className="lb-idpills" role="radiogroup" aria-label="登录身份">
                {LOGIN_TYPE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={loginType === option.value}
                    className={`lb-pill${loginType === option.value ? ' on' : ''}`}
                    onClick={() => setLoginType(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <Form form={form} onFinish={onFinish} autoComplete="off">
                <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                  <Input prefix={<UserOutlined style={{ color: '#94a3b8' }} />} placeholder="账号" />
                </Form.Item>
                <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
                  <Input.Password prefix={<LockOutlined style={{ color: '#94a3b8' }} />} placeholder="密码" />
                </Form.Item>
                <div className="lb-aux">
                  <Switch size="small" checked={rememberMe} onChange={setRememberMe} />
                  <span className="lb-remember" onClick={() => setRememberMe(!rememberMe)}>
                    记住我（7 天内免登录）
                  </span>
                  <a className="lb-forgot" onClick={() => message.info('请联系管理员重置密码')}>
                    忘记密码？
                  </a>
                </div>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  block
                  size="large"
                  className="lb-submit"
                >
                  登 录
                </Button>
              </Form>
            </div>
          )}

          {isInWecom && (
            <p className="inapp-hint">↻ 已在企业微信内，自动静默登录中…</p>
          )}

          {loggingIn && (
            <div className="lb-logging-mask">
              <Spin />
              <span className="lb-logging-text">企业微信登录中…</span>
            </div>
          )}
        </div>
      </div>

      <div className="lb-foot">© 2026 SPC · 企业微信已接入 · 建议使用 Chrome / Edge 浏览器</div>
    </div>
  )
}
