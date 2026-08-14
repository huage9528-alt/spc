import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Form, Input, Button, Spin, message } from 'antd'
import { UserOutlined, LockOutlined, ShopOutlined, TeamOutlined } from '@ant-design/icons'
import { authApi } from '../services/api'
import { useAuthStore } from '../store/auth'
import { SUPPLIER_PORTAL_PATHS } from '../constants/permissions'

type LoginType = 'employee' | 'supplier'

interface LoginFormValues {
  loginType: LoginType
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

const LOGIN_TYPE_OPTIONS: Array<{
  label: string
  description: string
  value: LoginType
  icon: ReactNode
}> = [
  {
    label: '内部员工',
    description: '企业账号',
    value: 'employee',
    icon: <TeamOutlined />,
  },
  {
    label: '供应商',
    description: '协作账号',
    value: 'supplier',
    icon: <ShopOutlined />,
  },
]

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
    <div className="login-col right">
      <div id="wecom-qr-container">
        <iframe src={src} title="企业微信扫码登录" scrolling="no" />
      </div>
      <p className="qr-tag">仅支持已绑定的内部员工</p>
    </div>
  )
}

export default function Login() {
  const [form] = Form.useForm<LoginFormValues>()
  const [loading, setLoading] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [qrConfig, setQrConfig] = useState<WecomQrConfig | null>(null)
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [searchParams] = useSearchParams()
  const code = searchParams.get('code')
  const isInWecom =
    typeof navigator !== 'undefined' &&
    navigator.userAgent.toLowerCase().includes('wxwork')

  // 企微 code → JWT → 登录（扫码 onLoginSuccess 与静默 OAuth ?code= 回调共用）
  const loginWithWecomCode = useCallback(async (wecomCode: string, opts?: { clearUrl?: boolean }) => {
    setLoggingIn(true)
    try {
      const res: any = await authApi.wecomLogin(wecomCode)
      const token = res.data.access_token
      useAuthStore.getState().setAuth(token, null)
      const meRes: any = await authApi.getMe()
      setAuth(token, meRes.data)
      message.success('登录成功')
      navigate('/dashboard')
    } catch {
      // /wecom-login 失败由全局拦截器 toast；此处仅结束 loading
    } finally {
      setLoggingIn(false)
      if (opts?.clearUrl) window.history.replaceState({}, '', window.location.pathname)
    }
  }, [setAuth, navigate])

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

  // 企微客户端内：无 code 时静默跳转 OAuth
  useEffect(() => {
    if (code || !isInWecom) return
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
  }, [code, isInWecom])

  const onFinish = async (values: LoginFormValues) => {
    setLoading(true)
    try {
      const res: any = await authApi.login(values.username, values.password, values.loginType)
      const token = res.data.access_token

      useAuthStore.getState().setAuth(token, null)
      const meRes: any = await authApi.getMe()
      const user = meRes.data
      const isSupplierAccount = user?.role_code === 'supplier'
      if (values.loginType === 'supplier' && !isSupplierAccount) {
        useAuthStore.getState().logout()
        message.warning('当前为内部员工账号，请切换到内部员工登录')
        return
      }
      if (values.loginType === 'employee' && isSupplierAccount) {
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
        navigate('/dashboard')
      }
    } catch (error: any) {
      message.error(error?.message || '登录失败，请检查用户名和密码')
    } finally {
      setLoading(false)
    }
  }

  const showQr = !isInWecom && !!qrConfig?.enabled

  return (
    <div className="login-bg">
      <div className={`login-card${showQr ? ' has-qr' : ''}`}>
        <div className="login-col left">
          <div className="text-center mb-8">
            <div
              className="inline-flex items-center justify-center mb-4"
              style={{ width: 48, height: 48, borderRadius: 14, background: 'linear-gradient(135deg, #6366f1, #818cf8)', boxShadow: '0 4px 16px rgba(99,102,241,.25)' }}
            >
              <LockOutlined style={{ fontSize: 22, color: '#fff' }} />
            </div>
            <h1 className="text-xl font-bold m-0" style={{ color: '#0f172a' }}>
              供应链与生产协同中台
            </h1>
            <p className="mt-2" style={{ color: '#94a3b8', fontSize: 13 }}>
              Supply Chain &amp; Production Collaboration
            </p>
          </div>

          <Form form={form} onFinish={onFinish} autoComplete="off" size="large" initialValues={{ loginType: 'employee' }}>
            <Form.Item name="loginType" hidden>
              <Input />
            </Form.Item>
            <Form.Item
              className="login-role-field"
              shouldUpdate={(prev, current) => prev.loginType !== current.loginType}
            >
              {({ getFieldValue, setFieldsValue }) => {
                const currentLoginType = (getFieldValue('loginType') || 'employee') as LoginType

                return (
                  <div className="login-role-switch" role="radiogroup" aria-label="登录身份">
                    <span
                      className={`login-role-indicator${currentLoginType === 'supplier' ? ' is-supplier' : ''}`}
                      aria-hidden="true"
                    />
                    {LOGIN_TYPE_OPTIONS.map((option) => {
                      const isActive = currentLoginType === option.value

                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={`login-role-option${isActive ? ' is-active' : ''}`}
                          role="radio"
                          aria-checked={isActive}
                          onClick={() => setFieldsValue({ loginType: option.value })}
                        >
                          <span className="login-role-icon">{option.icon}</span>
                          <span className="login-role-text">
                            <span className="login-role-label">{option.label}</span>
                            <span className="login-role-desc">{option.description}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )
              }}
            </Form.Item>
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input
                prefix={<UserOutlined style={{ color: '#a5b4fc' }} />}
                placeholder="用户名"
                style={{ background: 'rgba(255,255,255,.5)', borderColor: 'rgba(0,0,0,.08)' }}
              />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password
                prefix={<LockOutlined style={{ color: '#a5b4fc' }} />}
                placeholder="密码"
                style={{ background: 'rgba(255,255,255,.5)', borderColor: 'rgba(0,0,0,.08)' }}
              />
            </Form.Item>
            <Form.Item className="mb-0 mt-2">
              <Button type="primary" htmlType="submit" loading={loading} block size="large"
                style={{ height: 44, fontWeight: 600 }}
              >
                登录
              </Button>
            </Form.Item>
          </Form>
          {isInWecom && (
            <p className="inapp-hint">↻ 已在企业微信内，自动静默登录中…</p>
          )}
        </div>

        {showQr && (
          <>
            <div className="login-divider" />
            <WecomQrPanel config={qrConfig as WecomQrConfig} />
          </>
        )}

        {loggingIn && (
          <div className="login-logging-mask">
            <Spin />
            <span className="login-logging-text">企业微信登录中…</span>
          </div>
        )}
      </div>
    </div>
  )
}
