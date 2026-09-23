"""审批中心 - 审批类企微推送公共封装。

审批待办 / 超时提醒都是「给审批人发一张可点击的卡片」，payload 结构与降级策略完全一致，
故收口在此；未配置企微、用户未绑定 wecom_user_id、推送失败都只记日志，不影响业务。
"""

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def send_approval_wecom_textcard(
    db: AsyncSession,
    *,
    user_ids: list[int],
    title: str,
    description: str,
    path: str,
    btn_text: str = "查看详情",
) -> None:
    """给指定用户推送企微 textcard；path 为前端路由（如 /approvals/pending）。"""
    if not user_ids:
        return
    try:
        from app.core.config import get_settings
        settings = get_settings()
        if not (settings.wecom_corp_id and settings.wecom_corp_secret and settings.wecom_agent_id):
            return
        rows = await db.execute(text(
            "SELECT wecom_user_id FROM sys_user WHERE id = ANY(:uids) "
            "AND wecom_user_id IS NOT NULL AND wecom_user_id != ''"
        ), {"uids": list(user_ids)})
        wecom_ids = [r[0] for r in rows if r[0]]
        if not wecom_ids:
            return
        base = settings.frontend_base_url or "http://localhost:3000"
        if base and not base.startswith(("http://", "https://")):
            base = "http://" + base
        from app.services.basicdata.wecom.client import get_wecom_client
        resp = await get_wecom_client().send_app_message({
            "touser": "|".join(wecom_ids),
            "msgtype": "textcard",
            "agentid": int(settings.wecom_agent_id),
            "textcard": {
                "title": title,
                "description": description,
                "url": f"{base}{path}",
                "btntxt": btn_text,
            },
        })
        if resp.get("errcode", 0) != 0:
            logger.warning("[审批提醒][wecom] 推送失败 errcode=%s", resp.get("errcode"))
    except Exception as exc:
        logger.warning("[审批提醒][wecom] 推送异常（已降级）: %s", exc)
