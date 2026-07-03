from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    PROJECT_NAME: str = "供应链与生产协同中台"
    VERSION: str = "1.0.0"
    API_PREFIX: str = "/api/v1"

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://root:123456@192.168.0.127:5432/spc_db"
    DATABASE_URL_SYNC: str = "postgresql+psycopg2://root:123456@192.168.0.127:5432/spc_db"

    # ERP 中间库连接（只读）
    ERP_DB_URL: str = ""  # e.g. "mssql+pyodbc://user:pass@host/erp_db?driver=ODBC+Driver+17+for+SQL+Server"
    ERP_DB_SCHEMA: str = "dbo"  # ERP 中间表所在 schema
    ERP_SYNC_BATCH_SIZE: int = 500  # 每批次同步条数
    ERP_SYNC_ENABLED: bool = False  # 是否启用 ERP 同步
    ERP_SYNC_DEFAULT_PASSWORD: str = "admin123"  # 自动创建用户的默认密码

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

    model_config = {"env_file": (".env.local", ".env"), "env_file_encoding": "utf-8", "extra": "ignore"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
