using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Export;

namespace VideoEdit.UnitTests;

/// <summary>
/// rendering-semantics §2 parity testleri: compiler'ın ürettiği ffmpeg geometrisi
/// (scale → [çapa pad'i] → rotate → overlay) ile §2.4'ün AÇIK PİKSEL FORMÜLÜ aynı ekran
/// koordinatını vermelidir. §2.5 doğrulama invaryantı: çapa pikseli BİREBİR aynı,
/// köşe noktalarında fark ≤ 0.5 px (yuvarlama payı).
///
/// Buradaki "ffmpeg modeli" filtrelerin tanımlı davranışının aritmetik karşılığıdır:
///  scale=box:force_original_aspect_ratio=decrease → tek ölçek çarpanı;
///  pad=iw*kx:ih*ky:iw*dx:ih*dy      → çapa padded tuvalin MERKEZİNE gelir;
///  rotate=a:c=none:ow=hypot(iw,ih)  → giriş merkezi çıkış merkezinde, merkez etrafında dönme;
///  overlay=x=P.x-f*w                → çapa P'ye oturur.
/// </summary>
public sealed class LayerGeometryTests
{
    private const int CompW = 1920;
    private const int CompH = 1080;

    /// <summary>rendering-semantics §2.4 açık piksel formülü (bağımsız implementasyon).</summary>
    private static (double X, double Y) NormativeScreen(
        double srcW, double srcH, int compW, int compH, Transform t, double srcX, double srcY)
    {
        var s = Math.Min(compW / srcW, compH / srcH) * t.Scale;
        var wDraw = srcW * s;
        var hDraw = srcH * s;
        var ax = t.AnchorX * wDraw;
        var ay = t.AnchorY * hDraw;
        var theta = t.RotationDeg * Math.PI / 180d;
        var cos = Math.Cos(theta);
        var sin = Math.Sin(theta);
        var px = compW / 2d + t.X * compW;
        var py = compH / 2d + t.Y * compH;
        var u = srcX * s - ax;
        var v = srcY * s - ay;
        return (px + cos * u - sin * v, py + sin * u + cos * v);
    }

    /// <summary>Compiler'ın ürettiği ffmpeg zincirinin aritmetik modeli.</summary>
    private static (double X, double Y) FfmpegScreen(
        double srcW, double srcH, int compW, int compH, Transform t, double srcX, double srcY)
    {
        var p = LayerGeometry.Compute(t, compW, compH);

        // scale=<box>:force_original_aspect_ratio=decrease → aspect koruyan tek çarpan.
        var f = Math.Min(p.BoxWidth / srcW, p.BoxHeight / srcH);
        var w = srcW * f;
        var h = srcH * f;
        var x = srcX * f;
        var y = srcY * f;

        if (!p.Rotates)
        {
            return (p.AnchorTargetX - p.OverlayAnchorFactorX * w + x,
                    p.AnchorTargetY - p.OverlayAnchorFactorY * h + y);
        }

        // pad: çapayı padded tuvalin merkezine getirir.
        var padW = w * p.PadWidthFactor;
        var padH = h * p.PadHeightFactor;
        var padX = x + w * p.PadXFactor;
        var padY = y + h * p.PadYFactor;

        // rotate: ow=oh=hypot(padW,padH); giriş merkezi → çıkış merkezi, merkez etrafında dönme.
        var dg = Math.Sqrt(padW * padW + padH * padH);
        var cos = Math.Cos(p.RotationRad);
        var sin = Math.Sin(p.RotationRad);
        var rx = dg / 2d + cos * (padX - padW / 2d) - sin * (padY - padH / 2d);
        var ry = dg / 2d + sin * (padX - padW / 2d) + cos * (padY - padH / 2d);

        return (p.AnchorTargetX - p.OverlayAnchorFactorX * dg + rx,
                p.AnchorTargetY - p.OverlayAnchorFactorY * dg + ry);
    }

    public static TheoryData<double, double, double, double, double, double, double, double> Cases() => new()
    {
        // srcW, srcH, x, y, scale, rotationDeg, anchorX, anchorY
        { 1920, 1080, 0, 0, 1, 0, 0.5, 0.5 },                 // kimlik
        { 1280, 720, 0.25, -0.25, 0.35, 0, 0.5, 0.5 },        // PiP
        { 1920, 1080, 0, 0, 0.5, 30, 0.5, 0.5 },              // merkez çapalı dönme
        { 1920, 1080, -0.1, 0.05, 1.3, 37, 0.2, 0.8 },        // §2.4 test vektörüyle aynı transform
        { 640, 480, 0.4, 0.4, 0.25, 90, 0, 0 },               // sol-üst çapa, dik açı
        { 640, 480, -0.3, -0.2, 2, 215, 1, 0.25 },            // sağ çapa, geniş açı, büyütme
        { 1080, 1920, 0, 0, 1, -45, 0.5, 0 },                 // dikey kaynak, negatif açı
        { 800, 600, 0.1, 0.1, 0.8, 360, 0.3, 0.7 },           // 360° = dönme YOK
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void FfmpegGeometry_MatchesNormativePixelFormula(
        double srcW, double srcH, double x, double y,
        double scale, double rotationDeg, double anchorX, double anchorY)
    {
        var t = ExportTestDocs.Transform(x, y, scale, rotationDeg, anchorX, anchorY);

        // Çapa pikseli + dört köşe + merkez: hepsi §2.4 ile birebir örtüşmeli.
        foreach (var (sx, sy) in new[]
                 {
                     (anchorX * srcW, anchorY * srcH),
                     (0d, 0d), (srcW, 0d), (0d, srcH), (srcW, srcH),
                     (srcW / 2, srcH / 2),
                 })
        {
            var expected = NormativeScreen(srcW, srcH, CompW, CompH, t, sx, sy);
            var actual = FfmpegScreen(srcW, srcH, CompW, CompH, t, sx, sy);
            Assert.True(Math.Abs(expected.X - actual.X) <= 0.5,
                $"x mismatch at src({sx},{sy}): normative {expected.X}, ffmpeg {actual.X}");
            Assert.True(Math.Abs(expected.Y - actual.Y) <= 0.5,
                $"y mismatch at src({sx},{sy}): normative {expected.Y}, ffmpeg {actual.Y}");
        }
    }

    [Fact]
    public void AnchorPixel_LandsExactlyOnTargetPoint()
    {
        // §2.3 adım 4: "elemanın çapa noktası P'ye oturur" — yuvarlama payı olmadan.
        var t = ExportTestDocs.Transform(x: 0.25, y: -0.1, scale: 0.4, rotationDeg: 73, anchorX: 0.2, anchorY: 0.9);
        var actual = FfmpegScreen(1280, 720, CompW, CompH, t, 0.2 * 1280, 0.9 * 720);

        Assert.Equal(CompW / 2d + 0.25 * CompW, actual.X, 3);
        Assert.Equal(CompH / 2d - 0.1 * CompH, actual.Y, 3);
    }

    [Fact]
    public void CenterAnchor_NeedsNoAnchorPad()
    {
        // Çapa merkezdeyken pad no-op'tur (kx=ky=1, dx=dy=0) — filtre üretilmez.
        var p = LayerGeometry.Compute(
            ExportTestDocs.Transform(scale: 0.5, rotationDeg: 45), CompW, CompH);
        Assert.True(p.Rotates);
        Assert.False(p.NeedsAnchorPad);
        Assert.Equal(1, p.PadWidthFactor);
        Assert.Equal(0, p.PadXFactor);
        Assert.Equal(0.5, p.OverlayAnchorFactorX);
    }

    [Fact]
    public void RotationMultipleOf360_ProducesNoRotateFilter()
    {
        // 360'ın katı = kimlik dönme: rotate atlanır (alpha da gerekmez).
        foreach (var deg in new[] { 0d, 360d, -720d })
        {
            var p = LayerGeometry.Compute(ExportTestDocs.Transform(rotationDeg: deg), CompW, CompH);
            Assert.False(p.Rotates);
        }

        Assert.True(LayerGeometry.Compute(
            ExportTestDocs.Transform(rotationDeg: 361), CompW, CompH).Rotates);
    }

    [Fact]
    public void NoRotation_OverlayFactorIsTheAnchorItself()
    {
        // §2.5: θ = 0 iken overlay_x = P.x - anchorX*w_px (telafi yok).
        var p = LayerGeometry.Compute(
            ExportTestDocs.Transform(anchorX: 0.25, anchorY: 0.75), CompW, CompH);
        Assert.Equal(0.25, p.OverlayAnchorFactorX);
        Assert.Equal(0.75, p.OverlayAnchorFactorY);
    }

    // ───────────── Ara tuval defteri (bellek tavanının doğrulandığı büyüklük) ─────────────

    [Theory]
    // scale, rotationDeg, anchorX, anchorY, beklenen ara tuval (w, h)
    [InlineData(1, 0, 0.5, 0.5, 1920, 1080)]        // dönme yok → kutunun kendisi
    [InlineData(1, 0, 0, 0, 1920, 1080)]            // pad YALNIZ dönmeyle üretilir
    [InlineData(0.5, 30, 0.5, 0.5, 1102, 1102)]     // merkez çapa: Dg = ceil(hypot(960,540))
    [InlineData(0.5, 30, 0, 1, 2203, 2203)]         // köşe çapa: pad 2x → Dg = ceil(hypot(1920,1080))
    [InlineData(2, 30, 0, 0, 8812, 8812)]           // denetim #2 reprosu (ffmpeg: overlay w:8812 h:8812)
    [InlineData(1, 90, 0.25, 0.5, 3076, 3076)]      // asimetrik çapa: yalnız x ekseni 1.5x
    public void IntermediateCanvas_CountsPadAndRotateGrowth(
        double scale, double rotationDeg, double anchorX, double anchorY,
        long expectedWidth, long expectedHeight)
    {
        var p = LayerGeometry.Compute(
            ExportTestDocs.Transform(scale: scale, rotationDeg: rotationDeg,
                anchorX: anchorX, anchorY: anchorY),
            CompW, CompH);

        Assert.Equal(expectedWidth, p.IntermediateWidth);
        Assert.Equal(expectedHeight, p.IntermediateHeight);

        // Ara tuval, zincirin ürettiği HER ara adımı kapsamalıdır (kutu ve pad dahil).
        var padWidth = p.NeedsAnchorPad ? p.BoxWidth * p.PadWidthFactor : p.BoxWidth;
        var padHeight = p.NeedsAnchorPad ? p.BoxHeight * p.PadHeightFactor : p.BoxHeight;
        Assert.True(p.IntermediateWidth >= padWidth);
        Assert.True(p.IntermediateHeight >= padHeight);
    }

    [Fact]
    public void IntermediateCanvas_SaturatesInsteadOfOverflowing()
    {
        // double→long taşması NEGATİFE dönseydi tavan karşılaştırması sessizce geçerdi;
        // .NET Core 3.0+ doyurma sözleşmesi bunu engeller — test o sözleşmeyi sabitler.
        var p = LayerGeometry.Compute(ExportTestDocs.Transform(scale: 1e30), CompW, CompH);
        Assert.True(p.BoxWidth > LayerGeometry.MaxLayerDimension);
        Assert.True(p.IntermediateWidth > LayerGeometry.MaxLayerDimension);
        Assert.True(p.IntermediateHeight > LayerGeometry.MaxLayerDimension);
    }

    [Fact]
    public void ScaleBox_IsHalfUpRoundedProjectCanvas()
    {
        // §2.5 adım 1: w_px = roundHalfUp(w_d); kutu = proje tuvali × scale.
        var p = LayerGeometry.Compute(ExportTestDocs.Transform(scale: 0.35), 1920, 1080);
        Assert.Equal(672, p.BoxWidth);   // 1920*0.35 = 672
        Assert.Equal(378, p.BoxHeight);  // 1080*0.35 = 378

        // half-up (banker's rounding YASAK): 1080*0.3805 = 410.94 → 411; 1920*0.3805 = 730.56 → 731
        var half = LayerGeometry.Compute(ExportTestDocs.Transform(scale: 0.3805), 1920, 1080);
        Assert.Equal(731, half.BoxWidth);
        Assert.Equal(411, half.BoxHeight);
    }
}
