"""上传内容安全校验：扩展名白名单 + 魔数（magic bytes）嗅探。

防范场景：客户端可任意伪造 multipart 的 Content-Type 与文件名。若仅校验声明的
MIME，攻击者可把 .html/.svg 声明为 text/plain / image/png 上传，本地存储按
`{uuid}{原始扩展名}` 落盘后被 StaticFiles 按扩展名以 text/html、image/svg+xml
同源渲染，造成存储型 XSS（token 存于 localStorage，可直接被窃取）。

校验策略（三层，全部通过才放行）：
1. 声明的 MIME 必须在调用方的 MIME 白名单内（由端点用 Settings.STORAGE_ALLOWED_MIMES 校验）；
2. 文件扩展名必须与声明的 MIME 匹配（MIME_EXTENSIONS 映射），杜绝"声明文本、实为 .html"；
3. 文件内容的魔数必须与声明的 MIME 家族匹配；纯文本类无魔数，仅允许声明 text/plain / text/csv
   且内容不含 NUL 字节。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional


class UploadValidationError(ValueError):
    """上传内容未通过安全校验（message 可直接作为 400 detail 返回给用户）"""


# 每个 MIME 允许的扩展名（与 Settings.STORAGE_ALLOWED_MIMES 一一对应）
MIME_EXTENSIONS: dict[str, set[str]] = {
    "image/png": {".png"},
    "image/jpeg": {".jpg", ".jpeg"},
    "image/jpg": {".jpg", ".jpeg"},
    "image/gif": {".gif"},
    "image/webp": {".webp"},
    "image/bmp": {".bmp"},
    "application/pdf": {".pdf"},
    "application/msword": {".doc"},
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {".docx"},
    "application/vnd.ms-excel": {".xls"},
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {".xlsx"},
    "application/vnd.ms-powerpoint": {".ppt"},
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": {".pptx"},
    "application/zip": {".zip"},
    "application/x-zip-compressed": {".zip"},
    "application/x-rar-compressed": {".rar"},
    "text/plain": {".txt"},
    "text/csv": {".csv"},
}

_TEXT_MIMES = {"text/plain", "text/csv"}

_EXT_RE = re.compile(r"^\.[a-z0-9]{1,8}$")


def _sniff_families(content: bytes) -> Optional[set[str]]:
    """按魔数返回内容所属的 MIME 家族；识别不出二进制签名时返回 None（可能为纯文本）。"""
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return {"image/png"}
    if content.startswith(b"\xff\xd8\xff"):
        return {"image/jpeg", "image/jpg"}
    if content.startswith((b"GIF87a", b"GIF89a")):
        return {"image/gif"}
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return {"image/webp"}
    if content.startswith(b"BM"):
        return {"image/bmp"}
    if content.startswith(b"%PDF-"):
        return {"application/pdf"}
    if content.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
        # ZIP 容器家族：zip / docx / xlsx / pptx 共享同一签名，无法仅凭魔数细分
        return {
            "application/zip",
            "application/x-zip-compressed",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }
    if content.startswith(b"Rar!\x1a\x07"):
        return {"application/x-rar-compressed"}
    if content.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        # OLE2 容器家族：doc / xls / ppt 共享同一签名
        return {
            "application/msword",
            "application/vnd.ms-excel",
            "application/vnd.ms-powerpoint",
        }
    return None


def validate_upload(content: bytes, filename: str, declared_mime: str) -> str:
    """校验上传文件，通过则返回可用的 MIME，不通过抛 UploadValidationError。

    - content: 文件完整字节（调用方已限制大小）
    - filename: 客户端原始文件名（仅用于提取扩展名）
    - declared_mime: 客户端声明的 Content-Type（调用方应先用 MIME 白名单过滤）
    """
    allowed_exts = MIME_EXTENSIONS.get(declared_mime)
    if allowed_exts is None:
        raise UploadValidationError(f"不支持的文件类型: {declared_mime}")

    ext = Path(filename or "").suffix.lower()
    if not ext or not _EXT_RE.match(ext) or ext not in allowed_exts:
        raise UploadValidationError(
            f"文件扩展名 '{ext or '无'}' 与文件类型 {declared_mime} 不匹配，"
            f"该类型仅允许: {', '.join(sorted(allowed_exts))}"
        )

    families = _sniff_families(content)
    if families is None:
        # 无二进制签名：仅接受文本类声明，且内容不得含 NUL 字节（含 NUL 视为二进制）
        if declared_mime not in _TEXT_MIMES:
            raise UploadValidationError(f"文件内容与声明的类型 {declared_mime} 不符")
        if b"\x00" in content[:8192]:
            raise UploadValidationError("文件内容包含二进制数据，与声明的文本类型不符")
    elif declared_mime not in families:
        raise UploadValidationError(f"文件内容与声明的类型 {declared_mime} 不符")

    return declared_mime
