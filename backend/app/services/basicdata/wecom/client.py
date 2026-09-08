import asyncio
import hashlib
import secrets
import time
from typing import Any, Literal

import httpx

from app.core.config import get_settings
from app.services.basicdata.wecom.exceptions import (
    WecomAPIError,
    WecomNotConfiguredError,
)

WECOM_BASE = "https://qyapi.weixin.qq.com"

_TOKEN_TTL_SECONDS = 7000
_TOKEN_BUFFER_SECONDS = 100
_JSAPI_TICKET_TTL_SECONDS = 7000  # 官方 7200s，提前 200s 刷新

JSAPI_LIST_SCAN = ["scanQRCode"]


class WecomClient:
    def __init__(self):
        self._settings = get_settings()
        self._token_cache: dict[str, tuple[str, float]] = {}
        self._jsapi_ticket_cache: tuple[str, float] | None = None
        self._lock = asyncio.Lock()
        # jsapi_ticket 必须用独立锁：_request/get_access_token 也用 _lock，
        # 同锁不可重入会导致冷启动时 get_jsapi_ticket 永久阻塞。
        self._jsapi_ticket_lock = asyncio.Lock()

    def _require_secret(self, kind: Literal["app", "contact"]) -> str:
        corp_id = self._settings.wecom_corp_id
        if not corp_id:
            raise WecomNotConfiguredError("WECOM_CORP_ID 未配置")
        if kind == "app":
            secret = self._settings.wecom_corp_secret
            if not secret:
                raise WecomNotConfiguredError("WECOM_CORP_SECRET 未配置")
        else:
            secret = self._settings.wecom_contact_secret or self._settings.wecom_corp_secret
            if not secret:
                raise WecomNotConfiguredError("通讯录 secret 未配置（WECOM_CONTACT_SECRET 或 WECOM_CORP_SECRET）")
        return secret

    async def get_access_token(self, kind: Literal["app", "contact"] = "app") -> str:
        cached = self._token_cache.get(kind)
        now = time.time()
        if cached and cached[1] > now + _TOKEN_BUFFER_SECONDS:
            return cached[0]

        async with self._lock:
            cached = self._token_cache.get(kind)
            if cached and cached[1] > now + _TOKEN_BUFFER_SECONDS:
                return cached[0]

            corp_id = self._settings.wecom_corp_id
            secret = self._require_secret(kind)
            url = f"{WECOM_BASE}/cgi-bin/gettoken"
            params = {"corpid": corp_id, "corpsecret": secret}
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(url, params=params)
            data = resp.json()
            if data.get("errcode", 0) != 0 or "access_token" not in data:
                raise WecomAPIError(
                    data.get("errcode", -1),
                    data.get("errmsg", "获取 access_token 失败"),
                    http_status=resp.status_code,
                )
            token = data["access_token"]
            self._token_cache[kind] = (token, now + _TOKEN_TTL_SECONDS)
            return token

    async def _request(
        self,
        method: str,
        path: str,
        kind: Literal["app", "contact"],
        params: dict | None = None,
        json_body: dict | None = None,
        retry_on_invalid_token: bool = True,
    ) -> dict:
        token = await self.get_access_token(kind)
        url = f"{WECOM_BASE}{path}"
        async with httpx.AsyncClient(timeout=30) as client:
            for attempt in range(2):
                req_params = {"access_token": token}
                if params:
                    req_params.update(params)
                if method == "GET":
                    resp = await client.get(url, params=req_params)
                else:
                    resp = await client.post(url, params=req_params, json=json_body)
                if resp.status_code != 200:
                    raise WecomAPIError(resp.status_code, f"HTTP {resp.status_code}", resp.status_code)
                data = resp.json()
                errcode = data.get("errcode", 0)
                if errcode == 40001 and retry_on_invalid_token and attempt == 0:
                    self._token_cache.pop(kind, None)
                    token = await self.get_access_token(kind)
                    continue
                if errcode != 0 and errcode is not None:
                    raise WecomAPIError(errcode, data.get("errmsg", ""), resp.status_code)
                return data
        return {}

    async def list_departments(self) -> list[dict]:
        data = await self._request("GET", "/cgi-bin/department/list", "contact")
        return data.get("department", [])

    async def list_users(self, department_id: int = 1, fetch_child: int = 1) -> list[dict]:
        data = await self._request(
            "GET",
            "/cgi-bin/user/list",
            "contact",
            params={"department_id": department_id, "fetch_child": fetch_child},
        )
        return data.get("userlist", [])

    async def send_app_message(self, payload: dict) -> dict:
        return await self._request(
            "POST",
            "/cgi-bin/message/send",
            "app",
            json_body=payload,
        )

    async def get_userinfo_by_code(self, code: str) -> dict:
        """通过 OAuth code 换取访问者身份（含 userid）"""
        data = await self._request(
            "GET",
            "/cgi-bin/auth/getuserinfo",
            "app",
            params={"code": code},
        )
        return data

    async def get_jsapi_ticket(self) -> str:
        """获取企业 jsapi_ticket（用于 wx.config 签名；JS-SDK 全家桶含 scanQRCode）"""
        cached = self._jsapi_ticket_cache
        now = time.time()
        if cached and cached[1] > now + _TOKEN_BUFFER_SECONDS:
            return cached[0]

        async with self._jsapi_ticket_lock:
            cached = self._jsapi_ticket_cache
            if cached and cached[1] > now + _TOKEN_BUFFER_SECONDS:
                return cached[0]

            data = await self._request(
                "GET",
                "/cgi-bin/get_jsapi_ticket",
                "app",
            )
            ticket = data.get("ticket")
            if not ticket:
                raise WecomAPIError(
                    data.get("errcode", -1),
                    data.get("errmsg", "获取 jsapi_ticket 失败"),
                    http_status=200,
                )
            self._jsapi_ticket_cache = (ticket, now + _JSAPI_TICKET_TTL_SECONDS)
            return ticket

    @staticmethod
    def generate_jsapi_signature(ticket: str, url: str, timestamp: int, nonce_str: str) -> str:
        """按企业微信官方算法生成 wx.config 签名（SHA1）"""
        raw = (
            f"jsapi_ticket={ticket}&noncestr={nonce_str}"
            f"&timestamp={timestamp}&url={url}"
        )
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def new_nonce_str(length: int = 16) -> str:
        return secrets.token_urlsafe(length)


_singleton: WecomClient | None = None


def get_wecom_client() -> WecomClient:
    global _singleton
    if _singleton is None:
        _singleton = WecomClient()
    return _singleton
