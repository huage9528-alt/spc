import React from 'react'
import {BrowserRouter, Routes, Route, Navigate, useLocation} from 'react-router-dom'
import {App as AntdApp, ConfigProvider, Result, Button} from 'antd'
import MainLayout from './layouts/MainLayout'
import Dashboard from './pages/Dashboard/index'
import OrderList from './pages/OrderDelivery/OrderList/index'
import RunOrderList from './pages/OrderDelivery/RunOrderList/index'
import DomesticOrders from './pages/OrderDelivery/DomesticOrders/index'
import DomesticShipment from './pages/OrderDelivery/DomesticShipment/index'
import OrderRiskPool from './pages/OrderDelivery/OrderRiskPool/index'
import PurchasePlan from './pages/MaterialCenter/PurchasePlan/index'
import MaterialIssues from './pages/MaterialCenter/MaterialIssues/index'
import LongLeadMaterials from './pages/MaterialCenter/LongLeadMaterials/index'
import KitAnalysis from './pages/MaterialCenter/KitAnalysis/index'
import SupplierRisk from './pages/MaterialCenter/SupplierRisk/index'
import SupplierPayment from './pages/MaterialCenter/SupplierPayment/index'
import OrderDetail from './pages/OrderDelivery/OrderDetail/index'
import StockCheck from './pages/MaterialCenter/StockCheck/index'
import StockCheckWorkbench from './pages/MaterialCenter/StockCheck/Workbench'
import QuickCount from './pages/MaterialCenter/StockCheck/QuickCount'
import TaskStockCoverage from './pages/MaterialCenter/TaskStockCoverage'
import SubcontractOrders from './pages/MaterialCenter/SubcontractOrders/index'
import ScrapInventory from './pages/MaterialCenter/ScrapInventory'
import IssueLedger from './pages/ExceptionCenter/IssueLedger/index'
import ExceptionPool from './pages/ExceptionCenter/ExceptionPool/index'
import IssueLogView from './pages/ExceptionCenter/IssueLogView/index'
import ChangeLogView from './pages/ExceptionCenter/ChangeLogView/index'
import QualityIssues from './pages/ExceptionCenter/QualityIssues/index'
import ProductSamples from './pages/ExceptionCenter/ProductSamples/index'
import ClosureTracking from './pages/ExceptionCenter/ClosureTracking/index'
import DataImport from './pages/BasicDataCenter/DataIntegration/index'
import {
    RiskRules,
    InspectionRules,
    NodeStandards,
    ResponsibilityMap,
    StatusDictionary,
    OrderStandards,
    WorkInstructions
} from './pages/RulesCenter'
import {
    UserManagement,
    AuditLog,
    SyncSqlConfig,
    FeedbackManagement,
    FileManagement,
    AnnouncementManagement,
    RoleManagement,
    PermissionManagement,
    DataSupply,
    ShareManagement
} from './pages/BasicDataCenter'
import WritebackConfig from './pages/BasicDataCenter/WritebackConfig'
import WritebackMonitor from './pages/WritebackMonitor/index'
import Customers from './pages/BasicDataCenter/Customers'
import Suppliers from './pages/BasicDataCenter/Suppliers'
import SupplierMaterialMap from './pages/BasicDataCenter/SupplierMaterialMap'
import Materials from './pages/BasicDataCenter/Materials'
import SKUs from './pages/BasicDataCenter/SKUs'
import Products from './pages/BasicDataCenter/Products'
import Warehouses from './pages/BasicDataCenter/Warehouses'
import Processes from './pages/BasicDataCenter/Processes'
import Organizations from './pages/BasicDataCenter/Organizations'
import Positions from './pages/BasicDataCenter/Positions'
import Employees from './pages/BasicDataCenter/Employees'
import Locations from './pages/BasicDataCenter/Locations'
import Inventory from './pages/BasicDataCenter/Inventory'
import ProductionOverview from './pages/ProductionCenter/ProductionOverview/index'
import Dashboard372 from './pages/ProductionCenter/Dashboard372/index'
import SchedulePlans from './pages/ProductionCenter/SchedulePlans/index'
import TodoWorkbench from './pages/ProductionCenter/TodoWorkbench/index'
import ChangeEvents from './pages/ProductionCenter/ChangeEvents/index'
import ScheduleBoard from './pages/ProductionCenter/ScheduleBoard/index'
import FrontProcess from './pages/ProductionCenter/FrontProcess/index'
import SMT from './pages/ProductionCenter/SMT/index'
import Lean from './pages/ProductionCenter/Lean/index'
import LeanManagement from './pages/ProductionCenter/Lean/management'
import Assembly from './pages/ProductionCenter/Assembly/index'
import Packaging from './pages/ProductionCenter/Packaging/index'
import ProcessExceptions from './pages/ProductionCenter/ProcessExceptions/index'
import ProductProcessCapacity from './pages/ProductionCenter/ProductProcessCapacity/index'
import DailyReports from './pages/ProductionCenter/DailyReports/index'
import WorkshopDailyReportForm from './pages/ProductionCenter/DailyReports/ReportForm'
import ProductionReports from './pages/ProductionCenter/ProductionReports/index'
import MeetingCenter from './pages/MeetingCenter/index'
import NPICenter from './pages/NPICenter/index'
import Login from './pages/Login'
import Profile from './pages/Profile'
import ShareAccess from './pages/ShareAccess'
import DeployVersions from './pages/SystemCenter/DeployVersions'
import PriceChangeList from './pages/Purchase/PriceChange/list'
import PriceChangeNew from './pages/Purchase/PriceChange/new'
import PriceChangeDetail from './pages/Purchase/PriceChange/detail'
import PriceChangePending from './pages/Purchase/PriceChange/pending'
import ApprovalConfig from './pages/Purchase/PriceChange/config'
import SubjectBalances from './pages/FinanceCenter/SubjectBalances/index'
import {useAuthStore} from './store/auth'
import {useThemeStore} from './store/theme'
import {setGlobalMessageApi} from './utils/antdMessage'

function AntdMessageBridge() {
    const {message} = AntdApp.useApp()

    React.useEffect(() => {
        setGlobalMessageApi(message)
    }, [message])

    return null
}

function PrivateRoute({children}: { children: React.ReactNode }) {
    const token = useAuthStore((s) => s.currentToken)
    const location = useLocation()
    if (!token) return <Navigate to="/login" replace state={{ from: location }}/>
    return <>{children}</>
}

// 检查分享用户是否有权访问当前路径
function ShareRouteGuard({children}: { children: React.ReactNode }) {
    const {isShareUser, getShareTargetPath} = useAuthStore()
    const location = useLocation()

    if (!isShareUser()) return <>{children}</>

    const targetPath = getShareTargetPath()
    if (!targetPath) return <>{children}</>

    const currentPath = location.pathname

    // 动态路由匹配（如 /orders/:orderNo/lines/:lineNo）
    if (targetPath.includes(':')) {
        const prefix = targetPath.split('/:')[0]
        if (currentPath.startsWith(prefix)) return <>{children}</>
    }

    // 精确匹配
    if (currentPath === targetPath) return <>{children}</>

    // 子路径匹配（如 /basicdata/customers 匹配 /basicdata）
    if (currentPath.startsWith(targetPath)) return <>{children}</>

    // 不匹配：显示无权限
    return (
        <div style={{display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh'}}>
            <Result
                status="403"
                title="无访问权限"
                subTitle="您只能访问分享的页面，其他页面无权查看"
            />
        </div>
    )
}

export default function App() {
    const {fontSizeScale} = useThemeStore()

    // Apply font scale to root element
    React.useEffect(() => {
        document.documentElement.style.setProperty('--font-size-scale', fontSizeScale.toString())
    }, [fontSizeScale])

    return (
        <ConfigProvider
            theme={{
                token: {
                    fontSize: 14 * fontSizeScale,
                },
            }}
        >
            <AntdApp>
                <AntdMessageBridge/>
                <BrowserRouter>
                    <Routes>
                        <Route path="/login" element={<Login/>}/>
                        <Route path="/share/:token" element={<ShareAccess/>}/>
                        <Route
                            path="/"
                            element={
                                <PrivateRoute>
                                    <ShareRouteGuard>
                                        <MainLayout/>
                                    </ShareRouteGuard>
                                </PrivateRoute>
                            }
                        >
                            <Route index element={<Navigate to="/dashboard" replace/>}/>
                            <Route path="profile" element={<Profile/>}/>
                            <Route path="dashboard" element={<Dashboard/>}/>
                            <Route path="orders" element={<OrderList/>}/>
                            <Route path="run-orders" element={<RunOrderList/>}/>
                            <Route path="domestic-orders" element={<DomesticOrders/>}/>
                            <Route path="domestic-shipment" element={<DomesticShipment/>}/>
                            <Route path="order-risk-pool" element={<OrderRiskPool/>}/>
                            <Route path="purchase-plan" element={<PurchasePlan/>}/>
                            <Route path="material-issues" element={<MaterialIssues/>}/>
                            <Route path="long-lead-materials" element={<LongLeadMaterials/>}/>
                            <Route path="stock-check" element={<StockCheck />} />
                            <Route path="stock-check/:checkId" element={<StockCheckWorkbench />} />
                            <Route path="quick-stock-check" element={<QuickCount />} />
                            <Route path="task-stock-check" element={<TaskStockCoverage />} />
                            <Route path="subcontract-orders" element={<SubcontractOrders/>}/>
                            <Route path="scrap-inventory" element={<ScrapInventory/>}/>
                            <Route path="kit-analysis" element={<KitAnalysis/>}/>
                            <Route path="supplier-risk" element={<SupplierRisk/>}/>
                            <Route path="supplier-payment" element={<SupplierPayment/>}/>
                            <Route path="orders/:orderNo" element={<OrderDetail/>}/>
                            <Route path="orders/:orderNo/lines/:lineNo" element={<OrderDetail/>}/>
                            <Route path="issues" element={<ExceptionPool/>}/>
                            <Route path="issue-log" element={<IssueLogView/>}/>
                            <Route path="change-log" element={<ChangeLogView/>}/>
                            <Route path="quality-issues" element={<QualityIssues/>}/>
                            <Route path="product-samples" element={<ProductSamples/>}/>
                            <Route path="closure-tracking" element={<ClosureTracking/>}/>
                            <Route path="production" element={<Navigate to="/production-overview" replace/>}/>
                            <Route path="production-overview" element={<ProductionOverview/>}/>
                            <Route path="production-dashboard" element={<Dashboard372/>}/>
                            <Route path="schedule-plans" element={<SchedulePlans/>}/>
                            <Route path="todo-workbench" element={<TodoWorkbench/>}/>
                            <Route path="change-events" element={<ChangeEvents/>}/>
                            <Route path="schedule-board" element={<ScheduleBoard/>}/>
                            <Route path="front-process" element={<FrontProcess/>}/>
                            <Route path="smt" element={<SMT/>}/>
                            <Route path="lean-today" element={<Lean/>}/>
                            <Route path="lean" element={<Lean/>}/>
                            <Route path="lean-management" element={<LeanManagement/>}/>
                            <Route path="assembly" element={<Assembly/>}/>
                            <Route path="packaging" element={<Packaging/>}/>
                            <Route path="product-process-capacities" element={<ProductProcessCapacity/>}/>
                            <Route path="process-exceptions" element={<ProcessExceptions/>}/>
                            <Route path="daily-reports" element={<DailyReports/>}/>
                            <Route path="production-reports" element={<ProductionReports/>}/>
                            <Route path="daily-reports/new" element={<WorkshopDailyReportForm mode="create"/>}/>
                            <Route path="daily-reports/:id/edit" element={<WorkshopDailyReportForm mode="edit"/>}/>
                            <Route path="daily-reports/:id/view" element={<WorkshopDailyReportForm mode="view"/>}/>
                            <Route path="meetings" element={<MeetingCenter/>}/>
                            <Route path="npi" element={<NPICenter/>}/>
                            <Route path="import" element={<DataImport/>}/>
                            <Route path="risk-rules" element={<RiskRules/>}/>
                            <Route path="inspection-rules" element={<InspectionRules/>}/>
                            <Route path="node-standards" element={<NodeStandards/>}/>
                            <Route path="responsibility-map" element={<ResponsibilityMap/>}/>
                            <Route path="status-dict" element={<StatusDictionary/>}/>
                            <Route path="order-standards" element={<OrderStandards/>}/>
                            <Route path="work-instructions" element={<WorkInstructions/>}/>
                            <Route path="users" element={<UserManagement/>}/>
                            <Route path="roles" element={<RoleManagement/>}/>
                            <Route path="permissions" element={<PermissionManagement/>}/>
                            <Route path="audit" element={<AuditLog/>}/>
                            <Route path="share-management" element={<ShareManagement/>}/>
                            <Route path="sync-config" element={<SyncSqlConfig/>}/>
                            <Route path="writeback-config" element={<WritebackConfig/>}/>
                            <Route path="writeback-monitor" element={<WritebackMonitor/>}/>
                            <Route path="basicdata" element={<Navigate to="/basicdata/customers" replace/>}/>
                            <Route path="masterdata" element={<Navigate to="/basicdata/customers" replace/>}/>
                            <Route path="basicdata/customers" element={<Customers/>} key="customers"/>
                            <Route path="basicdata/suppliers" element={<Suppliers/>} key="suppliers"/>
                            <Route path="basicdata/supplier-material-map" element={<SupplierMaterialMap/>} key="supplier-material-map"/>
                            <Route path="basicdata/materials" element={<Materials/>} key="materials"/>
                            <Route path="basicdata/skus" element={<SKUs/>} key="skus"/>
                            <Route path="basicdata/products" element={<Products/>} key="products"/>
                            <Route path="basicdata/warehouses" element={<Warehouses/>} key="warehouses"/>
                            <Route path="basicdata/processes" element={<Processes/>} key="processes"/>
                            <Route path="basicdata/organizations" element={<Organizations/>} key="organizations"/>
                            <Route path="basicdata/positions" element={<Positions/>} key="positions"/>
                            <Route path="basicdata/employees" element={<Employees/>} key="employees"/>
                            <Route path="basicdata/locations" element={<Locations />} key="locations" />
                            <Route path="basicdata/inventory" element={<Inventory />} key="inventory" />
                            <Route path="basicdata/feedback" element={<FeedbackManagement/>} key="feedback"/>
                            <Route path="basicdata/files" element={<FileManagement/>} key="files"/>
                            <Route path="basicdata/data-supply" element={<DataSupply/>} key="data-supply"/>
                            <Route path="announcements" element={<AnnouncementManagement/>} key="announcements"/>
                            {/* 兼容旧权限 route_path：/sys/deploy-versions → /deploy-versions */}
                            <Route path="sys/deploy-versions" element={<Navigate to="/deploy-versions" replace/>}/>
                            <Route path="deploy-versions" element={<DeployVersions/>} key="deploy-versions"/>
                            <Route path="purchase/price-change" element={<PriceChangeList/>}/>
                            <Route path="purchase/price-change/new" element={<PriceChangeNew/>}/>
                            <Route path="purchase/price-change/pending" element={<PriceChangePending/>}/>
                            <Route path="purchase/price-change/config" element={<ApprovalConfig/>}/>
                            <Route path="purchase/price-change/:id" element={<PriceChangeDetail/>}/>
                            <Route path="finance/subject-balances" element={<SubjectBalances/>} key="finance-subject-balances"/>
                        </Route>
                    </Routes>
                </BrowserRouter>
            </AntdApp>
        </ConfigProvider>
    )
}
