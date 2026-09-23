"""供应商索赔测试套件全局设施。

关键约束：app.core.database 在「导入时」就按 settings.DATABASE_URL 创建全局引擎池，
因此必须在任何 app 业务模块导入之前完成环境变量覆盖（指向独立测试库 spc_test）
并清空 get_settings 的 lru_cache。pytest 先导入 conftest 再导入测试模块，
故本文件顶部的覆盖代码天然先于所有测试模块的 app 导入执行。
"""

import json
import os
from urllib.parse import urlparse, urlunparse

from app.core.config import get_settings  # config 模块无副作用，不建引擎

TEST_DB_NAME = os.environ.get("SPC_TEST_DB", "spc_test")
TEST_PASSWORD = "test1234"

# 基线配置（来自 backend/.env.local），只用于推导测试库地址
_base = get_settings()


def _swap_db(url: str, db_name: str) -> str:
    parts = urlparse(url)
    return urlunparse(parts._replace(path=f"/{db_name}"))


os.environ["DATABASE_URL"] = _swap_db(_base.DATABASE_URL, TEST_DB_NAME)
os.environ["DATABASE_URL_SYNC"] = _swap_db(_base.DATABASE_URL_SYNC, TEST_DB_NAME)
get_settings.cache_clear()

# ---------------------------------------------------------------- 环境就绪，以下才能导入 app 模块

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

ROLES = ["admin", "quality", "purchase_manager", "manager", "finance", "general_manager", "viewer"]
# permissions 为空 dict 时 PermissionChecker 视作「角色配置异常」（not row[0]），故每个角色至少给一项
BASE_PERMS = {"dashboard": ["read"]}
# general_manager 无代码内权限加成，直接在角色行种入权限 JSON，模拟「角色管理」运行时授予路径
ROLE_PERMS = {
    code: dict(BASE_PERMS) for code in ROLES
}
ROLE_PERMS["general_manager"].update({
    "quality.supplier_claim": ["read"],
    "approval.pending": ["read"],
})
USERS = {
    "admin": "admin",
    "qa_quality": "quality",
    "qa_quality2": "quality",
    "qa_pm": "purchase_manager",
    "qa_mgr": "manager",
    "qa_fin": "finance",
    "qa_gm": "general_manager",
    "qa_viewer": "viewer",
}

DEFAULT_CHAIN = [
    {"seq": 1, "label": "索赔部门意见", "role": "purchase_manager"},
    {"seq": 2, "label": "上级部门意见", "role": "manager",
     "condition": {"field": "claim_amount", "op": ">=", "value": 1000}},
    {"seq": 3, "label": "总经理意见", "role": "general_manager",
     "condition": {"field": "claim_amount", "op": ">=", "value": 5000}},
    {"seq": 4, "label": "财务结算", "role": "finance"},
]


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def _test_db():
    """创建独立测试库 + 全量表 + 最小种子（角色/用户/默认审批链），整个测试会话复用。"""
    import asyncio

    import app.models  # noqa: F401 — 将全部模型注册到 Base.metadata
    from app.core.database import Base, engine
    from app.core.security import get_password_hash

    # 1) 经 sync 引擎连 postgres 库建测试库（与 init_database.create_database 同模式）
    sync_engine = create_engine(_swap_db(_base.DATABASE_URL_SYNC, "postgres"))
    with sync_engine.connect() as conn:
        conn.execute(text("COMMIT"))
        exists = conn.execute(
            text("SELECT 1 FROM pg_database WHERE datname = :d"), {"d": TEST_DB_NAME}
        ).fetchone()
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{TEST_DB_NAME}"'))
        conn.execute(text("COMMIT"))
    sync_engine.dispose()

    # 2) 只建本套件所需的最小表集合——全量 create_all 会被遗留模型的
    #    order_material_po_binding 非法外键（po_no 无唯一约束）卡死，且与本功能无关
    from app.models.basicdata.announcement import Notification
    from app.models.basicdata.bom import Bom
    from app.models.basicdata.data_supply import DataSupplyApiKey, DataSupplyCallLog
    from app.models.basicdata.file_asset import FileAsset
    from app.models.basicdata.user import SysRole, SysUser
    from app.models.basicdata.user_org_scope import UserOrgScope
    from app.models.exception.quality_issue import QualityIssue
    from app.models.order.sale_order import SaleOrder, SaleOrderLine
    from app.models.quality.supplier_claim import SupplierClaim, SupplierClaimApprovalLog
    tables = [
        SysRole.__table__, SysUser.__table__, UserOrgScope.__table__,
        SupplierClaim.__table__, SupplierClaimApprovalLog.__table__,
        Notification.__table__, FileAsset.__table__,
        DataSupplyApiKey.__table__, DataSupplyCallLog.__table__,
        QualityIssue.__table__, SaleOrder.__table__, SaleOrderLine.__table__, Bom.__table__,
    ]
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=tables)
        # approval_config 模型在 purchase 域（故意不导入），直接 DDL 建表
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS approval_config (
                id SERIAL PRIMARY KEY,
                biz_type VARCHAR(64) NOT NULL UNIQUE,
                biz_name VARCHAR(128),
                nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
                is_active BOOLEAN DEFAULT TRUE,
                updated_by VARCHAR(64),
                updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL
            )
        """))

    # 3) 幂等种子（upsert，重复运行不产生重复行）
    async with engine.begin() as conn:
        for code in ROLES:
            await conn.execute(text("""
                INSERT INTO sys_role (role_code, role_name, permissions)
                VALUES (:code, :code, CAST(:perms AS jsonb))
                ON CONFLICT (role_code) DO UPDATE SET role_name = EXCLUDED.role_name,
                                                     permissions = EXCLUDED.permissions
            """), {"code": code, "perms": json.dumps(ROLE_PERMS.get(code, {}))})
        rows = ",".join(f"('{u}', '{r}')" for u, r in USERS.items())
        user_rows_sql = f"""
            INSERT INTO sys_user (username, hashed_password, is_active, role_id, login_version,
                                  is_default_password, channel_sessions, font_size_scale, created_at)
            SELECT u.username, :pwd, TRUE, r.id, 1, TRUE, '{{}}'::jsonb, '1.0', NOW()
            FROM (VALUES {rows}) AS u(username, role_code)
            JOIN sys_role r ON r.role_code = u.role_code
            ON CONFLICT (username) DO UPDATE SET hashed_password = EXCLUDED.hashed_password,
                                            is_active = TRUE, role_id = EXCLUDED.role_id
        """
        await conn.execute(text(user_rows_sql), {"pwd": get_password_hash(TEST_PASSWORD)})
        await conn.execute(text("""
            INSERT INTO approval_config (biz_type, biz_name, nodes, is_active, updated_by)
            VALUES ('supplier_claim', '供应商索赔单', CAST(:nodes AS jsonb), TRUE, 'pytest')
            ON CONFLICT (biz_type) DO NOTHING
        """), {"nodes": json.dumps(DEFAULT_CHAIN)})
    yield
    await engine.dispose()


@pytest_asyncio.fixture(loop_scope="session")
async def client(_test_db):
    """每个测试独立的 ASGI 客户端；前置清空业务表，保证用例互不影响可重复运行。"""
    from app.core.database import engine
    from app.main import app

    async with engine.begin() as conn:
        await conn.execute(text(
            "TRUNCATE supplier_claim, supplier_claim_approval_log, notification, file_asset "
            "RESTART IDENTITY CASCADE"
        ))
        # 审批配置恢复默认链与启用态（配置/停用类用例会改，不能污染后续用例）
        await conn.execute(text("""
            UPDATE approval_config SET nodes = CAST(:nodes AS jsonb), is_active = TRUE
            WHERE biz_type = 'supplier_claim'
        """), {"nodes": json.dumps(DEFAULT_CHAIN)})

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture(loop_scope="session")
async def db(_test_db):
    """直查数据库用的会话（通知/引用计数等落库断言）。"""
    from app.core.database import AsyncSessionLocal

    async with AsyncSessionLocal() as session:
        yield session


# 质量对外接口测试用 HMAC Key（假凭证，rate_limit=0 绕过 Redis）
EXTERNAL_QUALITY_KEY = {"app_key": "ak_pytest_quality", "app_secret": "sk_pytest_quality"}
EXTERNAL_ORDERS_KEY = {"app_key": "ak_pytest_orders", "app_secret": "sk_pytest_orders"}


@pytest_asyncio.fixture(loop_scope="session")
async def external_keys(_test_db):
    """清空质量/数据供给表并种入两把 HMAC Key：quality（两个新接口）/ orders（未授权对照）。"""
    from app.core.database import engine

    async with engine.begin() as conn:
        await conn.execute(text(
            "TRUNCATE quality_issue, sale_order, sale_order_line, scm_bom, "
            "data_supply_api_key, data_supply_call_log RESTART IDENTITY CASCADE"
        ))
        await conn.execute(text("""
            INSERT INTO data_supply_api_key
                (key_name, api_key, is_active, allowed_endpoints_json, rate_limit,
                 app_key, app_secret, ip_whitelist_json, created_by)
            VALUES
                ('pytest-quality', 'ak_pytest_quality', TRUE,
                 '["quality_issues.list", "quality_trace.list"]', 0, :qak, :qas, NULL, 'pytest'),
                ('pytest-orders', 'ak_pytest_orders', TRUE,
                 '["orders.list"]', 0, :oak, :oas, NULL, 'pytest')
        """), {
            "qak": EXTERNAL_QUALITY_KEY["app_key"], "qas": EXTERNAL_QUALITY_KEY["app_secret"],
            "oak": EXTERNAL_ORDERS_KEY["app_key"], "oas": EXTERNAL_ORDERS_KEY["app_secret"],
        })
    yield {"quality": EXTERNAL_QUALITY_KEY, "orders": EXTERNAL_ORDERS_KEY}


@pytest_asyncio.fixture(loop_scope="session")
async def ext_client(external_keys):
    """质量对外接口用例专用 ASGI 客户端（先清表种 Key，再进入用例）。"""
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def login(client: AsyncClient, username: str, password: str = TEST_PASSWORD) -> dict:
    r = await client.post("/api/v1/basicdata/auth/login",
                          data={"username": username, "password": password, "login_type": "employee"})
    body = r.json()
    assert body.get("code") == 0, f"login {username} failed: {body}"
    return {"Authorization": f"Bearer {body['data']['access_token']}"}
