# 把预处理脚本产物装配进 debug-obsidian-plugin skill 生成的隔离 vault。
# skill 的 start.ps1 只会拷贝 main.js/manifest/styles.css 到插件目录，
# 不会带上 dist/preprocess-scripts（magick.wasm、imagemagick.js 等）。
# 本脚本补上这一步；启动 Obsidian 仍是 skill 的职责，测试脚本不感知。
#
# 用法:
#   pwsh scripts/e2e-vault.ps1            # 使用默认 skill vault 路径
#   pwsh scripts/e2e-vault.ps1 -VaultDir "path\to\vault"   # 指定 vault
param(
    [string]$RepoRoot = (Get-Location),

    [string]$VaultDir
)

$ErrorActionPreference = "Stop"

$manifestPath = Join-Path $RepoRoot "manifest.json"
if (-not (Test-Path $manifestPath)) { throw "manifest.json not found at $RepoRoot" }
$id = (Get-Content $manifestPath -Raw | ConvertFrom-Json).id

if (-not $VaultDir) {
    $VaultDir = Join-Path $RepoRoot ".scratch\obsidian-$id\vault"
}

$pluginDir = Join-Path $VaultDir ".obsidian\plugins\$id"
if (-not (Test-Path $pluginDir)) {
    throw "插件目录不存在: $pluginDir。请先用 debug-obsidian-plugin skill 的 start.ps1 启动并装配插件。"
}

# 构建插件与预处理脚本
Write-Host "构建插件与预处理脚本..."
pnpm run build
pnpm run preprocess:build

$src = Join-Path $RepoRoot "dist\preprocess-scripts"
if (-not (Test-Path $src)) { throw "缺少 dist\preprocess-scripts（preprocess:build 未产出）" }

$dst = Join-Path $pluginDir "dist\preprocess-scripts"
Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
$dstParent = Split-Path $dst -Parent
if (-not (Test-Path $dstParent)) { New-Item -ItemType Directory -Path $dstParent -Force }
Copy-Item $src $dst -Recurse

Write-Host "装配完成: dist\preprocess-scripts -> $dst"
Write-Host "现在可以运行 pnpm run e2e（连接已就绪的 CDP 实例）"