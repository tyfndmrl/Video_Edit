<#
.SYNOPSIS
    POC demosu icin kullanici + proje olusturur ve demo medyasini API uzerinden yukler.

.DESCRIPTION
    docs/demo-senaryosu.md'nin "Hazirlik" adimini otomatiklestirir. UI'a hic
    dokunmaz; ayni REST sozlesmesini kullanir:

      POST /api/auth/register | /api/auth/login
      POST /api/projects
      POST /api/projects/{projectId}/assets        (multipart baslat)
      POST /api/assets/{id}/parts/presign          (imzali PUT adresi)
      PUT  <presigned url>                         (dosyanin kendisi -> MinIO/R2)
      POST /api/assets/{id}/complete               (isleme kuyruga girer)
      GET  /api/assets/{id}                        (status: ready olana kadar)

    Demoyu ANLATIRKEN yukleme beklemek istemiyorsaniz bu betigi onceden
    kosun: medya "Hazir" durumda hazir bekler. Yuklemenin KENDISINI gostermek
    istiyorsaniz betigi hic kosmayin ya da -SkipMedia ile sadece proje acin.

    Betik hicbir sey SILMEZ ve var olan demo kullanicisini yeniden kullanir
    (kayit 400 donerse girise duser). Her kosumda YENI bir proje acar.

.PARAMETER ApiUrl
    API kok adresi. Varsayilan: http://localhost:5000

.PARAMETER EditorUrl
    Editor (Vite) kok adresi - cikti baglantisi icin. Varsayilan: http://localhost:5173

.PARAMETER Email
    Demo kullanicisi. Varsayilan: demo@videoedit.test

.PARAMETER Password
    Demo sifresi (min 8 karakter, en az bir rakam + bir kucuk harf).
    Varsayilan: demo1234

.PARAMETER ProjectName
    Proje adi. Varsayilan: "POC Demo <tarih-saat>"

.PARAMETER MediaDir
    Yuklenecek dosyalarin klasoru. Varsayilan: <repo>/.artifacts/demo-media
    (scripts/make-demo-media.ps1 ciktisi)

.PARAMETER SkipMedia
    Sadece kullanici + proje olustur, medya yukleme.

.PARAMETER TimeoutSec
    Bir dosyanin "ready" olmasi icin ust sinir. Varsayilan: 300

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\seed-demo.ps1

.NOTES
    On kosul: API + worker + MinIO ayakta (compose.dev.yml). Medya dosyalari
    icin once scripts/make-demo-media.ps1 kosulmalidir.
    Windows PowerShell 5.1 ile uyumludur.
#>
[CmdletBinding()]
param(
    [string] $ApiUrl = 'http://localhost:5000',
    [string] $EditorUrl = 'http://localhost:5173',
    [string] $Email = 'demo@videoedit.test',
    [string] $Password = 'demo1234',
    [string] $ProjectName,
    [string] $MediaDir,
    [switch] $SkipMedia,
    [int] $TimeoutSec = 300
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest ilerleme cubugu buyuk PUT'lari yavaslatir

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $MediaDir) { $MediaDir = Join-Path $repoRoot '.artifacts\demo-media' }
if (-not $ProjectName) { $ProjectName = "POC Demo $(Get-Date -Format 'dd.MM HH:mm')" }

# contentType SUNUCU whitelist'inden gelir (UploadRules.ContentTypeKinds);
# uzantidan tahmin edip yanlis tip gondermek 400 uretir.
$contentTypes = @{
    '.mp4'  = 'video/mp4'
    '.mov'  = 'video/quicktime'
    '.webm' = 'video/webm'
    '.mp3'  = 'audio/mpeg'
    '.m4a'  = 'audio/mp4'
    '.wav'  = 'audio/wav'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.webp' = 'image/webp'
}

# --------------------------------------------------------------------------
# HTTP yardimcilari
# --------------------------------------------------------------------------

function Get-ErrorBody {
    param($ErrorRecord)
    # PS 5.1: hata govdesi ($_.ErrorDetails.Message) cogu zaman doludur; degilse
    # response stream'i elle okunur. Sessiz 'bilinmeyen hata' birakmiyoruz.
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        return $ErrorRecord.ErrorDetails.Message
    }
    $resp = $null
    if ($ErrorRecord.Exception.PSObject.Properties['Response']) { $resp = $ErrorRecord.Exception.Response }
    if ($resp -and $resp.GetResponseStream) {
        try {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            return $reader.ReadToEnd()
        }
        catch { }
    }
    return $ErrorRecord.Exception.Message
}

function Get-StatusCode {
    param($ErrorRecord)
    $resp = $null
    if ($ErrorRecord.Exception.PSObject.Properties['Response']) { $resp = $ErrorRecord.Exception.Response }
    if ($resp -and $resp.PSObject.Properties['StatusCode']) { return [int] $resp.StatusCode }
    return 0
}

function Invoke-Api {
    param(
        [Parameter(Mandatory = $true)][string] $Method,
        [Parameter(Mandatory = $true)][string] $Path,
        [string] $JsonBody,
        [string] $Token,
        [string] $What
    )
    $headers = @{}
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }
    $p = @{
        Method          = $Method
        Uri             = "$ApiUrl$Path"
        Headers         = $headers
        UseBasicParsing = $true
        TimeoutSec      = 120
    }
    if ($JsonBody) {
        $p['Body'] = $JsonBody
        $p['ContentType'] = 'application/json'
    }
    try {
        return Invoke-RestMethod @p
    }
    catch {
        $code = Get-StatusCode $_
        $body = Get-ErrorBody $_
        throw "$What basarisiz (HTTP $code) $Method $Path`n$body"
    }
}

# --------------------------------------------------------------------------
# 0) On kosul: API ayakta mi?
# --------------------------------------------------------------------------
Write-Host "API kontrol ediliyor: $ApiUrl/health" -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 10 -UseBasicParsing
}
catch {
    throw @"
API yanit vermiyor ($ApiUrl/health).
Ayaga kaldirin:
  docker compose -f compose.dev.yml up -d postgres redis minio
  dotnet run --project backend/src/VideoEdit.Api
  dotnet run --project backend/src/VideoEdit.Worker
"@
}
Write-Host "  API: $($health.status)" -ForegroundColor Green

# --------------------------------------------------------------------------
# 1) Kullanici: once kayit, olmazsa giris
# --------------------------------------------------------------------------
$token = $null
$registerBody = ConvertTo-Json @{ email = $Email; password = $Password; displayName = 'Demo Kullanici' } -Compress
try {
    $auth = Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/auth/register" `
        -Body $registerBody -ContentType 'application/json' -UseBasicParsing -TimeoutSec 30
    $token = $auth.accessToken
    Write-Host "Demo kullanicisi OLUSTURULDU: $Email" -ForegroundColor Green
}
catch {
    # 400 = e-posta zaten kayitli (Identity DuplicateEmail) -> normal yol.
    $loginBody = ConvertTo-Json @{ email = $Email; password = $Password } -Compress
    try {
        $auth = Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/auth/login" `
            -Body $loginBody -ContentType 'application/json' -UseBasicParsing -TimeoutSec 30
        $token = $auth.accessToken
        Write-Host "Demo kullanicisi mevcut, giris yapildi: $Email" -ForegroundColor Green
    }
    catch {
        throw "Kayit da giris de basarisiz. Kayit hatasi: $(Get-ErrorBody $_)"
    }
}

# --------------------------------------------------------------------------
# 2) Proje
# --------------------------------------------------------------------------
$project = Invoke-Api -Method Post -Path '/api/projects' -Token $token -What 'Proje olusturma' `
    -JsonBody (ConvertTo-Json @{ name = $ProjectName } -Compress)
$projectId = $project.id
Write-Host "Proje olusturuldu: $ProjectName" -ForegroundColor Green
Write-Host "  projectId: $projectId"

# --------------------------------------------------------------------------
# 3) Medya yukleme
# --------------------------------------------------------------------------
function Send-Asset {
    param([System.IO.FileInfo] $File)

    $ext = $File.Extension.ToLowerInvariant()
    if (-not $contentTypes.ContainsKey($ext)) {
        throw "Desteklenmeyen uzanti: $($File.Name) ($ext). Izinli: $($contentTypes.Keys -join ', ')"
    }
    $contentType = $contentTypes[$ext]

    Write-Host "  $($File.Name) ($([math]::Round($File.Length / 1MB, 2)) MB) yukleniyor..."

    # 3a) init
    $init = Invoke-Api -Method Post -Path "/api/projects/$projectId/assets" -Token $token `
        -What "init ($($File.Name))" `
        -JsonBody (ConvertTo-Json @{ fileName = $File.Name; sizeBytes = $File.Length; contentType = $contentType } -Compress)
    $assetId = $init.assetId
    $partSize = [long] $init.partSize
    $partCount = [int] $init.partCount

    # Demo medyasi tek part'a sigar (< 64 MiB). Cok part'li dosya gelirse
    # sessizce yanlis yuklemek yerine acikca reddediyoruz - bu betik demo
    # medyasi icindir, uretim yukleyicisi (uploadEngine.ts) degildir.
    if ($partCount -ne 1) {
        throw "$($File.Name) $partCount part gerektiriyor (part boyutu $partSize B). " +
        'Bu betik yalnizca tek part''lik (< 64 MiB) demo dosyalarini destekler; UI yukleyicisini kullanin.'
    }

    # 3b) presign
    $presignJson = '{"partNumbers":[1]}'   # tek elemanli dizi: ConvertTo-Json 5.1'de skalere duselebiliyor
    $presign = Invoke-Api -Method Post -Path "/api/assets/$assetId/parts/presign" -Token $token `
        -What "presign ($($File.Name))" -JsonBody $presignJson
    $url = (@($presign))[0].url
    if (-not $url) { throw "presign yanitinda url yok ($($File.Name))." }

    # 3c) dosyanin kendisi -> depolama (imzali PUT; API'den GECMEZ)
    try {
        $put = Invoke-WebRequest -Method Put -Uri $url -InFile $File.FullName `
            -UseBasicParsing -TimeoutSec 600
    }
    catch {
        throw "Dosya PUT edilemedi ($($File.Name)) (HTTP $(Get-StatusCode $_)): $(Get-ErrorBody $_)"
    }
    $etag = $put.Headers['ETag']
    if ($etag -is [array]) { $etag = $etag[0] }
    if (-not $etag) {
        throw "Depolama ETag dondurmedi ($($File.Name)) - multipart tamamlanamaz."
    }
    $etag = $etag -replace '"', ''

    # 3d) complete -> isleme kuyruga girer
    $completeJson = '{"parts":[{"partNumber":1,"etag":"' + $etag + '"}]}'
    $complete = Invoke-Api -Method Post -Path "/api/assets/$assetId/complete" -Token $token `
        -What "complete ($($File.Name))" -JsonBody $completeJson
    Write-Host "    yuklendi, durum: $($complete.status)"

    return $assetId
}

function Wait-AssetReady {
    param([string] $AssetId, [string] $FileName)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    # "uploaded"dan hic cikmiyorsa isi ALAN yok -> worker ayakta degil.
    # (apps/editor/e2e/support/library.ts ile ayni teshis.)
    $queueDeadline = (Get-Date).AddSeconds(60)
    $leftQueue = $false
    $last = ''

    while ($true) {
        $asset = Invoke-Api -Method Get -Path "/api/assets/$AssetId" -Token $token -What "durum ($FileName)"
        $last = $asset.status
        if ($last -eq 'ready') {
            $meta = "$($asset.width)x$($asset.height)"
            if ($asset.durationMicros) { $meta += ", $([math]::Round($asset.durationMicros / 1e6, 2)) sn" }
            Write-Host "    HAZIR: $FileName ($meta)" -ForegroundColor Green
            return
        }
        if ($last -eq 'failed') {
            throw "$FileName sunucu tarafinda BASARISIZ oldu (errorCode: $($asset.errorCode))."
        }
        if ($last -eq 'processing') { $leftQueue = $true }

        if (-not $leftQueue -and (Get-Date) -gt $queueDeadline) {
            throw @"
$FileName 60 sn boyunca "$last" durumundan cikmadi - isi kimse almadi.
Medya worker'i calismiyor gorunuyor. Baslatin:
  dotnet run --project backend/src/VideoEdit.Worker
"@
        }
        if ((Get-Date) -gt $deadline) {
            throw "$FileName $TimeoutSec sn icinde hazir olmadi (son durum: $last)."
        }
        Start-Sleep -Milliseconds 1500
    }
}

if ($SkipMedia) {
    Write-Host 'Medya yukleme atlandi (-SkipMedia).' -ForegroundColor DarkGray
}
else {
    if (-not (Test-Path $MediaDir)) {
        throw @"
Medya klasoru yok: $MediaDir
Once uretin:  powershell -ExecutionPolicy Bypass -File scripts\make-demo-media.ps1
"@
    }
    $files = Get-ChildItem -Path $MediaDir -File | Where-Object { $contentTypes.ContainsKey($_.Extension.ToLowerInvariant()) } | Sort-Object Name
    if ($files.Count -eq 0) {
        throw "Medya klasorunde yuklenebilir dosya yok: $MediaDir"
    }

    Write-Host ''
    Write-Host "Medya yukleniyor ($($files.Count) dosya):" -ForegroundColor Cyan
    $assetIds = @{}
    foreach ($f in $files) { $assetIds[$f.Name] = Send-Asset -File $f }

    Write-Host ''
    Write-Host 'Isleme bekleniyor (ffprobe + proxy + filmstrip/waveform):' -ForegroundColor Cyan
    foreach ($f in $files) { Wait-AssetReady -AssetId $assetIds[$f.Name] -FileName $f.Name }
}

# --------------------------------------------------------------------------
# 4) Ozet
# --------------------------------------------------------------------------
$link = "$EditorUrl/?project=$projectId"
Write-Host ''
Write-Host '--------------------------------------------------------------' -ForegroundColor Green
Write-Host 'DEMO HAZIR' -ForegroundColor Green
Write-Host "  Kullanici : $Email / $Password"
Write-Host "  Proje     : $ProjectName"
Write-Host "  Baglanti  : $link"
Write-Host '--------------------------------------------------------------' -ForegroundColor Green
Write-Host 'Akis: docs/demo-senaryosu.md'
