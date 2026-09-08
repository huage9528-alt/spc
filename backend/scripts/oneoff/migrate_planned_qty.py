"""临时脚本：加 planned_qty 字段"""
import os

import psycopg2

# 连接串从环境变量注入（与根目录 .env 的 DATABASE_URL_SYNC 一致），不再硬编码凭据
CONN = os.environ.get(
    "DATABASE_URL_SYNC", "postgresql://postgres:postgres@localhost:5432/spc_db"
).replace("postgresql+psycopg2://", "postgresql://")

conn = psycopg2.connect(CONN)
cur = conn.cursor()
# 先检查字段是否已存在
cur.execute("""
    SELECT column_name FROM information_schema.columns
    WHERE table_name='production_schedule_plan' AND column_name='planned_qty'
""")
exists = cur.fetchone()
if exists:
    print('planned_qty 已存在，跳过')
else:
    cur.execute('ALTER TABLE production_schedule_plan ADD COLUMN IF NOT EXISTS planned_qty NUMERIC(15,2)')
    print('planned_qty 已添加')

    # 给现有数据回填（用 source_order_qty）
    cur.execute('UPDATE production_schedule_plan SET planned_qty = source_order_qty WHERE planned_qty IS NULL')
    print(f'回填 {cur.rowcount} 条记录')

conn.commit()
conn.close()
print('完成')
