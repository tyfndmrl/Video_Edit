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

## Üç mod — küratörlü / sistem / yok

Metin rasteri bir `fontId`'yi **daima bu sırayla** çözer (`FontResolver`):

| # | Mod | Ne zaman | Sonuç | Belirlenimci? | Dağıtılabilir mi? |
|---|---|---|---|---|---|
| 1 | **Küratörlü** | `manifest.json`'daki TTF diskte **var** | `FontSource = Curated`, sha256 pini doğrulanır | **Evet** — aynı proje her makinede bayt bayt aynı PNG | Evet (OFL/Apache; dosyalar bizim) |
| 2 | **Sistem** | TTF yok ama `systemFallback` eşlemesi yerel makinede bulundu | `FontSource = System`, `RasterResult.FontWarning` dolu, `Deterministic = false`, worker **UYARI** loglar | **Hayır** — makinedeki font sürümüne göre piksel/satır kırılımı değişir | **Hayır** — sistem fontları (Arial, Segoe UI, Times New Roman…) yeniden dağıtılamaz |
| 3 | **Yok** | ikisi de yok | `font-missing` (deterministik hata, worker retry etmez) | — | — |

**Sistem fontu dosyaları depoya kopyalanmaz.** Yalnız çalışma zamanında yerel yoldan
(`C:\Windows\Fonts`, `/usr/share/fonts`, …) ya da `SKFontManager` ile açılır. Bu mod
POC/geliştirme kolaylığıdır: font indirilmemiş bir kurulumda metin overlay'i çalışsın diye
vardır. **Üretim dağıtımı için 1. mod şarttır** — hem lisans (yalnız küratörlü set bizimle
birlikte dağıtılabilir) hem belirlenimcilik (render çiftliğindeki iki makine aynı kareyi
üretmelidir) nedeniyle. Piksel golden testleri yalnız 1. modda koşar (`CuratedFontFact`).

Bir işte sistem fontu kullanıldıysa worker şunu loglar (ve `OverlayRasterSet.ClipsUsingSystemFont`
etkilenen klipleri sayar):

```
[warn] Fonts: fontId 'roboto' için küratörlü TTF kurulu değil; SİSTEM FONTU kullanılıyor:
'Arial' (FileProbe) → C:\Windows\Fonts\arial.ttf. Bu render BELİRLENİMCİ DEĞİLDİR …
```

### Sistem eşlemesini yapılandırma

Varsayılan eşlemeler (`SystemFontDefaults` + manifestteki `systemFallback`) — sırayla denenir,
ilk bulunan kazanır:

| `fontId` | Aday aileler |
|---|---|
| `roboto` | Roboto → Arial → Liberation Sans → DejaVu Sans |
| `open-sans` | Open Sans → Segoe UI → DejaVu Sans → Liberation Sans |
| `noto-sans` | Noto Sans → Segoe UI → DejaVu Sans → Liberation Sans |
| `noto-serif` | Noto Serif → Times New Roman → Liberation Serif → DejaVu Serif |

Öncelik: **appsettings `Fonts:SystemFallback:<fontId>`** → manifestteki `systemFallback` →
yerleşik tablo. Aday bir **aile adı** ya da **mutlak dosya yolu** olabilir:

```jsonc
// appsettings.json (worker)
"Fonts": {
  "AllowSystemFallback": true,               // false: 2. mod kapanır, eksik font yine 'font-missing'
  "SystemFallback": {
    "roboto": "Inter, Arial",                // aile adları (virgülle sıralı)
    "noto-serif": "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"
  }
}
```

Ortam değişkeni karşılığı (aynı anahtarlar, `:` → `__`) — DI'a bağlamadan da çalışır:

```bash
Fonts__SystemFallback__roboto="Liberation Sans"
Fonts__AllowSystemFallback=false
VIDEOEDIT_SYSTEM_FONT_DIRS=/opt/fonts   # taranacak sistem font dizinlerini ezer
```

> Linux worker imajı `SkiaSharp.NativeAssets.Linux.NoDependencies` kullanır: fontconfig yoktur,
> dolayısıyla `SKFontManager` **boştur** ve sistem fontu yalnız **dizin taramasıyla** bulunur
> (`/usr/share/fonts` vb. — imajda font paketi kurulu değilse 2. mod da devre dışıdır).

## Set

| `fontId` | Aile | Lisans | Kaynak |
|---|---|---|---|
| `roboto` | Roboto | Apache-2.0 | github.com/googlefonts/Roboto |
| `open-sans` | Open Sans | OFL-1.1 | github.com/googlefonts/opensans |
| `noto-sans` | Noto Sans | OFL-1.1 | github.com/notofonts/notofonts.github.io |
| `noto-serif` | Noto Serif | OFL-1.1 | github.com/notofonts/notofonts.github.io |

Her ailede 4 stil: `400`, `400i`, `700`, `700i`.

## Editör bu listeyi NEREDEN alır — `GET /api/fonts`

**Tahmin etmez, sorar.** M4 dalga-2 denetimine kadar editörde ayrı, SABİT KODLU bir liste
vardı (`inter/roboto/georgia/impact/courier`, varsayılan `inter`) ve bu manifestle neredeyse
ayrık bir kümeydi: varsayılan id burada YOKTU, yani "metin ekle → dışa aktar" ana yolu her
seferinde `font-missing` ile düşüyordu (KRİTİK bulgu #1). Artık:

| Uç | Ne döner | Kim kullanır |
|---|---|---|
| `GET /api/fonts` | bu dosyanın izdüşümü: `fontId`, aile, ağırlıklar, stiller, sürüm/lisans, pin durumu | editör açılışta (react-query) |
| `GET /api/fonts/{fontId}/{styleKey}.ttf` | **küratörlü TTF'nin kendisi** | tarayıcı `@font-face` |

İki uç da **kimlik doğrulaması istemez** (kullanıcı verisi yok, lisanslar yeniden dağıtıma
izin verir, editör oturum açılmadan önce yükler). Tarayıcı fontu `ve-<fontId>` **özel aile
adıyla** yükler; makinede kurulu bir "Roboto" ölçümü kaçıramasın diye.

Ağ yoksa editör sırayla (1) `localStorage`'daki son bilinen listeye, (2) derlenmiş 4
küratörlü id'ye düşer. Her iki dalda da yazılan `fontId` bu dosyanın anahtarıdır — offline
yazılmış bir belge de export edilebilir. Bunu `fontManifest.contract.test.ts` **bu dosyayı
okuyarak** sabitler; ayrıca `POST /api/projects/{id}/exports` manifestte olmayan bir
`fontId` görürse **422** verir (3 dakika render edip `font-missing` ile düşmek yerine).

Manifest sunucuda okunamıyorsa `GET /api/fonts` **503** döner (500 değil) ve editör yukarıdaki
yedeklere düşer.

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
4. `fontId` manifest'te **yoksa** → **hata** (bu bir şema ihlalidir; sistem fontuna düşülmez).
5. `fontId` var ama dosya diskte yoksa → yukarıdaki **2. mod** (yapılandırılmış sistem fontu,
   işaretli + uyarılı); o da yoksa **hata**. sha256 pini tutmayan dosya da **hatadır** —
   değiştirilmiş bir font sistem fontuyla sessizce örtülmez.

`manifest.json`'daki `allowSystemFallback` bayrağı **bambaşka bir şeydir ve kapalı kalır**:
o, *glif düzeyinde* Skia fallback zinciridir (aynı metnin içindeki emoji için başka bir fonta
atlamak). Açılırsa satır kırılımı bile makineye bağlı olurdu. Yukarıdaki 2. mod ise *dosya
düzeyindedir*: fontId'nin tamamı tek bir yerel fontla çizilir ve sonuç açıkça işaretlenir.

**Emoji:** küratörlü set emoji fontu içermez. Emoji içeren metin `.notdef` kutusu ("tofu")
olarak çizilir ve raster sonucu `HasMissingGlyphs = true` döner (sessiz kalmaz). Emoji desteği
ayrı bir `fontId` (ör. Noto Color Emoji) + fallback zinciri gerektirir — `docs/backlog.md`.

## Worker / Docker

Worker imajında font kökü `VIDEOEDIT_FONT_ROOT` ile verilir (varsayılan `/data/fonts`,
kalıcı `worker_data` volume'unda). Kurulum:

```bash
OUTPUT_ROOT=/data/fonts ./fonts/fetch-fonts.sh
```

Font kökü bulunamazsa worker **açılışta uyarır** (düşmez); metin klibi içeren bir export
denendiğinde yukarıdaki **2. moda** (sistem fontu, uyarılı) düşer, o da yoksa `font-missing`
ile başarısız olur.

> **Üretim kontrol listesi:** dağıtımdan önce `fetch-fonts` çalıştırılmış olmalı ve
> `Fonts:AllowSystemFallback = false` yapılmalıdır. O zaman eksik font sessizce sistem fontuna
> kaymak yerine yine deterministik hata verir ve export'ların belirlenimciliği garanti kalır
> (`docs/backlog.md` — "üretim dağıtımı öncesi küratörlü font seti").
