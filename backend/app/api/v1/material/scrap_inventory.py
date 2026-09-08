"""物料齐套中心 — 报废物料库存查询 API（一次性查询工具，无状态）"""

from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import PermissionChecker
from app.schemas.common import ResponseModel
from app.schemas.material.schemas import ScrapInventoryQueryIn
from app.services.common.export_service import ExportColumn, GenericExportService
from app.services.material.scrap_inventory_service import (
    normalize_code_list,
    parse_scrap_list_file,
    query_scrap_inventory,
)

router = APIRouter()

SCRAP_EXPORT_COLUMNS: list[ExportColumn] = [
    ExportColumn("material_code", "物料代码", 26),
    ExportColumn("material_name", "物料名称", 40),
    ExportColumn("total_qty", "库存数", 12),
    ExportColumn("status", "状态", 14),
]

_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.post("/scrap-inventory/query", response_model=ResponseModel[dict])
async def scrap_inventory_query(
    body: ScrapInventoryQueryIn,
    current_user: dict = Depends(PermissionChecker("materials.scrap_inventory", "read")),
    db: AsyncSession = Depends(get_db),
):
    """报废物料库存查询 — 粘贴代码列表路径。"""
    try:
        rows = normalize_code_list(body.codes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    data = await query_scrap_inventory(db, rows)
    return ResponseModel(data=data)


@router.post("/scrap-inventory/query-file", response_model=ResponseModel[dict])
async def scrap_inventory_query_file(
    file: UploadFile = File(...),
    current_user: dict = Depends(PermissionChecker("materials.scrap_inventory", "read")),
    db: AsyncSession = Depends(get_db),
):
    """报废物料库存查询 — 上传 CSV(GBK/UTF-8)/XLSX，首列物料代码、次列名称(可选)。"""
    try:
        rows, invalid, dup = parse_scrap_list_file(await file.read(), file.filename or "")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not rows:
        raise HTTPException(status_code=400, detail="文件中没有有效的物料代码")
    data = await query_scrap_inventory(db, rows)
    data["invalid_rows"] = invalid
    data["duplicated"] = dup
    return ResponseModel(data=data)


@router.post("/scrap-inventory/export")
async def scrap_inventory_export(
    body: ScrapInventoryQueryIn,
    current_user: dict = Depends(PermissionChecker("materials.scrap_inventory", "read")),
    db: AsyncSession = Depends(get_db),
):
    """报废物料库存查询结果导出（xlsx/csv），与页面同口径重新查询后导出。"""
    fmt = (body.format or "xlsx").lower()
    if fmt not in ("xlsx", "csv"):
        raise HTTPException(status_code=400, detail="format 仅支持 xlsx / csv")
    try:
        rows = normalize_code_list(body.codes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    data = await query_scrap_inventory(db, rows)
    output = GenericExportService(SCRAP_EXPORT_COLUMNS, data["items"])
    content = output.to_xlsx() if fmt == "xlsx" else output.to_csv()
    filename = quote(f"报废物料库存.{fmt}")
    return StreamingResponse(
        content,
        media_type=_XLSX_MEDIA if fmt == "xlsx" else "text/csv",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )
