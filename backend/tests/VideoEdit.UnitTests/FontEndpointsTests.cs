using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using VideoEdit.Api.Endpoints;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// <c>GET /api/fonts</c> + font dosyası ucu — metin-overlay denetimi, KRİTİK bulgu #1(a) ve #3(a).
/// <para>
/// Bu uç OLMADAN editör font listesini TAHMİN ETMEK zorundaydı; tahmin manifestle ayrıştı ve
/// "metin ekle → dışa aktar" ana yolu <c>font-missing</c> ile düştü. Testler sözleşmenin
/// üç yarısını sabitler: (1) katalog gerçekten manifestten türer, (2) dosya ucu yalnız
/// manifestte tanımlı dosyaları verir (path traversal yok), (3) manifest yoksa uç 500 değil
/// konuşan bir 503 döner.
/// </para>
/// </summary>
public class FontEndpointsTests
{
    private static readonly FontManifestProvider RepoFonts = new();

    private static DefaultHttpContext Http() => new();

    private static FontManifest MemoryManifest(string root) => new()
    {
        ManifestVersion = 1,
        SourcePath = Path.Combine(root, "manifest.json"),
        RootDirectory = root,
        Fonts = new Dictionary<string, FontEntry>(StringComparer.Ordinal)
        {
            ["alpha"] = new()
            {
                Family = "Alpha Sans",
                Version = "v1",
                License = "OFL-1.1",
                Files = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["400"] = "alpha/Alpha-Regular.ttf",
                    ["700i"] = "alpha/Alpha-BoldItalic.ttf",
                },
            },
            ["beta"] = new()
            {
                Family = "Beta Serif",
                Version = "v2",
                License = "OFL-1.1",
                Deprecated = true,
                Files = new Dictionary<string, string>(StringComparer.Ordinal) { ["400"] = "beta/Beta.ttf" },
            },
        },
    };

    // ---------- GET /api/fonts ----------

    [Fact]
    public void Catalogue_ProjectsTheManifest_IdsFamiliesWeightsAndStyles()
    {
        var result = FontEndpoints.GetCatalogue(FontManifestProvider.Preloaded(MemoryManifest(Path.GetTempPath())), Http());

        var ok = Assert.IsType<Ok<FontCatalogueResponse>>(result);
        var body = ok.Value!;
        Assert.Equal(1, body.ManifestVersion);
        Assert.Equal(["alpha", "beta"], body.Fonts.Select(f => f.Id));

        var alpha = body.Fonts[0];
        Assert.Equal("Alpha Sans", alpha.Family);
        Assert.Equal([400, 700], alpha.Weights);
        Assert.Equal(["400", "700i"], alpha.Styles);
        Assert.True(alpha.Italic);
        Assert.False(alpha.Deprecated);
        // Dosya adresleri BU API'nin uçlarıdır: tarayıcı @font-face ile aynı TTF'yi çeker.
        Assert.Equal("/api/fonts/alpha/400.ttf", alpha.Files["400"]);
        Assert.Equal("/api/fonts/alpha/700i.ttf", alpha.Files["700i"]);

        // Kullanımdan kaldırılmış id KATALOGDA KALIR (eski projeler açılabilsin) ama
        // işaretlidir — istemci picker'da gizler.
        Assert.True(body.Fonts[1].Deprecated);
    }

    [Fact]
    public void Catalogue_SetsCacheHeader()
    {
        var http = Http();
        FontEndpoints.GetCatalogue(FontManifestProvider.Preloaded(MemoryManifest(Path.GetTempPath())), http);
        Assert.Equal($"public, max-age={FontEndpoints.CatalogueCacheSeconds}", http.Response.Headers.CacheControl);
    }

    [Fact]
    public void Catalogue_WithoutManifest_Returns503NotCrash()
    {
        // Fontları hiç kurmamış bir geliştirici makinesi: editör son bilinen listeye düşer.
        var result = FontEndpoints.GetCatalogue(FontManifestProvider.Preloaded(null, "manifest yok"), Http());

        var problem = Assert.IsType<ProblemHttpResult>(result);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, problem.StatusCode);
    }

    [Fact]
    public void Catalogue_FromTheRealRepoManifest_ContainsTheCuratedIds()
    {
        // Depodaki GERÇEK fonts/manifest.json — editörün offline yedeği bu id'leri taşır
        // (istemci tarafındaki eşi: fontManifest.contract.test.ts).
        Assert.NotNull(RepoFonts.Manifest);
        var ok = Assert.IsType<Ok<FontCatalogueResponse>>(
            FontEndpoints.GetCatalogue(FontManifestProvider.Preloaded(RepoFonts.Manifest), Http()));

        var ids = ok.Value!.Fonts.Select(f => f.Id).ToList();
        Assert.Contains("roboto", ids);
        Assert.Contains("open-sans", ids);
        Assert.Contains("noto-sans", ids);
        Assert.Contains("noto-serif", ids);
    }

    // ---------- GET /api/fonts/{id}/{style}.ttf ----------

    [Fact]
    public void FontFile_ServesAManifestFileThatExists()
    {
        var root = Directory.CreateTempSubdirectory("ve-fonts-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "alpha"));
            File.WriteAllBytes(Path.Combine(root, "alpha", "Alpha-Regular.ttf"), [0, 1, 2, 3]);

            var http = Http();
            var result = FontEndpoints.GetFontFile(
                "alpha", "400", FontManifestProvider.Preloaded(MemoryManifest(root)), http);

            var file = Assert.IsType<PhysicalFileHttpResult>(result);
            Assert.Equal("font/ttf", file.ContentType);
            Assert.Contains("immutable", http.Response.Headers.CacheControl.ToString());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("alpha", "500")]        // manifestte olmayan stil
    [InlineData("gamma", "400")]        // manifestte olmayan fontId
    [InlineData("alpha", "../../400")]  // path traversal denemesi
    [InlineData("../alpha", "400")]
    public void FontFile_RefusesAnythingNotInTheManifest(string fontId, string styleKey)
    {
        var result = FontEndpoints.GetFontFile(
            fontId, styleKey, FontManifestProvider.Preloaded(MemoryManifest(Path.GetTempPath())), Http());

        Assert.IsType<NotFound>(result);
    }

    [Fact]
    public void FontFile_ManifestEntryPointingOutsideTheRoot_IsRefused()
    {
        // Bozuk/kötü niyetli manifest kökten DIŞARI çıkamaz — dosya var olsa bile.
        var root = Directory.CreateTempSubdirectory("ve-fonts-").FullName;
        try
        {
            var outside = Path.Combine(Path.GetDirectoryName(root)!, "outside.ttf");
            File.WriteAllBytes(outside, [0]);
            var manifest = MemoryManifest(root);
            manifest.Fonts["alpha"].Files["400"] = "../outside.ttf";

            Assert.IsType<NotFound>(
                FontEndpoints.GetFontFile("alpha", "400", FontManifestProvider.Preloaded(manifest), Http()));
            File.Delete(outside);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // ---------- Bilinmeyen fontId ön kontrolü (bulgu #1d'nin saf yarısı) ----------

    [Fact]
    public void UnknownFontIds_FindsIdsThatAreNotInTheManifest()
    {
        var manifest = MemoryManifest(Path.GetTempPath());
        var doc = DocWithFontIds("alpha", "inter", "impact", "beta");

        Assert.Equal(["impact", "inter"], FontCatalogue.UnknownFontIds(doc, manifest));
    }

    [Fact]
    public void UnknownFontIds_EmptyWhenEveryClipUsesACuratedId()
    {
        var manifest = MemoryManifest(Path.GetTempPath());
        Assert.Empty(FontCatalogue.UnknownFontIds(DocWithFontIds("alpha", "beta"), manifest));
        Assert.Empty(FontCatalogue.UnknownFontIds(null, manifest));
    }

    [Fact]
    public void UnknownFontIds_TreatsBlankIdAsUnknown()
    {
        // Boş/boşluk fontId manifestin hiçbir anahtarına karşılık gelmez → bilinmezdir,
        // ve raporlanan değer kullanıcının belgesindeki DEĞERDİR (normalize edilmez).
        var manifest = MemoryManifest(Path.GetTempPath());
        Assert.Equal(["  "], FontCatalogue.UnknownFontIds(DocWithFontIds("  "), manifest));
    }

    private static TimelineDoc DocWithFontIds(params string[] fontIds)
    {
        var clips = new List<Clip>();
        foreach (var fontId in fontIds)
        {
            var clip = ExportTestDocs.TextClip(0, 1_000_000);
            clip.Text!.FontId = fontId;
            clips.Add(clip);
        }

        return ExportTestDocs.Doc(clips: [.. clips]);
    }

}
