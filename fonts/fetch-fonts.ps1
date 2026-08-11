<#
.SYNOPSIS
  Küratörlü font setini manifest.json'daki resmî adreslerden indirir ve sha256 pinlerini yazar.

.DESCRIPTION
  TTF dosyaları depoya GİRMEZ (fonts/.gitignore). Bu script onları manifest'in gösterdiği
  yerlere indirir ve manifest.lock.json'a sha256 pinlerini yazar; sonraki koşularda dosyaların
  sessizce değişmediği bu pinlerle doğrulanır (rendering-semantics §7 sürüm pinleme).

  İndirme yapılmadan yalnız doğrulama için: -VerifyOnly.

.EXAMPLE
  pwsh fonts/fetch-fonts.ps1
  pwsh fonts/fetch-fonts.ps1 -VerifyOnly
  pwsh fonts/fetch-fonts.ps1 -OutputRoot /data/fonts   # worker volume'una kurulum
#>
[CmdletBinding()]
param(
    [string]$OutputRoot,
    [switch]$Force,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $scriptDir 'manifest.json'
if (-not (Test-Path $manifestPath)) {
    throw "Manifest bulunamadi: $manifestPath"
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) { $OutputRoot = $scriptDir }
$OutputRoot = (Resolve-Path -LiteralPath $OutputRoot -ErrorAction SilentlyContinue).Path
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    New-Item -ItemType Directory -Force -Path $PSBoundParameters['OutputRoot'] | Out-Null
    $OutputRoot = (Resolve-Path -LiteralPath $PSBoundParameters['OutputRoot']).Path
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$lockPath = Join-Path $OutputRoot 'manifest.lock.json'

$lockFiles = @{}
if (Test-Path $lockPath) {
    $existingLock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($existingLock.files) {
        foreach ($p in $existingLock.files.PSObject.Properties) { $lockFiles[$p.Name] = $p.Value }
    }
}

$downloaded = 0
$skipped = 0
$verified = 0
$failed = @()

foreach ($fontProp in $manifest.fonts.PSObject.Properties) {
    $fontId = $fontProp.Name
    $entry = $fontProp.Value

    foreach ($fileProp in $entry.files.PSObject.Properties) {
        $styleKey = $fileProp.Name
        $relative = $fileProp.Value
        $target = Join-Path $OutputRoot $relative
        $lockKey = "$fontId/$styleKey"

        $url = $null
        if ($entry.urls -and $entry.urls.PSObject.Properties[$styleKey]) {
            $url = $entry.urls.PSObject.Properties[$styleKey].Value
        }

        $needsDownload = $Force -or (-not (Test-Path $target))
        if ($needsDownload -and -not $VerifyOnly) {
            if ([string]::IsNullOrWhiteSpace($url)) {
                $failed += "$lockKey : manifest'te 'urls' girdisi yok, dosya da yok ($target)"
                continue
            }

            $dir = Split-Path -Parent $target
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

            Write-Host "indiriliyor  $lockKey  <- $url"
            $tmp = "$target.part"
            try {
                Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -MaximumRedirection 5
                Move-Item -LiteralPath $tmp -Destination $target -Force
                $downloaded++
            }
            catch {
                if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force }
                $failed += "$lockKey : indirilemedi ($url) - $($_.Exception.Message)"
                continue
            }
        }
        elseif (-not (Test-Path $target)) {
            $failed += "$lockKey : dosya yok ($target)"
            continue
        }
        else {
            $skipped++
        }

        $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()

        # Manifest'te satir ici pin varsa O kazanir; yoksa lock dosyasi pinidir.
        $pinned = $null
        if ($entry.sha256 -and $entry.sha256.PSObject.Properties[$styleKey]) {
            $pinned = $entry.sha256.PSObject.Properties[$styleKey].Value
        }
        if ([string]::IsNullOrWhiteSpace($pinned) -and $lockFiles.ContainsKey($lockKey)) {
            $pinned = $lockFiles[$lockKey]
        }

        if (-not [string]::IsNullOrWhiteSpace($pinned)) {
            if ($pinned.ToLowerInvariant() -ne $hash) {
                $failed += "$lockKey : SHA256 PIN IHLALI (beklenen $pinned, bulunan $hash) - $target"
                continue
            }
            $verified++
        }

        $lockFiles[$lockKey] = $hash
    }
}

if (-not $VerifyOnly) {
    $ordered = [ordered]@{}
    foreach ($k in ($lockFiles.Keys | Sort-Object)) { $ordered[$k] = $lockFiles[$k] }
    $lock = [ordered]@{ lockVersion = 1; files = $ordered }
    ($lock | ConvertTo-Json -Depth 5) | Out-File -LiteralPath $lockPath -Encoding utf8
    Write-Host "lock yazildi: $lockPath"
}

Write-Host ""
Write-Host "indirilen: $downloaded | mevcut: $skipped | pin dogrulanan: $verified | hata: $($failed.Count)"
if ($failed.Count -gt 0) {
    foreach ($f in $failed) { Write-Host "  HATA  $f" }
    exit 1
}
