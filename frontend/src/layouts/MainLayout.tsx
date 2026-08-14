import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Button, Dropdown, Space, Modal, Form, Input, message, Result, Badge, Popover, Tabs, List, Tag, Typography, notification as antNotification } from 'antd'
import {
  DashboardOutlined,
  ShoppingCartOutlined,
  WarningOutlined,
  ImportOutlined,
  SettingOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
  BellOutlined,
  FileTextOutlined,
  UnorderedListOutlined,
  ExperimentOutlined,
  ContainerOutlined,
  ProfileOutlined,
  AuditOutlined,
  RocketOutlined,
  TeamOutlined,
  ProjectOutlined,
  ToolOutlined,
  DatabaseOutlined,
  AppstoreOutlined,
  SwapOutlined,
  SendOutlined,
  AccountBookOutlined,
  MessageOutlined,
  FolderOpenOutlined,
  NotificationOutlined,
  CheckOutlined,
  CheckCircleOutlined,
  SoundOutlined,
  IdcardOutlined,
  SafetyOutlined,
  ApiOutlined,
  EnvironmentOutlined,
  StockOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  ScheduleOutlined,
  AlertOutlined,
  HomeOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '../store/auth'
import { usePermissionStore, PermNode } from '../store/permission'
import { authApi, notificationApi } from '../services/api'
import FeedbackButton from '../pages/BasicDataCenter/FeedbackManagement/FeedbackButton'
import ShareButton from '../components/ShareButton'
import { FloatingAssistant, TopBarAssistant } from '../components/Assistant'
import FontSizeSetting from '../components/FontSizeSetting'
import { SUPPLIER_PORTAL_PATHS } from '../constants/permissions'

const { Sider, Content } = Layout

type PermissionAwareItem = {
  key: string
  icon?: React.ReactNode
  label: string
  permission?: string
  children?: PermissionAwareItem[]
}

// 模块 code → 图标映射（数据库不存储图标，由前端约定）
const MODULE_ICON_MAP: Record<string, React.ReactNode> = {
  dashboard: <DashboardOutlined />,
  topbar: <SettingOutlined />,
  orders: <FileTextOutlined />,
  materials: <ExperimentOutlined />,
  production: <RocketOutlined />,
  exceptions: <WarningOutlined />,
  meetings: <TeamOutlined />,
  npi: <ProjectOutlined />,
  rules: <ToolOutlined />,
  basicdata: <DatabaseOutlined />,
  finance: <AccountBookOutlined />,
}

// 权限 code → 图标映射（叶子节点图标）
const PERMISSION_ICON_MAP: Record<string, React.ReactNode> = {
  'orders.list': <UnorderedListOutlined />,
  'orders.run_orders': <RocketOutlined />,
  'orders.risk_pool': <WarningOutlined />,
  'materials.stock_check': <AuditOutlined />,
  'materials.purchase_plan': <ShoppingCartOutlined />,
  'materials.issues': <WarningOutlined />,
  'materials.long_lead': <ContainerOutlined />,
  'materials.kit_analysis': <AppstoreOutlined />,
  'materials.supplier_risk': <AuditOutlined />,
  'materials.supplier_payment': <AccountBookOutlined />,
  'production.overview': <DashboardOutlined />,
  'production.schedule_plans': <ProjectOutlined />,
  'production.product_process_capacities': <DatabaseOutlined />,
  'production.front_process': <ContainerOutlined />,
  'production.smt': <ExperimentOutlined />,
  'production.lean': <AuditOutlined />,
  'production.assembly': <ToolOutlined />,
  'production.packaging': <ContainerOutlined />,
  'production.exceptions': <WarningOutlined />,
  'production.daily_report': <FileTextOutlined />,
  'exceptions.pool': <WarningOutlined />,
  'exceptions.issue_log': <FileTextOutlined />,
  'exceptions.change_log': <SwapOutlined />,
  'exceptions.quality': <AuditOutlined />,
  'exceptions.product_samples': <FileTextOutlined />,
  'exceptions.closure': <AuditOutlined />,
  'rules.risk_rules': <SettingOutlined />,
  'rules.inspection': <AuditOutlined />,
  'rules.node_standards': <ContainerOutlined />,
  'rules.order_standards': <FileTextOutlined />,
  'rules.work_instructions': <AuditOutlined />,
  'rules.responsibility': <TeamOutlined />,
  'rules.status_dict': <AppstoreOutlined />,
  'basicdata.import': <ImportOutlined />,
  'basicdata.data': <DatabaseOutlined />,
  'basicdata.data.customers': <UserOutlined />,
  'basicdata.data.suppliers': <ShoppingCartOutlined />,
  'basicdata.data.materials': <AppstoreOutlined />,
  'basicdata.data.skus': <ContainerOutlined />,
  'basicdata.data.products': <FileTextOutlined />,
  'basicdata.data.warehouses': <ContainerOutlined />,
  'basicdata.data.locations': <EnvironmentOutlined />,
  'basicdata.data.processes': <RocketOutlined />,
  'basicdata.data.organizations': <TeamOutlined />,
  'basicdata.data.positions': <IdcardOutlined />,
  'basicdata.data.employees': <UserOutlined />,
  'basicdata.data.inventory': <StockOutlined />,
  'basicdata.feedback': <MessageOutlined />,
  'basicdata.files': <FolderOpenOutlined />,
  'basicdata.data_supply': <ApiOutlined />,
  announcements: <NotificationOutlined />,
  users: <UserOutlined />,
  roles: <SafetyOutlined />,
  audit: <AuditOutlined />,
  settings: <SwapOutlined />,
  'finance.data': <AccountBookOutlined />,
  meetings: <TeamOutlined />,
  npi: <ProjectOutlined />,
}

// 判断节点是否为可进入的菜单页面：自身有路由，或子树中存在有路由的页面。
// 无路由的叶子（如 users.reset_password、basicdata.feedback.handle）是页面子权限，不作为菜单项。
function isMenuPage(node: PermNode): boolean {
  if (node.route_path) return true
  if (node.children && node.children.length > 0) return node.children.some(isMenuPage)
  return false
}

// 从权限树动态生成菜单项
function buildMenuItemsFromTree(nodes: PermNode[]): PermissionAwareItem[] {
  return nodes
    .filter(node => node.code !== 'topbar') // 顶栏功能不在侧边栏显示
    .map(node => {
      const hasPageChildren = (node.children || []).some(isMenuPage)
      const icon = PERMISSION_ICON_MAP[node.code] || MODULE_ICON_MAP[node.module] || <AppstoreOutlined />
      const key = node.route_path || node.code

      if (hasPageChildren) {
        const children = buildMenuItemsFromTree((node.children || []).filter(isMenuPage))
        return {
          key,
          icon: MODULE_ICON_MAP[node.code] || MODULE_ICON_MAP[node.module] || icon,
          label: node.name,
          permission: node.code,
          children,
        }
      }

      // 无页面子节点：仅自身有路由时才是可进入的页面；否则是页面子权限，不进菜单
      if (!node.route_path) return null

      return {
        key,
        icon,
        label: node.name,
        permission: node.code,
      }
    })
    .filter(Boolean) as PermissionAwareItem[]
}

// 保留硬编码菜单作为 fallback（权限 API 不可用时使用）
const allMenuItems: PermissionAwareItem[] = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '供应链驾驶舱', permission: 'dashboard' },
  {
    key: 'order-delivery',
    icon: <FileTextOutlined />,
    label: '订单交付中心',
    permission: 'orders',
    children: [
      { key: '/orders', icon: <UnorderedListOutlined />, label: '订单总控台', permission: 'orders.list' },
      { key: '/run-orders', icon: <RocketOutlined />, label: '跑单管理', permission: 'orders.run_orders' },
      { key: '/order-risk-pool', icon: <WarningOutlined />, label: '订单风险池', permission: 'orders.risk_pool' },
      { key: '/inventory-check', icon: <CheckOutlined />, label: '订单物料盘点', permission: 'orders.inventory_check' },
    ],
  },
  {
    key: 'material-center',
    icon: <ExperimentOutlined />,
    label: '物料齐套中心',
    permission: 'materials',
    children: [
      { key: '/purchase-plan', icon: <ShoppingCartOutlined />, label: '采购到料计划', permission: 'materials.purchase_plan' },
      { key: '/material-issues', icon: <WarningOutlined />, label: '问题物料池', permission: 'materials.issues' },
      { key: '/long-lead-materials', icon: <ContainerOutlined />, label: '长交期物料池', permission: 'materials.long_lead' },
      { key: '/kit-analysis', icon: <AppstoreOutlined />, label: '齐套分析', permission: 'materials.kit_analysis' },
      { key: '/supplier-risk', icon: <AuditOutlined />, label: '供应商风险分析', permission: 'materials.supplier_risk' },
      { key: '/supplier-payment', icon: <AccountBookOutlined />, label: '供应商付款排程', permission: 'materials.supplier_payment' },
      { key: '/stock-check', icon: <AuditOutlined />, label: '物料盘点', permission: 'materials.stock_check' },
      { key: '/subcontract-orders', icon: <ProfileOutlined />, label: '委外订单', permission: 'materials.subcontract_orders' },
    ],
  },
  {
    key: 'production-center',
    icon: <RocketOutlined />,
    label: '生产协同中心',
    permission: 'production',
    children: [
        { key: '/production-dashboard', icon: <HomeOutlined />, label: '生产驾驶舱', permission: 'production.overview' },
      { key: '/todo-workbench', icon: <ThunderboltOutlined />, label: '待排工作台', permission: 'production.schedule_plans' },
      { key: '/change-events', icon: <AlertOutlined />, label: '变更事件中心', permission: 'production.schedule_plans' },
      { key: '/schedule-plans', icon: <ProjectOutlined />, label: '排产台账', permission: 'production.schedule_plans' },
      { key: '/schedule-board', icon: <ScheduleOutlined />, label: '排产看板', permission: 'production.schedule_plans' },
      { key: '/production-overview', icon: <DashboardOutlined />, label: '生产总览', permission: 'production.overview' },
      { key: '/product-process-capacities', icon: <DatabaseOutlined />, label: '产品工序产能', permission: 'production.product_process_capacities' },
      { key: '/front-process', icon: <ContainerOutlined />, label: '前道管理', permission: 'production.front_process' },
      { key: '/smt', icon: <ExperimentOutlined />, label: '贴片管理', permission: 'production.smt' },
      { key: '/lean', icon: <AuditOutlined />, label: '精益今日看板', permission: 'production.lean' },
      { key: '/lean-management', icon: <AuditOutlined />, label: '精益管理', permission: 'production.lean' },
      { key: '/assembly', icon: <ToolOutlined />, label: '组装管理', permission: 'production.assembly' },
      { key: '/packaging', icon: <ContainerOutlined />, label: '包装管理', permission: 'production.packaging' },
      { key: '/process-exceptions', icon: <WarningOutlined />, label: '工序异常池', permission: 'production.exceptions' },
    ],
  },
  {
    key: 'exception-center',
    icon: <WarningOutlined />,
    label: '异常与质量中心',
    permission: 'exceptions',
    children: [
      { key: '/issues', icon: <WarningOutlined />, label: '异常总池', permission: 'exceptions.pool' },
      { key: '/issue-log', icon: <FileTextOutlined />, label: '问题日志', permission: 'exceptions.issue_log' },
      { key: '/change-log', icon: <SwapOutlined />, label: '变更日志', permission: 'exceptions.change_log' },
      { key: '/quality-issues', icon: <AuditOutlined />, label: '品质异常', permission: 'exceptions.quality' },
      { key: '/product-samples', icon: <FileTextOutlined />, label: '产品封样', permission: 'exceptions.product_samples' },
      { key: '/closure-tracking', icon: <AuditOutlined />, label: '闭环跟踪', permission: 'exceptions.closure' },
    ],
  },
  {
    key: 'meeting-center',
    icon: <TeamOutlined />,
    label: '会议与任务中心',
    children: [
      { key: '/meetings', icon: <TeamOutlined />, label: '会议与行动项', permission: 'meetings' },
    ],
  },
  {
    key: 'npi-center',
    icon: <ProjectOutlined />,
    label: '新品/NPI项目中心',
    children: [
      { key: '/npi', icon: <ProjectOutlined />, label: '项目总览', permission: 'npi' },
    ],
  },
  {
    key: 'rules-center',
    icon: <ToolOutlined />,
    label: '规则配置中心',
    permission: 'rules',
    children: [
      { key: '/risk-rules', icon: <SettingOutlined />, label: '预警规则', permission: 'rules.risk_rules' },
      { key: '/inspection-rules', icon: <AuditOutlined />, label: '点检规则', permission: 'rules.inspection' },
      { key: '/node-standards', icon: <ContainerOutlined />, label: '节点标准', permission: 'rules.node_standards' },
      { key: '/order-standards', icon: <FileTextOutlined />, label: '订单标准', permission: 'rules.order_standards' },
      { key: '/work-instructions', icon: <AuditOutlined />, label: '作业指导书', permission: 'rules.work_instructions' },
      { key: '/responsibility-map', icon: <TeamOutlined />, label: '责任归属', permission: 'rules.responsibility' },
      { key: '/status-dict', icon: <AppstoreOutlined />, label: '状态字典', permission: 'rules.status_dict' },
    ],
  },
  {
    key: 'basicdata-center',
    icon: <DatabaseOutlined />,
    label: '基础数据与集成中心',
    children: [
      { key: '/import', icon: <ImportOutlined />, label: '数据集成', permission: 'basicdata.import' },
      {
        key: 'basicdata-management',
        icon: <DatabaseOutlined />,
        label: '基础数据管理',
        permission: 'basicdata.data',
        children: [
          { key: '/basicdata/customers', icon: <UserOutlined />, label: '客户', permission: 'basicdata.data' },
          { key: '/basicdata/suppliers', icon: <ShoppingCartOutlined />, label: '供应商', permission: 'basicdata.data' },
          { key: '/basicdata/materials', icon: <AppstoreOutlined />, label: '物料', permission: 'basicdata.data' },
          { key: '/basicdata/skus', icon: <ContainerOutlined />, label: 'SKU', permission: 'basicdata.data' },
          { key: '/basicdata/products', icon: <FileTextOutlined />, label: '产品', permission: 'basicdata.data' },
          { key: '/basicdata/warehouses', icon: <ContainerOutlined />, label: '仓库', permission: 'basicdata.data' },
          { key: '/basicdata/locations', icon: <EnvironmentOutlined />, label: '库位', permission: 'basicdata.data' },
          { key: '/basicdata/processes', icon: <RocketOutlined />, label: '工序', permission: 'basicdata.data' },
          { key: '/basicdata/organizations', icon: <TeamOutlined />, label: '组织', permission: 'basicdata.data' },
          { key: '/basicdata/positions', icon: <IdcardOutlined />, label: '岗位', permission: 'basicdata.data' },
          { key: '/basicdata/employees', icon: <UserOutlined />, label: '人员', permission: 'basicdata.data' },
          { key: '/basicdata/inventory', icon: <StockOutlined />, label: '库存', permission: 'basicdata.data' },
        ],
      },
      { key: '/users', icon: <UserOutlined />, label: '用户管理', permission: 'users' },
      { key: '/roles', icon: <SafetyOutlined />, label: '角色管理', permission: 'roles' },
      { key: '/permissions', icon: <KeyOutlined />, label: '权限管理', permission: 'permissions' },
      { key: '/audit', icon: <AuditOutlined />, label: '审计日志', permission: 'audit' },
      { key: '/share-management', icon: <SendOutlined />, label: '分享管理', permission: 'basicdata.share_management' },
      { key: '/sync-config', icon: <SwapOutlined />, label: '同步SQL配置', permission: 'settings' },
      { key: '/basicdata/data-supply', icon: <ApiOutlined />, label: '数据供给', permission: 'basicdata.data_supply' },
      { key: '/basicdata/feedback', icon: <MessageOutlined />, label: '问题反馈', permission: 'basicdata.feedback' },
      { key: '/basicdata/files', icon: <FolderOpenOutlined />, label: '文件管理', permission: 'basicdata.files' },
      { key: '/announcements', icon: <NotificationOutlined />, label: '公告管理', permission: 'announcements' },
    ],
  },
  {
    key: 'purchase-center',
    icon: <AccountBookOutlined />,
    label: '采购中心',
    permission: 'purchase',
    children: [
      { key: '/purchase/price-change', icon: <FileTextOutlined />, label: '调价单管理', permission: 'purchase.price_change' },
      { key: '/purchase/price-change/pending', icon: <ClockCircleOutlined />, label: '待我审批', permission: 'purchase.price_change.pending' },
      { key: '/purchase/price-change/config', icon: <SettingOutlined />, label: '审批配置', permission: 'purchase.price_change.config' },
    ],
  },
]

function filterMenuByPermission(items: PermissionAwareItem[], hasPermission: (resource: string, action: string) => boolean): PermissionAwareItem[] {
  return items
    .map(item => {
      if (item.children) {
        const filtered = filterMenuByPermission(item.children, hasPermission)
        if (filtered.length > 0) return { ...item, children: filtered }
        return null
      }
      if (!item.permission || hasPermission(item.permission, 'read')) return item
      return null
    })
    .filter(Boolean) as PermissionAwareItem[]
}

function filterMenuByPath(items: PermissionAwareItem[], targetPath: string, hasPermission: (resource: string, action: string) => boolean): PermissionAwareItem[] {
  return items
    .map(item => {
      if (item.children) {
        const filtered = filterMenuByPath(item.children, targetPath, hasPermission)
        if (filtered.length > 0) return { ...item, children: filtered }
        return null
      }
      if (item.key === targetPath && (!item.permission || hasPermission(item.permission, 'read'))) return item
      return null
    })
    .filter(Boolean) as PermissionAwareItem[]
}

const supplierPortalPaths = new Set<string>(SUPPLIER_PORTAL_PATHS)

function filterSupplierPortalMenu(items: PermissionAwareItem[], hasPermission: (resource: string, action: string) => boolean): PermissionAwareItem[] {
  return items
    .map(item => {
      if (item.children) {
        const filtered = filterSupplierPortalMenu(item.children, hasPermission)
        if (filtered.length > 0) return { ...item, children: filtered }
        return null
      }
      if (supplierPortalPaths.has(item.key) && (!item.permission || hasPermission(item.permission, 'read'))) return item
      return null
    })
    .filter(Boolean) as PermissionAwareItem[]
}

function toAntdItems(items: PermissionAwareItem[]): any[] {
  return items.map(({ permission: _perm, children, ...rest }) => ({
    ...rest,
    ...(children ? { children: toAntdItems(children) } : {}),
  }))
}

function findPurchase(menuItems: PermissionAwareItem[]): PermissionAwareItem | undefined {
  for (const item of menuItems) {
    if (item.label === '采购中心') return item
    if (item.children) {
      const found = findPurchase(item.children)
      if (found) return found
    }
  }
  return undefined
}

const pathToGroupKey: Record<string, string> = {
  '/orders': 'order-delivery',
  '/run-orders': 'order-delivery',
  '/order-risk-pool': 'order-delivery',
  '/stock-check': 'material-center',
  '/purchase-plan': 'material-center',
  '/material-issues': 'material-center',
  '/long-lead-materials': 'material-center',
  '/kit-analysis': 'material-center',
  '/supplier-risk': 'material-center',
  '/supplier-payment': 'material-center',
  '/subcontract-orders': 'material-center',
  '/production-dashboard': 'production-center',
  '/todo-workbench': 'production-center',
  '/change-events': 'production-center',
  '/production-overview': 'production-center',
  '/schedule-plans': 'production-center',
  '/product-process-capacities': 'production-center',
  '/front-process': 'production-center',
  '/smt': 'production-center',
  '/lean': 'production-center',
  '/lean-today': 'production-center',
  '/lean-management': 'production-center',

  '/purchase/price-change': 'purchase-center',
  '/purchase/price-change/new': 'purchase-center',
  '/purchase/price-change/pending': 'purchase-center',
  '/purchase/price-change/config': 'purchase-center',
  '/assembly': 'production-center',
  '/packaging': 'production-center',
  '/process-exceptions': 'production-center',
  '/issues': 'exception-center',
  '/issue-log': 'exception-center',
  '/change-log': 'exception-center',
  '/quality-issues': 'exception-center',
  '/product-samples': 'exception-center',
  '/closure-tracking': 'exception-center',
  '/meetings': 'meeting-center',
  '/npi': 'npi-center',
  '/risk-rules': 'rules-center',
  '/inspection-rules': 'rules-center',
  '/node-standards': 'rules-center',
  '/order-standards': 'rules-center',
  '/work-instructions': 'rules-center',
  '/responsibility-map': 'rules-center',
  '/status-dict': 'rules-center',
  '/import': 'basicdata-center',
  '/basicdata/customers': 'basicdata-management',
  '/basicdata/suppliers': 'basicdata-management',
  '/basicdata/materials': 'basicdata-management',
  '/basicdata/skus': 'basicdata-management',
  '/basicdata/products': 'basicdata-management',
  '/basicdata/warehouses': 'basicdata-management',
  '/basicdata/locations': 'basicdata-management',
  '/basicdata/processes': 'basicdata-management',
  '/basicdata/organizations': 'basicdata-management',
  '/basicdata/positions': 'basicdata-management',
  '/basicdata/employees': 'basicdata-management',
  '/basicdata/inventory': 'basicdata-management',
  '/users': 'basicdata-center',
  '/roles': 'basicdata-center',
  '/audit': 'basicdata-center',
  '/share-management': 'basicdata-center',
  '/sync-config': 'basicdata-center',
  '/basicdata/feedback': 'basicdata-center',
  '/basicdata/files': 'basicdata-center',
  '/basicdata/data-supply': 'basicdata-center',
  '/announcements': 'basicdata-center',
}

const pathToPermission: Record<string, string> = {
  '/dashboard': 'dashboard',
  '/orders': 'orders.list',
  '/run-orders': 'orders.run_orders',
  '/domestic-orders': 'orders.list',
  '/domestic-shipment': 'orders.list',
  '/order-risk-pool': 'orders.risk_pool',
  '/stock-check': 'materials.stock_check',
  '/purchase-plan': 'materials.purchase_plan',
  '/material-issues': 'materials.issues',
  '/long-lead-materials': 'materials.long_lead',
  '/kit-analysis': 'materials.kit_analysis',
  '/supplier-risk': 'materials.supplier_risk',
  '/supplier-payment': 'materials.supplier_payment',
  '/subcontract-orders': 'materials.subcontract_orders',
  '/issues': 'exceptions.pool',
  '/issue-log': 'exceptions.issue_log',
  '/change-log': 'exceptions.change_log',
  '/quality-issues': 'exceptions.quality',
  '/product-samples': 'exceptions.product_samples',
  '/closure-tracking': 'exceptions.closure',
  '/production-dashboard': 'production.overview',
  '/todo-workbench': 'production.schedule_plans',
  '/change-events': 'production.schedule_plans',
  '/schedule-board': 'production.schedule_plans',
  '/production-reports': 'production.daily_report',
  '/production-overview': 'production.overview',
  '/schedule-plans': 'production.schedule_plans',
  '/product-process-capacities': 'production.product_process_capacities',
  '/front-process': 'production.front_process',
  '/smt': 'production.smt',
  '/lean': 'production.lean',
  '/lean-today': 'production.lean',
  '/lean-management': 'production.lean',
  '/assembly': 'production.assembly',
  '/packaging': 'production.packaging',
  '/process-exceptions': 'production.exceptions',
  '/meetings': 'meetings',
  '/npi': 'npi',
  '/import': 'basicdata.import',
  '/risk-rules': 'rules.risk_rules',
  '/inspection-rules': 'rules.inspection',
  '/node-standards': 'rules.node_standards',
  '/order-standards': 'rules.order_standards',
  '/work-instructions': 'rules.work_instructions',
  '/responsibility-map': 'rules.responsibility',
  '/status-dict': 'rules.status_dict',
  '/users': 'users',
  '/roles': 'roles',
  '/audit': 'audit',
  '/share-management': 'basicdata.share_management',
  '/sync-config': 'settings',
  '/permissions': 'permissions',
  '/basicdata/customers': 'basicdata.data',
  '/basicdata/suppliers': 'basicdata.data',
  '/basicdata/materials': 'basicdata.data',
  '/basicdata/skus': 'basicdata.data',
  '/basicdata/products': 'basicdata.data',
  '/basicdata/warehouses': 'basicdata.data',
  '/basicdata/locations': 'basicdata.data',
  '/basicdata/processes': 'basicdata.data',
  '/basicdata/organizations': 'basicdata.data',
  '/basicdata/positions': 'basicdata.data',
  '/basicdata/employees': 'basicdata.data',
  '/basicdata/inventory': 'basicdata.data',
  '/basicdata/feedback': 'basicdata.feedback',
  '/basicdata/files': 'basicdata.files',
  '/basicdata/data-supply': 'basicdata.data_supply',
  '/announcements': 'announcements',
  '/purchase/price-change': 'purchase.price_change',
  '/purchase/price-change/new': 'purchase.price_change',
  '/purchase/price-change/pending': 'purchase.price_change.pending',
  '/purchase/price-change/config': 'purchase.price_change.config',
  '/finance/subject-balances': 'finance.data',
}

function getRequiredPermission(pathname: string, dynamicMap?: Record<string, string>): string | undefined {
  if (dynamicMap && dynamicMap[pathname]) return dynamicMap[pathname]
  if (pathToPermission[pathname]) return pathToPermission[pathname]
  if (pathname.startsWith('/orders/')) return 'orders.list'
  return undefined
}

export default function MainLayout() {
  const { currentUser, logout, hasPermission, isSupplierUser, isShareUser, getShareTargetPath, exitShare, originalToken, setAuth } = useAuthStore()
  const { tree: permTree, loaded: permLoaded, fetchTree, getPathToPermission, getPathToGroupKey } = usePermissionStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [bellOpen, setBellOpen] = useState(false)
  const [notifTab, setNotifTab] = useState('announcement_system')
  const [notifList, setNotifList] = useState<any[]>([])
  const [notifLoading, setNotifLoading] = useState(false)
  const [unreadTotal, setUnreadTotal] = useState(0)
  const [unreadByType, setUnreadByType] = useState<Record<string, number>>({})
  const [pwdModalOpen, setPwdModalOpen] = useState(false)
  const [pwdForm] = Form.useForm()
  const [forcePwdModalOpen, setForcePwdModalOpen] = useState(false)
  const [forcePwdForm] = Form.useForm()
  const [forcePwdDismissable, setForcePwdDismissable] = useState(false)
  const toastShown = useRef(false)

  // 加载权限树
  useEffect(() => {
    if (originalToken && !permLoaded) {
      fetchTree()
    }
  }, [originalToken, permLoaded, fetchTree])

  // 动态菜单项：优先使用 API 数据，fallback 到硬编码
  const dynamicMenuItems = useMemo(() => {
    if (permLoaded && permTree.length > 0) {
      const items = buildMenuItemsFromTree(permTree)
      // 注入 v2 新页面（共享 schedule_plans 权限，不在后端权限树里）
      const v2ExtraItems: PermissionAwareItem[] = [
      { key: '/production-dashboard', icon: <HomeOutlined />, label: '生产驾驶舱', permission: 'production.overview' },
        { key: '/todo-workbench', icon: <ThunderboltOutlined />, label: '待排工作台', permission: 'production.schedule_plans' },
        { key: '/change-events', icon: <AlertOutlined />, label: '变更事件中心', permission: 'production.schedule_plans' },
        { key: '/schedule-board', icon: <ScheduleOutlined />, label: '排产看板', permission: 'production.schedule_plans' },
        { key: '/lean-today', icon: <AuditOutlined />, label: '精益今日看板', permission: 'production.lean' },
        { key: '/lean-management', icon: <AuditOutlined />, label: '精益管理', permission: 'production.lean' },
        { key: '/production-reports', icon: <CheckCircleOutlined />, label: '报工管理', permission: 'production.daily_report' },
      ]
      const merged = items.map(item =>
        item.permission === 'production'
          ? { ...item, children: [...v2ExtraItems, ...(item.children || [])] }
          : item
      )
      // 采购中心：若权限树已有则注入子菜单，否则新增整个模块
      const purchaseChildren: PermissionAwareItem[] = [
        { key: '/purchase/price-change', icon: <FileTextOutlined />, label: '调价单管理', permission: 'purchase.price_change' },
        { key: '/purchase/price-change/pending', icon: <ClockCircleOutlined />, label: '待我审批', permission: 'purchase.price_change.pending' },
        { key: '/purchase/price-change/config', icon: <SettingOutlined />, label: '审批配置', permission: 'purchase.price_change.config' },
      ]
      const existingPurchase = findPurchase(merged)
      if (existingPurchase) {
        const existingKeys = new Set((existingPurchase.children || []).map(c => c.key))
        const newChildren = purchaseChildren.filter(c => !existingKeys.has(c.key))
        if (newChildren.length > 0) {
          existingPurchase.children = [...(existingPurchase.children || []), ...newChildren]
        }
      } else {
        merged.push({
          key: 'purchase-center',
          icon: <AccountBookOutlined />,
          label: '采购中心',
          permission: 'purchase',
          children: purchaseChildren,
        })
      }
      return merged
    }
    return allMenuItems
  }, [permLoaded, permTree])

  // 动态路径映射
  const dynamicPathToPermission = useMemo(() => {
    if (permLoaded && permTree.length > 0) {
      return getPathToPermission()
    }
    return pathToPermission
  }, [permLoaded, permTree, getPathToPermission])

  const dynamicPathToGroupKey = useMemo(() => {
    if (permLoaded && permTree.length > 0) {
      return getPathToGroupKey()
    }
    return pathToGroupKey
  }, [permLoaded, permTree, getPathToGroupKey])

  const canUseTopbar = useMemo(() => ({
    share: hasPermission('topbar.share', 'read'),
    feedback: hasPermission('topbar.feedback', 'read'),
    aiSearch: hasPermission('topbar.ai_search', 'read'),
    fontSize: hasPermission('topbar.font_size', 'read'),
    notifications: hasPermission('topbar.notifications', 'read'),
  }), [hasPermission, currentUser])

  const fetchUnreadCount = useCallback(async () => {
    if (!originalToken || isShareUser() || !canUseTopbar.notifications) return
    try {
      const res: any = await notificationApi.unreadCount()
      setUnreadTotal(res.data?.total || 0)
      setUnreadByType(res.data?.by_type || {})
    } catch { /* silent */ }
  }, [originalToken, isShareUser, canUseTopbar.notifications])

  const fetchNotifList = useCallback(async (tab?: string) => {
    if (!originalToken || isShareUser() || !canUseTopbar.notifications) return
    setNotifLoading(true)
    try {
      const activeTab = tab || notifTab
      const params: Record<string, any> = { page_size: 30 }
      if (activeTab === 'announcement_system') {
        const [annRes, sysRes] = await Promise.all([
          notificationApi.list({ ...params, type: 'announcement' }),
          notificationApi.list({ ...params, type: 'system' })
        ])
        const items = [...(annRes.data?.items || []), ...(sysRes.data?.items || [])]
        items.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        setNotifList(items)
      } else if (activeTab === 'alert') {
        const res: any = await notificationApi.list(params)
        const items = (res.data?.items || []).filter((n: any) => n.type !== 'announcement' && n.type !== 'system')
        setNotifList(items)
      }
    } catch { /* silent */ }
    setNotifLoading(false)
  }, [originalToken, isShareUser, notifTab, canUseTopbar.notifications])

  useEffect(() => {
    if (!originalToken || isShareUser()) return
    authApi.getMe()
      .then((res: any) => {
        if (res.data) {
          setAuth(originalToken, res.data)
        }
      })
      .catch(() => {})
  }, [originalToken, isShareUser, setAuth])

  useEffect(() => {
    if (!originalToken || isShareUser() || !canUseTopbar.notifications) return

    let es: EventSource | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const stopPolling = () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    }
    const startPolling = () => {
      if (pollTimer) return
      fetchUnreadCount()
      pollTimer = setInterval(fetchUnreadCount, 60000)
    }

    const connect = () => {
      if (closed) return
      try {
        es = new EventSource(`/api/v1/notifications/stream?token=${encodeURIComponent(originalToken)}`)
      } catch {
        startPolling()
        return
      }
      es.addEventListener('open', () => {
        // SSE 连上：停掉降级轮询
        stopPolling()
      })
      es.addEventListener('unread', (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data)
          setUnreadTotal(data.total || 0)
          setUnreadByType(data.by_type || {})
        } catch { /* silent */ }
      })
      es.addEventListener('error', () => {
        // 断开/Redis 故障：关 SSE → 启动降级轮询；30s 后尝试恢复实时
        try { es?.close() } catch { /* silent */ }
        es = null
        startPolling()
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => { if (!closed) connect() }, 30000)
      })
    }

    connect()

    return () => {
      closed = true
      try { es?.close() } catch { /* silent */ }
      stopPolling()
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [originalToken, isShareUser, canUseTopbar.notifications, fetchUnreadCount])

  useEffect(() => {
    if (!originalToken || isShareUser() || !canUseTopbar.notifications || toastShown.current) return
    if (sessionStorage.getItem('notif_toast_shown')) { toastShown.current = true; return }
    const showToast = async () => {
      try {
        const res: any = await notificationApi.list({ is_read: false, page_size: 5 })
        const items = (res.data?.items || []).filter((n: any) => n.priority === 'important' || n.priority === 'urgent')
        if (items.length > 0) {
          antNotification.info({
            message: '您有新的公告',
            description: items.map((n: any) => n.title).join('、'),
            placement: 'topRight',
            duration: 8,
            onClick: () => { setBellOpen(true) },
          })
        }
      } catch { /* silent */ }
      toastShown.current = true
      sessionStorage.setItem('notif_toast_shown', '1')
    }
    const t = setTimeout(showToast, 2000)
    return () => clearTimeout(t)
  }, [originalToken, isShareUser, canUseTopbar.notifications])

  useEffect(() => {
    if (bellOpen) fetchNotifList(notifTab)
  }, [bellOpen, notifTab, fetchNotifList])

  useEffect(() => {
    if (currentUser && 'is_default_password' in currentUser && currentUser.is_default_password) {
      setForcePwdDismissable(false)
      setForcePwdModalOpen(true)
    }
  }, [currentUser])

  const handleMarkRead = async (id: number) => {
    await notificationApi.markRead(id)
    setNotifList(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n))
    fetchUnreadCount()
  }

  const handleMarkAllRead = async () => {
    if (notifTab === 'announcement_system') {
      await Promise.all([
        notificationApi.markAllRead('announcement'),
        notificationApi.markAllRead('system')
      ])
    } else {
      await notificationApi.markAllRead(notifTab)
    }
    setNotifList(prev => prev.map(n => ({ ...n, is_read: true })))
    fetchUnreadCount()
  }

  const handleChangePassword = async () => {
    try {
      const values = await pwdForm.validateFields()
      await authApi.changePassword(values.old_password, values.new_password)
      message.success('密码修改成功')
      setPwdModalOpen(false)
      pwdForm.resetFields()
      const user = useAuthStore.getState().currentUser
      if (user && 'is_default_password' in user) {
        useAuthStore.getState().setAuth(useAuthStore.getState().originalToken!, { ...user, is_default_password: false } as any)
      }
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  const handleForceChangePassword = async () => {
    try {
      const values = await forcePwdForm.validateFields()
      await authApi.changePassword(values.old_password, values.new_password)
      message.success('密码修改成功')
      setForcePwdModalOpen(false)
      forcePwdForm.resetFields()
      const user = useAuthStore.getState().currentUser
      if (user && 'is_default_password' in user) {
        useAuthStore.getState().setAuth(useAuthStore.getState().originalToken!, { ...user, is_default_password: false } as any)
      }
      logout()
      navigate('/login')
    } catch (e: any) {
      // 错误已由全局拦截器提示
    }
  }

  const menuItems = useMemo(() => {
    if (isShareUser()) {
      const targetPath = getShareTargetPath()
      if (targetPath) {
        return toAntdItems(filterMenuByPath(dynamicMenuItems, targetPath, hasPermission))
      }
      return []
    }
    if (isSupplierUser()) {
      return toAntdItems(filterSupplierPortalMenu(dynamicMenuItems, hasPermission))
    }
    const filtered = filterMenuByPermission(dynamicMenuItems, hasPermission)
    return toAntdItems(filtered)
  }, [hasPermission, currentUser, isSupplierUser, isShareUser, getShareTargetPath, dynamicMenuItems])

  const requiredPermission = getRequiredPermission(location.pathname, dynamicPathToPermission)
  const canViewCurrentPage = !requiredPermission || hasPermission(requiredPermission, 'read')
  const openKeys = useMemo(() => {
    const gk = dynamicPathToGroupKey[location.pathname]
    return gk ? [gk] : []
  }, [location.pathname, dynamicPathToGroupKey])

  return (
    <Layout className="min-h-screen" style={{ background: '#f0f4f8' }}>
      {!isShareUser() && (
        <Sider
          trigger={null}
          collapsible
          collapsed={collapsed}
          width={256}
          className="sidebar-modern"
          style={{
            overflowY: 'auto',
            height: '100vh',
            position: 'fixed',
            left: 0,
            top: 0,
            bottom: 0,
            zIndex: 10,
          }}
        >
          <div className="flex items-center gap-3 px-6" style={{ height: 72, paddingTop: 16, paddingBottom: 16 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(99, 102, 241, 0.3)' }}>
              <span style={{ color: '#fff', fontWeight: 700, fontSize: 'calc(1rem * var(--font-size-scale))', letterSpacing: 1 }}>S</span>
            </div>
            {!collapsed && (
              <div className="flex flex-col">
                <span className="font-bold" style={{ color: '#fff', fontSize: 'calc(1.125rem * var(--font-size-scale))', letterSpacing: 0.5 }}>
                  SPC 中台
                </span>
                <span style={{ color: '#94a3b8', fontSize: 'calc(0.6875rem * var(--font-size-scale))', fontWeight: 400, letterSpacing: 1, textTransform: 'uppercase' }}>
                  供应链协同
                </span>
              </div>
            )}
          </div>

          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[location.pathname]}
            defaultOpenKeys={openKeys}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
          />
        </Sider>
      )}

      <Layout style={{ marginLeft: !isShareUser() && collapsed ? 80 : (!isShareUser() ? 256 : 0), transition: 'margin-left .2s', minHeight: '100vh' }}>
        <div className="header-bar" style={{ position: 'sticky', top: 0, zIndex: 9 }}>
          {!isShareUser() && (
            <Space size="middle">
              <Button
                type="text"
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed(!collapsed)}
                style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))', width: 36, height: 36, borderRadius: 10 }}
              />
            </Space>
          )}
          <Space size="middle">
            {!isShareUser() && !isSupplierUser() && canUseTopbar.share && <ShareButton />}
            {!isSupplierUser() && canUseTopbar.feedback && <FeedbackButton />}
            {canUseTopbar.fontSize && <FontSizeSetting />}
            {canUseTopbar.notifications && (
              <Popover
                open={bellOpen}
                onOpenChange={setBellOpen}
                trigger="click"
                placement="bottomRight"
                overlayStyle={{ width: 380 }}
                content={
                  <div style={{ margin: '-12px -16px' }}>
                    <Tabs
                      activeKey={notifTab}
                      onChange={setNotifTab}
                      centered
                      size="small"
                      style={{ marginBottom: 0 }}
                      items={[
                        {
                          key: 'announcement_system',
                          label: <span style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))' }}><SoundOutlined /> 公告系统 {(unreadByType['announcement'] || 0) + (unreadByType['system'] || 0) > 0 ? <Badge count={(unreadByType['announcement'] || 0) + (unreadByType['system'] || 0)} size="small" offset={[4, -2]} /> : null}</span>,
                        },
                        {
                          key: 'alert',
                          label: <span style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))' }}><WarningOutlined /> 提醒 {(unreadByType['material_alert'] || 0) + (unreadByType['exception_alert'] || 0) > 0 ? <Badge count={(unreadByType['material_alert'] || 0) + (unreadByType['exception_alert'] || 0)} size="small" offset={[4, -2]} /> : null}</span>,
                        },
                      ]}
                    />
                    <List
                      loading={notifLoading}
                      dataSource={notifList}
                      locale={{ emptyText: '暂无消息' }}
                      style={{ maxHeight: 360, overflowY: 'auto', padding: '0 12px' }}
                      renderItem={(item: any) => (
                        <List.Item
                          key={item.id}
                          style={{ cursor: 'pointer', padding: '10px 4px', opacity: item.is_read ? 0.55 : 1 }}
                          onClick={() => { if (!item.is_read) handleMarkRead(item.id) }}
                        >
                          <List.Item.Meta
                            title={
                              <Space size={4}>
                                {!item.is_read && <Badge status="processing" />}
                                <Typography.Text style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))' }} strong={!item.is_read}>{item.title}</Typography.Text>
                                {item.priority === 'urgent' && <Tag color="red" style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))', lineHeight: '18px' }}>紧急</Tag>}
                                {item.priority === 'important' && <Tag color="gold" style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))', lineHeight: '18px' }}>重要</Tag>}
                              </Space>
                            }
                            description={<Typography.Text type="secondary" style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))' }}>{item.created_at}</Typography.Text>}
                          />
                        </List.Item>
                      )}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderTop: '1px solid #f0f0f0' }}>
                      <Button type="link" size="small" icon={<CheckOutlined />} onClick={handleMarkAllRead} style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))' }}>全部已读</Button>
                      <Button type="link" size="small" onClick={() => { setBellOpen(false); navigate('/announcements') }} style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))' }}>查看全部</Button>
                    </div>
                  </div>
                }
              >
                <Badge count={unreadTotal} size="small" offset={[-4, 4]}>
                  <Button type="text" icon={<BellOutlined />} style={{ fontSize: 'calc(0.875rem * var(--font-size-scale))', width: 36, height: 36, borderRadius: 10, color: '#64748b' }} />
                </Badge>
              </Popover>
            )}
            {isShareUser() ? (
              <Button
                type="primary"
                icon={<LogoutOutlined />}
                onClick={() => { exitShare(); navigate('/dashboard') }}
              >
                退出分享
              </Button>
            ) : (
              <Dropdown
                menu={{
                  items: [
                    { key: 'change-pwd', icon: <KeyOutlined />, label: '修改密码' },
                    { type: 'divider' as const },
                    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'logout') { logout(); navigate('/login') }
                    if (key === 'change-pwd') { pwdForm.resetFields(); setPwdModalOpen(true) }
                  },
                }}
              >
                <Space className="cursor-pointer" style={{ padding: '4px 12px', borderRadius: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg, #6366f1, #818cf8)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <UserOutlined style={{ color: '#fff', fontSize: 'calc(0.875rem * var(--font-size-scale))' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                    <span style={{ color: '#334155', fontSize: 'calc(0.875rem * var(--font-size-scale))', fontWeight: 500 }}>
                      {currentUser && 'display_name' in currentUser ? (currentUser.display_name || currentUser.username) : '用户'}
                    </span>
                    {currentUser && 'position_name' in currentUser && currentUser.position_name && (
                      <span style={{ color: '#94a3b8', fontSize: 'calc(0.75rem * var(--font-size-scale))', fontWeight: 400 }}>
                        {currentUser.position_name}
                      </span>
                    )}
                  </div>
                </Space>
              </Dropdown>
            )}
          </Space>
        </div>

        <Modal
          title="修改密码"
          open={pwdModalOpen}
          onOk={handleChangePassword}
          onCancel={() => setPwdModalOpen(false)}
          width={420}
          okText="确认修改"
        >
          <Form form={pwdForm} layout="vertical" style={{ marginTop: 16 }}>
            <Form.Item name="old_password" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
              <Input.Password placeholder="输入当前密码" />
            </Form.Item>
            <Form.Item name="new_password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 6, message: '密码至少6位' }]}>
              <Input.Password placeholder="至少6位" />
            </Form.Item>
            <Form.Item
              name="confirm_password"
              label="确认新密码"
              dependencies={['new_password']}
              rules={[
                { required: true, message: '请确认新密码' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                    return Promise.reject(new Error('两次密码不一致'))
                  },
                }),
              ]}
            >
              <Input.Password placeholder="再次输入新密码" />
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          title="安全提醒 — 请修改默认密码"
          open={forcePwdModalOpen}
          onOk={handleForceChangePassword}
          onCancel={forcePwdDismissable ? () => { setForcePwdModalOpen(false); forcePwdForm.resetFields() } : undefined}
          closable={forcePwdDismissable}
          maskClosable={forcePwdDismissable}
          width={420}
          okText="确认修改"
          cancelText={forcePwdDismissable ? '稍后再说' : undefined}
          cancelButtonProps={forcePwdDismissable ? undefined : { style: { display: 'none' } }}
        >
          <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 6, color: '#ad6800', fontSize: 13 }}>
            检测到您正在使用默认密码，为保障账号安全，请立即修改密码
          </div>
          <Form form={forcePwdForm} layout="vertical" style={{ marginTop: 8 }}>
            <Form.Item name="old_password" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
              <Input.Password placeholder="输入当前密码" />
            </Form.Item>
            <Form.Item name="new_password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 6, message: '密码至少6位' }]}>
              <Input.Password placeholder="至少6位" />
            </Form.Item>
            <Form.Item
              name="confirm_password"
              label="确认新密码"
              dependencies={['new_password']}
              rules={[
                { required: true, message: '请确认新密码' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                    return Promise.reject(new Error('两次密码不一致'))
                  },
                }),
              ]}
            >
              <Input.Password placeholder="再次输入新密码" />
            </Form.Item>
          </Form>
        </Modal>

        <Content style={{ padding: '12px 24px 24px' }}>
          {canViewCurrentPage ? (
            <Outlet />
          ) : (
            <Result
              status="403"
              title="无访问权限"
              subTitle={`缺少 ${requiredPermission}.read 权限`}
            />
          )}
        </Content>
      </Layout>

      {/* AI 智能助手：右下角悬浮球，可自由拖动，闲置自动收进右侧边 */}
      {!isSupplierUser() && canUseTopbar.aiSearch && <FloatingAssistant />}
    </Layout>
  )
}
