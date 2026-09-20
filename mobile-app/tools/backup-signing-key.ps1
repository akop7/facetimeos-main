param([Parameter(Mandatory=$true)][string]$Destination, [string]$JavaPath = 'C:/Program Files/Android/Android Studio1/jbr')
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw 'Choose a new backup filename; existing backups will not be overwritten.' }
if ([IO.Path]::GetExtension($target) -ne '.p12') { throw 'Use a .p12 filename on your secure backup drive.' }
$signingDir = Join-Path $env:LOCALAPPDATA 'FaceTimeOS/signing'
$original = Get-Content -LiteralPath (Join-Path $signingDir 'android-release-password.dpapi') -Raw | ConvertTo-SecureString
$backupPassword = Read-Host 'New backup password (save it in your password manager)' -AsSecureString
try {
  $env:FTOS_BACKUP_SOURCE_PASS = [Net.NetworkCredential]::new('', $original).Password
  $env:FTOS_BACKUP_DEST_PASS = [Net.NetworkCredential]::new('', $backupPassword).Password
  if ($env:FTOS_BACKUP_DEST_PASS.Length -lt 12) { throw 'Use a backup password of at least 12 characters.' }
  & "$JavaPath/bin/keytool.exe" -importkeystore -srckeystore (Join-Path $signingDir 'android-release.jks') -srcstoretype JKS -srcalias facetimeos-android -srcstorepass:env FTOS_BACKUP_SOURCE_PASS -srckeypass:env FTOS_BACKUP_SOURCE_PASS -destkeystore $target -deststoretype PKCS12 -deststorepass:env FTOS_BACKUP_DEST_PASS -destkeypass:env FTOS_BACKUP_DEST_PASS -noprompt
  if ($LASTEXITCODE -ne 0) { throw 'Backup failed. Keep the original signing folder.' }
  Write-Output "Portable signing backup created: $target. Keep its password separately. Never upload either to GitHub."
} finally {
  Remove-Item Env:FTOS_BACKUP_SOURCE_PASS -ErrorAction SilentlyContinue
  Remove-Item Env:FTOS_BACKUP_DEST_PASS -ErrorAction SilentlyContinue
}
