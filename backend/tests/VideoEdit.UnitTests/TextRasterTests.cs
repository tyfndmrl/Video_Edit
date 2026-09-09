using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// Metin rasteri — GERÇEK glif çizimi (rendering-semantics §7).
/// <para>
/// Font kaynağı <see cref="TestFonts"/> tarafından seçilir: küratörlü set kuruluysa o, değilse
/// sistem fontu (MUTLAK yolla, depoya kopyalanmadan). Bu yüzden buradaki iddialar font
/// dosyasından BAĞIMSIZ değişmezlerdir — belirlenimcilik, satır/hizalama ilişkileri, bbox
/// büyüme yönü, straight alpha, eksik glif raporu. Piksel golden'ı YOKTUR: sistem fontu
/// makineden makineye değişir (şekil golden'ları taşınabilir, bkz. <see cref="ShapeRasterTests"/>).
/// </para>
/// </summary>
public sealed class TextRasterTests : IDisposable
{
    private readonly string dir = OverlayTestDocs.TempDir();
    private readonly SkiaOverlayRasterService service = TestFonts.Available
        ? TestFonts.CreateService()
        : null!;

    public void Dispose()
    {
        service?.Dispose();
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch (IOException)
        {
            // best-effort
        }
    }

    private Task<RasterResult> RenderAsync(TextClip clip, string name) =>
        service.RenderAsync(clip, OverlayTestDocs.Settings(), Path.Combine(dir, name));

    // ---------- Belirlenimcilik ----------

    [FontFact]
    public async Task SameInput_ProducesByteIdenticalPng()
    {
        var clip = OverlayTestDocs.Text(
            "Merhaba dünya",
            id: Guid.Parse("22222222-2222-2222-2222-222222222222"));

        var first = await RenderAsync(clip, "text-1.png");
        var second = await RenderAsync(clip, "text-2.png");

        Assert.Equal(first.Sha256, second.Sha256);
        Assert.Equal(File.ReadAllBytes(first.Path), File.ReadAllBytes(second.Path));
        Assert.Equal(first.Width, second.Width);
        Assert.Equal(first.BboxWidthPx, second.BboxWidthPx);
    }

    [FontFact]
    public async Task NewServiceInstance_ProducesTheSameBytes()
    {
        // Typeface cache'i / shaper durumu çıktıyı ETKİLEMEMELİ: worker'ın her koşusu aynı
        // PNG'yi üretmek zorundadır (export'un yeniden üretilebilirliği).
        var clip = OverlayTestDocs.Text("Aynı içerik", id: Guid.NewGuid());
        var first = await RenderAsync(clip, "fresh-1.png");

        using var other = TestFonts.CreateService();
        var second = await other.RenderAsync(
            clip, OverlayTestDocs.Settings(), Path.Combine(dir, "fresh-2.png"));

        Assert.Equal(first.Sha256, second.Sha256);
    }

    [FontFact]
    public async Task DifferentContent_ProducesDifferentBytes()
    {
        var a = await RenderAsync(OverlayTestDocs.Text("AAA"), "diff-a.png");
        var b = await RenderAsync(OverlayTestDocs.Text("BBB"), "diff-b.png");

        Assert.NotEqual(a.Sha256, b.Sha256);
    }

    // ---------- Çok satır ----------

    [FontFact]
    public async Task MultiLine_ProducesOneLinePerBreakAndGrowsInHeight()
    {
        var single = await RenderAsync(OverlayTestDocs.Text("bir"), "single.png");
        var triple = await RenderAsync(OverlayTestDocs.Text("bir\niki\nüç"), "triple.png");

        Assert.Single(single.Lines);
        Assert.Equal(3, triple.Lines.Count);
        Assert.Equal(["bir", "iki", "üç"], triple.Lines.Select(l => l.Text));

        // Satır yükseklikleri eşit aralıklı olmalı (CSS line-height modeli).
        var gap = triple.Lines[1].BaselineYPx - triple.Lines[0].BaselineYPx;
        Assert.Equal(gap, triple.Lines[2].BaselineYPx - triple.Lines[1].BaselineYPx, 6);
        Assert.Equal(48 * 1.2, gap, 6);

        Assert.True(triple.BboxHeightPx > single.BboxHeightPx * 2,
            $"3 satır ({triple.BboxHeightPx}) 1 satırın ({single.BboxHeightPx}) iki katından yüksek olmalı");
    }

    [FontFact]
    public async Task LineHeight_ChangesHeightButNotWidth()
    {
        var tight = await RenderAsync(OverlayTestDocs.Text("a\nb", lineHeight: 1.0), "lh-1.png");
        var loose = await RenderAsync(OverlayTestDocs.Text("a\nb", lineHeight: 2.0), "lh-2.png");

        Assert.Equal(tight.BboxWidthPx, loose.BboxWidthPx);
        Assert.True(loose.BboxHeightPx > tight.BboxHeightPx);
    }

    // ---------- Hizalama ----------

    [Theory]
    [InlineData(TextClipTextAlign.Left)]
    [InlineData(TextClipTextAlign.Center)]
    [InlineData(TextClipTextAlign.Right)]
    public async Task Align_PlacesTheShortLineConsistently(TextClipTextAlign align)
    {
        if (!TestFonts.Available)
        {
            return; // FontFact karşılığı: Theory'de atlama attribute'u yok
        }

        var result = await RenderAsync(
            OverlayTestDocs.Text("kısa\nçok daha uzun satır", align: align), $"align-{align}.png");

        var shortLine = result.Lines[0];
        var longLine = result.Lines[1];
        var slack = longLine.AdvanceWidthPx - shortLine.AdvanceWidthPx;
        Assert.True(slack > 0, "uzun satır gerçekten daha geniş olmalı");

        var expectedLeft = align switch
        {
            TextClipTextAlign.Center => slack / 2,
            TextClipTextAlign.Right => slack,
            _ => 0,
        };

        Assert.Equal(expectedLeft, shortLine.LeftPx, 3);
        Assert.Equal(0, longLine.LeftPx, 3);
    }

    [FontFact]
    public async Task Align_ChangesThePixelsNotJustTheMetadata()
    {
        var left = await RenderAsync(
            OverlayTestDocs.Text("a\nuzun satır", align: TextClipTextAlign.Left), "px-left.png");
        var right = await RenderAsync(
            OverlayTestDocs.Text("a\nuzun satır", align: TextClipTextAlign.Right), "px-right.png");

        Assert.Equal(left.Width, right.Width);
        Assert.NotEqual(left.Sha256, right.Sha256);
    }

    // ---------- Kontur + arka plan ----------

    [FontFact]
    public async Task Stroke_ExpandsTheBboxWithoutExceedingItsHalfWidth()
    {
        var plain = await RenderAsync(OverlayTestDocs.Text("Kontur"), "stroke-off.png");
        var stroked = await RenderAsync(
            OverlayTestDocs.Text("Kontur", stroke: new Stroke { Color = "#ff0000", WidthPx = 8 }),
            "stroke-on.png");

        // Kontur glif konturunun ORTASINDADIR → her kenarda EN FAZLA widthPx/2 taşar. Gerçek
        // büyüme bundan az olabilir: mürekkep kutusu advance kutusundan dardır (yan boşluklar),
        // yani konturun bir kısmı zaten mevcut bbox'ın içinde kalır. Bire bir +widthPx
        // matematiği TextLayoutEngineTests'te (sahte ölçümle) sabitlenmiştir.
        Assert.InRange(stroked.BboxWidthPx, plain.BboxWidthPx, plain.BboxWidthPx + 8);
        Assert.InRange(stroked.BboxHeightPx, plain.BboxHeightPx, plain.BboxHeightPx + 8);
        Assert.InRange(stroked.OriginXPx - plain.OriginXPx, 0, 4);
        Assert.True(stroked.BboxWidthPx > plain.BboxWidthPx, "kontur bbox'ı genişletmeliydi");
    }

    [FontFact]
    public async Task Background_FillsThePaddedBoxBehindTheText()
    {
        var result = await RenderAsync(
            OverlayTestDocs.Text(
                "Arka plan",
                fill: "#000000",
                background: new Background { Color = "#ffcc00", PaddingPx = 20, RadiusPx = 0 }),
            "background.png");

        using var bitmap = RasterAssert.Decode(result.Path);

        // Köşe: yarıçap 0 → arka plan kutusunun köşesi DOLU olmalı.
        var corner = bitmap.GetPixel(1, 1);
        Assert.Equal(255, corner.Alpha);
        Assert.Equal(0xff, corner.Red);
        Assert.Equal(0xcc, corner.Green);
        Assert.Equal(0x00, corner.Blue);
    }

    [FontFact]
    public async Task BackgroundRadius_LeavesTheCornerTransparent()
    {
        var square = await RenderAsync(
            OverlayTestDocs.Text("R", background: new Background { Color = "#ffcc00", PaddingPx = 20, RadiusPx = 0 }),
            "radius-0.png");
        var rounded = await RenderAsync(
            OverlayTestDocs.Text("R", background: new Background { Color = "#ffcc00", PaddingPx = 20, RadiusPx = 18 }),
            "radius-18.png");

        using var squareBitmap = RasterAssert.Decode(square.Path);
        using var roundedBitmap = RasterAssert.Decode(rounded.Path);

        Assert.Equal(255, squareBitmap.GetPixel(0, 0).Alpha);
        Assert.Equal(0, roundedBitmap.GetPixel(0, 0).Alpha);
        Assert.Equal(square.Width, rounded.Width); // yarıçap bbox'ı DEĞİŞTİRMEZ
    }

    [FontFact]
    public async Task StrokeAndBackgroundTogether_KeepEverythingInsideTheRaster()
    {
        var result = await RenderAsync(
            OverlayTestDocs.Text(
                "Aağ",
                fill: "#ffffff",
                stroke: new Stroke { Color = "#ff0000", WidthPx = 6 },
                background: new Background { Color = "#00000080", PaddingPx = 12, RadiusPx = 6 }),
            "stroke-bg.png");

        using var bitmap = RasterAssert.Decode(result.Path);

        // Kenar sütunları: mürekkep KIRPILMAMIŞ olmalı — en dış piksel sırasında
        // tam opak kırmızı (kontur) BULUNMAMALI, yani kontur rastere sığmış olmalı.
        for (var y = 0; y < bitmap.Height; y++)
        {
            var left = bitmap.GetPixel(0, y);
            var right = bitmap.GetPixel(bitmap.Width - 1, y);
            Assert.False(left is { Red: > 200, Green: < 80, Blue: < 80, Alpha: 255 },
                $"sol kenarda kırpılmış kontur var (y={y})");
            Assert.False(right is { Red: > 200, Green: < 80, Blue: < 80, Alpha: 255 },
                $"sağ kenarda kırpılmış kontur var (y={y})");
        }
    }

    // ---------- Türkçe + emoji ----------

    [FontFact]
    public async Task TurkishCharacters_AreRenderedNotDropped()
    {
        var ascii = await RenderAsync(OverlayTestDocs.Text("Iigsc"), "tr-ascii.png");
        var turkish = await RenderAsync(OverlayTestDocs.Text("İığşç"), "tr-full.png");

        Assert.False(turkish.HasMissingGlyphs,
            "Türkçe karakterler (İ ğ ş ç) küratörlü/sistem fontunda bulunmalı");
        Assert.NotEqual(ascii.Sha256, turkish.Sha256);

        // Noktalı İ ve kuyruklu ş/ç dikey kutuyu büyütür (ya da en azından küçültmez).
        Assert.True(turkish.BboxHeightPx >= ascii.BboxHeightPx);
    }

    [FontFact]
    public async Task DottedCapitalI_DiffersFromPlainI()
    {
        // Türkçe'nin klasik tuzağı: 'I' ile 'İ' AYNI glif olmamalı.
        var plain = await RenderAsync(OverlayTestDocs.Text("I"), "tr-I.png");
        var dotted = await RenderAsync(OverlayTestDocs.Text("İ"), "tr-Idot.png");

        Assert.NotEqual(plain.Sha256, dotted.Sha256);
    }

    [CuratedFontFact]
    public async Task Emoji_WithoutAnEmojiFont_IsReportedAsMissingGlyph()
    {
        // Küratörlü sette emoji fontu YOKTUR (fonts/README.md): .notdef kutusu çizilir ama
        // SESSİZ KALINMAZ — sonuç işaretlenir, worker uyarı loglar.
        //
        // KAPI NEDEN [CuratedFontFact]: bu iddia bir DEĞİŞMEZ değil, KÜRATÖRLÜ SETİN
        // özelliğidir ("bu sette emoji fontu yok"). Sistem fontuyla koşarsa font
        // rastgeledir ve iddia anlamını yitirir. CI'da ÖLÇÜLDÜ: fontlar indirilmediği
        // için test sistem fontuna (Ubuntu'da DejaVu Sans) düşüyordu ve DejaVu
        // U+1F600 için glif TAŞIYOR (glyph 5857) — iddia haklı olarak kırmızıya döndü.
        // Küratörlü Roboto'da aynı kod noktası glif 0 verir (Linux'ta ölçüldü), yani
        // ÜRÜN doğruydu; kusur testin kapısındaydı.
        var result = await RenderAsync(OverlayTestDocs.Text("selam \U0001F600"), "emoji.png");

        Assert.True(result.HasMissingGlyphs);
        Assert.True(File.Exists(result.Path), "eksik glif render'ı yine de PNG üretmeli");
    }

    // ---------- Font çözümü ----------

    [FontFact]
    public async Task ManifestFont_IsMarkedCuratedAndDeterministic()
    {
        // Manifest'in gösterdiği dosya diskte VARSA sistem fontuna ASLA düşülmez: sonuç
        // 'küratörlü' işaretlenir, belirlenimcidir ve uyarı taşımaz (fonts/README.md üç mod).
        var result = await RenderAsync(OverlayTestDocs.Text("Küratörlü"), "curated.png");

        Assert.Equal(FontSourceKind.Curated, result.FontSource);
        Assert.True(result.Deterministic);
        Assert.Null(result.FontWarning);
        Assert.False(string.IsNullOrWhiteSpace(result.FontFamily));
    }

    [FontFact]
    public async Task UnknownFontId_FailsWithFontMissing()
    {
        var ex = await Assert.ThrowsAsync<FontNotFoundException>(() =>
            RenderAsync(OverlayTestDocs.Text("x", fontId: "boyle-bir-font-yok"), "nofont.png"));

        Assert.Equal("font-missing", ex.Code);
    }

    [FontFact]
    public async Task Italic_IsAppliedAndFlaggedWhenSynthesized()
    {
        var upright = await RenderAsync(OverlayTestDocs.Text("Eğik", italic: false), "upright.png");
        var italic = await RenderAsync(OverlayTestDocs.Text("Eğik", italic: true), "italic.png");

        Assert.NotEqual(upright.Sha256, italic.Sha256);
        Assert.False(upright.SyntheticItalic);

        // Küratörlü sette italik DOSYA vardır; sistem fallback'inde yoktur → sentetik oblik.
        if (!TestFonts.CuratedAvailable)
        {
            Assert.True(italic.SyntheticItalic);
        }
    }

    // ---------- @2x kuralı + ölçüm API'si ----------

    [FontFact]
    public async Task Raster_IsTwiceTheBbox()
    {
        var result = await RenderAsync(OverlayTestDocs.Text("Ölçek"), "scale-2x.png");

        Assert.Equal(2, result.RasterScale);
        Assert.Equal(result.Width, (int)Math.Ceiling(result.BboxWidthPx * 2));
        Assert.Equal(result.Height, (int)Math.Ceiling(result.BboxHeightPx * 2));
    }

    [FontFact]
    public async Task RasterScale_FollowsCeilOfTransformScaleAboveTwo()
    {
        var normal = await RenderAsync(OverlayTestDocs.Text("Ö", scale: 1), "s1.png");
        var large = await RenderAsync(OverlayTestDocs.Text("Ö", scale: 3.2), "s4.png");

        Assert.Equal(2, normal.RasterScale);
        Assert.Equal(4, large.RasterScale);
        Assert.Equal(normal.BboxWidthPx, large.BboxWidthPx); // bbox ölçekten BAĞIMSIZ
        Assert.True(large.Width > normal.Width);
    }

    [FontFact]
    public void Measure_ReturnsLayoutWithoutWritingAFile()
    {
        var clip = OverlayTestDocs.Text("ölçüm\niki satır");

        var layout = service.Measure(clip.Text, OverlayTestDocs.Settings());

        Assert.Equal(2, layout.Lines.Count);
        Assert.True(layout.BboxWidthPx > 0);
        Assert.Empty(Directory.GetFiles(dir));
    }

    [FontFact]
    public async Task Measure_AgreesWithTheRenderedRaster()
    {
        // Frontend bbox'ı Measure'dan alır, export ise Render'dan — İKİSİ AYNI OLMAK ZORUNDA.
        var clip = OverlayTestDocs.Text(
            "parity\ntesti", stroke: new Stroke { Color = "#000000", WidthPx = 4 });

        var measured = service.Measure(clip.Text, OverlayTestDocs.Settings());
        var rendered = await RenderAsync(clip, "parity.png");

        Assert.Equal(measured.BboxWidthPx, rendered.BboxWidthPx);
        Assert.Equal(measured.BboxHeightPx, rendered.BboxHeightPx);
        Assert.Equal(measured.OriginXPx, rendered.OriginXPx);
        Assert.Equal(measured.Lines.Count, rendered.Lines.Count);
    }

    // ---------- Uç durumlar ----------

    [FontFact]
    public async Task EmptyContent_StillProducesAValidTransparentPng()
    {
        var result = await RenderAsync(OverlayTestDocs.Text(string.Empty), "empty.png");

        Assert.True(result.Width >= 1 && result.Height >= 1);
        using var bitmap = RasterAssert.Decode(result.Path);
        Assert.Equal(0, bitmap.GetPixel(0, 0).Alpha);
    }

    [FontFact]
    public async Task InvalidFontSize_FailsWithATypedError()
    {
        var ex = await Assert.ThrowsAsync<UnsupportedOverlayClipException>(() =>
            RenderAsync(OverlayTestDocs.Text("x", fontSizePx: 0), "zero.png"));

        Assert.Equal("overlay-unsupported-clip", ex.Code);
    }

    [FontFact]
    public async Task TextIsWrittenAtomically()
    {
        var result = await RenderAsync(OverlayTestDocs.Text("atomik"), "atomic-text.png");

        Assert.False(File.Exists(result.Path + ".part"));
        Assert.Equal(new FileInfo(result.Path).Length, result.ByteSize);
    }
}
