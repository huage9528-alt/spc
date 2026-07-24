import api from './api'

// 生产协同中心 API（从 services/api.ts 拆出，纯搬运）
export const productionApi = {
  // 生产总览
  getOverview: () => api.get('/production/overview'),
  getKpiSummary: () => api.get('/production/kpi-summary'),
  getTodayCards: () => api.get('/production/kpi-summary/today-cards'),
  getWorkshopOverview: (params: Record<string, any>) => api.get('/production/kpi-summary/workshop-overview', { params }),
  listSchedulePlans: (params: Record<string, any>) => api.get('/production/schedule-plans', { params }),
  createSchedulePlan: (data: Record<string, any>) => api.post('/production/schedule-plans', data),
  updateSchedulePlan: (id: number, data: Record<string, any>) => api.put(`/production/schedule-plans/${id}`, data),
  getDeleteSchedulePlanPreview: (id: number, params?: Record<string, any>) =>
    api.get(`/production/schedule-plans/${id}/delete-preview`, { params }),
  confirmDeleteSchedulePlan: (id: number, data: { reason?: string; execute_backfill?: boolean; break_frozen_reason?: string }) =>
    api.post(`/production/schedule-plans/${id}/delete-confirm`, data),
  deleteSchedulePlan: (id: number, params?: Record<string, any>) =>
    api.delete(`/production/schedule-plans/${id}`, { params }),
  executeDeleteBackfill: (data: { items: Array<{ plan_id: number; suggested_plan_date: string }>; remark?: string }) =>
    api.post('/production/schedule-plans/backfill/execute', data),
  // 重新排产
  reschedulePreview: (
    planId: number,
    targetDate: string,
    manpower?: number,
    dailyWorkHours?: number,
  ) =>
    api.post(`/production/schedule-plans/${planId}/reschedule-preview`, null, {
      params: { target_date: targetDate, manpower, daily_work_hours: dailyWorkHours },
      timeout: 60000,
    }),
  reschedulePlan: (
    planId: number,
    targetDate?: string,
    breakFrozenReason?: string,
    manpower?: number,
    dailyWorkHours?: number,
  ) =>
    api.post(`/production/schedule-plans/${planId}/reschedule`, null, {
      params: {
        target_date: targetDate,
        break_frozen_reason: breakFrozenReason,
        manpower,
        daily_work_hours: dailyWorkHours,
      },
      timeout: 120000,
    }),
  listSchedulePlanHistory: (params: { order_no: string; line_no: string }) =>
    api.get('/production/schedule-plans/history', { params }),
  // 订单池用于排产
  getOrdersForScheduling: (params: Record<string, any>) => api.get('/production/schedule-plans/orders-for-scheduling', { params }),
  getTodoWorkbench: (params: Record<string, any>) => api.get('/production/schedule-plans/todo-workbench', { params }),
  refreshTodoSnapshots: (data: Record<string, any>) => api.post('/production/schedule-plans/todo-workbench/refresh-snapshots', data),
  // 获取工作时间配置
  getWorkHoursConfig: () => api.get('/production/schedule-plans/work-hours-config'),
  // 查询产能时间槽使用情况
  getCapacityUsage: (params: {
    department: string
    schedule_bucket: string
    start_date: string
    end_date: string
    daily_capacity?: number
  }) => api.get('/production/schedule-plans/capacity-usage', { params }),
  simulateLeanSchedule: (data: Record<string, any>) => api.post('/production/schedule-plans/simulate-lean', data),
  // 一键排产
  autoSchedule: (data: Record<string, any>) => api.post('/production/schedule-plans/auto-schedule', data, { timeout: 120000 }),
  batchAutoSchedule: (data: Record<string, any>) => api.post('/production/schedule-plans/batch-auto-schedule', data, { timeout: 300000 }),
  // 检测变更
  detectScheduleChanges: () => api.post('/production/schedule-plans/detect-changes'),
  // UPPH 变更影响
  listChangeEvents: (params: Record<string, any>) => api.get('/production/schedule-plans/change-events', { params }),
  updateChangeEventStatus: (data: { event_ids: string[]; process_status: string; remark?: string }) =>
    api.post('/production/schedule-plans/change-events/status', data),
  listUpphImpactPlans: (params: Record<string, any>) => api.get('/production/schedule-plans/upph-impact', { params }),
  batchReschedulePlans: (data: { plan_ids: number[], all_or_none?: boolean }) => api.post('/production/schedule-plans/batch-reschedule', data),
  listOperationLogs: (params: Record<string, any>) => api.get('/production/schedule-plans/operation-logs', { params }),
  getScheduleDebugTrace: (params: { order_no: string; line_no: string }) =>
    api.get('/production/schedule-plans/debug-trace', { params }),
  // 缺少UPPH的产品
  listMissingUpphProducts: (params: Record<string, any>) => api.get('/production/schedule-plans/missing-upph-products', { params }),
  // 前道管理
  listFrontProcess: (params: Record<string, any>) =>
    api.get('/production/front-process', { params }),
  createFrontProcess: (data: Record<string, any>) =>
    api.post('/production/front-process', data),
  updateFrontProcess: (id: number, data: Record<string, any>) =>
    api.put(`/production/front-process/${id}`, data),
  importFrontProcess: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/production/front-process/import', fd)
  },
  // 贴片管理
  listSMT: (params: Record<string, any>) =>
    api.get('/production/smt', { params }),
  createSMT: (data: Record<string, any>) =>
    api.post('/production/smt', data),
  updateSMT: (id: number, data: Record<string, any>) =>
    api.put(`/production/smt/${id}`, data),
  importSMT: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/production/smt/import', fd)
  },
  // 精益管理
  listLean: (params: Record<string, any>) =>
    api.get('/production/lean', { params }),
  createLean: (data: Record<string, any>) =>
    api.post('/production/lean', data),
  updateLean: (id: number, data: Record<string, any>) =>
    api.put(`/production/lean/${id}`, data),
  importLean: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/production/lean/import', fd)
  },
  // 组装管理
  listAssembly: (params: Record<string, any>) =>
    api.get('/production/assembly', { params }),
  createAssembly: (data: Record<string, any>) =>
    api.post('/production/assembly', data),
  updateAssembly: (id: number, data: Record<string, any>) =>
    api.put(`/production/assembly/${id}`, data),
  importAssembly: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/production/assembly/import', fd)
  },
  // 包装管理
  listPackaging: (params: Record<string, any>) =>
    api.get('/production/packaging', { params }),
  createPackaging: (data: Record<string, any>) =>
    api.post('/production/packaging', data),
  updatePackaging: (id: number, data: Record<string, any>) =>
    api.put(`/production/packaging/${id}`, data),
  importPackaging: (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return api.post('/production/packaging/import', fd)
  },
  // 工序异常池
  listExceptions: (params: Record<string, any>) =>
    api.get('/production/exceptions', { params }),
  createException: (data: Record<string, any>) =>
    api.post('/production/exceptions', data),
  updateException: (id: number, data: Record<string, any>) =>
    api.put(`/production/exceptions/${id}`, data),
  deleteException: (id: number) =>
    api.delete(`/production/exceptions/${id}`),
  // 产品工序产能
  listProductProcessCapacities: (params: Record<string, any>) => api.get('/production/product-process-capacities', { params }),
  syncProductProcessCapacitiesFromOA: () => api.post('/production/product-process-capacities/sync-oa'),
  createProductProcessCapacity: (data: Record<string, any>) => api.post('/production/product-process-capacities', data),
  updateProductProcessCapacity: (id: number, data: Record<string, any>) => api.put(`/production/product-process-capacities/${id}`, data),
  deleteProductProcessCapacity: (id: number) => api.delete(`/production/product-process-capacities/${id}`),
  listUpphFormulaConfigs: (params: Record<string, any> = {}) => api.get('/production/upph-formula-configs', { params }),
  createUpphFormulaConfig: (data: Record<string, any>) => api.post('/production/upph-formula-configs', data),
  updateUpphFormulaConfig: (id: number, data: Record<string, any>) => api.put(`/production/upph-formula-configs/${id}`, data),
  deleteUpphFormulaConfig: (id: number) => api.delete(`/production/upph-formula-configs/${id}`),
}
