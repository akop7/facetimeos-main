param([string]$JavaPath = 'C:/Program Files/Android/Android Studio1/jbr', [string]$SdkPath = "$env:LOCALAPPDATA/Android/Sdk", [string]$GradlePath = '', [switch]$FingerprintsOnly)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath "$projectDir/package.json" -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$') { throw 'Invalid release version.' }
$signingDir = Join-Path $env:LOCALAPPDATA 'FaceTimeOS/signing'
$keyFile = Join-Path $signingDir 'android-release.jks'
$passwordFile = Join-Path $signingDir 'android-release-password.dpapi'
if (!(Test-Path -LiteralPath "$JavaPath/bin/keytool.exe")) { throw 'Set -JavaPath to a JDK 17/21 installation.' }
if (!(Test-Path -LiteralPath $signingDir)) { New-Item -ItemType Directory -Path $signingDir | Out-Null }
& icacls.exe $signingDir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to signing credentials.' }
if (!(Test-Path -LiteralPath $keyFile)) {
  if (Test-Path -LiteralPath $passwordFile) { throw 'Signing password exists without its key. Restore the original key; do not generate a replacement for an existing release.' }
  $randomBytes = New-Object byte[] 36
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
  $randomPassword = [Convert]::ToBase64String($randomBytes)
  $securePassword = ConvertTo-SecureString $randomPassword -AsPlainText -Force
  $securePassword | ConvertFrom-SecureString | Set-Content -LiteralPath $passwordFile -NoNewline
  $env:FTOS_ANDROID_KEY_PASSWORD = $randomPassword
  $randomPassword = $null
  & "$JavaPath/bin/keytool.exe" -genkeypair -keystore $keyFile -storetype JKS -alias facetimeos-android -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=FaceTimeOS Android, OU=Mobile, O=FaceTimeOS, C=IN' -storepass:env FTOS_ANDROID_KEY_PASSWORD -keypass:env FTOS_ANDROID_KEY_PASSWORD
  if ($LASTEXITCODE -ne 0) { throw 'Signing key generation failed. Preserve the signing folder and investigate.' }
} else {
  if (!(Test-Path -LiteralPath $passwordFile)) { throw 'Restore the signing password or original secure backup before building.' }
  $securePassword = Get-Content -LiteralPath $passwordFile -Raw | ConvertTo-SecureString
  $env:FTOS_ANDROID_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $securePassword).Password
}
$env:FTOS_ANDROID_KEYSTORE = $keyFile
$env:JAVA_HOME = $JavaPath
$env:ANDROID_HOME = $SdkPath
$env:FTOS_ANDROID_CXX_DIR = Join-Path $env:LOCALAPPDATA 'FaceTimeOS/cxx'
try {
  & "$JavaPath/bin/keytool.exe" -list -v -keystore $keyFile -alias facetimeos-android -storepass:env FTOS_ANDROID_KEY_PASSWORD | Select-String 'SHA1:|SHA256:|Valid from:|Owner:'
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read signing identity.' }
  if ($FingerprintsOnly) { return }
  if (!(Test-Path -LiteralPath "$projectDir/android/app/google-services.json")) { throw 'Place the Firebase Android google-services.json in android/app first.' }
  Push-Location "$projectDir/android"
  try {
    $gradleCommand = if ($GradlePath) { $GradlePath } else { './gradlew.bat' }
    & $gradleCommand assembleRelease '-PreactNativeArchitectures=arm64-v8a,x86_64' --no-daemon --console=plain --max-workers=2
    if ($LASTEXITCODE -ne 0) { throw 'Android release build failed.' }
  } finally { Pop-Location }
  $apk = Join-Path $projectDir 'android/app/build/outputs/apk/release/app-release.apk'
  & "$SdkPath/build-tools/36.0.0/apksigner.bat" verify --verbose --print-certs $apk
  if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed; do not publish.' }
  $releaseDir = Join-Path $projectDir 'release'
  New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
  $releaseApk = Join-Path $releaseDir "FaceTimeOS-$version-android.apk"
  Copy-Item -LiteralPath $apk -Destination $releaseApk
  $checksum = (Get-FileHash -LiteralPath $releaseApk -Algorithm SHA256).Hash.ToLowerInvariant()
  "$checksum  $([IO.Path]::GetFileName($releaseApk))" | Set-Content -LiteralPath "$releaseApk.sha256" -Encoding ascii
  Get-FileHash -LiteralPath $releaseApk -Algorithm SHA256
} finally {
  Remove-Item Env:FTOS_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:FTOS_ANDROID_KEYSTORE -ErrorAction SilentlyContinue
  Remove-Item Env:FTOS_ANDROID_CXX_DIR -ErrorAction SilentlyContinue
}
