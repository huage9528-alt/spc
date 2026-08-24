from pathlib import Path
from typing import Optional
from pydantic_settings import BaseSettings
from functools import lru_cache

# config.py 位于 backend/app/core/，项目根目录为其上三级
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
_ENV_FILES = (
    _PROJECT_ROOT / ".env.local",
    _PROJECT_ROOT / ".env",
    Path(".env.local"),
    Path(".env"),
)


class Settings(BaseSettings):
    PROJECT_NAME: str = "供应链与生产协同中台"
    VERSION: str = "1.0.0"
    API_PREFIX: str = "/api/v1"

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://root:123456@192.168.0.127:5432/spc_db"
    DATABASE_URL_SYNC: str = "postgresql+psycopg2://root:123456@192.168.0.127:5432/spc_db"
    # 远程 DB 空闲连接会被防火墙/NAT 静默掐断(无 RST),必须 recycle+pre_ping 双保险
    DB_POOL_RECYCLE: int = 180

    # ERP 中间库连接（只读）
    ERP_DB_URL: str = ""  # e.g. "mssql+pyodbc://user:pass@host/erp_db?driver=ODBC+Driver+17+for+SQL+Server"
    ERP_DB_SCHEMA: str = "dbo"  # ERP 中间表所在 schema
    ERP_SYNC_BATCH_SIZE: int = 500  # 每批次同步条数
    ERP_SYNC_QUERY_TIMEOUT: int = 600  # 单次 ERP 查询超时(秒)，防止无限挂起
    ERP_SYNC_ENABLED: bool = False  # 是否启用 ERP 同步
    ERP_SYNC_DEFAULT_PASSWORD: str = "admin123"  # 自动创建用户的默认密码
    UPPH_MATCH_MODE: str="bom_code"

    erp_db_url_write: Optional[str] = None
    writeback_enabled: bool = True
    writeback_poll_interval: int = 5
    writeback_batch_size: int = 20
    writeback_claim_timeout: int = 120

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # JWT
    SECRET_KEY: str = "your-secret-key-change-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 480  # 8 hours

    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost:5173"]

    # Cache
    DASHBOARD_CACHE_TTL: int = 300  # 5 minutes

    # File storage
    STORAGE_BACKEND: str = "local"  # local / s3
    STORAGE_LOCAL_ROOT: str = "/app/uploads"
    STORAGE_LOCAL_URL_PREFIX: str = "/uploads"
    STORAGE_MAX_FILE_SIZE: int = 10 * 1024 * 1024  # 10MB
    STORAGE_ALLOWED_MIMES: list[str] = [
        "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp",
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/zip",
        "application/x-zip-compressed",
        "application/x-rar-compressed",
        "text/plain",
        "text/csv",
    ]
    # S3 / MinIO（占位）
    STORAGE_S3_ENDPOINT: str = ""
    STORAGE_S3_BUCKET: str = ""
    STORAGE_S3_ACCESS_KEY: str = ""
    STORAGE_S3_SECRET_KEY: str = ""
    STORAGE_S3_REGION: str = ""

    # AI Service
    AI_DEFAULT_PROVIDER: str = "rule_based"  # rule_based | openai | dashscope
    AI_OPENAI_API_KEY: str = ""
    AI_OPENAI_MODEL: str = "gpt-4o-mini"
    AI_OPENAI_BASE_URL: str = ""
    AI_DASHSCOPE_API_KEY: str = ""
    AI_DASHSCOPE_MODEL: str = "qwen-plus"
    AI_REQUEST_TIMEOUT: int = 30

    # Agent 稳固性
    AI_SUMMARY_ENABLED: bool = True
    AI_SUMMARY_TOKEN_LIMIT: int = 80000
    AI_RUN_LOG_DIR: str = ""
    AI_LOG_RETENTION_DAYS: int = 30
    AI_MAX_AGENT_DURATION_S: int = 120

    # 物料盘点
    STOCK_CHECK_RECENT_SKIP_DAYS: int = 7  # 订单盘点建单/刷新BOM时，近 N 天内已盘过的(物料×仓库)行仅标记"近期已盘"免盘(不预填盘点数据)

    # WeCom (企业微信)
    wecom_corp_id: Optional[str] = None
    wecom_agent_id: Optional[str] = None
    wecom_corp_secret: Optional[str] = None
    wecom_contact_secret: Optional[str] = None
    frontend_base_url: Optional[str] = None
    data_supply_alert_wecom_uids: str = ""  # 逗号分隔的企微 userid，空则告警只记日志

    model_config = {"env_file": _ENV_FILES, "env_file_encoding": "utf-8", "extra": "ignore"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
