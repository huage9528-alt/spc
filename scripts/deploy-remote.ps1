#requires -Version 5.1
# 一键部署 SPC-v2 到远程 Docker（密码等配置已内置，全自动，无需交互）

param(
    [string]$RemoteHost = "",
    [string]$RemoteUser = "",
    [string]$RemotePath = "",
    [string]$IdentityFile = "",
    [string]$EnvFile = "",
    [switch]$SkipBuild,
    [switch]$SkipUpload,
    [switch]$SkipVerify,
    [switch]$NonInteractive
)

# ===== 远程部署配置（按需修改）=====
$REMOTE_HOST = "192.168.0.127"          # 远程服务器 IP / 域名
$REMOTE_USER = "mac"                    # SSH 用户名
$REMOTE_PASS = "hjgd@123"                       # SSH 密码（留空则仍手动输入一次）
$REMOTE_PATH = "/Users/mac/hjgd-IM/docker/SPC"   # 远程部署目录
# ===== 配置结束 =====

$ErrorActionPreference = "Stop"

$scriptStart = Get-Date
$stepStart = $scriptStart

function Show-StepElapsed {
    param([Parameter(Mandatory = $true)][string]$Label)
    $sec = [math]::Round(((Get-Date) - $script:stepStart).TotalSeconds, 1)
    Write-Host "  [$Label] 耗时: ${sec}s"
    $script:stepStart = Get-Date
}

trap {
    $elapsed = [math]::Round(((Get-Date) - $script:scriptStart).TotalSeconds, 1)
    Write-Host ""
    Write-Host "===== 部署失败 (已运行 ${elapsed}s) =====" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host "位置: $($_.ScriptStackTrace)" }
    Write-Host "====================" -ForegroundColor Red
    if (-not $NonInteractive) { Read-Host "按回车键退出..." }
    exit 1
}

if ($RemoteHost) { $REMOTE_HOST = $RemoteHost }
if ($RemoteUser) { $REMOTE_USER = $RemoteUser }
if ($RemotePath) { $REMOTE_PATH = $RemotePath }

if (-not $REMOTE_HOST) { throw "请在脚本顶部配置 REMOTE_HOST 或用 -RemoteHost 指定" }
if (-not $REMOTE_USER) { throw "请在脚本顶部配置 REMOTE_USER 或用 -RemoteUser 指定" }

$RepoRoot    = (Resolve-Path "$PSScriptRoot\..").Path
$ComposeFile = Join-Path $RepoRoot "docker-compose-prod.yml"

if (-not $IdentityFile) { $IdentityFile = Join-Path $env:USERPROFILE ".ssh\id_rsa" }
if (-not $EnvFile)      { $EnvFile = Join-Path $RepoRoot ".env" }

foreach ($tool in @("docker", "ssh", "scp", "tar", "gzip")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "缺少必需工具: $tool" }
}

if (-not (Test-Path -LiteralPath $ComposeFile)) { throw "找不到 compose 文件: $ComposeFile" }
if (-not (Test-Path -LiteralPath $EnvFile))     { throw "找不到 env 文件: $EnvFile" }

$tmpDir = Join-Path $env:TEMP ("spc-deploy-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpDir | Out-Null

# 用 SSH_ASKPASS 免交互提供密码（仅当配置了密码时启用）
if ($REMOTE_PASS) {
    $passFile = Join-Path $tmpDir "pass.txt"
    [System.IO.File]::WriteAllText($passFile, $REMOTE_PASS, [System.Text.Encoding]::ASCII)
    $askpassCmd = Join-Path $tmpDir "askpass.cmd"
    Set-Content -Path $askpassCmd -Value "@echo off`r`ntype `"$passFile`"" -Encoding ASCII
    $env:SSH_ASKPASS = $askpassCmd
    $env:SSH_ASKPASS_REQUIRE = "force"
    Write-Host "使用脚本内置密码认证（无需手动输入）"
} else {
    Write-Host "未配置 REMOTE_PASS，请在 ssh 提示时手动输入密码"
}

$target    = "$REMOTE_USER@$REMOTE_HOST"
$sshOpts   = @(
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=5"
)
if (Test-Path -LiteralPath $IdentityFile) { $sshOpts = @("-i", $IdentityFile) + $sshOpts }

function Invoke-Remote {
    param([Parameter(Mandatory = $true)][string]$Command)
    & ssh @($sshOpts + $target + $Command)
    if ($LASTEXITCODE -ne 0) { throw "远程命令失败 (exit=$LASTEXITCODE): $Command" }
}

function Copy-ToRemote {
    param([Parameter(Mandatory = $true)][string]$LocalFile,
          [Parameter(Mandatory = $true)][string]$RemoteDest)
    & scp @($sshOpts + $LocalFile + "${target}:${RemoteDest}")
    if ($LASTEXITCODE -ne 0) { throw "scp 失败: $LocalFile -> $RemoteDest" }
}

Write-Host "[1/5] 构建镜像 (SkipBuild=$SkipBuild) ..."
if (-not $SkipBuild) {
    & docker build -t spc-v2-backend:latest (Join-Path $RepoRoot "backend")
    if ($LASTEXITCODE -ne 0) { throw "backend 镜像构建失败" }
    & docker build -t spc-v2-frontend:latest (Join-Path $RepoRoot "frontend")
    if ($LASTEXITCODE -ne 0) { throw "frontend 镜像构建失败" }
}
Show-StepElapsed "1/5"

Write-Host "[2/5] 打包镜像与配置 ..."
$imagesTar = Join-Path $tmpDir "images.tar"
& docker save -o $imagesTar spc-v2-backend:latest spc-v2-frontend:latest
if ($LASTEXITCODE -ne 0) { throw "docker save 失败" }
$bundleTar = Join-Path $tmpDir "bundle.tar"
& tar -cf $bundleTar -C $tmpDir images.tar -C $RepoRoot docker-compose-prod.yml .env
if ($LASTEXITCODE -ne 0) { throw "bundle 打包失败" }
& gzip -f $bundleTar
if ($LASTEXITCODE -ne 0) { throw "gzip 压缩失败" }
$bundlePath = "$bundleTar.gz"
Show-StepElapsed "2/5"

$remoteDeployCmd = "export PATH=/opt/homebrew/bin:/usr/local/bin:`$PATH; cd $REMOTE_PATH && " +
                   "mkdir -p data/uploads data/wecom_verify && " +
                   "gunzip -f bundle.tar.gz && " +
                   "tar -xf bundle.tar docker-compose-prod.yml images.tar && " +
                   "(if [ ! -f .env ]; then tar -xf bundle.tar .env; else echo ENV-KEPT; fi) && " +
                   "docker load -i images.tar && " +
                   "docker compose -f docker-compose-prod.yml up -d && " +
                   "docker compose -f docker-compose-prod.yml ps && " +
                   "(for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do " +
                   "if curl -s -o /dev/null http://localhost:18085/api/v1/common/ping; then echo BACKEND-OK; exit 0; fi; " +
                   "sleep 3; done; echo BACKEND-NOT-READY; echo '--- compose ps ---'; " +
                   "docker compose -f docker-compose-prod.yml ps; " +
                   "echo '--- backend logs (tail 50) ---'; " +
                   "docker logs --tail 50 `$(docker compose -f docker-compose-prod.yml ps -q backend 2>/dev/null | head -n1) 2>/dev/null; " +
                   "exit 1)"

if (-not $SkipUpload) {
    Write-Host "[3/5] 上传 bundle 到 $target`:$REMOTE_PATH ..."
    Invoke-Remote "mkdir -p $REMOTE_PATH"
    Copy-ToRemote $bundlePath "$REMOTE_PATH/bundle.tar.gz"
    Show-StepElapsed "3/5"

    Write-Host "[4/5] 远程加载并启动 ..."
    Invoke-Remote $remoteDeployCmd
} else {
    Write-Host "[3/5] 跳过上传 (SkipUpload=$SkipUpload) ..."
    Write-Host "[4/5] 仅远程启动 ..."
    Invoke-Remote "export PATH=/opt/homebrew/bin:/usr/local/bin:`$PATH; cd $REMOTE_PATH && docker compose -f docker-compose-prod.yml down && docker compose -f docker-compose-prod.yml up -d && docker compose -f docker-compose-prod.yml ps"
}
Show-StepElapsed "4/5"

if (-not $SkipVerify) {
    Write-Host "[5/5] 验证 ..."
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://${REMOTE_HOST}:18084/" -TimeoutSec 10
    if ($resp.StatusCode -ne 200) { throw "前端探测返回 HTTP $($resp.StatusCode)" }
    Write-Host "  前端 http://${REMOTE_HOST}:18084/ 返回 200"
} else {
    Write-Host "[5/5] 跳过验证 (SkipVerify=$SkipVerify)"
}
Show-StepElapsed "5/5"

Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
$totalMin = [math]::Round(((Get-Date) - $scriptStart).TotalSeconds / 60, 1)
Write-Host "总耗时: ${totalMin} 分钟（约 $([math]::Round(((Get-Date) - $scriptStart).TotalSeconds, 0))s）"
Write-Host "部署完成。访问: 前端 http://${REMOTE_HOST}:18084  后端 http://${REMOTE_HOST}:18085"
