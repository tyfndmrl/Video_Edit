namespace VideoEdit.Media.Text;

/// <summary>
/// Overlay raster hattı ayarları ("Text" config section'ı — env: <c>Text__FontRoot</c>).
/// </summary>
public sealed class TextRasterOptions
{
    public const string SectionName = "Text";

    /// <summary>Ortam değişkeniyle geçersiz kılma (config'ten önce bakılır — Docker/CI kolaylığı).</summary>
    public const string FontRootEnvVar = "VIDEOEDIT_FONT_ROOT";

    public const string ManifestFileName = "manifest.json";

    /// <summary>
    /// <c>manifest.json</c> + font dosyalarının kökü. Boşsa <see cref="FontRootLocator"/>
    /// sırayla env → uygulama dizini → yukarı doğru depo kökü arar.
    /// </summary>
    public string? FontRoot { get; set; }

    /// <summary>
    /// @2x raster kuralının taban çarpanı (rendering-semantics §7: <c>rasterPx = bboxPx * 2</c>).
    /// Değiştirilmesi sözleşme değişikliğidir — iki tarafta AYNI anda değişmelidir.
    /// </summary>
    public int BaseRasterScale { get; set; } = 2;

    /// <summary>
    /// Tek raster kenarının üst sınırı (px). <see cref="Export.LayerGeometry.MaxLayerDimension"/>
    /// ile AYNI: 8192² rgba = 256 MB/kare, worker'ın taşıyabileceği tavan. Aşılırsa raster
    /// çarpanı düşürülür; taban çarpanda bile aşılıyorsa <see cref="RasterTooLargeException"/>.
    /// </summary>
    public int MaxRasterDimension { get; set; } = 8192;

    /// <summary>PNG encode kalitesi — PNG kayıpsızdır, değer yalnız Skia API'sinin talebidir.</summary>
    public int PngQuality { get; set; } = 100;
}

/// <summary>
/// Font kökü bulucu. Yalnız DOSYA SİSTEMİ araması yapar — bulunan kök doğrulanmaz
/// (<see cref="FontManifest.Load"/> o işi yapar ve açıklayıcı hata verir).
/// </summary>
public static class FontRootLocator
{
    /// <summary>Depo kökünde beklenen dizin adı.</summary>
    public const string ConventionalDirectoryName = "fonts";

    /// <summary>
    /// Sıra: (1) açık ayar, (2) <c>VIDEOEDIT_FONT_ROOT</c>, (3) uygulama dizininden başlayarak
    /// yukarı doğru ilk <c>fonts/manifest.json</c>, (4) çalışma dizininden yukarı. Hiçbiri
    /// yoksa uygulama dizini altındaki <c>fonts</c> döner (hata mesajı bu yolu gösterir).
    /// </summary>
    public static string Locate(string? configured = null)
    {
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return Path.GetFullPath(configured);
        }

        var fromEnv = Environment.GetEnvironmentVariable(TextRasterOptions.FontRootEnvVar);
        if (!string.IsNullOrWhiteSpace(fromEnv))
        {
            return Path.GetFullPath(fromEnv);
        }

        foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            if (SearchUpwards(start) is { } found)
            {
                return found;
            }
        }

        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ConventionalDirectoryName));
    }

    private static string? SearchUpwards(string startDirectory)
    {
        var dir = new DirectoryInfo(Path.GetFullPath(startDirectory));
        // Derinlik sınırlı: sonsuz sembolik-link zincirlerinde takılmasın.
        for (var depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, ConventionalDirectoryName);
            if (File.Exists(Path.Combine(candidate, TextRasterOptions.ManifestFileName)))
            {
                return candidate;
            }
        }

        return null;
    }
}
