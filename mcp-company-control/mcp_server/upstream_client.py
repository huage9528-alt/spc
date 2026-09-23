"""中台只读查询端点客户端 — 超时、错误码映射、受限重试（规范 §11/§12/§13）

认证（优先级）：
  1) HMAC API Key（SPC「数据供给」机制）：APP_KEY + APP_SECRET，
     签名串 = timestamp + app_key + endpoint_code + query_string（HMAC-SHA256 hex）
  2) 静态 Bearer TOKEN
  3) OAuth2 client_credentials

凭证全部来自环境变量，禁止硬编码（规范 §11）。日志只写 stderr，绝不写 stdout（规范 §4）。
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import time
from typing import Any, Dict, Optional
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

load_dotenv()  # 读取项目根 .env；不覆盖已存在的环境变量

BASE_URL = os.getenv("CONTROL_PLATFORM_BASE_URL", "").rstrip("/")
APP_KEY = os.getenv("CONTROL_PLATFORM_APP_KEY", "")
APP_SECRET = os.getenv("CONTROL_PLATFORM_APP_SECRET", "")
TOKEN = os.getenv("CONTROL_PLATFORM_TOKEN", "")
CLIENT_ID = os.getenv("CONTROL_PLATFORM_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("CONTROL_PLATFORM_CLIENT_SECRET", "")
TOKEN_URL = os.getenv("CONTROL_PLATFORM_TOKEN_URL", "")
REQUEST_TIMEOUT_MS = int(os.getenv("CONTROL_PLATFORM_TIMEOUT_MS", "15000"))
CONNECT_TIMEOUT_MS = int(os.getenv("CONTROL_PLATFORM_CONNECT_TIMEOUT_MS", "5000"))

# SPC 可暴露接口注册表：路径 → endpoint_code（int: 前缀为内部 @exposable；其余为对外接口注册表）
# 签名用，必须与 SPC 侧注册一致；已就绪：/common/ping + 五个对外接口 + 物料齐套 5 接口 + 质量 2 接口
_ENDPOINT_CODES = {
    "/common/ping": "int:health.ping",
    "/external/orders/list": "orders.list",
    "/external/order-details/list": "order_details.list",
    "/external/boms/tree": "boms.tree",
    "/external/materials/list": "materials.list",
    "/external/suppliers/list": "suppliers.list",
    "/external/material-kitting/results": "kitting.results",
    "/external/material-kitting/shortages": "kitting.shortages",
    "/external/material-kitting/demands": "kitting.demands",
    "/external/inventory/availability": "inventory.availability",
    "/external/material-supplies/list": "material.supplies",
    "/external/quality-issues/list": "quality_issues.list",
    "/external/quality-trace/list": "quality_trace.list",
}

_RETRYABLE = {"UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED"}
_MAX_ATTEMPTS = 2  # 首次 + 至多 1 次重试，禁止无限重试（规范 §12）
_RETRY_BACKOFF_S = 0.4

_token_cache: Dict[str, Any] = {"token": "", "expires_at": 0.0}


class UpstreamError(Exception):
    """上游调用失败 — code 取规范 §12 错误码"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(REQUEST_TIMEOUT_MS / 1000, connect=CONNECT_TIMEOUT_MS / 1000)


def _map_status(status: int) -> str:
    if status in (400, 422):
        return "INVALID_ARGUMENT"
    if status == 401:
        return "UNAUTHORIZED"
    if status == 403:
        return "FORBIDDEN"
    if status == 404:
        return "NOT_FOUND"
    if status == 429:
        return "RATE_LIMITED"
    if status >= 500:
        return "UPSTREAM_UNAVAILABLE"
    return "INTERNAL_ERROR"


def _hmac_headers(path: str, query_string: str) -> Dict[str, str]:
    """SPC HMAC 签名头：待签名串 = timestamp + app_key + endpoint_code + query_string"""
    endpoint_code = _ENDPOINT_CODES.get(path)
    if not endpoint_code:
        raise UpstreamError("INTERNAL_ERROR", f"缺少 {path} 的 endpoint_code 映射（SPC 可暴露接口未注册）")
    timestamp = str(int(time.time()))
    string_to_sign = f"{timestamp}{APP_KEY}{endpoint_code}{query_string}"
    signature = hmac.new(APP_SECRET.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return {"X-App-Key": APP_KEY, "X-Timestamp": timestamp, "X-Signature": signature}


async def _get_token() -> str:
    if not BASE_URL:
        raise UpstreamError("UPSTREAM_UNAVAILABLE", "未配置 CONTROL_PLATFORM_BASE_URL")
    if TOKEN:
        return TOKEN
    if CLIENT_ID and CLIENT_SECRET:
        now = time.time()
        if _token_cache["token"] and now < _token_cache["expires_at"] - 60:
            return str(_token_cache["token"])
        url = TOKEN_URL or f"{BASE_URL}/oauth/token"
        async with httpx.AsyncClient(timeout=_timeout()) as client:
            resp = await client.post(
                url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": CLIENT_ID,
                    "client_secret": CLIENT_SECRET,
                },
            )
        if resp.status_code != 200:
            raise UpstreamError("UNAUTHORIZED", f"获取访问令牌失败 HTTP {resp.status_code}")
        body = resp.json()
        _token_cache["token"] = body.get("access_token", "")
        _token_cache["expires_at"] = now + float(body.get("expires_in", 3600))
        return str(_token_cache["token"])
    raise UpstreamError("UNAUTHORIZED", "未配置中台凭证（APP_KEY/APP_SECRET、TOKEN 或 CLIENT_ID/CLIENT_SECRET）")


async def _auth_headers(path: str, query_string: str) -> Dict[str, str]:
    if APP_KEY and APP_SECRET:
        return _hmac_headers(path, query_string)
    token = await _get_token()
    return {"Authorization": f"Bearer {token}"}


def _unwrap_envelope(body: Any) -> Dict[str, Any]:
    """SPC 统一信封 {code,message,data} 适配：code!=0 转结构化错误，成功返回 data。"""
    if isinstance(body, dict) and "code" in body:
        code = body.get("code")
        if code not in (0, None):
            message = str(body.get("message") or "上游返回业务错误")
            if isinstance(code, int):
                raise UpstreamError(_map_status(code), message)
            raise UpstreamError("INTERNAL_ERROR", message)
        inner = body.get("data")
        return inner if isinstance(inner, dict) else {"data": inner}
    return body if isinstance(body, dict) else {"data": body}


async def call(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """GET {BASE_URL}{path}?query，200 返回 JSON dict；失败抛 UpstreamError（错误码见 §12）

    查询串由本函数拼装并参与 HMAC 签名，保证与服务端收到的原始 query string 一致。
    """
    if not BASE_URL:
        raise UpstreamError("UPSTREAM_UNAVAILABLE", "未配置 CONTROL_PLATFORM_BASE_URL")
    query_string = urlencode(params) if params else ""
    url = f"{BASE_URL}{path}" + (f"?{query_string}" if query_string else "")
    headers = await _auth_headers(path, query_string)
    last_error: Optional[UpstreamError] = None

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=_timeout()) as client:
                resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                return _unwrap_envelope(resp.json())
            code = _map_status(resp.status_code)
            last_error = UpstreamError(code, f"中台端点 {path} 返回 HTTP {resp.status_code}")
            if code not in _RETRYABLE:
                raise last_error
        except httpx.TimeoutException:
            last_error = UpstreamError("UPSTREAM_TIMEOUT", f"中台端点 {path} 响应超时（>{REQUEST_TIMEOUT_MS}ms）")
        except httpx.HTTPError as exc:
            last_error = UpstreamError("UPSTREAM_UNAVAILABLE", f"中台端点 {path} 不可达：{type(exc).__name__}")

        if attempt < _MAX_ATTEMPTS and last_error.code in _RETRYABLE:
            await asyncio.sleep(_RETRY_BACKOFF_S)
            continue
        break

    assert last_error is not None
    logger.warning("upstream call failed: %s -> %s", path, last_error.code)
    raise last_error
