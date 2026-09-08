#requires -Version 5.1
# SPC-v2 远程部署版本管理工具
# 用法:
#   .\scripts\manage-version.ps1 list                               # 列出远程版本
#   .\scripts\manage-version.ps1 rollback v11-20260827-0930         # 回退到指定版本
#   .\scripts\manage-version.ps1 cleanup                            # 手动清理（保留最近 5 个）

param(
    [Parameter(Position = 0)][string]$Command = "list",
    [Parameter(Position = 1)][string]$Version = "",
    [string]$RemoteHost = "",
    [string]$RemoteUser = "",
    [string]$RemotePath = "",
    [string]$IdentityFile = "",
    [switch]$NonInteractive
)

. (Join-Path $PSScriptRoot "deploy-config.ps1")

if ($RemoteHost)   { $DEPLOY_REMOTE_HOST = $RemoteHost }
if ($RemoteUser)   { $DEPLOY_REMOTE_USER = $RemoteUser }
if ($RemotePath)   { $DEPLOY_REMOTE_PATH = $RemotePath }
if ($IdentityFile) { $DEPLOY_IDENTITY_FILE = $IdentityFile }

$ErrorActionPreference = "Stop"
$scriptStart = Get-Date

$script:TmpDir = $null

trap {
    $elapsed = [math]::Round(((Get-Date) - $script:scriptStart).TotalSeconds, 1)
    Write-Host ""
    Write-Host "===== 操作失败 (已运行 ${elapsed}s) =====" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host "位置: $($_.ScriptStackTrace)" }
    Write-Host "====================" -ForegroundColor Red
    if ($script:TmpDir) { Remove-Item -Recurse -Force $script:TmpDir -ErrorAction SilentlyContinue }
    if (-not $NonInteractive) { Read-Host "按回车键退出..." }
    exit 1
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw "缺少必需工具: ssh" }

$script:TmpDir = Join-Path $env:TEMP ("spc-vermgr-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $script:TmpDir | Out-Null

Initialize-DeploySsh -TempDir $script:TmpDir

switch ($Command.ToLower()) {
    "list" {
        $remoteScript = @'
cd __P__ 2>/dev/null || { echo "REMOTE-PATH-MISSING __P__"; exit 1; }
echo "CURRENT $(cat current.txt 2>/dev/null || echo '-')"
ls -1 versions 2>/dev/null | grep -E '^v[0-9]+-' | sed 's/^v\([0-9][0-9]*\)-.*/\1 &/' | sort -rn | awk '{print $2}' | while read d; do
  created=""; git=""; note=""
  if [ -f "versions/$d/meta.txt" ]; then
    created=$(grep '^created=' "versions/$d/meta.txt" | cut -d= -f2-)
    git=$(grep '^git=' "versions/$d/meta.txt" | cut -d= -f2-)
    note=$(grep '^note=' "versions/$d/meta.txt" | cut -d= -f2-)
  fi
  ok="OK"
  docker image inspect "spc-v2-backend:$d" >/dev/null 2>&1 || ok="MISSING"
  docker image inspect "spc-v2-frontend:$d" >/dev/null 2>&1 || ok="MISSING"
  echo "VER|$d|$created|$git|$note|$ok"
done
'@
        $remoteScript = $remoteScript.Replace('__P__', $DEPLOY_REMOTE_PATH)
        $out = Invoke-RemoteScript -Script $remoteScript -TempDir $script:TmpDir -Capture

        $current = ""
        $rows = @()
        foreach ($line in @($out)) {
            $t = "$line".Trim()
            if ($t -match '^REMOTE-PATH-MISSING') { throw "远程部署目录不存在: $DEPLOY_REMOTE_PATH（尚未做过版本化部署？）" }
            elseif ($t -match '^CURRENT\s+(.+)$') { $current = $Matches[1].Trim() }
            elseif ($t -match '^VER\|(.+)$') {
                $parts = $Matches[1] -split '\|', 5
                $rows += [pscustomobject]@{
                    Version = $parts[0]
                    Created = $parts[1]
                    Git     = $parts[2]
                    Note    = $parts[3]
                    Images  = $parts[4]
                    Status  = if ($parts[0] -eq $current) { "当前运行" } else { "" }
                }
            }
        }
        if (-not $current -and $rows.Count -eq 0) { throw "无法获取远程版本信息（连接失败或首次部署前）" }
        Write-Host "当前运行: $current"
        if ($rows.Count -eq 0) {
            Write-Host "（远程尚无历史版本）"
        } else {
            $rows | Format-Table Version, Created, Git, Images, Status, Note -AutoSize
        }
    }

    "rollback" {
        if (-not $Version) { throw "用法: .\scripts\manage-version.ps1 rollback <版本名>（先 list 查看）" }
        if ($Version -notmatch '^v\d+-\d{8}-\d{4}$') { throw "版本名格式应为 vN-YYYYMMDD-HHmm，例如 v11-20260827-0930" }

        $remoteScript = @'
set -e
cd __P__
V='__V__'
if [ ! -d "versions/$V" ]; then
  echo "VERSION-NOT-FOUND 可用版本:"
  ls -1 versions 2>/dev/null | grep -E '^v[0-9]+-' || echo "(无)"
  exit 1
fi
docker image inspect "spc-v2-backend:$V" >/dev/null 2>&1 || { echo "IMAGE-MISSING: spc-v2-backend:$V（该版本镜像可能已被清理）"; exit 1; }
docker image inspect "spc-v2-frontend:$V" >/dev/null 2>&1 || { echo "IMAGE-MISSING: spc-v2-frontend:$V（该版本镜像可能已被清理）"; exit 1; }
docker tag "spc-v2-backend:$V" spc-v2-backend:latest
docker tag "spc-v2-frontend:$V" spc-v2-frontend:latest
cp "versions/$V/.env" ./.env
cp "versions/$V/docker-compose-prod.yml" ./docker-compose-prod.yml
docker compose -f docker-compose-prod.yml up -d
docker compose -f docker-compose-prod.yml ps
(for i in $(seq 1 20); do
  if curl -s -o /dev/null http://localhost:18085/api/v1/common/ping; then echo BACKEND-OK; exit 0; fi
  sleep 3
done
echo BACKEND-NOT-READY
echo '--- compose ps ---'
docker compose -f docker-compose-prod.yml ps
echo '--- backend logs (tail 50) ---'
docker logs --tail 50 $(docker compose -f docker-compose-prod.yml ps -q backend 2>/dev/null | head -n1) 2>/dev/null
exit 1)
# 远程侧前端权威检查（不依赖操作者本机网络/代理）
fcode=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:18084/ || echo 000)
if [ "$fcode" = "200" ]; then echo FRONTEND-OK; else echo "FRONTEND-BAD:$fcode"; docker compose -f docker-compose-prod.yml logs --tail 20 frontend; exit 1; fi
echo "$V" > current.txt
echo "ROLLBACK-OK $V"
'@
        $remoteScript = $remoteScript.Replace('__P__', $DEPLOY_REMOTE_PATH).Replace('__V__', $Version)

        Write-Host "回退到 $Version ..."
        Invoke-RemoteScript -Script $remoteScript -TempDir $script:TmpDir

        try {
            $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://${DEPLOY_REMOTE_HOST}:18084/" -TimeoutSec 10
            if ($resp.StatusCode -ne 200) { throw "HTTP $($resp.StatusCode)" }
            Write-Host "前端 http://${DEPLOY_REMOTE_HOST}:18084/ 返回 200"
        } catch {
            Write-Host "警告: 本机探测前端失败（可能经代理或网络受限: $($_.Exception.Message)）；远程侧健康检查已通过（BACKEND-OK + FRONTEND-OK）" -ForegroundColor Yellow
        }
        Write-Host "回退完成，当前版本: $Version"
    }

    "cleanup" {
        $remoteScript = @'
set -e
cd __P__
cur=$(cat current.txt 2>/dev/null || echo '')
ls -1 versions 2>/dev/null | grep -E '^v[0-9]+-' | sed 's/^v\([0-9][0-9]*\)-.*/\1 &/' | sort -rn | awk '{print $2}' | tail -n +6 | while read old; do
  if [ "$old" = "$cur" ]; then continue; fi
  docker rmi "spc-v2-backend:$old" "spc-v2-frontend:$old" >/dev/null 2>&1 || true
  rm -rf "versions/$old"
  echo "已清理旧版本: $old"
done
echo CLEANUP-DONE
'@
        $remoteScript = $remoteScript.Replace('__P__', $DEPLOY_REMOTE_PATH)
        Invoke-RemoteScript -Script $remoteScript -TempDir $script:TmpDir
    }

    default {
        throw "未知命令: $Command（可用: list / rollback / cleanup）"
    }
}

Remove-Item -Recurse -Force $script:TmpDir -ErrorAction SilentlyContinue
Write-Host "操作完成。"
