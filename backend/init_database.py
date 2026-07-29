#!/usr/bin/env python3
"""
SPC v2 Database Initialization Script
Initialize database tables and seed data for supply chain collaboration platform
"""

import asyncio
import json
import sys
from datetime import datetime, date
from pathlib import Path

# Add project root to Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from sqlalchemy import text, select
from sqlalchemy.orm import Session
from app.core.database import engine, Base, AsyncSessionLocal
from app.core.config import get_settings
from app.core.security import get_password_hash
from app.models.order.sale_order import SaleOrder, SaleOrderLine
from app.models.order.eta_update import ETAUpdate
from app.models.order.run_order import RunOrder
from app.models.material.material_demand import MaterialDemand
from app.models.material.purchase_order import PurchaseOrder
from app.models.material.binding import OrderMaterialPoBinding
from app.models.material.receipt_batch import ReceiptBatch
from app.models.material.material_issue import MaterialIssue
from app.models.material.long_lead_material import LongLeadMaterial
from app.models.material.purchase_invoice import PurchaseInvoice
from app.models.production.process_progress import ProcessProgress
from app.models.production.process_exception import ProcessException
from app.models.production.schedule_plan import ProductionSchedulePlan
from app.models.exception.risk_issue import RiskIssue
from app.models.exception.issue_log import IssueLog
from app.models.exception.change_log import ChangeLog
from app.models.exception.quality_issue import QualityIssue
from app.models.rules.risk_rule import RiskRule
from app.models.rules.inspection_rule import InspectionRule
from app.models.rules.node_standard import NodeStandard
from app.models.rules.responsibility_map import ResponsibilityMap
from app.models.rules.status_dictionary import StatusDictionary
from app.models.common.business_document import BusinessDocument, BusinessDocumentVersion
from app.models.basicdata.user import SysUser, SysRole
from app.models.basicdata.audit_log import AuditLog
from app.models.basicdata.field_mapping import FieldMapping
from app.models.basicdata.sync_sql_config import SyncSqlConfig
from app.models.basicdata.sync_log import SyncLog
from app.models.basicdata.position import Position
# from app.models.basicdata.bom import Bom
# from app.models.basicdata.bom_detail import BomDetail
# from app.models.basicdata.inventory import Inventory
from app.models.basicdata.file_asset import FileAsset
from app.models.basicdata.feedback import Feedback

settings = get_settings()


class DatabaseInitializer:
    def __init__(self):
        self.engine = engine
        self.settings = settings

    def create_database(self):
        """Create database if not exists"""
        print("Creating database...")
        try:
            # Extract database name from DATABASE_URL_SYNC
            from urllib.parse import urlparse
            db_url = urlparse(self.settings.DATABASE_URL_SYNC)
            db_name = db_url.path.lstrip('/')  # Remove leading slash

            # Connect to postgres database to create the target database
            from sqlalchemy import create_engine

            postgres_url = self.settings.DATABASE_URL_SYNC.replace(f"/{db_name}", "/postgres")
            sync_engine = create_engine(postgres_url)

            with sync_engine.connect() as conn:
                conn.execute(text("COMMIT"))  # End any transaction
                result = conn.execute(text(f"SELECT 1 FROM pg_database WHERE datname='{db_name}'"))
                if not result.fetchone():
                    conn.execute(text(f"CREATE DATABASE {db_name}"))
                    print(f"Database '{db_name}' created successfully")
                else:
                    print(f"Database '{db_name}' already exists")
                conn.close()
        except Exception as e:
            print(f"Error creating database: {e}")
            raise

    async def create_tables(self):
        """Create all tables"""
        print("Creating tables...")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        print("Tables created successfully")

    async def migrate_columns(self):
        """为已有表补充新增字段（ALTER TABLE ADD COLUMN IF NOT EXISTS）"""
        print("Checking for missing columns...")
        new_columns = {
            "sale_order": {
                "line_no": "VARCHAR(32) NOT NULL DEFAULT ''",
                "customer": "VARCHAR(128)",
                "customer_code": "VARCHAR(64)",
                "product_code": "VARCHAR(64)",
                "product_name": "VARCHAR(256)",
                "order_qty": "NUMERIC(15,2)",
                "order_amount": "NUMERIC(15,2)",
                "completed_qty": "NUMERIC(15,2)",
                "promised_date": "DATE",
                "planned_start_date": "DATE",
                "batch_no": "VARCHAR(128)",
                "department": "VARCHAR(64)",
                "audit_date": "DATE",
                "owner": "VARCHAR(64)",
                "status": "VARCHAR(32) NOT NULL DEFAULT 'open'",
                "risk_level": "VARCHAR(16)",
                "extra_data": "JSONB",
                "data_source": "VARCHAR(32)",
                "delivery_completed_date": "DATE",
                "customer_grade": "VARCHAR(16)",
                "shipping_plan": "DATE",
                "customer_inspection_date": "DATE",
                "inspection_result": "VARCHAR(64)",
                "packaging_status": "VARCHAR(128)",
                "bom_return_date": "DATE",
                "material_ready_date": "DATE",
                "shipping_status_desc": "VARCHAR(512)",
                "procurement_status": "VARCHAR(256)",
                "material_dates": "JSONB",
                "front_process_date": "DATE",
                "first_article_date": "DATE",
                "assembly_start_date": "DATE",
                "assembly_complete_date": "DATE",
                "remark": "TEXT",
                "order_date": "DATE",
                "risk_score": "NUMERIC(5,2)",
                "risk_factors": "JSONB",
                "risk_assessed_at": "TIMESTAMP",
                "is_closed": "INTEGER NOT NULL DEFAULT 0",
            },
            "sale_order_line": {
                "sale_order_id": "INTEGER REFERENCES sale_order(id)",
                "erp_line_id": "VARCHAR(64)",
                "order_no": "VARCHAR(64) NOT NULL DEFAULT ''",
                "line_no": "VARCHAR(32) NOT NULL DEFAULT ''",
                "product_code": "VARCHAR(64)",
                "product_name": "VARCHAR(256)",
                "order_qty": "NUMERIC(15,2)",
                "order_amount": "NUMERIC(15,2)",
                "promised_date": "DATE",
                "shipping_plan": "DATE",
                "planned_start_date": "DATE",
                "batch_no": "VARCHAR(128)",
                "status": "VARCHAR(32) NOT NULL DEFAULT 'open'",
            },
            "purchase_order": {
                "detail_id": "INTEGER NOT NULL DEFAULT 1",
                "order_no": "VARCHAR(64)",
                "spec_model": "VARCHAR(256)",
                "unit": "VARCHAR(32)",
                "received_qty": "NUMERIC(15,2)",
                "arrival_hour_note": "VARCHAR(256)",
                "inspection_date": "DATE",
            },
            "process_progress": {
                "product_code": "VARCHAR(64)",
                "line_no": "VARCHAR(32)",
            },
            "material_demand": {
                "data_source": "VARCHAR(32)",
                "material_property": "INTEGER",
                "material_type_name": "VARCHAR(64)",
                "spec_model": "VARCHAR(256)",
                "unit": "VARCHAR(32)",
            },
            "scm_customer": {
                "data_source": "VARCHAR(32)",
            },
            "scm_supplier": {
                "data_source": "VARCHAR(32)",
            },
            "scm_material": {
                "data_source": "VARCHAR(32)",
                "material_id": "VARCHAR(50) UNIQUE",
                "parent_id": "VARCHAR(50)",
                "is_deleted": "INTEGER DEFAULT 0",
            },
            "scm_sku": {
                "data_source": "VARCHAR(32)",
            },
            "scm_product": {
                "data_source": "VARCHAR(32)",
            },
            "scm_warehouse": {
                "wh_id": "INTEGER",
                "parent_wh_id": "INTEGER",
                "wh_attribute": "VARCHAR(10)",
                "plan_area": "VARCHAR(50)",
                "phone": "VARCHAR(30)",
                "is_workshop": "INTEGER DEFAULT 0",
                "is_deleted": "INTEGER DEFAULT 0",
                "data_source": "VARCHAR(32)",
                "updated_at": "TIMESTAMP NOT NULL DEFAULT now()",
            },
            "scm_process": {
                "data_source": "VARCHAR(32)",
            },
            "scm_organization": {
                "data_source": "VARCHAR(32)",
                "oa_org_id": "VARCHAR(64)",
            },
            "scm_position": {
                "oa_position_id": "VARCHAR(64)",
                "role_id": "INTEGER",
            },
            "scm_employee": {
                "data_source": "VARCHAR(32)",
                "oa_user_id": "VARCHAR(64) UNIQUE",
                "manager_oa_user_id": "VARCHAR(64)",
                "login_id": "VARCHAR(64)",
                "position_id": "BIGINT",
            },
            "sys_user": {
                "login_version": "INTEGER NOT NULL DEFAULT 0",
                "last_token_jti": "VARCHAR(64)",
                "last_login_time": "TIMESTAMP",
                "supplier_name": "VARCHAR(100)",
                "emp_code": "VARCHAR(20)",
                "font_size_scale": "VARCHAR(10) DEFAULT '1.0'",
                "is_default_password": "BOOLEAN NOT NULL DEFAULT TRUE",
            },
            "sys_role": {
                "org_id": "VARCHAR(64)",
                "position_id": "VARCHAR(64)",
            },
            "quality_issue": {
                "erp_quality_id": "VARCHAR(64)",
                "submit_dept": "VARCHAR(64)",
                "submit_date": "DATE",
                "submitter": "VARCHAR(64)",
                "product_code": "VARCHAR(64)",
                "product_name": "VARCHAR(128)",
                "process": "VARCHAR(64)",
                "defect_type": "VARCHAR(64)",
                "root_cause": "TEXT",
                "description": "TEXT",
                "batch_qty": "INTEGER",
                "sample_qty": "INTEGER",
                "defect_qty": "INTEGER",
            },
            "production_schedule_plan": {
                "frozen_locked_by": "VARCHAR(64)",
                "frozen_locked_at": "TIMESTAMP",
                "planned_qty": "NUMERIC(15,2)",
                "manpower": "INTEGER",
            },
            "production_schedule_operation_log": {
                "is_frozen_break": "BOOLEAN NOT NULL DEFAULT FALSE",
            },
            "approval_config": {
                "biz_name": "VARCHAR(128)",
            }
            "purchase_price_change": {
                "erp_price_snapshot": "JSONB",
                "self_check_status": "VARCHAR(16) NOT NULL DEFAULT 'pending'",
                "self_check_result": "JSONB",
                "self_check_evidence": "JSONB",
            },
            "mrp_plan_order": {
                "stock_qty": "NUMERIC(15,2)",
                "audit_date": "DATE",
            },
        }
        # 删除已废弃的列
        drop_columns = {
            "long_lead_material": ["material_name", "lead_time_days"],
            "quality_issue": [
                "year", "week_no", "department", "category", "issue_date",
                "reporter", "content", "node", "audit_person", "audit_score",
                "is_project", "material_code", "process_type", "resolved_at",
            ],
        }
        added = 0
        async with self.engine.begin() as conn:
            for table, columns in new_columns.items():
                for col, col_type in columns.items():
                    try:
                        await conn.execute(text(
                            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {col_type}"
                        ))
                        added += 1
                    except Exception as e:
                        print(f"  Column {table}.{col} skipped: {e}")
            # 删除废弃列
            for table, cols in drop_columns.items():
                for col in cols:
                    try:
                        await conn.execute(text(
                            f"ALTER TABLE {table} DROP COLUMN IF EXISTS {col}"
                        ))
                        added += 1
                    except Exception as e:
                        print(f"  Drop {table}.{col} skipped: {e}")
        print(f"Column migration completed ({added} statements executed)")

        # 确保 is_closed 列存在且类型为 integer（独立事务，避免被其他语句回滚）
        for table in ("sale_order", "purchase_order"):
            try:
                async with self.engine.begin() as conn:
                    await conn.execute(text(
                        f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS is_closed INTEGER NOT NULL DEFAULT 0"
                    ))
                async with self.engine.begin() as conn:
                    await conn.execute(text(
                        f"ALTER TABLE {table} ALTER COLUMN is_closed DROP DEFAULT"
                    ))
                    await conn.execute(text(
                        f"ALTER TABLE {table} ALTER COLUMN is_closed TYPE integer USING is_closed::integer"
                    ))
                    await conn.execute(text(
                        f"ALTER TABLE {table} ALTER COLUMN is_closed SET DEFAULT 0"
                    ))
                print(f"  {table}.is_closed ensured as integer")
            except Exception as e:
                print(f"  {table}.is_closed fix skipped: {e}")

        # 创建唯一约束
        async with self.engine.begin() as conn:
            try:
                await conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_order_line_order_erp ON sale_order_line (order_no, erp_line_id)"
                ))
                print("  Unique constraint uq_sale_order_line_order_erp ensured")
            except Exception as e:
                print(f"  Unique constraint skipped: {e}")
            try:
                await conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_issue_erp_quality_id ON quality_issue (erp_quality_id) WHERE erp_quality_id IS NOT NULL"
                ))
                print("  Unique constraint uq_quality_issue_erp_quality_id ensured")
            except Exception as e:
                print(f"  Quality issue unique constraint skipped: {e}")
            try:
                await conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_employee_oa_user_id ON scm_employee (oa_user_id) WHERE oa_user_id IS NOT NULL"
                ))
                print("  Unique constraint uq_scm_employee_oa_user_id ensured")
            except Exception as e:
                print(f"  Employee oa_user_id unique constraint skipped: {e}")
            try:
                await conn.execute(text(
                    "ALTER TABLE scm_position ALTER COLUMN position_code DROP NOT NULL"
                ))
                await conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_position_code ON scm_position (position_code)"
                ))
                await conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_position_oa_position_id ON scm_position (oa_position_id) WHERE oa_position_id IS NOT NULL"
                ))
                await conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS idx_scm_employee_position_id ON scm_employee (position_id)"
                ))
                await conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS idx_scm_position_role_id ON scm_position (role_id)"
                ))
                print("  Position indexes ensured")
            except Exception as e:
                print(f"  Position indexes skipped: {e}")

    async def rebuild_mrp_plan_order(self):
        """按 PRD 重建 mrp_plan_order 表（销售订单ID + 物料ID 联合主键）。
        若检测到旧结构（存在自增 id 列）则 DROP 后按 ORM 模型重建；
        新结构或不存在时由 create_all / checkfirst 保证幂等。
        """
        print("Checking mrp_plan_order structure...")
        async with self.engine.begin() as conn:
            result = await conn.execute(text("""
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'mrp_plan_order' AND column_name = 'id'
            """))
            is_legacy = result.fetchone() is not None
            if is_legacy:
                await conn.execute(text("DROP TABLE IF EXISTS mrp_plan_order CASCADE"))
                print("  Dropped legacy mrp_plan_order (rebuilding from model)")

        mrp_table = Base.metadata.tables.get('mrp_plan_order')
        if mrp_table is not None:
            async with self.engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all, tables=[mrp_table])
            print("  mrp_plan_order aligned (composite PK: sale_order_id + material_id)")

    async def backfill_sale_order_id(self):
        """Backfill sale_order_id on sale_order_line by matching order_no"""
        print("Backfilling sale_order_id on sale_order_line...")
        async with self.engine.begin() as conn:
            result = await conn.execute(text(
                "SELECT COUNT(*) FROM sale_order_line WHERE sale_order_id IS NULL"
            ))
            null_count = result.scalar() or 0
            if null_count > 0:
                await conn.execute(text("""
                    UPDATE sale_order_line sol
                    SET sale_order_id = so.id
                    FROM sale_order so
                    WHERE sol.sale_order_id IS NULL
                      AND sol.order_no = so.order_no
                """))
                print(f"  Backfilled {null_count} rows")
            else:
                print("  No rows need backfilling")

    async def seed_roles(self):
        """Seed / update system roles"""
        print("Seeding system roles...")
        async with AsyncSessionLocal() as session:
            try:
                roles_data = [
                    {
                        "role_code": "admin",
                        "role_name": "系统管理员",
                        "permissions": {
                            "dashboard": ["create", "read", "update", "delete"],
                            "orders.list": ["create", "read", "update", "delete", "import"],
                            "orders.run_orders": ["create", "read", "update", "delete", "import"],
                            "orders.risk_pool": ["create", "read", "update", "delete", "import"],
                            "materials.purchase_plan": ["create", "read", "update", "delete", "import"],
                            "materials.issues": ["create", "read", "update", "delete", "import"],
                            "materials.long_lead": ["create", "read", "update", "delete", "import"],
                            "materials.kit_analysis": ["create", "read", "update", "delete", "import"],
                            "materials.supplier_risk": ["create", "read", "update", "delete", "import"],
                            "materials.supplier_payment": ["create", "read", "update", "delete", "import"],
                            "production.overview": ["create", "read", "update", "delete", "import"],
                            "production.front_process": ["create", "read", "update", "delete", "import"],
                            "production.smt": ["create", "read", "update", "delete", "import"],
                            "production.lean": ["create", "read", "update", "delete", "import"],
                            "production.assembly": ["create", "read", "update", "delete", "import"],
                            "production.packaging": ["create", "read", "update", "delete", "import"],
                            "production.exceptions": ["create", "read", "update", "delete", "import"],
                            "production.schedule_plans": ["create", "read", "update", "delete"],
                            "exceptions.pool": ["create", "read", "update", "delete", "import"],
                            "exceptions.issue_log": ["create", "read", "update", "delete", "import"],
                            "exceptions.change_log": ["create", "read", "update", "delete", "import"],
                            "exceptions.quality": ["create", "read", "update", "delete", "import"],
                            "exceptions.product_samples": ["create", "read", "update", "delete"],
                            "exceptions.closure": ["create", "read", "update", "delete", "import"],
                            "meetings": ["create", "read", "update", "delete"],
                            "npi": ["create", "read", "update", "delete"],
                            "rules.risk_rules": ["create", "read", "update", "delete"],
                            "rules.inspection": ["create", "read", "update", "delete"],
                            "rules.node_standards": ["create", "read", "update", "delete"],
                            "rules.responsibility": ["create", "read", "update", "delete"],
                            "rules.status_dict": ["create", "read", "update", "delete"],
                            "rules.order_standards": ["create", "read", "update", "delete"],
                            "rules.work_instructions": ["create", "read", "update", "delete"],
                            "basicdata.import": ["create", "read", "update", "delete", "import"],
                            "basicdata.data": ["create", "read", "update", "delete", "import"],
                            "basicdata.feedback": ["create", "read", "update", "delete"],
                            "basicdata.files": ["read", "delete"],
                            "basicdata.data_supply": ["create", "read", "update", "delete"],
                            "announcements": ["create", "read", "update", "delete"],
                            "users": ["create", "read", "update", "delete"],
                            "audit": ["read"],
                            "settings": ["create", "read", "update", "delete"],
                            "topbar.share": ["read"],
                            "topbar.feedback": ["read"],
                            "topbar.ai_search": ["read"],
                            "topbar.font_size": ["read"],
                            "topbar.notifications": ["read"]
                        }
                    },
                    {
                        "role_code": "planner",
                        "role_name": "生产计划员",
                        "permissions": {
                            "dashboard": ["read"],
                            "orders.list": ["read", "update"],
                            "orders.run_orders": ["read", "update"],
                            "orders.risk_pool": ["read", "update"],
                            "orders.inventory_check": ["read", "update"],
                            "materials.purchase_plan": ["read"],
                            "materials.issues": ["read"],
                            "materials.long_lead": ["read"],
                            "materials.kit_analysis": ["read"],
                            "materials.supplier_risk": ["read"],
                            "materials.supplier_payment": ["read"],
                            "production.overview": ["read", "update", "import"],
                            "production.front_process": ["read", "update", "import"],
                            "production.smt": ["read", "update", "import"],
                            "production.lean": ["read", "update", "import"],
                            "production.assembly": ["read", "update", "import"],
                            "production.packaging": ["read", "update", "import"],
                            "production.exceptions": ["read", "update", "import"],
                            "production.schedule_plans": ["read", "update"],
                            "exceptions.pool": ["read"],
                            "exceptions.issue_log": ["read"],
                            "exceptions.change_log": ["read"],
                            "exceptions.quality": ["read"],
                            "exceptions.product_samples": ["read", "update"],
                            "exceptions.closure": ["read"],
                            "meetings": ["read"],
                            "npi": ["read"],
                            "basicdata.import": ["read"],
                            "basicdata.data": ["read"],
                            "basicdata.feedback": ["create", "read"],
                            "announcements": ["read"],
                            "audit": ["read"],
                            "topbar.share": ["read"],
                            "topbar.feedback": ["read"],
                            "topbar.ai_search": ["read"],
                            "topbar.font_size": ["read"],
                            "topbar.notifications": ["read"]
                        }
                    },
                    {
                        "role_code": "purchaser",
                        "role_name": "采购员",
                        "permissions": {
                            "dashboard": ["read"],
                            "orders.list": ["read"],
                            "orders.run_orders": ["read"],
                            "orders.risk_pool": ["read"],
                            "orders.inventory_check": ["read"],
                            "materials.purchase_plan": ["create", "read", "update", "import"],
                            "materials.issues": ["create", "read", "update", "import"],
                            "materials.long_lead": ["create", "read", "update", "import"],
                            "materials.kit_analysis": ["create", "read", "update", "import"],
                            "materials.supplier_risk": ["create", "read", "update", "import"],
                            "materials.supplier_payment": ["create", "read", "update", "import"],
                            "purchase.price_change": ["create", "read", "update"],
                            "purchase.price_change.pending": ["read"],
                            "exceptions.pool": ["read"],
                            "exceptions.issue_log": ["read"],
                            "exceptions.change_log": ["read"],
                            "exceptions.quality": ["read"],
                            "exceptions.closure": ["read"],
                            "meetings": ["read"],
                            "npi": ["read"],
                            "basicdata.import": ["read"],
                            "basicdata.data": ["read"],
                            "basicdata.feedback": ["create", "read"],
                            "announcements": ["read"],
                            "audit": ["read"],
                            "topbar.share": ["read"],
                            "topbar.feedback": ["read"],
                            "topbar.ai_search": ["read"],
                            "topbar.font_size": ["read"],
                            "topbar.notifications": ["read"]
                        }
                    },
                    {
                        "role_code": "manager",
                        "role_name": "供应链经理",
                        "permissions": {
                            "dashboard": ["read"],
                            "orders.list": ["read", "update"],
                            "orders.run_orders": ["read", "update"],
                            "orders.risk_pool": ["read", "update"],
                            "orders.inventory_check": ["read", "update"],
                            "materials.purchase_plan": ["read", "update"],
                            "materials.issues": ["read", "update"],
                            "materials.long_lead": ["read", "update"],
                            "materials.kit_analysis": ["read", "update"],
                            "materials.supplier_risk": ["read", "update"],
                            "materials.supplier_payment": ["read", "update"],
                            "production.overview": ["read", "update"],
                            "production.front_process": ["read", "update"],
                            "production.smt": ["read", "update"],
                            "production.lean": ["read", "update"],
                            "production.assembly": ["read", "update"],
                            "production.packaging": ["read", "update"],
                            "production.exceptions": ["read", "update"],
                            "exceptions.pool": ["read", "update"],
                            "exceptions.issue_log": ["read", "update"],
                            "exceptions.change_log": ["read", "update"],
                            "exceptions.quality": ["read", "update"],
                            "exceptions.closure": ["read", "update"],
                            "meetings": ["create", "read", "update", "delete"],
                            "npi": ["read"],
                            "basicdata.import": ["read"],
                            "basicdata.data": ["read"],
                            "basicdata.feedback": ["create", "read", "update"],
                            "announcements": ["read"],
                            "audit": ["read"],
                            "topbar.share": ["read"],
                            "topbar.feedback": ["read"],
                            "topbar.ai_search": ["read"],
                            "topbar.font_size": ["read"],
                            "topbar.notifications": ["read"]
                        }
                    },
                    {
                        "role_code": "purchase_manager",
                        "role_name": "采购经理",
                        "permissions": {
                            "dashboard": ["read"],
                            "orders.list": ["read"],
                            "orders.run_orders": ["read"],
                            "orders.risk_pool": ["read"],
                            "orders.inventory_check": ["read"],
                            "materials.purchase_plan": ["create", "read", "update", "delete", "import"],
                            "materials.issues": ["create", "read", "update", "delete", "import"],
                            "materials.long_lead": ["create", "read", "update", "delete", "import"],
                            "materials.kit_analysis": ["create", "read", "update", "delete", "import"],
                            "materials.supplier_risk": ["create", "read", "update", "delete", "import"],
                            "materials.supplier_payment": ["create", "read", "update", "delete", "import"],
                            "purchase.price_change": ["create", "read", "update", "delete"],
                            "purchase.price_change.pending": ["read"],
                            "purchase.price_change.config": ["create", "read", "update", "delete"],
                            "exceptions.pool": ["read", "update"],
                            "exceptions.issue_log": ["read", "update"],
                            "exceptions.change_log": ["read", "update"],
                            "exceptions.quality": ["read", "update"],
                            "exceptions.closure": ["read", "update"],
                            "meetings": ["read"],
                            "npi": ["read"],
                            "basicdata.import": ["read"],
                            "basicdata.data": ["read"],
                            "basicdata.feedback": ["create", "read", "update"],
                            "announcements": ["read"],
                            "audit": ["read"],
                            "topbar.share": ["read"],
                            "topbar.feedback": ["read"],
                            "topbar.ai_search": ["read"],
                            "topbar.font_size": ["read"],
                            "topbar.notifications": ["read"]
                        }
                    },
                    {
                        "role_code": "supplier",
                        "role_name": "供应商",
                        "permissions": {
                            "materials.purchase_plan": ["read"],
                            "materials.supplier_risk": ["read"],
                            "topbar.font_size": ["read"],
                            "topbar.notifications": ["read"],
                        }
                    }
                ]

                for role_data in roles_data:
                    existing = await session.execute(
                        select(SysRole).where(SysRole.role_code == role_data["role_code"])
                    )
                    role = existing.scalar_one_or_none()
                    if role:
                        role.role_name = role_data["role_name"]
                        role.permissions = role_data["permissions"]
                    else:
                        session.add(SysRole(**role_data))

                await session.commit()
                print("System roles seeded/updated successfully")

            except Exception as e:
                await session.rollback()
                print(f"Error seeding roles: {e}")
                raise

    async def seed_users(self):
        """Seed / update system users"""
        print("Seeding system users...")
        async with AsyncSessionLocal() as session:
            try:
                # Get role IDs
                admin_role = await session.execute(text("SELECT id FROM sys_role WHERE role_code = 'admin'"))
                planner_role = await session.execute(text("SELECT id FROM sys_role WHERE role_code = 'planner'"))
                purchaser_role = await session.execute(text("SELECT id FROM sys_role WHERE role_code = 'purchaser'"))
                manager_role = await session.execute(text("SELECT id FROM sys_role WHERE role_code = 'manager'"))
                purchase_manager_role = await session.execute(text("SELECT id FROM sys_role WHERE role_code = 'purchase_manager'"))

                default_password = get_password_hash("admin123")
                users_data = [
                    {
                        "username": "admin",
                        "display_name": "系统管理员",
                        "hashed_password": default_password,
                        "role_id": admin_role.scalar()
                    },
                    {
                        "username": "planner01",
                        "display_name": "计划员01",
                        "hashed_password": default_password,
                        "role_id": planner_role.scalar()
                    },
                    {
                        "username": "purchaser01",
                        "display_name": "采购员01",
                        "hashed_password": default_password,
                        "role_id": purchaser_role.scalar()
                    },
                    {
                        "username": "manager01",
                        "display_name": "供应链经理",
                        "hashed_password": default_password,
                        "role_id": manager_role.scalar()
                    },
                    {
                        "username": "purchase_mgr01",
                        "display_name": "采购经理",
                        "hashed_password": default_password,
                        "role_id": purchase_manager_role.scalar()
                    }
                ]

                for user_data in users_data:
                    existing = await session.execute(
                        select(SysUser).where(SysUser.username == user_data["username"])
                    )
                    user = existing.scalar_one_or_none()
                    if user:
                        user.display_name = user_data["display_name"]
                        user.role_id = user_data["role_id"]
                    else:
                        session.add(SysUser(**user_data))

                await session.commit()
                print("System users seeded/updated successfully")

            except Exception as e:
                await session.rollback()
                print(f"Error seeding users: {e}")
                raise


    async def seed_risk_rules(self):
        """Seed risk rules"""
        print("Seeding risk rules...")
        async with AsyncSessionLocal() as session:
            try:
                # Check if rules already exist
                result = await session.execute(text("SELECT COUNT(*) FROM risk_rule"))
                if result.scalar() > 0:
                    print("Risk rules already exist, skipping...")
                    return

                rules_data = [
                    # ── 6 评分因子规则 ──
                    {
                        "rule_code": "DELIVERY_DELAY_HIGH",
                        "rule_name": "交期延期-高风险",
                        "rule_type": "delivery_delay",
                        "condition_json": {"delay_days_gt": 7},
                        "risk_level": "red",
                        "created_by": "admin"
                    },
                    {
                        "rule_code": "DELIVERY_DELAY_MEDIUM",
                        "rule_name": "交期延期-中风险",
                        "rule_type": "delivery_delay",
                        "condition_json": {"delay_days_gt": 3, "delay_days_lte": 7},
                        "risk_level": "yellow",
                        "created_by": "admin"
                    },
                    {
                        "rule_code": "SHORTAGE_HIGH",
                        "rule_name": "欠料风险-高风险",
                        "rule_type": "shortage",
                        "condition_json": {"shortage_qty_gt": 100},
                        "risk_level": "red",
                        "created_by": "admin"
                    },
                    {
                        "rule_code": "SHORTAGE_MEDIUM",
                        "rule_name": "欠料风险-中风险",
                        "rule_type": "shortage",
                        "condition_json": {"shortage_qty_gt": 50, "shortage_qty_lte": 100},
                        "risk_level": "yellow",
                        "created_by": "admin"
                    },
                    {
                        "rule_code": "ETA_DELAY_HIGH",
                        "rule_name": "ETA延期-高风险",
                        "rule_type": "eta_delay",
                        "condition_json": {"delay_days_gt": 14},
                        "risk_level": "red",
                        "created_by": "admin"
                    },
                    {
                        "rule_code": "ETA_DELAY_MEDIUM",
                        "rule_name": "ETA延期-中风险",
                        "rule_type": "eta_delay",
                        "condition_json": {"delay_days_gt": 7, "delay_days_lte": 14},
                        "risk_level": "yellow",
                        "created_by": "admin"
                    },
                    {
                        "rule_code": "PROCESS_LAG_HIGH",
                        "rule_name": "工序滞后-高风险",
                        "rule_type": "process_lag",
                        "condition_json": {"threshold_days": 3},
                        "risk_level": "red",
                        "created_by": "admin"
                    },
                    {
                        "rule_code": "QUALITY_RULE",
                        "rule_name": "品质异常-预警",
                        "rule_type": "quality",
                        "condition_json": {"open_count_gt": 0},
                        "risk_level": "yellow",
                        "created_by": "admin"
                    },
                    {
                        "rule_code": "INSPECTION_NG_RULE",
                        "rule_name": "客检NG-预警",
                        "rule_type": "inspection_ng",
                        "condition_json": None,
                        "risk_level": "red",
                        "created_by": "admin"
                    },
                    # ── 2 监控规则 ──
                    {
                        "rule_code": "HOLIDAY_RISK_MAY",
                        "rule_name": "五一假期风险",
                        "rule_type": "holiday_risk",
                        "condition_json": {"holiday_months": [5, 10], "threshold_days": 7},
                        "risk_level": "yellow",
                        "created_by": "admin"
                    },
                    {
                        "rule_code": "LONG_LEAD_90",
                        "rule_name": "长周期物料-90天",
                        "rule_type": "long_lead",
                        "condition_json": {"threshold_days": 90},
                        "risk_level": "yellow",
                        "created_by": "admin"
                    },
                ]

                for rule_data in rules_data:
                    rule = RiskRule(**rule_data)
                    session.add(rule)

                await session.commit()
                print("Risk rules seeded successfully")

            except Exception as e:
                await session.rollback()
                print(f"Error seeding risk rules: {e}")
                raise

    async def seed_field_mapping(self):
        """Seed field mapping configuration"""
        print("Seeding field mapping...")
        async with AsyncSessionLocal() as session:
            try:
                # Check if mappings already exist
                result = await session.execute(text("SELECT COUNT(*) FROM field_mapping"))
                if result.scalar() > 0:
                    print("Field mappings already exist, skipping...")
                    return

                mappings_data = [
                    # ERP Order mappings
                    {
                        "source_system": "erp",
                        "source_field": "ORDER_ID",
                        "target_field": "order_no",
                        "description": "ERP Order ID to order_no",
                        "created_by": "admin"
                    },
                    {
                        "source_system": "erp",
                        "source_field": "LINE_NUM",
                        "target_field": "line_no",
                        "description": "Order line number",
                        "created_by": "admin"
                    },
                    {
                        "source_system": "erp",
                        "source_field": "CUST_NAME",
                        "target_field": "customer",
                        "description": "Customer name",
                        "created_by": "admin"
                    },
                    {
                        "source_system": "erp",
                        "source_field": "PRODUCT_CODE",
                        "target_field": "product_code",
                        "description": "Product/SKU code",
                        "created_by": "admin"
                    },
                    # SRM PO mappings
                    {
                        "source_system": "srm",
                        "source_field": "PO_NUMBER",
                        "target_field": "po_no",
                        "description": "SRM PO number",
                        "created_by": "admin"
                    },
                    {
                        "source_system": "srm",
                        "source_field": "MATERIAL_CODE",
                        "target_field": "material_code",
                        "description": "Material code",
                        "created_by": "admin"
                    },
                    {
                        "source_system": "srm",
                        "source_field": "SUPPLIER_CODE",
                        "target_field": "supplier_code",
                        "description": "Supplier code",
                        "created_by": "admin"
                    }
                ]

                for mapping_data in mappings_data:
                    mapping = FieldMapping(**mapping_data)
                    session.add(mapping)

                await session.commit()
                print("Field mapping seeded successfully")

            except Exception as e:
                await session.rollback()
                print(f"Error seeding field mapping: {e}")
                raise

    async def seed_normal_order_standards(self):
        """Seed normal order delivery and material kit readiness standards."""
        print("Seeding normal order standards...")
        content = """21、订单总交付标准周期为31天，供应链内部交付期为28天。其中物料采购周期为20天，组、包装车间周期为5天，前道车间、光电车间、品质部检验包含在供应链内部交付期合理安排。这个是正常订单的标准，特殊的就可以手动调整。

24、物料齐套装配车间标准：组装7天齐套，包装包材3天齐套。同时执行包材提前送大货样进行检验，成品支架提前3天送大货样进行检验，合格后待通知送货。"""

        async with AsyncSessionLocal() as session:
            try:
                await session.execute(text("""
                    INSERT INTO node_standard (
                        node_code,
                        node_name,
                        time_value,
                        time_unit,
                        applicable_scene,
                        description,
                        is_active,
                        created_by
                    )
                    VALUES
                        ('NORMAL_ORDER_TOTAL_DELIVERY', '正常订单总交付标准周期', 31, '天', '通用', '订单总交付标准周期为31天', true, 'admin'),
                        ('SUPPLY_CHAIN_INTERNAL_DELIVERY', '供应链内部交付期', 28, '天', '通用', '供应链内部交付期为28天', true, 'admin'),
                        ('MATERIAL_PROCUREMENT_CYCLE', '物料采购周期', 20, '天', '通用', '物料采购周期为20天', true, 'admin'),
                        ('ASSEMBLY_PACKAGING_WORKSHOP_CYCLE', '组、包装车间周期', 5, '天', '通用', '组、包装车间周期为5天', true, 'admin'),
                        ('ASSEMBLY_MATERIAL_KIT_READY', '组装齐套标准', 7, '天', '通用', '组装7天齐套', true, 'admin'),
                        ('PACKAGING_MATERIAL_KIT_READY', '包装包材齐套标准', 3, '天', '通用', '包装包材3天齐套', true, 'admin'),
                        ('FINISHED_BRACKET_SAMPLE_INSPECTION_ADVANCE', '成品支架大货样检验提前期', 3, '天', '通用', '成品支架提前3天送大货样进行检验', true, 'admin')
                    ON CONFLICT (node_code) DO UPDATE
                    SET node_name = EXCLUDED.node_name,
                        time_value = EXCLUDED.time_value,
                        time_unit = EXCLUDED.time_unit,
                        applicable_scene = EXCLUDED.applicable_scene,
                        description = EXCLUDED.description,
                        is_active = EXCLUDED.is_active,
                        created_by = COALESCE(node_standard.created_by, EXCLUDED.created_by),
                        updated_at = now()
                """))

                await session.execute(text("""
                    WITH upserted_document AS (
                        INSERT INTO business_document (
                            doc_type,
                            code,
                            title,
                            applicable_product,
                            applicable_order,
                            applicable_process,
                            current_version,
                            status,
                            created_by
                        )
                        VALUES (
                            'order_standard',
                            'STD-NORMAL-ORDER-DELIVERY',
                            '正常订单交付与物料齐套标准',
                            NULL,
                            '正常订单',
                            NULL,
                            'V1.0',
                            'published',
                            'admin'
                        )
                        ON CONFLICT (doc_type, code) DO UPDATE
                        SET title = EXCLUDED.title,
                            applicable_product = EXCLUDED.applicable_product,
                            applicable_order = EXCLUDED.applicable_order,
                            applicable_process = EXCLUDED.applicable_process,
                            current_version = EXCLUDED.current_version,
                            status = EXCLUDED.status,
                            updated_at = now()
                        RETURNING id
                    )
                    INSERT INTO business_document_version (
                        document_id,
                        version_no,
                        content,
                        attachments,
                        status,
                        effective_date,
                        published_at,
                        published_by,
                        created_by
                    )
                    SELECT
                        id,
                        'V1.0',
                        :content,
                        '[]'::jsonb,
                        'published',
                        DATE '2026-06-09',
                        now(),
                        'admin',
                        'admin'
                    FROM upserted_document
                    ON CONFLICT (document_id, version_no) DO UPDATE
                    SET content = EXCLUDED.content,
                        attachments = EXCLUDED.attachments,
                        status = EXCLUDED.status,
                        effective_date = EXCLUDED.effective_date,
                        published_at = COALESCE(business_document_version.published_at, EXCLUDED.published_at),
                        published_by = EXCLUDED.published_by,
                        updated_at = now()
                """), {"content": content})

                await session.commit()
                print("Normal order standards seeded successfully")

            except Exception as e:
                await session.rollback()
                print(f"Error seeding normal order standards: {e}")
                raise

    async def seed_sample_data(self):
        """Seed comprehensive sample data for dashboard visualization"""
        print("Seeding sample business data...")
        async with AsyncSessionLocal() as session:
            try:
                result = await session.execute(text("SELECT COUNT(*) FROM sale_order"))
                if result.scalar() > 0:
                    print("Sample data already exists, skipping...")
                    return

                # ============================================================
                # 订单行 — 3 条示例数据 (红/黄/绿)
                # ============================================================
                orders_data = [
                    # --- 红色高风险 ---
                    {"order_no": "SO-2026-001", "line_no": "10", "customer": "华为技术", "customer_code": "C-HW001", "product_code": "P001", "product_name": "5G基站滤波器", "order_qty": 5000, "promised_date": date(2026, 4, 15), "planned_start_date": date(2026, 4, 1), "department": "销售一部", "audit_date": date(2026, 3, 10), "batch_no": "P001-HW-001-01", "owner": "planner01", "status": "open", "risk_level": "red", "data_source": "erp"},
                    # --- 黄色中风险 ---
                    {"order_no": "SO-2026-006", "line_no": "10", "customer": "大疆创新", "customer_code": "C-DJI01", "product_code": "P006", "product_name": "飞控主板", "order_qty": 1200, "promised_date": date(2026, 5, 5), "planned_start_date": date(2026, 4, 20), "department": "销售一部", "audit_date": date(2026, 3, 25), "batch_no": "P006-DJI-001-01", "owner": "planner01", "status": "open", "risk_level": "yellow", "data_source": "erp"},
                    # --- 绿色正常 ---
                    {"order_no": "SO-2026-011", "line_no": "10", "customer": "海康威视", "customer_code": "C-HIK01", "product_code": "P012", "product_name": "网络硬盘录像机", "order_qty": 2000, "promised_date": date(2026, 5, 25), "planned_start_date": date(2026, 5, 8), "department": "销售三部", "audit_date": date(2026, 4, 8), "batch_no": "P012-HIK-002-01", "owner": "planner01", "status": "open", "risk_level": "green", "data_source": "erp"},
                ]

                for d in orders_data:
                    header_data = {
                        "order_no": d["order_no"],
                        "customer": d.get("customer"),
                        "customer_code": d.get("customer_code"),
                        "department": d.get("department"),
                        "audit_date": d.get("audit_date"),
                        "owner": d.get("owner"),
                        "status": d.get("status", "open"),
                        "risk_level": d.get("risk_level"),
                        "data_source": d.get("data_source"),
                    }
                    order_obj = SaleOrder(**header_data)
                    session.add(order_obj)
                    await session.flush()  # get order_obj.id

                    line_data = {
                        "sale_order_id": order_obj.id,
                        "order_no": d["order_no"],
                        "line_no": d["line_no"],
                        "product_code": d.get("product_code"),
                        "product_name": d.get("product_name"),
                        "order_qty": d.get("order_qty"),
                        "promised_date": d.get("promised_date"),
                        "planned_start_date": d.get("planned_start_date"),
                        "batch_no": d.get("batch_no"),
                        "status": d.get("status", "open"),
                    }
                    session.add(SaleOrderLine(**line_data))

                await session.flush()

                # ============================================================
                # 物料需求 — 仅保留 3 个订单的物料
                # ============================================================
                materials_data = [
                    # SO-001 (红)
                    {"order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-PCB-001", "material_name": "高频PCB板", "req_qty": 5000, "req_date": date(2026, 3, 25), "allocated_qty": 2000, "shortage_qty": 3000, "shortage_flag": True},
                    {"order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-IC-001", "material_name": "射频芯片 QFN48", "req_qty": 5000, "req_date": date(2026, 3, 28), "allocated_qty": 1000, "shortage_qty": 4000, "shortage_flag": True},
                    {"order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-CON-001", "material_name": "SMA连接器", "req_qty": 10000, "req_date": date(2026, 3, 28), "allocated_qty": 10000, "shortage_qty": 0, "shortage_flag": False},
                    # SO-006 (黄)
                    {"order_no": "SO-2026-006", "line_no": "10", "material_code": "MC-IC-004", "material_name": "IMU传感器 6轴", "req_qty": 1200, "req_date": date(2026, 4, 12), "allocated_qty": 800, "shortage_qty": 400, "shortage_flag": True},
                    {"order_no": "SO-2026-006", "line_no": "10", "material_code": "MC-PCB-002", "material_name": "8层HDI板", "req_qty": 1200, "req_date": date(2026, 4, 12), "allocated_qty": 1200, "shortage_qty": 0, "shortage_flag": False},
                    # SO-011 (绿)
                    {"order_no": "SO-2026-011", "line_no": "10", "material_code": "MC-HDD-001", "material_name": "企业级硬盘 4TB", "req_qty": 8000, "req_date": date(2026, 5, 1), "allocated_qty": 8000, "shortage_qty": 0, "shortage_flag": False},
                ]

                for d in materials_data:
                    session.add(MaterialDemand(**d))

                await session.flush()

                # ============================================================
                # 采购订单 — 仅保留 6 个订单的物料对应的 PO
                # ============================================================
                po_data = [
                    {"po_no": "PO-2026-001", "material_code": "MC-IC-001", "supplier_code": "S-QCOM", "supplier_name": "高通半导体", "material_type_name": "芯片", "material_name": "射频芯片 QFN48", "po_qty": 4000, "po_price": 12.5, "po_date": date(2026, 3, 20), "po_status": "placed", "eta": date(2026, 4, 28), "original_eta": date(2026, 4, 20), "owner": "purchaser01", "data_source": "erp"},
                    {"po_no": "PO-2026-007", "material_code": "MC-IC-004", "supplier_code": "S-INV", "supplier_name": "InvenSense", "material_type_name": "芯片", "material_name": "IMU传感器 6轴", "po_qty": 400, "po_price": 22.0, "po_date": date(2026, 3, 18), "po_status": "accepted", "eta": date(2026, 4, 22), "original_eta": date(2026, 4, 18), "owner": "purchaser01", "data_source": "erp"},
                    {"po_no": "PO-2026-010", "material_code": "MC-PCB-001", "supplier_code": "S-SLPCB", "supplier_name": "深南电路", "material_type_name": "PCB", "material_name": "高频PCB板", "po_qty": 3000, "po_price": 25.0, "po_date": date(2026, 3, 12), "po_status": "in_production", "eta": date(2026, 4, 18), "original_eta": date(2026, 4, 12), "owner": "purchaser01", "data_source": "erp"},
                    {"po_no": "PO-2026-017", "material_code": "MC-CON-001", "supplier_code": "S-AMP2", "supplier_name": "安费诺连接器", "material_type_name": "连接器", "material_name": "SMA连接器", "po_qty": 10000, "po_price": 1.5, "po_date": date(2026, 3, 8), "po_status": "shipped", "eta": date(2026, 4, 9), "original_eta": date(2026, 4, 8), "owner": "purchaser01", "data_source": "erp"},
                    {"po_no": "PO-2026-019", "material_code": "MC-PCB-002", "supplier_code": "S-SLPCB", "supplier_name": "深南电路", "material_type_name": "PCB", "material_name": "8层HDI板", "po_qty": 1200, "po_price": 45.0, "po_date": date(2026, 3, 8), "po_status": "partial_received", "eta": date(2026, 4, 8), "original_eta": date(2026, 4, 8), "actual_arrival_date": date(2026, 4, 8), "owner": "purchaser01", "data_source": "erp"},
                    {"po_no": "PO-2026-021", "material_code": "MC-HDD-001", "supplier_code": "S-WD", "supplier_name": "西部数据", "material_type_name": "存储", "material_name": "企业级硬盘 4TB", "po_qty": 8000, "po_price": 85.0, "po_date": date(2026, 3, 1), "po_status": "received", "eta": date(2026, 4, 1), "original_eta": date(2026, 4, 1), "actual_arrival_date": date(2026, 4, 1), "owner": "purchaser01", "data_source": "erp"},
                ]

                for d in po_data:
                    session.add(PurchaseOrder(**d))

                await session.flush()

                # ============================================================
                # 绑定关系 — 仅保留 3 个订单的绑定
                # ============================================================
                from app.models.material.binding import OrderMaterialPoBinding
                bindings_data = [
                    {"order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-PCB-001", "po_no": "PO-2026-010", "bound_qty": 3000, "bind_status": "bound", "bind_source": "auto_rule"},
                    {"order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-IC-001", "po_no": "PO-2026-001", "bound_qty": 4000, "bind_status": "bound", "bind_source": "auto_rule"},
                    {"order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-CON-001", "po_no": "PO-2026-017", "bound_qty": 10000, "bind_status": "bound", "bind_source": "auto_rule"},
                    {"order_no": "SO-2026-006", "line_no": "10", "material_code": "MC-IC-004", "po_no": "PO-2026-007", "bound_qty": 400, "bind_status": "bound", "bind_source": "auto_rule"},
                    {"order_no": "SO-2026-006", "line_no": "10", "material_code": "MC-PCB-002", "po_no": "PO-2026-019", "bound_qty": 1200, "bind_status": "bound", "bind_source": "auto_rule"},
                    {"order_no": "SO-2026-011", "line_no": "10", "material_code": "MC-HDD-001", "po_no": "PO-2026-021", "bound_qty": 8000, "bind_status": "bound", "bind_source": "auto_rule"},
                ]

                for d in bindings_data:
                    session.add(OrderMaterialPoBinding(**d))

                await session.flush()

                # ============================================================
                # 异常问题 — 仅保留 3 个订单的异常
                # ============================================================
                _seed_date = "20260415"
                issues_data = [
                    # delivery_delay
                    {"issue_no": f"DD-{_seed_date}-0001", "issue_type": "delivery_delay", "risk_level": "red", "order_no": "SO-2026-001", "description": "交期延期8天，承诺4/15未交付", "owner": "planner01", "status": "open"},
                    # shortage
                    {"issue_no": f"SH-{_seed_date}-0001", "issue_type": "shortage", "risk_level": "red", "order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-PCB-001", "description": "高频PCB板欠料3000片", "owner": "planner01", "status": "open"},
                    {"issue_no": f"SH-{_seed_date}-0002", "issue_type": "shortage", "risk_level": "red", "order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-IC-001", "description": "射频芯片欠料4000片", "owner": "planner01", "status": "open"},
                    {"issue_no": f"SH-{_seed_date}-0003", "issue_type": "shortage", "risk_level": "yellow", "order_no": "SO-2026-006", "line_no": "10", "material_code": "MC-IC-004", "description": "IMU传感器欠料400片", "owner": "planner01", "status": "open"},
                    # eta_delay
                    {"issue_no": f"ED-{_seed_date}-0001", "issue_type": "eta_delay", "risk_level": "red", "order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-IC-001", "po_no": "PO-2026-001", "description": "射频芯片ETA延期8天，原4/20改为4/28", "owner": "purchaser01", "status": "open"},
                    # process_lag
                    {"issue_no": f"PL-{_seed_date}-0001", "issue_type": "process_lag", "risk_level": "red", "order_no": "SO-2026-001", "description": "贴片工序卡点，等待物料到位", "owner": "production01", "status": "open"},
                    # quality
                    {"issue_no": f"QL-{_seed_date}-0001", "issue_type": "quality", "risk_level": "yellow", "order_no": "SO-2026-006", "description": "IMU传感器来料不良2条品质异常未关闭", "owner": "quality01", "status": "open"},
                    # inspection_ng
                    {"issue_no": f"IN-{_seed_date}-0001", "issue_type": "inspection_ng", "risk_level": "red", "order_no": "SO-2026-011", "description": "客检结果NG，需返工处理", "owner": "quality01", "status": "open"},
                    # holiday_risk
                    {"issue_no": f"HR-{_seed_date}-0001", "issue_type": "holiday_risk", "risk_level": "yellow", "order_no": "SO-2026-001", "line_no": "10", "material_code": "MC-PCB-001", "po_no": "PO-2026-010", "description": "深南电路五一假期停产7天，影响PCB交付", "owner": "planner01", "status": "open"},
                    # long_lead
                    {"issue_no": f"LL-{_seed_date}-0001", "issue_type": "long_lead", "risk_level": "yellow", "material_code": "MC-IC-001", "description": "射频芯片交期120天超过阈值90天", "owner": "purchaser01", "status": "open"},
                ]

                for d in issues_data:
                    session.add(RiskIssue(**d))

                await session.commit()
                print(f"Sample data seeded: {len(orders_data)} orders, {len(materials_data)} materials, {len(po_data)} POs, {len(bindings_data)} bindings, {len(issues_data)} issues")

            except Exception as e:
                await session.rollback()
                print(f"Error seeding sample data: {e}")
                raise

    async def seed_sync_sql_config(self):
        """Seed ERP sync SQL configuration templates (upsert missing types)"""
        print("Seeding sync SQL config...")
        async with AsyncSessionLocal() as session:
            try:
                from app.models.basicdata.sync_sql_config import SyncSqlConfig
                import json

                # 查询已存在的 sync_type，只插入缺失的
                existing = await session.execute(select(SyncSqlConfig.sync_type))
                existing_types = set(existing.scalars().all())

                configs = [
                    SyncSqlConfig(
                        sync_type="orders",
                        description="订单行数据 — 从ERP销售订单表拉取",
                        sql_text="""select ROW_NUMBER()Over(ORDER BY FContractNo)  as rowId,FContractNo 销售合同单号,FContractName 客户名称,b.FEntryID 订单行号,f.FNumber  客户,c.FNumber 产品代码,c.FName 产品名称,b.FQuantity 订单数量,d.FName 部门,a.FCheckDate 审核日期,b.FDELIVERYDate 交期,b.FText23 批号
 
from k3sv.AIS20161019115614.dbo.t_RPContract a --销售合同主表
left join k3sv.AIS20161019115614.dbo.t_rpContractEntry b on a.FContractID =b.FContractID  --销售合同明细
left JOIN k3sv.AIS20161019115614.dbo.t_ICItem  c on b.FProductID =c.FItemID  --物料表获取物料名称
left join k3sv.AIS20161019115614.dbo.t_Department d on a.FDepartment =d.FItemID  --部门表
left join k3sv.AIS20161019115614.dbo.t_SubMessage e on b.FBase3 =e.FInterID --关联产品象限
left join k3sv.AIS20161019115614.dbo.t_Organization f on a.FCustomer=f.FItemID --关联客户表
 where  a.FChangeMark =0 and a.FText not like'%取消%'AND d.FName<>'研发中心'  --一般我们计算中不获取研发合同，只计算销售下单合同，销售可能存在订单变更或取消，所以过滤未取消订单

 and YEAR(a.FCheckDate)=2026

   order by ROW_NUMBER()Over(ORDER BY FContractNo),FContractNo ,YEAR(a.FCheckDate),month(a.FCheckDate),d.FName,c.FNumber,b.FDELIVERYDate desc
   """.strip(),
                        field_mapping_json=json.dumps({
  "销售合同单号": "order_no",
  "订单行号": "line_no",
  "客户": "customer_code",
  "产品代码": "product_code",
  "产品名称": "product_name",
  "订单数量": "order_qty",
  "部门": "department",
  "审核日期": "audit_date",
  "交期": "promised_date",
  "批号": "batch_no",
  "客户名称": "customer"
}),
                        is_active=True,
                        sync_enabled=True,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="materials",
                        description="物料需求数据 — 从ERP的MRP运算结果拉取",
                        sql_text="""
SELECT
    CAST(mr.FOrderNo AS VARCHAR(64))       AS order_no,
    CAST(mr.FLineNo AS VARCHAR(32))        AS line_no,
    CAST(mr.FMaterialCode AS VARCHAR(64))  AS material_code,
    CAST(mat.FName AS VARCHAR(256))        AS material_name,
    CAST(mr.FReqQty AS DECIMAL(15,2))      AS req_qty,
    CAST(mr.FReqDate AS DATE)              AS req_date,
    CAST(mr.FAllocQty AS DECIMAL(15,2))    AS allocated_qty,
    mr.FModifyDate                         AS erp_updated_at
FROM T_PLN_MRPRESULT mr
LEFT JOIN T_BD_MATERIAL mat ON mr.FMaterialCode = mat.FNumber
WHERE mr.FModifyDate >= :since
ORDER BY mr.FOrderNo, mr.FLineNo, mr.FMaterialCode
                        """.strip(),
                        field_mapping_json=None,
                        is_active=True,
                        sync_enabled=True,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="purchase_orders",
                        description="采购订单数据 — 从ERP采购订单表拉取",
                        sql_text="""
SELECT
    CAST(po.FBillNo AS VARCHAR(64))        AS po_no,
    CAST(poe.FMaterialCode AS VARCHAR(64)) AS material_code,
    CAST(sup.FNumber AS VARCHAR(64))       AS supplier_code,
    CAST(sup.FName AS VARCHAR(256))        AS supplier_name,
    CAST(poe.FQty AS DECIMAL(15,2))        AS po_qty,
    CASE
        WHEN poe.FReceivedQty >= poe.FQty THEN 'received'
        WHEN poe.FReceivedQty > 0 THEN 'partial_received'
        WHEN po.FConfirmStatus = 'B' THEN 'accepted'
        ELSE 'placed'
    END                                    AS po_status,
    CAST(poe.FDeliveryDate AS DATE)        AS eta,
    CAST(poe.FOrigDeliveryDate AS DATE)    AS original_eta,
    CAST(poe.FActualDate AS DATE)          AS actual_arrival_date,
    CAST(po.FBuyer AS VARCHAR(64))         AS owner,
    poe.FModifyDate                        AS erp_updated_at
FROM T_PUR_ORDER po
JOIN T_PUR_ORDERENTRY poe ON po.FID = poe.FID
LEFT JOIN T_BD_SUPPLIER sup ON po.FSupplierId = sup.FSupplierId
WHERE poe.FModifyDate >= :since
ORDER BY po.FBillNo
                        """.strip(),
                        field_mapping_json=None,
                        is_active=True,
                        sync_enabled=True,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="mrp_plan_orders",
                        description="MRP计划订单 — 从K3 ICMrpResult拉取（字段对齐新表结构，部分K3源列待确认）",
                        sql_text="""
SELECT
    CAST(so.FID AS INT)                   AS sale_order_id,
    CAST(mat.FItemID AS VARCHAR(50))      AS material_id,
    CAST(so.FBillNo AS VARCHAR(64))       AS sale_order_no,
    CAST(mat.FNumber AS VARCHAR(64))      AS material_code,
    CAST(mat.FName AS VARCHAR(256))       AS material_name,
    CAST(mat.FErpClsID AS INT)            AS material_property,
    CAST(mat.FUnitID AS VARCHAR(50))      AS unit_id,
    CAST(unit.FName AS VARCHAR(64))       AS unit_name,
    CAST(mr.FPlanQty AS DECIMAL(15,2))    AS base_plan_qty,
    CAST(mr.FDate AS DATETIME)            AS mrp_run_time,
    CAST(mr.FNeedDate AS DATE)            AS need_date,
    CASE WHEN mr.FStatus IN (2,3) THEN 1 ELSE 0 END AS is_closed,
    CASE WHEN mr.FStatus IN (2,3) THEN 0 ELSE NULL END AS close_type,
    CAST(mr.FOrderType AS INT)            AS bill_type,
    mr.FModifyDate                        AS erp_updated_at
FROM ICMrpResult mr
LEFT JOIN t_ICItem mat ON mr.FMaterialId = mat.FItemID
LEFT JOIN t_MeasureUnit unit ON mat.FUnitID = unit.FItemID
LEFT JOIN T_SAL_ORDER so ON so.FBillNo = mr.FSaleOrderNo
WHERE mr.FModifyDate >= :since
ORDER BY so.FID, mat.FItemID
                        """.strip(),
                        field_mapping_json=None,
                        is_active=True,
                        sync_enabled=True,
                        created_by="admin",
                    ),
                    # ---- 基础数据同步配置（占位，需根据实际 ERP 表结构配置 SQL 后启用） ----
                    SyncSqlConfig(
                        sync_type="customers",
                        description="客户 — 从ERP客户表拉取",
                        sql_text="SELECT customer_code, customer_name, customer_short, customer_level, industry_type, credit_code, status FROM T_BD_CUSTOMER WHERE FModifyDate >= :since ORDER BY customer_code",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1d",
                        sync_strategy="incremental",
                        sync_priority=10,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="suppliers",
                        description="供应商 — 从ERP供应商表拉取",
                        sql_text="SELECT supplier_code, supplier_name, supplier_short, supplier_type, contact_person, contact_phone, payment_terms, status FROM T_BD_SUPPLIER WHERE FModifyDate >= :since ORDER BY supplier_code",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1d",
                        sync_strategy="incremental",
                        sync_priority=11,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="materials_masterdata",
                        description="物料 — 从ERP物料主表拉取",
                        sql_text="SELECT material_code, material_name, spec_model, material_type, unit_of_measure, brand, is_purchase, is_produce, status FROM T_BD_MATERIAL WHERE FModifyDate >= :since ORDER BY material_code",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1d",
                        sync_strategy="incremental",
                        sync_priority=12,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="skus",
                        description="SKU — 从ERP SKU表拉取",
                        sql_text="SELECT sku_code, material_id, sku_name, attr_json, barcode, gross_weight, net_weight, volume FROM T_BD_SKU WHERE FModifyDate >= :since ORDER BY sku_code",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1d",
                        sync_strategy="incremental",
                        sync_priority=13,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="products",
                        description="产品 — 从ERP产品表拉取",
                        sql_text="SELECT product_code, product_line, tech_version, bom_version, default_warehouse, warranty_days FROM T_BD_PRODUCT WHERE FModifyDate >= :since ORDER BY product_code",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1d",
                        sync_strategy="incremental",
                        sync_priority=14,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="warehouses",
                        description="仓库 — 从ERP仓库表拉取",
                        sql_text="SELECT wh_code, wh_name, wh_type, address, manager_id, is_enabled FROM T_BD_WAREHOUSE ORDER BY wh_code",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1w",
                        sync_strategy="full",
                        sync_priority=15,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="processes",
                        description="工序 — 从ERP工序表拉取",
                        sql_text="SELECT process_code, process_name, process_group, standard_hour, work_center, is_qc_point, description FROM T_BD_PROCESS ORDER BY process_code",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1w",
                        sync_strategy="full",
                        sync_priority=16,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="organizations",
                        description="组织 — 从ERP组织表拉取",
                        sql_text="SELECT org_code, org_name, oa_org_id, org_type, parent_id, leader_id, status FROM T_BD_ORGANIZATION ORDER BY org_code",
                        field_mapping_json=json.dumps({
                            "oa_org_id": "oa_org_id",
                        }),
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1w",
                        sync_strategy="full",
                        sync_priority=17,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="positions",
                        description="Position - pull from OA position table",
                        sql_text="SELECT position_code, oa_position_id, position_name, status FROM T_BD_POSITION ORDER BY position_code",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1d",
                        sync_strategy="full",
                        sync_priority=18,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="employees",
                        description="人员 — 从ERP员工表拉取",
                        sql_text="SELECT emp_code, emp_name, org_id, login_id, position, phone, email, status FROM T_BD_EMPLOYEE WHERE FModifyDate >= :since ORDER BY emp_code",
                        field_mapping_json=json.dumps({
                            "login_id": "login_id",
                        }),
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1d",
                        sync_strategy="incremental",
                        sync_priority=19,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="purchase_invoices",
                        description="采购开票 — 从ERP采购发票表拉取（幂等键: invoice_no+line_no）",
                        sql_text="-- TODO: 配置 ERP 采购开票查询 SQL，返回字段需包含: invoice_no, line_no, invoice_date, supplier_id, supplier_code, supplier_name, payment_term, settlement_method, invoice_amount, remain_payable\nSELECT NULL AS invoice_no, NULL AS line_no, NULL AS invoice_date, NULL AS supplier_id, NULL AS supplier_code, NULL AS supplier_name, NULL AS payment_term, NULL AS settlement_method, NULL AS invoice_amount, NULL AS remain_payable WHERE 1 = 0 AND :since IS NOT NULL",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1d",
                        sync_strategy="incremental",
                        sync_priority=20,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="payment_applies",
                        description="付款申请 — 从ERP付款申请表拉取（幂等键: payment_apply_no）",
                        sql_text="-- TODO: 配置 ERP 付款申请查询 SQL，返回字段需包含: payment_apply_no, doc_no, doc_date, subsystem_id, paid_amount\nSELECT NULL AS payment_apply_no, NULL AS doc_no, NULL AS doc_date, NULL AS subsystem_id, NULL AS paid_amount WHERE 1 = 0 AND :since IS NOT NULL",
                        field_mapping_json=None,
                        is_active=False,
                        sync_enabled=False,
                        sync_interval="1d",
                        sync_strategy="incremental",
                        sync_priority=21,
                        created_by="admin",
                    ),
                    SyncSqlConfig(
                        sync_type="inventory",
                        description="即时库存 — 从ERP库存表拉取（全量快照）",
                        sql_text="-- TODO: 配置 ERP 即时库存查询 SQL，返回字段需包含: material_id, material_code, material_name, wh_id, wh_code, wh_name, location_id, location_name, qty_on_hand, locked_qty, balance_qty, qty_in_transit, batch_no\nSELECT NULL AS material_id, NULL AS material_code, NULL AS material_name, NULL AS wh_id, NULL AS wh_code, NULL AS wh_name, NULL AS location_id, NULL AS location_name, NULL AS qty_on_hand, NULL AS locked_qty, NULL AS balance_qty, NULL AS qty_in_transit, NULL AS batch_no WHERE 1 = 0",
                        field_mapping_json=None,
                        is_active=True,
                        sync_enabled=True,
                        sync_interval="6h",
                        sync_strategy="full",
                        sync_priority=8,
                        created_by="admin",
                    ),
                ]

                new_configs = [c for c in configs if c.sync_type not in existing_types]
                if not new_configs:
                    print("Sync SQL config: all types already exist, nothing to add")
                    return

                for c in new_configs:
                    session.add(c)

                await session.commit()
                print(f"Sync SQL config seeded: added {len(new_configs)} new types ({', '.join(c.sync_type for c in new_configs)})")

            except Exception as e:
                await session.rollback()
                print(f"Error seeding sync SQL config: {e}")
                raise

    async def seed_base_conditions(self):
        """Seed 车间排产基础条件默认值 (人数/工时/周日排产, 按排产阶段分桶).

        人数初始值尽力读 UPPH 公式配置表, 读不到用 10.
        已存在的桶不覆盖 (用户在抽屉里设过的值不被重新 seed 覆盖).
        """
        print("Seeding production base conditions...")
        from app.models.production.base_condition import ProductionBaseCondition

        # 桶 → (中文名, UPPH 车间名, UPPH 工序) 用于读人数默认
        buckets = [
            ("lean", "精益", "精益车间", "*"),
            ("assembly", "组装", "装配车间", "组装"),
            ("packaging", "包装", "装配车间", "包装"),
            ("mixed", "混合", "装配车间", "*"),
        ]

        async with AsyncSessionLocal() as session:
            try:
                # 读 UPPH 公式配置表取人数默认
                manpower_map: dict[str, int] = {}
                for bucket, _, workshop, process in buckets:
                    row = (
                        await session.execute(
                            text(
                                "SELECT manpower FROM production_upph_formula_config "
                                "WHERE workshop_name = :w AND process_type = :p AND is_active = true "
                                "LIMIT 1"
                            ),
                            {"w": workshop, "p": process},
                        )
                    ).first()
                    manpower_map[bucket] = int(row[0]) if row and row[0] else 10

                for bucket, label, _, _ in buckets:
                    existing = (
                        await session.execute(
                            select(ProductionBaseCondition).where(
                                ProductionBaseCondition.schedule_bucket == bucket
                            )
                        )
                    ).scalars().first()
                    if existing:
                        # 已存在不覆盖用户设的值, 仅补 label
                        if not existing.bucket_label:
                            existing.bucket_label = label
                        continue
                    session.add(
                        ProductionBaseCondition(
                            schedule_bucket=bucket,
                            bucket_label=label,
                            default_manpower=manpower_map.get(bucket, 10),
                            daily_work_hours=8,
                            include_sunday=False,
                            is_active=True,
                            created_by="admin",
                        )
                    )

                await session.commit()
                print(f"Production base conditions seeded for {len(buckets)} buckets (manpower={manpower_map})")

            except Exception as e:
                await session.rollback()
                print(f"Error seeding production base conditions: {e}")
                raise

    async def initialize_all(self):
        """Initialize complete database"""
        print("=" * 50)
        print("SPC v2 Database Initialization")
        print("=" * 50)
        
        try:
            self.create_database()
            await self.create_tables()
            await self.migrate_columns()
            await self.rebuild_mrp_plan_order()
            await self.backfill_sale_order_id()
            await self.seed_roles()
            await self.seed_users()
            await self.seed_risk_rules()
            await self.seed_field_mapping()
            await self.seed_normal_order_standards()
            await self.seed_base_conditions()
            await self.seed_sync_sql_config()
            await self.seed_sample_data()
            
            print("=" * 50)
            print("Database initialization completed successfully!")
            print("=" * 50)
            print("\nDefault login credentials:")
            print("Username: admin")
            print("Password: admin123")
            print("\nOther test users:")
            print("- planner01 / admin123")
            print("- purchaser01 / admin123") 
            print("- manager01 / admin123")
            
        except Exception as e:
            print(f"Database initialization failed: {e}")
            raise


async def main():
    """Main function"""
    initializer = DatabaseInitializer()
    await initializer.initialize_all()


if __name__ == "__main__":
    asyncio.run(main())
