import { useState, useEffect, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import {
  Table, Button, Modal, Form, Input, Select, Space, message,
  Popconfirm, Tag, Switch, Tabs, Card, Row, Col, DatePicker,
  Typography, Tooltip, Alert, InputNumber, Badge, Empty, Collapse, Steps,
} from 'antd'
import {
  PlusOutlined, CopyOutlined, ApiOutlined,
  BarChartOutlined, KeyOutlined, ReloadOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined,
  SafetyCertificateOutlined,
  ExclamationCircleOutlined, BookOutlined, DownloadOutlined,
  CodeOutlined, LockOutlined, WarningOutlined,
} from '@ant-design/icons'
import { dataSupplyApi } from '../../../services/api'
import PermButton from '../../../components/PermButton'
import { useAuthStore } from '../../../store/auth'
import dayjs from 'dayjs'

const { Text } = Typography
const { RangePicker } = DatePicker

// 兼容 HTTP 环境的复制函数
const copyToClipboard = (text: string) => {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => message.success('已复制'))
  } else {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    message.success('已复制')
  }
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

const StatCard = ({ icon, color, title, value, suffix, trend }: {
  icon: ReactNode; color: string; title: string; value: ReactNode; suffix?: ReactNode; trend?: { value: string; up: boolean }
}) => (
  <div
    style={{
      background: `linear-gradient(135deg, ${color}0f 0%, ${color}03 100%)`,
      borderRadius: 12,
      padding: '16px 18px',
      border: `1px solid ${color}18`,
      boxShadow: `0 2px 8px ${color}08, 0 1px 3px rgba(0,0,0,0.03)`,
      transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
      position: 'relative',
      overflow: 'hidden',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.transform = 'translateY(-2px)';
      e.currentTarget.style.boxShadow = `0 8px 20px ${color}15, 0 4px 8px rgba(0,0,0,0.06)`;
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.transform = 'translateY(0)';
      e.currentTarget.style.boxShadow = `0 2px 8px ${color}08, 0 1px 3px rgba(0,0,0,0.03)`;
    }}
  >
    <div style={{
      position: 'absolute',
      top: -20,
      right: -20,
      width: 80,
      height: 80,
      borderRadius: '50%',
      background: `radial-gradient(circle, ${color}10 0%, transparent 70%)`,
    }} />
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, position: 'relative', zIndex: 1 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `linear-gradient(135deg, ${color}25 0%, ${color}0d 100%)`,
        boxShadow: `inset 0 1px 2px ${color}10, 0 2px 6px ${color}10`,
      }}>
        <span style={{ color, fontSize: 'calc(1.25rem * var(--font-size-scale))', display: 'flex' }}>{icon}</span>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 'calc(0.78125rem * var(--font-size-scale))', color: '#8c8c8c', marginBottom: 4, fontWeight: 500, letterSpacing: 0.2 }}>{title}</div>
        <div style={{ fontSize: 'calc(1.5rem * var(--font-size-scale))', fontWeight: 700, color, lineHeight: 1.15, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
          {value}{suffix && <span style={{ fontSize: 'calc(0.84375rem * var(--font-size-scale))', fontWeight: 400, marginLeft: 6, color: '#8c8c8c' }}>{suffix}</span>}
        </div>
        {trend && (
          <div style={{ marginTop: 6, fontSize: 'calc(0.75rem * var(--font-size-scale))', color: trend.up ? '#52c41a' : '#ff4d4f', display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 'calc(0.625rem * var(--font-size-scale))' }}>{trend.up ? '▲' : '▼'}</span>
            {trend.value}
          </div>
        )}
      </div>
    </div>
  </div>
)

// 代码块：带语言标签 + 一键复制
const CodeBlock = ({ code, lang = 'python' }: { code: string; lang?: string }) => {
  const { Text } = Typography
  return (
    <div style={{ position: 'relative', margin: '12px 0' }}>
      <div style={{
        background: '#1e1e1e', borderRadius: 10, overflow: 'hidden',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 16px', background: '#2d2d2d', borderBottom: '1px solid #3d3d3d',
        }}>
          <Tag color="geekblue" style={{ margin: 0, fontSize: 'calc(0.6875rem * var(--font-size-scale))' }}>{lang}</Tag>
          <Button
            size="small" type="text" icon={<CopyOutlined />}
            onClick={() => copyToClipboard(code)}
            style={{ color: '#9cdcfe' }}
          />
        </div>
        <pre style={{
          margin: 0, padding: '16px 20px', overflow: 'auto',
          fontSize: 'calc(0.78125rem * var(--font-size-scale))', lineHeight: 1.7, fontFamily: 'Consolas, Monaco, "Courier New", monospace',
          color: '#d4d4d4', background: '#1e1e1e',
        }}>
          <code>{code}</code>
        </pre>
      </div>
    </div>
  )
}

// 键值对描述表（替代手写 HTML table）
const DescTable = ({ rows, columns = 2 }: {
  rows: { label: ReactNode; value: ReactNode }[]
  columns?: 2 | 3
}) => {
  const cols = columns
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gap: 12, borderRadius: 12, padding: 4,
    }}>
      {rows.map((r, i) => (
        <div key={i} style={{
          background: '#fafbfc', padding: '14px 16px',
          display: 'flex', flexDirection: 'column', gap: 6, minHeight: 56,
          justifyContent: 'center', borderRadius: 8,
          border: '1px solid #f0f1f5',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = '#f5f7fa';
          e.currentTarget.style.borderColor = '#e4e7ed';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = '#fafbfc';
          e.currentTarget.style.borderColor = '#f0f1f5';
        }}
        >
          <Text type="secondary" style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', fontWeight: 500 }}>{r.label}</Text>
          <div style={{ fontSize: 'calc(0.8125rem * var(--font-size-scale))' }}>{r.value}</div>
        </div>
      ))}
    </div>
  )
}


interface ApiKeyItem {
  id: number
  key_name: string
  app_key: string | null
  description: string | null
  is_active: boolean
  allowed_endpoints_json: string | null
  rate_limit: number
  expires_at: string | null
  ip_whitelist_json: string | null
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

interface CallLogItem {
  id: number
  api_key_id: number | null
  api_key_name: string | null
  data_type: string
  request_params_json: string | null
  response_status: number | null
  response_count: number
  ip_address: string | null
  user_agent: string | null
  duration_ms: number | null
  error_message: string | null
  called_at: string | null
}

interface Statistics {
  total_calls: number
  success_calls: number
  failed_calls: number
  failure_rate?: number | null
  rate_limited_calls?: number
  p95_duration_ms?: number | null
  avg_duration_ms: number | null
  by_data_type: Record<string, number>
  by_endpoint?: Record<string, number>
  by_date: Record<string, number>
  by_api_key: Record<string, number>
}

const ENDPOINT_TEMPLATES: { name: string; prefixes: string[] }[] = [
  { name: '主数据只读', prefixes: ['customers.', 'suppliers.', 'materials.', 'products.', 'warehouses.', 'locations.', 'processes.', 'organizations.', 'positions.', 'employees.'] },
  { name: '生产域', prefixes: ['schedule_plans.', 'process_exceptions.', 'process_progress.', 'production_task_orders.', 'boms.', 'bom_details.'] },
  { name: '供需域', prefixes: ['orders.', 'order_details.', 'purchase_orders.', 'inventory.'] },
]

export default function DataSupply() {
  const [activeTab, setActiveTab] = useState('api-keys')
  const [loading, setLoading] = useState(false)

  // ── 对外接口清单（供 API Key 勾选接口权限） ──
  interface EndpointOption {
    endpoint_code: string
    name: string
    description: string
    method: string
    path: string
    tags: string[]
  }
  const [endpointOptions, setEndpointOptions] = useState<EndpointOption[]>([])
  const endpointLabelMap = useMemo(
    () => Object.fromEntries(endpointOptions.map(e => [e.endpoint_code, e.name])),
    [endpointOptions]
  )

  const [internalEndpointOptions, setInternalEndpointOptions] = useState<EndpointOption[]>([])

  // ── API Key ──
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([])
  const [apiKeyTotal, setApiKeyTotal] = useState(0)
  const [apiKeyPage, setApiKeyPage] = useState(1)
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false)
  const [editingApiKey, setEditingApiKey] = useState<ApiKeyItem | null>(null)
  const [apiKeyForm] = Form.useForm()
  const [newKeyModalOpen, setNewKeyModalOpen] = useState(false)
  const [newKeyInfo, setNewKeyInfo] = useState<{ app_key: string; app_secret: string } | null>(null)
  const [apiKeySaving, setApiKeySaving] = useState(false)

  // ── 调用日志 ──
  const [callLogs, setCallLogs] = useState<CallLogItem[]>([])
  const [callLogTotal, setCallLogTotal] = useState(0)
  const [callLogPage, setCallLogPage] = useState(1)
  const [logFilters, setLogFilters] = useState<{ data_type?: string; dateRange?: any }>({})

  // ── 统计 ──
  const [statistics, setStatistics] = useState<Statistics | null>(null)
  const hasPermission = useAuthStore(s => s.hasPermission)
  const canDelete = hasPermission('basicdata.data_supply', 'delete')

  // ═══════════════════════════════════════════
  // 数据加载
  // ═══════════════════════════════════════════

  const fetchEndpoints = useCallback(async () => {
    try {
      const res: any = await dataSupplyApi.listEndpoints()
      setEndpointOptions(res.data || [])
    } catch { /* silent */ }
  }, [])

  const fetchApiKeys = useCallback(async () => {
    setLoading(true)
    try {
      const res: any = await dataSupplyApi.listApiKeys({ page: apiKeyPage, page_size: 20 })
      setApiKeys(res.data?.items || [])
      setApiKeyTotal(res.data?.total || 0)
    } catch { /* 错误已由全局拦截器提示 */ }
    setLoading(false)
  }, [apiKeyPage])

  const fetchCallLogs = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = { page: callLogPage, page_size: 20 }
      if (logFilters.data_type) params.data_type = logFilters.data_type
      if (logFilters.dateRange) {
        params.start_date = logFilters.dateRange[0].format('YYYY-MM-DD')
        params.end_date = logFilters.dateRange[1].format('YYYY-MM-DD')
      }
      const res: any = await dataSupplyApi.listCallLogs(params)
      setCallLogs(res.data?.items || [])
      setCallLogTotal(res.data?.total || 0)
    } catch { /* 错误已由全局拦截器提示 */ }
    setLoading(false)
  }, [callLogPage, logFilters])

  const fetchStatistics = useCallback(async () => {
    try {
      const params: any = {}
      if (logFilters.data_type) params.data_type = logFilters.data_type
      if (logFilters.dateRange) {
        params.start_date = logFilters.dateRange[0].format('YYYY-MM-DD')
        params.end_date = logFilters.dateRange[1].format('YYYY-MM-DD')
      }
      const res: any = await dataSupplyApi.getStatistics(params)
      setStatistics(res.data || null)
    } catch { /* silent */ }
  }, [logFilters])

  useEffect(() => {
    // 首次加载时获取对外接口清单
    fetchEndpoints()
  }, [fetchEndpoints])

  useEffect(() => {
    if (activeTab === 'api-keys') {
      fetchApiKeys()
    } else if (activeTab === 'call-logs') {
      fetchCallLogs()
      fetchStatistics()
    } else if (activeTab === 'guide') {
      // 切换到使用说明 tab 时刷新对外接口清单，自动获取新添加的接口
      fetchEndpoints()
    }
  }, [activeTab, fetchApiKeys, fetchCallLogs, fetchStatistics, fetchEndpoints])

  useEffect(() => {
    if (!apiKeyModalOpen) return
    dataSupplyApi.listExposableInternalEndpoints()
      .then((res: any) => {
        const list = res?.data?.data || res?.data || []
        setInternalEndpointOptions(list)
      })
      .catch(() => setInternalEndpointOptions([]))
  }, [apiKeyModalOpen])

  // ═══════════════════════════════════════════
  // API Key 操作
  // ═══════════════════════════════════════════

  const applyEndpointTemplate = (prefixes: string[]) => {
    const codes = endpointOptions
      .filter(e => prefixes.some(p => e.endpoint_code.startsWith(p)))
      .map(e => e.endpoint_code)
    apiKeyForm.setFieldValue('allowed_endpoints', codes)
    if (codes.length) {
      message.success(`已按模板勾选 ${codes.length} 个对外接口`)
    } else {
      message.warning('该模板未匹配到任何接口，请确认接口清单已加载')
    }
  }

  const handleCreateApiKey = () => {
    setEditingApiKey(null)
    apiKeyForm.resetFields()
    apiKeyForm.setFieldsValue({ rate_limit: 100 })
    setApiKeyModalOpen(true)
  }

  const handleEditApiKey = (key: ApiKeyItem) => {
    setEditingApiKey(key)
    const allAllowed = key.allowed_endpoints_json ? JSON.parse(key.allowed_endpoints_json) : []
    const externalAllowed = allAllowed.filter((s: string) => !s.startsWith('int:'))
    const internalAllowed = allAllowed.filter((s: string) => s.startsWith('int:'))
    apiKeyForm.setFieldsValue({
      key_name: key.key_name,
      description: key.description,
      allowed_endpoints: externalAllowed,
      allowed_internal_endpoints: internalAllowed,
      rate_limit: key.rate_limit,
      expires_at: key.expires_at ? dayjs(key.expires_at) : undefined,
      ip_whitelist: key.ip_whitelist_json ? JSON.parse(key.ip_whitelist_json).join('\n') : '',
    })
    setApiKeyModalOpen(true)
  }

  const handleSaveApiKey = async () => {
    if (apiKeySaving) return
    setApiKeySaving(true)
    try {
      const values = await apiKeyForm.validateFields()
      // 解析 IP 白名单
      const ipList = values.ip_whitelist
        ? values.ip_whitelist.split('\n').map((s: string) => s.trim()).filter(Boolean)
        : []

      if (editingApiKey) {
        const updateData: any = {
          key_name: values.key_name,
          description: values.description,
          allowed_endpoints_json: JSON.stringify([
            ...(values.allowed_endpoints || []),
            ...(values.allowed_internal_endpoints || []),
          ]),
          rate_limit: values.rate_limit,
          ip_whitelist_json: JSON.stringify(ipList),
        }
        if (values.expires_at) {
          updateData.expires_at = values.expires_at.toISOString()
        }
        await dataSupplyApi.updateApiKey(editingApiKey.id, updateData)
        message.success('API Key 已更新')
      } else {
        const createData: any = {
          key_name: values.key_name,
          description: values.description,
          allowed_endpoints_json: JSON.stringify([
            ...(values.allowed_endpoints || []),
            ...(values.allowed_internal_endpoints || []),
          ]),
          rate_limit: values.rate_limit,
          ip_whitelist_json: JSON.stringify(ipList),
        }
        if (values.expires_at) {
          createData.expires_at = values.expires_at.toISOString()
        }
        const res: any = await dataSupplyApi.createApiKey(createData)
        message.success('API Key 已创建')
        const data = res.data || res
        setNewKeyInfo(data.app_key ? { app_key: data.app_key, app_secret: data.app_secret } : null)
        setNewKeyModalOpen(true)
      }
      setApiKeyModalOpen(false)
      fetchApiKeys()
    } catch (e: any) {
      if (e.errorFields) return
      // 错误已由全局拦截器提示
    } finally {
      setApiKeySaving(false)
    }
  }

  const handleToggleApiKey = async (key: ApiKeyItem) => {
    try {
      await dataSupplyApi.updateApiKey(key.id, { is_active: !key.is_active })
      message.success(key.is_active ? '已禁用' : '已启用')
      fetchApiKeys()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  const handleDeleteApiKey = async (id: number) => {
    try {
      await dataSupplyApi.deleteApiKey(id)
      message.success('已删除')
      fetchApiKeys()
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  // ═══════════════════════════════════════════
  // 渲染
  // ═══════════════════════════════════════════

  // ── Tab 2: API Key 管理 ──
  const renderApiKeysTab = () => (
    <div>
      {newKeyModalOpen && (
        <Modal
          open
          title={<span><ExclamationCircleOutlined style={{ color: '#faad14', marginRight: 8 }} />API Key 已创建</span>}
          width={620}
          centered
          footer={[
            <Button key="copyall" icon={<CopyOutlined />} onClick={() => {
              const all = newKeyInfo
                ? `AppKey: ${newKeyInfo.app_key}\nAppSecret: ${newKeyInfo.app_secret}`
                : ''
              copyToClipboard(all)
            }}>复制全部</Button>,
            <Button key="ok" type="primary" danger onClick={() => { setNewKeyModalOpen(false); setNewKeyInfo(null) }}>
              我已保存，关闭
            </Button>,
          ]}
          closable={false}
          maskClosable={false}
        >
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="以下信息仅显示一次，关闭后无法再次查看，请立即复制保存！"
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {newKeyInfo && (
              <Row gutter={16}>
                <Col span={12}>
                  <div style={{
                    background: 'linear-gradient(135deg, #f6ffed 0%, #f0fff0 100%)',
                    border: '1px solid #b7eb8f', borderRadius: 10,
                    padding: '16px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <Text type="secondary" style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', fontWeight: 500 }}>AppKey（签名认证标识）</Text>
                      <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copyToClipboard(newKeyInfo.app_key)} />
                    </div>
                    <Text code style={{ fontSize: 'calc(0.8125rem * var(--font-size-scale))', wordBreak: 'break-all', background: 'transparent', border: 'none', padding: 0 }}>{newKeyInfo.app_key}</Text>
                  </div>
                </Col>
                <Col span={12}>
                  <div style={{
                    background: 'linear-gradient(135deg, #fff7e6 0%, #fff2e8 100%)',
                    border: '1px solid #ffd591', borderRadius: 10,
                    padding: '16px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <Text type="secondary" style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', fontWeight: 500 }}>AppSecret（密钥，务必保密）</Text>
                      <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copyToClipboard(newKeyInfo.app_secret)} />
                    </div>
                    <Text code style={{ fontSize: 'calc(0.8125rem * var(--font-size-scale))', wordBreak: 'break-all', background: 'transparent', border: 'none', padding: 0 }}>{newKeyInfo.app_secret}</Text>
                  </div>
                </Col>
              </Row>
            )}
          </div>
        </Modal>
      )}

      <div>
        {/* 顶部工具栏 */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
          padding: '14px 18px',
          background: 'linear-gradient(135deg, #f6f9ff 0%, #f9f0ff 100%)',
          borderRadius: 12,
          border: '1px solid #e6eaff',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'linear-gradient(135deg, #1890ff25 0%, #722ed125 100%)',
              boxShadow: '0 2px 8px rgba(24, 144, 255, 0.15)',
            }}>
              <SafetyCertificateOutlined style={{ fontSize: 'calc(1.125rem * var(--font-size-scale))', color: '#1890ff' }} />
            </div>
            <div>
              <div style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937', lineHeight: 1.2 }}>API Key 列表</div>
              <div style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', color: '#8c8c8c', marginTop: 2 }}>
                共 {apiKeyTotal} 个 · 已启用 {apiKeys.filter(k => k.is_active).length} 个
              </div>
            </div>
          </div>
          <PermButton permResource="basicdata.data_supply" permAction="create" type="primary" icon={<PlusOutlined />} onClick={handleCreateApiKey} style={{
            boxShadow: '0 2px 8px rgba(24, 144, 255, 0.3)',
          }}>
            创建 API Key
          </PermButton>
        </div>

        <Table
          className="data-supply-table"
          dataSource={apiKeys}
          rowKey="id"
          loading={loading}
          pagination={{ current: apiKeyPage, total: apiKeyTotal, pageSize: 20, onChange: setApiKeyPage, showTotal: t => `共 ${t} 条` }}
          size="middle"
          scroll={{ x: 1000 }}
          rowClassName={(_, index) => index! % 2 === 0 ? 'row-even' : 'row-odd'}
          onRow={(record) => ({
            style: { transition: 'all 0.2s ease' },
          })}
          showSorterTooltip={false}
          columns={[
            {
              title: '名称',
              dataIndex: 'key_name',
              key: 'key_name',
              width: 200,
              render: (v: string, r: ApiKeyItem) => (
                <div>
                  <Space size={6}>
                    <Text strong={r.is_active} style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))' }}>{v}</Text>
                    {!r.is_active && <Tag color="default" style={{ margin: 0 }}>已禁用</Tag>}
                  </Space>
                  {r.description && (
                    <div style={{ marginTop: 4 }}>
                      <Text type="secondary" style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{r.description}</Text>
                    </div>
                  )}
                </div>
              ),
            },
            {
              title: '凭据',
              key: 'credentials',
              width: 260,
              render: (_: any, r: ApiKeyItem) => (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Space size={4}>
                    <Text type="secondary" style={{ fontSize: 'calc(0.6875rem * var(--font-size-scale))', fontWeight: 500 }}>AppKey</Text>
                    <span style={{
                      background: '#f5f7fa',
                      padding: '2px 8px',
                      borderRadius: 4,
                      fontSize: 'calc(0.75rem * var(--font-size-scale))',
                      fontFamily: 'Consolas, monospace',
                      color: '#595959',
                    }}>
                      {r.app_key || '-'}
                    </span>
                    {r.app_key && (
                      <Tooltip title="复制 AppKey">
                        <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copyToClipboard(r.app_key!)} />
                      </Tooltip>
                    )}
                  </Space>
                  <Text type="secondary" style={{ fontSize: 'calc(0.6875rem * var(--font-size-scale))' }}>签名认证，AppSecret 仅创建时可见</Text>
                </div>
              ),
            },
            {
              title: '访问权限',
              key: 'permissions',
              width: 280,
              render: (_: any, r: ApiKeyItem) => {
                const parseArr = (s: string | null) => {
                  if (!s) return null
                  try { const a = JSON.parse(s); return Array.isArray(a) && a.length ? a : null } catch { return null }
                }
                const eps = parseArr(r.allowed_endpoints_json)
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div>
                      <Text type="secondary" style={{ fontSize: 'calc(0.6875rem * var(--font-size-scale))', fontWeight: 500 }}>对外接口：</Text>
                      {!eps ? <Tag style={{ margin: 0 }}>无</Tag> : (
                        <Space wrap size={4}>
                          {eps.slice(0, 3).map((code: string) => (
                            <Tag key={code} color="purple" style={{ margin: 0 }}>{endpointLabelMap[code] || code}</Tag>
                          ))}
                          {eps.length > 3 && (
                            <Tooltip title={eps.map((code: string) => endpointLabelMap[code] || code).join('、')}>
                              <Tag style={{ margin: 0 }}>+{eps.length - 3}</Tag>
                            </Tooltip>
                          )}
                        </Space>
                      )}
                    </div>
                  </div>
                )
              },
            },
            {
              title: '访问限制',
              key: 'limits',
              width: 170,
              render: (_: any, r: ApiKeyItem) => {
                let ipTag = <Tag color="green" style={{ margin: 0 }}>不限</Tag>
                if (r.ip_whitelist_json) {
                  try {
                    const ips = JSON.parse(r.ip_whitelist_json)
                    if (ips.length) ipTag = <Tooltip title={ips.join(', ')}><Tag color="blue" style={{ margin: 0 }}>{ips.length} IP</Tag></Tooltip>
                  } catch { /* keep default */ }
                }
                let expireNode: ReactNode = <Tag color="green" style={{ margin: 0 }}>永久</Tag>
                if (r.expires_at) {
                  const isExpired = new Date(r.expires_at) < new Date()
                  expireNode = (
                    <Text type={isExpired ? 'danger' : undefined} style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>
                      {r.expires_at.slice(0, 10)}{isExpired && ' 过期'}
                    </Text>
                  )
                }
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>
                    <Space size={6}><ClockCircleOutlined style={{ color: '#8c8c8c' }} /><Text style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{r.rate_limit}/min</Text></Space>
                    <Space size={6}><SafetyCertificateOutlined style={{ color: '#8c8c8c' }} />{ipTag}</Space>
                    <Space size={6}><ExclamationCircleOutlined style={{ color: '#8c8c8c' }} />{expireNode}</Space>
                  </div>
                )
              },
            },
            {
              title: '状态',
              key: 'status',
              width: 80,
              render: (_: any, r: ApiKeyItem) => (
                <Switch checked={r.is_active} onChange={() => handleToggleApiKey(r)} size="small" />
              ),
            },
            {
              title: '操作',
              key: 'action',
              width: 110,
              fixed: 'right' as const,
              render: (_: any, r: ApiKeyItem) => (
                <Space>
                  <PermButton permResource="basicdata.data_supply" permAction="update" size="small" type="link" onClick={() => handleEditApiKey(r)}>编辑</PermButton>
                  <Popconfirm title="确认删除此 API Key？" onConfirm={() => handleDeleteApiKey(r.id)} disabled={!canDelete}>
                    <PermButton permResource="basicdata.data_supply" permAction="delete" size="small" type="link" danger>删除</PermButton>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

      <Modal
        title={editingApiKey ? '编辑 API Key' : '创建 API Key'}
        open={apiKeyModalOpen}
        onOk={handleSaveApiKey}
        onCancel={() => { setApiKeyModalOpen(false); setEditingApiKey(null) }}
        confirmLoading={apiKeySaving}
        okText={apiKeySaving ? '保存中...' : '确定'}
        width={640}
        destroyOnClose
      >
        <Form form={apiKeyForm} layout="vertical">
          <Form.Item name="key_name" label="名称（外部系统名）" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：MES系统、WMS系统" />
          </Form.Item>
          <Form.Item name="description" label="用途说明">
            <Input.TextArea rows={2} placeholder="描述此 Key 的用途" />
          </Form.Item>
          <Form.Item
            label="允许调用的对外接口"
            tooltip="控制 /external/* 下各业务接口的调用权限，未勾选则无法调用任何对外接口"
          >
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', fontWeight: 500 }}>权限模板：</Text>
              {ENDPOINT_TEMPLATES.map(tpl => {
                const count = endpointOptions.filter(e => tpl.prefixes.some(p => e.endpoint_code.startsWith(p))).length
                return (
                  <Tooltip key={tpl.name} title={`按前缀批量勾选：${tpl.prefixes.join('、')}`}>
                    <Button size="small" onClick={() => applyEndpointTemplate(tpl.prefixes)}>
                      {tpl.name}{count > 0 ? `（${count}）` : ''}
                    </Button>
                  </Tooltip>
                )
              })}
              <Tooltip title={`勾选全部 ${endpointOptions.length} 个对外接口`}>
                <Button size="small" onClick={() => apiKeyForm.setFieldValue('allowed_endpoints', endpointOptions.map(e => e.endpoint_code))}>
                  全量只读（{endpointOptions.length}）
                </Button>
              </Tooltip>
              <Button size="small" danger onClick={() => apiKeyForm.setFieldValue('allowed_endpoints', [])}>
                清空
              </Button>
            </div>
            <Form.Item name="allowed_endpoints" noStyle>
              <Select
              mode="multiple"
              placeholder="选择允许调用的对外接口"
              optionLabelProp="label"
              options={endpointOptions.map(e => ({
                value: e.endpoint_code,
                label: e.name,
                title: `${e.method} ${e.path} — ${e.description}`,
              }))}
              optionRender={(option) => {
                const ep = endpointOptions.find(e => e.endpoint_code === option.value)
                if (!ep) return option.label
                return (
                  <Space direction="vertical" size={0}>
                    <Space size={6}>
                      <Tag color="blue" style={{ margin: 0 }}>{ep.method}</Tag>
                      <Text strong>{ep.name}</Text>
                      {ep.tags?.map(t => <Tag key={t} style={{ margin: 0 }}>{t}</Tag>)}
                    </Space>
                    <Text type="secondary" style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{ep.path}</Text>
                  </Space>
                )
              }}
            />
            </Form.Item>
          </Form.Item>
          <Form.Item
            name="allowed_internal_endpoints"
            label="允许调用的内部接口"
            tooltip="控制 @exposable 标记的内部接口的调用权限，使用 int: 前缀；与对外接口在同一字段"
          >
            <Select
              mode="multiple"
              placeholder="选择允许调用的内部接口"
              optionLabelProp="label"
              options={internalEndpointOptions.map(e => ({
                value: e.endpoint_code,
                label: e.name,
                title: `${e.method} ${e.path} — ${e.description}`,
              }))}
              optionRender={(option) => {
                const ep = internalEndpointOptions.find(e => e.endpoint_code === option.value)
                if (!ep) return option.label
                return (
                  <Space direction="vertical" size={0}>
                    <Space size={6}>
                      <Tag color="green" style={{ margin: 0 }}>{ep.method}</Tag>
                      <Text strong>{ep.name}</Text>
                      {ep.tags?.map(t => <Tag key={t} style={{ margin: 0 }}>{t}</Tag>)}
                    </Space>
                    <Text type="secondary" style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{ep.path}</Text>
                  </Space>
                )
              }}
            />
          </Form.Item>
          <Form.Item name="rate_limit" label="速率限制（每分钟请求数，0 表示不限）" rules={[{ required: true, message: '请输入速率限制' }]}>
            <InputNumber min={0} max={10000} style={{ width: '100%' }} placeholder="100" />
          </Form.Item>
          <Form.Item name="ip_whitelist" label="IP 白名单（每行一个，留空则不限制）" tooltip="限制允许调用的来源 IP，留空表示不限制">
            <Input.TextArea rows={3} placeholder={"192.168.1.100\n10.0.0.0/24"} />
          </Form.Item>
          <Form.Item name="expires_at" label="过期时间（可选）">
            <DatePicker
              showTime
              style={{ width: '100%' }}
              placeholder="不选则永不过期"
              disabledDate={(current) => current && current < dayjs().startOf('day')}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )

  // ── Tab 3: 调用日志 ──
  const renderCallLogsTab = () => {
    const successRate = statistics && statistics.total_calls > 0
      ? ((statistics.success_calls / statistics.total_calls) * 100).toFixed(1)
      : null

    return (
      <div>
        {/* 统计卡片 */}
        {statistics && (
          <>
          <Row gutter={12} style={{ marginBottom: 16 }}>
            <Col span={6}>
              <StatCard
                icon={<BarChartOutlined />}
                color="#1890ff"
                title="总调用次数"
                value={statistics.total_calls}
              />
            </Col>
            <Col span={6}>
              <StatCard
                icon={<CheckCircleOutlined />}
                color="#52c41a"
                title="成功 / 成功率"
                value={statistics.success_calls}
                suffix={successRate ? `(${successRate}%)` : ''}
              />
            </Col>
            <Col span={6}>
              <StatCard
                icon={<CloseCircleOutlined />}
                color={statistics.failed_calls ? '#ff4d4f' : '#bfbfbf'}
                title="失败"
                value={statistics.failed_calls}
              />
            </Col>
            <Col span={6}>
              <StatCard
                icon={<ClockCircleOutlined />}
                color="#722ed1"
                title="平均耗时"
                value={statistics.avg_duration_ms?.toFixed(1) || '-'}
                suffix="ms"
              />
            </Col>
          </Row>
          <Row gutter={12} style={{ marginBottom: 16, marginTop: 12 }}>
            <Col span={8}>
              <StatCard
                icon={<WarningOutlined />}
                color={statistics.failure_rate ? '#ff4d4f' : '#52c41a'}
                title="失败率"
                value={statistics.failure_rate != null ? (statistics.failure_rate * 100).toFixed(1) : '-'}
                suffix={statistics.failure_rate != null ? '%' : ''}
              />
            </Col>
            <Col span={8}>
              <StatCard
                icon={<ExclamationCircleOutlined />}
                color={statistics.rate_limited_calls ? '#fa8c16' : '#bfbfbf'}
                title="限流命中（429）"
                value={statistics.rate_limited_calls ?? 0}
              />
            </Col>
            <Col span={8}>
              <StatCard
                icon={<ClockCircleOutlined />}
                color="#13c2c2"
                title="P95 耗时"
                value={statistics.p95_duration_ms != null ? statistics.p95_duration_ms.toFixed(1) : '-'}
                suffix="ms"
              />
            </Col>
          </Row>
          </>
        )}

        {/* 筛选栏 */}
        <div style={{
          marginBottom: 16,
          padding: '12px 16px',
          background: '#fafbfc',
          borderRadius: 8,
          border: '1px solid #f0f0f0',
        }}>
          <Space wrap size={12}>
            <Select
              allowClear
              placeholder="按接口筛选（endpoint_code）"
              style={{ width: 220 }}
              showSearch
              optionFilterProp="value"
              options={endpointOptions.map(e => ({ value: e.endpoint_code, label: e.name }))}
              value={logFilters.data_type || undefined}
              onChange={(v) => {
                setCallLogPage(1)
                setLogFilters(prev => ({ ...prev, data_type: v }))
              }}
            />
            <RangePicker
              value={logFilters.dateRange || null}
              onChange={(dates) => {
                setCallLogPage(1)
                setLogFilters(prev => ({ ...prev, dateRange: dates }))
              }}
            />
            <Button
              icon={<ReloadOutlined />}
              onClick={() => { setLogFilters({}); setCallLogPage(1) }}
            >
              重置
            </Button>
          </Space>
        </div>

        {/* 按接口分布 */}
        {statistics && Object.keys(statistics.by_data_type).length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ marginBottom: 6, display: 'block', fontSize: 'calc(0.8125rem * var(--font-size-scale))' }}>按接口分布</Text>
            <Space wrap size={6}>
              {Object.entries(statistics.by_data_type)
                .sort(([, a], [, b]) => b - a)
                .map(([type, count]) => (
                  <Tag
                    key={type}
                    color="blue"
                    style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', padding: '3px 10px', borderRadius: 4 }}
                  >
                    {endpointLabelMap[type] || type}: <Text strong>{count}</Text>
                  </Tag>
                ))}
            </Space>
          </div>
        )}

        {/* 按 API Key 分布 */}
        {statistics && Object.keys(statistics.by_api_key).length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Text strong style={{ marginBottom: 6, display: 'block', fontSize: 'calc(0.8125rem * var(--font-size-scale))' }}>按 API Key 分布</Text>
            <Space wrap size={6}>
              {Object.entries(statistics.by_api_key)
                .sort(([, a], [, b]) => b - a)
                .map(([name, count]) => (
                  <Tag key={name} color="geekblue" style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))', padding: '3px 10px', borderRadius: 4 }}>
                    {name}: <Text strong>{count}</Text>
                  </Tag>
                ))}
            </Space>
          </div>
        )}

        <Table
          className="data-supply-table"
          dataSource={callLogs}
          rowKey="id"
          loading={loading}
          pagination={{
            current: callLogPage,
            total: callLogTotal,
            pageSize: 20,
            onChange: setCallLogPage,
            showTotal: t => `共 ${t} 条`,
          }}
          scroll={{ x: 1340 }}
          size="middle"
          rowClassName={(_, index) => index! % 2 === 0 ? 'row-even' : 'row-odd'}
          locale={{ emptyText: <Empty description="暂无调用日志" /> }}
          onRow={(record) => ({
            style: { transition: 'all 0.2s ease' },
          })}
          showSorterTooltip={false}
          columns={[
            {
              title: '时间',
              dataIndex: 'called_at',
              key: 'called_at',
              width: 170,
              render: (v: string) => v ? <Text style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{v.slice(0, 19).replace('T', ' ')}</Text> : '-',
            },
            {
              title: 'API Key',
              dataIndex: 'api_key_name',
              key: 'api_key_name',
              width: 140,
              render: (v: string | null) => v || <Text type="secondary">-</Text>,
            },
            {
              title: '接口',
              dataIndex: 'data_type',
              key: 'data_type',
              width: 160,
              render: (v: string) => (
                <Tag color="blue">
                  {endpointLabelMap[v] || v}
                </Tag>
              ),
            },
            {
              title: '状态',
              dataIndex: 'response_status',
              key: 'status',
              width: 80,
              render: (v: number | null) => {
                if (v === 200) return <Badge status="success" text="200" />
                if (v === 500) return <Badge status="error" text={String(v)} />
                return <Badge status="warning" text={String(v || '-')} />
              },
            },
            {
              title: '错误信息',
              dataIndex: 'error_message',
              key: 'error_message',
              width: 150,
              ellipsis: true,
              render: (v: string | null) => v ? (
                <Tooltip title={v}>
                  <Text type="danger" style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{v}</Text>
                </Tooltip>
              ) : <Text type="secondary">-</Text>,
            },
            {
              title: '返回条数',
              dataIndex: 'response_count',
              key: 'count',
              width: 90,
              render: (v: number) => <Text>{v}</Text>,
            },
            {
              title: '耗时',
              dataIndex: 'duration_ms',
              key: 'duration',
              width: 90,
              render: (v: number | null) => {
                if (!v) return '-'
                const ms = Number(v)
                const color = ms > 1000 ? '#ff4d4f' : ms > 500 ? '#faad14' : '#52c41a'
                return <Text style={{ color, fontWeight: 500 }}>{ms.toFixed(1)}ms</Text>
              },
            },
            {
              title: 'IP',
              dataIndex: 'ip_address',
              key: 'ip',
              width: 130,
              render: (v: string | null) => v ? <Text style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{v}</Text> : <Text type="secondary">-</Text>,
            },
            {
              title: '请求参数',
              dataIndex: 'request_params_json',
              key: 'params',
              ellipsis: true,
              render: (v: string | null) => v ? (
                <Tooltip title={v}>
                  <Text ellipsis style={{ maxWidth: 200, fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{v}</Text>
                </Tooltip>
              ) : <Text type="secondary">-</Text>,
            },
          ]}
        />
      </div>
    )
  }

  // ── Tab 4: 使用说明 ──
  const generateGuideMarkdown = () => {
    const host = window.location.host
    const externalBase = `http://${host}/api/v1/external`

    const endpointRows = endpointOptions.map(e =>
      `| ${e.endpoint_code} | ${e.name} | \`${e.method} ${e.path}\` | ${e.description} |`
    ).join('\n')

    const internalEndpointRows = internalEndpointOptions.map(e =>
      `| ${e.endpoint_code} | ${e.name} | \`${e.method} ${e.path}\` | ${e.description} |`
    ).join('\n')

    // ── 各对外接口的请求参数 / 响应字段明细（来自后端 endpoints/*.py 的实现） ──
    // 若字段变动，需同步更新此处
    const ENDPOINT_DETAILS: Record<string, {
      params: Array<[string, string, string]>
      fields: Array<[string, string]>
    }> = {
      'orders.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（订单号 / 客户 / 产品名 模糊匹配）'],
          ['status', '否', '订单状态，多选逗号分隔，如 open,closed'],
          ['customer_code', '否', '客户编码精确匹配'],
          ['risk_level', '否', '风险等级，多选逗号分隔，如 red,yellow'],
          ['promised_date_start', '否', '合同交期开始日期 YYYY-MM-DD'],
          ['promised_date_end', '否', '合同交期结束日期 YYYY-MM-DD'],
          ['updated_after', '否', '增量同步，仅返回 updated_at >= 此时间的记录 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['order_no', '订单号'], ['line_no', '订单行号'],
          ['customer', '客户名称'], ['customer_code', '客户编码'],
          ['product_code', '产品编码'], ['product_name', '产品名称'],
          ['order_qty', '订单数量'], ['completed_qty', '已完成数量'],
          ['order_amount', '订单金额'], ['status', '订单状态'],
          ['risk_level', '风险等级'], ['promised_date', '合同交期'],
          ['planned_start_date', '计划开始日期'], ['owner', '负责人'],
          ['updated_at', '更新时间'],
        ],
      },
      'boms.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['material_code', '否', '物料代码精确匹配（关联 scm_material）'],
          ['bom_no', '否', 'BOM 编号模糊匹配'],
          ['bom_version', '否', 'BOM 版本号精确匹配'],
          ['bom_type', '否', 'BOM 类型精确匹配'],
          ['use_status', '否', '使用状态精确匹配'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['bom_id', 'BOM ID'], ['bom_no', 'BOM 编号'],
          ['material_id', '物料 ERP ID'], ['material_code', '物料代码（带 material_code 时返回）'],
          ['material_name', '物料名称（带 material_code 时返回）'],
          ['parent_material_id', '父物料 ID'], ['bom_version', 'BOM 版本号'],
          ['bom_type', 'BOM 类型'], ['base_qty', '基本用量'],
          ['unit_id', '单位 ID'], ['use_status', '使用状态'],
          ['disabled_status', '禁用状态'], ['void_flag', '作废标志'],
          ['update_time', '更新时间'],
        ],
      },
      'bom_details.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['bom_id', '否', 'BOM ID 精确匹配'],
          ['material_id', '否', '物料 ID 精确匹配（BOM 明细中的物料）'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '明细ID'], ['bom_id', 'BOM ID'], ['bom_no', 'BOM 编号'],
          ['line_no', '行号'], ['material_id', '物料 ID'],
          ['material_code', '物料代码'], ['material_name', '物料名称'],
          ['standard_qty', '标准用量'], ['aux_qty', '辅助用量'],
          ['material_type', '物料类型'], ['config_type', '配置类型'],
          ['lead_offset_days', '提前期偏移天数'], ['back_flush', '倒冲标志'],
          ['scrap_rate', '损耗率'], ['oper_sn', '工序序号'],
          ['process_id', '工序 ID'], ['warehouse_id', '仓库 ID'],
          ['location_id', '库位 ID'], ['valid_date', '生效日期'],
          ['invalid_date', '失效日期'], ['unit_id', '单位 ID'],
          ['customer_bom_code', '客户 BOM 编码'], ['aux_attr_id', '辅助属性 ID'],
          ['material_size', '物料规格'], ['kit_flag', '套件标志'],
          ['data_source', '数据来源'], ['create_time', '创建时间'],
          ['update_time', '更新时间'],
        ],
      },
      'customers.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（客户编码 / 名称 / 简称 模糊匹配）'],
          ['customer_level', '否', '客户等级，多选逗号分隔'],
          ['industry_type', '否', '所属行业'],
          ['status', '否', '状态，多选逗号分隔 (1-启用 0-禁用)'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['customer_code', '客户编码'],
          ['customer_name', '客户名称'], ['customer_short', '客户简称'],
          ['customer_level', '客户等级'], ['industry_type', '所属行业'],
          ['credit_code', '统一社会信用代码'], ['status', '状态'],
          ['update_time', '更新时间'],
        ],
      },
      'suppliers.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（供应商编码 / 名称 / 简称 模糊匹配）'],
          ['supplier_type', '否', '供应商类型精确匹配'],
          ['status', '否', '状态，多选逗号分隔 (1-启用 0-禁用)'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['supplier_code', '供应商编码'],
          ['supplier_name', '供应商名称'], ['supplier_short', '供应商简称'],
          ['supplier_type', '供应商类型'], ['contact_person', '联系人'],
          ['contact_phone', '联系电话（脱敏 138****1234）'],
          ['payment_terms', '付款条件'], ['status', '状态'],
          ['update_time', '更新时间'],
        ],
      },
      'materials.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（物料编码 / 名称 / 规格型号 模糊匹配）'],
          ['material_type', '否', '物料分类精确匹配'],
          ['is_purchase', '否', '是否可采购 (0/1)'],
          ['is_produce', '否', '是否可生产 (0/1)'],
          ['status', '否', '状态，多选逗号分隔 (1-启用 0-禁用)'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['erp_material_id', 'ERP 物料 ID'],
          ['material_code', '物料编码'], ['material_name', '物料名称'],
          ['spec_model', '规格型号'], ['material_type', '物料分类'],
          ['unit_of_measure', '单位'], ['brand', '品牌'],
          ['is_purchase', '是否可采购'], ['is_produce', '是否可生产'],
          ['status', '状态'], ['supplier_id', '供应商 ERP ID'],
          ['supplier_name', '供应商名称'], ['order_unit_price', '采购单价'],
          ['last_outbound_date', '最近出库日期'], ['update_time', '更新时间'],
        ],
      },
      'products.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（产品编码模糊匹配）'],
          ['product_line', '否', '产品线精确匹配'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['product_code', '产品编码'],
          ['product_line', '产品线'], ['tech_version', '工艺版本'],
          ['bom_version', 'BOM 版本'], ['default_warehouse', '默认仓库'],
          ['warranty_days', '保修天数'], ['upph', 'UPPH（每小时产量）'],
          ['update_time', '更新时间'],
        ],
      },
      'purchase_orders.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（PO 号 / 物料名称 / 订单号 模糊匹配）'],
          ['po_status', '否', 'PO 状态，多选逗号分隔'],
          ['supplier_code', '否', '供应商编码精确匹配'],
          ['order_no', '否', '关联销售订单号精确匹配'],
          ['material_code', '否', '物料编码精确匹配'],
          ['eta_start', '否', 'ETA 开始日期 YYYY-MM-DD'],
          ['eta_end', '否', 'ETA 结束日期 YYYY-MM-DD'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['po_no', 'PO 号'], ['detail_id', '明细 ID'],
          ['order_no', '关联销售订单号'], ['material_code', '物料编码'],
          ['material_name', '物料名称'], ['spec_model', '规格型号'],
          ['material_type_name', '物料分类名称'], ['supplier_code', '供应商编码'],
          ['supplier_name', '供应商名称'], ['po_qty', '采购数量'],
          ['received_qty', '已收数量'], ['po_price', '采购单价'],
          ['unit', '单位'], ['po_date', 'PO 日期'],
          ['po_status', 'PO 状态'], ['eta', '预计到货日'],
          ['actual_arrival_date', '实际到货日'], ['inspection_date', '检验日'],
          ['owner', '负责人'], ['is_closed', '是否关闭'],
          ['updated_at', '更新时间'],
        ],
      },
      'schedule_plans.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（订单号 / 产品编码 模糊匹配）'],
          ['department', '否', '部门精确匹配'],
          ['status', '否', '计划状态，多选逗号分隔 (planned/confirmed/locked/in_progress/done/...)'],
          ['order_no', '否', '订单号精确匹配'],
          ['product_code', '否', '产品编码精确匹配'],
          ['plan_date_start', '否', '排产开始日期 YYYY-MM-DD'],
          ['plan_date_end', '否', '排产结束日期 YYYY-MM-DD'],
          ['include_inactive', '否', '是否包含历史版本 (1-是 0-否，默认 0 只返回 is_active=True)'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['department', '部门'], ['plan_date', '排产日期'],
          ['order_no', '订单号'], ['line_no', '订单行号'],
          ['product_code', '产品编码'], ['model_code', '型号编码'],
          ['quantity', '计划数量'], ['owner', '负责人'],
          ['start_date', '开始日期'], ['end_date', '结束日期'],
          ['priority', '优先级'], ['status', '状态'],
          ['upph', 'UPPH'], ['plan_version', '计划版本'],
          ['is_active', '是否生效版本'], ['confirmed_by', '确认人'],
          ['confirmed_at', '确认时间'], ['updated_at', '更新时间'],
        ],
      },
      'organizations.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（oa_org_id / org_name 模糊匹配）'],
          ['org_type', '否', '组织类型精确匹配'],
          ['status', '否', '状态，多选逗号分隔 (1-启用 0-禁用)'],
        ],
        fields: [
          ['oa_org_id', 'OA 组织 ID'], ['org_name', '组织名称'],
          ['org_type', '组织类型'], ['parent_code', '父组织 OA ID'],
          ['leader_name', '负责人姓名'], ['status', '状态'],
        ],
      },
      'positions.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（position_code / position_name 模糊匹配）'],
          ['status', '否', '状态，多选逗号分隔 (1-启用 0-禁用)'],
        ],
        fields: [
          ['id', '记录ID'], ['position_code', '岗位编码'],
          ['position_name', '岗位名称'], ['status', '状态'],
        ],
      },
      'employees.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（oa_user_id / emp_name 模糊匹配）'],
          ['org_id', '否', '组织 oa_org_id 筛选'],
          ['position_code', '否', '岗位编码筛选'],
          ['status', '否', '状态，多选逗号分隔'],
        ],
        fields: [
          ['id', '记录ID'], ['oa_user_id', 'OA 用户 ID'],
          ['emp_name', '员工姓名'], ['org_id', '组织 OA ID'],
          ['org_name', '组织名称'], ['position_name', '岗位名称'],
          ['phone', '手机号（脱敏）'], ['email', '邮箱'],
          ['status', '状态'],
        ],
      },
      'organizations.employees': {
        params: [
          ['oa_org_id', '是', '组织 OA ID（路径参数），返回该组织及其所有子组织下的员工'],
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（oa_user_id / emp_name 模糊匹配）'],
          ['position_code', '否', '岗位编码筛选'],
          ['status', '否', '状态，多选逗号分隔'],
        ],
        fields: [
          ['id', '记录ID'], ['oa_user_id', 'OA 用户 ID'],
          ['emp_name', '员工姓名'], ['org_id', '组织 OA ID'],
          ['org_name', '组织名称'], ['position_name', '岗位名称'],
          ['phone', '手机号（脱敏）'], ['email', '邮箱'],
          ['status', '状态'],
        ],
      },
      'inventory.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（物料编码 / 物料名称 / 仓库名称 模糊匹配）'],
          ['material_code', '否', '物料编码精确匹配'],
          ['wh_code', '否', '仓库编码精确匹配'],
          ['batch_no', '否', '批次号精确匹配'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['material_id', '物料 ID'],
          ['material_code', '物料编码'], ['material_name', '物料名称'],
          ['wh_id', '仓库 ID'], ['wh_code', '仓库编码'],
          ['wh_name', '仓库名称'], ['location_id', '库位 ID'],
          ['location_name', '库位名称'], ['qty_on_hand', '现存量'],
          ['locked_qty', '锁定数量'], ['balance_qty', '可用数量'],
          ['qty_in_transit', '在途数量'], ['unit_price', '单位成本'],
          ['ending_balance', '期末结存'], ['batch_no', '批次号'],
          ['updated_at', '更新时间'],
        ],
      },
      'warehouses.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（仓库编码 / 仓库名称 模糊匹配）'],
          ['wh_type', '否', '仓库类型精确匹配'],
          ['wh_attribute', '否', '仓库属性精确匹配 (10-良品 11-在检 12-不良)'],
          ['is_enabled', '否', '是否启用 (0/1)'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['wh_id', '仓库 ERP ID'],
          ['parent_wh_id', '父仓库 ID'], ['wh_code', '仓库编码'],
          ['wh_name', '仓库名称'], ['wh_type', '仓库类型'],
          ['wh_attribute', '仓库属性'], ['plan_area', '规划区域'],
          ['is_workshop', '是否车间仓'], ['is_enabled', '是否启用'],
          ['updated_at', '更新时间'],
        ],
      },
      'locations.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（库位编码 / 名称 / 全称 模糊匹配）'],
          ['parent_id', '否', '父库位 ID 精确匹配'],
          ['detail_flag', '否', '明细标识 (0/1)'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['location_id', '库位 ERP ID'],
          ['location_group_id', '库位组 ID'], ['location_code', '库位编码'],
          ['location_name', '库位名称'], ['location_full_name', '库位全称'],
          ['depth', '层级深度'], ['detail_flag', '明细标识'],
          ['parent_id', '父库位 ID'], ['updated_at', '更新时间'],
        ],
      },
      'production_task_orders.list': {
        params: [
          ['page', '否', '页码，默认 1'],
          ['page_size', '否', '每页条数，默认 20，最大 200'],
          ['keyword', '否', '关键字（任务单号 / 物料名称 模糊匹配）'],
          ['workshop', '否', '生产车间精确匹配'],
          ['task_type', '否', '类型精确匹配'],
          ['is_closed', '否', '是否关闭 (0/1)'],
          ['audit_status', '否', '审核状态 (0=未审核 1=已审核)'],
          ['mrp_flag', '否', 'MRP 标志 (0/1)'],
          ['sale_order_no', '否', '销售订单号精确匹配'],
          ['updated_after', '否', '增量同步 (ISO 8601)'],
        ],
        fields: [
          ['id', '记录ID'], ['task_id', '任务单 ERP ID'],
          ['task_no', '任务单号'], ['workshop', '车间'],
          ['material_code', '物料编码'], ['material_name', '物料名称'],
          ['planned_start_date', '计划开始日期'],
          ['planned_end_date', '计划结束日期'],
          ['actual_start_date', '实际开始日期'],
          ['actual_end_date', '实际结束日期'],
          ['task_qty', '任务数量'], ['repair_qty', '返修数量'],
          ['actual_qty', '实际数量'], ['task_type', '类型'],
          ['sale_order_no', '销售订单号'], ['sale_order_id', '销售订单 ID'],
          ['start_flag', '开工标志'], ['is_closed', '是否关闭'],
          ['audit_status', '审核状态'], ['mrp_flag', 'MRP 标志'],
          ['audit_user_id', '审核人 ID'], ['request_user_id', '申请人 ID'],
          ['supplier_id', '供应商 ID'], ['erp_updated_at', 'ERP 更新时间'],
          ['updated_at', '更新时间'],
        ],
      },
    }

    // 按 tags 分组渲染对外接口明细
    const groupedEndpoints = endpointOptions.reduce<Record<string, EndpointOption[]>>((acc, e) => {
      const tag = e.tags?.[0] || '其他'
      ;(acc[tag] = acc[tag] || []).push(e)
      return acc
    }, {})

    const endpointDetails = Object.entries(groupedEndpoints).map(([tag, list]) => {
      const blocks = list.map(e => {
        const detail = ENDPOINT_DETAILS[e.endpoint_code]
        const paramRows = (detail?.params?.length
          ? detail.params.map(([n, r, d]) => `| \`${n}\` | ${r} | ${d} |`)
          : ['| （见后端 docstring） |  |  |']
        ).join('\n')
        const fieldRows = (detail?.fields?.length
          ? detail.fields.map(([n, d]) => `| \`${n}\` | ${d} |`)
          : ['| （由返回结果决定） |  |']
        ).join('\n')
        const fullPath = `${externalBase}${e.path.replace(/^\/external/, '')}`
        return `#### ${e.name}（\`${e.endpoint_code}\`）

\`${e.method} ${fullPath}\`

${e.description}

**请求参数**

| 参数 | 必填 | 说明 |
|------|------|------|
${paramRows}

**响应字段（items 元素）**

| 字段 | 说明 |
|------|------|
${fieldRows}
`
      }).join('\n')
      return `### ${tag}\n\n${blocks}`
    }).join('\n\n')

    return `# 数据供给 API 使用说明

## 1. 接入流程

1. 若需把某个内部接口（已有路由）也对外开放，请在该 handler 上加 \`@exposable("int:<domain>.<verb>", ...)\` 装饰器并重新启动后端（该端点会出现在 API Key 表单的「可调用内部接口」中）
2. 在 **API Key 管理** 中创建一个 API Key，勾选允许调用的对外接口、**以及需要的内部接口（以 int: 为前缀）**
3. 妥善保存生成的 AppKey + AppSecret（仅显示一次），将其配置到外部系统中
4. 外部系统调用 API 时，使用 HMAC-SHA256 签名认证

## 2. 两类接口

| 接口类别 | 路径前缀 | 权限字段 | 说明 |
|----------|----------|----------|------|
| 对外业务接口 | \`${externalBase}/...\` | allowed_endpoints | 按业务场景封装，字段固定精简 |
| 内部可暴露接口（@exposable）| **保持原 URL 不变**（不重新挂载）| allowed_endpoints（含 \`int:\` 前缀）| 在已有内部 handler 上加 \`@exposable\` 装饰器即可，外部系统用同一 URL + HMAC 签名调用 |

> 两类接口共用同一套 AppKey / 签名算法。\`allowed_endpoints\` 同时控制「对外业务接口」与「内部可暴露接口」两者（后者用 \`int:\` 前缀区分）。

## 3. 认证方式

采用 HMAC-SHA256 签名认证（AppSecret 不在网络传输）：

每次请求携带以下三个请求头：

| 请求头 | 说明 | 示例 |
|--------|------|------|
| \`X-App-Key\` | 应用标识（AppKey） | \`ak_a1b2c3d4e5f6g7h8\` |
| \`X-Timestamp\` | 当前 Unix 时间戳（秒） | \`1719000000\` |
| \`X-Signature\` | HMAC-SHA256 签名 | \`a3f2b1c4d5e6...\` |

**签名算法：**

\`\`\`
对外接口：待签名串 = timestamp + app_key + endpoint_code + query_string
内部接口：待签名串 = timestamp + app_key + endpoint_code + query_string（endpoint_code 以 int: 开头）

例：1719000000ak_a1b2c3d4e5f6g7h8orders.listpage=1&page_size=20

用 AppSecret 对待签名串做 HMAC-SHA256，结果转十六进制小写放入 X-Signature
\`\`\`

> 注意：对外接口签名中用的是 **endpoint_code（如 orders.list）**，不是 URL 路径。
> query_string 必须与实际请求 URL 中 \`?\` 后的内容完全一致（含顺序），无参数时为空串。

**防重放：** 时间戳与服务器时间差超过 5 分钟，请求将被拒绝。

## 4. 对外业务接口清单

| endpoint_code | 名称 | 路径 | 说明 |
|---------------|------|------|------|
${endpointRows}

> 所有对外接口共用统一响应格式（见 5），items 元素字段见下方各接口明细。
> 通用查询参数：page / page_size 分页、keyword 关键字、updated_after 增量同步（部分接口不支持）。

${endpointDetails}

## 4.5 内部可暴露接口清单（@exposable）

| endpoint_code | 名称 | 方法 / 路径 | 说明 |
|---------------|------|--------------|------|
${internalEndpointRows}

> 说明：这些端点不需要在 URL 中加 \`/external\` 前缀 — 调用方发送请求到原始 URL（如 \`/api/v1/common/ping\`），按第 6 章内部接口示例签名即可。endpoint_code 仍以 \`int:\` 前缀与其他接口区分。

## 5. 统一响应格式

\`\`\`json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [...],
    "total": 100,
    "page": 1,
    "page_size": 20
  }
}
\`\`\`

> items 元素字段见第 4 章各接口明细。

## 6. 调用示例

### Python（对外接口签名认证）

\`\`\`python
import hmac, hashlib, time, requests

APP_KEY = "ak_xxxxxxxx"
APP_SECRET = "your_app_secret"
ENDPOINT_CODE = "orders.list"   # 注意：用接口代码，不是 URL 路径

query_string = "page=1&page_size=20"
timestamp = str(int(time.time()))
string_to_sign = f"{timestamp}{APP_KEY}{ENDPOINT_CODE}{query_string}"
signature = hmac.new(APP_SECRET.encode(), string_to_sign.encode(), hashlib.sha256).hexdigest()

resp = requests.get(
    "${externalBase}/orders/list",
    params={"page": 1, "page_size": 20},
    headers={
        "X-App-Key": APP_KEY,
        "X-Timestamp": timestamp,
        "X-Signature": signature,
    },
)
print(resp.json())
\`\`\`

### cURL

\`\`\`bash
TIMESTAMP=$(date +%s)
APP_KEY="ak_xxxxxxxx"
APP_SECRET="your_app_secret"
ENDPOINT="orders.list"
QS="page=1&page_size=20"
SIG=$(echo -n "\${TIMESTAMP}\${APP_KEY}\${ENDPOINT}\${QS}" \\
  | openssl dgst -sha256 -hmac "\$APP_SECRET" | awk '{print $NF}')

curl "${externalBase}/orders/list?page=1&page_size=20" \\
  -H "X-App-Key: \$APP_KEY" -H "X-Timestamp: \$TIMESTAMP" -H "X-Signature: \$SIG"
\`\`\`

### 内部接口 — Node.js / TypeScript

\`\`\`typescript
import crypto from "crypto";

const appKey = process.env.SPC_APP_KEY ?? "ak_xxxxxxxx";
const appSecret = process.env.SPC_APP_SECRET ?? "your_app_secret";
const endpointCode = "int:health.ping";
const queryString = "";

const timestamp = Math.floor(Date.now() / 1000).toString();
const stringToSign = \`\${timestamp}\${appKey}\${endpointCode}\${queryString}\`;
const signature = crypto
  .createHmac("sha256", appSecret)
  .update(stringToSign)
  .digest("hex");

const resp = await fetch(
  \`\${process.env.SPC_BASE ?? "http://localhost:8000"}/api/v1/common/ping\`,
  {
    method: "GET",
    headers: {
      "X-App-Key": appKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    },
  }
);
console.log(await resp.json());
\`\`\`

### 内部接口 — Go

\`\`\`go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	appKey := getenv("SPC_APP_KEY", "ak_xxxxxxxx")
	appSecret := getenv("SPC_APP_SECRET", "your_app_secret")
	endpointCode := "int:health.ping"

	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(appSecret))
	mac.Write([]byte(timestamp + appKey + endpointCode))
	sig := hex.EncodeToString(mac.Sum(nil))

	base := getenv("SPC_BASE", "http://localhost:8000")
	req, _ := http.NewRequest("GET", base+"/api/v1/common/ping", nil)
	req.Header.Set("X-App-Key", appKey)
	req.Header.Set("X-Timestamp", timestamp)
	req.Header.Set("X-Signature", sig)

	resp, err := http.DefaultClient.Do(req)
	if err != nil { panic(err) }
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	fmt.Println(string(body))
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" { return v }
	return def
}
\`\`\`

> 注意：内部接口（@exposable）的待签名串同样以 \`endpoint_code\` 参与拼接（不是 URL 路径），格式与对外业务接口一致。

## 7. 安全机制

| 机制 | 说明 |
|------|------|
| HMAC-SHA256 签名 | AppSecret 不在网络传输，仅用于本地签名计算 |
| 时间戳校验 | 请求时间与服务器时间差超过 5 分钟则拒绝，防重放攻击 |
| IP 白名单 | 可为每个 API Key 配置允许的来源 IP |
| 字段级脱敏 | 手机号、邮箱等敏感字段自动脱敏（如 138****1234） |
| 接口级权限 | allowed_endpoints 统一控制对外接口与 int: 内部接口的访问范围 |
| 限流 | 每 Key 每分钟固定窗口计数，超限返回 429 + Retry-After |

> **限流规则**：每个 Key 每分钟固定窗口计数，额度 = Key 的 rate_limit（0 或空表示不限）；超限返回 429 并携带 Retry-After 响应头（当前窗口剩余秒数），按其秒数等待后重试即可，客户端建议做指数退避。

## 8. 错误码说明

| HTTP 状态码 | 含义 | 排查建议 |
|-------------|------|----------|
| 401 | 缺少认证信息 | 检查是否携带了 X-App-Key/X-Timestamp/X-Signature（含内部接口路径） |
| 403 | 签名错/过期/无权限/IP不在白名单 | 签名不匹配、Key 已过期、IP 不在白名单、未授权该接口，或该内部接口未在 allowed_endpoints（含 int: 前缀）授权 |
| 404 | 接口/记录不存在 | URL 路径不存在、未注册为 @exposable、或单条记录 ID 不存在 |
| 429 | 触发限流 | 已超过 Key 的每分钟限额，按 Retry-After 头等待后重试，或联系管理员调整额度 |
| 500 | sys-api-caller 占位用户缺失 | 容器启动后未执行 init_database.py，缺少 api_caller 角色与 sys-api-caller 系统用户。补跑一次 init_database.py 即可恢复 |
`
  }

  const handleExportMarkdown = () => {
    const md = generateGuideMarkdown()
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '数据供给API使用说明.md'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    message.success('文档已导出')
  }

  const renderGuideTab = () => {
    const host = window.location.host
    const externalBase = `http://${host}/api/v1/external`

    const pythonExample = `import hmac, hashlib, time, requests

APP_KEY = "ak_xxxxxxxx"
APP_SECRET = "your_app_secret"   # 创建Key时返回的64位串
ENDPOINT_CODE = "orders.list"    # 注意：用接口代码，不是 URL 路径

# 1. query_string 必须和请求 URL 中 ? 后的内容完全一致（含顺序）
query_string = "page=1&page_size=20"
timestamp = str(int(time.time()))

# 2. 拼接待签名串：timestamp + app_key + endpoint_code + query_string
string_to_sign = f"{timestamp}{APP_KEY}{ENDPOINT_CODE}{query_string}"

# 3. 用 AppSecret 做 HMAC-SHA256，转十六进制小写
signature = hmac.new(
    APP_SECRET.encode("utf-8"),
    string_to_sign.encode("utf-8"),
    hashlib.sha256,
).hexdigest()

# 4. 发请求（每次请求都重新生成 timestamp + signature）
resp = requests.get(
    f"${externalBase}/orders/list",
    params={"page": 1, "page_size": 20},
    headers={
        "X-App-Key": APP_KEY,
        "X-Timestamp": timestamp,
        "X-Signature": signature,
    },
)
print(resp.json())`

    const curlExample = `TIMESTAMP=$(date +%s)
APP_KEY="ak_xxxxxxxx"
APP_SECRET="your_app_secret"
ENDPOINT="orders.list"
QS="page=1&page_size=20"

# 待签名串 = 时间戳 + AppKey + endpoint_code + query_string
SIG=$(printf '%s' "\${TIMESTAMP}\${APP_KEY}\${ENDPOINT}\${QS}" \\
  | openssl dgst -sha256 -hmac "\$APP_SECRET" | awk '{print $NF}')

curl "${externalBase}/orders/list?page=1&page_size=20" \\
  -H "X-App-Key: \$APP_KEY" \\
  -H "X-Timestamp: \$TIMESTAMP" \\
  -H "X-Signature: \$SIG"`

    const javaExample = `String appKey = "ak_xxxxxxxx";
String appSecret = "your_app_secret";
String endpointCode = "orders.list";
String queryString = "page=1&page_size=20";

String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
String stringToSign = timestamp + appKey + endpointCode + queryString;

Mac mac = Mac.getInstance("HmacSHA256");
mac.init(new SecretKeySpec(appSecret.getBytes(), "HmacSHA256"));
String signature = HexFormat.of().formatHex(
    mac.doFinal(stringToSign.getBytes(StandardCharsets.UTF_8)));

HttpRequest req = HttpRequest.newBuilder()
    .uri(URI.create("${externalBase}/orders/list?page=1&page_size=20"))
    .header("X-App-Key", appKey)
    .header("X-Timestamp", timestamp)
    .header("X-Signature", signature)
    .GET().build();
HttpResponse<String> resp = HttpClient.newHttpClient()
    .send(req, HttpResponse.BodyHandlers.ofString());
System.out.println(resp.body());`

    return (
      <div>
        <div style={{ marginBottom: 20, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<DownloadOutlined />} onClick={handleExportMarkdown}>
            导出 Markdown 文档
          </Button>
        </div>

        {/* 1. 接入流程 */}
        <Card
          style={{ marginBottom: 16, borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.04)', transition: 'all 0.2s ease' }}
          size="small"
          bordered={false}
          hoverable
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, #1890ff25 0%, #1890ff0d 100%)',
                boxShadow: '0 2px 6px rgba(24, 144, 255, 0.1)',
              }}>
                <ApiOutlined style={{ fontSize: 'calc(1rem * var(--font-size-scale))', color: '#1890ff' }} />
              </div>
              <span style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937' }}>接入流程</span>
            </div>
          }
        >
          <Steps
            size="small"
            current={-1}
            direction="vertical"
            items={[
              { title: '标记内部接口（如需）', description: '对需要对外开放的已有内部 handler 加 @exposable("int:<code>", ...)，重启后端。该端点会出现在 API Key 表单的「可调用内部接口」中' },
              { title: '创建 API Key', description: '在「API Key 管理」中创建 Key，勾选允许调用的对外接口、以及需要的内部接口（int: 前缀）' },
              { title: '保存凭据', description: '妥善保存 AppKey + AppSecret（仅显示一次），配置到外部系统' },
              { title: '签名调用', description: '外部系统每次请求用 HMAC-SHA256 生成签名，携带三个请求头，访问原 URL 即可' },
            ]}
          />
        </Card>

        {/* 2. 认证方式 */}
        <Card
          style={{ marginBottom: 16, borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.04)', transition: 'all 0.2s ease' }}
          size="small"
          bordered={false}
          hoverable
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, #52c41a25 0%, #52c41a0d 100%)',
                boxShadow: '0 2px 6px rgba(82, 196, 26, 0.1)',
              }}>
                <SafetyCertificateOutlined style={{ fontSize: 'calc(1rem * var(--font-size-scale))', color: '#52c41a' }} />
              </div>
              <span style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937' }}>认证方式</span>
            </div>
          }
        >
          <Alert
            type="info" showIcon style={{ marginBottom: 16 }}
            message="采用 HMAC-SHA256 签名认证，AppSecret 不在网络传输，安全性高"
          />

          <Text strong>签名认证（唯一方式）</Text>
          <div style={{ margin: '12px 0 16px' }}>
            <DescTable
              rows={[
                { label: '请求头', value: <Text code>X-App-Key</Text> },
                { label: '请求头', value: <Text code>X-Timestamp</Text> },
                { label: '请求头', value: <Text code>X-Signature</Text> },
                { label: '说明', value: '应用标识（AppKey）' },
                { label: '说明', value: '当前 Unix 时间戳（秒）' },
                { label: '说明', value: 'HMAC-SHA256 签名（十六进制小写）' },
                { label: '示例', value: <Text code>ak_a1b2c3d4...</Text> },
                { label: '示例', value: <Text code>1719000000</Text> },
                { label: '示例', value: <Text code>a3f2b1c4d5e6...</Text> },
              ]}
            />
          </div>

          <div style={{
            background: 'linear-gradient(135deg, #f0f5ff 0%, #f9f0ff 100%)',
            border: '1px solid #d6e4ff', borderRadius: 10,
            padding: '16px 20px', marginBottom: 8,
          }}>
            <Text strong>签名算法</Text>
            <div style={{ marginTop: 10 }}>
              <Text>① 构造待签名串（四段拼接，无分隔符）：</Text>
              <CodeBlock
                lang="text"
                code={`对外接口:    timestamp + app_key + endpoint_code + query_string
内部接口:    timestamp + app_key + endpoint_code + query_string   (endpoint_code 以 int: 开头)

示例:  1719000000ak_xxxorders.listpage=1&page_size=20
       1719000000ak_xxxint:health.ping`}
              />
              <Text>② 用 <Text code>AppSecret</Text> 对待签名串做 HMAC-SHA256，结果转十六进制小写，放入 <Text code>X-Signature</Text></Text>
            </div>
            <div style={{ marginTop: 10 }}>
              <Text type="warning">⚠ 关键注意：</Text>
              <ul style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 'calc(0.8125rem * var(--font-size-scale))', lineHeight: 2 }}>
                <li>对外接口签名用 <Text code>endpoint_code</Text>（如 <Text code>orders.list</Text>），<Text strong>不是 URL 路径</Text></li>
                <li><Text code>query_string</Text> 须与请求 URL 中 <Text code>?</Text> 后内容完全一致（含参数顺序），无参数时为空串</li>
                <li><Text code>timestamp</Text> 用当前时间，服务端允许 ±5 分钟偏差，防重放</li>
                <li>每次请求都要重新生成 timestamp 和 signature</li>
              </ul>
            </div>
          </div>
        </Card>

        {/* 3. 对外业务接口 */}
        <Card
          style={{ marginBottom: 16, borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.04)', transition: 'all 0.2s ease' }}
          size="small"
          bordered={false}
          hoverable
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, #722ed125 0%, #722ed10d 100%)',
                boxShadow: '0 2px 6px rgba(114, 46, 209, 0.1)',
              }}>
                <ApiOutlined style={{ fontSize: 'calc(1rem * var(--font-size-scale))', color: '#722ed1' }} />
              </div>
              <span style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937' }}>对外业务接口清单</span>
            </div>
          }
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            路径前缀 <Text code>/api/v1/external</Text>，权限由 API Key 的「允许调用的对外接口」控制。各接口均支持分页与增量同步。
          </Text>
          <Table
            size="small"
            pagination={false}
            rowKey="endpoint_code"
            dataSource={endpointOptions}
            scroll={{ x: 700 }}
            columns={[
              {
                title: '接口代码', dataIndex: 'endpoint_code', width: 200,
                render: (v: string) => <Text code style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{v}</Text>,
              },
              { title: '名称', dataIndex: 'name', width: 130 },
              {
                title: '方法 / 路径', key: 'route', width: 280,
                render: (_: any, r: any) => (
                  <Space size={6}>
                    <Tag color="blue" style={{ margin: 0 }}>{r.method}</Tag>
                    <Text code style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{r.path}</Text>
                  </Space>
                ),
              },
              { title: '说明', dataIndex: 'description' },
            ]}
          />
        </Card>

        {/* 3b. 内部可暴露接口清单 */}
        <Card
          style={{ marginBottom: 16, borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.04)', transition: 'all 0.2s ease' }}
          size="small"
          bordered={false}
          hoverable
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, #13c2c225 0%, #13c2c20d 100%)',
                boxShadow: '0 2px 6px rgba(19, 194, 194, 0.1)',
              }}>
                <ApiOutlined style={{ fontSize: 'calc(1rem * var(--font-size-scale))', color: '#13c2c2' }} />
              </div>
              <span style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937' }}>内部可暴露接口清单（@exposable）</span>
            </div>
          }
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            这些内部接口可被外部系统通过 API Key + HMAC 签名调用，URL <Text strong>无需</Text> 加 <Text code>/external</Text> 前缀。权限由 API Key 的「允许调用的内部接口」字段（<Text code>int:</Text> 前缀条目）控制。
          </Text>
          <Table
            size="small"
            pagination={false}
            rowKey="endpoint_code"
            dataSource={internalEndpointOptions}
            scroll={{ x: 700 }}
            columns={[
              {
                title: '接口代码', dataIndex: 'endpoint_code', width: 200,
                render: (v: string) => <Text code style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{v}</Text>,
              },
              { title: '名称', dataIndex: 'name', width: 200 },
              {
                title: '方法 / 路径', key: 'route', width: 280,
                render: (_: any, r: any) => (
                  <Space size={6}>
                    <Tag color="green" style={{ margin: 0 }}>{r.method}</Tag>
                    <Text code style={{ fontSize: 'calc(0.75rem * var(--font-size-scale))' }}>{r.path}</Text>
                  </Space>
                ),
              },
              { title: '说明', dataIndex: 'description' },
            ]}
          />
          <Alert
            style={{ marginTop: 12 }}
            type="info" showIcon
            message={<>开发者要在新接口上加 <Text code>@exposable("int:&lt;domain&gt;.&lt;verb&gt;", name, description, tags)</Text>，并把对应 handler 的 <Text code>Depends(get_current_user)</Text> 替换为 <Text code>Depends(get_current_user_or_api_key)</Text>。</>}
          />
        </Card>

        {/* 4. 调用示例 */}
        <Card
          style={{ marginBottom: 16, borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.04)', transition: 'all 0.2s ease' }}
          size="small"
          bordered={false}
          hoverable
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, #fa8c1625 0%, #fa8c160d 100%)',
                boxShadow: '0 2px 6px rgba(250, 140, 22, 0.1)',
              }}>
                <CodeOutlined style={{ fontSize: 'calc(1rem * var(--font-size-scale))', color: '#fa8c16' }} />
              </div>
              <span style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937' }}>调用示例</span>
            </div>
          }
        >
          <Collapse
            defaultActiveKey={['python']}
            items={[
              { key: 'python', label: 'Python（requests）', children: <CodeBlock code={pythonExample} lang="python" /> },
              { key: 'curl', label: 'cURL（openssl）', children: <CodeBlock code={curlExample} lang="bash" /> },
              { key: 'java', label: 'Java（HttpClient）', children: <CodeBlock code={javaExample} lang="java" /> },
            ]}
          />
        </Card>

        {/* 4b. 内部接口签名示例 */}
        <Card
          style={{ marginBottom: 16, borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.04)', transition: 'all 0.2s ease' }}
          size="small"
          bordered={false}
          hoverable
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, #eb2f9625 0%, #eb2f960d 100%)',
                boxShadow: '0 2px 6px rgba(235, 47, 150, 0.1)',
              }}>
                <CodeOutlined style={{ fontSize: 'calc(1rem * var(--font-size-scale))', color: '#eb2f96' }} />
              </div>
              <span style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937' }}>内部接口调用示例（Node.js / TypeScript / Go）</span>
            </div>
          }
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
            以冒烟端点 <Text code>int:health.ping → GET /api/v1/common/ping</Text> 为例。待签名串格式与对外业务接口完全一致，<Text strong>用 endpoint_code（int:health.ping）而非 URL 路径参与签名</Text>。
          </Text>
          <Collapse
            defaultActiveKey={['node']}
            items={[
              {
                key: 'node', label: 'Node.js / TypeScript (built-in fetch)',
                children: <CodeBlock
                  lang="typescript"
                  code={`import crypto from "crypto";

const appKey = process.env.SPC_APP_KEY ?? "ak_xxxxxxxx";
const appSecret = process.env.SPC_APP_SECRET ?? "your_app_secret";
const endpointCode = "int:health.ping";
const queryString = "";

const timestamp = Math.floor(Date.now() / 1000).toString();
const stringToSign = \`\${timestamp}\${appKey}\${endpointCode}\${queryString}\`;
const signature = crypto
  .createHmac("sha256", appSecret)
  .update(stringToSign)
  .digest("hex");

const resp = await fetch(
  \`\${process.env.SPC_BASE ?? "http://localhost:8000"}/api/v1/common/ping\`,
  {
    method: "GET",
    headers: {
      "X-App-Key": appKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    },
  }
);
console.log(await resp.json());`}
                />,
              },
              {
                key: 'go', label: 'Go (net/http + crypto/hmac)',
                children: <CodeBlock
                  lang="go"
                  code={`package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	appKey := getenv("SPC_APP_KEY", "ak_xxxxxxxx")
	appSecret := getenv("SPC_APP_SECRET", "your_app_secret")
	endpointCode := "int:health.ping"

	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(appSecret))
	mac.Write([]byte(timestamp + appKey + endpointCode))
	sig := hex.EncodeToString(mac.Sum(nil))

	base := getenv("SPC_BASE", "http://localhost:8000")
	req, _ := http.NewRequest("GET", base+"/api/v1/common/ping", nil)
	req.Header.Set("X-App-Key", appKey)
	req.Header.Set("X-Timestamp", timestamp)
	req.Header.Set("X-Signature", sig)

	resp, err := http.DefaultClient.Do(req)
	if err != nil { panic(err) }
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	fmt.Println(string(body))
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" { return v }
	return def
}`}
                />,
              },
            ]}
          />
        </Card>

        {/* 5. 安全机制 + 错误码 */}
        <Row gutter={16}>
          <Col span={12}>
            <Card
              style={{ borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.04)', height: '100%', transition: 'all 0.2s ease' }}
              size="small"
              bordered={false}
              hoverable
              title={
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 10,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'linear-gradient(135deg, #52c41a25 0%, #52c41a0d 100%)',
                    boxShadow: '0 2px 6px rgba(82, 196, 26, 0.1)',
                  }}>
                    <LockOutlined style={{ fontSize: 'calc(1rem * var(--font-size-scale))', color: '#52c41a' }} />
                  </div>
                  <span style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937' }}>安全机制</span>
                </div>
              }
            >
              <DescTable
                columns={2}
                rows={[
                  { label: 'HMAC-SHA256', value: 'AppSecret 不上网传输' },
                  { label: '时间戳校验', value: '±5 分钟防重放' },
                  { label: 'IP 白名单', value: '可限制来源 IP' },
                  { label: '字段脱敏', value: '手机/邮箱自动脱敏' },
                  { label: '接口级权限', value: 'allowed_endpoints 统一控制' },
                  { label: '限流', value: '每分钟固定窗口，超限 429' },
                  { label: '调用日志', value: '全程记录可追溯' },
                ]}
              />
            </Card>
          </Col>
          <Col span={12}>
            <Card
              style={{ borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.04)', height: '100%', transition: 'all 0.2s ease' }}
              size="small"
              bordered={false}
              hoverable
              title={
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 10,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'linear-gradient(135deg, #ff4d4f25 0%, #ff4d4f0d 100%)',
                    boxShadow: '0 2px 6px rgba(255, 77, 79, 0.1)',
                  }}>
                    <WarningOutlined style={{ fontSize: 'calc(1rem * var(--font-size-scale))', color: '#ff4d4f' }} />
                  </div>
                  <span style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937' }}>错误码</span>
                </div>
              }
            >
              <Table
                size="small"
                pagination={false}
                rowKey="code"
                dataSource={[
                  { code: '401', meaning: '缺少认证头', advice: '检查是否携带 X-App-Key / X-Timestamp / X-Signature 三件套（内部接口路径同样需要）' },
                  { code: '403', meaning: '签名失败 / IP 不在白名单 / Key 未授权该接口', advice: '按返回 detail 排查：核对签名串与 query_string、确认 Key 未过期、IP 已加白，且该接口（含 int: 前缀）已在 allowed_endpoints 勾选' },
                  { code: '404', meaning: '接口 / 记录不存在', advice: '核对 URL 路径；内部接口需已注册 @exposable；单条查询确认记录 ID 存在' },
                  { code: '429', meaning: '触发限流', advice: '已超过 Key 每分钟限额，按 Retry-After 响应头等待后重试，或联系管理员调高额度和退避重试' },
                  { code: '500', meaning: '服务内部错误', advice: 'sys-api-caller 占位用户缺失时补跑 init_database.py；其余情况携带调用时间与日志联系管理员' },
                ]}
                columns={[
                  {
                    title: '状态码', dataIndex: 'code', width: 76,
                    render: (v: string) => <Tag color={v === '403' || v === '500' ? 'red' : v === '404' || v === '429' ? 'orange' : 'default'}>{v}</Tag>,
                  },
                  { title: '含义', dataIndex: 'meaning', width: 170 },
                  { title: '处理建议', dataIndex: 'advice' },
                ]}
              />
            </Card>
          </Col>
        </Row>

        {/* 6. 限流规则 */}
        <Card
          style={{ marginTop: 16, borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.04)', transition: 'all 0.2s ease' }}
          size="small"
          bordered={false}
          hoverable
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, #faad1425 0%, #faad140d 100%)',
                boxShadow: '0 2px 6px rgba(250, 173, 20, 0.1)',
              }}>
                <ClockCircleOutlined style={{ fontSize: 'calc(1rem * var(--font-size-scale))', color: '#faad14' }} />
              </div>
              <span style={{ fontSize: 'calc(0.9375rem * var(--font-size-scale))', fontWeight: 600, color: '#1f2937' }}>限流规则</span>
            </div>
          }
        >
          <DescTable
            columns={2}
            rows={[
              { label: '计数方式', value: '每 Key 每分钟固定窗口计数（按自然分钟对齐，该 Key 的所有对外 / 内部接口共用同一额度）' },
              { label: '额度', value: '等于 API Key 的「速率限制（每分钟请求数）」即 rate_limit；为 0 或空表示不限流' },
              { label: '超限行为', value: '返回 429，并携带 Retry-After 响应头（当前窗口剩余秒数），命中限流的调用会记录到调用日志' },
              { label: '处理建议', value: '按 Retry-After 等待后重试；频繁触发请联系管理员调高额度，客户端建议做指数退避' },
            ]}
          />
        </Card>
      </div>
    )
  }

  return (
    <div style={{ padding: 0, background: '#f5f7fa', minHeight: 'calc(100vh - 64px)' }}>
      <style>{`
        .data-supply-tabs .ant-tabs-nav {
          margin-bottom: 0 !important;
          padding: 0 4px;
        }
        .data-supply-tabs .ant-tabs-tab {
          padding: 10px 18px;
          font-size: calc(0.875rem * var(--font-size-scale));
          font-weight: 500;
          transition: all 0.2s ease;
        }
        .data-supply-tabs .ant-tabs-tab:hover {
          color: #1890ff;
        }
        .data-supply-tabs .ant-tabs-tab-active {
          font-weight: 600;
        }
        .data-supply-tabs .ant-tabs-ink-bar {
          height: 3px;
          border-radius: 2px;
        }
        .data-supply-table .ant-table-thead > tr > th {
          background: linear-gradient(180deg, #fafbfc 0%, #f5f7fa 100%) !important;
          color: #262626 !important;
          font-weight: 600 !important;
          font-size: calc(0.8125rem * var(--font-size-scale)) !important;
          border-bottom: 1px solid #e8e8e8 !important;
          padding: 12px 16px !important;
        }
        .data-supply-table .ant-table-tbody > tr.row-even > td {
          background: #fcfcfd;
        }
        .data-supply-table .ant-table-tbody > tr.row-odd > td {
          background: #ffffff;
        }
        .data-supply-table .ant-table-tbody > tr:hover > td {
          background: #f0f5ff !important;
        }
        .data-supply-table .ant-table-tbody > tr.row-disabled > td {
          opacity: 0.5;
        }
        .data-supply-table .ant-table-tbody > tr > td {
          padding: 12px 16px !important;
          border-bottom: 1px solid #f0f0f0 !important;
        }
        .data-supply-table .ant-table-container {
          border-radius: 8px;
          overflow: hidden;
        }
      `}</style>
      {/* Tab 区域 - 无外层框，吸附顶部栏下方并占满宽度 */}
      <Tabs
        className="data-supply-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        size="middle"
        style={{ marginBottom: 0, background: '#fff', padding: '0 16px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 56, zIndex: 8 }}
        tabBarStyle={{ marginBottom: 0 }}
        items={[
          {
            key: 'api-keys',
            label: (
              <span style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))', fontWeight: 500 }}>
                <KeyOutlined style={{ marginRight: 6 }} />
                API Key 管理
              </span>
            ),
            children: null,
          },
          {
            key: 'call-logs',
            label: (
              <span style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))', fontWeight: 500 }}>
                <BarChartOutlined style={{ marginRight: 6 }} />
                调用日志
              </span>
            ),
            children: null,
          },
          {
            key: 'guide',
            label: (
              <span style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))', fontWeight: 500 }}>
                <BookOutlined style={{ marginRight: 6 }} />
                使用说明
              </span>
            ),
            children: null,
          },
        ]}
      />
      {/* 内容区域 - 单独放在下方 */}
      <div style={{ padding: '12px 16px 16px' }}>
        <Card
          bordered={false}
          style={{
            borderRadius: 12,
            boxShadow: '0 1px 4px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.02)',
          }}
          bodyStyle={{ padding: 20 }}
        >
          {activeTab === 'api-keys' && renderApiKeysTab()}
          {activeTab === 'call-logs' && renderCallLogsTab()}
          {activeTab === 'guide' && renderGuideTab()}
        </Card>
      </div>
    </div>
  )
}
