from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Deploy Agent 配置。从环境变量 DEPLOY_AGENT_* 读取。"""

    # 工作目录：包含 docker-compose-prod.yml / .env / versions/ / current.txt
    work_dir: str = "/opt/spc-v2"
    # 源码目录：用于 git pull + docker build
    source_dir: str = "/opt/spc-v2/source"
    # Git 远程（生产主机首次部署时 git clone；之后用 pull）
    git_url: str = ""
    git_branch: str = "main"

    # 镜像名（与 docker compose service tag 一致）
    backend_image: str = "spc-v2-backend"
    frontend_image: str = "spc-v2-frontend"

    compose_file: str = "docker-compose-prod.yml"

    # 健康检查端点
    backend_ping_url: str = "http://localhost:18085/api/v1/common/ping"
    frontend_url: str = "http://localhost:18084/"

    # 保留最近 N 个版本
    retain_count: int = 5

    # 与后端共用 JWT secret
    jwt_secret: str = "dev-secret"
    jwt_algorithms: list[str] = ["HS256"]

    # 监听
    host: str = "127.0.0.1"
    port: int = 8901

    model_config = SettingsConfigDict(
        env_prefix="DEPLOY_AGENT_",
        env_file=(".env.local", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )


_settings: Settings | None = None


def get_settings() -> Settings:
    """lru_cache'd settings。"""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
