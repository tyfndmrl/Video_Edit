using VideoEdit.Contracts.Timeline;

namespace VideoEdit.Media.Text;

/// <summary>
/// Dikey font metrikleri — SKIA UZLAŞIMI: <see cref="Ascent"/> NEGATİFTİR (taban çizgisinin
/// üstü), <see cref="Descent"/> pozitiftir.
/// </summary>
public readonly record struct FontVerticalMetrics(double Ascent, double Descent)
{
    /// <summary>Font kutusu yüksekliği (descent - ascent).</summary>
    public double BoxHeight => Descent - Ascent;
}

/// <summary>
/// Layout'un ölçüm bağımlılığı. Skia'dan AYRIŞTIRILMIŞTIR: satır kırma / hizalama / bbox
/// matematiği font dosyası olmadan da birim testlenebilsin diye (fontlar depoya girmez —
/// fonts/README.md). Üretimde tek gerçeklemesi <c>SkiaGlyphMeasurer</c>'dır.
/// </summary>
public interface IGlyphMeasurer
{
    FontVerticalMetrics Metrics { get; }

    /// <summary>Satırın ilerleme (advance) genişliği — CSS'in satır genişliği ile aynı kavram.</summary>
    double MeasureAdvance(string line);

    /// <summary>
    /// Satırın SIKI mürekkep sınırları; kalem (0, taban çizgisi) noktasına GÖRECELİ.
    /// Boş/görünmez satırda <see cref="InkBox.Empty"/> döner.
    /// </summary>
    InkBox MeasureInk(string line);

    /// <summary>Metindeki her kod noktası fontta var mı (yoksa .notdef kutusu çizilir).</summary>
    bool ContainsAllGlyphs(string text);
}

/// <summary>Eksen hizalı kutu (px). <see cref="IsEmpty"/> kutular birleşime katılmaz.</summary>
public readonly record struct InkBox(double Left, double Top, double Right, double Bottom)
{
    public static InkBox Empty => new(0, 0, 0, 0);

    public bool IsEmpty => Right <= Left || Bottom <= Top;

    public InkBox Translate(double dx, double dy) => new(Left + dx, Top + dy, Right + dx, Bottom + dy);

    public InkBox Inflate(double amount) =>
        amount == 0 ? this : new(Left - amount, Top - amount, Right + amount, Bottom + amount);

    public InkBox Union(InkBox other)
    {
        if (other.IsEmpty)
        {
            return this;
        }

        return IsEmpty
            ? other
            : new(Math.Min(Left, other.Left), Math.Min(Top, other.Top),
                  Math.Max(Right, other.Right), Math.Max(Bottom, other.Bottom));
    }
}

/// <summary>
/// Yerleşmiş tek satır. <c>LeftPx</c> satırın içerik kutusundaki sol kenarı (hizalamadan doğar);
/// <c>BaselineYPx</c> taban çizgisinin içerik kutusu ÜST kenarına olan uzaklığıdır.
/// </summary>
public sealed record LaidOutLine(
    int Index,
    string Text,
    double AdvanceWidthPx,
    double LeftPx,
    double BaselineYPx);

/// <summary>
/// Layout sonucu. Tüm ölçüler PROJE ÇIKTI PİKSELİNDEDİR (raster çarpanı UYGULANMAMIŞ).
/// İçerik kutusunun sol-üstü (0,0)'dır; bbox kontur/arka plan/mürekkep taşmasıyla NEGATİF
/// koordinata uzayabilir — <see cref="OriginXPx"/>/<see cref="OriginYPx"/> içerik kutusunun
/// PNG içindeki yerini verir.
/// </summary>
public sealed record TextLayout(
    IReadOnlyList<LaidOutLine> Lines,
    double LineHeightPx,
    double ContentWidthPx,
    double ContentHeightPx,
    double BboxLeftPx,
    double BboxTopPx,
    double BboxWidthPx,
    double BboxHeightPx,
    bool HasMissingGlyphs,
    InkBox? BackgroundRect = null)
{
    public double OriginXPx => -BboxLeftPx;

    public double OriginYPx => -BboxTopPx;
}

/// <summary>Layout girdisi — şema alanlarının Skia'dan bağımsız kopyası.</summary>
public sealed record TextLayoutRequest
{
    public required string Content { get; init; }

    public required double FontSizePx { get; init; }

    public required double LineHeight { get; init; }

    public required TextClipTextAlign Align { get; init; }

    /// <summary>Kontur GENİŞLİĞİ (glif konturunun ORTASINDA; dışa taşan pay yarısıdır).</summary>
    public double StrokeWidthPx { get; init; }

    /// <summary>Arka plan varsa dolgu payı; yoksa null (kutu üretilmez).</summary>
    public double? BackgroundPaddingPx { get; init; }

    /// <summary>
    /// Yumuşak satır kırma genişliği. Şemada TextClip'in genişlik alanı YOKTUR → export
    /// hattı null verir (yalnız açık <c>\n</c> satır üretir). Alan eklenirse hazır.
    /// </summary>
    public double? MaxWidthPx { get; init; }
}

/// <summary>
/// Metin yerleşimi — rendering-semantics §7'nin "layout'un tek doğruluk kaynağı" tarafı.
/// SAF: dosya/Skia yüzeyi yok, yalnız <see cref="IGlyphMeasurer"/>.
/// <para>
/// Dikey model CSS <c>line-height</c> ile AYNIDIR (preview↔export parity'sinin şartı):
/// <code>
/// lineHeightPx = fontSizePx * lineHeight
/// halfLeading  = (lineHeightPx - (descent - ascent)) / 2
/// baseline(0)  = halfLeading - ascent
/// baseline(i)  = baseline(0) + i * lineHeightPx
/// contentH     = lineHeightPx * satırSayısı
/// </code>
/// Yatayda satır genişliği ADVANCE'tır (mürekkep değil) — hizalama CSS ile aynı sonucu verir.
/// </para>
/// </summary>
public static class TextLayoutEngine
{
    /// <summary>
    /// ÖLÇÜMÜ SIFIR olan metnin asgari içerik genişliği (fontSizePx'in katı). Boş metin de
    /// tutulabilir bir kutu taşımalıdır; aksi halde gizmo kutusu yok olur ve kullanıcı yeni
    /// eklediği metni seçemez.
    /// <para>
    /// AYNI SABİT İSTEMCİDE DE VARDIR: <c>EMPTY_TEXT_MIN_WIDTH_RATIO</c>
    /// (apps/editor/src/features/text/textLayout.ts). İkisini
    /// <c>packages/timeline-schema/test-vectors/text-layout-vectors.json</c> kilitler —
    /// biri değişirse ÖTEKİ DİLİN testi kırmızıya döner (M4 dalga-2 denetimi, bulgu #2).
    /// </para>
    /// Kural YALNIZ ölçüm 0 iken uygulanır: gerçekten dar bir satır ("I") dar kalmalıdır.
    /// </summary>
    public const double EmptyTextMinWidthRatio = 0.5;

    /// <summary>Boş içerik bile TEK satır üretir: yükseklik korunur, kutu kaybolmaz.</summary>
    public static TextLayout Layout(TextLayoutRequest request, IGlyphMeasurer measurer)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(measurer);

        var rawLines = SplitLines(request.Content);
        var lines = request.MaxWidthPx is { } maxWidth and > 0
            ? rawLines.SelectMany(l => WrapLine(l, maxWidth, measurer)).ToList()
            : rawLines;
        if (lines.Count == 0)
        {
            lines = [string.Empty];
        }

        var lineHeightPx = request.FontSizePx * request.LineHeight;
        var metrics = measurer.Metrics;
        var halfLeading = (lineHeightPx - metrics.BoxHeight) / 2d;
        var firstBaseline = halfLeading - metrics.Ascent;

        var advances = lines.Select(measurer.MeasureAdvance).ToList();
        var measured = advances.Count == 0 ? 0d : advances.Max();
        // Asgari genişlik kuralı — İSTEMCİYLE AYNI (bkz. EmptyTextMinWidthRatio). Yalnız
        // ölçüm 0 iken devreye girer; " " gibi advance üreten metinlerde girmez.
        var contentWidth = measured > 0d ? measured : request.FontSizePx * EmptyTextMinWidthRatio;
        var contentHeight = lineHeightPx * lines.Count;

        var laidOut = new List<LaidOutLine>(lines.Count);
        var ink = InkBox.Empty;
        var strokeHalf = Math.Max(0d, request.StrokeWidthPx) / 2d;
        for (var i = 0; i < lines.Count; i++)
        {
            var left = request.Align switch
            {
                TextClipTextAlign.Center => (contentWidth - advances[i]) / 2d,
                TextClipTextAlign.Right => contentWidth - advances[i],
                _ => 0d,
            };
            var baseline = firstBaseline + (i * lineHeightPx);
            laidOut.Add(new LaidOutLine(i, lines[i], advances[i], left, baseline));

            var lineInk = measurer.MeasureInk(lines[i]);
            if (!lineInk.IsEmpty)
            {
                ink = ink.Union(lineInk.Translate(left, baseline).Inflate(strokeHalf));
            }
        }

        // Kutu birleşimi: içerik kutusu DAİMA içeridedir (yalnız boşluktan oluşan metinde bile
        // yerleşim kutusu korunur), üstüne mürekkep+kontur taşması ve arka plan kutusu eklenir.
        var content = new InkBox(0, 0, Math.Max(contentWidth, 0), Math.Max(contentHeight, 0));
        var box = content.Union(ink);

        // ARKA PLAN DİKDÖRTGENİ = İÇERİK ± PAY (bbox DEĞİL). Burada üretilir ki çizim tarafı
        // (SkiaOverlayRasterService) ve istemci aynı kutuyu kullansın — denetim bulgusu #2'nin
        // ikinci yarısı tam olarak buydu: istemci arka planı TÜM bbox'a boyuyordu.
        InkBox? backgroundRect = null;
        if (request.BackgroundPaddingPx is { } padding)
        {
            backgroundRect = content.Inflate(Math.Max(0d, padding));
            box = box.Union(backgroundRect.Value);
        }

        // Dışa doğru tamsayıya: kırpılma olmasın (yarım piksel mürekkep kesilmesin).
        var left0 = Math.Floor(box.Left);
        var top0 = Math.Floor(box.Top);
        var width = Math.Max(1d, Math.Ceiling(box.Right) - left0);
        var height = Math.Max(1d, Math.Ceiling(box.Bottom) - top0);

        return new TextLayout(
            laidOut,
            lineHeightPx,
            contentWidth,
            contentHeight,
            left0,
            top0,
            width,
            height,
            !measurer.ContainsAllGlyphs(request.Content),
            backgroundRect);
    }

    /// <summary>
    /// Satır ayrımı: CRLF/CR normalize edilir, yalnız AÇIK <c>\n</c> satır üretir.
    /// Boş içerik tek boş satırdır (yükseklik korunur).
    /// </summary>
    internal static List<string> SplitLines(string content)
    {
        if (string.IsNullOrEmpty(content))
        {
            return [string.Empty];
        }

        return content.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Split('\n')
            .ToList();
    }

    /// <summary>
    /// Açgözlü kelime kırma (boşluk sınırında). Tek başına sığmayan kelime KARAKTER bazında
    /// bölünür — sonsuz döngü yok, en az bir karakter her zaman ilerler.
    /// </summary>
    internal static List<string> WrapLine(string line, double maxWidthPx, IGlyphMeasurer measurer)
    {
        if (line.Length == 0 || measurer.MeasureAdvance(line) <= maxWidthPx)
        {
            return [line];
        }

        var result = new List<string>();
        var current = string.Empty; // kabul edilmiş kelimeler + aralarındaki boşluklar
        foreach (var word in SplitKeepingSpaces(line))
        {
            var pending = word;

            // Kelime sınırında kırma. ÖLÇÜM DAİMA TrimEnd'lidir: satır sonundaki boşluk
            // görünmez, onu taşma saymak satırı erken kırar ve sonraki satırı boşlukla
            // başlatırdı (" ee" hatası — bu davranış testle sabitlenmiştir).
            if (current.Length > 0 && measurer.MeasureAdvance((current + pending).TrimEnd()) > maxWidthPx)
            {
                result.Add(current.TrimEnd());
                current = string.Empty;
                pending = pending.TrimStart();
            }

            // Tek başına sığmayan kelime: karakter bazında bölünür. Her tur en az bir karakter
            // tükettiği için (LongestPrefixThatFits >= 1) döngü sonludur.
            while (true)
            {
                var combined = current + pending;
                var visible = combined.TrimEnd();
                if (visible.Length <= 1 || measurer.MeasureAdvance(visible) <= maxWidthPx)
                {
                    break;
                }

                var cut = LongestPrefixThatFits(combined, maxWidthPx, measurer);
                if (cut >= visible.Length)
                {
                    break;
                }

                result.Add(combined[..cut]);
                current = string.Empty;
                pending = combined[cut..];
            }

            current += pending;
        }

        result.Add(current.TrimEnd());
        return result;
    }

    private static int LongestPrefixThatFits(string text, double maxWidthPx, IGlyphMeasurer measurer)
    {
        var cut = 1;
        while (cut < text.Length && measurer.MeasureAdvance(text[..(cut + 1)]) <= maxWidthPx)
        {
            cut++;
        }

        return cut;
    }

    /// <summary>"a bc  d" → ["a ", "bc  ", "d"] (boşluklar kendinden ÖNCEKİ kelimeye yapışır).</summary>
    private static List<string> SplitKeepingSpaces(string line)
    {
        var parts = new List<string>();
        var index = 0;
        while (index < line.Length)
        {
            var wordEnd = index;
            while (wordEnd < line.Length && line[wordEnd] != ' ')
            {
                wordEnd++;
            }

            var spaceEnd = wordEnd;
            while (spaceEnd < line.Length && line[spaceEnd] == ' ')
            {
                spaceEnd++;
            }

            parts.Add(line[index..spaceEnd]);
            index = spaceEnd == index ? index + 1 : spaceEnd;
        }

        return parts;
    }
}
