import { create } from 'zustand'
import { useThemeStore } from './theme'
import { usePermissionStore } from './permission'
import { useUiPreferencesStore } from './uiPreferences'
import { useStockCheckPoolStore } from './stockCheckPool'

interface UserInfo {
  id: number
  username: string
  display_name: string | null
  role_code: string
  role_name: string
  permissions: Record<string, string[]> | null
  supplier_name?: string | null
  supplier_code?: string | null
  font_size_scale?: string | null
  ui_preferences?: Record<string, any> | null
  is_default_password: boolean
  login_version: number
  position_name?: string | null
  wecom_user_id?: string | null
}

interface ShareUserInfo {
  id: 0
  username: 'share_user'
  display_name: '分享访问'
  role_code: 'share'
  role_name: '分享访问'
  permissions: Record<string, string[]> | null
  is_share_user: true
  share_target_path: string
  share_permissions: string[]  // 分享时授予的操作权限 ['read','create','update','delete']
}

interface AuthState {
  // 原始登录信息
  originalToken: string | null
  originalUser: UserInfo | null
  // 分享登录信息
  shareToken: string | null
  shareUser: ShareUserInfo | null
  // 当前活跃的认证
  currentToken: string | null
  currentUser: (UserInfo | ShareUserInfo) | null
  
  setAuth: (token: string, user: UserInfo | null) => void
  updateUserField: (patch: Partial<UserInfo>) => void
  setShareAuth: (token: string, targetPath: string, sharePermissions?: string[]) => void
  exitShare: () => void
  logout: () => void
  hasPermission: (resource: string, action: string) => boolean
  isAdmin: () => boolean
  isSupplierUser: () => boolean
  isShareUser: () => boolean
  getShareTargetPath: () => string | undefined
}

const permissionAliases: Record<string, string[]> = {
  'basicdata.import': ['masterdata.import'],
  'basicdata.data': ['masterdata.data'],
  'basicdata.feedback': ['masterdata.feedback'],
  'basicdata.files': ['masterdata.files'],
  'masterdata.import': ['basicdata.import'],
  'masterdata.data': ['basicdata.data'],
  'masterdata.feedback': ['basicdata.feedback'],
  'masterdata.files': ['basicdata.files'],
}

// 分享路径 → 允许的权限资源映射
const sharePathToPermission: Record<string, string> = {
  '/dashboard': 'dashboard',
  '/orders': 'orders',
  '/run-orders': 'orders.run_orders',
  '/order-risk-pool': 'orders.risk_pool',
  '/purchase-plan': 'materials.purchase_plan',
  '/material-issues': 'materials.issues',
  '/long-lead-materials': 'materials.long_lead',
  '/kit-analysis': 'materials.kit_analysis',
  '/supplier-risk': 'materials.supplier_risk',
  '/supplier-payment': 'materials.supplier_payment',
  '/issues': 'exceptions',
  '/quality-issues': 'exceptions.quality',
  '/product-samples': 'exceptions.product_samples',
  '/closure-tracking': 'exceptions.closure',
  '/production-overview': 'production.overview',
  '/schedule-plans': 'production.schedule_plans',
  '/front-process': 'production.front_process',
  '/smt': 'production.smt',
  '/lean': 'production.lean',
  '/assembly': 'production.assembly',
  '/packaging': 'production.packaging',
  '/process-exceptions': 'production.exceptions',
  '/import': 'basicdata.import',
  '/risk-rules': 'rules.risk_rules',
  '/node-standards': 'rules.node_standards',
  '/order-standards': 'rules.order_standards',
  '/work-instructions': 'rules.work_instructions',
  '/users': 'users',
  '/audit': 'audit',
  '/sync-config': 'settings',
  '/basicdata/customers': 'basicdata.data',
  '/basicdata/suppliers': 'basicdata.data',
  '/basicdata/supplier-material-map': 'basicdata.data.suppliers',
  '/basicdata/materials': 'basicdata.data',
  '/basicdata/skus': 'basicdata.data',
  '/basicdata/products': 'basicdata.data',
  '/basicdata/warehouses': 'basicdata.data',
  '/basicdata/processes': 'basicdata.data',
  '/basicdata/organizations': 'basicdata.data',
  '/basicdata/employees': 'basicdata.data',
  '/basicdata/feedback': 'basicdata.feedback',
  '/basicdata/files': 'basicdata.files',
  '/announcements': 'announcements',
}

export const useAuthStore = create<AuthState>((set, get) => {
  // 从 localStorage 恢复状态
  const originalToken = localStorage.getItem('token')
  const originalUserStr = localStorage.getItem('user')
  const shareToken = localStorage.getItem('shareToken')
  const shareUserStr = localStorage.getItem('shareUser')
  
  let originalUser: UserInfo | null = null
  if (originalUserStr) {
    try {
      originalUser = JSON.parse(originalUserStr)
    } catch {
      localStorage.removeItem('user')
    }
  }
  
  let shareUser: ShareUserInfo | null = null
  if (shareUserStr) {
    try {
      shareUser = JSON.parse(shareUserStr)
    } catch {
      localStorage.removeItem('shareUser')
    }
  }
  
  const pathname = window.location.pathname
  const isShareEntry = pathname.startsWith('/share/')
  let isLegitShareContext = isShareEntry
  if (!isShareEntry && shareUser && shareUser.share_target_path) {
    const tp = shareUser.share_target_path
    if (tp.includes(':')) {
      isLegitShareContext = pathname.startsWith(tp.split('/:')[0])
    } else {
      isLegitShareContext = pathname === tp || pathname.startsWith(tp + '/')
    }
  }
  let activeShareToken = shareToken
  let activeShareUser = shareUser
  if (!isLegitShareContext && (shareToken || shareUser)) {
    localStorage.removeItem('shareToken')
    localStorage.removeItem('shareUser')
    activeShareToken = null
    activeShareUser = null
  }

  // 确定当前活跃的认证
  let currentToken: string | null = activeShareToken || originalToken
  let currentUser: (UserInfo | ShareUserInfo) | null = activeShareUser || originalUser
  
  return {
    originalToken,
    originalUser,
    shareToken: activeShareToken,
    shareUser: activeShareUser,
    currentToken,
    currentUser,
    
    setAuth: (token, user) => {
      localStorage.setItem('token', token)
      if (user) {
        localStorage.setItem('user', JSON.stringify(user))
        useThemeStore.getState().loadFontSizeFromUser(user)
        useUiPreferencesStore.getState().loadFromUser(user)
        useStockCheckPoolStore.getState().loadForUser(user.id)
      }
      // 如果当前不在分享模式，更新当前认证
      const state = get()
      if (!state.shareUser) {
        set({ originalToken: token, originalUser: user, currentToken: token, currentUser: user })
      } else {
        set({ originalToken: token, originalUser: user })
      }
    },

    updateUserField: (patch) => {
      const state = get()
      if (!state.originalUser) return
      const updated = { ...state.originalUser, ...patch }
      localStorage.setItem('user', JSON.stringify(updated))
      set({
        originalUser: updated,
        currentUser: state.shareUser ? state.currentUser : updated,
      })
    },
    
    setShareAuth: (token, targetPath, sharePermissions) => {
      const perms = sharePermissions || ['read']
      localStorage.setItem('shareToken', token)
      const shareUserInfo: ShareUserInfo = {
        id: 0,
        username: 'share_user',
        display_name: '分享访问',
        role_code: 'share',
        role_name: '分享访问',
        permissions: null,
        is_share_user: true,
        share_target_path: targetPath,
        share_permissions: perms,
      }
      localStorage.setItem('shareUser', JSON.stringify(shareUserInfo))
      set({ shareToken: token, shareUser: shareUserInfo, currentToken: token, currentUser: shareUserInfo })
    },
    
    exitShare: () => {
      localStorage.removeItem('shareToken')
      localStorage.removeItem('shareUser')
      const state = get()
      set({
        shareToken: null,
        shareUser: null,
        currentToken: state.originalToken,
        currentUser: state.originalUser,
      })
    },
    
    logout: () => {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      localStorage.removeItem('shareToken')
      localStorage.removeItem('shareUser')
      useStockCheckPoolStore.getState().loadForUser(null)
      set({
        originalToken: null,
        originalUser: null,
        shareToken: null,
        shareUser: null,
        currentToken: null,
        currentUser: null,
      })
    },
    
    hasPermission: (resource: string, action: string) => {
      const { currentUser, shareUser } = get()
      if (!currentUser) return false
      // 分享用户：只对分享目标页面对应的权限返回 true，且仅限授权的操作
      if ('is_share_user' in currentUser && currentUser.is_share_user) {
        const targetPath = shareUser?.share_target_path
        const sharePerms = shareUser?.share_permissions || ['read']
        // 检查操作是否在分享权限中
        if (!sharePerms.includes(action)) return false
        if (!targetPath) return false
        // 动态获取分享路径映射，fallback 到硬编码
        let sharePathMap = sharePathToPermission
        try {
          const permState = usePermissionStore.getState()
          if (permState.loaded && permState.tree.length > 0) {
            sharePathMap = permState.getSharePathToPermission()
          }
        } catch { /* fallback */ }
        // 动态路由（如 /orders/:orderNo/lines/:lineNo）需要特殊处理
        if (targetPath.includes(':')) {
          const prefix = targetPath.split('/:')[0]
          const allowedResource = sharePathMap[prefix]
          if (allowedResource && resource.split('.')[0] === allowedResource.split('.')[0]) return true
          return false
        }
        const allowedResource = sharePathMap[targetPath]
        if (!allowedResource) return true
        if (resource === allowedResource) return true
        if (resource.split('.')[0] === allowedResource.split('.')[0]) return true
        return false
      }
      if ('role_code' in currentUser && currentUser.role_code === 'admin') return true
      const perms = 'permissions' in currentUser ? currentUser.permissions : null
      if (!perms || typeof perms !== 'object') return false
      const resourcesToCheck = [resource, ...(permissionAliases[resource] || [])]
      for (const candidate of resourcesToCheck) {
        const actions = (perms as Record<string, string[]>)[candidate]
        if (Array.isArray(actions) && actions.includes(action)) return true
      }
      for (const candidate of resourcesToCheck) {
        const parts = candidate.split('.')
        for (let i = parts.length - 1; i > 0; i--) {
          const parent = parts.slice(0, i).join('.')
          if (!parent) continue
          const parentActions = (perms as Record<string, string[]>)[parent]
          if (Array.isArray(parentActions) && parentActions.includes(action)) return true
        }
      }
      return false
    },
    
    isAdmin: () => {
      const { currentUser } = get()
      return !!(currentUser && 'role_code' in currentUser && currentUser.role_code === 'admin')
    },

    isSupplierUser: () => {
      const { currentUser } = get()
      return !!(currentUser && 'role_code' in currentUser && currentUser.role_code === 'supplier')
    },
    
    isShareUser: () => {
      const { currentUser } = get()
      return !!(currentUser && 'is_share_user' in currentUser && currentUser.is_share_user === true)
    },
    
    getShareTargetPath: () => {
      const { shareUser } = get()
      return shareUser?.share_target_path
    },
  }
})
