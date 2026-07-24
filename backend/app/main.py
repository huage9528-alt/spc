import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.api.v1 import api_router
from app.services.basicdata.sync_scheduler import scheduler  # noqa: F401
from app.services.exception.risk_scheduler import risk_scheduler  # noqa: F401
from app.services.scheduler.overdue_checker import overdue_checker  # noqa: F401
from app.services.scheduler.capacity_sync_scheduler import capacity_sync_scheduler  # noqa: F401


class SafeJSONEncoder(json.JSONEncoder):
    """自定义 JSON 编码器，处理非 UTF-8 编码的字符串和特殊类型"""
    def default(self, obj):
        from decimal import Decimal
        from datetime import datetime, date
        if isinstance(obj, Decimal):
            return float(obj)
        if isinstance(obj, (datetime, date)):
            return obj.isoformat()
        if isinstance(obj, bytes):
            try:
                return obj.decode('utf-8')
            except UnicodeDecodeError:
                return obj.decode('latin-1', errors='replace')
        if isinstance(obj, str):
            try:
                obj.encode('utf-8')
                return obj
            except UnicodeEncodeError:
                try:
                    return obj.encode('latin-1').decode('gbk')
                except (UnicodeDecodeError, UnicodeEncodeError):
                    return obj.encode('latin-1', errors='replace').decode('utf-8', errors='replace')
        return super().default(obj)


class SafeJSONResponse(JSONResponse):
    """自定义 JSON 响应，使用安全编码器"""
    def render(self, content) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            indent=None,
            separators=(',', ':'),
            cls=SafeJSONEncoder,
        ).encode('utf-8')

settings = get_settings()
logger = logging.getLogger(__name__)


def _check_erp_connection():
    """启动时检测 ERP 数据库连接"""
    if not settings.ERP_DB_URL:
        logger.warning("[ERP连接检测] ERP_DB_URL 未配置，跳过")
        return
    if not settings.ERP_SYNC_ENABLED:
        logger.info("[ERP连接检测] ERP 同步未启用，跳过")
        return

    try:
        from sqlalchemy import create_engine, text
        url = settings.ERP_DB_URL
        for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
            if param.split("=")[0] not in url:
                url += f"&{param}" if "?" in url else f"?{param}"
        engine = create_engine(
            url,
            echo=False,
            connect_args={"login_timeout": 10, "timeout": 10},
        )
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        engine.dispose()
        logger.info("[ERP连接检测] ERP 数据库连接正常")
    except Exception as e:
        logger.error(f"[ERP连接检测] ERP 数据库连接失败: {e}")
        logger.error("[ERP连接检测] 请检查 ERP_DB_URL 配置和网络连通性，ERP 同步功能将不可用")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时：检测 ERP 数据库连接
    _check_erp_connection()
    # 启动时：同步权限定义到数据库
    try:
        from app.core.permission_registry import sync_permissions_to_db
        from app.core.database import AsyncSessionLocal
        async with AsyncSessionLocal() as db:
            await sync_permissions_to_db(db)
            # 清理上次未完成的同步任务（服务重启导致的僵尸 running/pending 任务）
            try:
                from sqlalchemy import update, select
                from app.models.basicdata.sync_log import SyncLog
                stale = await db.execute(
                    select(SyncLog).where(SyncLog.status.in_(("pending", "running")))
                )
                for log in stale.scalars():
                    log.status = "failed"
                    log.message = (log.message or "") + " [服务重启，任务中断已自动标记为失败]"
                    if log.finished_at is None:
                        from datetime import datetime
                        log.finished_at = datetime.now()
                await db.commit()
                logger.info("[启动] 已清理中断的同步任务")
            except Exception as e:
                logger.warning(f"[启动] 清理中断同步任务失败: {e}")
    except Exception as e:
        logger.warning(f"[权限注册] 同步权限定义失败: {e}")
    # 启动时：开启 ERP 定时同步
    scheduler.start()
    # 启动时：开启风险评估定时调度
    risk_scheduler.start()
    # 启动时：开启逾期未到料检查
    overdue_checker.start()
    # 启动时：开启 OA 工序产能定时同步（白天每小时增量 + 凌晨3点全量兜底）
    capacity_sync_scheduler.start()
    yield
    # 关闭时：停止调度器
    capacity_sync_scheduler.stop()
    overdue_checker.stop()
    risk_scheduler.stop()
    scheduler.stop()


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    openapi_url=f"{settings.API_PREFIX}/openapi.json",
    docs_url=f"{settings.API_PREFIX}/docs",
    redoc_url=f"{settings.API_PREFIX}/redoc",
    lifespan=lifespan,
    default_response_class=SafeJSONResponse,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.API_PREFIX)

# 挂载本地存储静态目录（本地后端时启用，S3 时为空操作）
try:
    from app.core.storage import get_storage
    get_storage().mount_static(app)
except Exception as e:
    logger.warning(f"[Storage] 挂载静态目录失败: {e}")


@app.get("/health")
async def health_check():
    return {"status": "ok", "version": settings.VERSION, "erp_sync_enabled": settings.ERP_SYNC_ENABLED}
