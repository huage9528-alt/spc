// 生产协同中心共享常量
//
// 命名约定：按业务域分层，不同状态机不可混用（key 命名相近但语义不同）。
// - PROCESS_STATUS_MAP   工序类页面（SMT/Lean/Assembly/Packaging/FrontProcess/ProductionOverview）
// - SCHEDULE_STATUS_MAP  排产计划（SchedulePlans）—— 暂留本地，待 1b 拆分时迁入
// - EXCEPTION_STATUS_MAP 工序异常池（ProcessExceptions）—— 暂留本地，待后续统一

export interface StatusMeta {
  label: string
  color: string
}

// 工序类页面共用状态映射（6 个文件原本各自定义，已收敛到此处）
// 注意：key `pending` 的业务语义是「进行中」，保留以兼容后端返回值，不要按字面意思改写。
export const PROCESS_STATUS_MAP: Record<string, StatusMeta> = {
  completed: { label: '已完成', color: 'success' },
  pending: { label: '进行中', color: 'processing' },
  overdue: { label: '逾期', color: 'error' },
  abnormal: { label: '异常', color: 'warning' },
}
