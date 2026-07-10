// 生产协同中心 — 占位
// 子页面: 372 驾驶舱、生产总览、前道管理、贴片管理、精益管理、组装管理、包装管理、工序异常池

import { Navigate } from 'react-router-dom'

export default function ProductionCenter() {
  return <Navigate to="/production-dashboard" replace />
}
