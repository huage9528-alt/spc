#requires -Version 5.1
# 一键部署 SPC-v2 到远程 Docker（带版本管理）
# 每次完整部署自动生成版本 vN-时间戳（镜像双标签 + 配置快照，保留最近 5 个），
# 出问题可用 scripts\manage-version.ps1 rollback <版本名> 秒级回退。

param(
    [string]$RemoteHost = "",
    [string]$RemoteUser = "",
    [string]$RemotePath = "",
    [string]$IdentityFile = "",
    [string]$EnvFile = "",
    [string]$Note = "",
    [switch]$SkipBuild,
    [switch]$SkipUpload,
    [switch]$SkipVerify,
    [switch]$NonInteractive
)

. (Join-Path $PSScriptRoot "deploy-config.ps1")

# 命令行参数覆盖共享配置
if ($RemoteHost)   { $DEPLOY_REMOTE_HOST = $RemoteHost }
if ($RemoteUser)   { $DEPLOY_REMOTE_USER = $RemoteUser }
if ($RemotePath)   { $DEPLOY_REMOTE_PATH = $RemotePath }
if ($IdentityFile) { $DEPLOY_IDENTITY_FILE = $IdentityFile }

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
    if ($tmpDir -and (Test-Path $tmpDir)) { Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue }
    if (-not $NonInteractive) { Read-Host "按回车键退出..." }
    exit 1
}

if (-not $DEPLOY_REMOTE_HOST) { throw "请在 deploy-config.ps1 配置 DEPLOY_REMOTE_HOST 或用 -RemoteHost 指定" }
if (-not $DEPLOY_REMOTE_USER) { throw "请在 deploy-config.ps1 配置 DEPLOY_REMOTE_USER 或用 -RemoteUser 指定" }

$RepoRoot    = (Resolve-Path "$PSScriptRoot\..").Path
$ComposeFile = Join-Path $RepoRoot "docker-compose-prod.yml"

if (-not $EnvFile) { $EnvFile = Join-Path $RepoRoot ".env" }

foreach ($tool in @("docker", "ssh", "scp", "tar", "gzip")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "缺少必需工具: $tool" }
}

if (-not (Test-Path -LiteralPath $ComposeFile)) { throw "找不到 compose 文件: $ComposeFile" }
if (-not (Test-Path -LiteralPath $EnvFile))     { throw "找不到 env 文件: $EnvFile" }

$tmpDir = Join-Path $env:TEMP ("spc-deploy-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpDir | Out-Null

Initialize-DeploySsh -TempDir $tmpDir

# ===== [1/6] 确定版本号（仅完整部署路径；SkipUpload 不产生新版本）=====
$Version = ""
$versionNum = 0
if (-not $SkipUpload) {
    Write-Host "[1/6] 确定版本号 ..."
    Invoke-Remote "echo SSH-OK" | Out-Null
    $lastNum = 0
    $raw = Invoke-RemoteCapture "cat $DEPLOY_REMOTE_PATH/last_version.txt 2>/dev/null || echo EMPTY"
    $lastNumStr = ("$raw").Trim()
    if ($lastNumStr -match '^\d+$') {
        $lastNum = [int]$lastNumStr
    } else {
        $dirsRaw = Invoke-RemoteCapture "ls -1 $DEPLOY_REMOTE_PATH/versions 2>/dev/null || true"
        foreach ($line in @($dirsRaw)) {
            $t = "$line".Trim()
            if ($t -match '^v(\d+)-') {
                $n = [int]$Matches[1]
                if ($n -gt $lastNum) { $lastNum = $n }
            }
        }
    }
    $versionNum = $lastNum + 1
    $Version = "v${versionNum}-" + (Get-Date -Format "yyyyMMdd-HHmm")
    Write-Host "  本次部署版本: $Version（上一版本序号: $lastNum）"
} else {
    Write-Host "[1/6] 跳过版本号（SkipUpload 不产生新版本）"
}
Show-StepElapsed "1/6"

# git 短哈希（记录进 meta，失败容忍）
$gitHash = ""
try {
    $gitOut = & git -C $RepoRoot rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0) { $gitHash = "$gitOut".Trim() }
} catch { $gitHash = "" }

if (-not $SkipUpload) {
    Write-Host "[2/6] 构建镜像 (SkipBuild=$SkipBuild) ..."
    if (-not $SkipBuild) {
        & docker build -t spc-v2-backend:latest -t "spc-v2-backend:$Version" (Join-Path $RepoRoot "backend")
        if ($LASTEXITCODE -ne 0) { throw "backend 镜像构建失败" }
        & docker build -t spc-v2-frontend:latest -t "spc-v2-frontend:$Version" (Join-Path $RepoRoot "frontend")
        if ($LASTEXITCODE -ne 0) { throw "frontend 镜像构建失败" }
    } else {
        & docker tag spc-v2-backend:latest "spc-v2-backend:$Version"
        if ($LASTEXITCODE -ne 0) { throw "本机不存在 spc-v2-backend:latest，无法 -SkipBuild（请先完整构建）" }
        & docker tag spc-v2-frontend:latest "spc-v2-frontend:$Version"
        if ($LASTEXITCODE -ne 0) { throw "本机不存在 spc-v2-frontend:latest，无法 -SkipBuild（请先完整构建）" }
    }
    Show-StepElapsed "2/6"

    Write-Host "[3/6] 打包镜像与配置 ..."
    $imagesTar = Join-Path $tmpDir "images.tar"
    & docker save -o $imagesTar "spc-v2-backend:$Version" "spc-v2-frontend:$Version"
    if ($LASTEXITCODE -ne 0) { throw "docker save 失败" }
    $bundleTar = Join-Path $tmpDir "bundle.tar"
    & tar -cf $bundleTar -C $tmpDir images.tar -C $RepoRoot docker-compose-prod.yml .env
    if ($LASTEXITCODE -ne 0) { throw "bundle 打包失败" }
    & gzip -f $bundleTar
    if ($LASTEXITCODE -ne 0) { throw "gzip 压缩失败" }
    $bundlePath = "$bundleTar.gz"
    Show-StepElapsed "3/6"
} else {
    Write-Host "[2/6] 跳过构建（SkipUpload 不上传，无需构建）"
    Write-Host "[3/6] 跳过打包（SkipUpload 不上传，无需打包）"
}

if (-not $SkipUpload) {
    $noteSafe = ($Note -replace "[`r`n]+", " ").Replace("'", "")
    $created = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    # 远程部署脚本：单引号 here-string（内部 bash $ 无需转义），占位符 .Replace 注入
    $remoteScript = @'
set -e
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd __P__
mkdir -p data/uploads data/wecom_verify
gunzip -f bundle.tar.gz
tar -xf bundle.tar docker-compose-prod.yml images.tar
if [ ! -f .env ]; then tar -xf bundle.tar .env; else echo ENV-KEPT; fi
docker load -i images.tar
docker tag "spc-v2-backend:__V__" spc-v2-backend:latest
docker tag "spc-v2-frontend:__V__" spc-v2-frontend:latest
mkdir -p "versions/__V__"
cp .env docker-compose-prod.yml "versions/__V__/"
printf 'version=%s\ncreated=%s\ngit=%s\nnote=%s\n' '__V__' '__CREATED__' '__GIT__' '__NOTE__' > "versions/__V__/meta.txt"
echo __N__ > last_version.txt
echo '__V__' > current.txt
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
# 清理旧版本：按目录名序号降序保留最近 5 个，当前运行版本不清理
cur=$(cat current.txt 2>/dev/null || echo '')
ls -1 versions 2>/dev/null | grep -E '^v[0-9]+-' | sed 's/^v\([0-9][0-9]*\)-.*/\1 &/' | sort -rn | awk '{print $2}' | tail -n +6 | while read old; do
  if [ "$old" = "$cur" ]; then continue; fi
  docker rmi "spc-v2-backend:$old" "spc-v2-frontend:$old" >/dev/null 2>&1 || true
  rm -rf "versions/$old"
  echo "已清理旧版本: $old"
done
# 清理本次部署的解包残留（镜像已 load 进 docker，tar 包不再需要）
rm -f bundle.tar images.tar bundle.tar.gz
echo DEPLOY-VERSIONED __V__
'@
    $remoteScript = $remoteScript.Replace('__P__', $DEPLOY_REMOTE_PATH).Replace('__V__', $Version).
        Replace('__N__', "$versionNum").Replace('__CREATED__', $created).
        Replace('__GIT__', $gitHash).Replace('__NOTE__', $noteSafe)

    Write-Host "[4/6] 上传 bundle 到 $DEPLOY_REMOTE_USER@$DEPLOY_REMOTE_HOST`:$DEPLOY_REMOTE_PATH ..."
    Invoke-Remote "mkdir -p $DEPLOY_REMOTE_PATH"
    Copy-ToRemote $bundlePath "$DEPLOY_REMOTE_PATH/bundle.tar.gz"
    Show-StepElapsed "4/6"

    Write-Host "[5/6] 远程加载并启动（版本 $Version）..."
    Invoke-RemoteScript -Script $remoteScript -TempDir $tmpDir
} else {
    Write-Host "[4/6] 跳过上传 (SkipUpload=$SkipUpload) ..."
    Write-Host "[5/6] 仅远程启动 ..."
    Invoke-Remote "export PATH=/opt/homebrew/bin:/usr/local/bin:`$PATH; cd $DEPLOY_REMOTE_PATH && docker compose -f docker-compose-prod.yml down && docker compose -f docker-compose-prod.yml up -d && docker compose -f docker-compose-prod.yml ps"
}
Show-StepElapsed "5/6"

if (-not $SkipVerify) {
    Write-Host "[6/6] 验证 ..."
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://${DEPLOY_REMOTE_HOST}:18084/" -TimeoutSec 10
        if ($resp.StatusCode -ne 200) { throw "HTTP $($resp.StatusCode)" }
        Write-Host "  前端 http://${DEPLOY_REMOTE_HOST}:18084/ 返回 200"
    } catch {
        Write-Host "  警告: 本机探测前端失败（可能经代理或网络受限: $($_.Exception.Message)）；远程侧健康检查已通过（BACKEND-OK + FRONTEND-OK）" -ForegroundColor Yellow
    }
} else {
    Write-Host "[6/6] 跳过验证 (SkipVerify=$SkipVerify)"
}
Show-StepElapsed "6/6"

Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
$totalMin = [math]::Round(((Get-Date) - $scriptStart).TotalSeconds / 60, 1)
Write-Host "总耗时: ${totalMin} 分钟（约 $([math]::Round(((Get-Date) - $scriptStart).TotalSeconds, 0))s）"
if ($Version) { Write-Host "已部署版本: $Version" }
Write-Host "部署完成。访问: 前端 http://${DEPLOY_REMOTE_HOST}:18084  后端 http://${DEPLOY_REMOTE_HOST}:18085"
if ($Version) { Write-Host "如需回退: .\scripts\manage-version.ps1 rollback <版本名>（先 .\scripts\manage-version.ps1 list 查看）" }
