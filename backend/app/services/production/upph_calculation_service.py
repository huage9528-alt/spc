
from typing import Optional, List, Tuple
from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.production.product_process_capacity import ProductProcessCapacity
from app.core.config import get_settings


class UpphCalculationService:
    """UPPH 计算服务 - 统一处理 UPPH 的获取、匹配、计算"""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.settings = get_settings()

    async def get_matched_capacities(
        self,
        product_code: Optional[str] = None,
        bom_code: Optional[str] = None,
    ) -> List[ProductProcessCapacity]:
        """
        根据配置获取匹配的 UPPH 记录
        返回按 last_sync_time 倒序排列的列表（最新优先）
        """
        match_mode = self.settings.UPPH_MATCH_MODE
        conditions = [ProductProcessCapacity.is_active == True]

        if match_mode == "bom_code" and bom_code:
            # 按 BOM 编码匹配
            conditions.append(ProductProcessCapacity.bom_code == bom_code)
        elif product_code:
            # 默认按产品编码匹配
            conditions.append(ProductProcessCapacity.product_code == product_code)
        else:
            # 没有匹配条件
            return []

        result = await self.db.execute(
            select(ProductProcessCapacity)
            .where(*conditions)
            .order_by(
                # 优先选择有备注的，再按 last_sync_time 倒序（最新优先）
                ProductProcessCapacity.remark.is_(None),
                ProductProcessCapacity.last_sync_time.desc().nullslast(),
                ProductProcessCapacity.id.desc(),
            )
        )
        return list(result.scalars().all())

    async def calculate_total_upph(
        self,
        product_code: Optional[str] = None,
        bom_code: Optional[str] = None,
    ) -> Tuple[Optional[float], List[ProductProcessCapacity]]:
        """
        计算综合 UPPH
        返回：(综合 UPPH, 使用的 UPPH 记录列表)
        """
        capacities = await self.get_matched_capacities(product_code=product_code, bom_code=bom_code)

        total_upph = 0.0
        used_capacities = []

        for c in capacities:
            if c.upph and float(c.upph) > 0:
                total_upph += float(c.upph)
                used_capacities.append(c)

        return (total_upph if total_upph > 0 else None, used_capacities)
