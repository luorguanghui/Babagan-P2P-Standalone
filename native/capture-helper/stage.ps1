param(
  [string]$ObsRoot = $(if ($env:OBS_RUNTIME) { $env:OBS_RUNTIME } elseif (Test-Path 'C:/Program Files/obs-studio/bin/64bit/obs.dll') { 'C:/Program Files/obs-studio' } else { 'G:/obs-studio' }),
  [string]$ObsSource = $(if ($env:OBS_SOURCE) { $env:OBS_SOURCE } else { Join-Path $env:TEMP 'babagan-obs-source-32.1.2' }),
  [string]$Dumpbin = $(if ($env:DUMPBIN_PATH) { $env:DUMPBIN_PATH } else { 'E:/visual_studio/VC/Tools/MSVC/14.43.34808/bin/Hostx64/x64/dumpbin.exe' })
)
$ErrorActionPreference = 'Stop'
$helperRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$targetRoot = Join-Path (Split-Path -Parent $helperRoot) 'runtime'
$binRoot = Join-Path $ObsRoot 'bin/64bit'
$pluginRoot = Join-Path $ObsRoot 'obs-plugins/64bit'
if (!(Test-Path -LiteralPath (Join-Path $binRoot 'obs.dll'))) { throw "OBS runtime missing at $ObsRoot" }
if (!(Test-Path -LiteralPath $Dumpbin)) { throw "dumpbin missing at $Dumpbin" }
if (!(Test-Path -LiteralPath (Join-Path $ObsSource 'COPYING'))) { throw "OBS 32.1.2 license source missing at $ObsSource" }
New-Item -ItemType Directory -Force (Join-Path $targetRoot 'bin/64bit'), (Join-Path $targetRoot 'obs-plugins/64bit'), (Join-Path $targetRoot 'data/obs-plugins') | Out-Null
$queue = [Collections.Generic.Queue[string]]::new()
foreach ($seed in @('obs.dll', 'libobs-d3d11.dll', 'libobs-winrt.dll', 'win-capture.dll', 'win-wasapi.dll')) { $queue.Enqueue($seed) }
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
while ($queue.Count -gt 0) {
  $name = $queue.Dequeue()
  if (!$seen.Add($name)) { continue }
  $source = Join-Path $binRoot $name
  $destination = Join-Path $targetRoot 'bin/64bit'
  if (!(Test-Path -LiteralPath $source)) {
    $source = Join-Path $pluginRoot $name
    $destination = Join-Path $targetRoot 'obs-plugins/64bit'
  }
  if (!(Test-Path -LiteralPath $source)) { continue }
  Copy-Item -LiteralPath $source -Destination $destination -Force
  foreach ($line in (& $Dumpbin /dependents $source)) {
    if ($line -match '^\s*([A-Za-z0-9._+-]+\.dll)\s*$') { $queue.Enqueue($Matches[1]) }
  }
}
Copy-Item -LiteralPath (Join-Path $helperRoot 'build/babagan-capture.exe') -Destination (Join-Path $targetRoot 'bin/64bit/babagan-capture.exe') -Force
Copy-Item -LiteralPath (Join-Path $ObsRoot 'data/libobs') -Destination (Join-Path $targetRoot 'data') -Recurse -Force
foreach ($plugin in @('win-capture', 'win-wasapi')) {
  Copy-Item -LiteralPath (Join-Path $ObsRoot "data/obs-plugins/$plugin") -Destination (Join-Path $targetRoot 'data/obs-plugins') -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $ObsSource 'COPYING') -Destination (Join-Path $targetRoot 'COPYING-OBS.txt') -Force
Write-Output "Staged minimal libobs runtime: $targetRoot"
