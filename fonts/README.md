# Fontlar — küratörlü set ve `fontId` sözleşmesi

Bu dizin, metin kliplerinin **tek font kaynağıdır**. `docs/rendering-semantics.md` §7 bağlayıcıdır:

- Şemada serbest `fontFamily` **yoktur**; `TextClip.text.fontId` bu dizindeki
  [`manifest.json`](manifest.json) anahtarlarından biridir.
- **Aynı TTF dosyası** hem tarayıcının `@font-face`'ine hem sunucudaki SkiaSharp'a gider.
  Preview ↔ export parity'sinin şartı budur: satır kırılımı ve bbox iki tarafta aynı dosyadan
  ölçülür (çelişkide SkiaSharp kazanır).
- **Sürüm pinlidir.** Bir `fontId`'nin `files` haritası asla değiştirilmez; font güncellemesi
  **yeni** bir `fontId` açar (ör. `roboto` → `roboto-2026`) ve eskisi `"deprecated": true`
  işaretlenir. Böylece mevcut projelerin layout'u (dolayısıyla export'u) değişmez.

## TTF dosyaları depoda YOKTUR — bir kez indirin

`.gitignore` font ikililerini dışarıda tutar (16 dosya, ~9.5 MB). Kurulum:

```powershell
# Windows / PowerShell
pwsh fonts/fetch-fonts.ps1
```

```bash
# Linux / macOS (curl + jq gerekir)
./fonts/fetch-fonts.sh
```

Script `manifest.json` içindeki resmî adreslerden indirir, dosyaları `files` haritasındaki
yerlere koyar ve **`manifest.lock.json`**'a sha256 pinlerini yazar. Sonraki koşularda
(`-VerifyOnly` / `--verify-only`) dosyaların sessizce değişmediği bu pinlerle doğrulanır.

Fontlar indirilmeden metin klibi olan bir projeyi dışa aktarırsanız iş
**`font-missing`** koduyla deterministik olarak başarısız olur (sessizce yanlış fontla render
edilmez) ve hata mesajı bu dosyayı işaret eder.

## Set

| `fontId` | Aile | Lisans | Kaynak |
|---|---|---|---|
| `roboto` | Roboto | Apache-2.0 | github.com/googlefonts/Roboto |
| `open-sans` | Open Sans | OFL-1.1 | github.com/googlefonts/opensans |
| `noto-sans` | Noto Sans | OFL-1.1 | github.com/notofonts/notofonts.github.io |
| `noto-serif` | Noto Serif | OFL-1.1 | github.com/notofonts/notofonts.github.io |

Her ailede 4 stil: `400`, `400i`, `700`, `700i`.

### Neden statik TTF, değişken (variable) font değil?

Kullandığımız **SkiaSharp 3.116.1'de değişken font ekseni sabitleme API'si yoktur**
(`SKFontArguments` kaldırıldı). Değişken bir dosya daima *varsayılan* örneğiyle açılır; yani
`fontWeight: 700` istendiğinde sessizce Regular çizilirdi. Bu yüzden set statik dosyalardan
kuruludur ve her ağırlık kendi dosyasıdır. (SkiaSharp değişken font desteğini geri getirirse
manifest `variableAxes` alanını zaten tanıyor — `FontManifest.Resolve` `wght` eksenini
kırpıp uygular.)

## Font eşleşme kuralı (deterministik)

`FontManifest.Resolve(fontId, weight, italic)`:

1. Tam anahtar (`700i`) varsa o kullanılır.
2. İtalik istendi ama italik dosya yoksa → aynı ağırlığın **dik** dosyası + sentetik oblik
   (`skewX = -0.25`); sonuç `SyntheticItalic` ile işaretlenir.
3. Ağırlık yoksa → `|Δağırlık|` en küçük dosya; eşitlikte **düşük** ağırlık kazanır.
4. `fontId` manifest'te yoksa ya da dosya diskte yoksa → **hata** (sessiz fallback YOK).

Sistem fontlarına düşme (`allowSystemFallback`) **kapalıdır ve kapalı kalmalıdır**: sistem
fontu makineden makineye değişir, açılırsa aynı proje farklı worker'da farklı piksel üretir.

**Emoji:** küratörlü set emoji fontu içermez. Emoji içeren metin `.notdef` kutusu ("tofu")
olarak çizilir ve raster sonucu `HasMissingGlyphs = true` döner (sessiz kalmaz). Emoji desteği
ayrı bir `fontId` (ör. Noto Color Emoji) + fallback zinciri gerektirir — `docs/backlog.md`.

## Worker / Docker

Worker imajında font kökü `VIDEOEDIT_FONT_ROOT` ile verilir (varsayılan `/data/fonts`,
kalıcı `worker_data` volume'unda). Kurulum:

```bash
OUTPUT_ROOT=/data/fonts ./fonts/fetch-fonts.sh
```

Font kökü bulunamazsa worker **açılışta uyarır** (düşmez); yalnız metin klibi içeren bir
export denendiğinde `font-missing` ile başarısız olur.
