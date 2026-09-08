# scripts/remote — 服务器端运维文件（仓库权威源）

这些文件部署在远程服务器上（被 compose 挂载或 cron 调用）。仓库保留一份作为权威源，
**服务器上改动后记得回填这里**；迁移/重建服务器时按本 README 恢复，无需重写。

服务器：`ubuntu@150.158.13.110`，部署目录 `/home/ubuntu/apps/hj-spc`
（连接配置见 `scripts/deploy-config.ps1`）

## 文件清单

| 文件             | 服务器位置                                   | 用途                                                                                               |
| -------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `nginx.conf`   | `/home/ubuntu/apps/hj-spc/nginx.conf`   | 前端容器 nginx 配置（compose 挂载，覆盖镜像内置）：监听 18084；`/api/`、`/uploads/` 反代 backend，resolver 动态解析防容器重建后 502 |
| `backup-db.sh` | `/home/ubuntu/apps/hj-spc/backup-db.sh` | 每日 3:30 pg_dump 备份到 `backups/`，保留 7 天，含完整性校验；恢复命令见文件头注释                                          |

## 同步命令（仓库根目录执行）

```powershell
scp -i D:\wanghuazheng\whz_server.pem scripts\remote\nginx.conf ubuntu@150.158.13.110:/home/ubuntu/apps/hj-spc/nginx.conf
scp -i D:\wanghuazheng\whz_server.pem scripts\remote\backup-db.sh ubuntu@150.158.13.110:/home/ubuntu/apps/hj-spc/backup-db.sh
```

改 `nginx.conf` 后需重启前端容器生效（服务器上执行）：

```bash
cd /home/ubuntu/apps/hj-spc && docker compose -f docker-compose-prod.yml restart frontend
```

cron 安装（幂等，重复执行不会产生重复条目）：

```bash
chmod +x /home/ubuntu/apps/hj-spc/backup-db.sh
( crontab -l 2>/dev/null | grep -v backup-db.sh; echo '30 3 * * * /home/ubuntu/apps/hj-spc/backup-db.sh >> /home/ubuntu/apps/hj-spc/backups/backup.log 2>&1' ) | crontab -
```

## 迁移新服务器 checklist

1. 新服务器装 Docker（含 compose 插件），配置 SSH 密钥，开放 18084/18085 端口
2. 建目录：`mkdir -p /home/ubuntu/apps/hj-spc/{data/uploads,data/wecom_verify,data/postgres,backups}`
3. 本机执行一次完整部署（自动拉起 postgres/redis/backend/frontend 并初始化版本管理）：
   `powershell -ExecutionPolicy Bypass -File scripts\deploy-remote.ps1 -NonInteractive`
4. 上传本目录两个文件（见"同步命令"）+ 装 cron + `chmod +x`
5. `.env`（**不在仓库，含密码**）：从旧服务器拷贝 `/home/ubuntu/apps/hj-spc/.env`，
   或参照 `docker-compose-prod.yml` 的 environment 字段手工创建；
   必须包含 `POSTGRES_PASSWORD` / `REDIS_PASSWORD`（compose 变量替换用）
6. 数据迁移：
   - 旧服务器先 `bash backup-db.sh` 出最新备份，scp 到新服务器后：
     `docker exec -i hj-spc-postgres pg_restore -U root -d spc_db --clean --if-exists --no-owner < backups/<文件>.dump`
   - 上传文件目录 `data/uploads` 用 scp/rsync 整体迁移
7. 验证：前端 `http://<ip>:18084/` 200；经 nginx 的 `/api/v1/common/ping` 401（进程活）；
   登录接口返回 `code:0`

## 注意

- `.env`、SSH 密钥、备份文件**永远不进仓库**
- 一键部署的 bundle 只含镜像 + compose + .env，**不含**本目录文件——迁移时别漏第 4/5 步
- 数据库版本镜像 `postgres:15`（与内网原库 15.x 对齐），升级前先出备份
