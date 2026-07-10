"""调价单模块 - 数据库表创建（独立于排产系统）"""
import psycopg2

CONN = 'postgresql://root:123456@183.134.254.14:15432/spc_db'

SQL_LIST = [
    # 1. 主表
    """
    CREATE TABLE IF NOT EXISTS purchase_price_change (
      id              SERIAL PRIMARY KEY,
      change_no       VARCHAR(32) NOT NULL UNIQUE,
      title           VARCHAR(256),
      change_type     VARCHAR(32) DEFAULT 'price_change',
      price_direction VARCHAR(16),

      supplier_code   VARCHAR(64),
      supplier_name   VARCHAR(128),
      phone           VARCHAR(32),
      fax             VARCHAR(32),
      contact_person  VARCHAR(64),
      address         VARCHAR(256),

      customer        VARCHAR(128),
      customer_phone  VARCHAR(32),
      customer_fax    VARCHAR(32),
      purchase_contact VARCHAR(64),

      tax_rate        VARCHAR(16),
      payment_method  VARCHAR(64),
      settlement_method VARCHAR(64),

      change_date     DATE,

      attachments     JSONB DEFAULT '[]',

      remark          TEXT,
      signature_opinion TEXT,

      approval_status VARCHAR(16) DEFAULT 'draft',
      approval_level  INT DEFAULT 1,
      approved_by     VARCHAR(64),
      approved_at     TIMESTAMP,
      submitted_at    TIMESTAMP,
      approval_snapshot JSONB,
      version         INT DEFAULT 1,

      applicant       VARCHAR(64),
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_at      TIMESTAMP DEFAULT NOW()
    )
    """,

    # 2. 子表
    """
    CREATE TABLE IF NOT EXISTS purchase_price_change_item (
      id              SERIAL PRIMARY KEY,
      change_id       INT NOT NULL REFERENCES purchase_price_change(id) ON DELETE CASCADE,
      seq             INT,

      material_code   VARCHAR(64),
      material_name   VARCHAR(256),
      spec            VARCHAR(256),
      unit            VARCHAR(16),

      order_qty       NUMERIC(15,4),
      delivery_qty    NUMERIC(15,4),

      old_price       NUMERIC(15,4),
      old_price_date  VARCHAR(16),
      new_price       NUMERIC(15,4),
      price_change_pct NUMERIC(5,2),

      remark          VARCHAR(256)
    )
    """,

    # 3. 审批日志
    """
    CREATE TABLE IF NOT EXISTS purchase_price_change_approval_log (
      id              SERIAL PRIMARY KEY,
      change_id       INT NOT NULL REFERENCES purchase_price_change(id) ON DELETE CASCADE,
      approval_level  INT,
      approver        VARCHAR(64),
      action          VARCHAR(16),
      comment         TEXT,
      operated_at     TIMESTAMP DEFAULT NOW()
    )
    """,

    # 4. AI 分析
    """
    CREATE TABLE IF NOT EXISTS purchase_price_change_ai_analysis (
      id              SERIAL PRIMARY KEY,
      change_id       INT NOT NULL REFERENCES purchase_price_change(id) ON DELETE CASCADE,
      item_id         INT REFERENCES purchase_price_change_item(id),

      history_trend   JSONB,
      market_source   VARCHAR(64),
      market_price    NUMERIC(15,4),
      market_range    VARCHAR(32),
      market_fetched_at TIMESTAMP,

      ai_conclusion   TEXT,
      ai_risk_level   VARCHAR(16),
      ai_detail       TEXT,
      ai_model        VARCHAR(64),
      ai_status       VARCHAR(16) DEFAULT 'pending',
      ai_error_msg    TEXT,

      search_keywords TEXT,
      ai_analyzed_at  TIMESTAMP,
      created_at      TIMESTAMP DEFAULT NOW()
    )
    """,

    # 5. 审批配置（可动态修改审批链）
    """
    CREATE TABLE IF NOT EXISTS approval_config (
      id          SERIAL PRIMARY KEY,
      biz_type    VARCHAR(64) NOT NULL UNIQUE,
      nodes       JSONB NOT NULL DEFAULT '[]',
      is_active   BOOLEAN DEFAULT TRUE,
      updated_by  VARCHAR(64),
      updated_at  TIMESTAMP DEFAULT NOW()
    )
    """,
]


def main():
    conn = psycopg2.connect(CONN)
    cur = conn.cursor()

    for sql in SQL_LIST:
        try:
            cur.execute(sql)
            # 提取表名
            tbl = sql.split('CREATE TABLE IF NOT EXISTS ')[1].split('(')[0].strip()
            print(f'[OK] {tbl}')
        except Exception as e:
            print(f'[FAIL] {str(e)[:80]}')

    # 插入默认审批配置（调价单的 4 级审批链）
    cur.execute("SELECT COUNT(*) FROM approval_config WHERE biz_type='price_change'")
    if cur.fetchone()[0] == 0:
        import json
        default_nodes = json.dumps([
            {"seq": 1, "label": "部门经理审批", "role": "department_manager"},
            {"seq": 2, "label": "成本会计审批", "role": "cost_accountant"},
            {"seq": 3, "label": "财务经理审批", "role": "finance_manager"},
            {"seq": 4, "label": "总经理审批", "role": "general_manager",
             "condition": {"field": "price_direction", "op": "in", "value": ["涨价", "新报价"]}},
        ])
        cur.execute(
            "INSERT INTO approval_config (biz_type, biz_name, nodes) VALUES (%s, %s, %s)",
            ('price_change', '调价单审批', default_nodes)
        )
        print('[OK] 默认审批配置已插入')

    conn.commit()
    conn.close()
    print('\n完成！')


if __name__ == '__main__':
    main()
