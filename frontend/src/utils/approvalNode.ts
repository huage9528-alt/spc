// 审批节点操作权判定：admin 旁路；动态 approvers 优先，其次固定 role。
export function canApproveNode(user: any, node: any): boolean {
  if (!user || !node) return false
  if ('role_code' in user && user.role_code === 'admin') return true
  const approvers = node.approvers
  if (Array.isArray(approvers)) {
    return approvers.some((a: any) => a.username === user.username || String(a.user_id) === String(user.id))
  }
  const role = node.role
  if (role && role !== '__dept_manager__') {
    return 'role_code' in user && user.role_code === role
  }
  return false
}
