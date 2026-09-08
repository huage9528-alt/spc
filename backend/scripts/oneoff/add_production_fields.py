#!/usr/bin/env python3
"""直接添加生产排产需要的字段"""

import asyncio
import sys
from pathlib import Path

# 添加项目路径（本脚本位于 backend/scripts/oneoff/）
backend_path = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(backend_path))

from sqlalchemy import text
from app.core.database import AsyncSessionLocal


async def add_fields():
    async with AsyncSessionLocal() as db:
        print("=" * 60)
        print("添加生产排产字段")
        print("=" * 60)
        
        # 1. 产品表添加 upph 字段
        print("\n1. 添加产品表 upph 字段...")
        try:
            await db.execute(text("ALTER TABLE scm_product ADD COLUMN IF NOT EXISTS upph NUMERIC(15, 2) DEFAULT 0"))
            print("   ✅ 成功")
        except Exception as e:
            print(f"   ⚠️ 警告: {e}")
        
        # 2. 排产表添加字段
        print("\n2. 添加排产表字段...")
        try:
            await db.execute(text("ALTER TABLE production_schedule_plan ADD COLUMN IF NOT EXISTS upph NUMERIC(15, 2) DEFAULT 0"))
            await db.execute(text("ALTER TABLE production_schedule_plan ADD COLUMN IF NOT EXISTS daily_work_hours NUMERIC(5, 2) DEFAULT 8"))
            print("   ✅ 成功")
        except Exception as e:
            print(f"   ⚠️ 警告: {e}")
        
        # 3. 初始化工作时间配置
        print("\n3. 初始化工作时间配置...")
        try:
            await db.execute(text("""
                INSERT INTO node_standard (node_code, node_name, time_value, time_unit, applicable_scene, description, is_active, created_by, created_at, updated_at)
                SELECT 'daily_work_hours', '每日工作小时数', 8, '小时', 'production_scheduling', '精益车间每日工作小时数，用于排产计算', true, 'system', now(), now()
                WHERE NOT EXISTS (SELECT 1 FROM node_standard WHERE node_code = 'daily_work_hours')
            """))
            print("   ✅ 成功")
        except Exception as e:
            print(f"   ⚠️ 警告: {e}")
        
        await db.commit()
        print("\n✅ 完成！")


if __name__ == "__main__":
    asyncio.run(add_fields())