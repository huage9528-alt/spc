import axios from 'axios'
import { useAuthStore } from '../store/auth'
import { getGlobalMessageApi } from '../utils/antdMessage'

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
})

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().currentToken
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => {
    const data = response.data
    if (data.code !== 0) {
      const err: any = new Error(data.message || '请求失败')
      err._apiData = data
      err._apiResponse = response
      return Promise.reject(err)
    }
    return data
  },
  (error) => {
    const messageApi = getGlobalMessageApi()
    const status = error.response?.status
    const forceLogout = error.response?.headers?.['x-force-logout']
    if (status === 401) {
      const detail = error.response?.data?.detail || '登录已过期'
      error.message = detail
      // 登录接口自身的 401（用户名/密码错误等）由 Login 页面 catch 自行提示，
      // 不要再走全局 toast + 登出 + window.location.href 全页刷新逻辑，
      // 否则会立刻把刚排队的错误提示 toast 销毁。
      if (error.config?.url?.includes('/basicdata/auth/login')) {
        return Promise.reject(error)
      }
      const { isShareUser, exitShare, logout } = useAuthStore.getState()
      if (isShareUser()) {
        messageApi?.warning({ content: detail, duration: 2 })
        setTimeout(() => {
          exitShare()
          window.location.href = '/login'
        }, 1500)
      } else if (forceLogout === 'true') {
        messageApi?.warning({ content: detail, duration: 2 })
        setTimeout(() => {
          logout()
          window.location.href = '/login'
        }, 1500)
      } else {
        messageApi?.error(detail)
        logout()
        window.location.href = '/login'
      }
    } else if (status === 403) {
      const detail = error.response?.data?.detail || '权限不足，无法执行此操作'
      error.message = detail
      messageApi?.error(detail)
    } else if (status === 404) {
      error.message = error.response?.data?.detail || '请求的资源不存在'
      messageApi?.error(error.message)
    } else if (status && status >= 500) {
      error.message = error.response?.data?.detail || '服务器错误，请稍后重试'
      messageApi?.error(error.message)
    } else if (!error.response) {
      error.message = '网络连接失败，请检查网络连接后重试'
      messageApi?.error(error.message)
    }
    return Promise.reject(error)
  },
)

export default api

// ============ Auth (基础数据与集成中心) ============
export const authApi = {
  login: (username: string, password: string, loginType: 'employee' | 'supplier' = 'employee') => {
    const formData = new URLSearchParams()
    formData.append('username', username)
    formData.append('password', password)
    formData.append('login_type', loginType)
    return api.post('/basicdata/auth/login', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  },
  getMe: () => api.get('/basicdata/auth/me'),
  changePassword: (old_password: string, new_password: string) =>
    api.put('/basicdata/auth/change-password', { old_password, new_password }),
  updatePreferences: (data: { font_size_scale?: string; ui_preferences?: Record<string, any> }) =>
    api.put('/basicdata/auth/preferences', data),
}

export const permissionApi = {
  tree: () => api.get('/permissions/tree'),
  list: () => api.get('/permissions'),
  routeMap: () => api.get('/permissions/route-map'),
}

// ============ 供应链驾驶舱 ============
export const dashboardApi = {
  getSummary: () => api.get('/dashboard/summary'),
  getOrders: (params: Record<string, any>) => api.get('/dashboard/orders', { params }),
  getMaterials: (params: Record<string, any>) => api.get('/dashboard/materials', { params }),
  getRiskDistribution: () => api.get('/dashboard/risk-distribution'),
  getTodayOverview: () => api.get('/dashboard/today-overview'),
  getTodayDueOrders: (params: Record<string, any>) => api.get('/dashboard/today-due-orders', { params }),
  getRollingRisk: () => api.get('/dashboard/rolling-risk'),
  getOrderRiskDistribution: () => api.get('/dashboard/order-risk-distribution'),
  getClosureAchievement: () => api.get('/dashboard/closure-achievement'),
  getProcurementBoard: (targetDate?: string) => api.get('/dashboard/procurement-board', { params: targetDate ? { target_date: targetDate } : {} }),
  getShipmentBoard: () => api.get('/dashboard/shipment-board'),
}

// ============ 订单交付中心 ============
export const orderApi = {
  list: (params: Record<string, any>) => api.get('/orders', { params }),
  listDomestic: (params: Record<string, any>) => api.get('/orders/domestic', { params }),
  listDomesticShipment: (params: Record<string, any>) => api.get('/orders/domestic-shipment', { params }),
  listRiskPool: (params: Record<string, any>) => api.get('/orders/risk-pool', { params }),
  getDetail: (orderNo: string, lineNo?: string) =>
    lineNo ? api.get(`/orders/${orderNo}/lines/${lineNo}`) : api.get(`/orders/${orderNo}`),
  getProductMaterials: (orderNo: string, params: Record<string, any> = {}) =>
    api.get(`/orders/${orderNo}/product-materials`, { params }),
  update: (orderNo: string, data: Record<string, any>) => api.put(`/orders/${orderNo}`, data),
  exportOrders: (params: Record<string, any>) =>
    api.get('/orders/export', { params, responseType: 'blob' }),
  getShippingAnalytics: () => api.get('/orders/shipping-analytics'),
}

export const runOrderApi = {
  list: (params: Record<string, any>) => api.get('/run-orders', { params }),
  get: (id: number) => api.get(`/run-orders/${id}`),
  create: (data: Record<string, any>) => api.post('/run-orders', data),
  update: (id: number, data: Record<string, any>) => api.put(`/run-orders/${id}`, data),
  syncFromOrder: (orderNo: string) => api.post(`/run-orders/sync-from-order/${orderNo}`),
}

// ============ 物料齐套中心 ============
export const poApi = {
  list: (params: Record<string, any>) => api.get('/materials', { params }),
  get: (poNo: string) => api.get(`/materials/${poNo}`),
  updateStatus: (poNo: string, data: { po_status: string; remark?: string }) =>
    api.put(`/materials/${poNo}/status`, data),
  getTimeline: (poNo: string) => api.get(`/materials/${poNo}/timeline`),
}

export const materialApi = {
  // 采购到料计划
  listPurchasePlan: (params: Record<string, any>) =>
    api.get('/materials/purchase-plan', { params }),
  createPurchasePlan: (data: Record<string, any>) =>
    api.post('/materials/purchase-plan', data),
  updatePurchasePlan: (id: number, data: Record<string, any>) =>
    api.put(`/materials/purchase-plan/${id}`, data),
  batchUpdatePurchasePlan: (data: {
    ids: number[]
    eta?: string
    owner?: string
    owner_id?: number
    supplier_account?: string
    actual_arrival_date?: string
    inspection_date?: string
    clear_fields?: string[]
  }) =>
    api.put('/materials/purchase-plan/batch', data),
  importPurchasePlan: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/materials/purchase-plan/import', fd)
  },
  getPurchasePlanStats: (params: Record<string, any>) =>
    api.get('/materials/purchase-plan/stats', { params }),
  getPurchasePlanAnalysis: (params: Record<string, any>) =>
    api.get('/materials/purchase-plan/analysis', { params }),
  exportPurchasePlan: (params: Record<string, any>) =>
    api.get('/materials/purchase-plan/export', { params, responseType: 'blob' }),
  // 问题物料
  listIssues: (params: Record<string, any>) =>
    api.get('/materials/issues', { params }),
  createIssue: (data: Record<string, any>) =>
    api.post('/materials/issues', data),
  updateIssue: (id: number, data: Record<string, any>) =>
    api.put(`/materials/issues/${id}`, data),
  deleteIssue: (id: number) =>
    api.delete(`/materials/issues/${id}`),
  importIssues: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/materials/issues/import', fd)
  },
  // 长交期物料（派生视图 + 注解表）
  listLongLead: (params: Record<string, any>) =>
    api.get('/materials/long-lead', { params }),
  updateLongLead: (id: number, data: Record<string, any>) =>
    api.put(`/materials/long-lead/${id}`, data),
  deleteLongLead: (id: number) =>
    api.delete(`/materials/long-lead/${id}`),
  scanLongLead: () =>
    api.post('/materials/long-lead/scan'),
  ensureAnnotation: (data: Record<string, any>) =>
    api.post('/materials/long-lead/ensure-annotation', data),
  // 齐套分析
  getKitAnalysis: (params: Record<string, any>) =>
    api.get('/materials/kit-analysis', { params }),
  getOrderMaterials: (orderNo: string, params: Record<string, any>) =>
    api.get(`/materials/kit-analysis/${orderNo}/materials`, { params }),
  getOrderProductBreakdown: (orderNo: string) =>
    api.get(`/materials/kit-analysis/${orderNo}/product-breakdown`),
  getOrderProductBomFlat: (orderNo: string, productCode: string, bomId?: string | null) =>
    api.get(`/materials/kit-analysis/${orderNo}/product-bom-flat`, {
      params: { product_code: productCode, ...(bomId ? { bom_id: bomId } : {}) },
    }),
  // 物料盘点
  createStockCheckFromOrder: (orderNo: string, data?: {
    title?: string
    check_date?: string
    remark?: string
    selected_products?: Array<{ product_code?: string | null; bom_no?: string | null }>
  }) =>
    api.post(`/materials/stock-check/from-order/${orderNo}`, data || {}),
  getRecentStockChecks: (params: Record<string, any> = {}) =>
    api.get('/materials/stock-check/recent', { params }),
  getStockChecksByOrder: (orderNo: string) =>
    api.get(`/materials/stock-check/by-order/${orderNo}`),
  getStockCheck: (checkId: number) =>
    api.get(`/materials/stock-check/${checkId}`),
  getStockCheckItems: (checkId: number, params: Record<string, any> = {}) =>
    api.get(`/materials/stock-check/${checkId}/items`, { params }),
  updateStockCheckItem: (itemId: number, data: { actual_qty?: number; is_checked?: number; remark?: string; force_recount?: boolean }) =>
    api.put(`/materials/stock-check/items/${itemId}`, data),
  batchUpdateStockCheckItems: (checkId: number, items: Array<{ id: number; actual_qty?: number; is_checked?: number; remark?: string; force_recount?: boolean }>) =>
    api.post('/materials/stock-check/items/batch', { check_id: checkId, items }),
  completeStockCheck: (checkId: number) =>
    api.post(`/materials/stock-check/${checkId}/complete`),
  cancelStockCheck: (checkId: number) =>
    api.post(`/materials/stock-check/${checkId}/cancel`),
  getMaterialHistory: (params: { material_id: number }) =>
    api.get('/materials/stock-check/material-history', { params }),
  listMaterialCandidates: (params: { keyword?: string; page?: number; page_size?: number } = {}) =>
    api.get('/materials/stock-check/material-candidates', { params }),
  createStockCheckFromMaterials: (data: {
    material_ids: number[]
    title?: string
    check_date?: string
    remark?: string
    co_checker_user_ids?: number[]
  }) => api.post('/materials/stock-check/from-materials', data),
  updateStockCheckCoCheckers: (checkId: number, co_checker_user_ids: number[]) =>
    api.put(`/materials/stock-check/${checkId}/co-checkers`, { co_checker_user_ids }),
  refreshStockCheckBom: (checkId: number) =>
    api.post(`/materials/stock-check/${checkId}/refresh-bom`),
  getCoCheckerCandidates: () =>
    api.get('/materials/stock-check/co-checker-candidates'),
  // 供应商风险
  getSupplierRisk: (params: Record<string, any>) =>
    api.get('/materials/supplier-risk', { params }),
  // 供应商付款排程（基于 purchase_invoice 聚合，只读）
  listSupplierPayment: (params: Record<string, any>) =>
    api.get('/materials/supplier-payment', { params }),
  getSupplierPaymentSummary: (params: Record<string, any> = {}) =>
    api.get('/materials/supplier-payment/summary', { params }),
  // 委外订单
  listSubcontractOrders: (params: Record<string, any>) =>
    api.get('/materials/subcontract-orders', { params }),
  getSubcontractOrder: (id: number) =>
    api.get(`/materials/subcontract-orders/${id}`),
  getSubcontractOrderDetails: (id: number, params: Record<string, any> = {}) =>
    api.get(`/materials/subcontract-orders/${id}/details`, { params }),
  createSubcontractOrder: (data: Record<string, any>) =>
    api.post('/materials/subcontract-orders', data),
  updateSubcontractOrder: (id: number, data: Record<string, any>) =>
    api.put(`/materials/subcontract-orders/${id}`, data),
  batchUpdateSubcontractOrders: (data: { ids: number[]; status?: string; remark?: string }) =>
    api.put('/materials/subcontract-orders/batch', data),
  deleteSubcontractOrder: (id: number) =>
    api.delete(`/materials/subcontract-orders/${id}`),
  importSubcontractOrders: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/materials/subcontract-orders/import', fd)
  },
  exportSubcontractOrders: (params: Record<string, any>) =>
    api.get('/materials/subcontract-orders/export', { params, responseType: 'blob' }),
  addSubcontractOrderDetail: (id: number, data: Record<string, any>) =>
    api.post(`/materials/subcontract-orders/${id}/details`, data),
  updateSubcontractOrderDetail: (id: number, detailId: number, data: Record<string, any>) =>
    api.put(`/materials/subcontract-orders/${id}/details/${detailId}`, data),
  deleteSubcontractOrderDetail: (id: number, detailId: number) =>
    api.delete(`/materials/subcontract-orders/${id}/details/${detailId}`),
}

// ============ 供应商即时沟通 ============
export const supplierMessageApi = {
  list: (supplierName: string, params: Record<string, any> = {}) =>
    api.get('/materials/supplier-messages', { params: { supplier_name: supplierName, ...params } }),
  send: (data: { supplier_name: string; supplier_account?: string; content: string; po_no?: string }) =>
    api.post('/materials/supplier-messages', data),
  unread: (supplierName?: string, afterId?: number) =>
    api.get('/materials/supplier-messages/unread', { params: { supplier_name: supplierName, after_id: afterId } }),
}

// ============ ETA (订单交付中心) ============
export const etaApi = {
  update: (poNo: string, data: { new_eta: string; update_reason?: string; remark?: string }) =>
    api.put(`/orders/eta/purchase-orders/${poNo}/eta`, data),
  getHistory: (poNo: string) => api.get(`/orders/eta/purchase-orders/${poNo}/eta-history`),
  getPendingUpdates: (params: Record<string, any>) => api.get('/orders/eta/pending-updates', { params }),
}

// ============ 生产协同中心（拆出独立模块 services/production.ts） ============
export { productionApi } from './production'

// ============ 异常与质量中心 ============
export const riskApi = {
  scan: () => api.post('/exceptions/risk/scan'),
  assess: () => api.post('/exceptions/risk/assess'),
  assessOrder: (orderNo: string) => api.post(`/exceptions/risk/assess/${orderNo}`),
  getAssessmentResult: (orderNo: string) => api.get(`/exceptions/risk/assessment-result/${orderNo}`),
}

export const issueApi = {
  list: (params: Record<string, any>) => api.get('/exceptions', { params }),
  create: (data: any) => api.post('/exceptions', data),
  update: (id: number, data: any) => api.put(`/exceptions/${id}`, data),
}

export const exceptionApi = {
  // 异常总池
  listPool: (params: Record<string, any>) => api.get('/exceptions/pool', { params }),
  getClosureTracking: (params?: Record<string, any>) => api.get('/exceptions/pool/closure-tracking', { params }),
  getClosureTrackingPersonDetails: (params: { owner: string; source_type?: string; status?: string }) =>
    api.get('/exceptions/pool/closure-tracking/person-details', { params }),
  // 问题日志
  listIssueLog: (params: Record<string, any>) => api.get('/exceptions/issue-log', { params }),
  createIssueLog: (data: Record<string, any>) => api.post('/exceptions/issue-log', data),
  updateIssueLog: (id: number, data: Record<string, any>) => api.put(`/exceptions/issue-log/${id}`, data),
  deleteIssueLog: (id: number) => api.delete(`/exceptions/issue-log/${id}`),
  importIssueLog: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/exceptions/issue-log/import', fd)
  },
  // 变更日志
  listChangeLog: (params: Record<string, any>) => api.get('/exceptions/change-log', { params }),
  createChangeLog: (data: Record<string, any>) => api.post('/exceptions/change-log', data),
  updateChangeLog: (id: number, data: Record<string, any>) => api.put(`/exceptions/change-log/${id}`, data),
  deleteChangeLog: (id: number) => api.delete(`/exceptions/change-log/${id}`),
  importChangeLog: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/exceptions/change-log/import', fd)
  },
  // 品质异常
  listQuality: (params: Record<string, any>) => {
    const queryParams = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach(item => queryParams.append(key, String(item)))
      } else if (value !== undefined && value !== null && value !== '') {
        queryParams.append(key, String(value))
      }
    })
    const qs = queryParams.toString()
    return api.get(`/exceptions/quality${qs ? `?${qs}` : ''}`)
  },
  getQualityStatistics: (params: Record<string, any>) => {
    const queryParams = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach(item => queryParams.append(key, String(item)))
      } else if (value !== undefined && value !== null && value !== '') {
        queryParams.append(key, String(value))
      }
    })
    const qs = queryParams.toString()
    return api.get(`/exceptions/quality/statistics${qs ? `?${qs}` : ''}`)
  },
  createQuality: (data: Record<string, any>) => api.post('/exceptions/quality', data),
  updateQuality: (id: number, data: Record<string, any>) => api.put(`/exceptions/quality/${id}`, data),
  deleteQuality: (id: number) => api.delete(`/exceptions/quality/${id}`),
}

// ============ 基础数据与集成中心 ============
export const importExportApi = {
  importOrders: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/basicdata/import-export/orders', formData)
  },
  importMaterials: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/basicdata/import-export/materials', formData)
  },
  importPurchaseOrders: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/basicdata/import-export/purchase-orders', formData)
  },
  syncData: (type: string, params: { hours?: number; order_numbers?: string[] } = {}) => {
    const queryParams = new URLSearchParams()
    if (params.hours !== undefined) {
      queryParams.append('hours', params.hours.toString())
    }
    if (params.order_numbers && params.order_numbers.length > 0) {
      params.order_numbers.forEach(order => queryParams.append('order_numbers', order))
    }
    const queryString = queryParams.toString()
    return api.post(`/basicdata/sync/${type}${queryString ? `?${queryString}` : ''}`)
  },
  getSyncStatus: () =>
    api.get('/basicdata/sync/status'),
  getSyncConfigStatus: () =>
    api.get('/basicdata/sync/config-status'),
  getErpOrders: () =>
    api.get('/basicdata/sync/erp-orders'),
  getSyncTask: (taskId: string) =>
    api.get(`/basicdata/sync/task/${taskId}`),
  listSyncTasks: (params?: { sync_type?: string; status?: string; limit?: number }) => {
    const queryParams = new URLSearchParams()
    if (params?.sync_type) queryParams.append('sync_type', params.sync_type)
    if (params?.status) queryParams.append('status', params.status)
    if (params?.limit) queryParams.append('limit', params.limit.toString())
    const qs = queryParams.toString()
    return api.get(`/basicdata/sync/tasks${qs ? `?${qs}` : ''}`)
  },
  exportWeeklyReport: () =>
    api.get('/basicdata/import-export/weekly-report', { responseType: 'blob' }),
  exportIssues: () =>
    api.get('/basicdata/import-export/issues', { responseType: 'blob' }),
}

export const dataSupplyApi = {
  listAvailableTypes: () => api.get('/basicdata/data-supply/configs/available-types'),
  dataTypeOptions: () => api.get('/basicdata/data-supply/data-type-options'),
  listConfigs: (params?: Record<string, any>) => api.get('/basicdata/data-supply/configs', { params }),
  createConfig: (data: Record<string, any>) => api.post('/basicdata/data-supply/configs', data),
  updateConfig: (configId: number, data: Record<string, any>) =>
    api.put(`/basicdata/data-supply/configs/${configId}`, data),
  deleteConfig: (configId: number) => api.delete(`/basicdata/data-supply/configs/${configId}`),
  listApiKeys: (params?: Record<string, any>) => api.get('/basicdata/data-supply/api-keys', { params }),
  createApiKey: (data: Record<string, any>) => api.post('/basicdata/data-supply/api-keys', data),
  updateApiKey: (keyId: number, data: Record<string, any>) =>
    api.put(`/basicdata/data-supply/api-keys/${keyId}`, data),
  deleteApiKey: (keyId: number) => api.delete(`/basicdata/data-supply/api-keys/${keyId}`),
  listEndpoints: () => api.get('/basicdata/data-supply/endpoints'),
  listExposableInternalEndpoints: () =>
    api.get('/basicdata/data-supply/exposable-internal-endpoints'),
  listCallLogs: (params?: Record<string, any>) => api.get('/basicdata/data-supply/call-logs', { params }),
  getStatistics: (params?: Record<string, any>) => api.get('/basicdata/data-supply/statistics', { params }),
}

// ============ 规则配置中心 ============
export const ruleApi = {
  list: () => api.get('/rules'),
  create: (data: any) => api.post('/rules', data),
  update: (id: number, data: any) => api.put(`/rules/${id}`, data),
}

export const documentApi = {
  listProductSamples: (params: Record<string, any> = {}) => api.get('/exceptions/product-samples', { params }),
  createProductSample: (data: Record<string, any>) => api.post('/exceptions/product-samples', data),
  updateProductSample: (id: number, data: Record<string, any>) => api.put(`/exceptions/product-samples/${id}`, data),
  deleteProductSample: (id: number) => api.delete(`/exceptions/product-samples/${id}`),
  listProductSampleVersions: (id: number) => api.get(`/exceptions/product-samples/${id}/versions`),
  publishProductSampleVersion: (id: number, data: Record<string, any>) => api.post(`/exceptions/product-samples/${id}/versions`, data),
  publishProductSample: (id: number) => api.post(`/exceptions/product-samples/${id}/publish`),
  archiveProductSample: (id: number) => api.post(`/exceptions/product-samples/${id}/archive`),
  listOrderStandards: (params: Record<string, any> = {}) => api.get('/rules/order-standards', { params }),
  createOrderStandard: (data: Record<string, any>) => api.post('/rules/order-standards', data),
  updateOrderStandard: (id: number, data: Record<string, any>) => api.put(`/rules/order-standards/${id}`, data),
  deleteOrderStandard: (id: number) => api.delete(`/rules/order-standards/${id}`),
  listOrderStandardVersions: (id: number) => api.get(`/rules/order-standards/${id}/versions`),
  publishOrderStandardVersion: (id: number, data: Record<string, any>) => api.post(`/rules/order-standards/${id}/versions`, data),
  publishOrderStandard: (id: number) => api.post(`/rules/order-standards/${id}/publish`),
  archiveOrderStandard: (id: number) => api.post(`/rules/order-standards/${id}/archive`),
  listWorkInstructions: (params: Record<string, any> = {}) => api.get('/rules/work-instructions', { params }),
  createWorkInstruction: (data: Record<string, any>) => api.post('/rules/work-instructions', data),
  updateWorkInstruction: (id: number, data: Record<string, any>) => api.put(`/rules/work-instructions/${id}`, data),
  deleteWorkInstruction: (id: number) => api.delete(`/rules/work-instructions/${id}`),
  listWorkInstructionVersions: (id: number) => api.get(`/rules/work-instructions/${id}/versions`),
  publishWorkInstructionVersion: (id: number, data: Record<string, any>) => api.post(`/rules/work-instructions/${id}/versions`, data),
  publishWorkInstruction: (id: number) => api.post(`/rules/work-instructions/${id}/publish`),
  archiveWorkInstruction: (id: number) => api.post(`/rules/work-instructions/${id}/archive`),
}

export const inspectionRuleApi = {
  list: (params: Record<string, any> = {}) => api.get('/rules/inspections', { params }),
  create: (data: any) => api.post('/rules/inspections', data),
  update: (id: number, data: any) => api.put(`/rules/inspections/${id}`, data),
  delete: (id: number) => api.delete(`/rules/inspections/${id}`),
}

export const nodeStandardApi = {
  list: (params: Record<string, any> = {}) => api.get('/rules/node-standards', { params }),
  create: (data: any) => api.post('/rules/node-standards', data),
  update: (id: number, data: any) => api.put(`/rules/node-standards/${id}`, data),
  delete: (id: number) => api.delete(`/rules/node-standards/${id}`),
}

export const responsibilityApi = {
  list: (params: Record<string, any> = {}) => api.get('/rules/responsibilities', { params }),
  create: (data: any) => api.post('/rules/responsibilities', data),
  update: (id: number, data: any) => api.put(`/rules/responsibilities/${id}`, data),
  delete: (id: number) => api.delete(`/rules/responsibilities/${id}`),
}

export const statusDictApi = {
  list: (params: Record<string, any> = {}) => api.get('/rules/status-dict', { params }),
  create: (data: any) => api.post('/rules/status-dict', data),
  update: (id: number, data: any) => api.put(`/rules/status-dict/${id}`, data),
  delete: (id: number) => api.delete(`/rules/status-dict/${id}`),
}

// ============ 审计日志 (基础数据与集成中心) ============
export const auditApi = {
  list: (params: Record<string, any>) => api.get('/basicdata/audit/logs', { params }),
}

// ============ Pilot ============
export const pilotApi = {
  getConfig: () => api.get('/pilot/config'),
  updateConfig: (items: any[]) => api.put('/pilot/config', { items }),
}

// ============ 通用文件服务 ============
export const fileApi = {
  upload: (file: File, namespace = 'misc') => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post(`/files/upload?namespace=${encodeURIComponent(namespace)}`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  list: (params: Record<string, any> = {}) => api.get('/files', { params }),
  stats: () => api.get('/files/stats'),
  remove: (id: number) => api.delete(`/files/${id}`),
  cleanupOrphans: (days = 7) => api.post(`/files/cleanup-orphans?days=${days}`),
  downloadUrl: (key: string) => `/api/v1/files/download/${key}`,
}

// ============ 问题反馈 (基础数据与集成中心) ============
export const feedbackApi = {
  list: (params: Record<string, any> = {}) => api.get('/basicdata/feedback', { params }),
  get: (id: number) => api.get(`/basicdata/feedback/${id}`),
  create: (data: Record<string, any>) => api.post('/basicdata/feedback', data),
  update: (id: number, data: Record<string, any>) => api.put(`/basicdata/feedback/${id}`, data),
  reply: (id: number, data: { reply?: string; status?: string }) =>
    api.post(`/basicdata/feedback/${id}/reply`, data),
  updateStatus: (id: number, status: string) =>
    api.patch(`/basicdata/feedback/${id}/status`, { status }),
  remove: (id: number) => api.delete(`/basicdata/feedback/${id}`),
}

// ============ 智能助手 ============
export const assistantApi = {
  chat: (message: string, sessionId?: string, conversationHistory?: any[]) =>
    api.post('/assistant/chat', { 
      message, 
      session_id: sessionId,
      conversation_history: conversationHistory 
    }),
  chatStream: (message: string, sessionId?: string, conversationHistory?: any[]) => {
    const token = useAuthStore.getState().currentToken
    return fetch('/api/v1/assistant/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        message,
        session_id: sessionId,
        conversation_history: conversationHistory,
      }),
    })
  },
  listSkills: () => api.get('/assistant/skills'),
}

// ============ 公告管理 (基础数据与集成中心) ============
export const announcementApi = {
  list: (params: Record<string, any> = {}) => api.get('/basicdata/announcements', { params }),
  create: (data: Record<string, any>) => api.post('/basicdata/announcements', data),
  update: (id: number, data: Record<string, any>) => api.put(`/basicdata/announcements/${id}`, data),
  remove: (id: number) => api.delete(`/basicdata/announcements/${id}`),
  publish: (id: number) => api.post(`/basicdata/announcements/${id}/publish`),
}

// ============ 通知中心 ============
export const notificationApi = {
  list: (params: Record<string, any> = {}) => api.get('/notifications', { params }),
  unreadCount: () => api.get('/notifications/unread-count'),
  markRead: (id: number) => api.post(`/notifications/${id}/read`),
  markAllRead: (type?: string) => api.post('/notifications/read-all', null, { params: type ? { type } : {} }),
  create: (data: { title: string; content: string; type?: string; priority?: string }) => api.post('/notifications', data),
}

// ============ 用户管理 (基础数据与集成中心) ============
export const userApi = {
  list: (params?: any) => api.get('/basicdata/users', { params }),
  roles: (params?: Record<string, any>) => api.get('/basicdata/users/roles', { params }),
  employeeOptions: (params?: { keyword?: string }) => api.get('/basicdata/users/employee-options', { params }),
  createRole: (data: { role_code: string; role_name: string; permissions?: Record<string, string[]> }) =>
    api.post('/basicdata/users/roles', data),
  updateRole: (id: number, data: { role_name?: string; permissions?: Record<string, string[]> }) =>
    api.put(`/basicdata/users/roles/${id}`, data),
  deleteRole: (id: number) => api.delete(`/basicdata/users/roles/${id}`),
  create: (data: { username: string; display_name?: string; password: string; role_id?: number; emp_code?: string; supplier_name?: string; is_active?: boolean }) =>
    api.post('/basicdata/users', data),
  update: (id: number, data: { display_name?: string; role_id?: number; emp_code?: string; supplier_name?: string; is_active?: boolean }) =>
    api.put(`/basicdata/users/${id}`, data),
  resetPassword: (id: number, new_password: string) =>
    api.put(`/basicdata/users/${id}/password`, { new_password }),
  delete: (id: number) => api.delete(`/basicdata/users/${id}`),
  batchGrant: (data: { role_ids: number[]; permissions: Record<string, string[]>; mode: 'grant' | 'revoke' | 'replace' }) =>
    api.post('/basicdata/users/roles/batch-grant', data),
  syncRoles: () => api.post('/basicdata/users/sync-roles'),
  listUnprovisionedEmployees: (params?: { keyword?: string; org_name?: string; position_name?: string; page?: number; page_size?: number }) =>
    api.get('/basicdata/users/unprovisioned-employees', { params }),
  batchProvision: (data: { emp_codes: string[]; role_id?: number; default_password?: string }) =>
    api.post('/basicdata/users/batch-provision', data),
  batchToggleActive: (data: { user_ids?: number[]; is_active: boolean; filter?: { role_code?: string; is_active?: boolean; keyword?: string; org_name?: string; position_name?: string; supplier_name?: string } }) =>
    api.put('/basicdata/users/batch/toggle-active', data),
  batchResetPassword: (data: { user_ids?: number[]; filter?: { role_code?: string; is_active?: boolean; keyword?: string; org_name?: string; position_name?: string; supplier_name?: string } }) =>
    api.put('/basicdata/users/batch/reset-password', data),
  batchDelete: (data: { user_ids?: number[]; filter?: { role_code?: string; is_active?: boolean; keyword?: string; org_name?: string; position_name?: string; supplier_name?: string } }) =>
    api.post('/basicdata/users/batch/delete', data),
}

// ============ 页面分享 ============
export const shareApi = {
  create: (data: { target_path: string; target_params?: object; expires_in?: string; permissions?: string[] }) =>
    api.post('/share', data),
  verify: (token: string) => api.get(`/share/${token}`),
  list: () => api.get('/share/list'),
  revoke: (id: number) => api.delete(`/share/${id}`),
}


