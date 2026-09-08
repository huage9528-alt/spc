import io
from fastapi import UploadFile, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import openpyxl

from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.models.material.material_demand import MaterialDemand
from app.models.material.purchase_order import PurchaseOrder


class ImportService:
    def __init__(self, db: AsyncSession, operator: str = ""):
        self.db = db
        self.operator = operator

    async def import_orders(self, file: UploadFile) -> dict:
        rows = self._parse_excel(file)
        created, updated, errors = 0, 0, []

        for i, row in enumerate(rows, start=2):
            try:
                order_no = str(row.get("order_no", "")).strip()
                line_no = str(row.get("line_no", "")).strip()
                raw_erp_id = row.get("erp_id")
                try:
                    erp_id = int(raw_erp_id) if raw_erp_id not in (None, "") else None
                except (TypeError, ValueError):
                    erp_id = None
                if not order_no or not line_no:
                    errors.append(f"第{i}行: 订单号或行号为空")
                    continue

                header_data = {
                    "order_no": order_no,
                    "erp_id": erp_id,
                    "customer": row.get("customer"),
                    "customer_code": row.get("customer_code"),
                    "department": row.get("department"),
                    "audit_date": row.get("audit_date"),
                    "owner": row.get("owner"),
                    "status": row.get("status") or "open",
                    "risk_level": row.get("risk_level"),
                    "data_source": row.get("data_source"),
                    "extra_data": row.get("extra_data"),
                }
                line_data = {
                    "order_no": order_no,
                    "line_no": line_no,
                    "product_code": row.get("product_code"),
                    "product_name": row.get("product_name"),
                    "order_qty": row.get("order_qty"),
                    "promised_date": row.get("promised_date"),
                    "planned_start_date": row.get("planned_start_date"),
                    "batch_no": row.get("batch_no"),
                    "status": row.get("status") or "open",
                }

                header_query = select(SaleOrder).where(SaleOrder.order_no == order_no)
                if erp_id is not None:
                    header_query = header_query.where(SaleOrder.erp_id == erp_id)
                else:
                    header_query = header_query.order_by(SaleOrder.id.desc())
                header = (await self.db.execute(header_query.limit(1))).scalar_one_or_none()
                if header:
                    for key, value in header_data.items():
                        if key not in ("order_no", "erp_id") and value is not None:
                            setattr(header, key, value)
                else:
                    self.db.add(SaleOrder(**header_data))

                result = await self.db.execute(
                    select(SaleOrderLine).where(
                        SaleOrderLine.order_no == order_no, SaleOrderLine.line_no == line_no
                    )
                )
                existing = result.scalar_one_or_none()

                if existing:
                    for key, value in line_data.items():
                        if key not in ("order_no", "line_no") and value is not None:
                            setattr(existing, key, value)
                    updated += 1
                else:
                    order = SaleOrderLine(**line_data)
                    self.db.add(order)
                    created += 1
            except Exception as e:
                errors.append(f"第{i}行: {str(e)}")

        await self.db.flush()
        return {"created": created, "updated": updated, "errors": errors}

    async def import_materials(self, file: UploadFile) -> dict:
        rows = self._parse_excel(file)
        created, errors = 0, []

        for i, row in enumerate(rows, start=2):
            try:
                mat = MaterialDemand(**row)
                self.db.add(mat)
                created += 1
            except Exception as e:
                errors.append(f"第{i}行: {str(e)}")

        await self.db.flush()
        return {"created": created, "errors": errors}

    async def import_purchase_orders(self, file: UploadFile) -> dict:
        rows = self._parse_excel(file)
        created, updated, errors = 0, 0, []

        for i, row in enumerate(rows, start=2):
            try:
                po_no = str(row.get("po_no", "")).strip()
                if not po_no:
                    errors.append(f"第{i}行: PO号为空")
                    continue

                detail_id = row.get("detail_id") or 1

                result = await self.db.execute(
                    select(PurchaseOrder).where(
                        PurchaseOrder.po_no == po_no,
                        PurchaseOrder.detail_id == detail_id,
                    )
                )
                existing = result.scalar_one_or_none()

                source_eta = row.get("eta")
                source_original_eta = row.get("original_eta") or source_eta
                if source_original_eta:
                    row["original_eta"] = source_original_eta

                if existing:
                    for key, value in row.items():
                        if key not in {"po_no", "eta"} and value is not None:
                            setattr(existing, key, value)
                    updated += 1
                else:
                    if source_original_eta and not row.get("eta"):
                        row["eta"] = source_original_eta
                    po = PurchaseOrder(**row)
                    if not po.original_eta and po.eta:
                        po.original_eta = po.eta
                    self.db.add(po)
                    created += 1
            except Exception as e:
                errors.append(f"第{i}行: {str(e)}")

        await self.db.flush()
        return {"created": created, "updated": updated, "errors": errors}

    @staticmethod
    def _parse_excel(file: UploadFile) -> list[dict]:
        """解析 Excel 文件，返回字典列表（表头为字段名）"""
        try:
            content = file.file.read()
            wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True)
            ws = wb.active

            rows_iter = ws.iter_rows(values_only=True)
            headers = [str(h).strip().lower() if h else "" for h in next(rows_iter)]

            result = []
            for row in rows_iter:
                row_dict = {}
                for header, value in zip(headers, row):
                    if header and value is not None:
                        row_dict[header] = value
                if row_dict:
                    result.append(row_dict)
            return result
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Excel解析失败: {str(e)}")
