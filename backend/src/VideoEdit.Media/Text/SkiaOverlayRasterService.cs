using System.Collections.Concurrent;
using System.Security.Cryptography;
using SkiaSharp;
using SkiaSharp.HarfBuzz;
using VideoEdit.Contracts.Timeline;

namespace VideoEdit.Media.Text;

/// <summary>
/// <see cref="ITextRasterService"/>'in SkiaSharp gerçeklemesi (rendering-semantics §7 + §6.4).
/// Sözleşmeler:
/// <list type="bullet">
///   <item><b>@2x kuralı (§7):</b> PNG, proje çıktı çözünürlüğündeki bbox'ın
///     <c>rasterScale</c> katında rasterize edilir; taban 2'dir, <c>transform.scale &gt; 2</c>
///     olan kliplerde <c>ceil(scale)</c>'e yükselir (upsample bulanıklığı olmasın). Kompozisyon
///     tarafı <c>1/rasterScale</c> çarpanıyla çizer — <see cref="OverlayRasterPlacement"/>.</item>
///   <item><b>Straight alpha (§6.4):</b> Skia içte PREMULTIPLIED çalışır; PNG daima straight
///     alpha taşır. Encode ÖNCESİ pikseller <see cref="SKAlphaType.Unpremul"/> yüzeye okunur.
///     Bu adım atlanırsa yarı saydam kenarlarda KOYU HALKA oluşur (§6.4 belirti sözlüğü).</item>
///   <item><b>Belirlenimcilik:</b> KÜRATÖRLÜ fontlarla aynı girdi → bayt bayt aynı PNG (hinting
///     kapalı, Skia sürümü csproj'da pinli, glif düzeyi fallback kapalı). Küratörlü TTF hiç
///     kurulu değilse <see cref="FontResolver"/> yapılandırılmış SİSTEM fontuna düşer: sonuç
///     <see cref="RasterResult.FontSource"/> = <see cref="FontSourceKind.System"/> ile
///     işaretlenir, <see cref="RasterResult.Deterministic"/> <c>false</c> olur ve uyarı
///     yayılır — piksel golden'ları o modda ANLAMSIZDIR (fonts/README.md "üç mod").</item>
///   <item><b>Klip başına TEK PNG:</b> pozisyon/ölçek/rotasyon/opaklık animasyonları bu bitmap'e
///     §2 transformlarıyla uygulanır (§7 — "aynı bitmap'i transform etmek = garanti parity").</item>
/// </list>
/// </summary>
public sealed class SkiaOverlayRasterService : ITextRasterService, IDisposable
{
    private readonly TextRasterOptions options;
    private readonly Lazy<FontManifest> manifest;
    private readonly Lazy<FontResolver> resolver;
    private readonly ConcurrentDictionary<string, Lazy<SKTypeface>> typefaces = new(StringComparer.Ordinal);
    private bool disposed;

    /// <param name="fontOptions">
    /// Sistem fontu politikası (config section <c>Fonts</c>). Verilmezse ortam
    /// değişkenlerinden okunur (<c>Fonts__SystemFallback__&lt;fontId&gt;</c>).
    /// </param>
    /// <param name="systemFonts">Sistem font kaynağı (testler sahte geçirir).</param>
    /// <param name="onWarning">
    /// Belirlenimcilik uyarılarının kanalı. Verilmezse <c>stderr</c>'e yazılır; host
    /// <c>m =&gt; logger.LogWarning("{Msg}", m)</c> geçirerek worker log'una bağlayabilir.
    /// </param>
    public SkiaOverlayRasterService(
        TextRasterOptions? options = null,
        FontManifest? manifest = null,
        FontOptions? fontOptions = null,
        ISystemFontSource? systemFonts = null,
        Action<string>? onWarning = null)
    {
        this.options = options ?? new TextRasterOptions();
        this.manifest = manifest is null
            ? new Lazy<FontManifest>(() => FontManifest.Load(
                Path.Combine(FontRootLocator.Locate(this.options.FontRoot), TextRasterOptions.ManifestFileName)))
            : new Lazy<FontManifest>(manifest);
        resolver = new Lazy<FontResolver>(
            () => new FontResolver(this.manifest.Value, fontOptions, systemFonts, onWarning));
    }

    /// <summary>Kullanılan manifest (tanılama/log için; ilk erişimde yüklenir).</summary>
    public FontManifest Manifest => manifest.Value;

    /// <summary>Üç modlu font çözümleyici (küratörlü → sistem → hata).</summary>
    public FontResolver Fonts => resolver.Value;

    public Task<RasterResult> RenderAsync(
        Clip clip, ProjectSettings settings, string outputPath, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(clip);
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        ct.ThrowIfCancellationRequested();

        var result = clip switch
        {
            TextClip text => RenderText(text, settings, outputPath),
            ShapeClip shape => RenderShape(shape, settings, outputPath),
            StickerClip => throw new UnsupportedOverlayClipException(
                "Çıkartma (sticker) klibi rasterleştirilmez: mevcut PNG/WebP asset'i doğrudan "
                + "ffmpeg girişi olarak kullanılır (rendering-semantics §7)."),
            _ => throw new UnsupportedOverlayClipException(
                $"'{clip.GetType().Name}' overlay raster hattında desteklenmiyor "
                + "(yalnız metin ve şekil klipleri rasterleştirilir)."),
        };

        return Task.FromResult(result);
    }

    public TextLayout Measure(TextClipText text, ProjectSettings settings)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(settings);

        var font = ResolveFont(text);
        using var measurer = CreateMeasurer(font, text);

        // Ölçümün BELİRLENİMCİ olup olmadığı sonucun parçasıdır: sistem fontuyla ölçülen kutu
        // başka bir kurulumda başka çıkar ve export'un ön kapısı ona güvenemez
        // (gerekçe + ölçüm: TextLayout.FontIsDeterministic).
        return TextLayoutEngine.Layout(LayoutRequestOf(text), measurer)
            with { FontIsDeterministic = font.Deterministic };
    }

    // ───────────────────────── Metin ─────────────────────────

    private RasterResult RenderText(TextClip clip, ProjectSettings settings, string outputPath)
    {
        if (clip.Text is null)
        {
            throw new UnsupportedOverlayClipException($"Metin klibi '{clip.Id}' boş 'text' alanı taşıyor.");
        }

        if (clip.Text.FontSizePx <= 0 || clip.Text.LineHeight <= 0)
        {
            throw new UnsupportedOverlayClipException(
                $"Metin klibi '{clip.Id}' geçersiz ölçü taşıyor "
                + $"(fontSizePx={clip.Text.FontSizePx}, lineHeight={clip.Text.LineHeight}).");
        }

        var fontFile = ResolveFont(clip.Text);
        using var measurer = CreateMeasurer(fontFile, clip.Text);
        var layout = TextLayoutEngine.Layout(LayoutRequestOf(clip.Text), measurer);

        var rasterScale = ChooseRasterScale(clip.Transform?.Scale ?? 1d, layout.BboxWidthPx, layout.BboxHeightPx);
        var fill = HexColor.Parse(clip.Text.Fill, $"text.fill ({clip.Id})");
        var strokeColor = clip.Text.Stroke is { WidthPx: > 0 } s
            ? HexColor.Parse(s.Color, $"text.stroke.color ({clip.Id})")
            : (SKColor?)null;
        var background = clip.Text.Background is { } bg
            ? (Color: HexColor.Parse(bg.Color, $"text.background.color ({clip.Id})"),
               Padding: Math.Max(0d, bg.PaddingPx),
               Radius: Math.Max(0d, bg.RadiusPx))
            : ((SKColor Color, double Padding, double Radius)?)null;

        using var pixels = Render(layout.BboxWidthPx, layout.BboxHeightPx, rasterScale, canvas =>
        {
            canvas.Translate((float)layout.OriginXPx, (float)layout.OriginYPx);

            if (background is { } b && layout.BackgroundRect is { } bgBox)
            {
                using var bgPaint = new SKPaint { Color = b.Color, IsAntialias = true, Style = SKPaintStyle.Fill };
                // Dikdörtgen LAYOUT'tan gelir (içerik ± pay) — burada yeniden hesaplanmaz.
                // Aynı kutuyu istemci de kullanır (textLayout.ts backgroundRect); iki tarafın
                // kuralı test-vectors/text-layout-vectors.json ile kilitlidir.
                var rect = new SKRect(
                    (float)bgBox.Left, (float)bgBox.Top, (float)bgBox.Right, (float)bgBox.Bottom);
                var radius = (float)Math.Clamp(b.Radius, 0d, Math.Min(rect.Width, rect.Height) / 2d);
                canvas.DrawRoundRect(rect, radius, radius, bgPaint);
            }

            // Kontur ÖNCE, dolgu SONRA: dolgu konturun iç yarısını örter, dışa taşan pay
            // strokeWidth/2'dir (layout bbox'ı da bu payla genişletildi).
            if (strokeColor is { } sc)
            {
                using var strokePaint = new SKPaint
                {
                    Color = sc,
                    IsAntialias = true,
                    Style = SKPaintStyle.Stroke,
                    StrokeWidth = (float)clip.Text.Stroke!.WidthPx,
                    StrokeJoin = SKStrokeJoin.Round,
                    StrokeCap = SKStrokeCap.Round,
                };
                DrawLines(canvas, layout, measurer, strokePaint);
            }

            using var fillPaint = new SKPaint { Color = fill, IsAntialias = true, Style = SKPaintStyle.Fill };
            DrawLines(canvas, layout, measurer, fillPaint);
        });

        var written = WritePng(pixels, outputPath);
        return new RasterResult(
            Width: pixels.Width,
            Height: pixels.Height,
            Path: written.Path,
            RasterScale: rasterScale,
            BboxWidthPx: layout.BboxWidthPx,
            BboxHeightPx: layout.BboxHeightPx,
            OriginXPx: layout.OriginXPx,
            OriginYPx: layout.OriginYPx,
            ByteSize: written.ByteSize,
            Sha256: written.Sha256,
            Lines: layout.Lines,
            HasMissingGlyphs: layout.HasMissingGlyphs,
            SyntheticItalic: fontFile.SyntheticItalic,
            SubstitutedWeight: fontFile.SubstitutedWeight,
            FontSource: fontFile.Source,
            FontFamily: fontFile.Family,
            // Sistem fontu kullanıldıysa uyarı SONUÇLA BİRLİKTE taşınır: worker log'a yazar,
            // API/UI "bu export belirlenimci değil" diyebilir (uyarı kanalı ayrıca tetiklenir).
            FontWarning: fontFile.Source == FontSourceKind.System
                ? FontWarnings.SystemFontUsed(fontFile)
                : null);
    }

    private static void DrawLines(SKCanvas canvas, TextLayout layout, SkiaGlyphMeasurer measurer, SKPaint paint)
    {
        foreach (var line in layout.Lines)
        {
            if (line.Text.Length == 0)
            {
                continue;
            }

            // Ölçümle AYNI shaping sonucu (glif kimlikleri + konumlar) — SkiaGlyphMeasurer cache'i.
            using var blob = measurer.BuildBlob(line.Text);
            if (blob is not null)
            {
                canvas.DrawText(blob, (float)line.LeftPx, (float)line.BaselineYPx, paint);
            }
        }
    }

    // ───────────────────────── Şekil ─────────────────────────

    private RasterResult RenderShape(ShapeClip clip, ProjectSettings settings, string outputPath)
    {
        if (clip.Shape is null)
        {
            throw new UnsupportedOverlayClipException($"Şekil klibi '{clip.Id}' boş 'shape' alanı taşıyor.");
        }

        var geometry = ShapeGeometry.Compute(clip.Shape, (int)settings.Width, (int)settings.Height);
        var rasterScale = ChooseRasterScale(clip.Transform?.Scale ?? 1d, geometry.BoxWidthPx, geometry.BoxHeightPx);

        var fill = HexColor.Parse(clip.Shape.Fill, $"shape.fill ({clip.Id})");
        var strokeColor = clip.Shape.Stroke is { WidthPx: > 0 } s
            ? HexColor.Parse(s.Color, $"shape.stroke.color ({clip.Id})")
            : (SKColor?)null;

        using var pixels = Render(geometry.BoxWidthPx, geometry.BoxHeightPx, rasterScale,
            canvas => DrawShape(canvas, geometry, fill, strokeColor));

        var written = WritePng(pixels, outputPath);
        return new RasterResult(
            Width: pixels.Width,
            Height: pixels.Height,
            Path: written.Path,
            RasterScale: rasterScale,
            BboxWidthPx: geometry.BoxWidthPx,
            BboxHeightPx: geometry.BoxHeightPx,
            OriginXPx: 0,
            OriginYPx: 0,
            ByteSize: written.ByteSize,
            Sha256: written.Sha256,
            Lines: RasterResult.NoLines,
            HasMissingGlyphs: false,
            SyntheticItalic: false,
            SubstitutedWeight: false);
    }

    private static void DrawShape(SKCanvas canvas, ShapeGeometry geometry, SKColor fill, SKColor? strokeColor)
    {
        var box = geometry.InsetBox;
        var rect = new SKRect((float)box.Left, (float)box.Top, (float)box.Right, (float)box.Bottom);

        using var fillPaint = new SKPaint { Color = fill, IsAntialias = true, Style = SKPaintStyle.Fill };
        using var strokePaint = new SKPaint
        {
            Color = strokeColor ?? SKColors.Transparent,
            IsAntialias = true,
            Style = SKPaintStyle.Stroke,
            StrokeWidth = (float)geometry.StrokeWidthPx,
            StrokeJoin = SKStrokeJoin.Miter,
        };

        switch (geometry.Type)
        {
            case ShapeClipShapeType.Rect:
                canvas.DrawRoundRect(rect, (float)geometry.CornerRadiusPx, (float)geometry.CornerRadiusPx, fillPaint);
                if (strokeColor is not null)
                {
                    canvas.DrawRoundRect(rect, (float)geometry.CornerRadiusPx, (float)geometry.CornerRadiusPx, strokePaint);
                }

                break;

            case ShapeClipShapeType.Ellipse:
                canvas.DrawOval(rect, fillPaint);
                if (strokeColor is not null)
                {
                    canvas.DrawOval(rect, strokePaint);
                }

                break;

            case ShapeClipShapeType.Line:
                {
                    // Çizgi/ok GÖVDESİ dolgu renginde çizilir; kontur rengi verilmişse onun
                    // rengi kazanır (tek gövdeli şekilde iki renk üst üste anlamsız olurdu).
                    using var linePaint = new SKPaint
                    {
                        Color = strokeColor ?? fill,
                        IsAntialias = true,
                        Style = SKPaintStyle.Stroke,
                        StrokeWidth = (float)geometry.LineThicknessPx,
                        StrokeCap = SKStrokeCap.Butt,
                    };
                    var y = (float)(geometry.BoxHeightPx / 2d);
                    canvas.DrawLine(
                        (float)(geometry.LineThicknessPx / 2d), y,
                        (float)(geometry.BoxWidthPx - (geometry.LineThicknessPx / 2d)), y,
                        linePaint);
                    break;
                }

            case ShapeClipShapeType.Arrow:
                {
                    var color = strokeColor ?? fill;
                    var y = (float)(geometry.BoxHeightPx / 2d);
                    var tipX = (float)(geometry.BoxWidthPx - (geometry.LineThicknessPx / 2d));
                    var headBaseX = (float)(tipX - geometry.ArrowHeadLengthPx);

                    using var linePaint = new SKPaint
                    {
                        Color = color,
                        IsAntialias = true,
                        Style = SKPaintStyle.Stroke,
                        StrokeWidth = (float)geometry.LineThicknessPx,
                        StrokeCap = SKStrokeCap.Butt,
                    };
                    canvas.DrawLine((float)(geometry.LineThicknessPx / 2d), y, headBaseX, y, linePaint);

                    using var headPath = new SKPath();
                    headPath.MoveTo(tipX, y);
                    headPath.LineTo(headBaseX, (float)(y - geometry.ArrowHeadHalfWidthPx));
                    headPath.LineTo(headBaseX, (float)(y + geometry.ArrowHeadHalfWidthPx));
                    headPath.Close();
                    using var headPaint = new SKPaint { Color = color, IsAntialias = true, Style = SKPaintStyle.Fill };
                    canvas.DrawPath(headPath, headPaint);
                    break;
                }

            default:
                throw new UnsupportedOverlayClipException($"Bilinmeyen şekil türü: {geometry.Type}.");
        }
    }

    // ───────────────────────── Ortak raster boru hattı ─────────────────────────

    /// <summary>
    /// §7 @2x kuralı: taban 2; <c>transform.scale &gt; 2</c> ise <c>ceil(scale)</c>. Sonuç
    /// <see cref="TextRasterOptions.MaxRasterDimension"/>'ı aşarsa çarpan kademeli düşürülür;
    /// 1'de bile sığmıyorsa deterministik hata (retry anlamsız).
    /// </summary>
    internal int ChooseRasterScale(double transformScale, double bboxWidthPx, double bboxHeightPx)
    {
        var wanted = Math.Max(options.BaseRasterScale, (int)Math.Ceiling(double.IsFinite(transformScale) ? transformScale : 1d));
        wanted = Math.Max(1, wanted);

        var longest = Math.Max(bboxWidthPx, bboxHeightPx);
        for (var scale = wanted; scale >= 1; scale--)
        {
            if (Math.Ceiling(longest * scale) <= options.MaxRasterDimension)
            {
                return scale;
            }
        }

        throw new RasterTooLargeException(
            $"Overlay rasteri taban çarpanda bile sığmıyor: bbox {bboxWidthPx:0.##}×{bboxHeightPx:0.##} px, "
            + $"tavan {options.MaxRasterDimension} px. Font boyutunu ya da şekil ölçeğini küçültün.");
    }

    private static SKBitmap Render(double bboxWidthPx, double bboxHeightPx, int rasterScale, Action<SKCanvas> draw)
    {
        var width = Math.Max(1, (int)Math.Ceiling(bboxWidthPx * rasterScale));
        var height = Math.Max(1, (int)Math.Ceiling(bboxHeightPx * rasterScale));

        // Skia içte PREMULTIPLIED çalışır — çizim yüzeyi de öyle olmalıdır.
        var info = new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var surface = SKSurface.Create(info)
            ?? throw new RasterTooLargeException(
                $"Skia {width}×{height} px raster yüzeyi ayıramadı (bellek?).");

        var canvas = surface.Canvas;
        canvas.Clear(SKColors.Transparent);
        canvas.Save();
        canvas.Scale(rasterScale, rasterScale);
        draw(canvas);
        canvas.Restore();
        canvas.Flush();

        // §6.4: PNG DAİMA straight (unassociated) alpha taşır → Unpremul yüzeye oku.
        // Doğrudan encode edilseydi yarı saydam kenarlarda koyu halka oluşurdu.
        var bitmap = new SKBitmap(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        using var image = surface.Snapshot();
        if (!image.ReadPixels(bitmap.PeekPixels(), 0, 0))
        {
            bitmap.Dispose();
            throw new RasterTooLargeException(
                $"Skia raster pikselleri okunamadı ({width}×{height}).");
        }

        return bitmap;
    }

    /// <summary>
    /// PNG'yi diske yazar. Bitmap'i DISPOSE ETMEZ — sahipliği çağırana aittir (aksi halde
    /// çağıran, yazımdan sonra Width/Height okurken serbest bırakılmış native belleğe
    /// dokunur ve süreç 0xC0000005 ile çöker; bu davranış testle sabitlenmiştir).
    /// </summary>
    private (string Path, long ByteSize, string Sha256) WritePng(SKBitmap bitmap, string outputPath)
    {
        var full = Path.GetFullPath(outputPath);
        var directory = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        using var data = bitmap.Encode(SKEncodedImageFormat.Png, options.PngQuality)
            ?? throw new RasterTooLargeException($"PNG encode başarısız ({bitmap.Width}×{bitmap.Height}).");
        var bytes = data.ToArray();

        // Atomik yazım: yarım PNG asla ffmpeg girişine dönüşmesin.
        var temp = full + ".part";
        File.WriteAllBytes(temp, bytes);
        File.Move(temp, full, overwrite: true);
        return (full, bytes.LongLength, Convert.ToHexStringLower(SHA256.HashData(bytes)));
    }

    // ───────────────────────── Font çözümü ─────────────────────────

    private FontFile ResolveFont(TextClipText text) =>
        Fonts.Resolve(text.FontId, text.FontWeight <= 0 ? 400 : text.FontWeight, text.Italic);

    /// <summary>
    /// Typeface cache'i (servis SINGLETON'dır: TTF her export'ta yeniden parse edilmez).
    /// <c>Lazy</c> ile sarılıdır: <c>GetOrAdd</c>'in fabrikası eşzamanlı çağrılarda BİRDEN ÇOK
    /// kez koşabilir; sarmalanmadan yarışan koşu kaybeden native <see cref="SKTypeface"/>'i
    /// hiç dispose edilmeden sızdırırdı.
    /// </summary>
    private SkiaGlyphMeasurer CreateMeasurer(FontFile file, TextClipText text)
    {
        var typeface = typefaces
            .GetOrAdd(file.CacheKey, _ => new Lazy<SKTypeface>(
                () => OpenTypeface(file), LazyThreadSafetyMode.ExecutionAndPublication))
            .Value;
        return new SkiaGlyphMeasurer(typeface, (float)text.FontSizePx, file.SyntheticItalic);
    }

    /// <summary>
    /// Font dosyasını açar.
    /// <para>
    /// DEĞİŞKEN (variable) FONT DESTEKLENMEZ — bilinçli ve TİPLİ hata. SkiaSharp 3.116.1'de
    /// eksen sabitleme API'si (<c>SKFontArguments</c>) YOKTUR; değişken bir dosya daima
    /// varsayılan örneğiyle açılır ve <c>fontWeight: 700</c> istendiğinde SESSİZCE Regular
    /// çizilirdi. Sessiz yanlış render yerine kurulum hatası veriyoruz; küratörlü set bu yüzden
    /// statik TTF'lerden kuruludur (fonts/README.md).
    /// </para>
    /// </summary>
    private static SKTypeface OpenTypeface(FontFile file)
    {
        // Sistem fontu, dosya yolu OLMADAN (SKFontManager yolu): İSTENEN stil ile yeniden
        // eşleştirilir — çözümlemedeki çağrının aynısı, dolayısıyla aynı süreçte aynı typeface.
        if (file.Source == FontSourceKind.System && file.Path.Length == 0)
        {
            var style = new SKFontStyle(
                file.RequestedWeight <= 0 ? 400 : file.RequestedWeight,
                (int)SKFontStyleWidth.Normal,
                file.RequestedItalic ? SKFontStyleSlant.Italic : SKFontStyleSlant.Upright);
            return SKFontManager.Default.MatchFamily(file.Family, style)
                ?? throw new FontLoadException(file.FontId,
                    $"Sistem fontu ailesi '{file.Family}' çözümlemeden sonra kayboldu "
                    + "(SKFontManager.MatchFamily null döndü).");
        }

        if (file.Variations.Count > 0)
        {
            throw new FontLoadException(file.FontId,
                $"fontId '{file.FontId}' manifest'te değişken font ekseni tanımlıyor "
                + $"({string.Join(", ", file.Variations.Select(v => $"{v.Key}={v.Value}"))}), ancak "
                + "kullanılan SkiaSharp sürümünde eksen sabitleme API'si yok — ağırlık sessizce "
                + "yanlış çizilirdi. Manifest'e ağırlık başına STATİK TTF girin (fonts/README.md).");
        }

        return SKTypeface.FromFile(file.Path)
            ?? throw new FontLoadException(file.FontId,
                $"Font dosyası Skia tarafından açılamadı (bozuk ya da desteklenmeyen biçim): {file.Path}");
    }

    private static TextLayoutRequest LayoutRequestOf(TextClipText text) => new()
    {
        Content = text.Content ?? string.Empty,
        FontSizePx = text.FontSizePx,
        LineHeight = text.LineHeight,
        Align = text.Align,
        StrokeWidthPx = text.Stroke?.WidthPx ?? 0d,
        BackgroundPaddingPx = text.Background is { } bg ? Math.Max(0d, bg.PaddingPx) : null,
        MaxWidthPx = null, // şemada TextClip genişlik alanı yok — yalnız açık \n satır üretir
    };

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        foreach (var typeface in typefaces.Values)
        {
            if (typeface.IsValueCreated)
            {
                typeface.Value.Dispose();
            }
        }

        typefaces.Clear();
    }
}
