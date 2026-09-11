"""物料盘点 (scm_inventory_check) Schemas"""

from typing import Optional, List, Any, Dict
from datetime import date, datetime
from decimal import Decimal
from pydantic import BaseModel


class StockCheckProductSelection(BaseModel):
    """订单盘点时选中的产品行标识(对应 get_order_product_materials 的一个分组)"""
    product_code: Optional[str] = None
    bom_no: Optional[str] = None


class StockCheckCreate(BaseModel):
    """从订单创建盘点单的入参(order_no 已存在 URL path 中,body 可省略)"""
    order_no: Optional[str] = None
    title: Optional[str] = None
    check_date: Optional[date] = None
    remark: Optional[str] = None
    # 指定要盘点哪些产品行;省略/为 None = 全部产品行(向后兼容),为空列表 = 未选(报错)
    selected_products: Optional[List[StockCheckProductSelection]] = None
    co_checker_user_ids: Optional[List[int]] = None
    # 近 N 天内已盘视为"近期已盘"免盘;省略 = 服务端配置默认(7 天);-1 = 不限(全部历史)
    recent_days: Optional[int] = None


class StockCheckMaterialSelection(BaseModel):
    """手动盘点: 选中一个「物料 × 仓库」组合; wh_id=None 表示未入库合成行"""
    material_id: int
    wh_id: Optional[int] = None


class StockCheckFromMaterialsCreate(BaseModel):
    """手动盘点: 用户从物料库选定物料的提交体。

    items: 新方式, 按 (物料, 仓库) 精确创建;
    material_ids: 旧兼容方式, 整物料全仓库; 两者可同时提交并合并去重。
    """
    material_ids: Optional[List[int]] = None
    items: Optional[List[StockCheckMaterialSelection]] = None
    title: Optional[str] = None
    check_date: Optional[date] = None
    remark: Optional[str] = None
    co_checker_user_ids: Optional[List[int]] = None
    # 近 N 天内已盘的行打「近期已盘」免盘标记; 省略 = 不标记; -1 = 不限(全部历史)
    recent_days: Optional[int] = None


class CoCheckersUpdate(BaseModel):
    co_checker_user_ids: List[int] = []
    expected_version: Optional[int] = None


class QuickCountIn(BaseModel):
    """快捷盘点: 搜索物料直接录入实盘数"""
    material_id: int
    wh_id: Optional[int] = None
    actual_qty: Decimal


class PresenceUpdate(BaseModel):
    """协作存在感:某用户正在编辑 item_id;item_id=None 表示离开/idle"""
    item_id: Optional[int] = None


class MaterialCandidateOut(BaseModel):
    """手动盘点选物料弹窗中的候选项,含即时库存与仓库维度(每「物料×仓库」一行)"""
    erp_material_id: int
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    system_qty: Optional[Decimal] = None
    wh_id: Optional[int] = None
    wh_code: Optional[str] = None
    wh_name: Optional[str] = None
    recent_checked_check_no: Optional[str] = None
    recent_checked_date: Optional[date] = None

    model_config = {"from_attributes": True}


class ScanWarehouseOut(BaseModel):
    """扫码盘点: 仓库精简项(顶部选择器 / 物料卡仓库切换)"""
    wh_id: int
    wh_code: Optional[str] = None
    wh_name: Optional[str] = None
    system_qty: Optional[Decimal] = None


class ResolvedCodeOut(BaseModel):
    """扫码盘点: 编码 → 物料解析结果"""
    erp_material_id: int
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    resolved_by: str = "material_code"  # material_code | sku_barcode
    wh_id: Optional[int] = None
    wh_code: Optional[str] = None
    wh_name: Optional[str] = None
    # 所选仓库的系统库存(scm_inventory 按 物料×仓库 汇总 qty_on_hand);
    # 未传 wh_id = null; 传了但无库存行 = 0(与候选列表"(未入库)"口径一致)
    system_qty: Optional[Decimal] = None
    warehouses: List[ScanWarehouseOut] = []


class StockCheckCountedItemOut(BaseModel):
    """已盘点物料台账: 每个「物料×仓库」取最近一条已盘点(actual_qty 非空、未取消)记录"""
    check_id: Optional[int] = None
    check_no: Optional[str] = None
    check_date: Optional[date] = None
    check_type: Optional[str] = None
    status: Optional[str] = None
    material_id: Optional[int] = None
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    wh_id: Optional[int] = None
    wh_code: Optional[str] = None
    wh_name: Optional[str] = None
    system_qty: Optional[Decimal] = None
    system_qty_time: Optional[datetime] = None
    req_qty: Optional[Decimal] = None
    actual_qty: Optional[Decimal] = None
    diff_qty: Optional[Decimal] = None
    counted_by: Optional[str] = None
    counted_at: Optional[datetime] = None
    checked_at: Optional[datetime] = None
    live_qty: Optional[Decimal] = None
    # 运行时计算: 未入库行(wh_id=NULL)物料现已入库时的实时仓库名(顿号分隔)
    live_wh_names: Optional[str] = None

    model_config = {"from_attributes": True}


class StockCheckItemUpdate(BaseModel):
    """单行更新(单行 PUT 或批量 batch 的子项)"""
    id: Optional[int] = None
    actual_qty: Optional[Decimal] = None
    is_checked: Optional[int] = None
    remark: Optional[str] = None
    force_recount: Optional[bool] = None
    expected_version: Optional[int] = None


class StockCheckItemBatchUpdate(BaseModel):
    check_id: int
    items: List[StockCheckItemUpdate]


class StockCheckItemOut(BaseModel):
    id: int
    version: Optional[int] = None
    check_id: int
    line_no: Optional[str] = None
    level: Optional[int] = None
    material_id: Optional[int] = None
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    req_qty: Optional[Decimal] = None
    system_qty: Optional[Decimal] = None
    system_qty_time: Optional[datetime] = None
    actual_qty: Optional[Decimal] = None
    diff_qty: Optional[Decimal] = None
    is_checked: Optional[int] = None
    checked_at: Optional[datetime] = None
    checked_by: Optional[str] = None
    counted_by_user_id: Optional[int] = None
    counted_by: Optional[str] = None
    counted_at: Optional[datetime] = None
    remark: Optional[str] = None
    material_property_label: Optional[str] = None
    material_type: Optional[str] = None
    wh_id: Optional[int] = None
    wh_name: Optional[str] = None
    wh_code: Optional[str] = None
    recent_checked_check_no: Optional[str] = None
    recent_checked_date: Optional[date] = None
    warehouses: Optional[str] = None
    # 运行时计算(读详情时实时查 scm_inventory,不落库)
    live_qty: Optional[Decimal] = None
    # 运行时计算: 未入库行(wh_id=NULL)物料现已入库时的实时仓库名(顿号分隔)
    live_wh_names: Optional[str] = None
    # 运行时计算: True=未盘点,快照库存展示为实时值;录入盘点数时冻结
    snapshot_live: Optional[bool] = None
    # 运行时计算: 仓库展示名(含实时仓库),供前端筛选/排序/展示
    warehouse_display: Optional[str] = None

    model_config = {"from_attributes": True}


class StockCheckOut(BaseModel):
    id: int
    version: Optional[int] = None
    check_no: str
    order_no: Optional[str] = None
    title: Optional[str] = None
    check_type: Optional[str] = None
    status: Optional[str] = None
    check_date: Optional[date] = None
    total_materials: Optional[int] = None
    checked_materials: Optional[int] = None
    total_diff_qty: Optional[Decimal] = None
    created_by: Optional[str] = None
    checked_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    remark: Optional[str] = None
    covered_products: Optional[List[Dict[str, Any]]] = None
    co_checker_user_ids: Optional[List[int]] = None
    created_by_user_id: Optional[int] = None
    source: Optional[str] = None
    erp_bill_no: Optional[str] = None
    # 以下为运行时计算字段
    co_checkers: Optional[List[Dict[str, Any]]] = None  # [{user_id, name}]
    can_edit: Optional[bool] = None
    items: List[StockCheckItemOut] = []
    # 盘点完结时的 K3 回写摘要 {total, success, failed, pending};仅 complete 响应携带
    writeback_summary: Optional[Dict[str, Any]] = None

    model_config = {"from_attributes": True}


class StockCheckListOut(BaseModel):
    id: int
    check_no: str
    order_no: Optional[str] = None
    title: Optional[str] = None
    check_type: Optional[str] = None
    status: Optional[str] = None
    check_date: Optional[date] = None
    total_materials: Optional[int] = None
    checked_materials: Optional[int] = None
    total_diff_qty: Optional[Decimal] = None
    created_by: Optional[str] = None
    checked_by: Optional[str] = None
    created_at: Optional[datetime] = None
    source: Optional[str] = None
    erp_bill_no: Optional[str] = None
    covered_products: Optional[List[Dict[str, Any]]] = None
    co_checker_user_ids: Optional[List[int]] = None
    updated_at: Optional[datetime] = None
    # 以下为运行时计算字段(attach_list_extras 写回)
    gain_count: Optional[int] = None      # 已盘行 diff_qty>0 数
    loss_count: Optional[int] = None      # 已盘行 diff_qty<0 数
    co_checkers: Optional[List[Dict[str, Any]]] = None  # [{user_id, name}]
    writeback_pending: Optional[int] = None   # K3 回写 pending 记录数(仅已完结单有)
    writeback_failed: Optional[int] = None    # K3 回写 failed 记录数

    model_config = {"from_attributes": True}


class StockCheckMyItemOut(BaseModel):
    """个人盘点台账：当前用户作为最后录入人(StockCheckItem.counted_by_user_id)
    关联的所有盘点行，关联盘点单头(订单类/手动)与仓库/物料快照。
    """
    item_id: int
    check_id: int
    check_no: str
    order_no: Optional[str] = None
    title: Optional[str] = None
    check_type: Optional[str] = None
    status: Optional[str] = None
    check_date: Optional[date] = None
    completed_at: Optional[datetime] = None
    material_id: Optional[int] = None
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    wh_id: Optional[int] = None
    wh_name: Optional[str] = None
    wh_code: Optional[str] = None
    system_qty: Optional[Decimal] = None
    actual_qty: Optional[Decimal] = None
    diff_qty: Optional[Decimal] = None
    counted_by_user_id: Optional[int] = None
    counted_by: Optional[str] = None
    counted_at: Optional[datetime] = None
    recent_checked_check_no: Optional[str] = None
    recent_checked_date: Optional[date] = None

    model_config = {"from_attributes": True}


class MaterialHistoryItem(BaseModel):
    check_no: str
    order_no: Optional[str] = None
    customer: Optional[str] = None
    status: str
    check_date: Optional[date] = None
    completed_at: Optional[datetime] = None
    actual_qty: Optional[Decimal] = None
    created_at: Optional[datetime] = None
    created_by: Optional[str] = None

    model_config = {"from_attributes": True}


class TopDiffMaterial(BaseModel):
    """盘盈盘亏 Top 差异物料（按 |净差异| 排序）"""
    material_code: str
    material_name: str
    diff_qty: float
    unit: Optional[str] = None

    model_config = {"from_attributes": True}


class StockCheckStats(BaseModel):
    """盘盈盘亏统计（仅 is_checked=1 的已盘点行，排除已取消单）"""
    total_checked: int
    gain_count: int
    loss_count: int
    flat_count: int
    total_gain_qty: float
    total_loss_qty: float
    top_diff_materials: List[TopDiffMaterial] = []


class StockCheckKpi(BaseModel):
    """盘点台账页 KPI 行(全局,不带筛选)"""
    status_counts: Dict[str, int]          # {open, in_progress, completed, cancelled} 缺省补 0
    in_progress_checks: int                # status='in_progress' 数
    week_new_checks: int                   # created_at >= 本周一 00:00 的单数
    week_new_by_type: Dict[str, int]       # 键: order/manual/quick/k3(k3=source='k3' 的单)
    pending_gain_count: int                # 已盘行 diff>0 总数(排除已取消单)
    pending_loss_count: int
    recent7_checked_materials: int         # 7 日内有 counted_at 的去重 material_id 数(排除已取消单)
    writeback_todo_checks: int = 0         # 已完结且存在 pending/failed K3 回写的单数


class StockCheckConflictOut(BaseModel):
    """乐观锁冲突响应 data 体"""
    resource: str
    item_id: Optional[int] = None
    check_id: Optional[int] = None
    server_version: int
    server_item: Optional[Dict[str, Any]] = None


class StockCheckActionBody(BaseModel):
    """complete / cancel 的请求体(支持 expected_version)"""
    expected_version: Optional[int] = None


class K3BillOut(BaseModel):
    """K3 盘盈盘亏单预览行(来自 ICStockBill FTranType 40/43)"""
    erp_bill_no: str
    erp_inter_id: int
    tran_type: int
    type_label: str
    bill_date: Optional[date] = None
    wh_name: Optional[str] = None
    item_count: int
    diff_total: Decimal
    imported: bool


class K3ImportRequest(BaseModel):
    bill_nos: List[str]


class K3ImportResultOut(BaseModel):
    created: List[Dict[str, Any]] = []   # [{check_no, erp_bill_no, skipped_items}]
    skipped: List[str] = []              # 已导入过被跳过的 K3 单号
    failed: List[Dict[str, Any]] = []    # [{erp_bill_no, reason}]


class StockCheckWritebackOut(BaseModel):
    """盘点完结 K3 回写记录"""
    model_config = {"from_attributes": True}

    id: int
    check_id: int
    bill_type: str  # gain / loss_transfer
    wh_id: int
    wh_code: Optional[str] = None
    wh_name: Optional[str] = None
    status: str  # pending / success / failed
    erp_bill_no: Optional[str] = None
    k3_inter_id: Optional[int] = None
    item_count: int = 0
    total_qty: Decimal = Decimal("0")
    error_msg: Optional[str] = None
    retry_count: int = 0
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    written_at: Optional[datetime] = None


class WritebackSkippedItemOut(BaseModel):
    """因无仓库(wh_id=NULL)被跳过的盘差行"""
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    unit: Optional[str] = None
    diff_qty: Decimal = Decimal("0")


class WritebackOverviewOut(BaseModel):
    """回写总览:记录列表 + 跳过行清单"""
    writebacks: List[StockCheckWritebackOut] = []
    skipped_items: List[WritebackSkippedItemOut] = []


class TaskCoverageItemOut(BaseModel):
    """任务盘点覆盖: 一行 = 物料×仓库"""
    material_id: int
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    wh_id: Optional[int] = None
    wh_name: Optional[str] = None
    system_qty: Optional[Decimal] = None
    req_qty: Optional[Decimal] = None
    is_checked: bool = False
    recent_check_no: Optional[str] = None
    recent_check_date: Optional[date] = None
    task_nos: List[str] = []
    order_nos: List[str] = []


class TaskCoverageStatsOut(BaseModel):
    task_count: int = 0
    product_count: int = 0
    row_count: int = 0
    checked_count: int = 0
    unchecked_count: int = 0
    checked_rate: Optional[float] = None


class TaskCoverageNoBomTaskOut(BaseModel):
    """范围内无法解析根 BOM 的任务单(警示列表)"""
    task_no: Optional[str] = None
    material_code: Optional[str] = None
    material_name: Optional[str] = None


class TaskCoveragePreviewItemOut(BaseModel):
    """仓库执行包卡片内的未盘行预览（Top N）"""
    material_id: int
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    system_qty: Optional[Decimal] = None
    req_qty: Optional[Decimal] = None


class TaskCoverageWarehouseOut(BaseModel):
    """任务盘点覆盖 · 仓库汇总（执行包视图数据源）"""
    wh_id: Optional[int] = None
    wh_name: Optional[str] = None
    row_count: int = 0
    checked_count: int = 0
    unchecked_count: int = 0
    preview_items: List[TaskCoveragePreviewItemOut] = []


class TaskCoverageOut(BaseModel):
    stats: TaskCoverageStatsOut
    items: List[TaskCoverageItemOut]
    total: int
    page: int
    page_size: int
    no_bom_tasks: List[TaskCoverageNoBomTaskOut] = []
    warehouses: List[TaskCoverageWarehouseOut] = []
    unstocked_count: int = 0


class TaskCoverageMaterialOrderOut(BaseModel):
    """单物料订单需求明细: 一行 = 销售订单"""
    order_no: str
    req_qty: Decimal = Decimal("0")
    task_nos: List[str] = []


class TaskCoverageMaterialOrdersOut(BaseModel):
    """任务盘点覆盖 · 单物料「订单×需求量」钻取结果"""
    material_id: int
    material_code: Optional[str] = None
    material_name: Optional[str] = None
    spec_model: Optional[str] = None
    unit: Optional[str] = None
    req_qty: Optional[Decimal] = None
    orders: List[TaskCoverageMaterialOrderOut] = []
    no_order_qty: Decimal = Decimal("0")


class StockCheckExportBody(BaseModel):
    """盘点单明细导出(POST): 前端页面筛选为客户端筛选,导出时传当前可见行 item_ids"""
    format: str = "xlsx"
    columns: Optional[List[str]] = None
    item_ids: Optional[List[int]] = None
