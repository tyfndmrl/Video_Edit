using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// Worker'ın overlay hazırlığı (tasarım 04 §4.2 adım 3): hangi klipler rasterleşir, dosyalar
/// nereye yazılır, hangi durum işi düşürür.
/// <para>
/// Toplama kuralları FONT GEREKTİRMEZ (saf); gerçek dosya üretimi testleri şekil klibiyle
/// yapılır (font bağımsız).
/// </para>
/// </summary>
public sealed class OverlayRasterPlannerTests : IDisposable
{
    private readonly string dir = OverlayTestDocs.TempDir();
    private readonly SkiaOverlayRasterService service = new(new TextRasterOptions(), new FontManifest());

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

    // ---------- Toplama kuralları ----------

    [Fact]
    public void Collect_TakesTextAndShapeClipsOnly()
    {
        var doc = OverlayTestDocs.Doc(
        [
            OverlayTestDocs.Text("a"),
            OverlayTestDocs.Shape(),
            OverlayTestDocs.Sticker(), // çıkartma: mevcut asset doğrudan kullanılır, raster YOK
        ]);

        var items = OverlayRasterPlanner.Collect(doc);

        Assert.Equal(2, items.Count);
        Assert.Collection(items,
            i => Assert.IsType<TextClip>(i.Clip),
            i => Assert.IsType<ShapeClip>(i.Clip));
    }

    [Fact]
    public void Collect_SkipsHiddenTracks()
    {
        // ExportCompiler'ın "atıl klip" kuralıyla aynı: gizli katmandaki metnin eksik fontu
        // TÜM export'u düşürmemeli (M4 dalga 1 denetimindeki hatanın tekrarı olurdu).
        var doc = OverlayTestDocs.Doc([OverlayTestDocs.Text("gizli")], hidden: true);

        Assert.Empty(OverlayRasterPlanner.Collect(doc));
    }

    [Fact]
    public void Collect_UsesTheClipIdAsTheFileName()
    {
        var id = Guid.Parse("33333333-3333-3333-3333-333333333333");
        var doc = OverlayTestDocs.Doc([OverlayTestDocs.Shape(id: id)]);

        var item = Assert.Single(OverlayRasterPlanner.Collect(doc));

        Assert.Equal(id, item.ClipId);
        Assert.Equal("33333333333333333333333333333333.png", item.FileName);
    }

    [Fact]
    public void Collect_KeepsDocumentOrderAcrossTracks()
    {
        var top = OverlayTestDocs.Shape(id: Guid.Parse("aaaaaaaa-0000-0000-0000-000000000000"));
        var bottom = OverlayTestDocs.Shape(id: Guid.Parse("bbbbbbbb-0000-0000-0000-000000000000"));
        var doc = OverlayTestDocs.Doc([top]);
        doc.Tracks.Add(new Track
        {
            Id = Guid.NewGuid(),
            Type = TrackType.Overlay,
            Muted = false,
            Hidden = false,
            Locked = false,
            Clips = [bottom],
        });

        var items = OverlayRasterPlanner.Collect(doc);

        Assert.Equal([top.Id, bottom.Id], items.Select(i => i.ClipId));
        Assert.Equal([0, 1], items.Select(i => i.TrackIndex));
    }

    // ---------- Compiler ile sözleşme ----------

    [Fact]
    public void Collect_MatchesTheCompilersRasterClipLedger()
    {
        // İKİ AJANIN KURALI AYNI OLMAK ZORUNDA: worker hangi klipler için PNG üretiyorsa,
        // compiler tam o klipler için raster BEKLER. Ayrışırlarsa export ya "no raster
        // provided" ile düşer ya da boşuna PNG üretilir. Bu test o sınırı kilitler.
        // Klipler AYNI track'te çakışamaz (şema değişmezi) → ardışık yerleştirilir.
        var visibleText = OverlayTestDocs.Text("görünür", startUs: 0);
        var visibleShape = OverlayTestDocs.Shape(startUs: 3_000_000);
        var doc = OverlayTestDocs.Doc(
            [visibleText, visibleShape, OverlayTestDocs.Sticker(startUs: 6_000_000)]);
        doc.Tracks.Add(new Track
        {
            Id = Guid.NewGuid(),
            Type = TrackType.Overlay,
            Muted = false,
            Hidden = true, // atıl: iki taraf da atlamalı
            Clips = [OverlayTestDocs.Text("gizli")],
            Locked = false,
        });

        var plan = Media.Export.ExportCompiler.Validate(doc);

        Assert.Equal(
            plan.RasterClips.Select(c => c.Id).Order(),
            OverlayRasterPlanner.Collect(doc).Select(i => i.ClipId).Order());
    }

    // ---------- Dosya üretimi ----------

    [Fact]
    public async Task RenderAll_WritesOnePngPerClipIntoTheOverlaysSubdirectory()
    {
        var doc = OverlayTestDocs.Doc([OverlayTestDocs.Shape(), OverlayTestDocs.Shape()], width: 160, height: 90);

        var set = await OverlayRasterPlanner.RenderAllAsync(doc, service, dir);

        Assert.Equal(2, set.Count);
        Assert.Equal(Path.Combine(dir, OverlayRasterPlanner.DirectoryName), set.Directory);
        Assert.Equal(2, Directory.GetFiles(set.Directory, "*.png").Length);
        foreach (var (clipId, raster) in set.Rasters)
        {
            Assert.True(File.Exists(raster.Path));
            Assert.Contains(clipId.ToString("N"), raster.Path, StringComparison.Ordinal);
        }

        Assert.Equal(set.Rasters.Values.Sum(r => r.ByteSize), set.TotalBytes);
    }

    [Fact]
    public async Task RenderAll_WithNoOverlayClips_CreatesNothing()
    {
        // Metinsiz proje FONT KURULUMUNDAN ETKİLENMEMELİ: ne dizin açılır ne font okunur.
        var doc = OverlayTestDocs.Doc([OverlayTestDocs.Sticker()]);

        var set = await OverlayRasterPlanner.RenderAllAsync(doc, service, dir);

        Assert.Equal(0, set.Count);
        Assert.False(Directory.Exists(Path.Combine(dir, OverlayRasterPlanner.DirectoryName)));
    }

    [Fact]
    public async Task RenderAll_IsDeterministicAcrossRuns()
    {
        var doc = OverlayTestDocs.Doc(
            [OverlayTestDocs.Shape(id: Guid.Parse("44444444-4444-4444-4444-444444444444"))],
            width: 160, height: 90);

        var first = await OverlayRasterPlanner.RenderAllAsync(doc, service, Path.Combine(dir, "run1"));
        var second = await OverlayRasterPlanner.RenderAllAsync(doc, service, Path.Combine(dir, "run2"));

        Assert.Equal(
            first.Rasters.Select(r => r.Value.Sha256),
            second.Rasters.Select(r => r.Value.Sha256));
    }

    [Fact]
    public async Task RenderAll_DuplicateClipIds_FailDeterministically()
    {
        var id = Guid.Parse("55555555-5555-5555-5555-555555555555");
        var doc = OverlayTestDocs.Doc(
            [OverlayTestDocs.Shape(id: id), OverlayTestDocs.Shape(id: id)], width: 160, height: 90);

        var ex = await Assert.ThrowsAsync<UnsupportedOverlayClipException>(() =>
            OverlayRasterPlanner.RenderAllAsync(doc, service, dir));

        Assert.Contains(id.ToString(), ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RenderAll_MissingFont_SurfacesTheTypedFontError()
    {
        // Worker bu hatayı 'font-missing' koduyla Failed'a yazar (retry YOK).
        var empty = new FontManifest { SourcePath = "(boş manifest)" };
        using var fontless = new SkiaOverlayRasterService(new TextRasterOptions(), empty);
        var doc = OverlayTestDocs.Doc([OverlayTestDocs.Text("metin")]);

        var ex = await Assert.ThrowsAsync<FontNotFoundException>(() =>
            OverlayRasterPlanner.RenderAllAsync(doc, fontless, dir));

        Assert.Equal("font-missing", ex.Code);
    }

    [Fact]
    public async Task RenderAll_HonoursCancellation()
    {
        var doc = OverlayTestDocs.Doc([OverlayTestDocs.Shape()], width: 160, height: 90);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OverlayRasterPlanner.RenderAllAsync(doc, service, dir, cts.Token));
    }

    [Fact]
    public void MissingGlyphReport_ListsOnlyAffectedClips()
    {
        var withGlyphs = Guid.Parse("66666666-6666-6666-6666-666666666666");
        var withoutGlyphs = Guid.Parse("77777777-7777-7777-7777-777777777777");
        var set = new OverlayRasterSet("d", new Dictionary<Guid, RasterResult>
        {
            [withGlyphs] = Raster(hasMissingGlyphs: false),
            [withoutGlyphs] = Raster(hasMissingGlyphs: true),
        });

        Assert.Equal([withoutGlyphs], set.ClipsWithMissingGlyphs);
    }

    [Fact]
    public void SystemFontReport_NamesTheAffectedClipsAndDropsDeterminism()
    {
        // Sistem fontuyla çizilen klip işi DÜŞÜRMEZ (çıktı geçerlidir) ama defter bunu
        // saklamaz: worker uyarı loglar, defter 'deterministik değil' der.
        var curated = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var system = Guid.Parse("22222222-2222-2222-2222-222222222222");
        var set = new OverlayRasterSet("d", new Dictionary<Guid, RasterResult>
        {
            [curated] = Raster(hasMissingGlyphs: false),
            [system] = Raster(hasMissingGlyphs: false, source: FontSourceKind.System, warning: "sistem fontu"),
        });

        Assert.Equal([system], set.ClipsUsingSystemFont);
        Assert.Equal(["sistem fontu"], set.SystemFontWarnings);
        Assert.False(set.Deterministic);
    }

    [Fact]
    public void CuratedOnlySet_IsDeterministic()
    {
        var set = new OverlayRasterSet("d", new Dictionary<Guid, RasterResult>
        {
            [Guid.Empty] = Raster(hasMissingGlyphs: false),
        });

        Assert.True(set.Deterministic);
        Assert.Empty(set.ClipsUsingSystemFont);
        Assert.Empty(set.SystemFontWarnings);
    }

    private static RasterResult Raster(
        bool hasMissingGlyphs,
        FontSourceKind? source = FontSourceKind.Curated,
        string? warning = null) => new(
        Width: 2, Height: 2, Path: "x.png", RasterScale: 2,
        BboxWidthPx: 1, BboxHeightPx: 1, OriginXPx: 0, OriginYPx: 0,
        ByteSize: 10, Sha256: "abc", Lines: RasterResult.NoLines,
        HasMissingGlyphs: hasMissingGlyphs, SyntheticItalic: false, SubstitutedWeight: false,
        FontSource: source, FontFamily: "F", FontWarning: warning);
}
