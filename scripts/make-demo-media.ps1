<#
.SYNOPSIS
    POC demo medyasini ffmpeg ile URETIR (repoya ikili dosya konmaz).

.DESCRIPTION
    docs/demo-senaryosu.md akisinin ihtiyac duydugu 4 dosyayi uretir:

      demo-01-gradyan.mp4     10 sn, 1920x1080, 30 fps, sesli (330 Hz)  ~7 MB
      demo-02-test-deseni.mp4 10 sn, 1920x1080, 30 fps, sesli (660 Hz)  ~8 MB
      demo-03-logo.png        640x640 RGBA (saydam zeminli halka)       ~7 KB
      demo-04-muzik.m4a       10 sn, AAC 48 kHz (220+330 Hz akor,
                              yavas tremolo) - muzik adimi icin        ~160 KB

    Icerik SENTETIKTIR (ffmpeg lavfi kaynaklari) - telif/gizlilik derdi yok,
    her makinede birebir ayni. Iki videonun renk imzasi bilerek FARKLIDIR:
    gecis (crossfade) ve renk duzeltme adimlarinda ekranda degisim GORULSUN.

    Dosyalar varsayilan olarak <repo>/.artifacts/demo-media altina yazilir;
    ".artifacts/" kok .gitignore'da oldugu icin repoya hicbir ikili dosya
    sizmaz. Var olan dosyalar yeniden uretilmez (-Force ile uretilir).

.PARAMETER OutDir
    Cikti klasoru. Varsayilan: <repo>/.artifacts/demo-media

.PARAMETER Force
    Dosyalar dursa da yeniden uretir.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\make-demo-media.ps1

.NOTES
    Gereksinim: ffmpeg + ffprobe PATH'te (winget install Gyan.FFmpeg).
    Windows PowerShell 5.1 ile uyumludur.
#>
[CmdletBinding()]
param(
    [string] $OutDir,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

# --- Konum -----------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repoRoot '.artifacts\demo-media' }

# --- On kosul: ffmpeg ------------------------------------------------------
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
$ffprobe = Get-Command ffprobe -ErrorAction SilentlyContinue
if (-not $ffmpeg -or -not $ffprobe) {
    throw "ffmpeg/ffprobe PATH'te bulunamadi. Kurulum: winget install Gyan.FFmpeg"
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
Write-Host "Cikti klasoru: $OutDir" -ForegroundColor Cyan

# 20 MB ustu dosya uretmek demo icin de kota icin de gereksiz - sinir sabit.
$maxBytes = 20MB

function Invoke-Ffmpeg {
    param([string[]] $FfArgs, [string] $Label)

    # stderr'i dosyaya alip cikis kodunu ayrica denetliyoruz: PowerShell 5.1'de
    # native stderr'i pipeline'a katmak ErrorRecord uretir (yanlis "hata").
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath $ffmpeg.Source -ArgumentList $FfArgs -NoNewWindow -Wait -PassThru `
            -RedirectStandardError $errFile
        if ($p.ExitCode -ne 0) {
            $err = Get-Content $errFile -Raw
            throw "$Label uretilemedi (ffmpeg exit $($p.ExitCode)):`n$err"
        }
    }
    finally {
        Remove-Item $errFile -Force -ErrorAction SilentlyContinue
    }
}

function New-DemoVideo {
    param(
        [string] $Path,
        [string] $VideoSource,
        [int] $ToneHz,
        [int] $Seconds
    )
    Invoke-Ffmpeg -Label (Split-Path $Path -Leaf) -FfArgs @(
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', $VideoSource,
        '-f', 'lavfi', '-i', "sine=frequency=$ToneHz`:sample_rate=48000:duration=$Seconds",
        '-t', "$Seconds",
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', '6000k',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-movflags', '+faststart',
        $Path
    )
}

# --- 1) Gradyan videosu (sicak renkler, yumusak hareket) --------------------
$video1 = Join-Path $OutDir 'demo-01-gradyan.mp4'
if ($Force -or -not (Test-Path $video1)) {
    Write-Host 'demo-01-gradyan.mp4 uretiliyor...'
    New-DemoVideo -Path $video1 -ToneHz 330 -Seconds 10 `
        -VideoSource 'gradients=s=1920x1080:rate=30:c0=0x0f2027:c1=0xf7971e:c2=0x2c5364:c3=0xff5f6d:n=4:type=radial:speed=0.02:duration=10'
}
else { Write-Host 'demo-01-gradyan.mp4 zaten var (atlandi).' -ForegroundColor DarkGray }

# --- 2) Test deseni videosu (renk barlari + hareketli ogeler + kare sayaci) -
# Kare sayaci demo sirasinda ise yarar: "1 kare ileri" kisayolu goz onunde
# dogrulanabilir.
$video2 = Join-Path $OutDir 'demo-02-test-deseni.mp4'
if ($Force -or -not (Test-Path $video2)) {
    Write-Host 'demo-02-test-deseni.mp4 uretiliyor...'
    New-DemoVideo -Path $video2 -ToneHz 660 -Seconds 10 `
        -VideoSource 'testsrc2=s=1920x1080:rate=30:duration=10'
}
else { Write-Host 'demo-02-test-deseni.mp4 zaten var (atlandi).' -ForegroundColor DarkGray }

# --- 3) Saydam zeminli logo (PNG, RGBA) ------------------------------------
# Cikartma / PiP adiminda alfa kanalinin gercekten korundugu gorunsun diye
# tam kare bir gorsel degil, ORTASI BOS bir halka uretilir.
$image = Join-Path $OutDir 'demo-03-logo.png'
if ($Force -or -not (Test-Path $image)) {
    Write-Host 'demo-03-logo.png uretiliyor...'
    Invoke-Ffmpeg -Label 'demo-03-logo.png' -FfArgs @(
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=640x640,format=rgba',
        '-vf', "geq=r='255*(1-0.6*(Y/H))':g='90+120*(X/W)':b='40':a='255*between(hypot(X-320,Y-320),190,300)'",
        '-frames:v', '1',
        $image
    )
}
else { Write-Host 'demo-03-logo.png zaten var (atlandi).' -ForegroundColor DarkGray }

# --- 4) Muzik (m4a, AAC) - senaryonun "Muzik ekle" adimi (Adim 4M) ---------
# Icerik iki sinusun akoru (220 + 330 Hz = tam beslik) + yavas tremolo:
# dalga formu panelde gorunur bicimde SALINIR ve dinlemesi rahatsiz etmez.
# Genlik: sine kaynagi 0.125 tepe uretir; amix normalize=0 ile 0.25,
# volume=2.2 ile ~0.55 tepe (clipping'e uzak, ama acikca duyulur).
$music = Join-Path $OutDir 'demo-04-muzik.m4a'
if ($Force -or -not (Test-Path $music)) {
    Write-Host 'demo-04-muzik.m4a uretiliyor...'
    Invoke-Ffmpeg -Label 'demo-04-muzik.m4a' -FfArgs @(
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=10',
        '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=10',
        '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=2.2,tremolo=f=0.5:d=0.4',
        '-c:a', 'aac', '-b:a', '128k',
        $music
    )
}
else { Write-Host 'demo-04-muzik.m4a zaten var (atlandi).' -ForegroundColor DarkGray }

# --- Dogrulama + ozet ------------------------------------------------------
Write-Host ''
Write-Host 'Uretilen dosyalar:' -ForegroundColor Green
foreach ($f in @($video1, $video2, $image, $music)) {
    if (-not (Test-Path $f)) { throw "Beklenen dosya olusmadi: $f" }
    $size = (Get-Item $f).Length
    if ($size -gt $maxBytes) {
        throw "$([System.IO.Path]::GetFileName($f)) 20 MB sinirini asti ($size bayt)."
    }
    if ([System.IO.Path]::GetExtension($f) -eq '.m4a') {
        $probe = & $ffprobe.Source -v error -select_streams a:0 `
            -show_entries stream=sample_rate,channels -show_entries format=duration `
            -of default=nw=1:nk=1 $f
    }
    else {
        $probe = & $ffprobe.Source -v error -select_streams v:0 `
            -show_entries stream=width,height -show_entries format=duration `
            -of default=nw=1:nk=1 $f
    }
    $info = ($probe -join ' ').Trim()
    '{0,-26} {1,10:N0} bayt   {2}' -f [System.IO.Path]::GetFileName($f), $size, $info | Write-Host
}
Write-Host ''
Write-Host "Sonraki adim: powershell -ExecutionPolicy Bypass -File scripts\seed-demo.ps1 -MediaDir `"$OutDir`"" -ForegroundColor Cyan
