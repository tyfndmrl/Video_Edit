#!/usr/bin/env bash
# Küratörlü font setini manifest.json'daki resmî adreslerden indirir ve sha256 pinlerini yazar.
# TTF dosyaları depoya GİRMEZ (fonts/.gitignore) — bkz. fonts/README.md.
#
#   ./fonts/fetch-fonts.sh                 # indir + manifest.lock.json yaz
#   ./fonts/fetch-fonts.sh --verify-only   # indirme yok, yalnız pin doğrula
#   OUTPUT_ROOT=/data/fonts ./fonts/fetch-fonts.sh
#
# Bağımlılık: curl, jq, sha256sum (ya da shasum -a 256).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="$script_dir/manifest.json"
output_root="${OUTPUT_ROOT:-$script_dir}"
verify_only=0
force=0

for arg in "$@"; do
  case "$arg" in
    --verify-only) verify_only=1 ;;
    --force) force=1 ;;
    *) echo "bilinmeyen argüman: $arg" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null || { echo "jq gerekli (apt-get install -y jq)" >&2; exit 2; }
[ -f "$manifest" ] || { echo "manifest bulunamadı: $manifest" >&2; exit 2; }

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

lock_path="$output_root/manifest.lock.json"
declare -A lock_files
if [ -f "$lock_path" ]; then
  while IFS=$'\t' read -r k v; do lock_files["$k"]="$v"; done \
    < <(jq -r '.files // {} | to_entries[] | "\(.key)\t\(.value)"' "$lock_path")
fi

downloaded=0; skipped=0; verified=0; failed=0
declare -a lock_out

while IFS=$'\t' read -r font_id style_key relative url pinned; do
  target="$output_root/$relative"
  lock_key="$font_id/$style_key"

  if [ "$force" = "1" ] || [ ! -f "$target" ]; then
    if [ "$verify_only" = "1" ] || [ -z "$url" ] || [ "$url" = "null" ]; then
      if [ ! -f "$target" ]; then
        echo "  HATA  $lock_key : dosya yok ($target)"; failed=$((failed+1)); continue
      fi
    else
      mkdir -p "$(dirname "$target")"
      echo "indiriliyor  $lock_key  <- $url"
      if curl -fsSL --max-time 120 -o "$target.part" "$url"; then
        mv -f "$target.part" "$target"; downloaded=$((downloaded+1))
      else
        rm -f "$target.part"
        echo "  HATA  $lock_key : indirilemedi ($url)"; failed=$((failed+1)); continue
      fi
    fi
  else
    skipped=$((skipped+1))
  fi

  hash="$(sha256_of "$target")"
  expected="$pinned"
  if [ -z "$expected" ] || [ "$expected" = "null" ]; then expected="${lock_files[$lock_key]:-}"; fi
  if [ -n "$expected" ]; then
    if [ "$expected" != "$hash" ]; then
      echo "  HATA  $lock_key : SHA256 PİN İHLALİ (beklenen $expected, bulunan $hash)"
      failed=$((failed+1)); continue
    fi
    verified=$((verified+1))
  fi

  lock_out+=("$lock_key	$hash")
done < <(jq -r '
  .fonts | to_entries[] as $f
  | $f.value.files | to_entries[]
  | [$f.key, .key, .value,
     ($f.value.urls[.key] // ""), ($f.value.sha256[.key] // "")]
  | @tsv' "$manifest")

if [ "$verify_only" != "1" ]; then
  {
    printf '{\n  "lockVersion": 1,\n  "files": {\n'
    printf '%s\n' "${lock_out[@]}" | sort | awk -F'\t' '
      { entries[NR] = sprintf("    \"%s\": \"%s\"", $1, $2) }
      END { for (i = 1; i <= NR; i++) printf "%s%s\n", entries[i], (i < NR ? "," : "") }'
    printf '  }\n}\n'
  } > "$lock_path"
  echo "lock yazıldı: $lock_path"
fi

echo ""
echo "indirilen: $downloaded | mevcut: $skipped | pin doğrulanan: $verified | hata: $failed"
[ "$failed" -eq 0 ]
