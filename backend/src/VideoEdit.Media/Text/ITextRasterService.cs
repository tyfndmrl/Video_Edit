using VideoEdit.Contracts.Timeline;

namespace VideoEdit.Media.Text;

/// <summary>
/// Tek overlay rasterinin sonucu. <c>Width</c>/<c>Height</c> PNG'nin GERÇEK piksel boyutu,
/// <c>Path</c> yazılan dosyadır (görev sözleşmesi: <c>RasterResult(width, height, path)</c>).
/// <para>
/// <c>BboxWidthPx</c>/<c>BboxHeightPx</c> aynı rasterin PROJE ÇIKTI PİKSELİNDEKİ boyutudur
/// (<c>Width / RasterScale</c>). Kompozisyon bu değeri kullanır — bkz.
/// <see cref="OverlayRasterPlacement"/>.
/// </para>
/// </summary>
public sealed record RasterResult(
    int Width,
    int Height,
    string Path,
    int RasterScale,
    double BboxWidthPx,
    double BboxHeightPx,
    double OriginXPx,
    double OriginYPx,
    long ByteSize,
    string Sha256,
    IReadOnlyList<LaidOutLine> Lines,
    bool HasMissingGlyphs,
    bool SyntheticItalic,
    bool SubstitutedWeight)
{
    /// <summary>Şekil rasterinde satır bilgisi yoktur.</summary>
    public static IReadOnlyList<LaidOutLine> NoLines { get; } = [];
}

/// <summary>
/// Metin/şekil kliplerinin SUNUCU raster hattı (rendering-semantics §7 — bağlayıcı):
/// layout ve bbox'ın tek doğruluk kaynağı SkiaSharp'tır ve EXPORT DAİMA bu çıktıyı kullanır.
/// İstemcinin canlı Canvas2D rasteri yalnız düzenleme sırasındaki geçici UX'tir; export'a
/// asla girmez, çelişkide SkiaSharp kazanır.
/// <para>
/// Çıkartma (sticker) klipleri BU HATTAN GEÇMEZ: mevcut PNG/WebP asset'i doğrudan ffmpeg
/// girişidir, rasterleştirmeye gerek yoktur — <see cref="RenderAsync"/> sticker klibi için
/// <see cref="UnsupportedOverlayClipException"/> atar.
/// </para>
/// </summary>
public interface ITextRasterService
{
    /// <summary>
    /// Metin ya da şekil klibini şeffaf PNG'ye rasterleştirir (straight alpha — §6.4) ve
    /// <paramref name="outputPath"/>'e yazar. Aynı girdi → BAYT BAYT aynı dosya.
    /// </summary>
    Task<RasterResult> RenderAsync(
        Clip clip, ProjectSettings settings, string outputPath, CancellationToken ct = default);

    /// <summary>
    /// Yalnız ölçüm: satır kırılımları + bbox (frontend'in yerleşim/gizmo/çarpışma için
    /// kullandığı türev veri — §7). Dosya YAZMAZ.
    /// </summary>
    TextLayout Measure(TextClipText text, ProjectSettings settings);
}

/// <summary>
/// Overlay rasterinin §2 transform hattına GİRİŞ KURALI (rendering-semantics §7'nin
/// "@2x raster" maddesinin normatif okunuşu — iki tarafta AYNI).
/// <para>
/// Medya katmanlarında <c>scale=1</c> "fit" demektir (§2.2). Overlay rasterinde ise
/// <c>scale=1</c> "TASARLANDIĞI PİKSEL BOYUTU" demektir: PNG zaten proje çözünürlüğüne göre
/// ölçülmüş bbox'ın <c>rasterScale</c> katıdır, §7 bunu kompozisyona <c>1/rasterScale</c>
/// ek çarpanıyla çizdirir (@2x için 0.5). Yani:
/// <code>
/// fitScale_overlay = 1 / rasterScale          // §2.2'nin min(W/w_s, H/h_s)'i DEĞİL
/// s                = fitScale_overlay * transform.scale
/// w_d              = pngWidth  * s = bboxWidthPx  * transform.scale
/// h_d              = pngHeight * s = bboxHeightPx * transform.scale
/// </code>
/// Bu kural olmasaydı 48 px'lik bir metin 1080p karede <c>scale=1</c> iken kareye
/// "sığdırılıp" ~10 kat büyütülürdü — <c>fontSizePx</c> anlamını yitirirdi.
/// §2.3'ün geri kalanı (çapa etrafında rotate → çapayı P'ye taşı) AYNEN geçerlidir.
/// </para>
/// </summary>
public static class OverlayRasterPlacement
{
    /// <summary>Overlay rasteri için fit çarpanı: <c>1 / rasterScale</c>.</summary>
    public static double FitScale(int rasterScale) => 1d / rasterScale;

    /// <summary>
    /// Kompozisyondaki çizim kutusu (px): <c>bboxPx * transform.scale</c>, §1.2 half-up ile
    /// tamsayıya. ffmpeg tarafında <c>scale=w=…:h=…</c> hedefidir.
    /// </summary>
    public static (long Width, long Height) DrawBox(RasterResult raster, double transformScale)
    {
        ArgumentNullException.ThrowIfNull(raster);
        return (RoundHalfUp(raster.BboxWidthPx * transformScale),
                RoundHalfUp(raster.BboxHeightPx * transformScale));
    }

    private static long RoundHalfUp(double x) => (long)Math.Floor(x + 0.5);
}
