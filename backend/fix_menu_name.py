import psycopg2

conn = psycopg2.connect('postgresql://root:123456@183.134.254.14:15432/spc_db')
cur = conn.cursor()

# 改 sys_permission 表里 schedule_plans 的 name
cur.execute("SELECT code, name FROM sys_permission WHERE code = 'production.schedule_plans'")
row = cur.fetchone()
print(f"改前: {row}")

cur.execute("UPDATE sys_permission SET name = '排产台账' WHERE code = 'production.schedule_plans'")
conn.commit()

cur.execute("SELECT code, name FROM sys_permission WHERE code = 'production.schedule_plans'")
row = cur.fetchone()
print(f"改后: {row}")

conn.close()
