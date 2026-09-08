#!/bin/bash
# SPC 数据库每日备份（cron 3:30 调用）：pg_dump 导出到 backups/，保留 7 天
# 恢复方法：
#   docker exec -i hj-spc-postgres pg_restore -U root -d spc_db --clean --if-exists --no-owner < /home/ubuntu/apps/hj-spc/backups/<文件>.dump
set -euo pipefail

BASE_DIR="/home/ubuntu/apps/hj-spc"
BACKUP_DIR="$BASE_DIR/backups"
mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/spc_db-$STAMP.dump"

docker exec hj-spc-postgres pg_dump -U root -d spc_db --format=custom > "$OUT"

SIZE=$(stat -c%s "$OUT")
if [ "$SIZE" -lt 1000000 ]; then
    echo "[$(date '+%F %T')] ERROR: 备份文件仅 ${SIZE} 字节（疑似失败），已删除: $OUT"
    rm -f "$OUT"
    exit 1
fi

# 保留 7 天，更旧的删除
find "$BACKUP_DIR" -name 'spc_db-*.dump' -mtime +7 -delete

echo "[$(date '+%F %T')] 备份完成: $OUT ($((SIZE / 1024 / 1024)) MB)"
