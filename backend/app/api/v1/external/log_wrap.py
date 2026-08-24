"""对外接口调用日志装饰器（行为照抄旧 router.py _dispatch 的日志段）"""

import functools
import time

from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.basicdata.data_supply import DataSupplyApiKey
from app.schemas.common import ResponseModel
from app.services.basicdata.data_supply_service import log_call


def log_external_call(endpoint_code: str, path_params: tuple = ()):
    """包装对外接口 handler，记录 DataSupplyCallLog。

    约定：被包装函数的 kwargs 必须含 request / db / key 三个名字
    （所有对外接口 handler 都按此签名声明）。
    path_params: 路径参数名元组（如 ("oa_org_id",)），合并进日志的 request_params。
    """
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            request: Request = kwargs["request"]
            db: AsyncSession = kwargs["db"]
            key_obj: DataSupplyApiKey = kwargs["key"]
            client_ip = request.client.host if request.client else None

            params: dict = dict(request.query_params)
            for p in path_params:
                if p in kwargs:
                    params[p] = kwargs[p]

            start_time = time.time()
            try:
                result = await fn(*args, **kwargs)
                response_count = (
                    len(result["items"])
                    if isinstance(result, dict) and "items" in result
                    else (1 if result else 0)
                )
            except HTTPException:
                raise
            except Exception as e:
                # 业务异常可能已让当前事务进入 aborted 状态，先回滚再写日志（照抄旧逻辑）
                try:
                    await db.rollback()
                except Exception:
                    pass
                duration_ms = (time.time() - start_time) * 1000
                await log_call(
                    db=db, api_key_id=key_obj.id, api_key_name=key_obj.key_name,
                    data_type=endpoint_code, request_params=params,
                    response_status=500, response_count=0,
                    ip_address=client_ip,
                    user_agent=request.headers.get("user-agent"),
                    duration_ms=duration_ms, error_message=str(e),
                )
                raise HTTPException(status_code=500, detail=f"接口内部错误: {str(e)}")

            duration_ms = (time.time() - start_time) * 1000
            await log_call(
                db=db, api_key_id=key_obj.id, api_key_name=key_obj.key_name,
                data_type=endpoint_code, request_params=params,
                response_status=200, response_count=response_count,
                ip_address=client_ip,
                user_agent=request.headers.get("user-agent"),
                duration_ms=duration_ms,
            )
            # 与旧 _dispatch 一致：handler 返回裸业务 dict，此处统一包上响应封皮
            return ResponseModel(data=result)
        return wrapper
    return decorator
