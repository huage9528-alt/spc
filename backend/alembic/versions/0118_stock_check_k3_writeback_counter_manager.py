"""add counter_user_id/manager_id to scm_stock_check_k3_writeback; rebuild unique constraint

Revision ID: 0118
Revises: 0117
Create Date: 2026-09-11

设计文档: docs/superpowers/specs/2026-09-11-stockcheck-k3-manager-dynamic-design.md

容器启动以 init_database.py 为真相源(migrate_columns 两列 + migrate_stock_check_k3_writeback_counter_manager
重建唯一约束); 本迁移与之同语句(ADD COLUMN IF NOT EXISTS / DROP+ADD CONSTRAINT),
即使 alembic 离线跑也不会冲突(IF NOT EXISTS 幂等)。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "0118"
down_revision: Union[str, Sequence[str], None] = "0117"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE scm_stock_check_k3_writeback ADD COLUMN IF NOT EXISTS counter_user_id BIGINT")
    op.execute("ALTER TABLE scm_stock_check_k3_writeback ADD COLUMN IF NOT EXISTS manager_id BIGINT")
    op.execute("ALTER TABLE scm_stock_check_k3_writeback DROP CONSTRAINT IF EXISTS uq_sckw_check_type_wh")
    op.execute(
        "ALTER TABLE scm_stock_check_k3_writeback "
        "ADD CONSTRAINT uq_sckw_check_type_wh_user "
        "UNIQUE (check_id, bill_type, wh_id, counter_user_id)"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE scm_stock_check_k3_writeback DROP CONSTRAINT IF EXISTS uq_sckw_check_type_wh_user")
    op.execute(
        "ALTER TABLE scm_stock_check_k3_writeback "
        "ADD CONSTRAINT uq_sckw_check_type_wh "
        "UNIQUE (check_id, bill_type, wh_id)"
    )
    op.execute("ALTER TABLE scm_stock_check_k3_writeback DROP COLUMN IF EXISTS manager_id")
    op.execute("ALTER TABLE scm_stock_check_k3_writeback DROP COLUMN IF EXISTS counter_user_id")
