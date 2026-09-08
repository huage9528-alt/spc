import { useEffect, useState } from 'react'
import { Dialog, Toast } from 'antd-mobile'
import { authApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'
import MIcon from '../components/MIcon'

export default function MePage() {
  const user = useAuthStore((s) => s.currentUser)
  const logout = useAuthStore((s) => s.logout)
  const [bindTip, setBindTip] = useState('')
  const [bound, setBound] = useState(false)

  useEffect(() => {
    authApi.getMe().then((res: any) => {
      const wecomId = res.data?.wecom_user_id
      setBound(!!wecomId)
      setBindTip(wecomId ? String(wecomId) : '')
    }).catch(() => setBound(false))
  }, [])

  const displayName = user && 'display_name' in user ? user.display_name || user.username : '-'
  const roleName = user && 'role_name' in user ? user.role_name : ''

  return (
    <div className="m-page m-page--with-tabbar">
      <div className="me-hero">
        <div className="avatar">{(displayName || '?').slice(0, 1)}</div>
        <div>
          <div className="nm">{displayName}</div>
          {roleName && <div className="rl">{roleName}</div>}
        </div>
      </div>

      <div className="m-card">
        <div className="info-row">
          <span className="lab">账号</span>
          <span className="val">{user && 'username' in user ? user.username : '-'}</span>
        </div>
        <div className="info-row">
          <span className="lab">角色</span>
          <span className="val">{roleName || '-'}</span>
        </div>
        <div className="info-row">
          <span className="lab">企业微信</span>
          <span className="val" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {bound ? (
              <>
                <span className="m-chip m-chip--done">已绑定</span>
                {bindTip && <span style={{ fontSize: 11, color: 'var(--spc-text3)' }}>{bindTip}</span>}
              </>
            ) : (
              <span style={{ fontSize: 13, color: 'var(--spc-text2)' }}>未绑定企微（请在 PC 端个人中心绑定）</span>
            )}
          </span>
        </div>
      </div>

      <button
        className="mbtn mbtn--danger-o mbtn--block"
        style={{ margin: '14px 14px 0', width: 'calc(100% - 28px)' }}
        onClick={() => {
          Dialog.confirm({
            title: '退出登录',
            content: '确定要退出当前账号吗？',
            onConfirm: () => {
              logout()
              window.location.replace('/m/login')
              Toast.show({ content: '已退出', duration: 800 })
            },
          })
        }}
      >
        <MIcon name="logout" size={18} />退出登录
      </button>
    </div>
  )
}
