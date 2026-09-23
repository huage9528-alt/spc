"""供应商索赔通知单 - 业务逻辑（raw SQL + 公共审批引擎）"""

import json
import logging
from datetime import datetime, date
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.common.approval_engine import ApprovalEngine
from app.services.common.approval_notify import send_approval_wecom_textcard

logger = logging.getLogger(__name__)

CLAIM_REASONS = {"field_customer_claim", "supply_performance"}
CLAIM_ITEMS = {
    "replacement", "packing_fee", "transporting_fee", "man_hour_fee",
    "additional_fee", "punishment", "downgrade_use", "direct_loss",
}
RETURN_REQUIREMENTS = {"no_return", "return_supplier_fee"}


def _to_date(value) -> Optional[date]:
    """把前端传来的日期统一转成 date：asyncpg 对 DATE 列只接受 date 对象，字符串会直接报 DataError。"""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise ValueError(f"日期格式不正确：{value}（应为 YYYY-MM-DD）")


class SupplierClaimService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.engine = ApprovalEngine(
            db,
            biz_type="supplier_claim",
            table="supplier_claim",
            log_table="supplier_claim_approval_log",
            ref_col="claim_id",
            condition_fields=["claim_amount"],
            notify_approvers=self._notify_approvers_of_level,
            notify_applicant=self._notify_applicant_hook,
        )

    # ---------- 查询 ----------

    async def list_claims(self, *, page=1, page_size=20, keyword=None, status=None,
                          date_start=None, date_end=None, applicant=None, supplier=None):
        conditions = ["1=1"]
        params: dict = {}
        if keyword:
            conditions.append("(c.claim_no ILIKE :kw OR c.supplier_name ILIKE :kw)")
            params["kw"] = f"%{keyword}%"
        if status:
            conditions.append("c.approval_status = :st")
            params["st"] = status
        if date_start:
            conditions.append("c.claim_date >= :ds")
            params["ds"] = _to_date(date_start)
        if date_end:
            conditions.append("c.claim_date <= :de")
            params["de"] = _to_date(date_end)
        if applicant:
            conditions.append("c.applicant = :ap")
            params["ap"] = applicant
        if supplier:
            conditions.append("c.supplier_name ILIKE :sup")
            params["sup"] = f"%{supplier}%"
        where = " AND ".join(conditions)
        total = (await self.db.execute(
            text(f"SELECT COUNT(*) FROM supplier_claim c WHERE {where}"), params
        )).scalar() or 0
        rows = await self.db.execute(text(f"""
            SELECT c.*, COALESCE(u.display_name, c.applicant) AS applicant_display
            FROM supplier_claim c
            LEFT JOIN sys_user u ON u.username = c.applicant OR CAST(u.id AS VARCHAR) = c.applicant
            WHERE {where}
            ORDER BY c.created_at DESC LIMIT :lim OFFSET :off
        """), {**params, "lim": page_size, "off": (page - 1) * page_size})
        items = [self._serialize(dict(r._mapping)) for r in rows]
        return items, total

    async def get_claim(self, claim_id: int) -> Optional[dict]:
        row = await self.db.execute(text("""
            SELECT c.*, COALESCE(u.display_name, c.applicant) AS applicant_display
            FROM supplier_claim c
            LEFT JOIN sys_user u ON u.username = c.applicant OR CAST(u.id AS VARCHAR) = c.applicant
            WHERE c.id = :eid
        """), {"eid": claim_id})
        r = row.fetchone()
        if not r:
            return None
        d = dict(r._mapping)
        if isinstance(d.get("approval_snapshot"), str):
            d["approval_snapshot"] = json.loads(d["approval_snapshot"] or "[]")
        if isinstance(d.get("claim_items"), str):
            d["claim_items"] = json.loads(d["claim_items"] or "[]")
        if isinstance(d.get("attachments"), str):
            d["attachments"] = json.loads(d["attachments"] or "[]")
        logs_row = await self.db.execute(
            text("SELECT * FROM supplier_claim_approval_log WHERE claim_id = :eid ORDER BY id"),
            {"eid": claim_id},
        )
        logs = [dict(x._mapping) for x in logs_row]
        current_round = 0
        for lg in logs:
            if lg.get("action") == "submit":
                current_round += 1
            lg["round"] = current_round
        d["approval_logs"] = logs
        d["approval_round"] = current_round
        return self._serialize(d)

    def _serialize(self, d: dict) -> dict:
        if isinstance(d.get("claim_date"), date):
            d["claim_date"] = d["claim_date"].isoformat()
        for key in ("created_at", "updated_at", "submitted_at", "approved_at"):
            if isinstance(d.get(key), datetime):
                d[key] = d[key].isoformat()
        if isinstance(d.get("claim_items"), str):
            d["claim_items"] = json.loads(d["claim_items"] or "[]")
        if isinstance(d.get("attachments"), str):
            d["attachments"] = json.loads(d["attachments"] or "[]")
        if isinstance(d.get("approval_snapshot"), str):
            d["approval_snapshot"] = json.loads(d["approval_snapshot"] or "[]")
        if d.get("claim_amount") is not None:
            d["claim_amount"] = float(d["claim_amount"])
        return d

    # ---------- 编号 ----------

    async def _gen_claim_no(self) -> str:
        today = datetime.now().strftime("%Y%m%d")
        row = await self.db.execute(
            text("SELECT MAX(claim_no) FROM supplier_claim WHERE claim_no LIKE :pfx"),
            {"pfx": f"SC{today}%"},
        )
        max_no = row.scalar() or f"SC{today}-000"
        seq = int(max_no.split("-")[-1]) + 1
        return f"SC{today}-{seq:03d}"

    # ---------- CRUD ----------

    def _validate(self, data: dict) -> Optional[str]:
        if not (data.get("supplier_name") or "").strip():
            return "供应商不能为空"
        if data.get("claim_reason") not in CLAIM_REASONS:
            return "索赔原因不合法"
        items = data.get("claim_items") or []
        if not isinstance(items, list) or any(i not in CLAIM_ITEMS for i in items):
            return "索赔细项不合法"
        if data.get("return_requirement") not in RETURN_REQUIREMENTS:
            return "退回要求不合法"
        if data.get("claim_amount") is None or float(data["claim_amount"]) < 0:
            return "索赔金额必须为非负数字"
        return None

    @staticmethod
    def _params(data: dict) -> dict:
        return {
            "sid": data.get("supplier_id"),
            "sc": (data.get("supplier_code") or "").strip(),
            "sn": (data.get("supplier_name") or "").strip(),
            "cr": data.get("claim_reason"),
            "ci": json.dumps(data.get("claim_items") or []),
            "amt": data.get("claim_amount"),
            "cm": data.get("claim_method"),
            "ce": data.get("calc_explanation"),
            "rr": data.get("return_requirement"),
            "cd": _to_date(data.get("claim_date")) or date.today(),
            "rm": data.get("remarks"),
            "att": json.dumps(data.get("attachments") or []),
        }

    async def create_claim(self, data: dict, *, applicant: str = "", submit: bool = False) -> dict:
        """先落库为 draft，提交动作统一走 engine.submit（保证快照/日志/通知一致）。"""
        err = self._validate(data)
        if err:
            raise ValueError(err)
        claim_no = await self._gen_claim_no()
        p = self._params(data)
        await self.db.execute(text("""
            INSERT INTO supplier_claim
                (claim_no, supplier_id, supplier_code, supplier_name, claim_reason, claim_items,
                 claim_amount, claim_method, calc_explanation, return_requirement, claim_date,
                 remarks, attachments, approval_status, approval_level, version, applicant)
            VALUES (:no, :sid, :sc, :sn, :cr, :ci, :amt, :cm, :ce, :rr, :cd, :rm, :att, 'draft', 1, 1, :ap)
        """), {**p, "no": claim_no, "ap": applicant})
        claim_id = (await self.db.execute(
            text("SELECT id FROM supplier_claim WHERE claim_no = :no"), {"no": claim_no}
        )).scalar()
        if submit:
            await self._do_submit(claim_id, applicant)
        return await self.get_claim(claim_id)

    async def update_claim(self, claim_id: int, data: dict) -> Optional[dict]:
        rec = await self.get_claim(claim_id)
        if not rec or rec.get("approval_status") not in ("draft", "rejected", "recalled"):
            return None
        err = self._validate(data)
        if err:
            raise ValueError(err)
        p = self._params(data)
        await self.db.execute(text("""
            UPDATE supplier_claim SET
                supplier_id=:sid, supplier_code=:sc, supplier_name=:sn, claim_reason=:cr,
                claim_items=:ci, claim_amount=:amt, claim_method=:cm, calc_explanation=:ce,
                return_requirement=:rr, claim_date=:cd, remarks=:rm, attachments=:att, updated_at=NOW()
            WHERE id=:eid
        """), {**p, "eid": claim_id})
        return await self.get_claim(claim_id)

    async def delete_claim(self, claim_id: int, *, can_archive_delete: bool = False) -> dict:
        rec = await self.get_claim(claim_id)
        if not rec:
            return {"success": False, "message": "索赔单不存在"}
        status = rec.get("approval_status")
        if status == "pending":
            return {"success": False, "message": "审批中的索赔单不可删除，请先撤回"}
        if status == "approved" and not can_archive_delete:
            return {"success": False, "message": "已归档的索赔单需「索赔单归档删除」权限"}
        # 解绑附件引用计数（ref_count 归零的孤儿文件由清理任务统一处理）
        try:
            from app.services.common.file_service import FileService
            keys = [a.get("key") for a in (rec.get("attachments") or []) if isinstance(a, dict) and a.get("key")]
            if keys:
                await FileService(self.db).detach(keys)
        except Exception as e:
            logger.warning("索赔单附件引用计数解绑失败(claim_id=%s): %s", claim_id, e)
        await self.db.execute(text("DELETE FROM supplier_claim_approval_log WHERE claim_id = :eid"), {"eid": claim_id})
        await self.db.execute(text("DELETE FROM supplier_claim WHERE id = :eid"), {"eid": claim_id})
        return {"success": True, "message": "已删除"}

    # ---------- 审批（委托引擎） ----------

    async def _do_submit(self, claim_id: int, applicant: str):
        rec = await self.get_claim(claim_id)
        if not rec or rec.get("approval_status") not in ("draft", "rejected", "recalled"):
            raise ValueError("仅草稿/驳回/撤回状态可提交")
        if not (rec.get("supplier_name") or "").strip():
            raise ValueError("供应商不能为空，无法提交")
        fresh = await self.engine.submit(claim_id, applicant)  # 链未配置/已停用会抛 ValueError，原样上抛
        if not fresh:
            raise ValueError("提交失败，请刷新后重试")
        # 绑定附件引用计数，避免孤儿清理误删已被单据引用的文件
        try:
            from app.services.common.file_service import FileService
            keys = [a.get("key") for a in (rec.get("attachments") or []) if isinstance(a, dict) and a.get("key")]
            if keys:
                await FileService(self.db).attach(keys, "supplier-claim", f"supplier_claim:{claim_id}")
        except Exception as e:
            logger.warning("索赔单附件引用计数绑定失败(claim_id=%s): %s", claim_id, e)

    async def submit_claim(self, claim_id: int, applicant: str, *, caller_role: str = "") -> Optional[dict]:
        rec = await self.get_claim(claim_id)
        if not rec or rec.get("approval_status") not in ("draft", "rejected", "recalled"):
            return None
        if caller_role != "admin" and rec.get("applicant") != applicant:
            raise ValueError("仅发起人可提交该索赔单")
        await self._do_submit(claim_id, applicant)
        return await self.get_claim(claim_id)

    async def approve(self, claim_id: int, approver: str, comment: str = "", *,
                      approver_role: str = "", expected_version: Optional[int] = None) -> dict:
        return await self.engine.approve(claim_id, approver, comment,
                                         approver_role=approver_role, expected_version=expected_version)

    async def reject(self, claim_id: int, approver: str, comment: str = "", *,
                     approver_role: str = "", expected_version: Optional[int] = None) -> dict:
        return await self.engine.reject(claim_id, approver, comment,
                                        approver_role=approver_role, expected_version=expected_version)

    async def recall(self, claim_id: int, applicant: str = "", *, caller_role: str = "") -> bool:
        rec = await self.get_claim(claim_id)
        if not rec:
            return False
        if caller_role != "admin" and rec.get("applicant") != applicant:
            raise ValueError("仅发起人可撤回该索赔单")
        return await self.engine.recall(claim_id, applicant)

    async def revoke(self, claim_id: int, revoker: str, *, revoker_role: str = "") -> dict:
        return await self.engine.revoke(claim_id, revoker, revoker_role=revoker_role)

    async def pending_approvals(self, *, approver_username: str = "", approver_role: str = "") -> list[dict]:
        rows = await self.db.execute(text("""
            SELECT * FROM supplier_claim WHERE approval_status = 'pending' ORDER BY submitted_at DESC NULLS LAST
        """))
        items = []
        for r in rows:
            d = self._serialize(dict(r._mapping))
            if approver_role != "admin" and not self.engine.is_current_node_approver(d, approver_username, approver_role):
                continue
            items.append(d)
        return items

    async def approved_by_me(self, approver: str) -> list[dict]:
        """我已审批：我最近一次 approve/reject 的单据（被反审核的审批已置 revoked，不计入）。"""
        rows = await self.db.execute(text("""
            SELECT c.*, l.action AS my_action, l.comment AS my_comment, l.operated_at AS acted_at
            FROM supplier_claim c
            JOIN LATERAL (
                SELECT action, comment, operated_at
                FROM supplier_claim_approval_log
                WHERE claim_id = c.id AND approver = :ap AND action IN ('approve', 'reject')
                ORDER BY id DESC LIMIT 1
            ) l ON TRUE
            ORDER BY l.operated_at DESC NULLS LAST
        """), {"ap": approver})
        return [self._serialize(dict(r._mapping)) for r in rows]

    async def submitted_by_me(self, applicant: str) -> list[dict]:
        rows = await self.db.execute(text("""
            SELECT * FROM supplier_claim WHERE applicant = :ap ORDER BY submitted_at DESC NULLS LAST
        """), {"ap": applicant})
        return [self._serialize(dict(r._mapping)) for r in rows]

    # ---------- 通知（引擎 hook） ----------

    async def _notify_approvers_of_level(self, rec: dict, level: int, title_prefix: str):
        snap = rec.get("approval_snapshot") or []
        node = next((n for n in snap if n.get("seq") == level), None)
        if not node:
            return
        target_uids = await self.engine.get_node_approver_user_ids(node)
        if not target_uids:
            return
        label = node.get("label", f"L{level}")
        title = f"[索赔单] {title_prefix} - {label}"
        content = (f"索赔单 {rec.get('claim_no', '')}（供应商：{rec.get('supplier_name', '')}，"
                   f"申请人：{rec.get('applicant', '')}，金额：{rec.get('claim_amount', 0)} 元）需要您{label}。")
        try:
            applicant_id = int(rec.get("applicant"))
        except (TypeError, ValueError):
            applicant_id = None
        for uid in target_uids:
            await self._notify_user(uid, title, content, ref_id=rec["id"],
                                    sender_name=rec.get("applicant"), sender_id=applicant_id)
        await self._notify_wecom(target_uids, rec, label)

    async def _notify_user(self, user_id: int, title: str, content: str, *,
                           ref_id: int = None, sender_name: str = None, sender_id: int = None):
        try:
            await self.db.execute(text("""
                INSERT INTO notification (user_id, type, title, content, ref_type, ref_id, sender_id, sender_name, priority, is_read, created_at)
                VALUES (:uid, 'supplier_claim', :title, :content, 'supplier_claim', :rid, :sid, :sender, 'high', FALSE, NOW())
            """), {"uid": user_id, "title": title, "content": content, "rid": ref_id,
                   "sid": sender_id, "sender": sender_name})
        except Exception as e:
            logger.warning(f"索赔单通知推送失败 user_id={user_id}: {e}")

    async def _notify_wecom(self, user_ids: list, rec: dict, label: str):
        """企微 textcard 推送，未配置/失败时降级，不影响审批流程。"""
        if not user_ids:
            return
        await send_approval_wecom_textcard(
            self.db,
            user_ids=[int(uid) for uid in user_ids],
            title=f"索赔单待审批 - {label}",
            description=(f"索赔单 {rec.get('claim_no', '')}\n供应商：{rec.get('supplier_name', '')}\n"
                         f"申请人：{rec.get('applicant', '')}\n审批节点：{label}\n点击查看详情并处理审批。"),
            path=f"/quality/supplier-claims/{rec['id']}",
        )

    async def _notify_applicant_hook(self, rec: dict, title: str, content: str):
        applicant = rec.get("applicant")
        if not applicant:
            return
        row = await self.db.execute(
            text("SELECT id FROM sys_user WHERE id::text = :a OR username = :a LIMIT 1"),
            {"a": str(applicant)},
        )
        r = row.fetchone()
        if r:
            await self._notify_user(r[0], title, content, ref_id=rec["id"])
