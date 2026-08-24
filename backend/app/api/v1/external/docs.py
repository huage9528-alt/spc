"""对外接口专属 OpenAPI 文档

- GET /api/v1/external/openapi.json  仅含对外接口的 schema
- GET /api/v1/external/docs          Swagger UI（第三方自取自调试）

生成方式：临时 FastAPI 实例 include 同一批 router（路径带完整 /api/v1/external
前缀，与真实可调用 URL 一致），取其 openapi() 结果并缓存。
"""

import functools

from fastapi import APIRouter, FastAPI
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import JSONResponse

from .routes import external_router

docs_router = APIRouter()


@functools.lru_cache(maxsize=1)
def _build_external_openapi() -> dict:
    doc_app = FastAPI(
        title="SPC 对外数据供给接口",
        version="1.0.0",
        description=(
            "第三方系统对接文档。认证方式：请求头 X-App-Key + X-Timestamp + X-Signature，"
            "签名串 = timestamp + app_key + endpoint_code + query_string，"
            "HMAC-SHA256(app_secret)。endpoint_code 见各接口 summary 下方描述或管理端接口清单。"
        ),
    )
    doc_app.include_router(external_router, prefix="/api/v1/external")
    return doc_app.openapi()


@docs_router.get("/openapi.json", include_in_schema=False)
async def external_openapi():
    return JSONResponse(_build_external_openapi())


@docs_router.get("/docs", include_in_schema=False)
async def external_docs_page():
    return get_swagger_ui_html(
        openapi_url="/api/v1/external/openapi.json",
        title="SPC 对外数据供给接口文档",
    )
