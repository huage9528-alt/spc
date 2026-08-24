import { useEffect, useState } from 'react'
import { List, Button, Dialog, Toast } from 'antd-mobile'
import { UserOutline } from 'antd-mobile-icons'
import { authApi } from '@/services/api'
import { useAuthStore } from '@/store/auth'

export default function MePage() {
  const user = useAuthStore((s) => s.currentUser)
  const logout = useAuthStore((s) => s.logout)
  const [bindTip, setBindTip] = useState('')

  useEffect(() => {
    authApi.getMe().then((res: any) => {
      setBindTip(res.data?.wecom_user_id ? `已绑定企微（${res.data.wecom_user_id}）` : '未绑定企微（请在 PC 端个人中心绑定）')
    }).catch(() => setBindTip(''))
  }, [])

  return (
    <div className="mobile-page mobile-page--with-tabbar">
      <div className="mobile-card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: '#6366f1',
            color: '#fff',
            fontSize: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <UserOutline />
        </div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#1e293b' }}>
            {user && 'display_name' in user ? user.display_name || user.username : '-'}
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
            {user && 'role_name' in user ? user.role_name : ''}
          </div>
        </div>
      </div>

      <div className="mobile-card" style={{ padding: 0 }}>
        <List>
          <List.Item extra={user && 'username' in user ? user.username : '-'}>账号</List.Item>
          <List.Item extra={bindTip || '…'}>企业微信</List.Item>
        </List>
      </div>

      <Button
        block
        color="danger"
        fill="outline"
        size="large"
        style={{ marginTop: 24 }}
        onClick={() => {
          Dialog.confirm({
            title: '退出登录',
            content: '确定退出当前账号？',
            onConfirm: () => {
              logout()
              window.location.replace('/m/login')
              Toast.show({ content: '已退出', duration: 800 })
            },
          })
        }}
      >
        退出登录
      </Button>
    </div>
  )
}
