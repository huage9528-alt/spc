import api from './api'

export const purchaseApi = {
  // 调价单 CRUD
  list: (params: Record<string, any>) => api.get('/purchase/price-change', { params }),
  get: (id: number) => api.get(`/purchase/price-change/${id}`),
  create: (data: Record<string, any>) => api.post('/purchase/price-change', data),
  update: (id: number, data: Record<string, any>) => api.put(`/purchase/price-change/${id}`, data),
  delete: (id: number) => api.delete(`/purchase/price-change/${id}`),

  // 审批
  submit: (id: number) => api.post(`/purchase/price-change/${id}/submit`),
  aiAnalyze: (id: number) => api.post(`/purchase/price-change/${id}/ai-analyze`),
  approve: (id: number, comment: string, expectedVersion?: number) =>
    api.post(`/purchase/price-change/${id}/approve`, { comment, expected_version: expectedVersion }),
  reject: (id: number, comment: string, expectedVersion?: number) =>
    api.post(`/purchase/price-change/${id}/reject`, { comment, expected_version: expectedVersion }),
  recall: (id: number) => api.post(`/purchase/price-change/${id}/recall`),
  revokeApproval: (id: number) => api.post(`/purchase/price-change/${id}/revoke-approval`),

  // 查询
  pending: () => api.get('/purchase/price-change/pending'),
  myApproved: (params?: Record<string, any>) => api.get('/purchase/price-change/my-approved', { params }),
  lastPrice: (materialCode: string, supplierCode: string) =>
    api.get('/purchase/price-change/supplier-last-price', {
      params: { material_code: materialCode, supplier_code: supplierCode },
    }),
  materialPriceHistory: (materialCode: string) =>
    api.get('/purchase/price-change/erp-material-prices', {
      params: { material_code: materialCode },
    }),
  searchSuppliers: (keyword: string, page = 1) =>
    api.get('/purchase/price-change/suppliers/search', { params: { keyword, page, page_size: 10 } }),
  searchEmployees: (keyword: string, page = 1) =>
    api.get('/purchase/price-change/employees/search', { params: { keyword, page, page_size: 10 } }),
  searchMaterials: (keyword: string, page = 1, pageSize = 15) =>
    api.get('/purchase/price-change/materials/search', { params: { keyword, page, page_size: pageSize } }),

  // 自检
  selfCheckPreview: (data: Record<string, any>) =>
    api.post('/purchase/price-change/self-check-preview', data),
  selfCheckRecord: (id: number) =>
    api.post(`/purchase/price-change/${id}/self-check`),
}
