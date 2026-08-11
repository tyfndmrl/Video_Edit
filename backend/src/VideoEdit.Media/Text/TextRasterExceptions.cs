namespace VideoEdit.Media.Text;

/// <summary>
/// Overlay raster hattının (metin/şekil) TİPLİ hata tabanı. Hepsi DETERMİNİSTİKTİR: aynı
/// girdi aynı hatayı üretir → worker retry etmez, doğrudan Failed yazar (tasarım 04 §4.3).
/// </summary>
public abstract class OverlayRasterException(string message, Exception? inner = null)
    : Exception(message, inner)
{
    /// <summary>Worker'ın <c>Job.ErrorMessage</c>'a yazdığı kısa makine kodu.</summary>
    public abstract string Code { get; }
}

/// <summary>
/// Font manifesti okunamadı / bozuk. Kurulum hatasıdır (dosya yok, JSON bozuk, sürüm bilinmiyor).
/// </summary>
public sealed class FontManifestException(string message, Exception? inner = null)
    : OverlayRasterException(message, inner)
{
    public override string Code => "font-manifest-invalid";
}

/// <summary>
/// <c>fontId</c> manifest'te yok ya da manifest'in gösterdiği TTF dosyası diskte yok.
/// Mesaj kullanıcıya ne yapacağını söyler (fonts/README.md → fetch script).
/// </summary>
public sealed class FontNotFoundException : OverlayRasterException
{
    public FontNotFoundException(string fontId, string message, string? expectedPath = null)
        : base(message)
    {
        FontId = fontId;
        ExpectedPath = expectedPath;
    }

    public string FontId { get; }

    /// <summary>Manifest'in beklediği mutlak dosya yolu (fontId bulunduysa dolu).</summary>
    public string? ExpectedPath { get; }

    public override string Code => "font-missing";

    /// <summary>Manifest'te hiç olmayan fontId.</summary>
    public static FontNotFoundException UnknownId(string fontId, string manifestPath, IEnumerable<string> known) =>
        new(fontId,
            $"fontId '{fontId}' font manifestinde yok ({manifestPath}). "
            + $"Tanımlı fontId'ler: {string.Join(", ", known.DefaultIfEmpty("(yok)"))}. "
            + "Klibin fontunu değiştirin ya da fonts/README.md'deki adımlarla fontu manifest'e ekleyin.");

    /// <summary>Manifest'te tanımlı ama diskte olmayan dosya.</summary>
    public static FontNotFoundException FileMissing(string fontId, string weightKey, string expectedPath) =>
        new(fontId,
            $"fontId '{fontId}' ({weightKey}) için font dosyası diskte yok: {expectedPath}. "
            + "Font varlıkları depoya GİRMEZ; fonts/README.md'deki indirme adımını çalıştırın "
            + "(fonts/fetch-fonts.ps1 veya fonts/fetch-fonts.sh).",
            expectedPath);
}

/// <summary>Font dosyası bulundu ama Skia açamadı / sha256 pinine uymuyor.</summary>
public sealed class FontLoadException(string fontId, string message)
    : OverlayRasterException(message)
{
    public string FontId { get; } = fontId;

    public override string Code => "font-invalid";
}

/// <summary>
/// İstenen raster, worker'ın taşıyabileceği tuval sınırını aşıyor
/// (<see cref="TextRasterOptions.MaxRasterDimension"/>). Ölçek/font boyutu düşürülmeli.
/// </summary>
public sealed class RasterTooLargeException(string message)
    : OverlayRasterException(message)
{
    public override string Code => "overlay-too-large";
}

/// <summary>Raster hattının desteklemediği klip türü (ör. media/sticker klibi rasterleştirilemez).</summary>
public sealed class UnsupportedOverlayClipException(string message)
    : OverlayRasterException(message)
{
    public override string Code => "overlay-unsupported-clip";
}
