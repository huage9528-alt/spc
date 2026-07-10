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
        total_row = await self.db.execute(text(f"SELECT COUNT(*) FROM purchase_price_change WHERE {where}"), params)
        total = total_row.scalar() or 0

        offset = (page - 1) * page_size
        rows = await self.db.execute(
            text(f"SELECT * FROM purchase_price_change WHERE {where} ORDER BY created_at DESC LIMIT :lim OFFSET :off"),
            {**params, "lim": page_size, "off": offset},
        )
        items = [dict(r._mapping) for r in rows]
        for item in items:
            if isinstance(item.get("change_date"), date):
                item["change_date"] = item["change_date"].isoformat()
            if isinstance(item.get("created_at"), datetime):
                item["created_at"] = item["created_at"].isoformat()
            if isinstance(item.get("updated_at"), datetime):
                item["updated_at"] = item["updated_at"].isoformat()
            if isinstance(item.get("attachments"), str):
                item["attachments"] = json.loads(item["attachments"] or "[]")
        return items, total

    async def get_price_change(self, change_id: int) -> Optional[dict]:
        row = await self.db.execute(text("SELECT * FROM purchase_price_change WHERE id = :id"), {"id": change_id})
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
            text("""INSERT INTO purchase_price_change (change_no, title, change_type, price_direction, supplier_code, supplier_name, phone, fax, contact_person, address, customer, customer_phone, customer_fax, purchase_contact, tax_rate, payment_method, settlement_method, change_date, attachments, remark, signature_opinion, approval_status, approval_level, version, applicant, submitted_at)
                 VALUES (:no, :title, :ct, :pd, :sc, :sn, :ph, :fx, :cp, :ad, :cu, :cph, :cfx, :pc, :tr, :pm, :sm, :cd, :att, :rm, :so, :st, :lv, :v, :ap, :sub) RETURNING id"""),
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
                 updated_at=:now WHERE id=:cid"""),
            {"title": data.get("title"), "sc": data.get("supplier_code"), "sn": data.get("supplier_name"),
             "ph": data.get("phone"), "fx": data.get("fax"), "cp": data.get("contact_person"),
             "ad": data.get("address"), "cu": data.get("customer"), "cph": data.get("customer_phone"),
             "cfx": data.get("customer_fax"), "pc": data.get("purchase_contact"),
             "tr": data.get("tax_rate"), "pm": data.get("payment_method"), "sm": data.get("settlement_method"),
             "cd": data.get("change_date"), "att": json.dumps(data.get("attachments") or []),
             "rm": data.get("remark"), "pd": data.get("price_direction"), "now": datetime.now(), "cid": change_id},
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
        return await self.get_price_change(change_id)

    async def approve(self, change_id: int, approver: str, comment=""):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") != "pending":
            return {"success": False, "message": "状态不正确"}

        snap = record.get("approval_snapshot") or []
        current_level = record.get("approval_level", 1)
        next_node = next((n for n in snap if n.get("seq") == current_level + 1), None)

        await self._add_approval_log(change_id, current_level, "approve", approver, comment)

        if next_node:
            await self.db.execute(text("UPDATE purchase_price_change SET approval_level=:lv WHERE id=:cid"), {"lv": current_level + 1, "cid": change_id})
            return {"success": True, "level": current_level, "finished": False}
        else:
            await self.db.execute(
                text("UPDATE purchase_price_change SET approval_status='approved', approved_by=:ap, approved_at=:now WHERE id=:cid"),
                {"ap": approver, "now": datetime.now(), "cid": change_id},
            )
            return {"success": True, "level": current_level, "finished": True}

    async def reject(self, change_id: int, approver: str, comment=""):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") != "pending":
            return {"success": False, "message": "状态不正确"}
        await self._add_approval_log(change_id, record.get("approval_level"), "reject", approver, comment)
        await self.db.execute(text("UPDATE purchase_price_change SET approval_status='rejected' WHERE id=:cid"), {"cid": change_id})
        return {"success": True}

    async def recall(self, change_id: int):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") != "pending":
            return False
        await self.db.execute(text("UPDATE purchase_price_change SET approval_status='recalled' WHERE id=:cid"), {"cid": change_id})
        return True

    async def delete(self, change_id: int):
        record = await self.get_price_change(change_id)
        if not record or record.get("approval_status") in ("pending", "approved"):
            return False
        await self.db.execute(text("DELETE FROM purchase_price_change_item WHERE change_id = :cid"), {"cid": change_id})
        await self.db.execute(text("DELETE FROM purchase_price_change_approval_log WHERE change_id = :cid"), {"cid": change_id})
        await self.db.execute(text("DELETE FROM purchase_price_change WHERE id = :cid"), {"cid": change_id})
        return True

    async def pending_approvals(self):
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

    async def _init_approval_snapshot(self, change_id: int, biz_type: str = "price_change"):
        # 获取单据的关键字段用于条件匹配
        r = await self.db.execute(
            text("SELECT price_direction FROM purchase_price_change WHERE id=:cid"),
            {"cid": change_id},
        )
        rec = r.fetchone()
        if not rec:
            return
        price_direction = rec[0]

        r2 = await self.db.execute(
            text("SELECT nodes FROM approval_config WHERE biz_type=:bt AND is_active=TRUE"),
            {"bt": biz_type},
        )
        row = r2.fetchone()
        if not row:
            return
        all_nodes = json.loads(row[0]) if isinstance(row[0], str) else (row[0] or [])
        snapshot = []
        for node in all_nodes:
            cond = node.get("condition")
            if cond and cond.get("field"):
                field_val = price_direction  # 当前单据只有 price_direction 字段可匹配
                if field_val not in cond.get("value", []):
                    continue
            snapshot.append({"seq": node.get("seq"), "label": node.get("label"), "role": node.get("role")})
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
