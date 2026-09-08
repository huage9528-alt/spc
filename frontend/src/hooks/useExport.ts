import { useState } from 'react'
import { message } from 'antd'
import axios from 'axios'
import { useAuthStore } from '../store/auth'
import { downloadBlob } from '../utils'

/**
 * 通用导出 Hook
 * @returns { exporting, exportData }
 *
 * 用法:
 *   const { exporting, exportData } = useExport()
 *   exportData('/api/v1/materials/purchase-plan/export', { keyword: '...', format: 'xlsx' }, 'purchase_plan.xlsx')
 */
export function useExport() {
  const [exporting, setExporting] = useState(false)

  const exportData = async (
    url: string,
    params: Record<string, any>,
    filename: string,
  ) => {
    setExporting(true)
    try {
      const token = useAuthStore.getState().currentToken
      const res = await axios.get(url, {
        params,
        responseType: 'blob',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      downloadBlob(res.data, filename)
      message.success('导出成功')
    } catch {
      message.error('导出失败')
    } finally {
      setExporting(false)
    }
  }

  const exportPostData = async (
    url: string,
    body: Record<string, any>,
    filename: string,
  ) => {
    setExporting(true)
    try {
      const token = useAuthStore.getState().currentToken
      const res = await axios.post(url, body, {
        responseType: 'blob',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      downloadBlob(res.data, filename)
      message.success('导出成功')
    } catch {
      message.error('导出失败')
    } finally {
      setExporting(false)
    }
  }

  return { exporting, exportData, exportPostData }
}

export default useExport
