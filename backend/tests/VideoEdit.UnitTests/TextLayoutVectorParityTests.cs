using System.Text.Json;
using System.Text.Json.Serialization;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// CROSS-LANGUAGE metin yerleşim parity'si (C# yarısı) — M4 dalga-2 denetimi bulgu #2.
/// <para>
/// <c>packages/timeline-schema/test-vectors/text-layout-vectors.json</c> dosyasını okur;
/// AYNI dosyayı <c>apps/editor/src/features/text/textLayoutVectors.test.ts</c> de okur.
/// Vektörler SENTETİK bir fontla sürülür, yani kilitlenen şey font metrikleri değil
/// YERLEŞİM KURALIDIR: bbox birleşimi, arka plan dikdörtgeni (içerik ± pay), boş metin
/// asgari genişliği ve taban çizgisi matematiği.
/// </para>
/// <para>
/// Desen easing/time vektörleriyle aynıdır (<see cref="TestVectorFiles"/>): bir tarafta kural
/// değişirse ÖTEKİ DİLİN testi kırmızıya döner — iki listenin sessizce ayrışması imkânsız.
/// </para>
/// </summary>
public class TextLayoutVectorParityTests
{
    private static readonly VectorFile Vectors = Load();

    private static VectorFile Load()
    {
        var path = TestVectorFiles.Resolve(
            "packages/timeline-schema/test-vectors/text-layout-vectors.json");
        var options = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
        };
        return JsonSerializer.Deserialize<VectorFile>(File.ReadAllText(path), options)
            ?? throw new InvalidOperationException($"Could not parse {path}");
    }

    [Fact]
    public void VectorFile_HasExpectedShape()
    {
        // Dosya sessizce budanırsa parity kanıtı çöker (easing vektörlerindeki aynı gardiyan).
        Assert.Equal(1, Vectors.VectorVersion);
        Assert.Equal(10, Vectors.Cases.Count);
        Assert.Equal(1e-9, Vectors.Tolerance, 15);
    }

    [Fact]
    public void EmptyTextMinWidthRatio_MatchesTheEngineConstant()
    {
        // Sabit SÖZLEŞMEDİR: iki dilde de aynı sayı olmak zorunda.
        Assert.Equal(TextLayoutEngine.EmptyTextMinWidthRatio, Vectors.EmptyTextMinWidthRatio, 12);
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in Vectors.Cases)
        {
            data.Add(c.Name);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Layout_MatchesCrossLanguageVectors(string name)
    {
        var c = Vectors.Cases.Single(x => x.Name == name);
        var tol = Vectors.Tolerance;
        var layout = TextLayoutEngine.Layout(RequestOf(c), new VectorMeasurer(Vectors.Font, c.Style.FontSizePx));
        var e = c.Expected;

        Close(e.LineHeightPx, layout.LineHeightPx, tol, $"{name}/lineHeightPx");
        Close(e.ContentWidthPx, layout.ContentWidthPx, tol, $"{name}/contentWidthPx");
        Close(e.ContentHeightPx, layout.ContentHeightPx, tol, $"{name}/contentHeightPx");
        Close(e.BboxLeftPx, layout.BboxLeftPx, tol, $"{name}/bboxLeftPx");
        Close(e.BboxTopPx, layout.BboxTopPx, tol, $"{name}/bboxTopPx");
        Close(e.BboxWidthPx, layout.BboxWidthPx, tol, $"{name}/bboxWidthPx");
        Close(e.BboxHeightPx, layout.BboxHeightPx, tol, $"{name}/bboxHeightPx");
        Close(e.OriginXPx, layout.OriginXPx, tol, $"{name}/originXPx");
        Close(e.OriginYPx, layout.OriginYPx, tol, $"{name}/originYPx");

        if (e.BackgroundRect is null)
        {
            Assert.Null(layout.BackgroundRect);
        }
        else
        {
            Assert.NotNull(layout.BackgroundRect);
            var actual = layout.BackgroundRect!.Value;
            Close(e.BackgroundRect.Left, actual.Left, tol, $"{name}/backgroundRect.left");
            Close(e.BackgroundRect.Top, actual.Top, tol, $"{name}/backgroundRect.top");
            Close(e.BackgroundRect.Right, actual.Right, tol, $"{name}/backgroundRect.right");
            Close(e.BackgroundRect.Bottom, actual.Bottom, tol, $"{name}/backgroundRect.bottom");
        }

        Assert.Equal(e.Lines.Count, layout.Lines.Count);
        for (var i = 0; i < e.Lines.Count; i++)
        {
            var expected = e.Lines[i];
            var line = layout.Lines[i];
            Assert.Equal(expected.Index, line.Index);
            Assert.Equal(expected.Text, line.Text);
            Close(expected.AdvanceWidthPx, line.AdvanceWidthPx, tol, $"{name}/line{i}.advance");
            Close(expected.LeftPx, line.LeftPx, tol, $"{name}/line{i}.left");
            Close(expected.BaselineYPx, line.BaselineYPx, tol, $"{name}/line{i}.baseline");
        }
    }

    private static void Close(double expected, double actual, double tolerance, string what) =>
        Assert.True(
            Math.Abs(expected - actual) <= tolerance,
            $"{what}: expected {expected:R}, got {actual:R} (diff {Math.Abs(expected - actual):E3} > {tolerance:E1})");

    private static TextLayoutRequest RequestOf(VectorCase c) => new()
    {
        Content = c.Style.Content,
        FontSizePx = c.Style.FontSizePx,
        LineHeight = c.Style.LineHeight,
        Align = c.Style.Align switch
        {
            "center" => TextClipTextAlign.Center,
            "right" => TextClipTextAlign.Right,
            "left" => TextClipTextAlign.Left,
            _ => throw new InvalidOperationException($"Bilinmeyen hizalama: {c.Style.Align}"),
        },
        StrokeWidthPx = c.Style.StrokeWidthPx,
        BackgroundPaddingPx = c.Style.BackgroundPaddingPx,
        MaxWidthPx = null,
    };

    /// <summary>
    /// Vektör dosyasının tarif ettiği SENTETİK font — TS testindeki
    /// <c>syntheticMeasurer</c> ile BİREBİR aynı kurallar (dosyanın "//" bloğu).
    /// </summary>
    private sealed class VectorMeasurer(SyntheticFont font, double fontSizePx) : IGlyphMeasurer
    {
        private readonly double cell = fontSizePx * font.AdvanceRatio;
        private readonly double bearing = fontSizePx * font.InkSideBearingRatio;

        public FontVerticalMetrics Metrics { get; } =
            new(fontSizePx * font.AscentRatio, fontSizePx * font.DescentRatio);

        public double MeasureAdvance(string line) => line.Length * cell;

        public InkBox MeasureInk(string line)
        {
            var first = -1;
            var last = -1;
            for (var i = 0; i < line.Length; i++)
            {
                if (line[i] == ' ')
                {
                    continue;
                }

                if (first < 0)
                {
                    first = i;
                }

                last = i;
            }

            if (first < 0)
            {
                return InkBox.Empty;
            }

            return new InkBox(
                (first * cell) + bearing,
                -fontSizePx * font.InkAscentRatio,
                ((last + 1) * cell) - bearing,
                fontSizePx * font.InkDescentRatio);
        }

        public bool ContainsAllGlyphs(string text) => true;
    }

    // ---------- Dosya modeli ----------

    private sealed record VectorFile(
        int VectorVersion,
        double Tolerance,
        double EmptyTextMinWidthRatio,
        SyntheticFont Font,
        List<VectorCase> Cases);

    private sealed record SyntheticFont(
        double AscentRatio,
        double DescentRatio,
        double AdvanceRatio,
        double InkAscentRatio,
        double InkDescentRatio,
        double InkSideBearingRatio);

    private sealed record VectorCase(string Name, string Why, VectorStyle Style, VectorExpected Expected);

    private sealed record VectorStyle(
        string Content,
        double FontSizePx,
        double LineHeight,
        string Align,
        double StrokeWidthPx,
        double? BackgroundPaddingPx);

    private sealed record VectorExpected(
        double LineHeightPx,
        double ContentWidthPx,
        double ContentHeightPx,
        double BboxLeftPx,
        double BboxTopPx,
        double BboxWidthPx,
        double BboxHeightPx,
        double OriginXPx,
        double OriginYPx,
        VectorRect? BackgroundRect,
        List<VectorLine> Lines);

    private sealed record VectorRect(double Left, double Top, double Right, double Bottom);

    private sealed record VectorLine(int Index, string Text, double AdvanceWidthPx, double LeftPx, double BaselineYPx);
}
