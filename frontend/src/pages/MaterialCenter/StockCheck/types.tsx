// 物料盘点共享类型与小组件（列表页 index.tsx 与工作台 Workbench.tsx 共用）
// 注意: 本文件为 .tsx（含 JSX 小组件），import 路径统一用 './types' 即可解析
import type { ReactNode } from 'react'
import { Tooltip } from 'antd'

export interface StockCheckItem {
  id: number
  check_id: number
  line_no?: string | null
  level?: number | null
  material_id?: number | null
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  material_property_label?: string | null
  material_type?: string | null
  warehouses?: string | null
  wh_id?: number | null
  wh_name?: string | null
  wh_code?: string | null
  recent_checked_check_no?: string | null
  recent_checked_date?: string | null
  req_qty?: number | null
  system_qty?: number | null
  system_qty_time?: string | null
  live_qty?: number | null
  live_wh_names?: string | null
  snapshot_live?: boolean | null
  warehouse_display?: string | null
  actual_qty?: number | null
  diff_qty?: number | null
  is_checked?: number | null
  checked_at?: string | null
  checked_by?: string | null
  remark?: string | null
  force_recount?: boolean
  audit_failed?: number | null
  appeal_status?: 'pending' | 'accepted' | 'rejected' | null
  appeal_reason?: string | null
  appeal_at?: string | null
  version?: number | null
}

export interface MyStockCheckItem {
  item_id: number
  check_id: number
  check_no: string
  order_no?: string | null
  title?: string | null
  check_type?: string | null
  status?: string | null
  check_date?: string | null
  completed_at?: string | null
  material_id?: number | null
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  wh_id?: number | null
  wh_name?: string | null
  wh_code?: string | null
  system_qty?: number | null
  actual_qty?: number | null
  diff_qty?: number | null
  counted_by_user_id?: number | null
  counted_by?: string | null
  counted_at?: string | null
  recent_checked_check_no?: string | null
  recent_checked_date?: string | null
}

export interface CoveredProduct {
  product_code?: string | null
  bom_no?: string | null
  line_no?: string | null
  product_name?: string | null
  order_qty?: number | null
}

export interface CoChecker {
  user_id: number
  name: string
}

export interface StockCheck {
  id: number
  check_no: string
  order_no?: string | null
  title?: string | null
  check_type?: string | null
  status?: string | null
  source?: string | null
  check_date?: string | null
  total_materials?: number | null
  checked_materials?: number | null
  total_diff_qty?: number | null
  created_by?: string | null
  created_by_user_id?: number | null
  checked_by?: string | null
  created_at?: string | null
  updated_at?: string | null
  completed_at?: string | null
  gain_count?: number | null
  loss_count?: number | null
  writeback_pending?: number | null
  writeback_failed?: number | null
  pending_appeals?: number | null
  remark?: string | null
  covered_products?: CoveredProduct[] | null
  co_checker_user_ids?: number[] | null
  co_checkers?: CoChecker[] | null
  can_edit?: boolean | null
  items?: StockCheckItem[]
  audit_status?: string | null
  audit_by?: string | null
  audit_at?: string | null
  audit_comment?: string | null
  version?: number | null
}

// 抽检处置历史（GET /materials/stock-check/{id}/audit-logs）
export interface StockCheckAuditItemLog {
  item_id: number
  audit_qty: number
  actual_qty_snapshot?: number | null
  matches?: number | null
}

export interface StockCheckAuditLog {
  id: number
  check_id: number
  round_no: number
  action: 'pass' | 'pass_exemption' | 'reject' | 'flag'
  comment?: string | null
  rejected_item_ids?: number[] | null
  operated_by_user_id?: number | null
  operated_by?: string | null
  created_at?: string | null
  items: StockCheckAuditItemLog[]
}

export interface MaterialCandidate {
  erp_material_id: number
  material_code?: string | null
  material_name?: string | null
  spec_model?: string | null
  unit?: string | null
  system_qty?: number | null
  // wh_id === undefined 表示旧版池数据(整物料全仓库); null 表示未入库合成行
  wh_id?: number | null
  wh_code?: string | null
  wh_name?: string | null
  recent_checked_check_no?: string | null
  recent_checked_date?: string | null
}

export interface MaterialHistoryItem {
  check_no: string
  order_no: string
  customer?: string | null
  status: string
  check_date?: string | null
  completed_at?: string | null
  actual_qty?: number | null
  created_at?: string | null
  created_by?: string | null
}

export interface StockCheckKpiData {
  status_counts: Record<string, number>
  in_progress_checks: number
  week_new_checks: number
  week_new_by_type: Record<string, number>
  pending_gain_count: number
  pending_loss_count: number
  recent7_checked_materials: number
  writeback_todo_checks?: number
}

// 标签变体（对照原型 styles.css 的 tag 配色）
export type ScTagVariant = 'wait' | 'kit' | 'prod' | 'done' | 'cancel' | 'purple' | 'amber' | 'warn' | 'plain'

export function ScTag({ variant, children, dot }: { variant: ScTagVariant; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`sc-tag sc-tag-${variant}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  )
}

export const STATUS_MAP: Record<string, { label: string; variant: ScTagVariant }> = {
  open: { label: '待盘点', variant: 'wait' },
  in_progress: { label: '进行中', variant: 'prod' },
  completed: { label: '已完成', variant: 'done' },
  cancelled: { label: '已取消', variant: 'cancel' },
}

export const AVATAR_COLORS = ['#5b5bd6', '#0ea5e9', '#f59e0b', '#8b5cf6', '#64748b']

export function checkTypeTag(t?: string | null, source?: string | null): { label: string; variant: ScTagVariant } {
  if (source === 'k3') return { label: 'K3', variant: 'amber' }
  if (t === 'quick') return { label: '快捷', variant: 'purple' }
  if (t === 'manual') return { label: '手动', variant: 'wait' }
  return { label: '订单', variant: 'kit' }
}

// 叠罗汉头像组: 首字取名, 色板按 user_id 取模, 超出 max 显示 +n
export function AvatarStack({ users, max = 3 }: { users: { user_id: number; name: string }[]; max?: number }) {
  if (!users || users.length === 0) return <span className="sc-diff-flat">—</span>
  const shown = users.slice(0, max)
  const rest = users.length - shown.length
  return (
    <Tooltip title={users.map((u) => u.name).join('、')} placement="top">
      <span className="sc-avatar-group">
        {shown.map((u) => (
          <span
            key={u.user_id}
            className="sc-avatar-sm"
            style={{ background: AVATAR_COLORS[Math.abs(u.user_id) % AVATAR_COLORS.length] }}
          >
            {(u.name || '?').charAt(0)}
          </span>
        ))}
        {rest > 0 && <span className="more-n">+{rest}</span>}
      </span>
    </Tooltip>
  )
}

// 盈/亏双色对: 全 0 显示「盘平」灰, 为 0 的一侧渲染灰 —
export function DiffPair({ gain, loss }: { gain?: number | null; loss?: number | null }) {
  const g = gain ?? 0
  const l = loss ?? 0
  if (!g && !l) return <span className="sc-diff-flat">盘平</span>
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {g ? <span className="sc-diff-up">盈 {g}</span> : <span className="sc-diff-flat">—</span>}
      <span className="sc-diff-flat"> · </span>
      {l ? <span className="sc-diff-down">亏 {l}</span> : <span className="sc-diff-flat">—</span>}
    </span>
  )
}

export interface StockCheckWriteback {
  id: number
  check_id: number
  bill_type: 'gain' | 'loss_transfer'
  wh_id: number
  wh_code?: string | null
  wh_name?: string | null
  status: 'pending' | 'success' | 'failed'
  erp_bill_no?: string | null
  k3_inter_id?: number | null
  item_count: number
  total_qty: number
  error_msg?: string | null
  retry_count: number
  created_by?: string | null
  created_at?: string | null
  written_at?: string | null
}

export interface WritebackSkippedItem {
  material_code?: string | null
  material_name?: string | null
  unit?: string | null
  diff_qty: number
  reason?: string | null
}

export interface WritebackOverview {
  writebacks: StockCheckWriteback[]
  skipped_items: WritebackSkippedItem[]
}
