"""通用多级审批引擎 — 从调价单审批逻辑泛化抽取（price_change 暂不接入，保持不动）。

主表约定列: approval_status / approval_level / approval_snapshot / approved_by / approved_at / submitted_at / version
日志表约定列: id / {ref_col} / approval_level / approver / action / comment / operated_at
状态机: draft → pending → approved | rejected | recalled（rejected/recalled 可重新提交，历史日志保留，按 submit 计轮）
审批链来源: approval_config 表（biz_type），提交时冻结快照；节点支持按单据字段条件过滤。
"""

import json
import logging
from datetime import datetime
from typing import Awaitable, Callable, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

NotifyApproversHook = Callable[[dict, int, str], Awaitable[None]]
NotifyApplicantHook = Callable[[dict, str, str], Awaitable[None]]


def check_node_permission(node: dict, approver: str, approver_role: str) -> tuple[bool, str]:
    """校验当前用户是否有权操作该审批节点。优先 approvers（动态解析），其次固定 role；admin 旁路。"""
    if approver_role == "admin":
        return True, ""
    approvers = node.get("approvers")
    if approvers is not None:
        if approvers:
            matched = any(approver == a.get("username") or approver == str(a.get("user_id")) for a in approvers)
            if matched:
                return True, ""
            names = ", ".join(a.get("username", "?") for a in approvers)
            return False, f"当前级别 [{node.get('label')}] 需 {names} 审批，您无权操作"
        return False, f"当前级别 [{node.get('label')}] 审批人解析失败，请联系管理员"
    required_role = node.get("role")
    if required_role and approver_role != required_role:
        return False, f"当前级别 [{node.get('label')}] 需角色 {required_role} 审批，您的角色（{approver_role or '未知'}）无权操作"
    return True, ""


def _cond_match(cond: Optional[dict], fields: dict) -> bool:
    """节点条件匹配。op 支持 in/>=/<=/>/</==/!=，数值比较失败视为不匹配。"""
    if not cond or not cond.get("field"):
        return True
    val = fields.get(cond.get("field"))
    op = cond.get("op", "in")
    target = cond.get("value")
    if op == "in":
        if isinstance(target, str):
            target = [v.strip() for v in target.split(",") if v.strip()]
        return val in (target or [])
    try:
        val_n = float(val)
        t = float(target)
    except (TypeError, ValueError):
        return False
    return {
        ">=": val_n >= t, "<=": val_n <= t, ">": val_n > t,
        "<": val_n < t, "==": val_n == t, "!=": val_n != t,
    }[op]


def _conditions_match(node: Optional[dict], fields: dict) -> bool:
    """节点触发条件：优先 conditions 数组（AND），兼容历史单条件 condition。"""
    if not node:
        return True
    conds = node.get("conditions")
    if conds:
        return all(_cond_match(c, fields) for c in conds)
    return _cond_match(node.get("condition"), fields)


async def resolve_node_approver_user_ids(db: AsyncSession, node: Optional[dict]) -> list[int]:
    """节点审批人的用户 ID 列表：approvers 优先（取 user_id），否则按角色查启用用户。

    非数字 user_id 视为脏数据跳过，避免一条历史配置让待办列表整体 500。
    """
    if not node:
        return []
    approvers = node.get("approvers")
    if approvers is not None:
        result = []
        for a in approvers:
            try:
                result.append(int(a["user_id"]))
            except (TypeError, ValueError, KeyError):
                continue
        return result
    role = node.get("role")
    if not role or db is None:
        return []
    rows = await db.execute(text("""
        SELECT u.id FROM sys_user u
        JOIN sys_role r ON u.role_id = r.id
        WHERE r.role_code = :rc AND u.is_active = TRUE
    """), {"rc": role})
    return [r[0] for r in rows if r[0]]


class ApprovalEngine:
    def __init__(
        self,
        db: AsyncSession,
        *,
        biz_type: str,
        table: str,
        log_table: str,
        ref_col: str,
        condition_fields: Optional[list[str]] = None,
        notify_approvers: Optional[NotifyApproversHook] = None,
        notify_applicant: Optional[NotifyApplicantHook] = None,
    ):
        self.db = db
        self.biz_type = biz_type
        self.table = table
        self.log_table = log_table
        self.ref_col = ref_col
        self.condition_fields = condition_fields or []
        self._notify_approvers = notify_approvers
        self._notify_applicant = notify_applicant

    # ---------- 基础 ----------

    async def load(self, entity_id: int) -> Optional[dict]:
        row = await self.db.execute(text(f"SELECT * FROM {self.table} WHERE id = :eid"), {"eid": entity_id})
        r = row.fetchone()
        if not r:
            return None
        d = dict(r._mapping)
        if isinstance(d.get("approval_snapshot"), str):
            d["approval_snapshot"] = json.loads(d["approval_snapshot"] or "[]")
        return d

    async def add_log(self, entity_id: int, level, action: str, approver: str, comment: str):
        await self.db.execute(
            text(f"INSERT INTO {self.log_table} ({self.ref_col}, approval_level, approver, action, comment) VALUES (:eid, :lv, :ap, :ac, :cm)"),
            {"eid": entity_id, "lv": level, "ap": approver, "ac": action, "cm": comment},
        )

    async def _build_snapshot(self, fields: dict) -> list[dict]:
        """读 approval_config 解析审批链快照（按条件过滤 + 重排 seq），不写库。"""
        r2 = await self.db.execute(
            text("SELECT nodes FROM approval_config WHERE biz_type = :bt AND is_active = TRUE"),
            {"bt": self.biz_type},
        )
        row = r2.fetchone()
        if not row:
            return []
        all_nodes = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or [])
        snapshot = []
        for node in all_nodes:
            if not _conditions_match(node, fields):
                continue
            snap_node = {"seq": node.get("seq"), "label": node.get("label"), "role": node.get("role")}
            if node.get("approvers"):
                snap_node["approvers"] = node["approvers"]
            # 0 = 不提醒，必须与「未配置」区分，故显式判 None
            if node.get("timeout_hours") is not None:
                try:
                    snap_node["timeout_hours"] = int(node["timeout_hours"])
                except (TypeError, ValueError):
                    # 历史脏数据：忽略该配置，按「未配置」处理（列表侧回退默认阈值）
                    logger.warning("审批链节点 timeout_hours 非法 biz=%s value=%r", self.biz_type, node.get("timeout_hours"))
            snapshot.append(snap_node)
        # 条件过滤会移除中间节点导致 seq 断档，引擎按 seq+1 找下一节点，必须重排为连续 1..n
        for i, node in enumerate(snapshot, 1):
            node["seq"] = i
        return snapshot

    async def get_node_approver_user_ids(self, node: dict) -> list[int]:
        return await resolve_node_approver_user_ids(self.db, node)

    # ---------- 节点审批人解析 ----------

    async def get_node_approver_usernames(self, node: dict) -> set[str]:
        approvers = node.get("approvers")
        if approvers is not None:
            result = set()
            for a in approvers:
                if a.get("username"):
                    result.add(a["username"])
                if a.get("user_id"):
                    result.add(str(a["user_id"]))
            return result
        role = node.get("role")
        if not role:
            return set()
        rows = await self.db.execute(text("""
            SELECT u.username, u.id FROM sys_user u
            JOIN sys_role r ON u.role_id = r.id
            WHERE r.role_code = :rc AND u.is_active = TRUE
        """), {"rc": role})
        result = set()
        for r in rows:
            if r[0]:
                result.add(r[0])
            result.add(str(r[1]))
        return result

    async def _earlier_approvers(self, entity_id: int, before_level: int) -> set[str]:
        """本轮次内、before_level 之前已审过的人（approve/auto_skip），username+user_id 都算。"""
        rows = await self.db.execute(text(f"""
            SELECT DISTINCT l.approver, u.id::text
            FROM {self.log_table} l
            LEFT JOIN sys_user u ON u.username = l.approver
            WHERE l.{self.ref_col} = :eid AND l.approval_level < :lv AND l.action IN ('approve', 'auto_skip')
              AND l.id >= (SELECT COALESCE(MAX(s.id), 0) FROM {self.log_table} s
                           WHERE s.{self.ref_col} = :eid AND s.action = 'submit')
        """), {"eid": entity_id, "lv": before_level})
        result = set()
        for r in rows:
            if r[0]:
                result.add(str(r[0]))
            if r[1]:
                result.add(str(r[1]))
        return result

    def is_current_node_approver(self, rec: dict, approver: str, approver_role: str) -> bool:
        """待我审批过滤：非 admin 只看当前级别归自己审的单子。审批链异常的单子不展示。"""
        snap = rec.get("approval_snapshot") or []
        node = next((n for n in snap if n.get("seq") == rec.get("approval_level", 1)), None)
        if not node:
            return False
        ok, _ = check_node_permission(node, approver, approver_role)
        return ok

    # ---------- 状态机 ----------

    async def submit(self, entity_id: int, applicant: str) -> Optional[dict]:
        rec = await self.load(entity_id)
        if not rec or rec.get("approval_status") not in ("draft", "rejected", "recalled"):
            return None
        fields = {f: rec.get(f) for f in self.condition_fields}
        # 链为空（未配置 / 已停用 / 条件全不满足）时拒绝提交，避免产生无人可见的挂单
        snapshot = await self._build_snapshot(fields)
        if not snapshot:
            raise ValueError("审批链未配置或已停用，无法提交")
        await self.db.execute(text(f"""
            UPDATE {self.table}
            SET approval_status = 'pending', approval_level = 1, submitted_at = :now, version = version + 1
            WHERE id = :eid AND approval_status IN ('draft', 'rejected', 'recalled')
        """), {"eid": entity_id, "now": datetime.now()})
        await self.add_log(entity_id, None, "submit", applicant, "提交审批")
        await self.db.execute(
            text(f"UPDATE {self.table} SET approval_snapshot = :snap WHERE id = :eid"),
            {"snap": json.dumps(snapshot), "eid": entity_id},
        )
        fresh = await self.load(entity_id)
        await self._notify_level(fresh, 1, "待您审批")
        return fresh

    async def approve(self, entity_id: int, approver: str, comment: str = "", *,
                      approver_role: str = "", expected_version: Optional[int] = None) -> dict:
        rec = await self.load(entity_id)
        if not rec or rec.get("approval_status") != "pending":
            return {"success": False, "message": "状态不正确"}
        current_version = rec.get("version", 1)
        if expected_version is not None and int(expected_version) != int(current_version):
            return {"success": False, "message": "数据已被他人更新，请刷新后重试"}

        snap = rec.get("approval_snapshot") or []
        current_level = rec.get("approval_level", 1)
        if not snap:
            return {"success": False, "message": "审批链未配置，请联系管理员在审批配置中设置审批节点"}
        current_node = next((n for n in snap if n.get("seq") == current_level), None)
        if not current_node:
            return {"success": False, "message": f"当前审批级别 {current_level} 在审批链中不存在"}
        ok, msg = check_node_permission(current_node, approver, approver_role)
        if not ok:
            return {"success": False, "message": msg}

        await self.add_log(entity_id, current_level, "approve", approver, comment)

        # 推进：下一节点审批人含当前审批人，或其全部审批人已在更早节点审过 → 自动跳过（循环处理连续跳过）
        next_level = current_level + 1
        skipped = []
        while True:
            next_node = next((n for n in snap if n.get("seq") == next_level), None)
            if not next_node:
                result = await self.db.execute(text(f"""
                    UPDATE {self.table}
                    SET approval_status = 'approved', approved_by = :ap, approved_at = :now, version = version + 1
                    WHERE id = :eid AND version = :v
                """), {"ap": approver, "now": datetime.now(), "eid": entity_id, "v": current_version})
                if result.rowcount == 0:
                    return {"success": False, "message": "数据已被他人更新，请刷新后重试"}
                fresh = await self.load(entity_id)
                if self._notify_applicant:
                    await self._notify_applicant(fresh, "[索赔单] 审批通过", f"您的索赔单 {rec.get('claim_no', '')} 已全部审批通过，已归档。")
                return {"success": True, "finished": True, "skipped": skipped}
            next_approvers = await self.get_node_approver_usernames(next_node)
            skip = approver in next_approvers
            if not skip and next_approvers:
                earlier = await self._earlier_approvers(entity_id, next_level) | {approver}
                if next_approvers.issubset(earlier):
                    skip = True
            if skip:
                await self.add_log(entity_id, next_level, "auto_skip", approver, "自动通过（审批人已在更早节点审过，避免重复审批）")
                skipped.append(next_level)
                next_level += 1
                continue
            break

        result = await self.db.execute(
            text(f"UPDATE {self.table} SET approval_level = :lv, version = version + 1 WHERE id = :eid AND version = :v"),
            {"lv": next_level, "eid": entity_id, "v": current_version},
        )
        if result.rowcount == 0:
            return {"success": False, "message": "数据已被他人更新，请刷新后重试"}
        fresh = await self.load(entity_id)
        await self._notify_level(fresh, next_level, "待您审批")
        return {"success": True, "finished": False, "skipped": skipped}

    async def reject(self, entity_id: int, approver: str, comment: str = "", *,
                     approver_role: str = "", expected_version: Optional[int] = None) -> dict:
        rec = await self.load(entity_id)
        if not rec or rec.get("approval_status") != "pending":
            return {"success": False, "message": "状态不正确"}
        current_version = rec.get("version", 1)
        if expected_version is not None and int(expected_version) != int(current_version):
            return {"success": False, "message": "数据已被他人更新，请刷新后重试"}
        snap = rec.get("approval_snapshot") or []
        current_level = rec.get("approval_level", 1)
        current_node = next((n for n in snap if n.get("seq") == current_level), None) if snap else None
        if current_node:
            ok, msg = check_node_permission(current_node, approver, approver_role)
            if not ok:
                return {"success": False, "message": msg}
        await self.add_log(entity_id, current_level, "reject", approver, comment)
        result = await self.db.execute(
            text(f"UPDATE {self.table} SET approval_status = 'rejected', version = version + 1 WHERE id = :eid AND version = :v"),
            {"eid": entity_id, "v": current_version},
        )
        if result.rowcount == 0:
            return {"success": False, "message": "数据已被他人更新，请刷新后重试"}
        fresh = await self.load(entity_id)
        if self._notify_applicant:
            await self._notify_applicant(fresh, "[索赔单] 审批被驳回",
                                         f"您的索赔单 {rec.get('claim_no', '')} 被 {approver} 驳回。意见：{comment or '无'}。请修改后重新提交。")
        return {"success": True}

    async def recall(self, entity_id: int, applicant: str = "") -> bool:
        rec = await self.load(entity_id)
        if not rec or rec.get("approval_status") != "pending":
            return False
        await self.db.execute(
            text(f"UPDATE {self.table} SET approval_status = 'recalled', version = version + 1 WHERE id = :eid"),
            {"eid": entity_id},
        )
        await self.add_log(entity_id, rec.get("approval_level"), "recall", applicant or rec.get("applicant", ""), "申请人撤回")
        return True

    async def revoke(self, entity_id: int, revoker: str, *, revoker_role: str = "") -> dict:
        """反审核：审批人撤回自己最近一次审批，回退一级；连续 auto_skip 一并撤销。"""
        rec = await self.load(entity_id)
        if not rec:
            return {"success": False, "message": "单据不存在"}
        if rec.get("approval_status") != "pending":
            return {"success": False, "message": "仅审批中状态可撤回审批"}
        current_level = rec.get("approval_level", 1)
        if current_level <= 1:
            return {"success": False, "message": "当前在第1级，没有可撤回的审批"}
        log_row = await self.db.execute(text(f"""
            SELECT id, approval_level, approver, action FROM {self.log_table}
            WHERE {self.ref_col} = :eid AND action IN ('approve', 'auto_skip')
              AND id >= (SELECT COALESCE(MAX(s.id), 0) FROM {self.log_table} s
                         WHERE s.{self.ref_col} = :eid AND s.action = 'submit')
            ORDER BY id DESC LIMIT 1
        """), {"eid": entity_id})
        last_log = log_row.fetchone()
        if not last_log:
            return {"success": False, "message": "没有可撤回的审批记录"}
        log_id, log_level, log_approver, log_action = last_log
        if revoker_role != "admin" and log_approver != revoker:
            return {"success": False, "message": "只能撤回自己刚做出的审批"}
        if log_level < current_level - 1:
            return {"success": False, "message": "审批已被后续操作覆盖，无法撤回"}
        await self.db.execute(text(f"""
            UPDATE {self.log_table}
            SET action = 'revoked', comment = CONCAT(COALESCE(comment, ''), ' | 已被撤回')
            WHERE id = :lid
        """), {"lid": log_id})
        rollback_level = max(log_level, 1)
        result = await self.db.execute(text(f"""
            UPDATE {self.table} SET approval_level = :lv, version = version + 1
            WHERE id = :eid AND approval_status = 'pending'
        """), {"lv": rollback_level, "eid": entity_id})
        if result.rowcount == 0:
            return {"success": False, "message": "状态已变化，请刷新后重试"}
        fresh = await self.load(entity_id)
        if self._notify_applicant:
            await self._notify_applicant(fresh, "[索赔单] 审批被撤回",
                                         f"您的索赔单 {rec.get('claim_no', '')} 被 {revoker} 撤回了审批，已回退到第{rollback_level}级重新审批。")
        await self._notify_level(fresh, rollback_level, "重新待您审批")
        return {"success": True, "level": rollback_level}

    # ---------- 通知 ----------

    async def _notify_level(self, rec: dict, level: int, title_prefix: str):
        if not self._notify_approvers or not rec:
            return
        try:
            await self._notify_approvers(rec, level, title_prefix)
        except Exception as e:
            logger.warning("审批通知 hook 失败 biz=%s id=%s level=%s: %s", self.biz_type, rec.get("id"), level, e)
