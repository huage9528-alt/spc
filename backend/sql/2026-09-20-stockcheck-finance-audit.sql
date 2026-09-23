-- ============================================================
-- 盘点财务抽检 + 复议 + 通知提出人 · 数据库变更脚本
-- 对应: docs/superpowers/specs/2026-09-18-stockcheck-finance-audit-design.md
-- 日期: 2026-09-20(2026-09-22 补齐通知列与复议索引)
-- 覆盖: 服务器 v9-20260918-0932(c67a15a) → 当前版本的全部库变更
-- 说明: 幂等,可重复执行。生产环境容器启动时 init_database.py 会自动执行
--       等价迁移(create_all + migrate_columns),本脚本供手工应用/DBA审核。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 盘点单头 scm_inventory_check:抽检 4 列
-- ------------------------------------------------------------
ALTER TABLE scm_inventory_check ADD COLUMN IF NOT EXISTS audit_status  VARCHAR(16);   -- pending/passed/rejected;NULL=存量老单(视为已通过)
ALTER TABLE scm_inventory_check ADD COLUMN IF NOT EXISTS audit_by      VARCHAR(100);  -- 最近一次抽检处理人姓名快照
ALTER TABLE scm_inventory_check ADD COLUMN IF NOT EXISTS audit_at      TIMESTAMP;     -- 最近一次抽检处理时间
ALTER TABLE scm_inventory_check ADD COLUMN IF NOT EXISTS audit_comment TEXT;          -- 通过说明 / 发回原因

-- 抽检状态索引(队列筛选高频)
CREATE INDEX IF NOT EXISTS ix_scm_inventory_check_audit_status
    ON scm_inventory_check (audit_status);

-- ------------------------------------------------------------
-- 2. 明细 scm_inventory_check_item:问题行标记 + 复议 3 列
-- ------------------------------------------------------------
ALTER TABLE scm_inventory_check_item ADD COLUMN IF NOT EXISTS audit_failed  INTEGER NOT NULL DEFAULT 0; -- 问题行标记 0/1;重录实盘数自动清零
ALTER TABLE scm_inventory_check_item ADD COLUMN IF NOT EXISTS appeal_status VARCHAR(16);                 -- 复议状态 pending/accepted/rejected;NULL=无复议
ALTER TABLE scm_inventory_check_item ADD COLUMN IF NOT EXISTS appeal_reason TEXT;                        -- 复议申请原因
ALTER TABLE scm_inventory_check_item ADD COLUMN IF NOT EXISTS appeal_at     TIMESTAMP;                   -- 复议申请时间

-- 复议待裁决队列按 appeal_status 过滤(高频),与模型 index=True 对齐
CREATE INDEX IF NOT EXISTS ix_scm_inventory_check_item_appeal_status
    ON scm_inventory_check_item (appeal_status);

-- ------------------------------------------------------------
-- 3. 存量回填:已完结老单视为已通过(避免卡抽检流程;幂等)
-- ------------------------------------------------------------
UPDATE scm_inventory_check
SET audit_status = 'passed'
WHERE status = 'completed' AND audit_status IS NULL;

-- ------------------------------------------------------------
-- 4. 新表:抽检处置历史(仅追加,一轮一条)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scm_inventory_check_audit_log (
    id                  BIGSERIAL PRIMARY KEY,
    check_id            BIGINT NOT NULL REFERENCES scm_inventory_check(id) ON DELETE CASCADE,
    round_no            INTEGER NOT NULL,              -- 第几轮抽检,从 1 递增
    action              VARCHAR(16) NOT NULL,          -- pass / pass_exemption / reject / flag / appeal / appeal_resolve
    comment             TEXT,
    rejected_item_ids   JSONB,                         -- 问题行 item.id 快照(自动比对不一致行 ∪ 手动勾选行)
    operated_by_user_id BIGINT,
    operated_by         VARCHAR(100),
    created_at          TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_scial_check_round
    ON scm_inventory_check_audit_log (check_id, round_no);
CREATE INDEX IF NOT EXISTS ix_scm_inventory_check_audit_log_check_id
    ON scm_inventory_check_audit_log (check_id);

-- ------------------------------------------------------------
-- 5. 新表:抽检复点明细(每轮每抽中行一条,历史不可变;免检不产生行)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scm_inventory_check_audit_item (
    id                  BIGSERIAL PRIMARY KEY,
    check_id            BIGINT NOT NULL REFERENCES scm_inventory_check(id) ON DELETE CASCADE,
    round_no            INTEGER NOT NULL,              -- 与 audit_log.round_no 对应
    item_id             BIGINT NOT NULL REFERENCES scm_inventory_check_item(id) ON DELETE CASCADE,
    audit_qty           NUMERIC(18,4) NOT NULL,        -- 财务复点数
    actual_qty_snapshot NUMERIC(18,4),                 -- 复点时该行盘点人实盘数快照
    matches             INTEGER NOT NULL,              -- 复点数==实盘快照 0/1(实盘为空视为 0)
    created_at          TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_scai_check_round
    ON scm_inventory_check_audit_item (check_id, round_no);
CREATE INDEX IF NOT EXISTS ix_scai_item
    ON scm_inventory_check_audit_item (item_id);

-- ------------------------------------------------------------
-- 6. 权限动作迁移:盘点抽检曾以 read/manage 声明,现回归标准增删改查
--    (应用启动时 migrate_permission_actions 会自动执行,此处供手工对齐)
-- ------------------------------------------------------------
UPDATE sys_permission
SET actions = '["create", "read", "update", "delete"]'::jsonb
WHERE code = 'materials.stock_check_audit'
  AND actions::text <> '["create", "read", "update", "delete"]';

UPDATE sys_role SET permissions = jsonb_set(
    permissions - 'materials.stock_check_audit',
    ARRAY['materials.stock_check_audit'],
    (
        SELECT COALESCE(jsonb_agg(DISTINCT x.a ORDER BY x.a), '[]'::jsonb)
        FROM (
            SELECT CASE WHEN t.a = 'manage' THEN 'update' ELSE t.a END AS a
            FROM jsonb_array_elements_text(permissions -> 'materials.stock_check_audit') AS t(a)
            UNION SELECT 'read'
        ) x
    )
)
WHERE permissions ? 'materials.stock_check_audit'
  AND permissions -> 'materials.stock_check_audit' ? 'manage';

-- ------------------------------------------------------------
-- 7. 通知 notification:提出人落库(通知中心三栏 + 复议申请记录提出人)
-- ------------------------------------------------------------
ALTER TABLE notification ADD COLUMN IF NOT EXISTS sender_id   INTEGER;      -- 提出人ID(关联 sys_user.id;与 migrate_columns 一致不建库级外键)
ALTER TABLE notification ADD COLUMN IF NOT EXISTS sender_name VARCHAR(64);  -- 提出人/发送人姓名快照

-- 存量回填:复议申请通知由 stock_check_audit 改为独立类型 stock_check_appeal(幂等)
UPDATE notification
SET type = 'stock_check_appeal'
WHERE type = 'stock_check_audit' AND title LIKE '%收到复议申请%';

-- ------------------------------------------------------------
-- 附:本次版本随容器启动自动清理的废弃表(init_database.py 幂等 DROP,手工执行可选)
-- ------------------------------------------------------------
-- DROP TABLE IF EXISTS issue_log, change_log, inspection_rule, responsibility_map, status_dictionary;

-- ------------------------------------------------------------
-- 验证(可选执行)
-- ------------------------------------------------------------
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'scm_inventory_check' AND column_name LIKE 'audit%';
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'scm_inventory_check_item' AND column_name IN ('audit_failed','appeal_status','appeal_reason','appeal_at');
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'notification' AND column_name IN ('sender_id','sender_name');
-- SELECT indexname FROM pg_indexes
--   WHERE indexname IN ('ix_scm_inventory_check_audit_status','ix_scm_inventory_check_item_appeal_status');  -- 应为 2 行
-- SELECT count(*) FROM scm_inventory_check WHERE status='completed' AND audit_status IS NULL;  -- 应为 0
