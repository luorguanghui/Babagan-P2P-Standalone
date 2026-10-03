param(
  [string]$SdkRoot = "$env:USERPROFILE/.cache/babagan-build/android-sdk",
  [string]$JavaRoot = 'C:/JAVA',
  [string]$OutputPath = '',
  [string]$SigningDirectory = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path "$PSScriptRoot/..").Path
$buildRoot = Join-Path $projectRoot 'android/build'
$toolsRoot = Join-Path $SdkRoot 'build-tools/35.0.0'
$platformJar = Join-Path $SdkRoot 'platforms/android-35/android.jar'
$env:JAVA_HOME = $JavaRoot
$env:PATH = "$JavaRoot/bin;$env:PATH"
function Check-Result { if ($LASTEXITCODE -ne 0) { throw "Build command failed: $LASTEXITCODE" } }
New-Item -ItemType Directory -Force "$buildRoot/classes", "$buildRoot/dex" | Out-Null
Push-Location $projectRoot
try {
  node scripts/prepare.mjs
  Check-Result
  & "$toolsRoot/aapt.exe" package -f -M android/AndroidManifest.xml -S android/res -I $platformJar -A www -F "$buildRoot/unsigned.apk"
  Check-Result
  & "$JavaRoot/bin/javac.exe" -encoding UTF-8 --release 8 -classpath $platformJar -d "$buildRoot/classes" android/src/cloud/babagan/meeting/MainActivity.java
  Check-Result
  $classes = @(Get-ChildItem "$buildRoot/classes" -Recurse -Filter '*.class' | ForEach-Object FullName)
  & "$toolsRoot/d8.bat" --lib $platformJar --min-api 26 --output "$buildRoot/dex" @classes
  Check-Result
  & "$JavaRoot/bin/jar.exe" uf "$buildRoot/unsigned.apk" -C "$buildRoot/dex" classes.dex
  Check-Result
  & "$toolsRoot/zipalign.exe" -f 4 "$buildRoot/unsigned.apk" "$buildRoot/aligned.apk"
  Check-Result
  $signingRoot = if ($SigningDirectory) { (Resolve-Path -LiteralPath $SigningDirectory).Path }
    else { Join-Path $env:LOCALAPPDATA 'Babagan/signing' }
  if (!$SigningDirectory) {
    New-Item -ItemType Directory -Force $signingRoot | Out-Null
    & icacls.exe $signingRoot /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null
  }
  $passFile = Join-Path $signingRoot 'store-password.txt'
  $keyFile = Join-Path $signingRoot 'babagan-release.p12'
  if ($SigningDirectory -and (!(Test-Path -LiteralPath $keyFile) -or !(Test-Path -LiteralPath $passFile))) {
    throw 'Selected signing directory must contain the existing key and password file'
  }
  if (!(Test-Path $keyFile)) {
    if (!(Test-Path $passFile)) {
      $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
      $bytes = New-Object byte[] 32
      $rng.GetBytes($bytes)
      -join ($bytes | ForEach-Object { '{0:X2}' -f $_ }) | Set-Content -NoNewline $passFile
    }
    & "$JavaRoot/bin/keytool.exe" -genkeypair -keystore $keyFile -storetype PKCS12 -storepass:file $passFile -alias babagan -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Babagan P2P, O=Babagan, C=CN'
    Check-Result
  }
  $outputRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'releases'))
  New-Item -ItemType Directory -Force $outputRoot | Out-Null
  $packageInfo = Get-Content package.json -Raw | ConvertFrom-Json
  $releaseVersion = if ($packageInfo.displayVersion) { $packageInfo.displayVersion } else { $packageInfo.version }
  $relApk = "releases/Babagan-P2P-$releaseVersion-Android.apk"
  $apkFile = if ($OutputPath) {
    if ([IO.Path]::IsPathRooted($OutputPath)) { [IO.Path]::GetFullPath($OutputPath) }
    else { [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputPath)) }
  } else { [IO.Path]::GetFullPath((Join-Path $projectRoot $relApk)) }
  New-Item -ItemType Directory -Force (Split-Path -Parent $apkFile) | Out-Null
  & "$toolsRoot/apksigner.bat" sign --ks $keyFile --ks-key-alias babagan --ks-pass "file:$passFile" --out $apkFile "$buildRoot/aligned.apk"
  Check-Result
  & "$toolsRoot/apksigner.bat" verify --verbose $apkFile
  Check-Result
  & "$toolsRoot/aapt.exe" dump badging $apkFile
  Check-Result
  $stream = [IO.File]::OpenRead($apkFile)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { Write-Output ("{0}  {1}" -f [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant(), $apkFile) }
    finally { $sha256.Dispose() }
  } finally { $stream.Dispose() }
} finally { Pop-Location }
