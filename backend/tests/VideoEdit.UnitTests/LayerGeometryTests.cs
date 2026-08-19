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
    // scale, rotationDeg, anchorX, anchorY, beklenen ara tuval (w, h).
    // Dg = köşegeni kapsayan en küçük ÇİFT tamsayı (§2.5): rotate tuvali TEK olamaz, yoksa
    // içerik tuvalin ortasına oturmaz ve overlay telafisi 0.5*w yarım tamsayı olur.
    [InlineData(1, 0, 0.5, 0.5, 1920, 1080)]        // dönme yok → kutunun kendisi
    [InlineData(1, 0, 0, 0, 1920, 1080)]            // pad YALNIZ dönmeyle üretilir
    [InlineData(0.5, 30, 0.5, 0.5, 1102, 1102)]     // merkez çapa: hypot(960,540)=1101.45 → 1102
    [InlineData(0.5, 30, 0, 1, 2204, 2204)]         // köşe çapa: pad 2x → hypot=2202.91; ceil 2203 TEK → 2204
    [InlineData(2, 30, 0, 0, 8812, 8812)]           // denetim #2 reprosu: hypot=8811.71 → 8812 (zaten çift)
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

        // Dönen katmanda tuval DAİMA ÇİFT (filtergraph'a yazılan 2*ceil(hypot/2)'nin defter
        // karşılığı). Dönmeyen katmanda böyle bir şart yok — orada tuval scale kutusudur.
        if (p.Rotates)
        {
            Assert.Equal(0, p.IntermediateWidth % 2);
            Assert.Equal(0, p.IntermediateHeight % 2);
        }
    }

    [Theory]
    // Defterin (LayerGeometry) ve filtergraph ifadesinin (2*ceil(hypot(iw,ih)/2)) AYNI sayıyı
    // vermesi şarttır: bellek tavanı defterden, gerçek tuval ifadeden doğar. "x'ten büyük/eşit
    // en küçük çift sayı" iki biçimde de aynıdır — bu tarama onu ölçekte örnekleyerek sabitler.
    [InlineData(0.1)]
    [InlineData(0.137)]
    [InlineData(0.25)]
    [InlineData(0.503)]
    [InlineData(0.75)]
    [InlineData(1)]
    [InlineData(1.005)]
    [InlineData(2)]
    [InlineData(3.333)]
    public void RotateCanvasLedger_MatchesTheFilterExpressionArithmetic(double scale)
    {
        var p = LayerGeometry.Compute(ExportTestDocs.Transform(scale: scale, rotationDeg: 30),
            CompW, CompH);

        // ffmpeg ifadesinin birebir aritmetiği (rotate ow'u round-half-up ile tamsayılar; ifade
        // zaten tam çift tamsayı ürettiği için o yuvarlama no-op'a düşer).
        var hypot = Math.Sqrt(((double)p.BoxWidth * p.BoxWidth) + ((double)p.BoxHeight * p.BoxHeight));
        var expression = 2 * (long)Math.Ceiling(hypot / 2);

        Assert.Equal(expression, p.IntermediateWidth);
        Assert.Equal(expression, p.IntermediateHeight);
        Assert.True(p.IntermediateWidth >= hypot, "tuval köşegeni kapsamalı");
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

    [Fact]
    public void NormalizeBox_IsTheBoxRoundedDownToEven_AndNeverBelowTwo()
    {
        // Kutuya normalize eden pad'in HEDEFİ. Çift kutuda kutunun KENDİSİDİR (mevcut 29
        // snapshot'ın bayt bayt korunmasının nedeni; 30. dosya bu turda yeni üretildi), tek
        // kutuda bir eksiğidir (pad ofseti tam bölünsün).
        var even = LayerGeometry.Compute(ExportTestDocs.Transform(scale: 0.5), 1920, 1080);
        Assert.Equal(960, even.BoxWidth);
        Assert.Equal(540, even.BoxHeight);
        Assert.Equal(960, even.NormalizeBoxWidth);
        Assert.Equal(540, even.NormalizeBoxHeight);

        var odd = LayerGeometry.Compute(ExportTestDocs.Transform(scale: 0.501), 1920, 1080);
        Assert.Equal(962, odd.BoxWidth);    // 1920*0.501 = 962 (çift)
        Assert.Equal(541, odd.BoxHeight);   // 1080*0.501 = 541 (TEK)
        Assert.Equal(962, odd.NormalizeBoxWidth);
        Assert.Equal(540, odd.NormalizeBoxHeight);
    }

    [Theory]
    [InlineData(2L, 2L)]
    [InlineData(3L, 2L)]   // 3 & ~1 = 2 — alt sınır zaten sağlanıyor
    [InlineData(1L, 2L)]   // 1 & ~1 = 0 → Math.Max(2,...) devreye girer: pad=0 üretilemez
    [InlineData(0L, 2L)]
    public void NormalizeBox_ClampsToTwo_SoPadTargetIsNeverZero(long box, long expected)
    {
        // Box ≥ 2 kapının (ExportCompiler.EnsureLayerFloor) garantisidir, ama o kapı ölçek
        // TABANINDAN sorulur ve bu yerleşim ölçek TAVANINDAN kurulur; ayrıca Compile'ı
        // Validate'siz çağıran bir yol açılırsa hiç koşmaz. pad=0 (ffmpeg'de "girdi boyutu"
        // demek) hiçbir yoldan sessizce üretilmemeli.
        var placement = Placement(box);
        Assert.Equal(expected, placement.NormalizeBoxWidth);
        Assert.Equal(expected, placement.NormalizeBoxHeight);
    }

    // ───────────────────── Dejenerelik (scale'in alt-piksel rejimi) ─────────────────────

    /// <summary>
    /// GERÇEK ffmpeg 8.0 ölçümleri: <c>scale=BW:BH:force_original_aspect_ratio=decrease:
    /// force_divisible_by=2</c> → <c>showinfo</c>'nun bildirdiği çıkış boyutu. Her satır ayrı bir
    /// ffmpeg süreciyle ölçülmüştür; tablo <see cref="ScaleOutput_MatchesRealFfmpeg"/> ile
    /// CANLI ffmpeg'e karşı yeniden koşulur (sürüm değişirse tablo değil GERÇEK ölçüm kazanır).
    /// srcW, srcH, boxW, boxH, outW, outH, dejenere mi.
    /// </summary>
    public static TheoryData<int, int, int, int, int, int, bool> MeasuredScaleOutputs() => new()
    {
        // ── DEJENERE: sığdırılan eksen 1 px'in ALTINDA → ffmpeg 0 hesaplar, "girdi boyutunu koru".
        { 1920, 100, 19, 11, 18, 100, true },   // rapor edilen vaka: 1080p, ölçek 0.010
        { 1920, 100, 19, 12, 18, 100, true },   // kutu yüksekliği fark etmez — kapı GENİŞLİKTE
        { 1920, 101, 19, 11, 18, 101, true },   // sınırın hemen ALTI (a = 19.01)
        {  200,  10, 19, 11, 18,  10, true },   // SESSİZ dal: 18x10 pad'e SIĞAR, hata vermez
        { 4000,  20, 19, 11, 18,  20, true },
        {  100,   8,  6,  6,  6,   8, true },   // İKİ EKSEN DE ÇİFT — parite kapısı bunu görmezdi
        {  100, 1200, 19, 11, 100, 10, true },  // DİKEY şerit → GENİŞLİK ekseni dejenere
        {   60, 1000, 19, 11,  60, 10, true },
        // ── TEMİZ: sığdırılan eksen ≥ 1 px.
        { 1920, 102, 19, 11, 18,   2, false },  // sınırın hemen ÜSTÜ (a = 18.82)
        { 1920, 100, 20, 11, 20,   2, false },  // kutu genişliği 20'ye çıkınca temiz
        { 1920, 100, 21, 12, 20,   2, false },  // MinScaleFor'un önerdiği kutu (ölçek 0.011)
        {  100, 1100, 19, 11,  2,  10, false }, // sınır TAM eşitlik: 11*100 == 1100
        { 1920, 1080, 19, 11, 18,  10, false }, // normal medya en küçük kutuda bile temiz
        { 1080, 1920, 19, 11,  6,  10, false },
        {  640,  480, 19, 11, 14,  10, false },
        {  512,  512, 19, 11, 12,  10, false },
        { 2560, 1080, 19, 11, 18,   8, false }, // 21:9 sinema oranı — hiç dejenere olmaz
        { 1920,  200, 19, 11, 18,   2, false },
        { 1920, 1080, 962, 541, 962, 540, false }, // parite düzeltmesinin fixture'ı
        { 3840, 2160, 962, 541, 962, 540, false },
    };

    [Theory]
    [MemberData(nameof(MeasuredScaleOutputs))]
    public void ScaleOutput_ReproducesMeasuredFfmpegDimensions(
        int srcW, int srcH, int boxW, int boxH, int outW, int outH, bool degenerate)
    {
        // Model KAYAN NOKTASIZDIR (av_rescale'in tamsayı yuvarlaması); kayan noktalı bir
        // replika ffmpeg sürümleri arasında sessizce ayrışırdı.
        Assert.Equal((outW, outH), LayerGeometry.ScaleOutput(boxW, boxH, srcW, srcH));
        Assert.Equal(degenerate, LayerGeometry.IsDegenerate(boxW, boxH, srcW, srcH));

        if (!degenerate)
        {
            // Temiz rejimde "çıktı ≤ kutu" sözleşmesi geçerlidir (pad hedefinin dayanağı).
            Assert.True(outW <= boxW && outH <= boxH, $"{outW}x{outH} kutuyu aştı");
            return;
        }

        // Dejenereliğin GÖZLENEBİLİR imzası: o eksende çıkış KAYNAĞIN KENDİ boyutudur
        // (ffmpeg 0'ı "girdi boyutunu koru" diye yorumlar). Bu, "çıktı kutuyu AŞAR" ile
        // AYNI ŞEY DEĞİLDİR — dejenerelik İKİ sonuç sınıfına ayrılır ve ikisi de kabul edilemez:
        //   * GÜRÜLTÜLÜ: kaynak boyutu pad hedefini aşar → ffmpeg -22, iş kuyruk sonrası ölür;
        //   * SESSİZ:    pad hedefine sığar → hiç hata yok, katman yanlış boyutta çizilir.
        // Tablodaki 200x10 vakası ikinci sınıftır (18x10, kutu 19x11'e SIĞAR) ve tam olarak bu
        // yüzden "çıktı kutuyu aşıyor mu" diye sormak kapı olarak YETMEZ.
        Assert.True(outW == srcW || outH == srcH,
            $"dejenere vakada eksenlerden biri kaynak boyutuna eşit olmalıydı: {outW}x{outH}");
    }

    [Fact]
    public void Degeneracy_HasBothANoisyAndASilentConsequenceClass()
    {
        // Bu ayrım kapının VARLIK GEREKÇESİDİR: "zaten patlıyordu, sessiz bozulma yok" iddiası
        // ölçümle yanlıştır. Aynı kutuda (19x11) iki afiş kaynağı iki farklı sonuç verir.
        var padTarget = (Width: 19 & ~1, Height: 11 & ~1); // NormalizeBox* = 18x10

        // GÜRÜLTÜLÜ: 1920x100 → 18x100; 100 > 10 → "Padded dimensions cannot be smaller" (-22).
        var noisy = LayerGeometry.ScaleOutput(19, 11, 1920, 100);
        Assert.True(LayerGeometry.IsDegenerate(19, 11, 1920, 100));
        Assert.True(noisy.Height > padTarget.Height);

        // SESSİZ: 200x10 → 18x10; pad hedefine TAM sığar → ffmpeg hiç şikâyet etmez, katman
        // önizlemenin çizdiği ~1 px yerine 10 px yüksek çizilir. Hiçbir kapı bunu görmüyordu.
        var silent = LayerGeometry.ScaleOutput(19, 11, 200, 10);
        Assert.True(LayerGeometry.IsDegenerate(19, 11, 200, 10));
        Assert.True(silent.Width <= padTarget.Width && silent.Height <= padTarget.Height);
    }

    [Fact]
    public void IsDegenerate_ClosedForm_AgreesWithTheExactModel_OverTheSweptBoxAndSourceRange()
    {
        // Kapalı form: BW*srcH < srcW || BH*srcW < srcH. MinScaleFor'u bundan çözüyoruz, o
        // yüzden TAM MODELLE aynı cevabı vermesi ŞART — ama YALNIZ kutu ≥ 2 iken (kutu < 2'de
        // min-kırpması da 0 üretir, kapalı form onu görmez). Kutu 2'nin ALTINDAKİ rejim ayrıca
        // ScaleFloor_ImpliesDegeneracy_OverTheSweptSources ile taranır.
        var mismatches = 0;
        for (var srcW = 1; srcW <= 200; srcW += 3)
        {
            for (var srcH = 1; srcH <= 200; srcH += 3)
            {
                for (var boxW = 2; boxW <= 40; boxW++)
                {
                    for (var boxH = 2; boxH <= 40; boxH++)
                    {
                        var exact = LayerGeometry.IsDegenerate(boxW, boxH, srcW, srcH);
                        var closed = ((long)boxW * srcH) < srcW || ((long)boxH * srcW) < srcH;
                        if (exact != closed)
                        {
                            mismatches++;
                        }
                    }
                }
            }
        }

        Assert.Equal(0, mismatches);
    }

    [Theory]
    // 1080p tuval + afiş kaynak: eşik (ceil(1920/100) - 0.5)/1920 = 19.5/1920 = 0.010156 → 0.011
    [InlineData(1920, 100, 0.011)]
    [InlineData(1920, 101, 0.011)]
    [InlineData(1920, 102, 0.010)]  // a = 18.82 → eşiğin altında, taban zaten SCALE_MIN
    [InlineData(1920, 1080, 0.002)] // normal medya: kutu ≥ 2 kuralı bağlar (1.5/1080 → 0.002)
    [InlineData(200, 10, 0.011)]    // 20:1, kaynak küçük ama ORAN belirleyici → 19.5/1920 → 0.011
    [InlineData(100, 1200, 0.011)]  // DİKEY şerit: (12-0.5)/1080 = 0.010648 → 0.011
    [InlineData(4000, 20, 0.104)]   // (200-0.5)/1920 = 0.103906 → 0.104
    public void MinScaleFor_IsTheSmallestGridScaleThatIsNotDegenerate(
        int srcW, int srcH, double expected)
    {
        var min = LayerGeometry.MinScaleFor(CompW, CompH, srcW, srcH);
        Assert.Equal(expected, min, 6);

        // KESİNLİK: önerilen ölçek dejenere DEĞİL, bir ızgara adımı altı ise dejenere OLMALI
        // (aksi halde kullanıcıya gereğinden büyük bir sayı söylenirdi).
        var (w, h) = LayerGeometry.ScaleBox(CompW, CompH, min);
        Assert.False(LayerGeometry.IsDegenerate(w, h, srcW, srcH));

        var below = Math.Round(min - 0.001d, 3);
        if (below >= 0.01d)
        {
            var (bw, bh) = LayerGeometry.ScaleBox(CompW, CompH, below);
            Assert.True(LayerGeometry.IsDegenerate(bw, bh, srcW, srcH));
        }
    }

    [Fact]
    public void MinScaleFor_AgreesWithTheExactModel_AcrossTheEditorScaleGrid_ForTheSweptSources()
    {
        // Editörün yazabildiği HER ölçek (TRANSFORM_SCALE_MIN=0.01 … maxClipScale, 3 ondalık)
        // birkaç kaynak oranında taranır: MinScaleFor eşiğin ALTINDA hiç temiz, ÜSTÜNDE hiç
        // dejenere vaka bırakmamalı. Monotonluk da burada sabitlenir.
        int[][] sources = [[1920, 100], [1920, 101], [1920, 102], [200, 10], [100, 1200],
                           [1920, 1080], [640, 480], [2560, 1080], [4000, 20], [60, 1000]];
        foreach (var src in sources)
        {
            var min = LayerGeometry.MinScaleFor(CompW, CompH, src[0], src[1]);
            for (var step = 10; step <= 4266; step++)
            {
                var scale = step / 1000d;
                var (w, h) = LayerGeometry.ScaleBox(CompW, CompH, scale);
                var degenerate = LayerGeometry.IsDegenerate(w, h, src[0], src[1]);
                Assert.Equal(scale < min - 1e-9, degenerate);
            }
        }
    }

    [Fact]
    public void SweptRasterBboxes_AreNotDegenerate_WhenTheScaleFloorHolds()
    {
        // METİN/ŞEKİL rasterinin ölçek kutusunun TABANI kendi bbox'ıdır (§7), PNG'nin kendisi
        // de bbox × rasterScale'dir → kaynak aspect'i ≈ kutu aspect'i. Kutu ≥ 2 iken dejenerelik
        // eşitsizliği sağlanmaz; test bunu taramayla sabitler.
        //
        // ESKİ HALİ KUTU < 2 BÖLGESİNİ `continue` İLE ATLIYORDU ve gerekçesi "kapı zaten
        // reddediyor"du. O gerekçe 5. tur denetiminde ÖLÇÜLEREK yanlışlandı: kutu ≥ 2 kuralı
        // ölçek TAVANINDAN sorulduğu için ölçek animasyonlu bir metin klibi tabanda 2x1 (hatta
        // 0x0) kutuya inip kapıdan geçiyordu. Atlama KALDIRILDI; o bölge artık ölçülüyor ve
        // "kaynaktan bağımsız taban" yükleminin ORADA tetiklendiği iddia ediliyor. Yani
        // rasterlerin bağışıklığı KOŞULLUDUR ve koşulun kendisi ulaşılabilirdir.
        var aboveFloor = 0;
        var belowFloor = 0;
        double[] bboxWidths = [6, 8, 19, 64, 137, 551, 1280, 1920, 4096, 8000];
        double[] bboxHeights = [3, 7, 20, 24, 77, 180, 720, 1080, 2160, 8000];
        int[] rasterScales = [1, 2, 3];
        foreach (var bw in bboxWidths)
        {
            foreach (var bh in bboxHeights)
            {
                foreach (var rasterScale in rasterScales)
                {
                    // PNG boyutu raster hattının yuvarlamasıyla üretilir (bbox ile TAM orantılı
                    // olmayabilir) — kapı gerçek PNG boyutunu gördüğü için burada da öyle.
                    var srcW = (long)Math.Round(bw * rasterScale, MidpointRounding.AwayFromZero);
                    var srcH = (long)Math.Round(bh * rasterScale, MidpointRounding.AwayFromZero);
                    for (var step = 10; step <= 4266; step++)
                    {
                        var scale = step / 1000d;

                        // İKİ kutu aritmetiği de taranır: STATİK yol yuvarlar, ANİMASYONLU yol
                        // (ffmpeg'in ifade değerlendirmesi) KIRPAR. Tarama yalnız birini
                        // sorsaydı, kapının gerçekten kaçırdığı bandı görmezdi.
                        (long W, long H)[] boxes =
                        [
                            LayerGeometry.ScaleBox(bw, bh, scale),
                            LayerGeometry.ScaleBoxTruncated(bw, bh, scale),
                        ];
                        foreach (var (w, h) in boxes)
                        {
                            if (LayerGeometry.IsBelowScaleFloor(w, h))
                            {
                                // ULAŞILABİLİR BÖLGE (ölçek animasyonunun tabanı). Kaynaktan
                                // bağımsız yarı burada tetiklenmeli — Validate'te PNG boyutu yok.
                                Assert.True(
                                    LayerGeometry.IsDegenerate(w, h, srcW, srcH),
                                    $"bbox {bw}x{bh} @{rasterScale}x, ölçek {scale}: kutu {w}x{h} "
                                    + "taban altında ama tam model bunu dejenere saymadı");
                                belowFloor++;
                                continue;
                            }

                            Assert.False(
                                LayerGeometry.IsDegenerate(w, h, srcW, srcH),
                                $"bbox {bw}x{bh} @{rasterScale}x, ölçek {scale}: kutu {w}x{h}");
                            aboveFloor++;
                        }
                    }
                }
            }
        }

        // İki bölgenin de GERÇEKTEN tarandığı sabitlenir: "0 vaka" bir iddiayı yeşil gösterirdi.
        Assert.True(aboveFloor > 500_000, $"taban ÜSTÜ tarama beklenenden dar: {aboveFloor}");
        Assert.True(belowFloor > 0, "taban ALTI bölge hiç taranmadı — atlama geri gelmiş olabilir");
    }

    [Theory]
    // fit, scale, statik kutu (roundHalfUp), animasyonlu kutu (ffmpeg KIRPAR)
    [InlineData(223d, 0.015, 3L, 3L)]     // 3.345 → iki model de 3
    [InlineData(104d, 0.015, 2L, 1L)]     // 1.56  → AYRIŞIYOR: statikte 2, animasyonluda 1
    [InlineData(104d, 0.020, 2L, 2L)]     // 2.08  → yeni taban: iki model de 2
    [InlineData(6d, 0.25, 2L, 1L)]        // 1.5   → AYRIŞIYOR (varyant 2'nin ölen vakası)
    [InlineData(6d, 0.334, 2L, 2L)]       // 2.004
    [InlineData(1920d, 0.001, 2L, 1L)]    // 1.92  → AYRIŞIYOR
    public void ScaleBox_And_ScaleBoxTruncated_AreDifferentArithmetics(
        double fit, double scale, long rounded, long truncated)
    {
        // İki yol İKİ FARKLI kutu üretir ve fark tam olarak tabanda belirleyicidir:
        // force_divisible_by=2 tek pikseli 0'a indirir, yani 2 ile 1 arasındaki bu fark
        // "çizilir" ile "katman kaynağın boyutuna sıçrar" farkıdır.
        Assert.Equal(rounded, LayerGeometry.ScaleBox(fit, fit, scale).Width);
        Assert.Equal(truncated, LayerGeometry.ScaleBoxTruncated(fit, fit, scale).Width);
        Assert.True(truncated <= rounded, "kırpma yuvarlamayı ASLA aşamaz");
    }

    [Theory]
    // fit (bbox), animasyonlu mu, beklenen taban ölçeği
    [InlineData(223d, 104d, false, 0.015)]  // statik: (2-0.5)/104 = 0.014423 → 0.015
    [InlineData(223d, 104d, true, 0.020)]   // animasyonlu: 2/104 = 0.019230 → 0.020
    [InlineData(6d, 20d, false, 0.25)]      // statik: (2-0.5)/6 = 0.25
    [InlineData(6d, 20d, true, 0.334)]      // animasyonlu: 2/6 = 0.33333 → 0.334
    public void MinScaleFor_InvertsTheBoxArithmeticOfThePathThatWillBeCompiled(
        double fitWidth, double fitHeight, bool truncated, double expected)
    {
        var min = LayerGeometry.MinScaleFor(fitWidth, fitHeight, 0, 0, truncated);
        Assert.Equal(expected, min, 6);

        // KESİNLİK: önerilen ölçek O YOLUN kutusuyla taban ÜSTÜNDE, bir ızgara adımı altı ise
        // taban ALTINDA olmalı — aksi halde kullanıcıya söylenen sayı ya çalışmaz ya da
        // gereğinden büyük olur (ikisi de bu turda ölçülerek yaşandı).
        (long W, long H) BoxAt(double s) => truncated
            ? LayerGeometry.ScaleBoxTruncated(fitWidth, fitHeight, s)
            : LayerGeometry.ScaleBox(fitWidth, fitHeight, s);

        var at = BoxAt(min);
        Assert.False(LayerGeometry.IsBelowScaleFloor(at.W, at.H), $"öneri {min} kutu {at.W}x{at.H}");

        var below = Math.Round(min - 0.001d, 3);
        var under = BoxAt(below);
        Assert.True(
            LayerGeometry.IsBelowScaleFloor(under.W, under.H),
            $"bir adım altı ({below}) kutu {under.W}x{under.H} — öneri gereğinden büyük");
    }

    [Fact]
    public void ScaleFloor_ImpliesDegeneracy_OverTheSweptSources()
    {
        // Kapının iki yüklemi ÇELİŞMEZ: kaynak biliniyorken kutu < 2 DAİMA dejenere çıkar.
        // Kaynaktan bağımsız yarı (IsBelowScaleFloor) bu yüzden emniyetli bir daraltmadır —
        // ölçüm/defter yokluğunda yanlış RET değil, yalnız daha az vaka görür.
        var belowFloor = 0;
        for (var srcW = 1; srcW <= 400; srcW += 7)
        {
            for (var srcH = 1; srcH <= 400; srcH += 7)
            {
                for (var boxW = 0; boxW <= 3; boxW++)
                {
                    for (var boxH = 0; boxH <= 3; boxH++)
                    {
                        if (!LayerGeometry.IsBelowScaleFloor(boxW, boxH))
                        {
                            continue;
                        }

                        Assert.True(
                            LayerGeometry.IsDegenerate(boxW, boxH, srcW, srcH),
                            $"kutu {boxW}x{boxH}, kaynak {srcW}x{srcH}");
                        belowFloor++;
                    }
                }
            }
        }

        Assert.True(belowFloor > 0, "hiç vaka taranmadı");

        // TERS YÖN: kaynak BİLİNMİYORken tam model kapıyı hiç çalıştırmaz (yanlış 422 yok) —
        // "boyutsuz asset'te ret üretilmez" güvencesi kutu 0 dalında da korunuyor.
        Assert.False(LayerGeometry.IsDegenerate(0, 0, 0, 0));
        Assert.False(LayerGeometry.IsDegenerate(1, 1, 0, 200));
        Assert.False(LayerGeometry.IsDegenerate(0, 5, 1920, 0));
    }

    /// <summary>Alt sınır testi için doğrudan kurulmuş yerleşim (Compute bu kutuları üretemez).</summary>
    private static LayerPlacement Placement(long box) => new()
    {
        BoxWidth = box,
        BoxHeight = box,
        RotationRad = 0,
        PadWidthFactor = 1,
        PadHeightFactor = 1,
        PadXFactor = 0,
        PadYFactor = 0,
        AnchorTargetX = 0,
        AnchorTargetY = 0,
        OverlayAnchorFactorX = 0.5,
        OverlayAnchorFactorY = 0.5,
        IntermediateWidth = box,
        IntermediateHeight = box,
    };
}
