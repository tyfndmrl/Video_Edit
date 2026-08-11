using VideoEdit.Contracts.Timeline;

namespace VideoEdit.Media.Text;

/// <summary>
/// Manifestin DIŞARI VERİLEBİLİR izdüşümü — <c>GET /api/fonts</c> gövdesi ve
/// "bilinmeyen fontId" ön kontrolü.
/// <para>
/// NEDEN VAR (M4 dalga-2 denetimi, KRİTİK bulgu #1): editör kendi font listesini SABİT
/// KODLUYORDU (<c>inter/roboto/georgia/impact/courier</c>, varsayılan <c>inter</c>) ve bu liste
/// <c>fonts/manifest.json</c> ile (<c>roboto/open-sans/noto-sans/noto-serif</c>) neredeyse
/// AYRIK bir kümeydi. Varsayılan id sunucuda YOKTU: her yeni metin klibi
/// <c>fontId='inter'</c> ile doğuyor, metin içeren her export <c>font-missing</c> ile
/// düşüyordu. Çözüm listeyi TAHMİN ETMEYİ bırakmaktır: katalog manifestten SUNULUR.
/// </para>
/// <para>
/// Bu sınıf Skia'ya DOKUNMAZ (saf izdüşüm + saf doğrulama), böylece API font dosyası kurulu
/// olmasa da katalog döndürebilir ve birim testleri raster hattı olmadan koşar.
/// </para>
/// </summary>
public static class FontCatalogue
{
    /// <summary>Manifest → katalog kayıtları (fontId'ye göre BELİRLENİMCİ sırada).</summary>
    public static IReadOnlyList<FontCatalogueEntry> Project(FontManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        var entries = new List<FontCatalogueEntry>(manifest.Fonts.Count);
        foreach (var (fontId, entry) in manifest.Fonts.OrderBy(f => f.Key, StringComparer.Ordinal))
        {
            var styles = entry.Files.Keys
                .Select(k => FontStyleKey.TryParse(k, out var parsed) ? (Key: k, Parsed: parsed) : (Key: k, Parsed: default))
                .Where(s => s.Parsed.Weight > 0)
                .OrderBy(s => s.Parsed.Weight)
                .ThenBy(s => s.Parsed.Italic)
                .ToList();

            entries.Add(new FontCatalogueEntry(
                Id: fontId,
                Family: entry.Family,
                Version: entry.Version,
                License: entry.License,
                Weights: styles.Select(s => s.Parsed.Weight).Distinct().Order().ToList(),
                Styles: styles.Select(s => s.Key).ToList(),
                Italic: styles.Any(s => s.Parsed.Italic),
                Deprecated: entry.Deprecated));
        }

        return entries;
    }

    /// <summary>
    /// Dokümandaki metin kliplerinin manifestte OLMAYAN fontId'leri (belirlenimci sırada, tekil).
    /// <para>
    /// Bunu export BAŞLAMADAN çağırmak, denetimin (d) maddesidir: kullanıcı 3 dakika render
    /// bekleyip <c>font-missing</c> ile düşmek yerine ANINDA 422 alır.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> UnknownFontIds(TimelineDoc? doc, FontManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        if (doc is null)
        {
            return [];
        }

        var unknown = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var track in doc.Tracks ?? [])
        {
            foreach (var clip in track.Clips ?? [])
            {
                if (clip is not TextClip { Text: { } text })
                {
                    continue;
                }

                // Boş/boşluk fontId de "bilinmeyen"dir: hiçbir manifest anahtarına karşılık
                // gelmez. Rapora BELGEDEKİ değer girer (normalize edilmez) — kullanıcı hangi
                // klibin hangi değeri taşıdığını görebilsin.
                var fontId = text.FontId ?? string.Empty;
                if (string.IsNullOrWhiteSpace(fontId) || !manifest.Fonts.ContainsKey(fontId))
                {
                    unknown.Add(fontId);
                }
            }
        }

        return [.. unknown];
    }

    /// <summary>
    /// <c>fontId</c> + stil anahtarı → diskteki MUTLAK dosya yolu. Yalnız manifestte TANIMLI
    /// anahtarlar kabul edilir ve sonuç manifest kökünün ALTINDA olmak zorundadır — istek
    /// yolundan gelen değerle dosya sistemi gezilemesin (path traversal).
    /// </summary>
    public static bool TryResolveFilePath(
        FontManifest manifest, string fontId, string styleKey, out string absolutePath)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        absolutePath = string.Empty;

        if (string.IsNullOrWhiteSpace(fontId) || string.IsNullOrWhiteSpace(styleKey)
            || !manifest.Fonts.TryGetValue(fontId, out var entry)
            || !entry.Files.TryGetValue(styleKey, out var relative))
        {
            return false;
        }

        var root = Path.GetFullPath(manifest.RootDirectory);
        var candidate = Path.GetFullPath(Path.Combine(root, relative));
        // Manifest bozuk/kötü niyetli olsa bile ("../../etc/passwd") kök dışına çıkılamaz.
        if (!candidate.StartsWith(
                root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase)
            || !File.Exists(candidate))
        {
            return false;
        }

        absolutePath = candidate;
        return true;
    }
}

/// <summary>
/// Manifesti BİR KEZ yükleyip paylaşan sağlayıcı (DI singleton'ı).
/// <para>
/// Yükleme HATASI istisna olarak yayılmaz, <see cref="LoadError"/> ile TAŞINIR: fontlar hiç
/// kurulmamış bir geliştirici makinesinde API'nin tamamının 500 vermesi (ya da açılışta
/// patlaması) kabul edilemez — yalnız font uçları ve font ön kontrolü devre dışı kalır,
/// export yolu eskisi gibi worker'da <c>font-missing</c> ile deterministik biçimde düşer.
/// </para>
/// </summary>
public sealed class FontManifestProvider
{
    public FontManifestProvider(TextRasterOptions? options = null)
    {
        var root = FontRootLocator.Locate(options?.FontRoot);
        Path = System.IO.Path.Combine(root, TextRasterOptions.ManifestFileName);
        try
        {
            Manifest = FontManifest.Load(Path);
        }
        catch (Exception ex) when (ex is FontManifestException or IOException or UnauthorizedAccessException)
        {
            LoadError = ex.Message;
        }
    }

    private FontManifestProvider(FontManifest? manifest, string? loadError, string path)
    {
        Manifest = manifest;
        LoadError = loadError;
        Path = path;
    }

    /// <summary>
    /// Hazır bir manifestle (ya da bilinçli olarak MANİFESTSİZ) sağlayıcı. Testler ve manifesti
    /// kendisi yükleyen host'lar için — dosya sistemine dokunmaz.
    /// </summary>
    public static FontManifestProvider Preloaded(
        FontManifest? manifest, string? loadError = null) =>
        new(manifest, manifest is null ? loadError ?? "(manifest sağlanmadı)" : null,
            manifest?.SourcePath ?? "(bellek)");

    /// <summary>Beklenen manifest yolu (hata mesajlarında gösterilir).</summary>
    public string Path { get; }

    /// <summary>Yüklenmiş manifest; yüklenemediyse <c>null</c>.</summary>
    public FontManifest? Manifest { get; }

    /// <summary>Yükleme başarısızsa insan okunur sebep; başarılıysa <c>null</c>.</summary>
    public string? LoadError { get; }
}

/// <summary>
/// Katalogdaki tek font. İstemci bunu <c>fontId</c> listesi + <c>@font-face</c> kuralları
/// üretmek için kullanır (apps/editor/src/features/text/fontCatalogue.ts).
/// </summary>
public sealed record FontCatalogueEntry(
    string Id,
    string Family,
    string Version,
    string License,
    IReadOnlyList<int> Weights,
    IReadOnlyList<string> Styles,
    bool Italic,
    bool Deprecated);
