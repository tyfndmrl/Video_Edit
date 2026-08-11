using VideoEdit.Contracts.Timeline;

namespace VideoEdit.Media.Text;

/// <summary>
/// Şekil klibinin ÇİZİM GEOMETRİSİ (proje çıktı pikselinde, raster çarpanı uygulanmamış).
/// SAF veri — Skia'sız birim testlenir.
/// <para>
/// SÖZLEŞME — ŞEKLİN DOĞAL KUTUSU PROJE KARESİDİR (W×H). Gerekçe: <c>ShapeClipShape</c>
/// şemasında genişlik/yükseklik alanı YOKTUR, dolayısıyla "scale = 1 → fit"
/// (rendering-semantics §2.2) yalnız doğal kutu = kompozisyon kabul edilirse tanımlıdır.
/// Kullanıcı şekli küçültmek için <c>transform.scale</c>'i kullanır; <c>scale=1</c> tam kare
/// dolduran bir dikdörtgen/elips demektir.
/// </para>
/// </summary>
public sealed record ShapeGeometry
{
    /// <summary>Kontur genişliği verilmemiş çizgi/ok için taban kalınlık oranı (kısa kenarın %1'i).</summary>
    public const double DefaultLineThicknessRatio = 0.01d;

    public const double MinLineThicknessPx = 2d;

    /// <summary>Ok başı uzunluğu = kalınlık × bu katsayı (kare genişliğinin 1/3'ü ile sınırlı).</summary>
    public const double ArrowHeadLengthFactor = 4d;

    /// <summary>Ok başı yarı genişliği = kalınlık × bu katsayı.</summary>
    public const double ArrowHeadHalfWidthFactor = 2.5d;

    public required ShapeClipShapeType Type { get; init; }

    /// <summary>Şeklin doğal kutusu = proje karesi (0,0,W,H) — bbox da budur.</summary>
    public required double BoxWidthPx { get; init; }

    public required double BoxHeightPx { get; init; }

    /// <summary>Kontur genişliği (0 = kontur yok). Dikdörtgen/elips kutusu bunun YARISI kadar içe alınır.</summary>
    public required double StrokeWidthPx { get; init; }

    /// <summary>Köşe yarıçapı (dikdörtgen); kutunun yarısını AŞAMAZ.</summary>
    public required double CornerRadiusPx { get; init; }

    /// <summary>Çizgi/ok kalınlığı (yalnız line/arrow için anlamlı).</summary>
    public required double LineThicknessPx { get; init; }

    /// <summary>Ok başı uzunluğu (yalnız arrow).</summary>
    public required double ArrowHeadLengthPx { get; init; }

    /// <summary>Ok başı yarı genişliği (yalnız arrow).</summary>
    public required double ArrowHeadHalfWidthPx { get; init; }

    /// <summary>Dikdörtgen/elipsin kontur payı içe alınmış çizim kutusu.</summary>
    public InkBox InsetBox => new(
        StrokeWidthPx / 2d,
        StrokeWidthPx / 2d,
        BoxWidthPx - (StrokeWidthPx / 2d),
        BoxHeightPx - (StrokeWidthPx / 2d));

    public static ShapeGeometry Compute(ShapeClipShape shape, int width, int height)
    {
        ArgumentNullException.ThrowIfNull(shape);
        if (width <= 0 || height <= 0)
        {
            throw new UnsupportedOverlayClipException(
                $"Şekil rasteri için geçersiz proje çözünürlüğü: {width}×{height}.");
        }

        var strokeWidth = Math.Max(0d, shape.Stroke?.WidthPx ?? 0d);

        // Kontur, kutuyu TAŞIRAMAZ: yarısı içe alındığında ters dönmüş kutu üretmemeli.
        strokeWidth = Math.Min(strokeWidth, Math.Min(width, height));

        var thickness = strokeWidth > 0
            ? strokeWidth
            : Math.Max(MinLineThicknessPx, Math.Round(Math.Min(width, height) * DefaultLineThicknessRatio));

        // Ok başı kareye sığmalı: yarı genişlik yüksekliğin yarısını, uzunluk genişliğin 1/3'ünü aşamaz.
        var maxThicknessForHead = height / 2d / ArrowHeadHalfWidthFactor;
        var headThickness = Math.Max(1d, Math.Min(thickness, maxThicknessForHead));
        var headLength = Math.Min(headThickness * ArrowHeadLengthFactor, width / 3d);

        var maxRadius = Math.Min(width, height) / 2d;
        var radius = Math.Clamp(shape.RadiusPx ?? 0d, 0d, maxRadius);

        return new ShapeGeometry
        {
            Type = shape.Type,
            BoxWidthPx = width,
            BoxHeightPx = height,
            StrokeWidthPx = strokeWidth,
            CornerRadiusPx = radius,
            LineThicknessPx = shape.Type is ShapeClipShapeType.Line or ShapeClipShapeType.Arrow
                ? headThickness
                : thickness,
            ArrowHeadLengthPx = headLength,
            ArrowHeadHalfWidthPx = headThickness * ArrowHeadHalfWidthFactor,
        };
    }
}
