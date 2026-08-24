"""对外接口注册表

每个对外接口在 endpoints/ 中用 @register_external 声明：
- endpoint_code: 唯一标识，与 API Key 的 allowed_endpoints_json、调用日志 data_type 对应
- path: 相对 /external 前缀的路径（须与真实路由一致，装配时有一致性校验）

真实路由由各 endpoints/*.py 的 APIRouter 声明；本注册表只负责
endpoint 清单（管理端勾选、文档索引），不再参与请求分发。
"""

from dataclasses import dataclass, field
from typing import Callable, List, Optional

from fastapi.routing import APIRoute


@dataclass
class ExternalEndpoint:
    """对外接口定义"""
    endpoint_code: str                 # 唯一标识，如 orders.list
    name: str                          # 中文名
    description: str = ""
    method: str = "GET"                # HTTP 方法
    path: str = ""                     # 相对 /external 前缀的路径，如 /orders/list
    tags: List[str] = field(default_factory=list)


_REGISTRY: dict = {}


def register_external(
    endpoint_code: str,
    name: str,
    *,
    method: str = "GET",
    path: str = "",
    description: str = "",
    tags: Optional[List[str]] = None,
) -> Callable:
    """装饰器：登记一个对外接口（与真实路由装饰器叠加使用，见 endpoints/orders.py）"""
    def decorator(fn):
        endpoint = ExternalEndpoint(
            endpoint_code=endpoint_code,
            name=name,
            description=description,
            method=method.upper(),
            path=path or f"/{endpoint_code.replace('.', '/')}",
            tags=tags or [],
        )
        if endpoint.endpoint_code in _REGISTRY:
            raise ValueError(f"endpoint_code 重复: {endpoint.endpoint_code}")
        _REGISTRY[endpoint.endpoint_code] = endpoint
        return fn
    return decorator


def get_endpoint_by_code(endpoint_code: str) -> Optional[ExternalEndpoint]:
    return _REGISTRY.get(endpoint_code)


def list_endpoints() -> List[ExternalEndpoint]:
    return list(_REGISTRY.values())


def list_endpoint_dicts() -> List[dict]:
    """返回可直接 JSON 序列化的 endpoint 清单（格式与旧版完全一致，前端在用）"""
    return [
        {
            "endpoint_code": e.endpoint_code,
            "name": e.name,
            "description": e.description,
            "method": e.method,
            "path": f"/external{e.path}",
            "tags": e.tags,
        }
        for e in _REGISTRY.values()
    ]


def check_registry_matches_router(router) -> None:
    """校验注册表 (method, path) 与真实路由一致，防止两处声明漂移。启动时调用。"""
    reg = {(e.method, e.path) for e in list_endpoints()}
    routes = set()
    for r in router.routes:
        if isinstance(r, APIRoute):
            for m in r.methods:
                routes.add((m, r.path))
    if reg != routes:
        only_reg = sorted(reg - routes)
        only_route = sorted(routes - reg)
        raise RuntimeError(
            f"对外接口注册表与路由不一致，仅注册表: {only_reg}，仅路由: {only_route}"
        )
