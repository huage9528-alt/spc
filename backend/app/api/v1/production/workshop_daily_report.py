"""生产协同中心 — 车间日报表单据 API（泛微OA样式，主表+3子表，手工填报）"""

import asyncio

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, or_, create_engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from typing import Optional
from datetime import date, datetime

from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import PermissionChecker
from app.models.basicdata.organization import Organization
from app.models.production.workshop_daily_report import (
    WorkshopDailyReport,
    WorkshopDailyReportLeave,
    WorkshopDailyReportWork,
    WorkshopDailyReportTask,
)
from app.schemas.common import ResponseModel, PageResult
from app.schemas.production.schemas import (
    WorkshopDailyReportCreate,
    WorkshopDailyReportUpdate,
    WorkshopDailyReportOut,
)

router = APIRouter()

_LOAD_OPTS = [
    selectinload(WorkshopDailyReport.leave_items),
    selectinload(WorkshopDailyReport.work_items),
    selectinload(WorkshopDailyReport.task_items),
]


async def _gen_report_no(db: AsyncSession, report_date: date) -> str:
    """生成流程编号: RPT-YYYYMMDD-XXX（当日序号）"""
    count = (
        await db.execute(
            select(func.count())
            .select_from(WorkshopDailyReport)
            .where(WorkshopDailyReport.report_date == report_date)
        )
    ).scalar() or 0
    return f"RPT-{report_date.strftime('%Y%m%d')}-{count + 1:03d}"


def _apply_children(report: WorkshopDailyReport, payload) -> None:
    """把入参子表写入关系；实际工时/金额自动补算；任务单自动编序号"""
    report.leave_items = [
        WorkshopDailyReportLeave(**it.model_dump()) for it in payload.leave_items or []
    ]
    report.task_items = [
        WorkshopDailyReportTask(seq=idx + 1, **it.model_dump())
        for idx, it in enumerate(payload.task_items or [])
    ]
    work_items = []
    for it in payload.work_items or []:
        w = WorkshopDailyReportWork(**it.model_dump())
        w.actual_hours = (w.normal_hours or 0) + (w.overtime_hours or 0)
        if w.amount is None:
            w.amount = (w.hourly_wage or 0) * (w.modulus or 1)
        work_items.append(w)
    report.work_items = work_items


def _recalc_stats(report: WorkshopDailyReport) -> None:
    """统计字段一律由子表自动计算，不手填（注意 DB 列是 Decimal，统一转 float）"""
    report.attendance_count = len(report.work_items or [])
    report.leave_count = len(report.leave_items or [])
    report.attendance_actual = max((report.attendance_count or 0) - (report.leave_count or 0), 0)
    report.leave_hours_total = round(float(sum((l.leave_hours or 0) for l in report.leave_items or [])), 2)
    report.work_wages_total = round(float(sum((w.amount or 0) for w in report.work_items or [])), 2)
    report.modulus_total = sum((w.modulus or 0) for w in report.work_items or [])
    report.grand_total_wages = round(
        float(report.work_wages_total or 0) + float(report.temp_amount or 0), 2
    )


def _make_title(report: WorkshopDailyReport) -> str:
    dept = report.department or ""
    d = report.report_date.strftime("%Y-%m-%d") if report.report_date else ""
    return f"恒创车间日报表-{dept}-{d}"


@router.get("", response_model=ResponseModel[PageResult[WorkshopDailyReportOut]])
async def list_workshop_daily_reports(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    report_date_from: Optional[date] = Query(None),
    report_date_to: Optional[date] = Query(None),
    workshop: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None, description="流程编号/组别模糊搜索"),
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    filters = []
    if report_date_from:
        filters.append(WorkshopDailyReport.report_date >= report_date_from)
    if report_date_to:
        filters.append(WorkshopDailyReport.report_date <= report_date_to)
    if workshop:
        filters.append(WorkshopDailyReport.workshop == workshop)
    if keyword:
        like = f"%{keyword}%"
        filters.append(
            or_(
                WorkshopDailyReport.report_no.ilike(like),
                WorkshopDailyReport.department.ilike(like),
                WorkshopDailyReport.title.ilike(like),
            )
        )

    count_stmt = select(func.count()).select_from(WorkshopDailyReport)
    if filters:
        count_stmt = count_stmt.where(*filters)
    total = (await db.execute(count_stmt)).scalar()

    query = (
        select(WorkshopDailyReport)
        .options(*_LOAD_OPTS)
        .where(*filters)
        .order_by(
            WorkshopDailyReport.report_date.desc().nullslast(),
            WorkshopDailyReport.id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = await db.execute(query)
    items = [WorkshopDailyReportOut.model_validate(r) for r in result.scalars().all()]
    return ResponseModel(data=PageResult(total=total or 0, page=page, page_size=page_size, items=items))


@router.post("", response_model=ResponseModel[WorkshopDailyReportOut])
async def create_workshop_daily_report(
    payload: WorkshopDailyReportCreate,
    current_user: dict = Depends(PermissionChecker("production.daily_report", "create")),
    db: AsyncSession = Depends(get_db),
):
    """新建车间日报表（整份单据，含3张子表）"""
    report = WorkshopDailyReport(
        report_no=await _gen_report_no(db, payload.report_date),
        report_date=payload.report_date,
        report_type=payload.report_type or "计件",
        department=payload.department,
        group_name=payload.group_name,
        workshop=payload.workshop,
        plan_qty=payload.plan_qty,
        work_hours=payload.work_hours,
        leader=payload.leader,
        repairer=payload.repairer,
        material_handler=payload.material_handler,
        completed_qty=payload.completed_qty,
        temp_personnel=payload.temp_personnel,
        temp_people_count=payload.temp_people_count or 0,
        temp_count=payload.temp_count or 0,
        temp_amount=payload.temp_amount,
        remark=payload.remark,
        reporter=current_user.get("username"),
        created_by=current_user.get("username"),
        data_source="manual",
    )
    report.title = _make_title(report)
    _apply_children(report, payload)
    _recalc_stats(report)
    db.add(report)
    await db.flush()
    loaded = (
        await db.execute(
            select(WorkshopDailyReport).where(WorkshopDailyReport.id == report.id).options(*_LOAD_OPTS)
        )
    ).scalar_one()
    return ResponseModel(data=WorkshopDailyReportOut.model_validate(loaded))


@router.get("/org-options", response_model=ResponseModel[list])
async def workshop_daily_report_org_options(
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    """日报表「部门」下拉数据源：供应链中心整棵子树（含层级缩进与员工数）"""
    root = (
        await db.execute(select(Organization).where(Organization.org_name == "供应链中心"))
    ).scalar_one_or_none()
    if root is None:
        return ResponseModel(data=[])
    orgs = (await db.execute(select(Organization).order_by(Organization.id))).scalars().all()
    by_id = {o.id: o for o in orgs}
    children_of = {}
    for o in orgs:
        children_of.setdefault(o.parent_id, []).append(o)

    options: list[dict] = []

    def walk(org_id: int, depth: int) -> None:
        node = by_id.get(org_id)
        if node is None:
            return
        kids = children_of.get(org_id, [])
        options.append({
            "id": node.id,
            "org_name": node.org_name,
            "org_code": node.org_code,
            "depth": depth,
            "has_children": bool(kids),
        })
        for kid in kids:
            walk(kid.id, depth + 1)

    walk(root.id, 0)
    return ResponseModel(data=options)


# OA 岗位ID 映射（字段关联固定值，与 OA 配置一致）
OA_JOBTITLE_LEADER = 26      # 组长
OA_JOBTITLE_REPAIRER = 25    # 维修员
OA_JOBTITLE_MATERIAL = 27    # 物料员


def _query_oa_people(dept_id: int) -> dict:
    """同步查询 OA ecology 库：该车间(部门)的 组长/维修员/物料员（岗位关联，按车间范围）"""
    empty = {"leader": [], "repairer": [], "material_handler": []}
    settings = get_settings()
    if not settings.ERP_DB_URL or not settings.ERP_SYNC_ENABLED:
        return empty
    url = settings.ERP_DB_URL
    for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
        if param.split("=")[0] not in url:
            url += f"&{param}" if "?" in url else f"?{param}"
    engine = create_engine(url, connect_args={"login_timeout": 10, "timeout": 15, "charset": "utf-8"})
    try:
        with engine.connect() as conn:
            sql = text(
                "SELECT r.id, r.lastname, b.id AS jid, b.jobtitlename "
                "FROM [FWsv].ecology.dbo.hrmresource r "
                "JOIN [FWsv].ecology.dbo.hrmjobtitles b ON r.jobtitle = b.id "
                "WHERE r.departmentid = :dept AND b.id IN (26, 25, 27) "
                "ORDER BY b.id, r.id"
            )
            rows = conn.execute(sql, {"dept": dept_id}).fetchall()
            result = {"leader": [], "repairer": [], "material_handler": []}
            for r in rows:
                item = {"id": r[0], "name": r[1], "jobtitle": r[3]}
                if r[2] == OA_JOBTITLE_LEADER:
                    result["leader"].append(item)
                elif r[2] == OA_JOBTITLE_REPAIRER:
                    result["repairer"].append(item)
                elif r[2] == OA_JOBTITLE_MATERIAL:
                    result["material_handler"].append(item)
            return result
    finally:
        engine.dispose()


@router.get("/people-options", response_model=ResponseModel[dict])
async def workshop_daily_report_people_options(
    org_id: int = Query(..., description="我方组织ID(scm_organization.id)"),
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    """选车间后按字段关联带出该车间的 组长/维修员/物料员（OA 岗位ID 26/25/27，按部门范围）"""
    org = (await db.execute(select(Organization).where(Organization.id == org_id))).scalar_one_or_none()
    if org is None or not org.org_code:
        return ResponseModel(data={"leader": [], "repairer": [], "material_handler": []})
    try:
        dept_id = int(org.org_code)
    except (TypeError, ValueError):
        return ResponseModel(data={"leader": [], "repairer": [], "material_handler": []})
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _query_oa_people, dept_id)
    return ResponseModel(data=data)


OA_SPECIAL_PERSON_IDS = {41, 47, 129, 53, 29}


def _compute_wage(row, person_id: int, rq_str: str) -> float:
    """复刻 OA getPrice 逻辑：从待遇清单行计算工时工资单价
    row = (djlx, zzhjbgzdj, zzhgwgz, dzhjbgzdj, dzhgwgz, ygjbgzdj, dzsxsj, syqgzdj, syqgwgz)"""
    if not row:
        return 0.0
    djlx = row[0]
    is_special = person_id in OA_SPECIAL_PERSON_IDS
    try:
        if djlx == 0:
            if is_special:
                return round((float(row[1] or 0) + float(row[2] or 0)) / 208, 2)
            return float(row[1] or 0)
        elif djlx == 1:
            effective = str(row[6] or "")[:10].replace("/", "-")
            if rq_str and effective and rq_str >= effective:
                if is_special:
                    return round((float(row[3] or 0) + float(row[4] or 0)) / 208, 2)
                return float(row[3] or 0)
            else:
                if is_special:
                    return round((float(row[7] or 0) + float(row[8] or 0)) / 208, 2)
                return float(row[5] or 0)
    except Exception:
        pass
    return 0.0


def _query_oa_wage_rates(conn, person_ids: list, rq_str: str) -> dict:
    """批量查待遇清单 formtable_main_16，返回 {person_id: 工时工资单价}"""
    if not person_ids:
        return {}
    id_list = ",".join(str(i) for i in person_ids)
    sql = text(
        f"SELECT xm, djlx, zzhjbgzdj, zzhgwgz, dzhjbgzdj, dzhgwgz, ygjbgzdj, dzsxsj, syqgzdj, syqgwgz "
        f"FROM [FWsv].ecology.dbo.formtable_main_16 "
        f"WHERE xm IN ({id_list}) AND zt = N'有效'"
    )
    rows = conn.execute(sql).fetchall()
    rates = {}
    for r in rows:
        pid = int(r[0])
        if pid not in rates:
            rates[pid] = _compute_wage(r[1:], pid, rq_str)
    return rates


def _query_oa_attendance(dept_name: str, report_date) -> list:
    """同步查询 OA 出勤视图 h_v_Attendants1（复刻 OA cqry：组装/包装/精益用 LIKE，其余精确）
    并按 日期+姓名 关联考勤视图 h_v_kaoqinName2 带出当日打卡点。"""
    if not dept_name:
        return []
    settings = get_settings()
    if not settings.ERP_DB_URL or not settings.ERP_SYNC_ENABLED:
        return []
    url = settings.ERP_DB_URL
    for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
        if param.split("=")[0] not in url:
            url += f"&{param}" if "?" in url else f"?{param}"
    engine = create_engine(url, connect_args={"login_timeout": 10, "timeout": 15, "charset": "utf-8"})
    rq = report_date.strftime("%Y-%m-%d") if report_date else None
    try:
        with engine.connect() as conn:
            if '组装' in dept_name:
                where = "a.departmentname LIKE '%组装%'"
                params = {}
            elif '包装' in dept_name:
                where = "a.departmentname LIKE '%包装%'"
                params = {}
            elif '精益' in dept_name:
                where = "a.departmentname LIKE '%精益%'"
                params = {}
            else:
                where = "a.departmentname = :name"
                params = {"name": dept_name}
            punch_col = (
                "(SELECT TOP 1 k.ITEM_time FROM [FWsv].ecology.dbo.h_v_kaoqinName2 k "
                "WHERE k.ITEM_employeeName = a.lastname AND k.ITEM_Date = :rq) AS punch"
                if rq else "CAST(NULL AS NVARCHAR(255)) AS punch"
            )
            if rq:
                params["rq"] = rq
            sql = text(
                "SELECT a.lastID, a.lastname, r.workcode, a.departmentname, " + punch_col + " "
                f"FROM [FWsv].ecology.dbo.h_v_Attendants1 a "
                "LEFT JOIN [FWsv].ecology.dbo.hrmresource r ON a.lastID = r.id "
                f"WHERE {where} "
                "ORDER BY a.departmentname, a.lastID"
            )
            rows = conn.execute(sql, params).fetchall()
            # 批量查待遇清单算工时工资单价
            person_ids = [r[0] for r in rows if r[0]]
            wage_rates = _query_oa_wage_rates(conn, person_ids, rq or "")
            result = []
            for r in rows:
                pid = r[0]
                result.append({
                    "id": pid,
                    "name": r[1],
                    "emp_code": r[2],
                    "departmentname": r[3],
                    "attendance_time": r[4],
                    "hourly_wage": wage_rates.get(pid, 0) if pid else 0,
                })
            return result
    finally:
        engine.dispose()


@router.get("/attendance-options", response_model=ResponseModel[list])
async def workshop_daily_report_attendance_options(
    org_id: int = Query(..., description="我方组织ID(scm_organization.id)"),
    report_date: Optional[date] = Query(None, description="填报日期(用于取当日打卡点)"),
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    """选车间后自动带出该车间实际出勤人员（OA 出勤视图 h_v_Attendants1）+ 当日考勤打卡(h_v_kaoqinName2)"""
    org = (await db.execute(select(Organization).where(Organization.id == org_id))).scalar_one_or_none()
    if org is None:
        return ResponseModel(data=[])
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _query_oa_attendance, org.org_name, report_date)
    return ResponseModel(data=data)


def _query_oa_leave(dept_name: str, report_date: date) -> list:
    """同步查询 OA 请假单 formtable_main_17：该部门请假区间覆盖所选日期的人员"""
    if not dept_name or not report_date:
        return []
    settings = get_settings()
    if not settings.ERP_DB_URL or not settings.ERP_SYNC_ENABLED:
        return []
    url = settings.ERP_DB_URL
    for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
        if param.split("=")[0] not in url:
            url += f"&{param}" if "?" in url else f"?{param}"
    engine = create_engine(url, connect_args={"login_timeout": 10, "timeout": 15, "charset": "utf-8"})
    rq = report_date.strftime("%Y-%m-%d")
    try:
        with engine.connect() as conn:
            if '组装' in dept_name:
                where = "e.departmentname LIKE '%组装%'"
                params = {}
            elif '包装' in dept_name:
                where = "e.departmentname LIKE '%包装%'"
                params = {}
            elif '精益' in dept_name:
                where = "e.departmentname LIKE '%精益%'"
                params = {}
            else:
                where = "e.departmentname = :name"
                params = {"name": dept_name}
            sql = text(
                "SELECT a.id, a.lastname, e.departmentname, a.workcode, "
                "d.ITEM_START_T, d.ITEM_LEAVE_T, d.ITEM_LEAVE_D, d.ITEM_APPLICATION_N "
                f"FROM [FWsv].ecology.dbo.formtable_main_17 d "
                "JOIN [FWsv].ecology.dbo.hrmresource a ON a.id = d.ITEM_APPLICANTID "
                "LEFT JOIN [FWsv].ecology.dbo.hrmdepartment e ON e.id = a.departmentid "
                f"WHERE {where} AND CAST(d.ITEM_START_T AS DATE) <= :rq AND CAST(d.ITEM_LEAVE_T AS DATE) >= :rq "
                "ORDER BY a.lastname"
            )
            params["rq"] = rq
            rows = conn.execute(sql, params).fetchall()
            result = []
            for r in rows:
                raw_d = float(r[6]) if r[6] is not None else 0.0
                start_str = str(r[4]).strip() if r[4] else ""
                end_str = str(r[5]).strip() if r[5] else ""
                start_date_str = start_str[:10]
                end_date_str = end_str[:10]
                if start_date_str == end_date_str:
                    # 单日假：用 ITEM_LEAVE_D；为0则按时间段算
                    leave_d = raw_d
                    if leave_d <= 0:
                        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M"):
                            try:
                                st = datetime.strptime(start_str, fmt)
                                et = datetime.strptime(end_str, fmt)
                                leave_d = round((et - st).total_seconds() / 3600, 2)
                                break
                            except Exception:
                                continue
                else:
                    # 多天假：按 OA 逻辑，当天固定 8h
                    leave_d = 8.0
                result.append({
                    "id": r[0],
                    "name": r[1],
                    "departmentname": r[2],
                    "emp_code": r[3],
                    "leave_start": start_str,
                    "leave_end": end_str,
                    "leave_hours": leave_d,
                    "application_no": r[7],
                })
            return result
    finally:
        engine.dispose()


@router.get("/leave-options", response_model=ResponseModel[list])
async def workshop_daily_report_leave_options(
    org_id: int = Query(..., description="我方组织ID(scm_organization.id)"),
    report_date: date = Query(..., description="填报日期"),
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    """选部门+日期后自动带出该车间请假人员（请假区间覆盖所选日期）"""
    org = (await db.execute(select(Organization).where(Organization.id == org_id))).scalar_one_or_none()
    if org is None:
        return ResponseModel(data=[])
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, _query_oa_leave, org.org_name, report_date)
    return ResponseModel(data=data)


@router.get("/{report_id}", response_model=ResponseModel[WorkshopDailyReportOut])
async def get_workshop_daily_report(
    report_id: int,
    current_user: dict = Depends(PermissionChecker("production.daily_report", "read")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(WorkshopDailyReport)
        .where(WorkshopDailyReport.id == report_id)
        .options(*_LOAD_OPTS)
    )
    report = result.scalar_one_or_none()
    if report is None:
        raise HTTPException(status_code=404, detail="车间日报表不存在")
    return ResponseModel(data=WorkshopDailyReportOut.model_validate(report))


@router.put("/{report_id}", response_model=ResponseModel[WorkshopDailyReportOut])
async def update_workshop_daily_report(
    report_id: int,
    payload: WorkshopDailyReportUpdate,
    current_user: dict = Depends(PermissionChecker("production.daily_report", "update")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(WorkshopDailyReport)
        .where(WorkshopDailyReport.id == report_id)
        .options(*_LOAD_OPTS)
    )
    report = result.scalar_one_or_none()
    if report is None:
        raise HTTPException(status_code=404, detail="车间日报表不存在")
    if report.data_source != "manual":
        raise HTTPException(status_code=400, detail="仅手工填报的车间日报表允许编辑")

    data = payload.model_dump(exclude_unset=True)
    child_keys = {"leave_items", "work_items", "task_items"}
    scalar = {k: v for k, v in data.items() if k not in child_keys}
    for k, v in scalar.items():
        setattr(report, k, v)
    if payload.leave_items is not None or payload.work_items is not None or payload.task_items is not None:
        _apply_children(report, payload)
    _recalc_stats(report)
    report.title = _make_title(report)
    await db.flush()
    loaded = (
        await db.execute(
            select(WorkshopDailyReport).where(WorkshopDailyReport.id == report.id).options(*_LOAD_OPTS)
        )
    ).scalar_one()
    return ResponseModel(data=WorkshopDailyReportOut.model_validate(loaded))


@router.delete("/{report_id}", response_model=ResponseModel[dict])
async def delete_workshop_daily_report(
    report_id: int,
    current_user: dict = Depends(PermissionChecker("production.daily_report", "delete")),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(WorkshopDailyReport).where(WorkshopDailyReport.id == report_id))
    report = result.scalar_one_or_none()
    if report is None:
        raise HTTPException(status_code=404, detail="车间日报表不存在")
    if report.data_source != "manual":
        raise HTTPException(status_code=400, detail="仅手工填报的车间日报表允许删除")

    await db.delete(report)
    await db.flush()
    return ResponseModel(data={"id": report_id})
