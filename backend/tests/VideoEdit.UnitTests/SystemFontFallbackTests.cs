using System.Collections;
using SkiaSharp;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// Küratörlü TTF kurulu DEĞİLKEN metin export'unun düşmemesini sağlayan üç modlu font
/// politikası (fonts/README.md "üç mod"):
/// <list type="number">
///   <item><b>küratörlü</b> — manifest'in TTF'i diskte varsa daima o (sha256 pinli, belirlenimci);</item>
///   <item><b>sistem</b> — yoksa yapılandırılmış sistem ailesi; sonuç
///     <see cref="FontSourceKind.System"/> işaretlenir + uyarı yayılır (BELİRLENİMCİ DEĞİL);</item>
///   <item><b>yok</b> — o da yoksa eskisi gibi <c>font-missing</c>.</item>
/// </list>
/// Buradaki iddialar PİKSEL GOLDEN'I İÇERMEZ: sistem fontu makineden makineye değişir
/// (golden'lar yalnız <see cref="CuratedFontFactAttribute"/> ile koşar).
/// </summary>
public sealed class SystemFontFallbackTests : IDisposable
{
    private readonly string dir = OverlayTestDocs.TempDir();

    public void Dispose()
    {
        try
        {
            Directory.Delete(dir, recursive: true);
        }
        catch (IOException)
        {
            // temizlik best-effort
        }
    }

    // ───────────────────────── Yapılandırma (saf) ─────────────────────────

    [Fact]
    public void ConfiguredFamilies_SplitsOnCommaAndSemicolonAndTrims()
    {
        var options = new FontOptions
        {
            SystemFallback = { ["roboto"] = " Arial , Liberation Sans; DejaVu Sans " },
        };

        Assert.Equal(["Arial", "Liberation Sans", "DejaVu Sans"], options.ConfiguredFamilies("roboto"));
        Assert.Empty(options.ConfiguredFamilies("open-sans"));
    }

    [Fact]
    public void ConfiguredFamilies_KeyIsCaseInsensitive()
    {
        var options = new FontOptions { SystemFallback = { ["Roboto"] = "Arial" } };

        Assert.Equal(["Arial"], options.ConfiguredFamilies("roboto"));
    }

    [Fact]
    public void FromEnvironment_ReadsTheSameKeysAsAppsettings()
    {
        // appsettings 'Fonts:SystemFallback:roboto' ↔ env 'Fonts__SystemFallback__roboto'
        var env = new Hashtable
        {
            ["Fonts__SystemFallback__roboto"] = "Comic Sans MS",
            ["Fonts__AllowSystemFallback"] = "false",
            ["PATH"] = "/usr/bin",
        };

        var options = FontOptions.FromEnvironment(env);

        Assert.Equal(["Comic Sans MS"], options.ConfiguredFamilies("roboto"));
        Assert.False(options.AllowSystemFallback);
    }

    [Fact]
    public void FromEnvironment_DefaultsToEnabled()
    {
        var options = FontOptions.FromEnvironment(new Hashtable());

        Assert.True(options.AllowSystemFallback,
            "Font indirilmemiş kurulumda metin export'u düşmesin diye VARSAYILAN AÇIK.");
        Assert.Empty(options.SystemFallback);
    }

    // ───────────────────────── Öncelik sırası (saf) ─────────────────────────

    [Fact]
    public void Candidates_ExplicitConfigurationOverridesManifestAndDefaults()
    {
        var entry = new FontEntry { Family = "Roboto", SystemFallback = ["Manifest Family"] };
        var options = new FontOptions { SystemFallback = { ["roboto"] = "Config Family" } };

        Assert.Equal(["Config Family"], FontFallbackPolicy.Candidates("roboto", options, entry));
    }

    [Fact]
    public void Candidates_ManifestEntryWinsOverBuiltInDefaults()
    {
        var entry = new FontEntry { Family = "Roboto", SystemFallback = ["Manifest Family", "İkinci"] };

        Assert.Equal(["Manifest Family", "İkinci"],
            FontFallbackPolicy.Candidates("roboto", new FontOptions(), entry));
    }

    [Fact]
    public void Candidates_BuiltInDefaultsCoverTheCuratedSet()
    {
        var roboto = FontFallbackPolicy.Candidates("roboto", null, new FontEntry { Family = "Roboto" });
        var serif = FontFallbackPolicy.Candidates("noto-serif", null, new FontEntry { Family = "Noto Serif" });

        // Önce fontun KENDİ ailesi (sistemde kuruluysa en yakın sonuç), sonra platform karşılıkları.
        Assert.Equal("Roboto", roboto[0]);
        Assert.Contains("Arial", roboto);
        Assert.Contains("Liberation Sans", roboto);
        Assert.Contains("Times New Roman", serif);
        Assert.Contains("Liberation Serif", serif);

        Assert.Equal(
            ["noto-sans", "noto-serif", "open-sans", "roboto"],
            SystemFontDefaults.KnownFontIds.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Candidates_UnknownFontIdFallsBackToItsOwnFamilyName()
    {
        var entry = new FontEntry { Family = "Inter" };

        Assert.Equal(["Inter"], FontFallbackPolicy.Candidates("inter-4", new FontOptions(), entry));
        Assert.Empty(FontFallbackPolicy.Candidates("inter-4", new FontOptions(), null));
    }

    // ───────────────────────── Çözümleme sırası ─────────────────────────

    [Fact]
    public void Resolve_PrefersTheCuratedFileAndNeverAsksTheSystem()
    {
        Touch("f/Regular.ttf");
        var system = new FakeSystemFontSource((_, _, _) => Match("Sistem"));
        var resolver = Resolver(ManifestWith(missingFile: false), system: system);

        var file = resolver.Resolve("f", 400, italic: false);

        Assert.Equal(FontSourceKind.Curated, file.Source);
        Assert.True(file.Deterministic);
        Assert.Empty(system.Calls);
    }

    [Fact]
    public void Resolve_UsesTheSystemFontWhenTheCuratedFileIsNotInstalled()
    {
        var system = new FakeSystemFontSource((_, _, _) =>
            Match("Arial", path: "/x/arial.ttf", weight: 400));
        var warnings = new List<string>();
        var resolver = Resolver(ManifestWith(missingFile: true), system: system, warnings: warnings);

        var file = resolver.Resolve("f", 400, italic: false);

        Assert.Equal(FontSourceKind.System, file.Source);
        Assert.False(file.Deterministic);
        Assert.Equal("Arial", file.Family);
        Assert.Equal("/x/arial.ttf", file.Path);
        Assert.Equal(SystemFontOrigin.FileProbe, file.SystemOrigin);
        Assert.Equal(["Manifest Family", "Öteki"], system.Calls.Single());

        var warning = Assert.Single(warnings);
        Assert.Contains("SİSTEM FONTU", warning, StringComparison.Ordinal);
        Assert.Contains("BELİRLENİMCİ DEĞİLDİR", warning, StringComparison.Ordinal);
        Assert.Contains("fetch-fonts", warning, StringComparison.Ordinal);
    }

    [Fact]
    public void Resolve_WarnsOncePerDistinctFontNotOncePerClip()
    {
        var system = new FakeSystemFontSource((_, _, _) => Match("Arial"));
        var warnings = new List<string>();
        var resolver = Resolver(ManifestWith(missingFile: true), system: system, warnings: warnings);

        resolver.Resolve("f", 400, italic: false);
        resolver.Resolve("f", 400, italic: false);
        resolver.Resolve("f", 400, italic: false);

        Assert.Single(warnings);
        // Sistem araması da klip başına tekrarlanmaz (dizin taraması + typeface açma pahalıdır).
        Assert.Single(system.Calls);
    }

    [Fact]
    public void Resolve_SystemMatchWithoutItalic_IsFlaggedAsSyntheticNotSilent()
    {
        var system = new FakeSystemFontSource((_, _, italic) => Match("Arial", italic: false));
        var resolver = Resolver(ManifestWith(missingFile: true), system: system);

        var file = resolver.Resolve("f", 400, italic: true);

        Assert.True(file.SyntheticItalic);
        Assert.True(file.RequestedItalic);
    }

    [Fact]
    public void Resolve_SystemMatchWithAnotherWeight_IsFlaggedAsSubstituted()
    {
        var system = new FakeSystemFontSource((_, _, _) => Match("Arial", weight: 400));
        var resolver = Resolver(ManifestWith(missingFile: true), system: system);

        var file = resolver.Resolve("f", 700, italic: false);

        Assert.True(file.SubstitutedWeight);
        Assert.Equal(400, file.ResolvedWeight);
        Assert.Equal(700, file.RequestedWeight);
    }

    [Fact]
    public void Resolve_PassesTheRequestedWeightAndSlantToTheSystemSource()
    {
        var system = new FakeSystemFontSource((_, _, _) => Match("Arial"));
        Resolver(ManifestWith(missingFile: true), system: system).Resolve("f", 700, italic: true);

        Assert.Equal(700, system.LastWeight);
        Assert.True(system.LastItalic);
    }

    // ───────────────────────── Sistem de yoksa: eski hata ─────────────────────────

    [Fact]
    public void Resolve_NoSystemMatch_StillFailsWithFontMissingAndListsWhatWasTried()
    {
        var system = new FakeSystemFontSource((_, _, _) => null);
        var resolver = Resolver(ManifestWith(missingFile: true), system: system);

        var ex = Assert.Throws<FontNotFoundException>(() => resolver.Resolve("f", 400, false));

        Assert.Equal("font-missing", ex.Code);
        Assert.Contains("Manifest Family", ex.Message, StringComparison.Ordinal);
        Assert.Contains("Fonts:SystemFallback:f", ex.Message, StringComparison.Ordinal);
        Assert.Contains("fetch-fonts", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Resolve_SystemFallbackDisabled_KeepsTheDeterministicFailure()
    {
        var system = new FakeSystemFontSource((_, _, _) => Match("Arial"));
        var resolver = Resolver(
            ManifestWith(missingFile: true),
            options: new FontOptions { AllowSystemFallback = false },
            system: system);

        var ex = Assert.Throws<FontNotFoundException>(() => resolver.Resolve("f", 400, false));

        Assert.Equal("font-missing", ex.Code);
        Assert.Contains("AllowSystemFallback=false", ex.Message, StringComparison.Ordinal);
        Assert.Empty(system.Calls);
    }

    [Fact]
    public void Resolve_UnknownFontId_NeverFallsBackToTheSystem()
    {
        // Manifest'te olmayan fontId bir ŞEMA ihlalidir (eksik kurulum değil): sistem fontuyla
        // örtülürse şemadaki fontId sözleşmesi anlamını yitirir.
        var system = new FakeSystemFontSource((_, _, _) => Match("Arial"));
        var resolver = Resolver(ManifestWith(missingFile: true), system: system);

        var ex = Assert.Throws<FontNotFoundException>(() => resolver.Resolve("boyle-font-yok", 400, false));

        Assert.Equal("font-missing", ex.Code);
        Assert.Empty(system.Calls);
    }

    [Fact]
    public void Resolve_Sha256PinViolation_IsNotPapredOverWithASystemFont()
    {
        // Dosya VAR ama pin tutmuyor → FontLoadException. Sistem fontuna düşmek, değiştirilmiş
        // bir font dosyasını sessizce örtmek olurdu.
        Touch("f/Regular.ttf", [1, 2, 3]);
        var manifest = OverlayTestDocs.WriteManifest(dir, new
        {
            manifestVersion = 1,
            fonts = new
            {
                f = new
                {
                    family = "F",
                    files = new Dictionary<string, string> { ["400"] = "f/Regular.ttf" },
                    sha256 = new Dictionary<string, string> { ["400"] = new string('a', 64) },
                },
            },
        });
        var system = new FakeSystemFontSource((_, _, _) => Match("Arial"));

        Assert.Throws<FontLoadException>(() => Resolver(manifest, system: system).Resolve("f", 400, false));
        Assert.Empty(system.Calls);
    }

    // ───────────────────────── Gerçek sistem font kaynağı ─────────────────────────

    [SystemFontFact]
    public void SkiaSystemFontSource_ResolvesAnInstalledFamily()
    {
        var match = SystemFontProbe.Match!;

        Assert.False(string.IsNullOrWhiteSpace(match.Family));
        Assert.True(match.Weight is > 0 and <= 1000);
        if (match.FilePath is not null)
        {
            Assert.True(File.Exists(match.FilePath), $"bulunan yol gerçek olmalı: {match.FilePath}");
        }
    }

    [SystemFontFileFact]
    public void SkiaSystemFontSource_ResolvesAnAbsolutePathAsIs()
    {
        var path = SystemFontProbe.AnyFontFile;

        var match = new SkiaSystemFontSource().Match([path!], 400, italic: false);

        Assert.NotNull(match);
        Assert.Equal(SystemFontOrigin.ConfiguredPath, match!.Origin);
        Assert.Equal(Path.GetFullPath(path!), match.FilePath);
    }

    [Fact]
    public void SkiaSystemFontSource_UnknownFamily_ReturnsNullInsteadOfADefaultFont()
    {
        // MatchFamily bazı platformlarda "iyi eşleşme yok" yerine varsayılan aileyi döndürür;
        // sessizce başka bir fontla çizmek yerine null dönmeliyiz.
        var source = new SkiaSystemFontSource();

        Assert.Null(source.Match(["Zzz Boyle Bir Aile Yok 12345"], 400, italic: false));
    }

    [FontManagerFact]
    public void SkiaSystemFontSource_FontManagerRoute_ResolvesFromTheFamilyNameAlone()
    {
        // Dizin taraması KAPALI (hiç dizin yok) → tek yol SKFontManager.Default.MatchFamily.
        var family = FontManagerFactAttribute.AnyFamily!;
        var source = new SkiaSystemFontSource([], useFontManager: true);

        var match = source.Match([family], 700, italic: false);

        Assert.NotNull(match);
        Assert.Equal(SystemFontOrigin.FontManager, match!.Origin);
        Assert.Null(match.FilePath); // yol bilinmez: typeface font yöneticisinden açılır
        Assert.Equal(
            SkiaSystemFontSource.Normalize(family),
            SkiaSystemFontSource.Normalize(match.Family));
    }

    [Fact]
    public void SkiaSystemFontSource_EmptyDirectoryListing_IsHarmless()
    {
        var source = new SkiaSystemFontSource([Path.Combine(dir, "yok-boyle-dizin")], useFontManager: false);

        Assert.Null(source.Match(["Arial"], 400, italic: false));
        Assert.Contains("yok-boyle-dizin", source.Describe(), StringComparison.Ordinal);
    }

    [SystemFontFileFact]
    public void SkiaSystemFontSource_FileProbe_FindsFontsInAConfiguredDirectory()
    {
        var path = SystemFontProbe.AnyFontFile;

        // Font yöneticisi KAPALI: yalnız dizin taraması (worker'ın Linux imajındaki tek yol —
        // NativeAssets.Linux.NoDependencies'te SKFontManager boştur).
        var directory = Path.GetDirectoryName(path!)!;
        var family = SystemFontProbe.AnyFontFamily!;
        var source = new SkiaSystemFontSource([directory], useFontManager: false);

        var match = source.Match([family], 400, italic: false);

        Assert.NotNull(match);
        Assert.Equal(SystemFontOrigin.FileProbe, match!.Origin);
        Assert.NotNull(match.FilePath);
        Assert.True(File.Exists(match.FilePath));
    }

    // ───────────────────────── Uçtan uca raster (gerçek sistem fontu) ─────────────────────────

    [SystemFontFact]
    public async Task Render_WithoutCuratedFonts_SucceedsViaTheSystemFontAndFlagsIt()
    {
        using var service = SystemFontService(out _);
        var clip = OverlayTestDocs.Text("Merhaba VideoEdit", fontId: "roboto", fontSizePx: 48);

        var result = await service.RenderAsync(clip, OverlayTestDocs.Settings(), Path.Combine(dir, "sys.png"));

        // 1) Render BAŞARILI: metin klibi olan export artık 'font-missing' ile düşmez.
        Assert.True(File.Exists(result.Path));
        Assert.True(result.ByteSize > 0);

        // 2) bbox MAKUL: 17 karakterlik tek satır 48 px'te ~kare değil, geniş ve tek satır
        //    yüksekliğinde. (Piksel golden'ı YOK — sistem fontu makineye göre değişir.)
        Assert.Single(result.Lines);
        Assert.InRange(result.BboxHeightPx, 20d, 120d);
        Assert.InRange(result.BboxWidthPx, 100d, 1200d);
        Assert.True(result.BboxWidthPx > result.BboxHeightPx * 2,
            $"tek satırlık uzun metin geniş olmalı ({result.BboxWidthPx}×{result.BboxHeightPx})");
        Assert.Equal(result.Width, (int)Math.Ceiling(result.BboxWidthPx * 2)); // @2x kuralı korunur

        // 3) Glif EKSİK DEĞİL: sistem fontu Latin alfabesini kapsıyor.
        Assert.False(result.HasMissingGlyphs);

        // 4) Kaynak İŞARETLİ + belirlenimcilik uyarısı sonuçla birlikte taşınıyor.
        Assert.Equal(FontSourceKind.System, result.FontSource);
        Assert.False(result.Deterministic);
        Assert.False(string.IsNullOrWhiteSpace(result.FontFamily));
        Assert.Contains("BELİRLENİMCİ DEĞİLDİR", result.FontWarning!, StringComparison.Ordinal);
    }

    [SystemFontFact]
    public async Task Render_WithSystemFont_IsStillRepeatableOnTheSameMachine()
    {
        // Belirlenimcilik MAKİNELER ARASI kaybolur; aynı makinede aynı girdi yine aynı baytları
        // vermeli (cache/shaping durumu çıktıyı etkilemesin).
        using var service = SystemFontService(out _);
        var clip = OverlayTestDocs.Text("Aynı", fontId: "roboto",
            id: Guid.Parse("33333333-3333-3333-3333-333333333333"));

        var first = await service.RenderAsync(clip, OverlayTestDocs.Settings(), Path.Combine(dir, "a.png"));
        var second = await service.RenderAsync(clip, OverlayTestDocs.Settings(), Path.Combine(dir, "b.png"));

        Assert.Equal(first.Sha256, second.Sha256);
    }

    [SystemFontFact]
    public void Measure_WorksWithASystemFont()
    {
        using var service = SystemFontService(out _);

        var layout = service.Measure(
            OverlayTestDocs.Text("iki\nsatır", fontId: "roboto").Text!, OverlayTestDocs.Settings());

        Assert.Equal(2, layout.Lines.Count);
        Assert.True(layout.BboxHeightPx > 0);
    }

    [SystemFontFact]
    public async Task Render_WithAppsettingsOverride_UsesTheConfiguredFamily()
    {
        var family = SystemFontProbe.AnyFontFamily!;
        var manifest = MissingCuratedManifest(systemFallback: ["Zzz Yok Boyle Aile"]);
        using var service = new SkiaOverlayRasterService(
            new TextRasterOptions(),
            manifest,
            // appsettings 'Fonts:SystemFallback:roboto' karşılığı — manifest eşlemesini EZER.
            new FontOptions { SystemFallback = { ["roboto"] = family } });

        var result = await service.RenderAsync(
            OverlayTestDocs.Text("Ezme", fontId: "roboto"), OverlayTestDocs.Settings(),
            Path.Combine(dir, "override.png"));

        Assert.Equal(FontSourceKind.System, result.FontSource);
        Assert.Equal(
            SkiaSystemFontSource.Normalize(family),
            SkiaSystemFontSource.Normalize(result.FontFamily!));
    }

    [Fact]
    public async Task Render_WithNeitherCuratedNorSystemFont_FailsWithFontMissing()
    {
        using var service = new SkiaOverlayRasterService(
            new TextRasterOptions(),
            MissingCuratedManifest(systemFallback: ["Zzz Yok Boyle Aile"]),
            new FontOptions(),
            new FakeSystemFontSource((_, _, _) => null));

        var ex = await Assert.ThrowsAsync<FontNotFoundException>(() => service.RenderAsync(
            OverlayTestDocs.Text("x", fontId: "roboto"), OverlayTestDocs.Settings(),
            Path.Combine(dir, "yok.png")));

        Assert.Equal("font-missing", ex.Code);
    }

    // ───────────────────────── yardımcılar ─────────────────────────

    private SkiaOverlayRasterService SystemFontService(out FontManifest manifest)
    {
        manifest = MissingCuratedManifest([SystemFontProbe.AnyFontFamily!]);
        // FontOptions AÇIKÇA verilir: testler makinedeki Fonts__* ortam değişkenlerine bağlı olmasın.
        return new SkiaOverlayRasterService(new TextRasterOptions(), manifest, new FontOptions());
    }

    /// <summary>Küratörlü dosyası KURULU OLMAYAN (indirilmemiş) üretim benzeri manifest.</summary>
    private FontManifest MissingCuratedManifest(string[] systemFallback) =>
        OverlayTestDocs.WriteManifest(dir, new
        {
            manifestVersion = 1,
            fonts = new
            {
                roboto = new
                {
                    family = "Roboto",
                    version = "classic-hinted",
                    license = "Apache-2.0",
                    files = new Dictionary<string, string>
                    {
                        ["400"] = "roboto/Roboto-Regular.ttf",
                        ["700"] = "roboto/Roboto-Bold.ttf",
                    },
                    systemFallback,
                },
            },
        });

    private FontManifest ManifestWith(bool missingFile) => OverlayTestDocs.WriteManifest(dir, new
    {
        manifestVersion = 1,
        fonts = new
        {
            f = new
            {
                family = "F",
                files = new Dictionary<string, string>
                {
                    ["400"] = missingFile ? "f/Yok.ttf" : "f/Regular.ttf",
                },
                systemFallback = new[] { "Manifest Family", "Öteki" },
            },
        },
    });

    private FontResolver Resolver(
        FontManifest manifest,
        FontOptions? options = null,
        ISystemFontSource? system = null,
        List<string>? warnings = null) =>
        new(manifest, options ?? new FontOptions(), system, warnings is null ? null : warnings.Add);

    private static SystemFontMatch Match(
        string family, string? path = null, int weight = 400, bool italic = false) =>
        new(family, family, path, weight, italic,
            path is null ? SystemFontOrigin.FontManager : SystemFontOrigin.FileProbe);

    private string Touch(string relative, byte[]? content = null)
    {
        var path = Path.Combine(dir, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, content ?? [0x00, 0x01, 0x02]);
        return path;
    }
}

/// <summary>Sahte sistem font kaynağı — çağrıları kaydeder (fallback'in ne zaman denendiği).</summary>
internal sealed class FakeSystemFontSource(
    Func<IReadOnlyList<string>, int, bool, SystemFontMatch?> match) : ISystemFontSource
{
    public List<IReadOnlyList<string>> Calls { get; } = [];

    public int LastWeight { get; private set; }

    public bool LastItalic { get; private set; }

    public SystemFontMatch? Match(IReadOnlyList<string> families, int weight, bool italic)
    {
        Calls.Add(families.ToList());
        LastWeight = weight;
        LastItalic = italic;
        return match(families, weight, italic);
    }

    public string Describe() => "sahte sistem font kaynağı";
}

/// <summary>
/// Bu makinede gerçekten kurulu bir sistem fontu var mı (testler için tek keşif noktası).
/// Aday aileler kasten Windows + Linux + macOS karışımıdır.
/// </summary>
internal static class SystemFontProbe
{
    private static readonly Lazy<SystemFontMatch?> Found = new(() =>
        SkiaSystemFontSource.Shared.Match(
            ["Arial", "Segoe UI", "Verdana", "Tahoma", "Times New Roman", "DejaVu Sans",
             "Liberation Sans", "Noto Sans", "Roboto", "Helvetica"],
            400, italic: false));

    public static SystemFontMatch? Match => Found.Value;

    public static bool Available => Found.Value is not null;

    /// <summary>Bulunan ailenin GERÇEK adı (typeface'ten okunmuş).</summary>
    public static string? AnyFontFamily => Found.Value?.Family;

    /// <summary>Yolu bilinen bir dosya (font yöneticisinden gelen eşleşmede null olabilir).</summary>
    public static string? AnyFontFile => Found.Value?.FilePath;
}

/// <summary>
/// Gerçek bir SİSTEM fontu gerektiren testler. Sistem fontu olmayan (ör. çok yalın kapsayıcı)
/// makinelerde atlanır — CI'da zorlamak için <c>VIDEOEDIT_FONT_TESTS=1</c>.
/// </summary>
public sealed class SystemFontFactAttribute : FactAttribute
{
    public SystemFontFactAttribute()
    {
        if (!SystemFontProbe.Available
            && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("VIDEOEDIT_FONT_TESTS")))
        {
            Skip = "Bu makinede kurulu bir sistem fontu bulunamadı (SKFontManager + font dizinleri boş).";
        }
    }
}

/// <summary>
/// <c>SKFontManager</c> yolunu doğrulayan testler. Worker'ın Linux imajı
/// <c>SkiaSharp.NativeAssets.Linux.NoDependencies</c> kullandığı için orada font yöneticisi
/// BOŞTUR (fontconfig yok) — bu testler atlanır, dosya taraması yolu geçerli kalır.
/// </summary>
public sealed class FontManagerFactAttribute : FactAttribute
{
    private static readonly Lazy<string?> Family = new(() =>
    {
        try
        {
            return SKFontManager.Default?.FontFamilies?
                .FirstOrDefault(f => !string.IsNullOrWhiteSpace(f));
        }
        catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException)
        {
            return null;
        }
    });

    /// <summary>Font yöneticisinin bildiği herhangi bir aile (yoksa null → test atlanır).</summary>
    public static string? AnyFamily => Family.Value;

    public FontManagerFactAttribute()
    {
        if (AnyFamily is null)
        {
            Skip = "SKFontManager bu makinede hiç aile bilmiyor (ör. Linux NoDependencies yapısı).";
        }
    }
}

/// <summary>
/// Yalnız DOSYA YOLU bilinen bir sistem fontu varken anlamlı testler (font yöneticisinden gelen
/// eşleşmede yol yoktur).
/// </summary>
public sealed class SystemFontFileFactAttribute : FactAttribute
{
    public SystemFontFileFactAttribute()
    {
        if (SystemFontProbe.AnyFontFile is null)
        {
            Skip = "Dosya yolu bilinen bir sistem fontu bulunamadı (yalnız SKFontManager eşleşmesi var).";
        }
    }
}
