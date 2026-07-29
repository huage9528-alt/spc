// SchedulePlans 模块常量（从 index.tsx 抽出，纯搬运，值未变更）

export const DEPARTMENTS = ['计划', '采购', '生产', '品质', '仓储']

export const BUCKET_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'lean', label: '精益' },
  { value: 'assembly', label: '装配-组装' },
  { value: 'packaging', label: '装配-包装' },
  { value: 'mixed', label: '组装+包装' },
  { value: 'pending', label: '待确认' },
]

export const PLAN_BUCKET_VIEW_OPTIONS = [
  { key: 'all', label: '全部计划' },
  { key: 'lean', label: '精益页面' },
  { key: 'assembly', label: '组装页面' },
  { key: 'packaging', label: '包装页面' },
]

export const TODO_FILTER_OPTIONS = [
  { value: 'all', label: '全部待处理' },
  { value: 'reschedule', label: '待重排' },
  { value: 'ready', label: '待排产' },
  { value: 'pending', label: '待确认' },
]

export const TODO_BUCKET_WORKSPACE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'lean', label: '精益' },
  { value: 'assembly', label: '组装' },
  { value: 'packaging', label: '包装' },
]

export const PLAN_SCOPE_OPTIONS = [
  { value: 'active', label: '当前计划' },
  { value: 'reschedule', label: '待重排' },
  { value: 'history', label: '历史计划' },
]

export const EVENT_TYPE_OPTIONS = [
  { value: 'all', label: '全部事件' },
  { value: 'upph_change', label: 'UPPH变化' },
  { value: 'bucket_change', label: '排产段变化' },
  { value: 'due_date_change', label: '交期变化' },
  { value: 'quantity_change', label: '数量变化' },
]

export interface StatusMeta {
  label: string
  color: string
}

export const STATUS_MAP: Record<string, StatusMeta> = {
  planned: { label: '已计划', color: 'blue' },
  in_progress: { label: '执行中', color: 'processing' },
  completed: { label: '已完成', color: 'success' },
  delayed: { label: '延期', color: 'warning' },
  cancelled: { label: '已取消', color: 'default' },
}

export const PRIORITY_MAP: Record<string, StatusMeta> = {
  low: { label: '低', color: 'default' },
  normal: { label: '普通', color: 'blue' },
  high: { label: '高', color: 'orange' },
  urgent: { label: '紧急', color: 'red' },
}

export const RISK_MAP: Record<string, StatusMeta> = {
  red: { label: '红色', color: 'red' },
  yellow: { label: '黄色', color: 'gold' },
  blue: { label: '蓝色', color: 'blue' },
  green: { label: '绿色', color: 'green' },
}

export interface ImpactMeta {
  label: string
  color: string
  priority: number
}

export const IMPACT_MAP: Record<string, ImpactMeta> = {
  high: { label: '高', color: 'red', priority: 1 },
  medium: { label: '中', color: 'orange', priority: 2 },
  low: { label: '低', color: 'blue', priority: 3 },
}

export const EVENT_TYPE_MAP: Record<string, StatusMeta> = {
  upph_change: { label: 'UPPH变化', color: 'purple' },
  bucket_change: { label: '排产段变化', color: 'magenta' },
  due_date_change: { label: '交期变化', color: 'gold' },
  quantity_change: { label: '数量变化', color: 'cyan' },
}

export const DELIVERY_STATUS_MAP: Record<string, StatusMeta> = {
  delayed: { label: '已延期', color: 'red' },
  upcoming: { label: '临期', color: 'orange' },
  normal: { label: '正常', color: 'green' },
  early: { label: '提前', color: 'blue' },
  unknown: { label: '待确认', color: 'default' },
}

export const BUCKET_COLOR_MAP: Record<string, string> = {
  lean: 'blue',
  assembly: 'purple',
  packaging: 'cyan',
  mixed: 'gold',
  pending: 'default',
}

export const ORDER_POOL_STATUS_COLOR_MAP: Record<string, string> = {
  ready: 'success',
  pending: 'warning',
  excluded: 'error',
  scheduled: 'processing',
}

export const TODO_STATUS_META: Record<string, { label: string; color: string; priority: number }> = {
  reschedule: { label: '待重排', color: 'error', priority: 0 },
  ready: { label: '待排产', color: 'processing', priority: 1 },
  pending: { label: '待确认', color: 'warning', priority: 2 },
  excluded: { label: '缺产能(需补UPPH)', color: 'error', priority: 3 },
}

export const ORDER_STAT_CARD_STYLE_MAP: Record<string, { background: string; border: string }> = {
  ready: { background: '#e6f4ff', border: '#91caff' },
  pending: { background: '#fff7e6', border: '#ffd591' },
  excluded: { background: '#fafafa', border: '#d9d9d9' },
  scheduled: { background: '#f6ffed', border: '#b7eb8f' },
  missing_upph: { background: '#fff1f0', border: '#ffa39e' },
}

export const LEAN_CAPACITY_LOAD_MAP: Record<string, StatusMeta> = {
  normal: { label: '正常', color: 'success' },
  overtime: { label: '需加班', color: 'warning' },
  sunday_production: { label: '周日生产', color: 'processing' },
  move_earlier: { label: '需前挪', color: 'error' },
  capacity_overflow: { label: '产能超限', color: 'error' },
}

export const PAGE_CACHE_TTL_MS = 30 * 1000
