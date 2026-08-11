using System.Text.Json;
using SkiaSharp;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// Layout matematiğini FONT DOSYASI OLMADAN test etmek için deterministik ölçüm sahtesi:
/// her karakter <see cref="CharWidth"/> geniştir, mürekkep kutusu taban çizgisinin
/// üstünde <c>InkAscent</c>, altında <c>InkDescent</c> kadar uzanır. Boşluklar mürekkepsizdir.
/// </summary>
internal sealed class FakeMeasurer(
    double charWidth = 10d, double ascent = -8d, double descent = 2d) : IGlyphMeasurer
{
    public double CharWidth { get; } = charWidth;

    /// <summary>Mürekkebin taban çizgisi üstündeki payı (pozitif sayı).</summary>
    public double InkAscent { get; init; } = 7d;

    /// <summary>Mürekkebin taban çizgisi altındaki payı.</summary>
    public double InkDescent { get; init; } = 1d;

    /// <summary>Bu kümedeki karakterler fontta YOK sayılır (eksik glif testleri).</summary>
    public string MissingChars { get; init; } = string.Empty;

    public FontVerticalMetrics Metrics { get; } = new(ascent, descent);

    public double MeasureAdvance(string line) => line.Length * CharWidth;

    public InkBox MeasureInk(string line)
    {
        var trimmed = line.Trim();
        if (trimmed.Length == 0)
        {
            return InkBox.Empty;
        }

        // Baştaki boşluklar mürekkepsiz: kutu ilk görünür karakterde başlar.
        var leading = line.Length - line.TrimStart().Length;
        var trailing = line.Length - line.TrimEnd().Length;
        return new InkBox(
            leading * CharWidth,
            -InkAscent,
            (line.Length - trailing) * CharWidth,
            InkDescent);
    }

    public bool ContainsAllGlyphs(string text) =>
        MissingChars.Length == 0 || !text.Any(MissingChars.Contains);
}

/// <summary>
/// Gerçek glif rasteri gerektiren testler için font kaynağı.
/// <list type="number">
///   <item>Depodaki küratörlü set kuruluysa (fonts/fetch-fonts) O kullanılır — tercih edilen yol;</item>
///   <item>değilse SİSTEM fontlarından biri, GEÇİCİ dizine yazılan TEST-ONLY manifest üzerinden
///     MUTLAK yolla gösterilir. Sistem fontu depoya KOPYALANMAZ (fonts/README.md kuralı) ve
///     bu manifest üretim manifesti değildir;</item>
///   <item>hiçbiri yoksa testler <see cref="FontFactAttribute"/> ile atlanır.</item>
/// </list>
/// Sistem fontuyla koşulan testler yalnız DEĞİŞMEZLERİ doğrular (belirlenimcilik, satır sayısı,
/// hizalama ilişkileri, bbox büyüme yönü) — piksel golden'ı YOKTUR, çünkü sistem fontu
/// makineden makineye değişir.
/// </summary>
internal static class TestFonts
{
    /// <summary>Testlerde kullanılan fontId (üretim manifestinde de vardır).</summary>
    public const string FontId = "roboto";

    private static readonly Lazy<FontManifest?> Curated = new(LoadCurated);
    private static readonly Lazy<FontManifest?> Fallback = new(LoadSystemFallback);

    /// <summary>Küratörlü set kurulu mu (golden'a izin veren tek durum).</summary>
    public static bool CuratedAvailable => Curated.Value is not null;

    public static bool Available => Manifest is not null;

    public static FontManifest? Manifest => Curated.Value ?? Fallback.Value;

    public static string Describe() => Curated.Value is not null
        ? $"küratörlü set ({Curated.Value.SourcePath})"
        : Fallback.Value is not null
            ? $"sistem fontu ({Fallback.Value.Fonts[FontId].Files["400"]})"
            : "(font yok)";

    public static SkiaOverlayRasterService CreateService(TextRasterOptions? options = null) =>
        new(options ?? new TextRasterOptions(),
            Manifest ?? throw new InvalidOperationException(
                "Font kaynağı yok — FontFactAttribute bu testi atlamalıydı."));

    private static FontManifest? LoadCurated()
    {
        var manifestPath = Path.Combine(
            TestVectorFiles.Resolve("fonts"), TextRasterOptions.ManifestFileName);
        if (!File.Exists(manifestPath))
        {
            return null;
        }

        try
        {
            var manifest = FontManifest.Load(manifestPath);
            // Dosyalar gerçekten indirilmiş mi? (manifest depoda, TTF'ler değil.)
            manifest.Resolve(FontId, 400, italic: false);
            return manifest;
        }
        catch (OverlayRasterException)
        {
            return null;
        }
    }

    private static FontManifest? LoadSystemFallback()
    {
        string[] candidates =
        [
            @"C:\Windows\Fonts\arial.ttf",
            @"C:\Windows\Fonts\segoeui.ttf",
            @"C:\Windows\Fonts\calibri.ttf",
            @"C:\Windows\Fonts\verdana.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
        ];

        var found = candidates.FirstOrDefault(File.Exists);
        if (found is null)
        {
            return null;
        }

        // TEST-ONLY manifest: mutlak yol gösterir, hiçbir şey kopyalanmaz.
        var manifest = new FontManifest
        {
            ManifestVersion = 1,
            Fonts = new Dictionary<string, FontEntry>(StringComparer.Ordinal)
            {
                [FontId] = new FontEntry
                {
                    Family = "System Test Font",
                    Version = "test",
                    License = "system",
                    Files = new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["400"] = found,
                        ["700"] = found,
                    },
                },
            },
            SourcePath = "(test-only in-memory manifest)",
            RootDirectory = Path.GetTempPath(),
        };
        manifest.Validate();
        return manifest;
    }
}

/// <summary>
/// Gerçek font gerektiren testler: hiçbir font kaynağı yoksa ATLANIR.
/// <c>VIDEOEDIT_FONT_TESTS=1</c> ile atlama KAPATILIR — CI'da "sessizce atlandı" olmasın diye
/// (MINIO_AVAILABLE deseninin tersi: burada varsayılan atlamak, zorlama ise patlamaktır).
/// </summary>
public sealed class FontFactAttribute : FactAttribute
{
    public FontFactAttribute()
    {
        if (!TestFonts.Available && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("VIDEOEDIT_FONT_TESTS")))
        {
            Skip = "Hiçbir font kaynağı bulunamadı — fonts/fetch-fonts.ps1 çalıştırın "
                + "(ya da VIDEOEDIT_FONT_TESTS=1 ile atlamayı kapatıp hatayı görün).";
        }
    }
}

/// <summary>Yalnız KÜRATÖRLÜ set kuruluyken anlamlı olan testler (piksel golden'ları).</summary>
public sealed class CuratedFontFactAttribute : FactAttribute
{
    public CuratedFontFactAttribute()
    {
        if (!TestFonts.CuratedAvailable)
        {
            Skip = "Küratörlü font seti kurulu değil (fonts/fetch-fonts.ps1) — "
                + "metin golden'ları yalnız pinli fontlarla anlamlıdır.";
        }
    }
}

/// <summary>PNG karşılaştırma yardımcıları (golden testleri, alpha DAHİL).</summary>
internal static class RasterAssert
{
    /// <summary>Golden dizini — dosya yoksa üretilir (ExportSnapshots deseni).</summary>
    public static string GoldenDir { get; } = TestVectorFiles.Resolve("backend/tests/RasterGoldens");

    /// <summary>
    /// PNG'yi AÇIKÇA straight (unpremultiplied) hedefe çözer. <c>SKBitmap.Decode</c> varsayılanı
    /// premultiplied'dır ve okunan değerleri geri çarpar; §6.4 testleri dosyaya YAZILAN baytları
    /// görmek zorundadır.
    /// </summary>
    public static SKBitmap Decode(string path)
    {
        using var data = SKData.Create(path);
        using var codec = SKCodec.Create(data)
            ?? throw new InvalidOperationException($"PNG çözülemedi: {path}");

        var info = new SKImageInfo(
            codec.Info.Width, codec.Info.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul);
        var bitmap = new SKBitmap(info);
        var result = codec.GetPixels(info, bitmap.GetPixels());
        if (result is not (SKCodecResult.Success or SKCodecResult.IncompleteInput))
        {
            bitmap.Dispose();
            throw new InvalidOperationException($"PNG piksel çözümü başarısız ({result}): {path}");
        }

        return bitmap;
    }

    /// <summary>Kanal başına ortalama kare hata (RGBA, straight alpha).</summary>
    public static double Mse(SKBitmap a, SKBitmap b)
    {
        Assert.Equal(a.Width, b.Width);
        Assert.Equal(a.Height, b.Height);

        double sum = 0;
        for (var y = 0; y < a.Height; y++)
        {
            for (var x = 0; x < a.Width; x++)
            {
                var pa = a.GetPixel(x, y);
                var pb = b.GetPixel(x, y);
                sum += Sq(pa.Red - pb.Red) + Sq(pa.Green - pb.Green)
                    + Sq(pa.Blue - pb.Blue) + Sq(pa.Alpha - pb.Alpha);
            }
        }

        return sum / (a.Width * (double)a.Height * 4);
    }

    /// <summary>
    /// Golden karşılaştırması: dosya yoksa üretilir ve test geçer (ilk koşu), varsa MSE eşiği
    /// uygulanır. Şekil golden'ları TAŞINABİLİRDİR (font içermez).
    /// </summary>
    public static void MatchesGolden(string pngPath, string goldenName, double mseThreshold = 1.0)
    {
        Directory.CreateDirectory(GoldenDir);
        var goldenPath = Path.Combine(GoldenDir, goldenName);
        if (!File.Exists(goldenPath))
        {
            File.Copy(pngPath, goldenPath);
            return;
        }

        using var actual = Decode(pngPath);
        using var golden = Decode(goldenPath);
        var mse = Mse(actual, golden);
        Assert.True(mse <= mseThreshold,
            $"{goldenName}: golden'dan sapma MSE {mse:F3} > {mseThreshold} ({pngPath})");
    }

    private static double Sq(int v) => (double)v * v;
}

/// <summary>Test dokümanları: metin/şekil klipleri ve proje ayarları.</summary>
internal static class OverlayTestDocs
{
    public static ProjectSettings Settings(int width = 1920, int height = 1080) => new()
    {
        Width = width,
        Height = height,
        Fps = new Rational { Num = 30, Den = 1 },
        AudioSampleRate = 48000,
        BackgroundColor = "#000000",
    };

    public static Transform Transform(double scale = 1d) => new()
    {
        X = 0,
        Y = 0,
        Scale = scale,
        RotationDeg = 0,
        AnchorX = 0.5,
        AnchorY = 0.5,
    };

    public static TextClip Text(
        string content = "Merhaba",
        string fontId = TestFonts.FontId,
        double fontSizePx = 48,
        int weight = 400,
        bool italic = false,
        string fill = "#ffffff",
        Stroke? stroke = null,
        Background? background = null,
        TextClipTextAlign align = TextClipTextAlign.Left,
        double lineHeight = 1.2,
        double scale = 1d,
        Guid? id = null,
        long startUs = 0) => new()
        {
            Id = id ?? Guid.NewGuid(),
            Kind = "text",
            TimelineStartUs = startUs,
            TimelineDurationUs = 3_000_000,
            Transform = Transform(scale),
            Keyframes = new KeyframeTracks(),
            Effects = [],
            Opacity = 1,
            Text = new TextClipText
            {
                Content = content,
                FontId = fontId,
                FontSizePx = fontSizePx,
                FontWeight = weight,
                Italic = italic,
                Fill = fill,
                Stroke = stroke,
                Background = background,
                Align = align,
                LineHeight = lineHeight,
            },
        };

    public static ShapeClip Shape(
        ShapeClipShapeType type = ShapeClipShapeType.Rect,
        string fill = "#3366ff",
        Stroke2? stroke = null,
        double? radiusPx = null,
        double scale = 1d,
        Guid? id = null,
        long startUs = 0) => new()
        {
            Id = id ?? Guid.NewGuid(),
            Kind = "shape",
            TimelineStartUs = startUs,
            TimelineDurationUs = 3_000_000,
            Transform = Transform(scale),
            Keyframes = new KeyframeTracks(),
            Effects = [],
            Opacity = 1,
            Shape = new ShapeClipShape
            {
                Type = type,
                Fill = fill,
                Stroke = stroke,
                RadiusPx = radiusPx,
            },
        };

    public static StickerClip Sticker(Guid? id = null, long startUs = 0) => new()
    {
        Id = id ?? Guid.NewGuid(),
        Kind = "sticker",
        TimelineStartUs = startUs,
        TimelineDurationUs = 3_000_000,
        Transform = Transform(),
        Keyframes = new KeyframeTracks(),
        Effects = [],
        Opacity = 1,
        AssetId = Guid.NewGuid(),
    };

    public static TimelineDoc Doc(IEnumerable<Clip> clips, bool hidden = false, int width = 1920, int height = 1080) => new()
    {
        SchemaVersion = 1,
        ProjectId = Guid.NewGuid(),
        Settings = Settings(width, height),
        Markers = [],
        Tracks =
        [
            new Track
            {
                Id = Guid.NewGuid(),
                Type = TrackType.Overlay,
                Muted = false,
                Hidden = hidden,
                Locked = false,
                Clips = clips.ToList(),
            },
        ],
    };

    /// <summary>Geçici dizin (testler arası izolasyon) — çağıran siler.</summary>
    public static string TempDir() =>
        Directory.CreateDirectory(Path.Combine(
            Path.GetTempPath(), "videoedit-raster-tests", Guid.NewGuid().ToString("N"))).FullName;

    /// <summary>Manifest'i geçici dizine yazıp yükler (manifest doğrulama testleri).</summary>
    public static FontManifest WriteManifest(string directory, object payload)
    {
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, TextRasterOptions.ManifestFileName);
        File.WriteAllText(path, JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            WriteIndented = true,
        }));
        return FontManifest.Load(path);
    }
}
