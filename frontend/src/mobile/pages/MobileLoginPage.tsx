import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Toast } from 'antd-mobile'
import { authApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { mobileAuth } from '../services/auth'
import MIcon from '../components/MIcon'

export default function MobileLoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const hasToken = !!useAuthStore((s) => s.currentToken)
  const [phase, setPhase] = useState<'oauth' | 'password'>('oauth')
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function loginByCode(code: string) {
    try {
      const res: any = await mobileAuth.wecomLogin(code)
      const token = res.data.access_token
      useAuthStore.getState().setAuth(token, null)
      const meRes: any = await authApi.getMe()
      setAuth(token, meRes.data)
      window.location.replace('/m/')
      return
    } catch (e: any) {
      const status = e?.response?.status
      const detail = e?.response?.data?.detail || e?.message || '登录失败'
      if (status === 403 && String(detail).includes('未绑定')) {
        setError('该企微账号未绑定系统用户，可先用账号密码登录，再到 PC 端个人中心绑定')
        setPhase('password')
        return
      }
      if (status === 401) {
        // code 失效/过期：去掉 code 重新发起授权
        window.location.replace(window.location.origin + '/m/login')
        return
      }
      setError(detail)
      setPhase('password')
    }
  }

  useEffect(() => {
    if (hasToken) {
      navigate('/', { replace: true })
      return
    }
    const code = new URLSearchParams(window.location.search).get('code')
    if (code) {
      loginByCode(code)
      return
    }
    if (phase === 'oauth') {
      mobileAuth
        .oauthUrl()
        .then((res: any) => {
          window.location.replace(res.data.oauth_url)
        })
        .catch(() => {
          // 企微未配置（501）或非企微环境：直接给密码表单
          setPhase('password')
        })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onPasswordSubmit() {
    if (!username.trim() || !password) {
      Toast.show('请输入账号和密码')
      return
    }
    setSubmitting(true)
    try {
      const res: any = await mobileAuth.passwordLogin(username.trim(), password)
      const token = res.data.access_token
      useAuthStore.getState().setAuth(token, null)
      const meRes: any = await authApi.getMe()
      setAuth(token, meRes.data)
      window.location.replace('/m/')
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || '登录失败')
      Toast.show(e?.response?.data?.detail || e?.message || '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="m-page m-page--full">
      <div className="login-wrap">
        {phase === 'oauth' ? (
          <div className="lp1">
            <div className="brand-ic">
              <MIcon name="cube" size={36} />
            </div>
            <div className="t">供应链与生产协同中台 · 移动端</div>
            <div className="big-spin" />
            <div className="s">正在跳转企业微信登录…</div>
            {error && <div className="s" style={{ color: '#b91c1c' }}>{error}</div>}
            <button className="lnk" onClick={() => setPhase('password')}>
              使用账号密码登录
            </button>
          </div>
        ) : (
          <div className="lp2">
            <div className="bt">供应链与生产协同中台</div>
            <div className="bs">移动端 · 账号密码登录</div>
            {error && <div className="lg-error">{error}</div>}
            <div className="m-field">
              <label>账号</label>
              <div className="inp">
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="请输入账号" />
              </div>
            </div>
            <div className="m-field">
              <label>密码</label>
              <div className="inp">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                />
              </div>
            </div>
            <button className="mbtn mbtn--deep mbtn--block lg-btn" disabled={submitting} onClick={onPasswordSubmit}>
              {submitting ? '登录中…' : '登 录'}
            </button>
            <div className="lg-alt">未绑定企微？登录后可在 PC 端个人中心绑定</div>
          </div>
        )}
      </div>
    </div>
  )
}
