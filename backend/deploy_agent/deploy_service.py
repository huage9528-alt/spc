"""部署服务核心逻辑。

把原本散在 scripts/deploy-remote.ps1 / manage-version.ps1 的命令搬到这里，
封装成可异步调用、可流式上报日志的 Python 函数。

公开 API：
    list_versions() -> list[dict]
    get_status() -> dict
    rollback(version: str) -> AsyncIterator[JobEvent]   # 同步推进，返回流式事件
    switch(version: str)   -> AsyncIterator[JobEvent]
    deploy_new(note, options) -> (job_id, AsyncIterator[JobEvent])

事件总线：module-level JobBus 实例。

所有"运行中的命令"统一通过 _run_step() 走 subprocess.Popen，按行读取 stdout/stderr，
同时 publish 到 JobBus。这种设计不需要 docker SDK（docker CLI 已经够用，部署主机必装 docker），
也方便在主机上直接调试（所有命令都是人也能跑的 shell 命令）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator

logger = logging.getLogger("deploy_agent.service")


# ============================================================
# 事件总线
# ============================================================
class JobBus:
    """job_id -> 订阅者列表的简易 PubSub。

    用 register() 在任务启动 *之前* 预先订阅，确保事件不会丢失。
    subscribe() 在 stream 已启动后用于 SSE 端点；事件通过 read-and-replay 列表补齐。
    """

    def __init__(self) -> None:
        self._subs: dict[str, list[asyncio.Queue[dict]]] = {}
        self._replay: dict[str, list[dict]] = {}
        self._ended: dict[str, bool] = {}
        self._lock = asyncio.Lock()

    def publish(self, job_id: str, event: dict) -> None:
        ev = dict(event)
        ev.setdefault("ts", datetime.utcnow().isoformat(timespec="seconds") + "Z")
        ev["job_id"] = job_id
        # 缓存 replay（最多 200 条，新消费者可补齐）
        replay = self._replay.setdefault(job_id, [])
        if len(replay) < 200:
            replay.append(ev)
        if ev.get("event") == "end":
            self._ended[job_id] = True
        for q in list(self._subs.get(job_id, ())):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:  # pragma: no cover
                pass
            except Exception:  # pragma: no cover
                pass

    async def register(self, job_id: str) -> asyncio.Queue[dict]:
        """预先创建一个 queue 并注册，供后续 SSE 端点 take over。"""
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=2048)
        async with self._lock:
            self._subs.setdefault(job_id, []).append(q)
        # 投递 replay 已结束标志
        if self._ended.get(job_id):
            try:
                tail = dict(self._replay.get(job_id, [])[-1]) if self._replay.get(job_id) else \
                    {"event": "end", "status": "unknown", "job_id": job_id}
                q.put_nowait(tail)
            except Exception:  # pragma: no cover
                pass
        return q

    async def subscribe(self, job_id: str) -> AsyncIterator[dict]:
        """晚加入的订阅器：先 replay 已缓存事件，再订阅 live。"""
        # 先快速投递 replay
        for ev in list(self._replay.get(job_id, ())):
            yield ev
            if ev.get("event") == "end":
                return
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=2048)
        async with self._lock:
            self._subs.setdefault(job_id, []).append(q)
        # 任务结束则直接退出
        if self._ended.get(job_id):
            async with self._lock:
                if q in self._subs.get(job_id, ()):
                    self._subs[job_id].remove(q)
                    if not self._subs[job_id]:
                        self._subs.pop(job_id, None)
            return
        try:
            while True:
                ev = await q.get()
                yield ev
                if ev.get("event") == "end":
                    return
        finally:
            async with self._lock:
                if q in self._subs.get(job_id, ()):
                    self._subs[job_id].remove(q)
                    if not self._subs[job_id]:
                        self._subs.pop(job_id, None)

    def final_status(self, job_id: str) -> dict | None:
        if not self._ended.get(job_id):
            return None
        events = self._replay.get(job_id, [])
        for ev in reversed(events):
            if ev.get("event") == "end":
                return ev
        return None

    def is_ended(self, job_id: str) -> bool:
        return bool(self._ended.get(job_id))

    def has(self, job_id: str) -> bool:
        return job_id in self._replay


bus = JobBus()


# ============================================================
# 通用执行器
# ============================================================
@dataclass
class StepResult:
    ok: bool
    code: int = 0
    duration_ms: int = 0


async def _run_step(
    job_id: str,
    step_index: int,
    step_name: str,
    cmd: list[str],
    cwd: str | None = None,
    timeout: int = 1800,
    env: dict | None = None,
) -> StepResult:
    """跑一条 shell 命令并把每行 stdout/stderr 推到 bus。同时打 step running / ok / fail。"""
    bus.publish(job_id, {"event": "step", "status": "running",
                         "step": step_index, "name": step_name,
                         "cmd": " ".join(cmd[:1]) + (" …" if len(cmd) > 1 else "")})
    started = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=cwd,
            env={**os.environ, **(env or {})},
        )
    except FileNotFoundError as e:
        bus.publish(job_id, {"event": "log", "level": "ERROR", "msg": str(e)})
        bus.publish(job_id, {"event": "step", "status": "fail",
                             "step": step_index, "name": step_name})
        return StepResult(ok=False, code=127)
    assert proc.stdout is not None
    try:
        async with asyncio.timeout(timeout):
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip("\n")
                level = "INFO" if text and not text.startswith(("ERROR", "WARN")) else "INFO"
                bus.publish(job_id, {"event": "log", "level": level, "msg": text})
        rc = await proc.wait()
    except TimeoutError:
        proc.kill()
        await proc.wait()
        bus.publish(job_id, {"event": "log", "level": "ERROR", "msg": f"timeout after {timeout}s"})
        bus.publish(job_id, {"event": "step", "status": "fail", "step": step_index, "name": step_name})
        return StepResult(ok=False, code=-1)

    duration = int((time.monotonic() - started) * 1000)
    if rc == 0:
        bus.publish(job_id, {"event": "step", "status": "ok",
                             "step": step_index, "name": step_name, "duration_ms": duration})
        return StepResult(ok=True, code=rc, duration_ms=duration)
    bus.publish(job_id, {"event": "step", "status": "fail",
                         "step": step_index, "name": step_name, "code": rc, "duration_ms": duration})
    return StepResult(ok=False, code=rc, duration_ms=duration)


def _publish_log(job_id: str, level: str, msg: str) -> None:
    bus.publish(job_id, {"event": "log", "level": level, "msg": msg})


# ============================================================
# 元数据
# ============================================================
_VERSION_DIR_RE = re.compile(r"^v(\d+)-")


def _work_dir() -> Path:
    from .config import get_settings

    return Path(get_settings().work_dir)


def _source_dir() -> Path:
    from .config import get_settings

    return Path(get_settings().source_dir)


def _current_version() -> str:
    p = _work_dir() / "current.txt"
    if not p.exists():
        return ""
    return p.read_text().strip()


def _last_seq() -> int:
    p = _work_dir() / "last_version.txt"
    if p.exists():
        try:
            return int(p.read_text().strip())
        except ValueError:
            pass
    versions_dir = _work_dir() / "versions"
    if not versions_dir.exists():
        return 0
    max_n = 0
    for child in versions_dir.iterdir():
        m = _VERSION_DIR_RE.match(child.name)
        if m:
            max_n = max(max_n, int(m.group(1)))
    return max_n


def _parse_meta(p: Path) -> dict[str, str]:
    if not p.exists():
        return {}
    out: dict[str, str] = {}
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _image_info(repo: str, tag: str) -> dict | None:
    """返回 {ok, id, size_bytes}；镜像不存在/不可查返回 None。同步调用。"""
    try:
        out = subprocess.run(
            ["docker", "image", "inspect", f"{repo}:{tag}",
             "--format", "{{.Id}}|{{.Size}}"],
            capture_output=True, text=True, timeout=15,
        )
        if out.returncode != 0:
            return None
        ident, size = out.stdout.strip().split("|", 1)
        return {"ok": True, "id": ident, "size_bytes": int(size or 0)}
    except Exception:
        return None


def _image_state(version: str) -> str:
    """OK / MISSING — 镜像是否齐全（同步，由调用方放后台线程）。"""
    from .config import get_settings

    settings = get_settings()
    b = _image_info(settings.backend_image, version)
    f = _image_info(settings.frontend_image, version)
    if b and f and b.get("ok") and f.get("ok"):
        return "OK"
    return "MISSING"


def _image_details(version: str) -> list[dict]:
    """每个镜像的 {name, ok, id_short, size_mb, size_bytes} 清单（供抽屉展示）。"""
    from .config import get_settings

    settings = get_settings()
    rows: list[dict] = []
    for repo in (settings.backend_image, settings.frontend_image):
        info = _image_info(repo, version)
        if info:
            _id = (info["id"] or "").replace("sha256:", "")
            rows.append({
                "name": f"{repo}:{version}",
                "ok": True,
                "id_short": _id[:7] if _id else "",
                "size_mb": round(info["size_bytes"] / (1024 * 1024), 1),
                "size_bytes": info["size_bytes"],
            })
        else:
            rows.append({"name": f"{repo}:{version}", "ok": False,
                         "id_short": "", "size_mb": 0, "size_bytes": 0})
    return rows


def _fmt_size(bytes_: float) -> str:
    """字节 → 人类可读（如 3.42 GB）。"""
    mb = bytes_ / (1024 * 1024)
    if mb >= 1024:
        return f"{mb / 1024:.2f} GB"
    return f"{mb:.1f} MB"


# ============================================================
# 公开 API
# ============================================================
def _parse_created(created: str):
    """'YYYY-MM-DD HH:MM:SS' → datetime；失败返回 None。"""
    try:
        return datetime.strptime(created, "%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return None


def _relative_time(ts: datetime | None) -> str:
    """相对时间（中文）：刚刚 / N 分钟前 / N 小时前 / N 天前。"""
    if ts is None:
        return ""
    delta = datetime.now() - ts
    if delta.total_seconds() < 60:
        return "刚刚"
    minutes = int(delta.total_seconds() // 60)
    if minutes < 60:
        return f"{minutes} 分钟前"
    hours = int(delta.total_seconds() // 3600)
    if hours < 24:
        return f"{hours} 小时前"
    days = int(delta.total_seconds() // 86400)
    return f"{days} 天前"


async def list_versions() -> list[dict]:
    versions_dir = _work_dir() / "versions"
    current = _current_version()
    rows: list[dict] = []
    if not versions_dir.exists():
        return rows
    for d in versions_dir.iterdir():
        if not d.is_dir() or not _VERSION_DIR_RE.match(d.name):
            continue
        meta = _parse_meta(d / "meta.txt")
        # images 检查放后台线程，避免阻塞（docker 不可用降级 MISSING）
        images = await asyncio.to_thread(_image_state, d.name)
        rows.append({
            "version": d.name,
            "current": d.name == current,
            "images": images,
            "created": meta.get("created", ""),
            "git": meta.get("git", ""),
            "note": meta.get("note", ""),
            "deployer": meta.get("deployer", ""),
        })
    rows.sort(key=lambda r: int(_VERSION_DIR_RE.match(r["version"]).group(1)), reverse=True)
    return rows


async def _disk_usage() -> dict:
    """work_dir 所在磁盘：总/已用/可用（字节）。"""
    try:
        import shutil as _sh

        usage = _sh.disk_usage(_work_dir())
        return {"total": usage.total, "used": usage.used, "free": usage.free}
    except Exception:
        return {}


async def _images_total_size() -> int:
    """远程 spc-v2-* 全部镜像占用字节。docker 不可用返回 0。"""
    from .config import get_settings

    settings = get_settings()
    try:
        out = subprocess.run(
            ["bash", "-lc",
             f"docker images --format '{{{{.Repository}}}} {{{{.Size}}}}' "
             f"| awk -v a='{settings.backend_image}' -v b='{settings.frontend_image}' "
             f"'$1==a||$1==b{{s+=$2}} END{{print s+0}}'"],
            capture_output=True, text=True, timeout=15,
        )
        if out.returncode == 0:
            return int(float(out.stdout.strip() or 0))
    except Exception:
        pass
    # fallback：逐版本 inspect 求和（不含共享层去重，足够接近）
    try:
        total = 0
        for v in await list_versions():
            for img in _image_details(v["version"]):
                total += img.get("size_bytes", 0)
        return total
    except Exception:
        return 0


async def _deploy_history_last7() -> dict:
    """最近 7 天每日部署次数（0-6 点列 7 根）。"""
    versions = await list_versions()
    counts: dict[str, int] = {}
    today = datetime.now()
    for offset in range(6, -1, -1):
        day = today - __import__("datetime").timedelta(days=offset)
        counts[day.strftime("%m-%d")] = 0
    total = 0
    for v in versions:
        ts = _parse_created(v.get("created", ""))
        if ts and (today - ts).days < 7 and (today - ts).days >= 0:
            key = ts.strftime("%m-%d")
            if key in counts:
                counts[key] += 1
                total += 1
    days = [{"date": d, "count": c, "idle": c == 0} for d, c in counts.items()]
    return {"count": total, "days": days}


async def get_status() -> dict:
    from .config import get_settings

    settings = get_settings()
    versions = await list_versions()
    current = next((v for v in versions if v["current"]), {})
    current_ts = _parse_created(current.get("created", ""))
    disk = await _disk_usage()
    images_bytes = await _images_total_size()
    hist = await _deploy_history_last7()
    return {
        "current": current.get("version", ""),
        "current_created": current.get("created", ""),
        "current_created_rel": _relative_time(current_ts) if current.get("version") else "",
        "current_git": current.get("git", ""),
        "current_note": current.get("note", ""),
        "current_deployer": current.get("deployer", ""),
        "version_count": len(versions),
        "retain_count": settings.retain_count,
        "compose_file": str(_work_dir() / settings.compose_file),
        "git_url": settings.git_url,
        "git_branch": settings.git_branch,
        "image_usage_bytes": images_bytes,
        "image_usage": _fmt_size(images_bytes) if images_bytes else "",
        "disk": disk,
        "deploy_history_last7": hist,
    }


# ============================================================
# 版本详情（抽屉）
# ============================================================
async def get_version_detail(version: str) -> dict | None:
    """单个版本的完整详情：元信息 / 镜像 / 快照 / 活动日志。"""
    versions_dir = _work_dir() / "versions"
    d = versions_dir / version
    if not d.is_dir():
        return None
    meta = _parse_meta(d / "meta.txt")
    versions = await list_versions()
    current = _current_version()

    # 快照文件
    snapshots = []
    for name, desc in (
        (".env", "已加密归档"),
        (settings_compose_name(), "部署期间版本"),
        ("meta.txt", "含 version / created / git / note"),
    ):
        p = d / name
        snapshots.append({"name": name, "desc": desc,
                          "size": p.stat().st_size if p.exists() else None,
                          "exists": p.exists()})

    # 活动日志：从「版本列表」推导（无需额外存储）
    activity: list[dict] = []
    created_ts = _parse_created(meta.get("created", ""))
    order = sorted(versions, key=lambda r: int(_VERSION_DIR_RE.match(r["version"]).group(1)))
    idx = next((i for i, v in enumerate(order) if v["version"] == version), None)
    if idx is not None:
        # 首次部署
        activity.append({
            "ts": meta.get("created", ""),
            "ts_rel": _relative_time(created_ts) if created_ts else "",
            "kind": "deploy",
            "title": "首次部署",
            "detail": f"由 {meta.get('deployer') or '脚本'} 触发 · 健康检查通过"
                      + (f" · {meta.get('note')}" if meta.get("note") else ""),
        })
        # 被谁取代（更高序号版本）
        successors = order[idx + 1:]
        for s in successors:
            s_ts = _parse_created(s.get("created", ""))
            activity.append({
                "ts": s.get("created", ""),
                "ts_rel": _relative_time(s_ts) if s_ts else "",
                "kind": "replaced",
                "title": f"被 {s['version']} 取代",
                "detail": f"{s['version']} 部署为当前运行",
            })
        # 当前运行 / 镜像清理提示
        if version == current:
            activity.append({
                "ts": "",
                "ts_rel": "",
                "kind": "current",
                "title": "当前运行中",
                "detail": "作为系统当前运行版本，不会被自动清理",
            })
        elif not activity or activity[-1]["kind"] != "replaced":
            activity.append({
                "ts": "",
                "ts_rel": "",
                "kind": "retained",
                "title": "已保留",
                "detail": "镜像保留在 versions/ 目录（保留策略以内）",
            })
    # 镜像
    images = _image_details(version)
    return {
        "version": version,
        "current": version == current,
        "images": images,
        "images_state": "OK" if images and all(i["ok"] for i in images) else "MISSING",
        "created": meta.get("created", ""),
        "created_rel": _relative_time(created_ts) if created_ts else "",
        "git": meta.get("git", ""),
        "note": meta.get("note", ""),
        "deployer": meta.get("deployer", ""),
        "snapshots": snapshots,
        "activity": activity,
    }


def settings_compose_name() -> str:
    from .config import get_settings

    return get_settings().compose_file


def _health_check(job_id: str, label: str, url: str, attempts: int = 20, interval: float = 3.0) -> bool:
    """同步内短暂 curl 跑健康检查（curl 是 Linux 主机预装的）。"""
    import urllib.request
    import socket

    _publish_log(job_id, "INFO", f"开始 {label} 健康检查：{url}")
    deadline = attempts * interval
    started = time.monotonic()
    for i in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=3) as resp:
                code = resp.getcode()
                if 200 <= code < 500 and code != 0:
                    _publish_log(job_id, "OK", f"{label} pass (HTTP {code}) · 第 {i}/{attempts} 次")
                    return True
        except (urllib.error.URLError, socket.timeout, ConnectionRefusedError) as e:
            _publish_log(job_id, "INFO", f"{label} 第 {i}/{attempts} 次未就绪: {type(e).__name__}")
        time.sleep(interval)
    _publish_log(job_id, "ERROR", f"{label} 健康检查失败，已重试 {attempts} 次")
    return False


# ============================================================
# 公共：switch / rollback (目标版本已存在) 都走这个流程
# ============================================================
async def _restore_version(job_id: str, target: str, is_rollback: bool = False) -> bool:
    from .config import get_settings

    settings = get_settings()
    work = _work_dir()
    src = work / "versions" / target
    if not src.is_dir():
        _publish_log(job_id, "ERROR", f"目标版本目录不存在: {src}")
        bus.publish(job_id, {"event": "end", "status": "fail", "version": target})
        return False

    bus.publish(job_id, {"event": "phase", "phase": "load_env"})
    target_env = src / ".env"
    if target_env.is_file():
        shutil.copy2(target_env, work / ".env")
        _publish_log(job_id, "OK", f"已恢复 .env 快照 from {target}/.env")
    else:
        _publish_log(job_id, "WARN", f"{target}/.env 不存在，使用当前 .env")

    bus.publish(job_id, {"event": "phase", "phase": "tag_image"})
    rc = await _run_step(job_id, 1, "切换镜像 latest 标签",
                         ["bash", "-lc",
                          f"docker tag {settings.backend_image}:{target} {settings.backend_image}:latest && "
                          f"docker tag {settings.frontend_image}:{target} {settings.frontend_image}:latest"])
    if not rc.ok:
        bus.publish(job_id, {"event": "end", "status": "fail", "version": target})
        return False

    bus.publish(job_id, {"event": "phase", "phase": "compose_up"})
    rc = await _run_step(job_id, 2, "docker compose up -d",
                         ["docker", "compose", "-f", str(work / settings.compose_file), "up", "-d"],
                         cwd=str(work))
    if not rc.ok:
        bus.publish(job_id, {"event": "end", "status": "fail", "version": target})
        return False

    bus.publish(job_id, {"event": "phase", "phase": "health_check"})
    backend_ok = _health_check(job_id, "BACKEND", settings.backend_ping_url)
    frontend_ok = _health_check(job_id, "FRONTEND", settings.frontend_url)
    if not (backend_ok and frontend_ok):
        bus.publish(job_id, {"event": "end", "status": "fail", "version": target})
        return False

    bus.publish(job_id, {"event": "phase", "phase": "write_current"})
    (work / "current.txt").write_text(target + "\n", encoding="utf-8")
    _publish_log(job_id, "OK", f"current.txt <- {target}")

    bus.publish(job_id, {"event": "end", "status": "ok", "version": target})
    return True


async def rollback(target: str) -> tuple[str, AsyncIterator[dict]]:
    """回退到目标版本。

    如果 target 为空字符串 → 回退到 list_versions 里的第二新（最新 = 当前）。
    """
    if not target:
        versions = await list_versions()
        if len(versions) < 2:
            raise ValueError("无可回退的历史版本（只有 1 个或 0 个）")
        target = versions[1]["version"]

    job_id = uuid.uuid4().hex[:16]
    bus.publish(job_id, {"event": "log", "level": "INFO",
                         "msg": f"开始回退到 {target}"})

    queue = await bus.register(job_id)

    async def _stream() -> AsyncIterator[dict]:
        while True:
            ev = await queue.get()
            yield ev
            if ev.get("event") == "end":
                return

    task = asyncio.create_task(_restore_version(job_id, target, is_rollback=True))
    task.add_done_callback(lambda t: t.exception() and bus.publish(
        job_id, {"event": "log", "level": "ERROR",
                 "msg": f"unhandled exception: {t.exception()}"}) and bus.publish(
        job_id, {"event": "end", "status": "fail", "version": target}))
    return job_id, _stream()


async def switch(target: str) -> tuple[str, AsyncIterator[dict]]:
    """切换当前到目标版本（与 rollback 等价但语义明确）。"""
    job_id = uuid.uuid4().hex[:16]
    bus.publish(job_id, {"event": "log", "level": "INFO",
                         "msg": f"开始切换到 {target}"})

    queue = await bus.register(job_id)

    async def _stream() -> AsyncIterator[dict]:
        while True:
            ev = await queue.get()
            yield ev
            if ev.get("event") == "end":
                return

    task = asyncio.create_task(_restore_version(job_id, target, is_rollback=False))
    task.add_done_callback(lambda t: t.exception() and bus.publish(
        job_id, {"event": "log", "level": "ERROR",
                 "msg": f"unhandled exception: {t.exception()}"}) and bus.publish(
        job_id, {"event": "end", "status": "fail", "version": target}))
    return job_id, _stream()


# ============================================================
# 部署新版本
# ============================================================
DEPLOY_NEW_STEPS = [
    "拉取 Git",
    "构建后端",
    "构建前端",
    "打包上传",
    "加载镜像",
    "健康检查",
    "切换并清理",
]


async def deploy_new(note: str, options: dict, operator: str = "") -> tuple[str, AsyncIterator[dict]]:
    from .config import get_settings

    settings = get_settings()
    source = _source_dir()
    work = _work_dir()

    last_n = _last_seq()
    new_seq = last_n + 1
    version = f"v{new_seq}-" + datetime.now().strftime("%Y%m%d-%H%M")
    job_id = uuid.uuid4().hex[:16]
    created = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    safe_note = (note or "").replace("\r", " ").replace("\n", " ").replace("'", "").strip()

    queue = await bus.register(job_id)
    bus.publish(job_id, {"event": "log", "level": "INFO",
                         "msg": f"开始部署新版本 {version} · 备注：{safe_note or '(空)'}"})

    async def _stream() -> AsyncIterator[dict]:
        while True:
            ev = await queue.get()
            yield ev
            if ev.get("event") == "end":
                return

    async def _run() -> None:
        try:
            # ---- STEP 0 拉取 Git ----
            bus.publish(job_id, {"event": "step", "status": "running", "step": 0,
                                 "name": "拉取 Git"})
            source.mkdir(parents=True, exist_ok=True)
            if not (source / ".git").is_dir():
                if not settings.git_url:
                    bus.publish(job_id, {"event": "log", "level": "ERROR",
                                         "msg": "git_url 未配置且 source 目录未初始化，请先 git clone 或设置 DEPLOY_AGENT_GIT_URL"})
                    bus.publish(job_id, {"event": "end", "status": "fail"})
                    return
                rc = await _run_step(
                    job_id, 0, "克隆源码仓库（首次）",
                    ["git", "clone", "--branch", settings.git_branch, settings.git_url, str(source)],
                )
                if not rc.ok:
                    bus.publish(job_id, {"event": "end", "status": "fail"})
                    return
            else:
                rc = await _run_step(
                    job_id, 0, "拉取最新代码",
                    ["git", "-C", str(source), "fetch", "--all", "--prune"],
                )
                if not rc.ok:
                    bus.publish(job_id, {"event": "end", "status": "fail"})
                    return
                rc = await _run_step(
                    job_id, 0, "重置到目标分支最新",
                    ["git", "-C", str(source), "reset", "--hard", f"origin/{settings.git_branch}"],
                )
                if not rc.ok:
                    bus.publish(job_id, {"event": "end", "status": "fail"})
                    return

            # ---- STEP 1 构建后端 ----
            backend_rc = await _run_step(
                job_id, 1, "构建后端镜像",
                ["docker", "build",
                 "-t", f"{settings.backend_image}:latest",
                 "-t", f"{settings.backend_image}:{version}",
                 "-f", "backend/Dockerfile", "."],
                cwd=str(source),
            )
            if not backend_rc.ok:
                bus.publish(job_id, {"event": "end", "status": "fail"})
                return

            # ---- STEP 2 构建前端 ----
            frontend_rc = await _run_step(
                job_id, 2, "构建前端镜像",
                ["docker", "build",
                 "-t", f"{settings.frontend_image}:latest",
                 "-t", f"{settings.frontend_image}:{version}",
                 "-f", "frontend/Dockerfile", "."],
                cwd=str(source),
            )
            if not frontend_rc.ok:
                bus.publish(job_id, {"event": "end", "status": "fail"})
                return

            # ---- STEP 3 打包上传（docker save → bundle） ----
            ver_dir = work / "versions" / version
            ver_dir.mkdir(parents=True, exist_ok=True)

            bundle = work / "bundle.tar"
            rc = await _run_step(
                job_id, 3, "打包镜像（docker save）",
                ["bash", "-lc",
                 f"docker save -o {bundle} {settings.backend_image}:{version} {settings.frontend_image}:{version}"],
                cwd=str(work),
            )
            if not rc.ok:
                bus.publish(job_id, {"event": "end", "status": "fail"})
                return

            # ---- STEP 4 加载镜像（本机 loopback = remote load 语义） ----
            rc = await _run_step(
                job_id, 4, "加载镜像（docker load）",
                ["docker", "load", "-i", str(bundle)],
                cwd=str(work),
            )
            if not rc.ok:
                bus.publish(job_id, {"event": "end", "status": "fail"})
                return
            bundle.unlink(missing_ok=True)

            # .env 必须存在（否则无法启动 compose）
            env_src = source / ".env"
            if env_src.is_file():
                shutil.copy2(env_src, work / ".env")
            elif not (work / ".env").is_file():
                bus.publish(job_id, {"event": "log", "level": "ERROR",
                                     "msg": "work_dir 与 source 都找不到 .env，无法启动 compose"})
                bus.publish(job_id, {"event": "end", "status": "fail"})
                return

            # ---- STEP 5 启动 + 健康检查 ----
            rc = await _run_step(
                job_id, 5, "docker compose up -d",
                ["docker", "compose", "-f", str(work / settings.compose_file), "up", "-d"],
                cwd=str(work),
            )
            if not rc.ok:
                bus.publish(job_id, {"event": "end", "status": "fail"})
                return
            bus.publish(job_id, {"event": "phase", "phase": "health_check"})
            if not _health_check(job_id, "BACKEND", settings.backend_ping_url):
                bus.publish(job_id, {"event": "end", "status": "fail"})
                return
            if not _health_check(job_id, "FRONTEND", settings.frontend_url):
                bus.publish(job_id, {"event": "end", "status": "fail"})
                return

            # ---- STEP 6 切换 current + 清理旧版本 ----
            git_short = ""
            try:
                out = subprocess.run(
                    ["git", "-C", str(source), "rev-parse", "--short", "HEAD"],
                    capture_output=True, text=True, timeout=10,
                )
                if out.returncode == 0:
                    git_short = out.stdout.strip()
            except Exception:
                pass

            (ver_dir / "meta.txt").write_text(
                f"version={version}\ncreated={created}\ngit={git_short}\nnote={safe_note}\n"
                + (f"deployer={operator}\n" if operator else ""),
                encoding="utf-8",
            )
            shutil.copy2(env_src if env_src.is_file() else work / ".env", ver_dir / ".env")
            shutil.copy2(work / settings.compose_file, ver_dir / settings.compose_file)
            _publish_log(job_id, "OK", f"已归档 {version}: meta.txt + .env + {settings.compose_file}")

            (work / "current.txt").write_text(version + "\n", encoding="utf-8")
            (work / "last_version.txt").write_text(str(new_seq) + "\n", encoding="utf-8")

            # 清理：保留最近 retain_count 个（按目录名序号降序），当前不清理
            current = version
            ver_dirs = sorted(
                [p.name for p in (work / "versions").iterdir()
                 if p.is_dir() and _VERSION_DIR_RE.match(p.name)],
                key=lambda n: int(_VERSION_DIR_RE.match(n).group(1)), reverse=True,
            )
            cleaned: list[str] = []
            for old in ver_dirs[settings.retain_count:]:
                if old == current:
                    continue
                await _run_step(
                    job_id, 6, f"清理旧版本 {old}",
                    ["bash", "-lc",
                     f"docker rmi {settings.backend_image}:{old} {settings.frontend_image}:{old} >/dev/null 2>&1; "
                     f"rm -rf {work / 'versions' / old}"],
                )
                cleaned.append(old)
            if cleaned:
                _publish_log(job_id, "INFO", f"已清理旧版本: {', '.join(cleaned)}")
            else:
                _publish_log(job_id, "INFO", "无需清理（未超过保留上限）")

            bus.publish(job_id, {"event": "step", "status": "ok", "step": 6,
                                 "name": "切换并清理"})
            bus.publish(job_id, {"event": "end", "status": "ok", "version": version})
        except Exception as exc:  # pragma: no cover - safety net
            logger.exception("deploy_new failed")
            bus.publish(job_id, {"event": "log", "level": "ERROR",
                                 "msg": f"unhandled exception: {exc!r}"})
            bus.publish(job_id, {"event": "end", "status": "fail"})

    task = asyncio.create_task(_run())
    return job_id, _stream()
