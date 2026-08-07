namespace VideoEdit.Media.Export;

/// <summary>
/// Çıktı profilleri (tasarım 04 §5). M3'te yalnız 1080p Standart; enum genişletilebilir
/// (4K / H.265 / yüksek kalite M5'te eklenir). Codec parametreleri profile aittir;
/// tuval çözünürlüğü ve fps DAİMA proje ayarlarından gelir.
/// </summary>
public enum ExportProfile
{
    /// <summary>1080p Standart (default): libx264 veryfast CRF18 + AAC 192k (tasarım 04 §5 ilk satır).</summary>
    Hd1080p = 0,
}

public static class ExportProfiles
{
    /// <summary>API'nin kabul ettiği profil adları → enum. Bilinmeyen ad → false (400).</summary>
    public static bool TryParse(string? value, out ExportProfile profile)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case "1080p":
                profile = ExportProfile.Hd1080p;
                return true;
            default:
                profile = default;
                return false;
        }
    }

    public static string Name(ExportProfile profile) => profile switch
    {
        ExportProfile.Hd1080p => "1080p",
        _ => throw new ArgumentOutOfRangeException(nameof(profile), profile, null),
    };

    /// <summary>
    /// Disk rezervasyonu için kaba çıktı bit hızı tahmini (tasarım 04 §4.2). CRF çıktısı
    /// içerik bağımlıdır — 1080p CRF18 veryfast için ~10 Mbps güvenli üst banttır.
    /// </summary>
    public static long EstimatedBitsPerSecond(ExportProfile profile) => profile switch
    {
        ExportProfile.Hd1080p => 10_000_000,
        _ => throw new ArgumentOutOfRangeException(nameof(profile), profile, null),
    };

    /// <summary>
    /// Çıktı argümanları (map + codec + renk tag'leri + ses + faststart). Çıktı DOSYA YOLU
    /// içermez — çağıran sona ekler. Renk tag'leri rendering-semantics §6.1: çıktı daima
    /// açıkça BT.709/tv olarak işaretlenir.
    /// </summary>
    public static IReadOnlyList<string> BuildOutputArgs(ExportProfile profile, int fpsNum, int fpsDen)
    {
        return profile switch
        {
            ExportProfile.Hd1080p =>
            [
                "-map", "[vout]",
                "-map", "[aout]",
                "-r", TimeFormat.Fps(fpsNum, fpsDen),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-profile:v", "high", "-g", "150",
                "-pix_fmt", "yuv420p",
                "-color_primaries", "bt709", "-color_trc", "bt709",
                "-colorspace", "bt709", "-color_range", "tv",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                "-movflags", "+faststart",
            ],
            _ => throw new ArgumentOutOfRangeException(nameof(profile), profile, null),
        };
    }
}
