using SkiaSharp;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// Şekil rasteri (rendering-semantics §6.4 straight alpha + §7 @2x kuralı).
/// Bu testler FONT GEREKTİRMEZ → golden PNG'leri TAŞINABİLİRDİR (her makinede aynı bayt).
/// Sabitlenen sözleşmeler:
///  - şeklin doğal kutusu PROJE KARESİDİR (şemada genişlik/yükseklik alanı yok);
///  - PNG = bbox × rasterScale, rasterScale = max(2, ceil(transform.scale));
///  - PNG straight (unassociated) alpha taşır — yarı saydam dolgu KOYULMAZ;
///  - aynı girdi → BAYT BAYT aynı dosya.
/// </summary>
public sealed class ShapeRasterTests : IDisposable
{
    private readonly string dir = OverlayTestDocs.TempDir();
    private readonly SkiaOverlayRasterService service = new(
        new TextRasterOptions(), new FontManifest());

    public void Dispose()
    {
        service.Dispose();
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch (IOException)
        {
            // best-effort
        }
    }

    private async Task<RasterResult> RenderAsync(ShapeClip clip, string name, int width = 320, int height = 180) =>
        await service.RenderAsync(clip, OverlayTestDocs.Settings(width, height), Path.Combine(dir, name));

    // ---------- Geometri (saf) ----------

    [Fact]
    public void Geometry_NaturalBoxIsTheProjectFrame()
    {
        var geometry = ShapeGeometry.Compute(
            new ShapeClipShape { Type = ShapeClipShapeType.Rect, Fill = "#ffffff" }, 1920, 1080);

        Assert.Equal(1920, geometry.BoxWidthPx);
        Assert.Equal(1080, geometry.BoxHeightPx);
    }

    [Fact]
    public void Geometry_StrokeIsInsetSoItStaysInsideTheBox()
    {
        var geometry = ShapeGeometry.Compute(
            new ShapeClipShape
            {
                Type = ShapeClipShapeType.Rect,
                Fill = "#ffffff",
                Stroke = new Stroke2 { Color = "#000000", WidthPx = 20 },
            }, 320, 180);

        Assert.Equal(10, geometry.InsetBox.Left);
        Assert.Equal(310, geometry.InsetBox.Right);
        Assert.Equal(170, geometry.InsetBox.Bottom);
    }

    [Fact]
    public void Geometry_CornerRadiusIsClampedToHalfTheShortSide()
    {
        var geometry = ShapeGeometry.Compute(
            new ShapeClipShape { Type = ShapeClipShapeType.Rect, Fill = "#fff", RadiusPx = 9999 }, 320, 180);

        Assert.Equal(90, geometry.CornerRadiusPx);
    }

    [Fact]
    public void Geometry_ArrowHeadFitsInsideTheFrame()
    {
        // Kalın kontur + kısa kare: ok başı kareyi taşırsa PNG kırpılırdı.
        var geometry = ShapeGeometry.Compute(
            new ShapeClipShape
            {
                Type = ShapeClipShapeType.Arrow,
                Fill = "#fff",
                Stroke = new Stroke2 { Color = "#fff", WidthPx = 500 },
            }, 320, 180);

        Assert.True(geometry.ArrowHeadHalfWidthPx <= geometry.BoxHeightPx / 2,
            $"ok başı yarı genişliği {geometry.ArrowHeadHalfWidthPx} > {geometry.BoxHeightPx / 2}");
        Assert.True(geometry.ArrowHeadLengthPx <= geometry.BoxWidthPx / 3);
    }

    [Fact]
    public void Geometry_LineWithoutStrokeGetsADeterministicDefaultThickness()
    {
        var geometry = ShapeGeometry.Compute(
            new ShapeClipShape { Type = ShapeClipShapeType.Line, Fill = "#fff" }, 1920, 1080);

        Assert.Equal(11, geometry.LineThicknessPx); // round(min(1920,1080) * 0.01)
    }

    // ---------- @2x kuralı ----------

    [Fact]
    public async Task Raster_IsTwiceTheBboxByDefault()
    {
        var result = await RenderAsync(OverlayTestDocs.Shape(), "rect.png");

        Assert.Equal(2, result.RasterScale);
        Assert.Equal(640, result.Width);
        Assert.Equal(360, result.Height);
        Assert.Equal(320, result.BboxWidthPx);
        Assert.Equal(180, result.BboxHeightPx);
    }

    [Fact]
    public async Task Raster_ScalesUpForClipsDrawnLargerThanTwice()
    {
        // §7: scale > 2 beklenen kliplerde raster çarpanı ceil(scale)'e yükselir.
        var result = await RenderAsync(OverlayTestDocs.Shape(scale: 2.3), "rect-3x.png");

        Assert.Equal(3, result.RasterScale);
        Assert.Equal(960, result.Width);
    }

    [Fact]
    public void RasterScale_DropsBackWhenTheCeilingWouldBeExceeded()
    {
        var options = new TextRasterOptions { MaxRasterDimension = 1000 };
        using var limited = new SkiaOverlayRasterService(options, new FontManifest());

        Assert.Equal(2, limited.ChooseRasterScale(1, 400, 300));  // 800 ≤ 1000
        Assert.Equal(1, limited.ChooseRasterScale(1, 800, 300));  // 1600 > 1000 → 1'e düşer
        Assert.Throws<RasterTooLargeException>(() => limited.ChooseRasterScale(1, 1200, 300));
    }

    [Fact]
    public async Task Raster_TooLargeForTheWorker_FailsDeterministically()
    {
        using var limited = new SkiaOverlayRasterService(
            new TextRasterOptions { MaxRasterDimension = 512 }, new FontManifest());

        var ex = await Assert.ThrowsAsync<RasterTooLargeException>(() =>
            limited.RenderAsync(OverlayTestDocs.Shape(), OverlayTestDocs.Settings(1920, 1080),
                Path.Combine(dir, "too-large.png")));

        Assert.Equal("overlay-too-large", ex.Code);
    }

    // ---------- Belirlenimcilik ----------

    [Fact]
    public async Task SameInput_ProducesByteIdenticalPng()
    {
        var clip = OverlayTestDocs.Shape(
            ShapeClipShapeType.Rect, fill: "#3366ffcc", radiusPx: 24,
            stroke: new Stroke2 { Color = "#ffcc00", WidthPx = 8 },
            id: Guid.Parse("11111111-1111-1111-1111-111111111111"));

        var first = await RenderAsync(clip, "det-1.png");
        var second = await RenderAsync(clip, "det-2.png");

        Assert.Equal(first.Sha256, second.Sha256);
        Assert.Equal(File.ReadAllBytes(first.Path), File.ReadAllBytes(second.Path));
    }

    [Fact]
    public async Task DifferentFill_ProducesDifferentHash()
    {
        // Belirlenimcilik testinin ANLAMLI olduğunun kanıtı (her şeye aynı hash veren
        // bir gerçekleme ilk testi de geçerdi).
        var a = await RenderAsync(OverlayTestDocs.Shape(fill: "#ff0000"), "fill-a.png");
        var b = await RenderAsync(OverlayTestDocs.Shape(fill: "#00ff00"), "fill-b.png");

        Assert.NotEqual(a.Sha256, b.Sha256);
    }

    // ---------- Straight alpha (§6.4) ----------

    [Fact]
    public async Task SemiTransparentFill_KeepsStraightAlphaChannels()
    {
        // #3366ff, alpha 0x80 (%50). PNG straight alpha taşımalıdır (§6.4): kanallar
        // ~0x33/0x66/0xff olmalı. Premultiplied yazılsaydı YARIYA düşerlerdi (0x19/0x33/0x80)
        // ve kompozisyonda koyu kenar halkası oluşurdu.
        //
        // ±2 tolerans: Skia kompozisyonu (zorunlu olarak) premultiplied yüzeyde yapar, PNG'ye
        // yazarken geri bölünür; 8 bitlik gidiş-dönüş kanal başına ≤1 birim kuantalama bırakır
        // (51 → 26 → 52). Tarayıcı hattı da aynı kuantalamayı yapar, bu yüzden parity bozulmaz.
        var result = await RenderAsync(
            OverlayTestDocs.Shape(fill: "#3366ff80"), "alpha.png");

        using var bitmap = RasterAssert.Decode(result.Path);
        var center = bitmap.GetPixel(bitmap.Width / 2, bitmap.Height / 2);

        Assert.Equal(0x80, center.Alpha);
        Assert.InRange(center.Red, 0x33 - 2, 0x33 + 2);
        Assert.InRange(center.Green, 0x66 - 2, 0x66 + 2);
        Assert.InRange(center.Blue, 0xff - 2, 0xff);

        // Ayrım kanıtı: premultiplied yazım 0x19 (25) verirdi — tolerans bunu KAPSAMAZ.
        Assert.True(center.Red > 0x19 + 2,
            $"kırmızı kanal premultiplied değere yakın ({center.Red}) — straight alpha ihlali");
    }

    [Fact]
    public async Task TransparentAreasStayFullyTransparent()
    {
        // Elips: köşeler şeklin DIŞINDA kalır → tamamen saydam olmalı (siyah değil).
        var result = await RenderAsync(
            OverlayTestDocs.Shape(ShapeClipShapeType.Ellipse, fill: "#ffffff"), "ellipse.png");

        using var bitmap = RasterAssert.Decode(result.Path);

        Assert.Equal(0, bitmap.GetPixel(0, 0).Alpha);
        Assert.Equal(0, bitmap.GetPixel(bitmap.Width - 1, bitmap.Height - 1).Alpha);
        Assert.Equal(255, bitmap.GetPixel(bitmap.Width / 2, bitmap.Height / 2).Alpha);
    }

    // ---------- Renk ayrıştırma (#RRGGBBAA tuzağı) ----------

    [Fact]
    public async Task InvalidColor_FailsWithATypedError()
    {
        var ex = await Assert.ThrowsAsync<UnsupportedOverlayClipException>(() =>
            RenderAsync(OverlayTestDocs.Shape(fill: "rgb(1,2,3)"), "bad-color.png"));

        Assert.Equal("overlay-unsupported-clip", ex.Code);
    }

    // ---------- Golden PNG'ler (taşınabilir: font içermez) ----------

    [Theory]
    [InlineData(ShapeClipShapeType.Rect, "shape-rect.png")]
    [InlineData(ShapeClipShapeType.Ellipse, "shape-ellipse.png")]
    [InlineData(ShapeClipShapeType.Line, "shape-line.png")]
    [InlineData(ShapeClipShapeType.Arrow, "shape-arrow.png")]
    public async Task Shapes_MatchTheirGoldens(ShapeClipShapeType type, string golden)
    {
        var result = await RenderAsync(
            OverlayTestDocs.Shape(type, fill: "#3366ff", radiusPx: 24,
                stroke: new Stroke2 { Color = "#ffcc00", WidthPx = 6 }),
            golden);

        RasterAssert.MatchesGolden(result.Path, golden);
    }

    // ---------- Yerleşim sözleşmesi (§7 "0.5 ek çarpan") ----------

    [Fact]
    public async Task Placement_DrawBoxIsBboxTimesTransformScaleNotAFit()
    {
        var result = await RenderAsync(OverlayTestDocs.Shape(), "placement.png");

        // fit = 1/rasterScale: @2x PNG kompozisyona 0.5 çarpanıyla girer.
        Assert.Equal(0.5, OverlayRasterPlacement.FitScale(result.RasterScale));

        var (width, height) = OverlayRasterPlacement.DrawBox(result, 1.0);
        Assert.Equal(320, width);
        Assert.Equal(180, height);

        var (halfWidth, halfHeight) = OverlayRasterPlacement.DrawBox(result, 0.5);
        Assert.Equal(160, halfWidth);
        Assert.Equal(90, halfHeight);
    }

    // ---------- Klip türü kapısı ----------

    [Fact]
    public async Task StickerClip_IsRejectedBecauseItNeedsNoRaster()
    {
        var ex = await Assert.ThrowsAsync<UnsupportedOverlayClipException>(() =>
            service.RenderAsync(OverlayTestDocs.Sticker(), OverlayTestDocs.Settings(),
                Path.Combine(dir, "sticker.png")));

        Assert.Contains("Çıkartma", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PartialFileIsNeverLeftBehind()
    {
        var result = await RenderAsync(OverlayTestDocs.Shape(), "atomic.png");

        Assert.True(File.Exists(result.Path));
        Assert.False(File.Exists(result.Path + ".part"), "atomik yazımın .part artığı kalmamalı");
        Assert.Equal(new FileInfo(result.Path).Length, result.ByteSize);

        // Raporlanan sha256 dosyanın gerçek özeti olmalı (cache anahtarı olarak kullanılabilsin).
        Assert.Equal(
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(result.Path))),
            result.Sha256);
    }
}
