#requires -Version 5.1
# SPC-v2 远程部署共享配置与 SSH 辅助函数
# 被 deploy-remote.ps1 / manage-version.ps1 dot-source，请勿单独运行。

# ===== 远程部署配置（按需修改，两脚本共用）=====
$DEPLOY_REMOTE_HOST   = "150.158.13.110"                  # 远程服务器 IP / 域名
$DEPLOY_REMOTE_USER   = "ubuntu"                          # SSH 用户名
$DEPLOY_REMOTE_PASS   = ""                                # SSH 密码（留空则用密钥或手动输入）
$DEPLOY_REMOTE_PATH   = "/home/ubuntu/apps/hj-spc"        # 远程部署目录
$DEPLOY_IDENTITY_FILE = "D:\wanghuazheng\whz_server.pem"  # SSH 密钥文件（留空用 ~/.ssh/id_rsa）
# ===== 配置结束 =====

# 控制台输出统一 UTF-8（中文在 UTF-8 终端不乱码；ssh 返回的 UTF-8 字节也能正确解码）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 初始化 SSH 认证，生成 $script:DeploySshOpts / $script:DeployTarget。
# TempDir: 可写临时目录（密码认证时在其中生成 askpass 脚本）。
function Initialize-DeploySsh {
    param([Parameter(Mandatory = $true)][string]$TempDir)

    $script:DeployTarget = "$DEPLOY_REMOTE_USER@$DEPLOY_REMOTE_HOST"

    $keyFile = $DEPLOY_IDENTITY_FILE
    if (-not $keyFile) { $keyFile = Join-Path $env:USERPROFILE ".ssh\id_rsa" }

    $script:DeploySshOpts = @(
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=5"
    )

    if (Test-Path -LiteralPath $keyFile) {
        Write-Host "使用密钥认证: $keyFile"
        $script:DeploySshOpts = @("-i", $keyFile) + $script:DeploySshOpts
    } elseif ($DEPLOY_REMOTE_PASS) {
        $passFile = Join-Path $TempDir "pass.txt"
        [System.IO.File]::WriteAllText($passFile, $DEPLOY_REMOTE_PASS, [System.Text.Encoding]::ASCII)
        $askpassCmd = Join-Path $TempDir "askpass.cmd"
        Set-Content -Path $askpassCmd -Value "@echo off`r`ntype `"$passFile`"" -Encoding ASCII
        $env:SSH_ASKPASS = $askpassCmd
        $env:SSH_ASKPASS_REQUIRE = "force"
        Write-Host "使用密码认证（密钥文件不存在: $keyFile）"
    } else {
        Write-Host "未找到密钥文件且未配置密码，请在 ssh 提示时手动输入密码"
    }
}

# 执行远程命令，退出码非 0 时抛错
function Invoke-Remote {
    param([Parameter(Mandatory = $true)][string]$Command)
    & ssh @($script:DeploySshOpts + $script:DeployTarget + $Command)
    if ($LASTEXITCODE -ne 0) { throw "远程命令失败 (exit=$LASTEXITCODE): $Command" }
}

# 执行远程命令并捕获 stdout（忽略退出码；抑制 stderr 以免 PS5.1 EAP=Stop 抛错）
function Invoke-RemoteCapture {
    param([Parameter(Mandatory = $true)][string]$Command)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & ssh @($script:DeploySshOpts + $script:DeployTarget + $Command) 2>$null
    } finally {
        $ErrorActionPreference = $prev
    }
    return $out
}

# 上传本地文件到远程
function Copy-ToRemote {
    param([Parameter(Mandatory = $true)][string]$LocalFile,
          [Parameter(Mandatory = $true)][string]$RemoteDest)
    & scp @($script:DeploySshOpts + $LocalFile + "${script:DeployTarget}:${RemoteDest}")
    if ($LASTEXITCODE -ne 0) { throw "scp 失败: $LocalFile -> ${script:DeployTarget}:${RemoteDest}" }
}

# 把远程 bash 脚本写入本地临时文件（UTF-8 无 BOM）、scp 上传、远程 bash 执行。
# 说明：复杂脚本若直接作为 ssh 命令行参数传递，Windows ssh 重组参数时会丢失双引号
# （bash 中 echo "A|$B" 的 | 会变成管道），必须走文件通道保证内容逐字保真。
function Invoke-RemoteScript {
    param([Parameter(Mandatory = $true)][string]$Script,
          [Parameter(Mandatory = $true)][string]$TempDir,
          [switch]$Capture)
    $shLocal = Join-Path $TempDir "remote-run.sh"
    # 行尾归一化为 LF（若源 .ps1 被 git 重检出为 CRLF，here-string 会携带 \r 污染远程 bash，
    # 最坏情况 set -e\r 失效导致静默假成功，必须在此免疫）
    $Script = ($Script -replace "`r`n", "`n") -replace "`r", "`n"
    [System.IO.File]::WriteAllText($shLocal, $Script, (New-Object System.Text.UTF8Encoding $false))
    Copy-ToRemote $shLocal "$DEPLOY_REMOTE_PATH/.remote-run.sh"
    $runCmd = "bash $DEPLOY_REMOTE_PATH/.remote-run.sh"
    if ($Capture) {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $out = & ssh @($script:DeploySshOpts + $script:DeployTarget + $runCmd) 2>$null
        } finally {
            $ErrorActionPreference = $prev
        }
        return $out
    }
    & ssh @($script:DeploySshOpts + $script:DeployTarget + $runCmd)
    if ($LASTEXITCODE -ne 0) { throw "远程脚本执行失败 (exit=$LASTEXITCODE)" }
}
