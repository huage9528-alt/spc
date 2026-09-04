"""调价单模块 - 业务逻辑（纯 raw SQL，避免 async ORM Greenlet 问题）"""

import json
import logging
import asyncio
from datetime import datetime, date
from typing import Any, Optional

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# 进程内规则阈值缓存（规则变更时由 clear_rule_cache 主动清空）
_rule_cache: dict[str, str] = {}


def _get_settings():
    from app.core.config import get_settings
    return get_settings()


def _get_wecom_client():
    from app.services.basicdata.wecom.client import get_wecom_client
    return get_wecom_client()


def clear_rule_cache() -> None:
    """清除规则阈值缓存（配置更新后调用）。"""
    _rule_cache.clear()


def _rule_float(rules: dict, key: str, default: float) -> float:
    """从规则字典读取 float，失败回落默认值。"""
    try:
        return float(rules.get(key, default))
    except (TypeError, ValueError):
        return default


class PriceChangeService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_price_changes(self, *, page=1, page_size=20, keyword=None, status=None, date_start=None, date_end=None, applicant=None):
        conditions = ["1=1"]
        params = {}
        if keyword:
            conditions.append("(pc.change_no ILIKE :kw OR pc.supplier_name ILIKE :kw OR pc.title ILIKE :kw)")
            params["kw"] = f"%{keyword}%"
        if status:
            conditions.append("pc.approval_status = :st")
            params["st"] = status
        if date_start:
            conditions.append("pc.change_date >= :ds")
            params["ds"] = date_start
        if date_end:
            conditions.append("pc.change_date <= :de")
            params["de"] = date_end
        if applicant:
            conditions.append("pc.applicant = :ap")
            params["ap"] = applicant

        where = " AND ".join(conditions)
        total_row = await self.db.execute(text(f"SELECT COUNT(*) FROM purchase_price_change pc WHERE {where}"), params)
        total = total_row.scalar() or 0

        offset = (page - 1) * page_size
        rows = await self.db.execute(
            text(f"""
                SELECT pc.*, COALESCE(u.display_name, pc.applicant) AS applicant_display
                FROM purchase_price_change pc
                LEFT JOIN sys_user u ON u.username = pc.applicant OR CAST(u.id AS VARCHAR) = pc.applicant
                WHERE {where}
                ORDER BY pc.created_at DESC LIMIT :lim OFFSET :off
            """),
            {**params, "lim": page_size, "off": offset},
        )
        items = []
        for r in rows:
            d = dict(r._mapping)
            if isinstance(d.get("change_date"), date):
                d["change_date"] = d["change_date"].isoformat()
            if isinstance(d.get("created_at"), datetime):
                d["created_at"] = d["created_at"].isoformat()
            if isinstance(d.get("updated_at"), datetime):
                d["updated_at"] = d["updated_at"].isoformat()
            if isinstance(d.get("attachments"), str):
                d["attachments"] = json.loads(d["attachments"] or "[]")
            items.append(d)
        return items, total

    async def get_price_change(self, change_id: int) -> Optional[dict]:
        row = await self.db.execute(text("""
            SELECT pc.*, COALESCE(u.display_name, pc.applicant) AS applicant_display
            FROM purchase_price_change pc
            LEFT JOIN sys_user u ON u.username = pc.applicant OR CAST(u.id AS VARCHAR) = pc.applicant
            WHERE pc.id = :id
        """), {"id": change_id})
        r = row.fetchone()
        if not r:
            return None
        record = dict(r._mapping)
        if isinstance(record.get("change_date"), date):
            record["change_date"] = record["change_date"].isoformat()
        for ts_key in ("created_at", "updated_at", "submitted_at", "approved_at"):
            if isinstance(record.get(ts_key), datetime):
                record[ts_key] = record[ts_key].isoformat()
        if isinstance(record.get("attachments"), str):
            record["attachments"] = json.loads(record["attachments"] or "[]")
        if isinstance(record.get("approval_snapshot"), str):
            record["approval_snapshot"] = json.loads(record["approval_snapshot"] or "[]")
        if isinstance(record.get("self_check_result"), str):
            record["self_check_result"] = json.loads(record["self_check_result"] or "{}")
        if isinstance(record.get("self_check_evidence"), str):
            record["self_check_evidence"] = json.loads(record["self_check_evidence"] or "[]")
        # 子表
        items_row = await self.db.execute(text("SELECT * FROM purchase_price_change_item WHERE change_id = :cid ORDER BY seq"), {"cid": change_id})
        record["items"] = [dict(r._mapping) for r in items_row]
        # 审批日志：按 id 升序取，每出现一次 action='submit' 即为新一轮的起点，
        # 为每条日志标注所属轮次（round），供前端按轮次分组展示。
        logs_row = await self.db.execute(text("SELECT * FROM purchase_price_change_approval_log WHERE change_id = :cid ORDER BY id"), {"cid": change_id})
        log_list = [dict(r._mapping) for r in logs_row]
        _round = 0
        for lg in log_list:
            if lg.get("action") == "submit":
                _round += 1
            lg["round"] = _round
        record["approval_logs"] = log_list
        # 当前轮次 = 累计提交次数（未提交过的草稿为 0）
        record["approval_round"] = _round
        # AI 分析
        ai_row = await self.db.execute(text("SELECT * FROM purchase_price_change_ai_analysis WHERE change_id = :cid ORDER BY id DESC LIMIT 1"), {"cid": change_id})
        ai = ai_row.fetchone()
        if ai:
            ai_analysis = dict(ai._mapping)
            for ts_key in ("market_fetched_at", "ai_analyzed_at", "created_at"):
                if isinstance(ai_analysis.get(ts_key), datetime):
                    ai_analysis[ts_key] = ai_analysis[ts_key].isoformat()
            record["ai_analysis"] = ai_analysis
        else:
            record["ai_analysis"] = None
        return record

    async def create_price_change(self, data: dict, items_data: list, *, submit=False, applicant="", self_check_evidence: list | None = None, action_note: str = ""):
        change_no = await self._gen_change_no()
        current = datetime.now()
        await self.db.execute(
            text("""INSERT INTO purchase_price_change (change_no, title, change_type, price_direction, supplier_code, supplier_name, phone, fax, contact_person, address, customer, customer_phone, customer_fax, purchase_contact, tax_rate, payment_method, settlement_method, change_date, attachments, remark, signature_opinion, approval_status, approval_level, version, applicant, submitted_at, erp_price_snapshot, self_check_action_note)
                 VALUES (:no, :title, :ct, :pd, :sc, :sn, :ph, :fx, :cp, :ad, :cu, :cph, :cfx, :pc, :tr, :pm, :sm, :cd, :att, :rm, :so, :st, :lv, :v, :ap, :sub, :eps, :an) RETURNING id"""),
            {
                "no": change_no, "title": data.get("title"), "ct": data.get("change_type", "price_change"),
                "pd": data.get("price_direction"), "sc": data.get("supplier_code"), "sn": data.get("supplier_name"),
                "ph": data.get("phone"), "fx": data.get("fax"), "cp": data.get("contact_person"),
                "ad": data.get("address"), "cu": data.get("customer"), "cph": data.get("customer_phone"),
                "cfx": data.get("customer_fax"), "pc": data.get("purchase_contact"),
                "tr": data.get("tax_rate"), "pm": data.get("payment_method"), "sm": data.get("settlement_method"),
                "cd": data.get("change_date"),
                "att": json.dumps(data.get("attachments") or []),
                "rm": data.get("remark"), "so": data.get("signature_opinion"),
                "st": "pending" if submit else "draft", "lv": 1, "v": 1,
                "ap": applicant, "sub": current if submit else None,
                "eps": json.dumps(data.get("erp_price_snapshot") or []),
                "an": (action_note or "").strip(),
            },
        )
        row = await self.db.execute(text("SELECT id FROM purchase_price_change WHERE change_no = :no"), {"no": change_no})
        cid = row.scalar()

        # 兜底：物料代码存在但名称缺失的行，按 ERP 主数据自动回填（防手工敲代码不带名称）
        items_data = await self._enrich_material_names(items_data)

        for idx, item in enumerate(items_data):
            old = item.get("old_price")
            new = item.get("new_price")
            pct = round((float(new) / float(old) - 1) * 100, 2) if old and float(old) > 0 and new and float(new) > 0 else None
            await self.db.execute(
                text("INSERT INTO purchase_price_change_item (change_id, seq, material_code, material_name, spec, unit, order_qty, delivery_qty, old_price, old_price_date, new_price, price_change_pct, remark) VALUES (:cid, :seq, :mc, :mn, :sp, :un, :oq, :dq, :op, :opd, :np, :pct, :rm)"),
                {"cid": cid, "seq": idx + 1, "mc": item.get("material_code"), "mn": item.get("material_name"),
                 "sp": item.get("spec"), "un": item.get("unit"), "oq": item.get("order_qty"),
                 "dq": item.get("delivery_qty"), "op": old, "opd": item.get("old_price_date"),
                 "np": new, "pct": pct, "rm": item.get("remark")},
            )

        if submit:
            # 1. 运行自检
            check_result = await self.self_check_record(cid)
            # 2. 校验凭证 + 行动项说明（高风险强制）
            ev_res = await self._validate_and_store_evidence(cid, self_check_evidence, action_note)
            if not ev_res["success"]:
                record = await self.get_price_change(cid)
                record["_self_check_required"] = True
                record["_self_check_result"] = check_result
                record["_message"] = ev_res["message"]
                return record

            await self._add_approval_log(cid, None, "submit", applicant, "提交审批")
            await self._init_approval_snapshot(cid)
            await self._notify_approvers_of_level(cid, 1)
            self._run_ai_analysis_background(cid)

        record = await self.get_price_change(cid)
        return record

    async def update_price_change(self, change_id: int, data: dict, items_data: list):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") not in ("draft", "rejected", "recalled"):
            return None

        await self.db.execute(
            text("""UPDATE purchase_price_change SET title=:title, supplier_code=:sc, supplier_name=:sn,
                 phone=:ph, fax=:fx, contact_person=:cp, address=:ad, customer=:cu, customer_phone=:cph,
                 customer_fax=:cfx, purchase_contact=:pc, tax_rate=:tr, payment_method=:pm,
                  settlement_method=:sm, change_date=:cd, attachments=:att, remark=:rm, price_direction=:pd,
                  erp_price_snapshot=:eps, updated_at=:now WHERE id=:cid"""),
            {"title": data.get("title"), "sc": data.get("supplier_code"), "sn": data.get("supplier_name"),
             "ph": data.get("phone"), "fx": data.get("fax"), "cp": data.get("contact_person"),
             "ad": data.get("address"), "cu": data.get("customer"), "cph": data.get("customer_phone"),
             "cfx": data.get("customer_fax"), "pc": data.get("purchase_contact"),
             "tr": data.get("tax_rate"), "pm": data.get("payment_method"), "sm": data.get("settlement_method"),
             "cd": data.get("change_date"), "att": json.dumps(data.get("attachments") or []),
             "rm": data.get("remark"), "pd": data.get("price_direction"),
             "eps": json.dumps(data.get("erp_price_snapshot") or []),
             "now": datetime.now(), "cid": change_id},
        )

        await self.db.execute(text("DELETE FROM purchase_price_change_item WHERE change_id=:cid"), {"cid": change_id})
        # 兜底：物料代码存在但名称缺失的行，按 ERP 主数据自动回填
        items_data = await self._enrich_material_names(items_data)
        for idx, item in enumerate(items_data):
            old = item.get("old_price")
            new = item.get("new_price")
            pct = round((float(new) / float(old) - 1) * 100, 2) if old and float(old) > 0 and new and float(new) > 0 else None
            await self.db.execute(
                text("INSERT INTO purchase_price_change_item (change_id, seq, material_code, material_name, spec, unit, order_qty, delivery_qty, old_price, old_price_date, new_price, price_change_pct, remark) VALUES (:cid, :seq, :mc, :mn, :sp, :un, :oq, :dq, :op, :opd, :np, :pct, :rm)"),
                {"cid": change_id, "seq": idx + 1, "mc": item.get("material_code"), "mn": item.get("material_name"),
                 "sp": item.get("spec"), "un": item.get("unit"), "oq": item.get("order_qty"),
                 "dq": item.get("delivery_qty"), "op": old, "opd": item.get("old_price_date"),
                 "np": new, "pct": pct, "rm": item.get("remark")},
            )

        return await self.get_price_change(change_id)

    async def submit_for_approval(self, change_id: int, applicant="", *, self_check_evidence: list | None = None, action_note: str = ""):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") not in ("draft", "rejected", "recalled"):
            return None

        # 1. 每次（重新）提交都用当前明细重跑自检，避免沿用上一轮/驳回前的结果
        check_result = await self.self_check_record(change_id)

        # 2. 校验凭证 + 行动项说明（高风险强制）
        ev_res = await self._validate_and_store_evidence(change_id, self_check_evidence, action_note)
        if not ev_res["success"]:
            return {
                "_self_check_required": True,
                "_self_check_result": check_result,
                "_message": ev_res["message"],
            }

        # 3. 开启新一轮审批：不删除历史审批记录（驳回/撤回等过程完整留存可追溯），
        #    仅重置到第 1 级，并按最新配置重生成审批链快照。
        await self.db.execute(
            text("""UPDATE purchase_price_change
                    SET approval_status='pending', approval_level=1, submitted_at=:now, version=version+1
                    WHERE id=:cid AND approval_status IN ('draft','rejected','recalled')"""),
            {"cid": change_id, "now": datetime.now()},
        )
        await self._add_approval_log(change_id, None, "submit", applicant, "提交审批")
        await self._init_approval_snapshot(change_id)
        await self._notify_approvers_of_level(change_id, 1)
        self._run_ai_analysis_background(change_id)
        return await self.get_price_change(change_id)

    def _check_node_permission(self, node: dict, approver: str, approver_role: str) -> tuple[bool, str]:
        """校验当前用户是否有权操作该审批节点。返回 (ok, message)。
        优先校验 approvers 列表（动态部门经理），其次校验 role。
        admin 绕过所有校验。
        """
        if approver_role == "admin":
            return True, ""
        approvers = node.get("approvers")
        if approvers is not None:
            # 动态节点：approvers 是 [{username, user_id}] 列表，当前用户匹配任一字段即可
            if approvers:
                matched = any(
                    approver == a.get("username") or approver == a.get("user_id")
                    for a in approvers
                )
                if matched:
                    return True, ""
                names = ", ".join(a.get("username", "?") for a in approvers)
                return False, f"当前级别 [{node.get('label')}] 需 {names} 审批，您无权操作"
            return False, f"当前级别 [{node.get('label')}] 部门经理解析失败（申请人可能未关联员工），请联系管理员"
        # 固定角色节点
        required_role = node.get("role")
        if required_role and approver_role != required_role:
            return False, f"当前级别 [{node.get('label')}] 需角色 {required_role} 审批，您的角色（{approver_role or '未知'}）无权操作"
        return True, ""

    async def _get_node_approver_usernames(self, node: dict) -> set[str]:
        """解析节点的具体审批人 username 集合，用于"同人重复跳过"判断。
        动态节点从 approvers 字段取（同时含 username 和 user_id 以兼容两种标识）；
        固定角色节点查 sys_role+sys_user（同样含两者）。
        """
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
        if not role or role == "__dept_manager__":
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

    async def _earlier_approvers(self, change_id: int, before_level: int) -> set[str]:
        """查询 change_id 在 before_level 之前（不含）已经审批过的人集合。
        approval_log.approver 存的是 username，这里 JOIN sys_user 同时返回 user_id，
        以便和 _get_node_approver_usernames（含 username+user_id）做 issubset 比对。
        """
        rows = await self.db.execute(text("""
            SELECT DISTINCT l.approver, u.id::text
            FROM purchase_price_change_approval_log l
            LEFT JOIN sys_user u ON u.username = l.approver
            WHERE l.change_id=:cid AND l.approval_level<:lv AND l.action IN ('approve', 'auto_skip')
              AND l.id >= (SELECT COALESCE(MAX(s.id), 0) FROM purchase_price_change_approval_log s
                           WHERE s.change_id=:cid AND s.action='submit')
        """), {"cid": change_id, "lv": before_level})
        result = set()
        for r in rows:
            if r[0]:
                result.add(str(r[0]))
            if r[1]:
                result.add(str(r[1]))
        return result

    async def approve(self, change_id: int, approver: str, comment="", *, approver_role: str = "", expected_version: int = None):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") != "pending":
            return {"success": False, "message": "状态不正确"}

        # 乐观锁：客户端传入 expected_version，必须与当前 version 匹配
        current_version = record.get("version", 1)
        if expected_version is not None and int(expected_version) != int(current_version):
            return {"success": False, "message": "数据已被他人更新，请刷新后重试"}

        snap = record.get("approval_snapshot") or []
        current_level = record.get("approval_level", 1)

        # 审批链空 → 拒绝（堵"未配置即通过"漏洞）
        if not snap:
            return {"success": False, "message": "审批链未配置，请联系管理员在审批配置中设置审批节点"}
        current_node = next((n for n in snap if n.get("seq") == current_level), None)
        if not current_node:
            return {"success": False, "message": f"当前审批级别 {current_level} 在审批链中不存在"}

        ok, msg = self._check_node_permission(current_node, approver, approver_role)
        if not ok:
            return {"success": False, "message": msg}

        # 通过当前节点
        await self._add_approval_log(change_id, current_level, "approve", approver, comment)

        # 推进到下一节点：若下一节点的审批人包含当前审批人，或下一节点所有审批人都已在更早节点审过，自动跳过
        # 循环处理连续多个节点都需要跳过的情况
        next_level = current_level + 1
        skipped_levels = []
        while True:
            next_node = next((n for n in snap if n.get("seq") == next_level), None)
            if not next_node:
                # 没有后续节点（含全部被跳过的情况）→ 归档
                result = await self.db.execute(
                    text("UPDATE purchase_price_change SET approval_status='approved', approved_by=:ap, approved_at=:now, version=version+1 WHERE id=:cid AND version=:v"),
                    {"ap": approver, "now": datetime.now(), "cid": change_id, "v": current_version},
                )
                if result.rowcount == 0:
                    return {"success": False, "message": "数据已被他人更新，请刷新后重试"}
                msg_extra = f"（自动跳过 L{','.join(map(str, skipped_levels))} 同人节点）" if skipped_levels else ""
                # 全部归档 → 通知申请人
                await self._notify_applicant(
                    change_id,
                    "[调价单] 审批通过",
                    f"您的调价单 {record.get('change_no', '')} 已全部审批通过，已归档。"
                )
                return {"success": True, "level": current_level, "finished": True, "skipped": skipped_levels, "message_extra": msg_extra}
            next_approvers = await self._get_node_approver_usernames(next_node)
            # 跳过条件 1：当前审批人也在下一节点的审批人集合里（连续同人）
            skip = approver in next_approvers
            # 跳过条件 2：下一节点的所有审批人都已在更早节点审过（跨级同人，如 L1 和 L3 同人但 L2 不同人）
            if not skip and next_approvers:
                earlier = await self._earlier_approvers(change_id, next_level)
                # 把刚审完的当前 approver 也算进去
                earlier = earlier | {approver}
                if next_approvers.issubset(earlier):
                    skip = True
            if skip:
                await self._add_approval_log(change_id, next_level, "auto_skip", approver, "自动通过（审批人已在更早节点审过，避免重复审批）")
                skipped_levels.append(next_level)
                next_level += 1
                continue
            break

        # 推进到下一个需要别人审的节点
        result = await self.db.execute(
            text("UPDATE purchase_price_change SET approval_level=:lv, version=version+1 WHERE id=:cid AND version=:v"),
            {"lv": next_level, "cid": change_id, "v": current_version},
        )
        if result.rowcount == 0:
            return {"success": False, "message": "数据已被他人更新，请刷新后重试"}
        msg_extra = f"（自动跳过 L{','.join(map(str, skipped_levels))} 同人节点）" if skipped_levels else ""
        # 推进到下一节点 → 通知下一节点审批人
        await self._notify_approvers_of_level(change_id, next_level)
        return {"success": True, "level": current_level, "finished": False, "skipped": skipped_levels, "message_extra": msg_extra}

    async def reject(self, change_id: int, approver: str, comment="", *, approver_role: str = "", expected_version: int = None):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") != "pending":
            return {"success": False, "message": "状态不正确"}

        # 乐观锁
        current_version = record.get("version", 1)
        if expected_version is not None and int(expected_version) != int(current_version):
            return {"success": False, "message": "数据已被他人更新，请刷新后重试"}

        snap = record.get("approval_snapshot") or []
        current_level = record.get("approval_level", 1)
        if snap:
            current_node = next((n for n in snap if n.get("seq") == current_level), None)
            if current_node:
                ok, msg = self._check_node_permission(current_node, approver, approver_role)
                if not ok:
                    return {"success": False, "message": msg}

        await self._add_approval_log(change_id, current_level, "reject", approver, comment)
        result = await self.db.execute(
            text("UPDATE purchase_price_change SET approval_status='rejected', version=version+1 WHERE id=:cid AND version=:v"),
            {"cid": change_id, "v": current_version},
        )
        if result.rowcount == 0:
            return {"success": False, "message": "数据已被他人更新，请刷新后重试"}
        # 通知申请人：被驳回
        await self._notify_applicant(
            change_id,
            "[调价单] 审批被驳回",
            f"您的调价单 {record.get('change_no', '')} 被 {approver} 驳回。意见：{comment or '无'}。请修改后重新提交。"
        )
        return {"success": True}

    async def recall(self, change_id: int, applicant: str = ""):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") != "pending":
            return False
        await self.db.execute(text("UPDATE purchase_price_change SET approval_status='recalled', version=version+1 WHERE id=:cid"), {"cid": change_id})
        await self._add_approval_log(change_id, record.get("approval_level"), "recall", applicant or record.get("applicant", ""), "申请人撤回")
        return True

    async def delete(self, change_id: int, *, can_archive_delete: bool = False):
        record = await self.get_price_change(change_id)
        if not record:
            return {"success": False, "message": "调价单不存在"}
        status = record.get("approval_status")
        if status == "pending":
            return {"success": False, "message": "审批中的调价单不可删除，请先撤回"}
        if status == "approved" and not can_archive_delete:
            return {"success": False, "message": "已归档的调价单需「调价单归档删除」权限（当前仅管理员可删）"}
        await self.db.execute(text("DELETE FROM purchase_price_change_item WHERE change_id = :cid"), {"cid": change_id})
        await self.db.execute(text("DELETE FROM purchase_price_change_approval_log WHERE change_id = :cid"), {"cid": change_id})
        await self.db.execute(text("DELETE FROM purchase_price_change_ai_analysis WHERE change_id = :cid"), {"cid": change_id})
        await self.db.execute(text("DELETE FROM purchase_price_change WHERE id = :cid"), {"cid": change_id})
        return {"success": True, "message": "已删除"}

    async def pending_approvals(self, *, approver_username: str = "", approver_role: str = ""):
        """待审批列表。传入 approver_username/role 时只返回当前用户有权审批的（admin 看全部）。"""
        rows = await self.db.execute(text("SELECT * FROM purchase_price_change WHERE approval_status='pending' ORDER BY submitted_at DESC NULLS LAST"))
        items = []
        for r in rows:
            d = dict(r._mapping)
            if isinstance(d.get("change_date"), date):
                d["change_date"] = d["change_date"].isoformat()
            if isinstance(d.get("submitted_at"), datetime):
                d["submitted_at"] = d["submitted_at"].isoformat()
            if isinstance(d.get("approval_snapshot"), str):
                try:
                    d["approval_snapshot"] = json.loads(d["approval_snapshot"])
                except Exception:
                    pass
            elif d.get("approval_snapshot") is None:
                d["approval_snapshot"] = []
            if isinstance(d.get("self_check_result"), str):
                try:
                    d["self_check_result"] = json.loads(d["self_check_result"])
                except Exception:
                    pass
            if isinstance(d.get("self_check_evidence"), str):
                try:
                    d["self_check_evidence"] = json.loads(d["self_check_evidence"])
                except Exception:
                    pass

            # 权限过滤：非 admin 只返回当前级别归自己审的单子
            if approver_role != "admin":
                snap = d.get("approval_snapshot") or []
                current_level = d.get("approval_level", 1)
                current_node = next((n for n in snap if n.get("seq") == current_level), None)
                if not current_node:
                    continue  # 审批链异常的单子不展示
                ok, _ = self._check_node_permission(current_node, approver_username, approver_role)
                if not ok:
                    continue  # 当前用户无权审批这一级 → 不显示

            # 附加最新 AI 分析状态/摘要
            ai_row = await self.db.execute(
                text("""SELECT ai_status, ai_risk_level, ai_conclusion, ai_error_msg, ai_analyzed_at
                        FROM purchase_price_change_ai_analysis
                        WHERE change_id=:cid
                        ORDER BY id DESC LIMIT 1"""),
                {"cid": d["id"]},
            )
            ai = ai_row.fetchone()
            if ai:
                ai_summary = dict(ai._mapping)
                if isinstance(ai_summary.get("ai_analyzed_at"), datetime):
                    ai_summary["ai_analyzed_at"] = ai_summary["ai_analyzed_at"].isoformat()
                d["ai_summary"] = ai_summary
            else:
                d["ai_summary"] = None
            items.append(d)
        return items

    async def _latest_ai_analysis(self, change_id: int) -> Optional[dict]:
        """查询最新一条 AI 分析记录（用于判断是否已生成，避免重复调用浪费 token）。"""
        row = await self.db.execute(
            text("SELECT id, ai_status FROM purchase_price_change_ai_analysis WHERE change_id = :cid ORDER BY id DESC LIMIT 1"),
            {"cid": change_id},
        )
        r = row.fetchone()
        if not r:
            return None
        return {"id": r[0], "ai_status": r[1]}

    async def rerun_ai_analysis(self, change_id: int) -> tuple[Optional[dict], bool]:
        """重新生成 AI 分析。返回 (record, ran)。
        ran=False 表示已有完成的分析（ai_status=done），跳过重复生成以节省 token。
        """
        record = await self.get_price_change(change_id)
        if not record:
            return None, False
        latest = await self._latest_ai_analysis(change_id)
        if latest and latest.get("ai_status") == "done":
            return record, False
        await self._run_ai_analysis(change_id)
        return await self.get_price_change(change_id), True

    async def get_approval_logs(self, change_id: int):
        rows = await self.db.execute(text("SELECT * FROM purchase_price_change_approval_log WHERE change_id=:cid ORDER BY operated_at"), {"cid": change_id})
        return [dict(r._mapping) for r in rows]

    # ==================== 自检引擎 ====================

    async def _load_rules(self) -> dict[str, str]:
        """读取自检规则阈值（进程内缓存，配置更新后由 clear_rule_cache 清空）。"""
        global _rule_cache
        if not _rule_cache:
            try:
                rows = await self.db.execute(text("SELECT config_key, config_value FROM price_change_rule_config"))
                _rule_cache = {r[0]: r[1] for r in rows}
            except Exception as e:
                logger.warning("读取规则阈值失败，使用默认值: %s", e)
                _rule_cache = {}
        return _rule_cache

    async def _erp_price_compare(self, material_code: str, supplier_code: str, new_price: float, rules: dict) -> dict | None:
        """ERP 采购订单成交价比价（数据源 B）。
        查本系统已同步的 purchase_order 表（不直连 ERP，保证性能与容错）。
        返回单条 risk dict；无 ERP 记录或异常返回 None（降级，不计入双源）。
        """
        try:
            lookback = int(_rule_float(rules, "erp_price_lookback_months", 12))
        except (TypeError, ValueError):
            lookback = 12
        # 用 make_interval 绑定参数（避免 ::int 与 asyncpg 占位符冲突）
        try:
            rows = await self.db.execute(text("""
                SELECT po_price, po_date
                FROM purchase_order
                WHERE material_code = :mc
                  AND po_price IS NOT NULL AND po_price > 0
                  AND po_date >= CURRENT_DATE - make_interval(months => :months)
                ORDER BY po_date DESC LIMIT 5
            """), {"mc": material_code, "months": lookback})
            prices = [float(r[0]) for r in rows if r[0] is not None and float(r[0]) > 0]
        except Exception as e:
            logger.warning("ERP 采购价比价查询失败(mc=%s): %s", material_code, e)
            return None
        if not prices:
            return None
        hist_max = max(prices)
        hist_avg = sum(prices) / len(prices)
        over_max_high = _rule_float(rules, "compare_over_max_high", 1.10)
        over_avg_medium = _rule_float(rules, "compare_over_avg_medium", 1.05)
        if new_price > hist_max * over_max_high:
            over_pct = round((new_price / hist_max - 1) * 100, 1)
            return {
                "type": "ERP采购比价", "source": "erp", "severity": "high",
                "rule": "新价超过ERP采购最高价%.0f%%以上" % round((over_max_high - 1) * 100),
                "detail": f"ERP采购最高价 {round(hist_max,2)}，新价 {new_price}，超出 {over_pct}%",
                "data": {"hist_avg": round(hist_avg, 4), "hist_max": round(hist_max, 4)},
            }
        if new_price > hist_max:
            over_pct = round((new_price / hist_max - 1) * 100, 1)
            return {
                "type": "ERP采购比价", "source": "erp", "severity": "medium",
                "rule": "新价超过ERP采购最高价",
                "detail": f"ERP采购最高价 {round(hist_max,2)}，新价 {new_price}，超出 {over_pct}%",
                "data": {"hist_avg": round(hist_avg, 4), "hist_max": round(hist_max, 4)},
            }
        if new_price > hist_avg * over_avg_medium:
            over_pct = round((new_price / hist_avg - 1) * 100, 1)
            return {
                "type": "ERP采购比价", "source": "erp", "severity": "medium",
                "rule": "新价超过ERP采购均价%.0f%%以上" % round((over_avg_medium - 1) * 100),
                "detail": f"ERP采购均价 {round(hist_avg,2)}，新价 {new_price}，高出 {over_pct}%",
                "data": {"hist_avg": round(hist_avg, 4), "hist_max": round(hist_max, 4)},
            }
        return {
            "type": "ERP采购比价", "source": "erp", "severity": "low",
            "rule": "新价不高于ERP采购均价",
            "detail": f"ERP采购均价 {round(hist_avg,2)}，新价 {new_price}，处于合理范围",
            "data": {"hist_avg": round(hist_avg, 4), "hist_max": round(hist_max, 4)},
        }

    async def self_check_preview(self, items_data: list, supplier_code: str = "") -> dict:
        """对提交的物料明细做自检（不依赖 DB 已有记录），返回结构化结果。
        用于前端在提交前预览自检结果。
        """
        checks = []
        max_risk = "low"
        rules = await self._load_rules()

        for item in items_data:
            mc = item.get("material_code", "")
            mn = item.get("material_name", "")
            old_price = float(item.get("old_price") or 0)
            new_price = float(item.get("new_price") or 0)

            check = {
                "seq": item.get("seq", 0),
                "material_code": mc,
                "material_name": mn,
                "old_price": old_price,
                "new_price": new_price,
                "risks": [],
                "risk_level": "low",
            }

            if not mc or old_price <= 0 or new_price <= 0:
                checks.append(check)
                continue

            # 1. 历史比价引擎
            hist_rows = await self.db.execute(text("""
                SELECT pci.old_price, pci.new_price, pc.change_date, pc.supplier_name
                FROM purchase_price_change_item pci
                JOIN purchase_price_change pc ON pc.id = pci.change_id
                WHERE pci.material_code = :mc
                  AND pc.approval_status = 'approved'
                  AND pc.id != COALESCE(:exclude, -1)
                ORDER BY pc.change_date DESC LIMIT 3
            """), {"mc": mc, "exclude": -1})
            history = [dict(r._mapping) for r in hist_rows]

            if history:
                hist_prices = []
                for h in history:
                    np = float(h.get("new_price") or 0)
                    if np > 0:
                        hist_prices.append(np)
                if hist_prices:
                    hist_avg = sum(hist_prices) / len(hist_prices)
                    hist_max = max(hist_prices)
                    hist_min = min(hist_prices)

                    over_max_high = _rule_float(rules, "compare_over_max_high", 1.10)
                    over_avg_medium = _rule_float(rules, "compare_over_avg_medium", 1.05)
                    # 规则：新价超过历史最高价
                    if new_price > hist_max * over_max_high:
                        over_pct = round((new_price / hist_max - 1) * 100, 1)
                        check["risks"].append({
                            "type": "历史比价", "source": "system",
                            "rule": f"新价超过历史最高价{round((over_max_high-1)*100):.0f}%以上",
                            "detail": f"历史最高价 {hist_max}，新价 {new_price}，超出 {over_pct}%",
                            "severity": "high",
                            "data": {"hist_avg": round(hist_avg, 4), "hist_max": round(hist_max, 4), "hist_min": round(hist_min, 4)},
                        })
                    elif new_price > hist_max:
                        over_pct = round((new_price / hist_max - 1) * 100, 1)
                        check["risks"].append({
                            "type": "历史比价", "source": "system",
                            "rule": "新价超过历史最高价",
                            "detail": f"历史最高价 {hist_max}，新价 {new_price}，超出 {over_pct}%",
                            "severity": "medium",
                            "data": {"hist_avg": round(hist_avg, 4), "hist_max": round(hist_max, 4), "hist_min": round(hist_min, 4)},
                        })
                    elif new_price > hist_avg * over_avg_medium:
                        over_pct = round((new_price / hist_avg - 1) * 100, 1)
                        check["risks"].append({
                            "type": "历史比价", "source": "system",
                            "rule": f"新价超过历史均价{round((over_avg_medium-1)*100):.0f}%以上",
                            "detail": f"历史均价 {round(hist_avg, 2)}，新价 {new_price}，高出 {over_pct}%",
                            "severity": "medium",
                            "data": {"hist_avg": round(hist_avg, 4), "hist_max": round(hist_max, 4), "hist_min": round(hist_min, 4)},
                        })
                    elif new_price <= hist_avg:
                        check["risks"].append({
                            "type": "历史比价", "source": "system",
                            "rule": "新价不高于历史均价",
                            "detail": f"历史均价 {round(hist_avg, 2)}，新价 {new_price}，处于合理范围",
                            "severity": "low",
                            "data": {"hist_avg": round(hist_avg, 4), "hist_max": round(hist_max, 4), "hist_min": round(hist_min, 4)},
                        })
                else:
                    check["risks"].append({
                        "type": "历史比价", "source": "system",
                        "rule": "无有效历史价格数据",
                        "detail": "该物料有历史记录但无有效价格",
                        "severity": "low",
                        "data": {},
                    })
            else:
                check["risks"].append({
                    "type": "历史比价", "source": "system",
                    "rule": "无历史记录",
                    "detail": "该物料无历史调价记录，无法通过历史比价",
                    "severity": "low",
                    "data": {},
                })

            # 1B. ERP 采购订单成交价比价（数据源 B，新增）— 失败降级，不影响主流程
            erp_risk = await self._erp_price_compare(mc, supplier_code, new_price, rules)
            if erp_risk:
                check["risks"].append(erp_risk)

            # 2. 涨幅分析引擎
            cur_pct = round((new_price / old_price - 1) * 100, 2) if old_price > 0 else 0
            if cur_pct > 0:
                # 查历史同物料的平均涨幅
                hist_pct_rows = await self.db.execute(text("""
                    SELECT pci.price_change_pct
                    FROM purchase_price_change_item pci
                    JOIN purchase_price_change pc ON pc.id = pci.change_id
                    WHERE pci.material_code = :mc
                      AND pc.approval_status = 'approved'
                      AND pci.price_change_pct IS NOT NULL
                      AND pci.price_change_pct > 0
                      AND pc.id != COALESCE(:exclude, -1)
                    ORDER BY pc.change_date DESC LIMIT 5
                """), {"mc": mc, "exclude": -1})
                hist_pcts = [float(r[0]) for r in hist_pct_rows if r[0] is not None]

                if hist_pcts:
                    hist_avg_pct = sum(hist_pcts) / len(hist_pcts)
                    surge_over_hist_high = _rule_float(rules, "surge_over_hist_high", 2.0)
                    surge_over_hist_medium = _rule_float(rules, "surge_over_hist_medium", 1.5)
                    # 涨幅远超历史平均水平
                    if cur_pct > hist_avg_pct * surge_over_hist_high and hist_avg_pct > 0:
                        check["risks"].append({
                            "type": "涨幅分析", "source": "surge",
                            "rule": "涨幅远超历史平均水平",
                            "detail": f"历史平均涨幅 {round(hist_avg_pct, 1)}%，本次涨幅 {cur_pct}%，超过{surge_over_hist_high}倍",
                            "severity": "high",
                            "data": {"hist_avg_pct": round(hist_avg_pct, 2), "cur_pct": cur_pct},
                        })
                    elif cur_pct > hist_avg_pct * surge_over_hist_medium:
                        check["risks"].append({
                            "type": "涨幅分析", "source": "surge",
                            "rule": "涨幅明显高于历史平均水平",
                            "detail": f"历史平均涨幅 {round(hist_avg_pct, 1)}%，本次涨幅 {cur_pct}%",
                            "severity": "medium",
                            "data": {"hist_avg_pct": round(hist_avg_pct, 2), "cur_pct": cur_pct},
                        })
                    else:
                        check["risks"].append({
                            "type": "涨幅分析", "source": "surge",
                            "rule": "涨幅在历史范围内",
                            "detail": f"历史平均涨幅 {round(hist_avg_pct, 1)}%，本次涨幅 {cur_pct}%",
                            "severity": "low",
                            "data": {"hist_avg_pct": round(hist_avg_pct, 2), "cur_pct": cur_pct},
                        })
                else:
                    # 无历史涨幅数据，总体用绝对涨幅判断
                    surge_no_history_high = _rule_float(rules, "surge_no_history_high", 20)
                    surge_no_history_medium = _rule_float(rules, "surge_no_history_medium", 10)
                    if cur_pct >= surge_no_history_high:
                        check["risks"].append({
                            "type": "涨幅分析", "source": "surge",
                            "rule": f"涨幅超过{round(surge_no_history_high)}%，需说明原因",
                            "detail": f"本次涨幅 {cur_pct}%，无历史参考数据",
                            "severity": "high",
                            "data": {"hist_avg_pct": None, "cur_pct": cur_pct},
                        })
                    elif cur_pct >= surge_no_history_medium:
                        check["risks"].append({
                            "type": "涨幅分析", "source": "surge",
                            "rule": f"涨幅超过{round(surge_no_history_medium)}%，建议说明",
                            "detail": f"本次涨幅 {cur_pct}%，无历史参考数据",
                            "severity": "medium",
                            "data": {"hist_avg_pct": None, "cur_pct": cur_pct},
                        })
                    else:
                        check["risks"].append({
                            "type": "涨幅分析", "source": "surge",
                            "rule": "涨幅在合理范围内",
                            "detail": f"本次涨幅 {cur_pct}%",
                            "severity": "low",
                            "data": {"hist_avg_pct": None, "cur_pct": cur_pct},
                        })
            elif cur_pct < 0:
                check["risks"].append({
                    "type": "涨幅分析", "source": "surge",
                    "rule": "降价",
                    "detail": f"本次降价 {abs(cur_pct)}%",
                    "severity": "low",
                    "data": {"hist_avg_pct": None, "cur_pct": cur_pct},
                })
            else:
                check["risks"].append({
                    "type": "涨幅分析", "source": "surge",
                    "rule": "价格持平",
                    "detail": "新旧价格无变化",
                    "severity": "low",
                    "data": {"hist_avg_pct": None, "cur_pct": cur_pct},
                })

            # 单项最高风险等级
            risk_levels = [r["severity"] for r in check["risks"]]
            if "high" in risk_levels:
                check["risk_level"] = "high"
            elif "medium" in risk_levels:
                check["risk_level"] = "medium"
            else:
                check["risk_level"] = "low"

            if check["risk_level"] == "high":
                max_risk = "high"
            elif max_risk != "high" and check["risk_level"] == "medium":
                max_risk = "medium"

            checks.append(check)

        return {
            "checks": checks,
            "overall_status": max_risk,
            "summary": self._summarize_self_check(checks),
        }

    async def self_check_record(self, change_id: int) -> dict:
        """对已有记录做自检，并存储结果到数据库。"""
        record = await self.get_price_change(change_id)
        if not record:
            return {"error": "调价单不存在"}
        items = record.get("items") or []
        result = await self.self_check_preview(items, record.get("supplier_code", ""))
        await self.db.execute(
            text("UPDATE purchase_price_change SET self_check_status=:st, self_check_result=:res WHERE id=:cid"),
            {"st": result["overall_status"], "res": json.dumps(result), "cid": change_id},
        )
        return result

    def _summarize_self_check(self, checks: list) -> str:
        """生成自检的一句话摘要。"""
        total = len(checks)
        high = sum(1 for c in checks if c["risk_level"] == "high")
        medium = sum(1 for c in checks if c["risk_level"] == "medium")
        parts = [f"共 {total} 项物料"]
        if high:
            parts.append(f"高风险 {high} 项")
        if medium:
            parts.append(f"中风险 {medium} 项")
        low = total - high - medium
        if low:
            parts.append(f"正常 {low} 项")
        if high > 0:
            return f"⚠️ {'，'.join(parts)}，需上传支撑凭证"
        elif medium > 0:
            return f"⚡ {'，'.join(parts)}，建议上传凭证说明"
        return f"✅ {'，'.join(parts)}，自检通过"

    def _check_self_check_required(self, self_check_result: dict | None) -> tuple[bool, str]:
        """判断是否需要强制上传凭证。返回 (required, reason)。"""
        if not self_check_result:
            return False, ""
        overall = self_check_result.get("overall_status", "low")
        if overall == "high":
            return True, "存在高风险项，必须上传支撑凭证才能提交审批"
        if overall == "medium":
            return True, "存在中风险项，建议上传凭证说明（可选跳过）"
        return False, ""

    async def _validate_and_store_evidence(self, change_id: int, evidence: list | None, action_note: str = ""):
        """校验并存储凭证 + 行动项说明。evidence: [{id, key, name, url}]。
        高风险时强制要求凭证 + 行动项说明（≥规则字数），否则拒绝。
        """
        record = await self.get_price_change(change_id)
        if not record:
            return {"success": False, "message": "调价单不存在"}
        check_result = record.get("self_check_result")
        if not check_result:
            return {"success": False, "message": "请先运行自检"}
        if isinstance(check_result, str):
            try:
                check_result = json.loads(check_result)
            except Exception:
                check_result = None
        required, reason = self._check_self_check_required(check_result)
        overall = check_result.get("overall_status", "low") if check_result else "low"
        rules = await self._load_rules()
        try:
            min_len = int(_rule_float(rules, "require_action_note_min_len", 10))
        except (TypeError, ValueError):
            min_len = 10
        # 高风险：必须有凭证 + 行动项说明
        if overall == "high":
            if (not evidence) or len(evidence) == 0:
                return {"success": False, "message": "存在高风险项，必须上传支撑凭证才能提交"}
            if len((action_note or "").strip()) < min_len:
                return {"success": False, "message": f"高风险项必须填写至少{min_len}字行动项说明"}
        elif required and (not evidence or len(evidence) == 0):
            return {"success": False, "message": reason}
        await self.db.execute(
            text("UPDATE purchase_price_change SET self_check_evidence=:ev, self_check_action_note=:note WHERE id=:cid"),
            {"ev": json.dumps(evidence or []), "note": (action_note or "").strip(), "cid": change_id},
        )
        # 绑定文件引用计数，杜绝孤儿文件
        try:
            from app.services.common.file_service import FileService
            keys = [e.get("key") for e in (evidence or []) if e.get("key")]
            if keys:
                await FileService(self.db).attach(keys, namespace="purchase-price-change-evidence", biz_ref=f"price_change:{change_id}")
        except Exception as e:
            logger.warning("凭证文件引用计数绑定失败(change_id=%s): %s", change_id, e)
        return {"success": True}

    async def _gen_change_no(self):
        today = datetime.now().strftime("%Y%m%d")
        row = await self.db.execute(text("SELECT MAX(change_no) FROM purchase_price_change WHERE change_no LIKE :pfx"), {"pfx": f"PC{today}%"})
        max_no = row.scalar() or f"PC{today}-000"
        seq = int(max_no.split("-")[-1]) + 1
        return f"PC{today}-{seq:03d}"

    async def _enrich_material_names(self, items: list) -> list:
        """兜底：对「有物料代码但物料名称为空」的行，从 ERP 物料主数据回填名称/规格/单位。

        只在名称缺失时补（前端选择物料时本应已带回名称；手工敲代码不带名称是历史问题主因）。
        ERP 不可达或代码在主数据中不存在时静默跳过，不影响单据保存。
        """
        missing = [
            i for i in (items or [])
            if (i.get("material_code") or "").strip() and not (i.get("material_name") or "").strip()
        ]
        if not missing:
            return items
        codes = list({str(i["material_code"]).strip() for i in missing})
        try:
            from sqlalchemy import create_engine
            from app.core.config import get_settings
            settings = get_settings()
            url = settings.ERP_DB_URL
            if not url:
                return items
            for param in ["TrustServerCertificate=yes", "Encrypt=no"]:
                if param.split("=")[0] not in url:
                    url += f"&{param}" if "?" in url else f"?{param}"
            erp_engine = create_engine(url, connect_args={"login_timeout": 10, "timeout": 15})
            rows_map: dict[str, tuple] = {}
            try:
                with erp_engine.connect() as conn:
                    placeholders = ",".join(f":mc{i}" for i in range(len(codes)))
                    rows = conn.execute(
                        text(f"""SELECT [物料代码], [物料名称], [规格型号], [单位]
                                FROM k3sv.AIS20161019115614.dbo.h_v_K3_WGICItem
                                WHERE [物料代码] IN ({placeholders})"""),
                        {f"mc{i}": c for i, c in enumerate(codes)},
                    )
                    for r in rows:
                        rows_map[r[0]] = (r[1], r[2], r[3])
            finally:
                erp_engine.dispose()
        except Exception as e:
            logger.warning("调价单物料名称 ERP 兜底回填失败: %s", e)
            return items

        for item in missing:
            code = str(item["material_code"]).strip()
            row = rows_map.get(code)
            if not row:
                continue
            item["material_name"] = row[0] or item.get("material_name")
            if not (item.get("spec") or "").strip():
                item["spec"] = row[1] or ""
            if not (item.get("unit") or "").strip():
                item["unit"] = row[2] or item.get("unit")
        return items

    async def _resolve_dept_manager(self, applicant: str) -> list[dict]:
        """动态解析申请人的部门经理（直接上级）。applicant 可能是 user_id 或 username。
        返回 [{username, user_id}] 列表（通常 1 个），解析失败返回空列表。
        """
        if not applicant:
            return []
        rows = await self.db.execute(text("""
            SELECT mgr_user.username, mgr_user.id
            FROM sys_user u
            JOIN scm_employee e ON e.emp_code = u.emp_code
            JOIN scm_employee mgr ON mgr.oa_user_id = e.manager_oa_user_id AND mgr.status = 1
            JOIN sys_user mgr_user ON mgr_user.emp_code = mgr.emp_code AND mgr_user.is_active = TRUE
            WHERE (u.id::text = :a OR u.username = :a)
        """), {"a": applicant})
        return [{"username": r[0], "user_id": str(r[1])} for r in rows if r[0]]

    async def _init_approval_snapshot(self, change_id: int, biz_type: str = "price_change"):
        # 获取单据的关键字段 + 申请人（用于动态部门经理解析）
        r = await self.db.execute(
            text("SELECT price_direction, applicant FROM purchase_price_change WHERE id=:cid"),
            {"cid": change_id},
        )
        rec = r.fetchone()
        if not rec:
            return
        price_direction = rec[0]
        applicant = rec[1]

        r2 = await self.db.execute(
            text("SELECT nodes FROM approval_config WHERE biz_type=:bt AND is_active=TRUE"),
            {"bt": biz_type},
        )
        row = r2.fetchone()
        if not row:
            return
        all_nodes = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or [])

        # 预解析动态部门经理（同一申请人只查一次）
        cached_dept_mgrs: list[str] | None = None

        snapshot = []
        for node in all_nodes:
            cond = node.get("condition")
            if cond and cond.get("field"):
                field_val = price_direction  # 当前单据只有 price_direction 字段可匹配
                if field_val not in cond.get("value", []):
                    continue
            node_role = node.get("role")
            snap_node = {"seq": node.get("seq"), "label": node.get("label"), "role": node_role}
            # 固定审批人（非动态部门经理）也冻结进 snapshot
            node_approvers = node.get("approvers")
            if node_approvers and isinstance(node_approvers, list) and len(node_approvers) > 0:
                snap_node["approvers"] = node_approvers
            # 动态部门经理：解析申请人直接上级，冻结进 snapshot
            if node_role == "__dept_manager__":
                if cached_dept_mgrs is None:
                    cached_dept_mgrs = await self._resolve_dept_manager(applicant)
                snap_node["approvers"] = cached_dept_mgrs
                snap_node["resolver"] = "dept_manager"
                if cached_dept_mgrs:
                    logger.info(f"部门经理解析 change_id={change_id} applicant={applicant} → {[a['username'] for a in cached_dept_mgrs]}")
                else:
                    logger.warning(f"部门经理解析失败 change_id={change_id} applicant={applicant}（无 emp_code 或上级无账号）")
            snapshot.append(snap_node)
        await self.db.execute(
            text("UPDATE purchase_price_change SET approval_snapshot=:snap WHERE id=:cid"),
            {"snap": json.dumps(snapshot), "cid": change_id},
        )

    async def _add_approval_log(self, change_id: int, level, action: str, approver: str, comment: str):
        await self.db.execute(
            text("INSERT INTO purchase_price_change_approval_log (change_id, approval_level, approver, action, comment) VALUES (:cid, :lv, :ap, :ac, :cm)"),
            {"cid": change_id, "lv": level, "ap": approver, "ac": action, "cm": comment},
        )

    async def _run_ai_analysis(self, change_id: int):
        """AI 分析价格变动，生成风险评估和建议（同步，显式调用时用）。"""
        await self._do_ai_analysis(change_id)

    def _run_ai_analysis_background(self, change_id: int) -> None:
        """AI 分析在后台异步执行（不阻塞提交流程）。"""
        task = asyncio.create_task(self._do_ai_analysis(change_id))

    async def _do_ai_analysis(self, change_id: int):
        try:
            from app.services.ai.service import ai_service
            from app.services.ai.base import ChatMessage, ChatOptions

            record = await self.get_price_change(change_id)
            if not record:
                return

            items = record.get("items") or []
            if not items:
                return

            # 查询历史价格走势
            history_parts = []
            for it in items:
                mc = it.get("material_code")
                if not mc:
                    continue
                hist_rows = await self.db.execute(
                    text("""SELECT pci.old_price, pci.new_price, pci.price_change_pct, pc.change_date, pc.supplier_name
                        FROM purchase_price_change_item pci
                        JOIN purchase_price_change pc ON pc.id = pci.change_id
                        WHERE pci.material_code = :mc AND pc.approval_status = 'approved'
                        ORDER BY pc.change_date DESC LIMIT 5"""),
                    {"mc": mc},
                )
                hist = [dict(r._mapping) for r in hist_rows]
                if hist:
                    hlines = [f"  {mc} {it.get('material_name','')} 历史:"]
                    for h in hist:
                        old = float(h.get("old_price") or 0)
                        new = float(h.get("new_price") or 0)
                        pct = h.get("price_change_pct")
                        hlines.append(
                            f"    {h.get('change_date')} | {h.get('supplier_name')} | "
                            f"{old}→{new} | {'+' if (pct or 0) >= 0 else ''}{pct}%"
                        )
                    history_parts.append("\n".join(hlines))
                else:
                    history_parts.append(f"  {mc} {it.get('material_name','')} 历史: 无历史记录")
            history_text = "\n".join(history_parts)

            # 构建分析 prompt
            lines = [
                f"调价单信息:",
                f"  供应商: {record.get('supplier_name')} | 类型: {record.get('price_direction')}",
                f"  付款方式: {record.get('payment_method')} | 结算: {record.get('settlement_method')}",
                f"  税率: {record.get('tax_rate')}",
                "---物料变动明细---",
            ]
            for it in items:
                old = float(it.get("old_price") or 0)
                new = float(it.get("new_price") or 0)
                pct = round((new / old - 1) * 100, 2) if old > 0 else None
                lines.append(
                    f"  {it.get('material_code')} {it.get('material_name')} | "
                    f"规格:{it.get('spec','')} | 原价:{old} 新价:{new} | "
                    f"变动:{'+' if (pct or 0) >= 0 else ''}{pct}%"
                )
            lines.append("---历史价格走势---")
            lines.append(history_text)
            # 附加 ERP 供应商比价数据
            erp_snap = record.get("erp_price_snapshot")
            if erp_snap:
                if isinstance(erp_snap, str):
                    try: erp_snap = json.loads(erp_snap)
                    except Exception: erp_snap = None
                if erp_snap and isinstance(erp_snap, list) and len(erp_snap) > 0:
                    lines.append("---ERP供应商比价数据(提交时快照)---")
                    for ep in erp_snap:
                        lines.append(
                            f"  供应商: {ep.get('supplier_name')} | "
                            f"单价: {ep.get('price')} | "
                            f"报价日期: {ep.get('start_date')}"
                        )
            prompt = "\n".join(lines)

            class PriceAnalysis(BaseModel):
                risk_level: str = Field(description="风险等级: low/medium/high")
                conclusion: str = Field(description="分析结论，2-3句话")
                detail: str = Field(description="详细分析说明，包括历史趋势对比")
                suggestions: str = Field(description="建议措施，多条用;分隔")
                market_source: str = Field(description="推测的市场行情参考来源，如'我的钢铁网'、'生意社'、'卓创资讯'等")
                market_price: float = Field(description="预估的市场参考价格，如无则填0")
                market_range: str = Field(description="市场参考价格范围描述，如'4500-4800元/吨'")
                search_keywords: str = Field(description="推荐搜索关键词，逗号分隔，如'铜价走势,铝锭价格,钢材行情'")

            result = await ai_service.structured_output(
                prompt="你是采购价格分析专家。分析以下调价单，结合历史价格走势，给出风险评估、建议和市场参考信息。\n\n" + prompt,
                schema=PriceAnalysis,
                options=ChatOptions(temperature=0.3),
            )

            history_json = json.dumps([dict(r._mapping) for r in hist_rows] if hist_rows else [], default=str)
            model = ai_service.current_provider()
            await self.db.execute(
                text("""INSERT INTO purchase_price_change_ai_analysis
                    (change_id, ai_conclusion, ai_risk_level, ai_detail, ai_model, ai_status, ai_analyzed_at,
                     history_trend, market_source, market_price, market_range, search_keywords)
                    VALUES (:cid, :conc, :risk, :det, :model, 'done', NOW(),
                     :hist, :ms, :mp, :mr, :sk)"""),
                {"cid": change_id, "conc": result.conclusion, "risk": result.risk_level,
                 "det": result.detail + "\n\n建议: " + result.suggestions, "model": model,
                 "hist": history_json, "ms": result.market_source or "",
                 "mp": result.market_price or 0, "mr": result.market_range or "",
                 "sk": result.search_keywords or ""},
            )
            logger.info(f"AI 分析完成 change_id={change_id} risk={result.risk_level}")
        except Exception as e:
            logger.warning(f"AI 分析失败 change_id={change_id}: {e}")
            try:
                await self.db.execute(
                    text("INSERT INTO purchase_price_change_ai_analysis (change_id, ai_status, ai_error_msg) VALUES (:cid, 'error', :msg)"),
                    {"cid": change_id, "msg": str(e)[:500]},
                )
            except Exception:
                pass

    async def export_list(self, keyword=None, status=None, date_start=None, date_end=None, applicant=None):
        """导出调价单列表为 dict list"""
        conditions = ["1=1"]
        params = {}
        if keyword:
            conditions.append("(change_no ILIKE :kw OR supplier_name ILIKE :kw OR title ILIKE :kw)")
            params["kw"] = f"%{keyword}%"
        if status:
            conditions.append("approval_status = :st")
            params["st"] = status
        if date_start:
            conditions.append("change_date >= :ds")
            params["ds"] = date_start
        if date_end:
            conditions.append("change_date <= :de")
            params["de"] = date_end
        if applicant:
            conditions.append("applicant = :ap")
            params["ap"] = applicant
        where = " AND ".join(conditions)
        rows = await self.db.execute(
            text(f"SELECT * FROM purchase_price_change WHERE {where} ORDER BY created_at DESC"),
            params,
        )
        items = []
        for r in rows:
            d = dict(r._mapping)
            if isinstance(d.get("change_date"), date):
                d["change_date"] = d["change_date"].isoformat()
            if isinstance(d.get("created_at"), datetime):
                d["created_at"] = d["created_at"].isoformat()
            items.append(d)
        return items

    # ==================== 通知 ====================

    async def _notify_user(self, user_id: int, title: str, content: str, *, ref_type: str = "price_change", ref_id: int = None, priority: str = "normal"):
        """给指定用户推一条通知（顶栏铃铛可见）"""
        try:
            await self.db.execute(text("""
                INSERT INTO notification (user_id, type, title, content, ref_type, ref_id, priority, is_read, created_at)
                VALUES (:uid, 'price_change', :title, :content, :rt, :rid, :p, FALSE, NOW())
            """), {"uid": user_id, "title": title, "content": content, "rt": ref_type, "rid": ref_id, "p": priority})
        except Exception as e:
            logger.warning(f"通知推送失败 user_id={user_id} title={title}: {e}")

    async def _notify_approvers_of_level(self, change_id: int, level: int, *, title_prefix: str = "待您审批"):
        """通知某个级别的审批人。动态节点取 approvers.user_id；固定角色节点查库。"""
        rec = await self.get_price_change(change_id)
        if not rec:
            return
        snap = rec.get("approval_snapshot") or []
        node = next((n for n in snap if n.get("seq") == level), None)
        if not node:
            return

        # 解析目标 user_id 列表
        target_uids: list[int] = []
        approvers = node.get("approvers")
        if isinstance(approvers, list):
            target_uids = [int(a["user_id"]) for a in approvers if a.get("user_id")]
        else:
            role = node.get("role")
            if role and role != "__dept_manager__":
                rows = await self.db.execute(text("""
                    SELECT u.id FROM sys_user u
                    JOIN sys_role r ON u.role_id = r.id
                    WHERE r.role_code = :rc AND u.is_active = TRUE
                """), {"rc": role})
                target_uids = [r[0] for r in rows if r[0]]

        if not target_uids:
            return

        no = rec.get("change_no", "")
        supplier = rec.get("supplier_name", "")
        applicant = rec.get("applicant", "")
        label = node.get("label", f"L{level}")
        title = f"[调价单] {title_prefix} - {label}"
        content = f"调价单 {no}（供应商：{supplier}，申请人：{applicant}）需要您{label}。"
        for uid in target_uids:
            await self._notify_user(uid, title, content, ref_id=change_id, priority="high")

        await self._notify_approvers_wecom(target_uids, change_id, no, supplier, applicant, label)

    async def _notify_approvers_wecom(self, user_ids: list[int], change_id: int, no: str, supplier: str, applicant: str, label: str):
        """企业微信推送调价单待审批消息卡片给审批人。未配置企微/推送失败时优雅降级，不影响审批流程。"""
        if not user_ids:
            return
        try:
            settings = _get_settings()
            if not (settings.wecom_corp_id and settings.wecom_corp_secret and settings.wecom_agent_id):
                logger.info("[price_change][wecom] 企业微信未配置，跳过审批推送")
                return
            # 查审批人的企微 userid（sys_user.wecom_user_id 已绑定）
            rows = await self.db.execute(text(
                "SELECT wecom_user_id FROM sys_user WHERE id = ANY(:uids) AND wecom_user_id IS NOT NULL AND wecom_user_id != ''"
            ), {"uids": user_ids})
            wecom_ids = [r[0] for r in rows if r[0]]
            if not wecom_ids:
                return
            base = settings.frontend_base_url or "http://localhost:3000"
            if base and not base.startswith(("http://", "https://")):
                base = "http://" + base
            url = f"{base}/purchase/price-change/{change_id}"
            desc = f"调价单 {no}\n供应商：{supplier}\n申请人：{applicant}\n审批节点：{label}\n点击查看详情并处理审批。"
            agent_id = settings.wecom_agent_id
            try:
                agent_id = int(agent_id)
            except (TypeError, ValueError):
                logger.warning(f"[price_change][wecom] agent_id 配置非法: {settings.wecom_agent_id}")
                return
            payload = {
                "touser": "|".join(wecom_ids),
                "msgtype": "textcard",
                "agentid": agent_id,
                "textcard": {
                    "title": f"调价单待审批 - {label}",
                    "description": desc,
                    "url": url,
                    "btntxt": "查看详情",
                },
            }
            resp = await _get_wecom_client().send_app_message(payload)
            errcode = resp.get("errcode", 0)
            if errcode != 0:
                logger.warning(f"[price_change][wecom] 推送审批消息失败 errcode={errcode} errmsg={resp.get('errmsg')}")
            else:
                logger.info(f"[price_change][wecom] 已推送 {len(wecom_ids)} 位审批人 change_id={change_id}")
        except Exception as e:
            logger.warning(f"[price_change][wecom] 审批企微推送异常（已降级）: {e}")

    async def _notify_applicant(self, change_id: int, title: str, content: str):
        """通知申请人"""
        rec = await self.get_price_change(change_id)
        if not rec:
            return
        applicant = rec.get("applicant")
        if not applicant:
            return
        # applicant 可能是 user_id 或 username，查库拿 id
        row = await self.db.execute(text("SELECT id FROM sys_user WHERE id::text = :a OR username = :a LIMIT 1"), {"a": str(applicant)})
        r = row.fetchone()
        if r:
            await self._notify_user(r[0], title, content, ref_id=change_id, priority="high")

    # ==================== 我已审批 ====================

    async def my_approved(self, approver: str, *, approver_role: str = "", page: int = 1, page_size: int = 20):
        """我已审批列表：approval_log 里 approver=当前用户的单子。
        approver 在日志里存的是 username（get_current_user_payload 已转换）。
        """
        # 先用子查询找到当前用户审过的所有 change_id（去重），按最新操作时间倒序
        offset = (page - 1) * page_size
        # 同时支持 username 和 user_id 匹配（兼容历史数据）
        like_match = f"%{approver}%"
        count_sql = text("""
            SELECT COUNT(DISTINCT change_id) FROM purchase_price_change_approval_log
            WHERE approver = :a OR approver = :a_id
        """)
        # 尝试把 approver 转成 id（如果它是 username）
        id_row = await self.db.execute(text("SELECT id FROM sys_user WHERE username = :a LIMIT 1"), {"a": approver})
        approver_id = id_row.scalar()

        params = {"a": approver, "a_id": str(approver_id) if approver_id else "__none__"}
        total = (await self.db.execute(count_sql, params)).scalar() or 0

        rows = await self.db.execute(text("""
            SELECT pc.*,
                   (SELECT action FROM purchase_price_change_approval_log
                    WHERE change_id = pc.id AND (approver = :a OR approver = :a_id)
                    ORDER BY operated_at DESC LIMIT 1) AS my_last_action,
                   (SELECT operated_at FROM purchase_price_change_approval_log
                    WHERE change_id = pc.id AND (approver = :a OR approver = :a_id)
                    ORDER BY operated_at DESC LIMIT 1) AS my_last_action_at
            FROM purchase_price_change pc
            WHERE pc.id IN (
                SELECT DISTINCT change_id FROM purchase_price_change_approval_log
                WHERE approver = :a OR approver = :a_id
            )
            ORDER BY my_last_action_at DESC NULLS LAST
            LIMIT :lim OFFSET :off
        """), {**params, "lim": page_size, "off": offset})

        items = []
        for r in rows:
            d = dict(r._mapping)
            if isinstance(d.get("change_date"), date):
                d["change_date"] = d["change_date"].isoformat()
            for k in ("created_at", "submitted_at", "approved_at", "my_last_action_at"):
                if isinstance(d.get(k), datetime):
                    d[k] = d[k].isoformat()
            items.append(d)
        return items, total

    # ==================== 反审核（撤回审批）====================

    async def revoke_approval(self, change_id: int, revoker: str, *, revoker_role: str = "") -> dict:
        """撤回自己的审批（反审核）。
        规则（大厂标准）：
        1. 单子状态必须是 pending（已归档/驳回的不能撤）
        2. 当前用户必须是最后一条 approve/auto_skip log 的 approver
        3. 撤回后，approval_level 回退一级，最后那条 log 改为 revoked
        4. 如果最后一条是 auto_skip（同人跳过），连跳过一起撤回，回退到真正的手动审
        """
        rec = await self.get_price_change(change_id)
        if not rec:
            return {"success": False, "message": "调价单不存在"}
        if rec.get("approval_status") != "pending":
            return {"success": False, "message": "仅审批中状态可撤回审批"}

        current_level = rec.get("approval_level", 1)
        if current_level <= 1:
            return {"success": False, "message": "当前在第1级，没有可撤回的审批"}

        # 查当前轮次内最后一条 approve/auto_skip 日志（即把单子推到当前级别的那次操作）
        log_row = await self.db.execute(text("""
            SELECT id, approval_level, approver, action FROM purchase_price_change_approval_log
            WHERE change_id = :cid AND action IN ('approve', 'auto_skip')
              AND id >= (SELECT COALESCE(MAX(s.id), 0) FROM purchase_price_change_approval_log s
                         WHERE s.change_id=:cid AND s.action='submit')
            ORDER BY id DESC LIMIT 1
        """), {"cid": change_id})
        last_log = log_row.fetchone()
        if not last_log:
            return {"success": False, "message": "没有可撤回的审批记录"}

        log_id, log_level, log_approver, log_action = last_log
        # admin 可撤回任何人的；非 admin 只能撤回自己的
        if revoker_role != "admin" and log_approver != revoker:
            return {"success": False, "message": "只能撤回自己刚做出的审批"}

        # 校验：必须撤回的是"导致当前级别"的那次操作
        # approve L(N-1) → 推进到 L(N)，所以 last_log.approval_level 应该是 current_level - 1
        # 但 auto_skip 的 level 可能就是当前级别本身（被跳到的级别）
        # 简单规则：last_log 的 level 必须 >= current_level - 1
        if log_level < current_level - 1:
            return {"success": False, "message": "审批已被后续操作覆盖，无法撤回"}

        # 把这条 log 标记为 revoked
        await self.db.execute(text("""
            UPDATE purchase_price_change_approval_log
            SET action = 'revoked', comment = CONCAT(COALESCE(comment, ''), ' | 已被撤回')
            WHERE id = :lid
        """), {"lid": log_id})

        # 找到撤回后应该回到的级别：连续把所有 auto_skip 也一起撤
        # 简化：回退到 log_level（即这次操作的源级别）
        rollback_level = log_level if log_action == "approve" else log_level
        # 如果 log_level 是 0（提交），回退到 1
        if rollback_level < 1:
            rollback_level = 1

        result = await self.db.execute(text("""
            UPDATE purchase_price_change
            SET approval_level = :lv, version = version + 1
            WHERE id = :cid AND approval_status = 'pending'
        """), {"lv": rollback_level, "cid": change_id})
        if result.rowcount == 0:
            return {"success": False, "message": "状态已变化，请刷新后重试"}

        logger.info(f"反审核 change_id={change_id} revoker={revoker} level {current_level} → {rollback_level}")

        # 通知申请人 + 新的当前级别审批人
        await self._notify_applicant(
            change_id,
            "[调价单] 审批被撤回",
            f"您的调价单 {rec.get('change_no', '')} 被 {revoker} 撤回了审批，已回退到第{rollback_level}级重新审批。"
        )
        await self._notify_approvers_of_level(change_id, rollback_level, title_prefix="重新待您审批")

        return {"success": True, "rollback_level": rollback_level}
