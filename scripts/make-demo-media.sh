#!/usr/bin/env bash
# POC demo medyasini ffmpeg ile URETIR (repoya ikili dosya konmaz).
#
# make-demo-media.ps1 ile AYNI dosyalari ayni parametrelerle uretir:
#
#   demo-01-gradyan.mp4      10 sn, 1920x1080, 30 fps, sesli (330 Hz)  ~7 MB
#   demo-02-test-deseni.mp4  10 sn, 1920x1080, 30 fps, sesli (660 Hz)  ~8 MB
#   demo-03-logo.png         640x640 RGBA (saydam zeminli halka)       ~7 KB
#
# Icerik SENTETIKTIR (ffmpeg lavfi kaynaklari): telif/gizlilik derdi yok, her
# makinede birebir ayni. Iki videonun renk imzasi bilerek FARKLIDIR - gecis
# (crossfade) ve renk duzeltme adimlarinda ekranda degisim GORULSUN.
#
# Cikti varsayilani <repo>/.artifacts/demo-media; ".artifacts/" kok
# .gitignore'da oldugu icin repoya hicbir ikili dosya sizmaz.
#
# Kullanim:
#   scripts/make-demo-media.sh [-o CIKTI_KLASORU] [-f]
#     -o  cikti klasoru
#     -f  dosyalar dursa da yeniden uret
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$REPO_ROOT/.artifacts/demo-media"
FORCE=0

while getopts ":o:f" opt; do
  case "$opt" in
    o) OUT_DIR="$OPTARG" ;;
    f) FORCE=1 ;;
    *) echo "Kullanim: $0 [-o CIKTI_KLASORU] [-f]" >&2; exit 2 ;;
  esac
done

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg PATH'te yok. Kurulum: apt install ffmpeg / brew install ffmpeg" >&2; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "ffprobe PATH'te yok (ffmpeg paketiyle gelir)." >&2; exit 1; }

mkdir -p "$OUT_DIR"
echo "Cikti klasoru: $OUT_DIR"

MAX_BYTES=$((20 * 1024 * 1024))

make_video() {
  local path="$1" src="$2" tone="$3" secs="$4"
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "$src" \
    -f lavfi -i "sine=frequency=${tone}:sample_rate=48000:duration=${secs}" \
    -t "$secs" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 6000k \
    -c:a aac -b:a 128k \
    -shortest -movflags +faststart \
    "$path"
}

VIDEO1="$OUT_DIR/demo-01-gradyan.mp4"
if [ "$FORCE" = "1" ] || [ ! -f "$VIDEO1" ]; then
  echo "demo-01-gradyan.mp4 uretiliyor..."
  make_video "$VIDEO1" \
    'gradients=s=1920x1080:rate=30:c0=0x0f2027:c1=0xf7971e:c2=0x2c5364:c3=0xff5f6d:n=4:type=radial:speed=0.02:duration=10' \
    330 10
else
  echo "demo-01-gradyan.mp4 zaten var (atlandi)."
fi

# Kare sayaci demo sirasinda ise yarar: "1 kare ileri" kisayolu goz onunde
# dogrulanabilir.
VIDEO2="$OUT_DIR/demo-02-test-deseni.mp4"
if [ "$FORCE" = "1" ] || [ ! -f "$VIDEO2" ]; then
  echo "demo-02-test-deseni.mp4 uretiliyor..."
  make_video "$VIDEO2" 'testsrc2=s=1920x1080:rate=30:duration=10' 660 10
else
  echo "demo-02-test-deseni.mp4 zaten var (atlandi)."
fi

# Cikartma / PiP adiminda alfa kanalinin gercekten korundugu gorunsun diye tam
# kare bir gorsel degil, ORTASI BOS bir halka uretilir.
IMAGE="$OUT_DIR/demo-03-logo.png"
if [ "$FORCE" = "1" ] || [ ! -f "$IMAGE" ]; then
  echo "demo-03-logo.png uretiliyor..."
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "color=c=black:s=640x640,format=rgba" \
    -vf "geq=r='255*(1-0.6*(Y/H))':g='90+120*(X/W)':b='40':a='255*between(hypot(X-320,Y-320),190,300)'" \
    -frames:v 1 \
    "$IMAGE"
else
  echo "demo-03-logo.png zaten var (atlandi)."
fi

echo
echo "Uretilen dosyalar:"
for f in "$VIDEO1" "$VIDEO2" "$IMAGE"; do
  [ -f "$f" ] || { echo "Beklenen dosya olusmadi: $f" >&2; exit 1; }
  size=$(wc -c < "$f" | tr -d ' ')
  if [ "$size" -gt "$MAX_BYTES" ]; then
    echo "$(basename "$f") 20 MB sinirini asti ($size bayt)." >&2
    exit 1
  fi
  info=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height -show_entries format=duration \
    -of default=nw=1:nk=1 "$f" | tr '\n' ' ')
  printf '%-26s %10s bayt   %s\n' "$(basename "$f")" "$size" "$info"
done

echo
echo "Sonraki adim (Windows): powershell -ExecutionPolicy Bypass -File scripts\\seed-demo.ps1 -MediaDir \"$OUT_DIR\""
