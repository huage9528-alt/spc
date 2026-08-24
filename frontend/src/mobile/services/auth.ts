import { authApi } from '@/services/api'

export const mobileAuth = {
  // OAuth 回跳必须是登录页路径，否则 code 会被 AuthGuard 丢弃导致免登死循环
  oauthUrl: () => authApi.wecomOauthUrl('mobile', '/m/login'),
  wecomLogin: (code: string) => authApi.wecomLogin(code, 'mobile'),
  passwordLogin: (username: string, password: string) =>
    authApi.login(username, password, 'employee', 'mobile'),
}
