"""部署运维中心路由组（部署版本管理）。"""
from app.api.v1.system.deploy_versions import router as deploy_versions_router

from app.api.v1.system import deploy_versions  # noqa: F401  导出子模块，供 api/v1/__init__.py 挂载 router

