import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Form, Toast, SpinLoading } from 'antd-mobile'
import { authApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import { mobileAuth } from '../services/auth'

export default function MobileLoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const hasToken = !!useAuthStore((s) => s.currentToken)
  const [phase, setPhase] = useState<'oauth' | 'password'>('oauth')
  const [error, setError] = useState('')

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

  async function onPasswordSubmit(values: { username: string; password: string }) {
    try {
      const res: any = await mobileAuth.passwordLogin(values.username, values.password)
      const token = res.data.access_token
      useAuthStore.getState().setAuth(token, null)
      const meRes: any = await authApi.getMe()
      setAuth(token, meRes.data)
      window.location.replace('/m/')
    } catch (e: any) {
      Toast.show({ content: e?.response?.data?.detail || e?.message || '登录失败' })
    }
  }

  if (phase === 'oauth') {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
        <SpinLoading color="primary" />
        <div style={{ color: '#64748b', fontSize: 13 }}>正在跳转企业微信登录…</div>
        {error && <div style={{ color: '#e11d48', fontSize: 13 }}>{error}</div>}
      </div>
    )
  }

  return (
    <div className="mobile-page" style={{ paddingTop: '18vh' }}>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b' }}>供应链与生产协同中台</div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 6 }}>移动端</div>
      </div>
      {error && <div style={{ color: '#e11d48', fontSize: 13, marginBottom: 12 }}>{error}</div>}
      <Form onFinish={onPasswordSubmit} footer={
        <Button block type="submit" color="primary" size="large">登录</Button>
      }>
        <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
          <Input placeholder="用户名" clearable />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input type="password" placeholder="密码" clearable />
        </Form.Item>
      </Form>
    </div>
  )
}
