using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// Metin yerleşimi (rendering-semantics §7 — "layout'un tek doğruluk kaynağı sunucudur").
/// Bu testler FONT DOSYASI GEREKTİRMEZ: ölçüm <see cref="FakeMeasurer"/> ile sabitlenir, böylece
/// satır kırma / hizalama / dikey model / bbox matematiği fontlardan bağımsız olarak kilitlenir.
/// Dikey model CSS line-height ile AYNI olmalıdır — preview↔export parity'sinin şartı.
/// </summary>
public sealed class TextLayoutEngineTests
{
    private static TextLayoutRequest Request(
        string content,
        double fontSize = 10,
        double lineHeight = 1.2,
        TextClipTextAlign align = TextClipTextAlign.Left,
        double strokeWidth = 0,
        double? backgroundPadding = null,
        double? maxWidth = null) => new()
        {
            Content = content,
            FontSizePx = fontSize,
            LineHeight = lineHeight,
            Align = align,
            StrokeWidthPx = strokeWidth,
            BackgroundPaddingPx = backgroundPadding,
            MaxWidthPx = maxWidth,
        };

    // ---------- Satır ayrımı ----------

    [Fact]
    public void HardBreaks_ProduceOneLineEach()
    {
        var layout = TextLayoutEngine.Layout(Request("ab\ncde\nf"), new FakeMeasurer());

        Assert.Equal(3, layout.Lines.Count);
        Assert.Equal(["ab", "cde", "f"], layout.Lines.Select(l => l.Text));
        // İçerik genişliği EN UZUN satırın advance'ıdır (3 karakter × 10 px).
        Assert.Equal(30, layout.ContentWidthPx);
    }

    [Fact]
    public void CrlfAndCr_AreNormalizedToSingleBreaks()
    {
        var crlf = TextLayoutEngine.Layout(Request("a\r\nb\rc"), new FakeMeasurer());
        var lf = TextLayoutEngine.Layout(Request("a\nb\nc"), new FakeMeasurer());

        Assert.Equal(3, crlf.Lines.Count);
        Assert.Equal(lf.Lines.Select(l => l.Text), crlf.Lines.Select(l => l.Text));
        Assert.Equal(lf.BboxHeightPx, crlf.BboxHeightPx);
    }

    [Fact]
    public void EmptyContent_StillHasOneLineAndFullLineHeight()
    {
        var layout = TextLayoutEngine.Layout(Request(string.Empty, fontSize: 10, lineHeight: 1.5), new FakeMeasurer());

        Assert.Single(layout.Lines);
        Assert.Equal(15, layout.ContentHeightPx); // 10 * 1.5
        Assert.Equal(0, layout.ContentWidthPx);
        // Bbox asla 0 olmaz: en az 1×1 (geçersiz PNG boyutu üretilemez).
        Assert.True(layout.BboxWidthPx >= 1);
        Assert.True(layout.BboxHeightPx >= 1);
    }

    [Fact]
    public void TrailingNewline_ProducesAnEmptyTrailingLine()
    {
        // "a\n" iki satırdır (ikincisi boş) — CSS/textarea davranışı.
        var layout = TextLayoutEngine.Layout(Request("a\n"), new FakeMeasurer());

        Assert.Equal(2, layout.Lines.Count);
        Assert.Equal(string.Empty, layout.Lines[1].Text);
        Assert.Equal(24, layout.ContentHeightPx); // 2 satır × 10 × 1.2
    }

    // ---------- Dikey model (CSS line-height) ----------

    [Fact]
    public void FirstBaseline_UsesCssHalfLeading()
    {
        // ascent=-8, descent=2 → font kutusu 10; lineHeight 1.2 × 10 = 12 → yarım leading 1.
        var layout = TextLayoutEngine.Layout(
            Request("a\nb", fontSize: 10, lineHeight: 1.2), new FakeMeasurer());

        Assert.Equal(12, layout.LineHeightPx);
        Assert.Equal(9, layout.Lines[0].BaselineYPx);   // halfLeading(1) + (-ascent)(8)
        Assert.Equal(21, layout.Lines[1].BaselineYPx);  // + bir satır yüksekliği
        Assert.Equal(24, layout.ContentHeightPx);
    }

    [Fact]
    public void LineHeightBelowFontBox_ProducesNegativeHalfLeading()
    {
        // lineHeight 0.8 × 10 = 8 < font kutusu 10 → yarım leading -1 (CSS'te de böyledir).
        // Mürekkebi ascent'ten TAŞAN bir fontta (aksanlı büyük harfler) bbox içerik kutusunun
        // üstüne çıkmak ZORUNDADIR, yoksa PNG'nin tepesi kırpılır.
        var layout = TextLayoutEngine.Layout(
            Request("a", fontSize: 10, lineHeight: 0.8),
            new FakeMeasurer { InkAscent = 9, InkDescent = 1 });

        Assert.Equal(7, layout.Lines[0].BaselineYPx); // -1 + 8
        Assert.Equal(8, layout.ContentHeightPx);
        Assert.Equal(-2, layout.BboxTopPx);           // mürekkep tepesi 7 - 9 = -2
        Assert.Equal(2, layout.OriginYPx);            // içerik kutusu PNG içinde 2 px aşağıda
        Assert.Equal(10, layout.BboxHeightPx);        // -2 .. 8
    }

    // ---------- Hizalama ----------

    [Theory]
    [InlineData(TextClipTextAlign.Left, 0d, 0d)]
    [InlineData(TextClipTextAlign.Center, 10d, 0d)]
    [InlineData(TextClipTextAlign.Right, 20d, 0d)]
    public void Align_PositionsShortLineWithinContentBox(
        TextClipTextAlign align, double expectedShortLeft, double expectedLongLeft)
    {
        // "ab" (20 px) ve "abcd" (40 px) → içerik genişliği 40.
        var layout = TextLayoutEngine.Layout(Request("ab\nabcd", align: align), new FakeMeasurer());

        Assert.Equal(40, layout.ContentWidthPx);
        Assert.Equal(expectedShortLeft, layout.Lines[0].LeftPx);
        Assert.Equal(expectedLongLeft, layout.Lines[1].LeftPx);
    }

    // ---------- Bbox: kontur, arka plan, mürekkep taşması ----------

    [Fact]
    public void Bbox_CoversInkOverflowAboveContentBox()
    {
        // Tek satır: içerik kutusu 0..12, mürekkep taban çizgisinin 7 px üstünde başlar → 9-7=2.
        var layout = TextLayoutEngine.Layout(Request("ab"), new FakeMeasurer());

        Assert.Equal(0, layout.BboxLeftPx);
        Assert.Equal(0, layout.BboxTopPx); // mürekkep (y=2) içerik kutusunun içinde
        Assert.Equal(20, layout.BboxWidthPx);
        Assert.Equal(12, layout.BboxHeightPx);
    }

    [Fact]
    public void Stroke_ExpandsBboxByHalfWidthOnEverySide()
    {
        var plain = TextLayoutEngine.Layout(Request("ab"), new FakeMeasurer());
        var stroked = TextLayoutEngine.Layout(Request("ab", strokeWidth: 6), new FakeMeasurer());

        // Kontur glif konturunun ORTASINDADIR → dışa taşan pay yarısıdır (3 px).
        Assert.Equal(-3, stroked.BboxLeftPx);
        Assert.Equal(3, stroked.OriginXPx);
        Assert.Equal(plain.BboxWidthPx + 6, stroked.BboxWidthPx);
        // Mürekkep kutusu (2..10) 3 px büyüyünce -1..13 → içerik kutusu 0..12 ile birleşince -1..13.
        Assert.Equal(-1, stroked.BboxTopPx);
        Assert.Equal(14, stroked.BboxHeightPx);
    }

    [Fact]
    public void Background_ExpandsBboxByPaddingAroundContentBox()
    {
        var layout = TextLayoutEngine.Layout(Request("ab", backgroundPadding: 5), new FakeMeasurer());

        Assert.Equal(-5, layout.BboxLeftPx);
        Assert.Equal(-5, layout.BboxTopPx);
        Assert.Equal(30, layout.BboxWidthPx);  // 20 + 2*5
        Assert.Equal(22, layout.BboxHeightPx); // 12 + 2*5
        Assert.Equal(5, layout.OriginXPx);
        Assert.Equal(5, layout.OriginYPx);
    }

    [Fact]
    public void StrokeAndBackground_TakeTheLargerExtentNotTheSum()
    {
        // Arka plan payı 5, kontur yarısı 3 → dış sınır 5 (toplama YOK).
        var layout = TextLayoutEngine.Layout(
            Request("ab", strokeWidth: 6, backgroundPadding: 5), new FakeMeasurer());

        Assert.Equal(-5, layout.BboxLeftPx);
        Assert.Equal(30, layout.BboxWidthPx);
    }

    [Fact]
    public void Bbox_IsRoundedOutwardToWholePixels()
    {
        // 7.5 px'lik font + 1.1 satır yüksekliği → kesirli kutu; bbox DIŞA yuvarlanır.
        var layout = TextLayoutEngine.Layout(
            Request("abc", fontSize: 7.5, lineHeight: 1.1), new FakeMeasurer { InkAscent = 6.4, InkDescent = 1.3 });

        Assert.Equal(Math.Floor(layout.BboxLeftPx), layout.BboxLeftPx);
        Assert.Equal(Math.Floor(layout.BboxTopPx), layout.BboxTopPx);
        Assert.Equal(Math.Ceiling(layout.BboxWidthPx), layout.BboxWidthPx);
        Assert.Equal(Math.Ceiling(layout.BboxHeightPx), layout.BboxHeightPx);
        Assert.True(layout.BboxHeightPx >= layout.ContentHeightPx);
    }

    [Fact]
    public void WhitespaceOnlyLine_KeepsContentBoxWithoutInk()
    {
        var layout = TextLayoutEngine.Layout(Request("   "), new FakeMeasurer());

        Assert.Equal(30, layout.ContentWidthPx);
        Assert.Equal(30, layout.BboxWidthPx); // mürekkep yok ama yerleşim kutusu korunur
        Assert.Equal(12, layout.BboxHeightPx);
    }

    // ---------- Eksik glif ----------

    [Fact]
    public void MissingGlyphs_AreReportedNotSwallowed()
    {
        var measurer = new FakeMeasurer { MissingChars = "😀" };

        Assert.True(TextLayoutEngine.Layout(Request("hi 😀"), measurer).HasMissingGlyphs);
        Assert.False(TextLayoutEngine.Layout(Request("hi"), measurer).HasMissingGlyphs);
    }

    // ---------- Yumuşak satır kırma (şemada genişlik alanı yok; motor hazır) ----------

    [Fact]
    public void Wrap_BreaksOnWordBoundaries()
    {
        var layout = TextLayoutEngine.Layout(
            Request("aa bb cc dd", maxWidth: 55), new FakeMeasurer());

        Assert.Equal(["aa bb", "cc dd"], layout.Lines.Select(l => l.Text));
    }

    [Fact]
    public void Wrap_BreaksOverlongWordByCharacter()
    {
        var layout = TextLayoutEngine.Layout(
            Request("aaaaaaa", maxWidth: 30), new FakeMeasurer());

        Assert.Equal(["aaa", "aaa", "a"], layout.Lines.Select(l => l.Text));
    }

    [Fact]
    public void Wrap_DoesNotLoopForeverOnSingleWideCharacter()
    {
        // Tek karakter bile sığmıyor: en az bir karakter ilerlemeli, satır başına bir karakter.
        var layout = TextLayoutEngine.Layout(Request("abc", maxWidth: 4), new FakeMeasurer());

        Assert.Equal(["a", "b", "c"], layout.Lines.Select(l => l.Text));
    }

    [Fact]
    public void Wrap_IsAppliedPerHardLine()
    {
        var layout = TextLayoutEngine.Layout(
            Request("aa bb\ncc dd ee", maxWidth: 55), new FakeMeasurer());

        Assert.Equal(["aa bb", "cc dd", "ee"], layout.Lines.Select(l => l.Text));
    }
}
