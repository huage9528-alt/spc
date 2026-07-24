"""调价单模块 - 业务逻辑（纯 raw SQL，避免 async ORM Greenlet 问题）"""

import json
import logging
from datetime import datetime, date
from typing import Any, Optional

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


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
        # 子表
        items_row = await self.db.execute(text("SELECT * FROM purchase_price_change_item WHERE change_id = :cid ORDER BY seq"), {"cid": change_id})
        record["items"] = [dict(r._mapping) for r in items_row]
        # 审批日志
        logs_row = await self.db.execute(text("SELECT * FROM purchase_price_change_approval_log WHERE change_id = :cid ORDER BY operated_at"), {"cid": change_id})
        record["approval_logs"] = [dict(r._mapping) for r in logs_row]
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

    async def create_price_change(self, data: dict, items_data: list, *, submit=False, applicant=""):
        change_no = await self._gen_change_no()
        current = datetime.now()
        await self.db.execute(
            text("""INSERT INTO purchase_price_change (change_no, title, change_type, price_direction, supplier_code, supplier_name, phone, fax, contact_person, address, customer, customer_phone, customer_fax, purchase_contact, tax_rate, payment_method, settlement_method, change_date, attachments, remark, signature_opinion, approval_status, approval_level, version, applicant, submitted_at, erp_price_snapshot)
                 VALUES (:no, :title, :ct, :pd, :sc, :sn, :ph, :fx, :cp, :ad, :cu, :cph, :cfx, :pc, :tr, :pm, :sm, :cd, :att, :rm, :so, :st, :lv, :v, :ap, :sub, :eps) RETURNING id"""),
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
            },
        )
        row = await self.db.execute(text("SELECT id FROM purchase_price_change WHERE change_no = :no"), {"no": change_no})
        cid = row.scalar()

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
            await self._add_approval_log(cid, None, "submit", applicant, "提交审批")
            await self._init_approval_snapshot(cid)
            await self._run_ai_analysis(cid)

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

    async def submit_for_approval(self, change_id: int, applicant=""):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") not in ("draft", "rejected", "recalled"):
            return None

        await self.db.execute(text("DELETE FROM purchase_price_change_approval_log WHERE change_id = :cid"), {"cid": change_id})
        await self.db.execute(
            text("UPDATE purchase_price_change SET approval_status='pending', approval_level=1, submitted_at=:now WHERE id=:cid"),
            {"cid": change_id, "now": datetime.now()},
        )
        await self._add_approval_log(change_id, None, "submit", applicant, "提交审批")
        await self._init_approval_snapshot(change_id)
        await self._run_ai_analysis(change_id)  # 异步触发 AI 分析
        # 通知 L1 审批人
        await self._notify_approvers_of_level(change_id, 1)
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

    async def delete(self, change_id: int):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") in ("pending", "approved"):
            return False
        await self.db.execute(text("DELETE FROM purchase_price_change_item WHERE change_id = :cid"), {"cid": change_id})
        await self.db.execute(text("DELETE FROM purchase_price_change_approval_log WHERE change_id = :cid"), {"cid": change_id})
        await self.db.execute(text("DELETE FROM purchase_price_change WHERE id = :cid"), {"cid": change_id})
        return True

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

    async def rerun_ai_analysis(self, change_id: int):
        record = await self.get_price_change(change_id)
        if not record:
            return None
        await self._run_ai_analysis(change_id)
        return await self.get_price_change(change_id)

    async def get_approval_logs(self, change_id: int):
        rows = await self.db.execute(text("SELECT * FROM purchase_price_change_approval_log WHERE change_id=:cid ORDER BY operated_at"), {"cid": change_id})
        return [dict(r._mapping) for r in rows]

    async def _gen_change_no(self):
        today = datetime.now().strftime("%Y%m%d")
        row = await self.db.execute(text("SELECT MAX(change_no) FROM purchase_price_change WHERE change_no LIKE :pfx"), {"pfx": f"PC{today}%"})
        max_no = row.scalar() or f"PC{today}-000"
        seq = int(max_no.split("-")[-1]) + 1
        return f"PC{today}-{seq:03d}"

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
        """AI 分析价格变动，生成风险评估和建议"""
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

        # 查最后一条 approve/auto_skip 日志（即把单子推到当前级别的那次操作）
        log_row = await self.db.execute(text("""
            SELECT id, approval_level, approver, action FROM purchase_price_change_approval_log
            WHERE change_id = :cid AND action IN ('approve', 'auto_skip')
            ORDER BY operated_at DESC LIMIT 1
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
