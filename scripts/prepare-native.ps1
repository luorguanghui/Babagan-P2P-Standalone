param([string]$ObsRoot = $(if ($env:OBS_RUNTIME) { $env:OBS_RUNTIME } elseif (Test-Path 'C:/Program Files/obs-studio/bin/64bit/obs.dll') { 'C:/Program Files/obs-studio' } else { 'G:/obs-studio' }))
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $projectRoot 'third_party/obs-studio-32.1.2'
$expectedCommit = 'fb4d98bf88fae5fc85cb11fc57f7c5e309282194'
if (!(Test-Path -LiteralPath (Join-Path $source '.git'))) {
  New-Item -ItemType Directory -Force (Split-Path -Parent $source) | Out-Null
  & git clone --depth 1 --branch 32.1.2 --filter=blob:none --sparse https://github.com/obsproject/obs-studio.git $source
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch OBS Studio 32.1.2 source' }
  & git -C $source sparse-checkout set libobs plugins/win-capture plugins/win-wasapi
  if ($LASTEXITCODE -ne 0) { throw 'Could not select OBS capture source directories' }
}
$actualCommit = (& git -C $source rev-parse HEAD).Trim()
if ($actualCommit -ne $expectedCommit) { throw "Unexpected OBS source commit: $actualCommit" }
$env:OBS_HEADERS = Join-Path $source 'libobs'
$env:OBS_SOURCE = $source
$env:OBS_RUNTIME = $ObsRoot
if (!$env:VCVARS64) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (Test-Path -LiteralPath $vswhere) {
    $installation = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
    if ($installation) { $env:VCVARS64 = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat' }
  }
}
if (!$env:VCVARS64) { $env:VCVARS64 = 'E:/visual_studio/VC/Auxiliary/Build/vcvars64.bat' }
if (!(Test-Path -LiteralPath $env:VCVARS64)) { throw 'Visual Studio C++ toolchain not found; set VCVARS64' }
$vsRoot = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $env:VCVARS64) '../../..')).Path
if (!$env:DUMPBIN_PATH) {
  $dumpbin = Get-ChildItem -LiteralPath (Join-Path $vsRoot 'VC/Tools/MSVC') -Filter dumpbin.exe -Recurse -File |
    Where-Object { $_.FullName -like '*Hostx64*x64*' } | Sort-Object FullName -Descending | Select-Object -First 1
  if ($dumpbin) { $env:DUMPBIN_PATH = $dumpbin.FullName }
}
Push-Location (Join-Path $projectRoot 'native/capture-helper')
try {
  & cmd.exe /c build.cmd
  if ($LASTEXITCODE -ne 0) { throw "Native helper build failed: $LASTEXITCODE" }
  & powershell.exe -ExecutionPolicy Bypass -File stage.ps1 -ObsRoot $ObsRoot -ObsSource $source
  if ($LASTEXITCODE -ne 0) { throw "Native runtime staging failed: $LASTEXITCODE" }
} finally { Pop-Location }
