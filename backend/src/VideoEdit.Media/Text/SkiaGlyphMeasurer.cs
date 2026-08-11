using System.Globalization;
using System.Text;
using SkiaSharp;
using SkiaSharp.HarfBuzz;

namespace VideoEdit.Media.Text;

/// <summary>
/// <see cref="IGlyphMeasurer"/>'ın SkiaSharp + HarfBuzz gerçeklemesi — rendering-semantics §7'nin
/// "shaping (HarfBuzz), emoji, RTL hepsi sunucuda ölçülür" maddesi.
/// <para>
/// ÖLÇÜM VE ÇİZİM AYNI SHAPING SONUCUNU KULLANIR (<see cref="Shape"/>): "ölçerken shaping yok,
/// çizerken var" ikiliği kerning kadar bbox kayması üretirdi. Bu sınıf shaping sonucunu
/// cache'ler, <c>SkiaOverlayRasterService</c> çizimde aynı cache'ten okur.
/// </para>
/// <para>
/// BELİRLENİMCİLİK: hinting KAPALI (<see cref="SKFontHinting.None"/>) — hinting ızgara
/// hizalaması yaptığı için metrikleri raster boyutuna bağlar; kapalıyken ölçüler yalnız TTF
/// dosyasından türer, yani @2x raster ile @1x ölçüm birebir ölçeklenir.
/// </para>
/// </summary>
internal sealed class SkiaGlyphMeasurer : IGlyphMeasurer, IDisposable
{
    /// <summary>Sentetik oblik eğimi (italik dosyası olmayan ailede) — Skia'nın uzlaşımı.</summary>
    public const float SyntheticItalicSkewX = -0.25f;

    private readonly SKShaper shaper;
    private readonly Dictionary<string, SKShaper.Result> shapeCache = new(StringComparer.Ordinal);
    private bool disposed;

    public SkiaGlyphMeasurer(SKTypeface typeface, float fontSizePx, bool syntheticItalic)
    {
        Typeface = typeface;
        Font = new SKFont(typeface, fontSizePx)
        {
            Hinting = SKFontHinting.None,
            Edging = SKFontEdging.Antialias,
            Subpixel = true,
            SkewX = syntheticItalic ? SyntheticItalicSkewX : 0f,
        };

        shaper = new SKShaper(typeface);
        var metrics = Font.Metrics;
        Metrics = new FontVerticalMetrics(metrics.Ascent, metrics.Descent);
    }

    public SKTypeface Typeface { get; }

    public SKFont Font { get; }

    public FontVerticalMetrics Metrics { get; }

    public double MeasureAdvance(string line) => line.Length == 0 ? 0d : Shape(line).Width;

    public InkBox MeasureInk(string line)
    {
        if (line.Length == 0)
        {
            return InkBox.Empty;
        }

        var shaped = Shape(line);
        if (shaped.Codepoints.Length == 0)
        {
            return InkBox.Empty;
        }

        // Glif kutuları shaped KONUMLARA taşınır: ölçüm ile çizim aynı yerleşimi kullanır.
        var glyphs = new ushort[shaped.Codepoints.Length];
        for (var i = 0; i < glyphs.Length; i++)
        {
            glyphs[i] = (ushort)shaped.Codepoints[i];
        }

        var bounds = new SKRect[glyphs.Length];
        Font.GetGlyphWidths(glyphs, new float[glyphs.Length], bounds);

        var box = InkBox.Empty;
        for (var i = 0; i < glyphs.Length; i++)
        {
            var b = bounds[i];
            if (b.Width <= 0 || b.Height <= 0)
            {
                continue; // boşluk gibi mürekkepsiz glifler
            }

            var point = shaped.Points[i];
            box = box.Union(new InkBox(
                b.Left + point.X, b.Top + point.Y, b.Right + point.X, b.Bottom + point.Y));
        }

        return box;
    }

    /// <summary>
    /// Metnin TÜM kod noktaları fontta var mı. Yoksa .notdef ("tofu") kutusu çizilir —
    /// sessiz kalmak yerine sonuç <c>HasMissingGlyphs</c> ile işaretlenir (emoji tipik durum:
    /// küratörlü set emoji fontu içermez ve sistem fallback'i belirlenimcilik gereği KAPALIDIR).
    /// </summary>
    public bool ContainsAllGlyphs(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return true;
        }

        var enumerator = StringInfo.GetTextElementEnumerator(text);
        while (enumerator.MoveNext())
        {
            var element = (string)enumerator.Current;
            foreach (var rune in element.EnumerateRunes())
            {
                if (rune.Value is '\n' or '\r' or '\t' || Rune.IsWhiteSpace(rune))
                {
                    continue;
                }

                if (Typeface.GetGlyph(rune.Value) == 0)
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>Shaping sonucunu (glif kimlikleri + konumlar + toplam advance) cache'ler.</summary>
    public SKShaper.Result Shape(string line)
    {
        if (shapeCache.TryGetValue(line, out var cached))
        {
            return cached;
        }

        var result = shaper.Shape(line, Font);
        shapeCache[line] = result;
        return result;
    }

    /// <summary>
    /// Ölçümde kullanılan glif kimlikleri + konumlarından çizim bloğu üretir. Çizim ile ölçüm
    /// AYNI diziyi kullanır — "shaped çiz, shaped'siz ölç" kayması imkânsızdır.
    /// Boş/glifsiz satırda null döner.
    /// </summary>
    public SKTextBlob? BuildBlob(string line)
    {
        if (line.Length == 0)
        {
            return null;
        }

        var shaped = Shape(line);
        if (shaped.Codepoints.Length == 0)
        {
            return null;
        }

        using var builder = new SKTextBlobBuilder();
        var run = builder.AllocatePositionedRun(Font, shaped.Codepoints.Length);
        var glyphs = run.Glyphs;
        var positions = run.Positions;
        for (var i = 0; i < shaped.Codepoints.Length; i++)
        {
            glyphs[i] = (ushort)shaped.Codepoints[i];
            positions[i] = shaped.Points[i];
        }

        return builder.Build();
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        shaper.Dispose();
        Font.Dispose();
    }
}
