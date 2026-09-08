import io
from datetime import date
from typing import Optional
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

from app.models.order.sale_order import SaleOrder
from app.models.exception.risk_issue import RiskIssue
from app.models.basicdata import Material

PROPERTY_LABEL = {1: "外购", 2: "自制", 3: "委外加工", 5: "虚拟件", 6: "特征类", 7: "配置类", 8: "规划类", 9: "组装件"}
SOURCE_LABEL = {"erp": "ERP", "manual": "手工", "excel": "Excel"}


class ExportService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def generate_weekly_report(self) -> io.BytesIO:
        wb = openpyxl.Workbook()

        # Sheet1: 风险订单总览
        ws1 = wb.active
        ws1.title = "风险订单总览"
        headers = ["订单号", "行号", "客户", "产品", "承诺交期", "计划上线", "风险等级", "责任人", "状态"]
        self._write_header(ws1, headers)

        result = await self.db.execute(
            select(SaleOrder)
            .where(SaleOrder.status.in_(["open", "in_progress"]))
            .order_by(SaleOrder.risk_level.asc(), SaleOrder.promised_date.asc())
        )
        for i, order in enumerate(result.scalars().all(), start=2):
            ws1.cell(row=i, column=1, value=order.order_no)
            ws1.cell(row=i, column=2, value=order.line_no)
            ws1.cell(row=i, column=3, value=order.customer)
            ws1.cell(row=i, column=4, value=order.product_name)
            ws1.cell(row=i, column=5, value=str(order.promised_date) if order.promised_date else "")
            ws1.cell(row=i, column=6, value=str(order.planned_start_date) if order.planned_start_date else "")
            ws1.cell(row=i, column=7, value=order.risk_level or "")
            ws1.cell(row=i, column=8, value=order.owner or "")
            ws1.cell(row=i, column=9, value=order.status)

        # Sheet2: 异常问题
        ws2 = wb.create_sheet("异常问题")
        issue_headers = ["问题编号", "类型", "风险等级", "订单号", "物料", "PO", "描述", "责任人", "状态", "创建时间"]
        self._write_header(ws2, issue_headers)

        issue_result = await self.db.execute(
            select(RiskIssue).order_by(RiskIssue.created_at.desc())
        )
        for i, issue in enumerate(issue_result.scalars().all(), start=2):
            ws2.cell(row=i, column=1, value=issue.issue_no)
            ws2.cell(row=i, column=2, value=issue.issue_type)
            ws2.cell(row=i, column=3, value=issue.risk_level)
            ws2.cell(row=i, column=4, value=issue.order_no)
            ws2.cell(row=i, column=5, value=issue.material_code)
            ws2.cell(row=i, column=6, value=issue.po_no)
            ws2.cell(row=i, column=7, value=issue.description)
            ws2.cell(row=i, column=8, value=issue.owner)
            ws2.cell(row=i, column=9, value=issue.status)
            ws2.cell(row=i, column=10, value=str(issue.created_at))

        output = io.BytesIO()
        wb.save(output)
        output.seek(0)
        return output

    async def export_issues(self) -> io.BytesIO:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "异常台账"
        headers = ["问题编号", "类型", "风险等级", "订单号", "行号", "物料", "PO",
                    "描述", "责任人", "处理动作", "承诺日期", "状态", "关闭时间", "创建时间"]
        self._write_header(ws, headers)

        result = await self.db.execute(
            select(RiskIssue).order_by(RiskIssue.created_at.desc())
        )
        for i, issue in enumerate(result.scalars().all(), start=2):
            ws.cell(row=i, column=1, value=issue.issue_no)
            ws.cell(row=i, column=2, value=issue.issue_type)
            ws.cell(row=i, column=3, value=issue.risk_level)
            ws.cell(row=i, column=4, value=issue.order_no)
            ws.cell(row=i, column=5, value=issue.line_no)
            ws.cell(row=i, column=6, value=issue.material_code)
            ws.cell(row=i, column=7, value=issue.po_no)
            ws.cell(row=i, column=8, value=issue.description)
            ws.cell(row=i, column=9, value=issue.owner)
            ws.cell(row=i, column=10, value=issue.action_taken)
            ws.cell(row=i, column=11, value=str(issue.commit_date) if issue.commit_date else "")
            ws.cell(row=i, column=12, value=issue.status)
            ws.cell(row=i, column=13, value=str(issue.closed_at) if issue.closed_at else "")
            ws.cell(row=i, column=14, value=str(issue.created_at))

        output = io.BytesIO()
        wb.save(output)
        output.seek(0)
        return output

    async def export_materials(
        self,
        keyword: Optional[str] = None,
        material_type: Optional[str] = None,
        status: Optional[str] = None,
        material_property: Optional[str] = None,
        data_source: Optional[str] = None,
    ) -> io.BytesIO:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "物料主数据"
        headers = ["物料编码", "物料名称", "规格型号", "物料分类", "物料属性", "计量单位",
                    "品牌/厂商", "可采购", "可生产", "数据来源", "订货单价", "最近出库",
                    "状态", "ERP物料ID", "更新时间"]
        self._write_header(ws, headers)

        query = select(Material).filter(Material.is_deleted == 0)
        if keyword:
            like = f"%{keyword}%"
            query = query.where(or_(Material.material_code.ilike(like), Material.material_name.ilike(like), Material.spec_model.ilike(like)))
        if material_type:
            types = [t.strip() for t in material_type.split(",") if t.strip()]
            if types:
                query = query.where(Material.material_type.in_(types))
        if status:
            statuses = [int(s.strip()) for s in status.split(",") if s.strip().isdigit()]
            if statuses:
                query = query.where(Material.status.in_(statuses))
        if material_property:
            props = [int(p.strip()) for p in material_property.split(",") if p.strip().isdigit()]
            if props:
                query = query.where(Material.material_property.in_(props))
        if data_source:
            sources = [s.strip() for s in data_source.split(",") if s.strip()]
            if sources:
                query = query.where(Material.data_source.in_(sources))
        query = query.order_by(Material.id)

        result = await self.db.execute(query)
        for i, m in enumerate(result.scalars().all(), start=2):
            row = [
                m.material_code, m.material_name, m.spec_model or "", m.material_type,
                PROPERTY_LABEL.get(m.material_property, "") if m.material_property is not None else "",
                m.unit_of_measure, m.brand or "",
                "是" if m.is_purchase else "否", "是" if m.is_produce else "否",
                SOURCE_LABEL.get(m.data_source or "", m.data_source or ""),
                float(m.order_unit_price) if m.order_unit_price is not None else None,
                str(m.last_outbound_date) if m.last_outbound_date else "",
                "启用" if m.status == 1 else "停用",
                m.erp_material_id,
                str(m.update_time or "")[:19],
            ]
            for col, value in enumerate(row, start=1):
                ws.cell(row=i, column=col, value=value)

        output = io.BytesIO()
        wb.save(output)
        output.seek(0)
        return output

    @staticmethod
    def _write_header(ws, headers: list[str]):
        header_font = Font(bold=True, color="FFFFFF")
        header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
        for col, header in enumerate(headers, start=1):
            cell = ws.cell(row=1, column=col, value=header)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal="center")
            ws.column_dimensions[cell.column_letter].width = max(len(header) * 2 + 4, 12)
