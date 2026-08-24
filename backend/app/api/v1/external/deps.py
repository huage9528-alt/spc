"""对外接口认证依赖：签名校验 + IP 白名单（语义与文案照抄旧 router.py）"""

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.basicdata.data_supply import DataSupplyApiKey
from app.services.basicdata.data_supply_service import (
    validate_signature_for_endpoint,
    check_ip_whitelist,
)
from app.services.basicdata.rate_limiter import check_rate_limit, RATE_LIMITED_MARK
from app.services.basicdata.data_supply_service import log_call


def external_auth(endpoint_code: str):
    """按 endpoint_code 生成认证依赖。

    顺序与旧 _dispatch 一致：签名认证 -> IP 白名单 -> 业务 handler。
    """
    async def dependency(
        request: Request,
        db: AsyncSession = Depends(get_db),
    ) -> DataSupplyApiKey:
        app_key = request.headers.get("X-App-Key")
        signature = request.headers.get("X-Signature")
        timestamp = request.headers.get("X-Timestamp")

        if not (app_key and signature and timestamp):
            raise HTTPException(
                status_code=401,
                detail="缺少认证信息：请提供 X-App-Key + X-Timestamp + X-Signature",
            )

        query_string = str(request.url.query) if request.url.query else ""
        key_obj, reason = await validate_signature_for_endpoint(
            db, app_key, signature, timestamp, endpoint_code, query_string
        )
        if not key_obj:
            raise HTTPException(status_code=403, detail=f"签名认证失败：{reason}")

        client_ip = request.client.host if request.client else None
        if client_ip and not check_ip_whitelist(key_obj, client_ip):
            raise HTTPException(status_code=403, detail=f"IP {client_ip} 不在白名单内")

        allowed, retry_after = await check_rate_limit(key_obj.id, key_obj.rate_limit)
        if not allowed:
            await log_call(
                db=db, api_key_id=key_obj.id, api_key_name=key_obj.key_name,
                data_type=endpoint_code, request_params=dict(request.query_params),
                response_status=429, response_count=0,
                ip_address=request.client.host if request.client else None,
                user_agent=request.headers.get("user-agent"),
                duration_ms=0.0, error_message=RATE_LIMITED_MARK,
            )
            raise HTTPException(
                status_code=429,
                detail=f"请求超过每分钟限额 {key_obj.rate_limit} 次，请 {retry_after} 秒后重试",
                headers={"Retry-After": str(retry_after)},
            )

        return key_obj

    return dependency

