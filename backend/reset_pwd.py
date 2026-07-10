import psycopg2
import bcrypt

conn = psycopg2.connect('postgresql://root:123456@183.134.254.14:15432/spc_db')
cur = conn.cursor()

new_pwd = 'admin123'
hashed = bcrypt.hashpw(new_pwd.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

cur.execute(
    "UPDATE sys_user SET hashed_password = %s, is_default_password = %s WHERE username = %s",
    (hashed, True, 'chenqiaoxia')
)
conn.commit()
print(f'chenqiaoxia 密码已重置为: {new_pwd}')
print(f'影响行数: {cur.rowcount}')
conn.close()
