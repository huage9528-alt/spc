"""add channel_sessions JSONB to sys_user (keep legacy login_version/last_token_jti)

Revision ID: 0116
Revises: 0115
Create Date: 2026-08-14

说明：登录会话改为分渠道管理（同渠道互斥、跨渠道并存）。
- 新增 sys_user.channel_sessions JSONB，结构 {渠道名: {version, last_jti}}
- 将存量 web 渠道会话从 login_version/last_token_jti 回填进 channel_sessions.web
- login_version / last_token_jti 两列保留不删，仅作历史兼容（运行时已不再读写）

容器启动以 init_database.py 为真相源（migrate_columns 加列 + backfill 回填与本迁移
完全一致，且不再登记 drop_columns），本 Alembic 仅手动运行时兜底；二者均使用
ADD COLUMN IF NOT EXISTS 幂等写法，不会冲突。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0116"
down_revision: Union[str, Sequence[str], None] = "0115"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) 新增 channel_sessions 列（幂等）
    op.execute(
        "ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS channel_sessions JSONB"
    )
    # 2) 回填存量 web 渠道会话（仅 channel_sessions 为空且有登录历史的行）
    op.execute(
        "UPDATE sys_user SET channel_sessions = jsonb_build_object('web', "
        "jsonb_build_object('version', COALESCE(login_version, 0), "
        "'last_jti', last_token_jti)) "
        "WHERE channel_sessions IS NULL "
        "AND (COALESCE(login_version, 0) > 0 OR last_token_jti IS NOT NULL)"
    )
    # 注意：login_version / last_token_jti 保留不删，仅作历史兼容


def downgrade() -> None:
    op.execute("ALTER TABLE sys_user DROP COLUMN IF EXISTS channel_sessions")
