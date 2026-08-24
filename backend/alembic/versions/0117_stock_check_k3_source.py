"""add source/erp_bill_no/erp_inter_id to scm_inventory_check (K3 gain/loss import)

Revision ID: 0117
Revises: 0116
Create Date: 2026-08-19

说明：K3 盘盈盘亏单导入功能（ICStockBill FTranType 40/43 → 中台盘点单）。
- 新增 scm_inventory_check.source VARCHAR(16) NOT NULL DEFAULT 'manual'（manual/k3）
- 新增 scm_inventory_check.erp_bill_no VARCHAR(64)（K3 单号 YADJ/KADJ，幂等键）
- 新增 scm_inventory_check.erp_inter_id BIGINT（K3 FInterID，排查用）
- 新增部分唯一索引 uq_scm_inventory_check_erp_bill_no（erp_bill_no 非空时唯一，
  防止同一张 K3 单重复导入生成多张盘点单）

容器启动以 init_database.py 为真相源（migrate_columns 三列 + ensure_indexes 唯一索引
与本迁移语句完全一致），本 Alembic 仅手动运行时兜底；二者均使用 IF NOT EXISTS /
IF EXISTS 幂等写法，不会冲突。

设计文档: docs/superpowers/specs/2026-08-19-k3-stock-gain-loss-import-design.md
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0117"
down_revision: Union[str, Sequence[str], None] = "0116"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE scm_inventory_check "
        "ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'manual'"
    )
    op.execute(
        "ALTER TABLE scm_inventory_check "
        "ADD COLUMN IF NOT EXISTS erp_bill_no VARCHAR(64)"
    )
    op.execute(
        "ALTER TABLE scm_inventory_check "
        "ADD COLUMN IF NOT EXISTS erp_inter_id BIGINT"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_inventory_check_erp_bill_no "
        "ON scm_inventory_check (erp_bill_no) WHERE erp_bill_no IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_scm_inventory_check_erp_bill_no")
    op.execute("ALTER TABLE scm_inventory_check DROP COLUMN IF EXISTS erp_inter_id")
    op.execute("ALTER TABLE scm_inventory_check DROP COLUMN IF EXISTS erp_bill_no")
    op.execute("ALTER TABLE scm_inventory_check DROP COLUMN IF EXISTS source")
