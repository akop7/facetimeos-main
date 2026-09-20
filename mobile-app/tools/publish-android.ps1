param([Parameter(Mandatory=$true)][string]$Commit, [Parameter(Mandatory=$true)][string]$NotesPath)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath "$projectDir/package.json" -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+-beta\.\d+$') { throw 'This publishing script is for Android beta releases.' }
$apk = Join-Path $projectDir "release/FaceTimeOS-$version-android.apk"
$tag = "android-v$version"
if ($Commit -notmatch '^[0-9a-f]{40}$') { throw 'Supply the full tested Git commit.' }
if (!(Test-Path -LiteralPath $apk) -or !(Test-Path -LiteralPath "$apk.sha256")) { throw 'Build and verify the release first.' }
$actualHash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
if (!(Get-Content -LiteralPath "$apk.sha256" -Raw).StartsWith($actualHash)) { throw 'APK checksum mismatch.' }
$credentialFields = @{}
$headers = @{}
try {
  # Ask the existing Git credential helper without displaying or persisting its token.
  $credentialText = "protocol=https`nhost=github.com`n`n" | git credential fill
  foreach ($line in $credentialText) { if ($line -match '^([^=]+)=(.*)$') { $credentialFields[$matches[1]] = $matches[2] } }
  if (!$credentialFields.password) { throw 'Sign in to GitHub using Git Credential Manager first.' }
  $headers = @{ Authorization = 'Bearer ' + $credentialFields.password; 'User-Agent' = 'FaceTimeOS-release'; Accept = 'application/vnd.github+json' }
  $base = 'https://api.github.com/repos/AlokGond/facetimeos'
  $remoteCommit = Invoke-RestMethod "$base/commits/$Commit" -Headers $headers
  if ($remoteCommit.sha -ne $Commit) { throw 'Push the tested commit first.' }
  $existing = @(Invoke-RestMethod "$base/releases" -Headers $headers) | Where-Object tag_name -eq $tag
  if ($existing) { throw 'This release already exists. Inspect it; do not overwrite published APKs.' }
  $release = Invoke-RestMethod "$base/releases" -Method Post -Headers $headers -ContentType 'application/json' -Body (@{tag_name=$tag; target_commitish=$Commit; name="FaceTimeOS Android $version"; draft=$true; prerelease=$true; body=(Get-Content -LiteralPath $NotesPath -Raw)} | ConvertTo-Json)
  foreach ($file in @($apk, "$apk.sha256")) {
    $assetName = [Uri]::EscapeDataString([IO.Path]::GetFileName($file))
    $uploadUrl = $release.upload_url.Split('{')[0] + '?name=' + $assetName
    $asset = Invoke-RestMethod $uploadUrl -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $file -TimeoutSec 300
    if ($asset.size -ne (Get-Item -LiteralPath $file).Length) { throw 'Uploaded asset size mismatch; release left as draft.' }
    if ($file -eq $apk -and $asset.digest -and $asset.digest -ne "sha256:$actualHash") { throw 'Uploaded APK digest mismatch; release left as draft.' }
  }
  $published = Invoke-RestMethod "$base/releases/$($release.id)" -Method Patch -Headers $headers -ContentType 'application/json' -Body '{"draft":false,"prerelease":true,"make_latest":"false"}'
  Write-Output $published.html_url
} finally {
  $credentialFields.Clear(); $headers.Clear(); $credentialText = $null
}
