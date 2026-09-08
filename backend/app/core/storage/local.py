"""本地文件存储后端

路径规则: {STORAGE_LOCAL_ROOT}/{namespace}/{YYYY}/{MM}/{uuid}{ext}
URL    : {STORAGE_LOCAL_URL_PREFIX}/{key}
"""
from __future__ import annotations

import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import BinaryIO

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.core.storage.base import StorageBackend, StoredFile


_SAFE_NS = re.compile(r"^[a-zA-Z0-9_\-]+$")
_SAFE_EXT = re.compile(r"^[a-z0-9]{1,8}$")


class _StaticSecurityHeaders:
    """为静态附件响应附加安全头的 ASGI 包装。

    /uploads 静态挂载按扩展名推断 Content-Type（如 .html -> text/html），
    nosniff + CSP sandbox 可阻止历史遗留或绕过校验的文件在浏览器中同源执行脚本。
    """

    def __init__(self, asgi_app):
        self.asgi_app = asgi_app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.asgi_app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                headers.append((b"x-content-type-options", b"nosniff"))
                headers.append((b"content-security-policy", b"sandbox"))
            await send(message)

        await self.asgi_app(scope, receive, send_with_headers)


class LocalStorageBackend(StorageBackend):
    def __init__(self, settings):
        self.root = Path(settings.STORAGE_LOCAL_ROOT).resolve()
        self.url_prefix = settings.STORAGE_LOCAL_URL_PREFIX.rstrip("/")
        self.root.mkdir(parents=True, exist_ok=True)

    def _build_key(self, namespace: str, original_name: str) -> str:
        ns = namespace if _SAFE_NS.match(namespace or "") else "misc"
        now = datetime.now()
        ext = Path(original_name or "").suffix.lower().lstrip(".")
        # 纵深防御：扩展名落地前再清洗一次（上游已有 MIME->扩展名白名单校验）
        if not _SAFE_EXT.match(ext):
            ext = ""
        fname = f"{uuid.uuid4().hex}.{ext}" if ext else uuid.uuid4().hex
        return f"{ns}/{now:%Y}/{now:%m}/{fname}"

    def _full_path(self, key: str) -> Path:
        # 防穿越
        target = (self.root / key).resolve()
        if not str(target).startswith(str(self.root)):
            raise ValueError(f"Invalid key: {key}")
        return target

    def save(self, content: bytes, original_name: str, mime: str, namespace: str) -> StoredFile:
        key = self._build_key(namespace, original_name)
        path = self._full_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            f.write(content)
        return StoredFile(
            key=key,
            url=self.get_url(key),
            name=original_name,
            size=len(content),
            mime=mime,
        )

    def delete(self, key: str) -> None:
        try:
            path = self._full_path(key)
            if path.exists():
                os.remove(path)
        except (FileNotFoundError, ValueError):
            return

    def get_url(self, key: str) -> str:
        return f"{self.url_prefix}/{key}"

    def open(self, key: str) -> BinaryIO:
        return open(self._full_path(key), "rb")

    def mount_static(self, app: FastAPI) -> None:
        # 挂载至 /uploads 静态路由（附加 nosniff + CSP sandbox 安全头）
        app.mount(
            self.url_prefix,
            _StaticSecurityHeaders(StaticFiles(directory=str(self.root))),
            name="uploads",
        )
