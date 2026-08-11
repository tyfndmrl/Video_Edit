using System.Text.Json;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// Font manifesti = <c>fontId</c> sözleşmesi (rendering-semantics §7). Bu testler font dosyası
/// GEREKTİRMEZ: eşleşme kuralı saf, dosya varlığı sahte (boş) dosyalarla kurulur.
/// Sabitlenen davranışlar: deterministik stil eşleşmesi, SESSİZ FALLBACK YOKLUĞU (eksik font
/// hatası), sha256 sürüm pini ve depodaki gerçek manifestin sağlığı.
/// </summary>
public sealed class FontManifestTests : IDisposable
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

    private string Touch(string relative, byte[]? content = null)
    {
        var path = Path.Combine(dir, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, content ?? [0x00, 0x01, 0x02]);
        return path;
    }

    private FontManifest Manifest(object fonts) =>
        OverlayTestDocs.WriteManifest(dir, new { manifestVersion = 1, fonts });

    // ---------- Yükleme / doğrulama ----------

    [Fact]
    public void Load_MissingFile_ExplainsWhereItLooked()
    {
        var path = Path.Combine(dir, "yok", TextRasterOptions.ManifestFileName);
        var ex = Assert.Throws<FontManifestException>(() => FontManifest.Load(path));

        Assert.Contains(path, ex.Message, StringComparison.Ordinal);
        Assert.Equal("font-manifest-invalid", ex.Code);
    }

    [Fact]
    public void Load_BrokenJson_FailsWithTypedError()
    {
        var path = Path.Combine(dir, TextRasterOptions.ManifestFileName);
        File.WriteAllText(path, "{ this is not json");

        Assert.Throws<FontManifestException>(() => FontManifest.Load(path));
    }

    [Fact]
    public void Load_UnknownManifestVersion_IsRejected()
    {
        var path = Path.Combine(dir, TextRasterOptions.ManifestFileName);
        File.WriteAllText(path, JsonSerializer.Serialize(new { manifestVersion = 2, fonts = new { } }));

        var ex = Assert.Throws<FontManifestException>(() => FontManifest.Load(path));
        Assert.Contains("sürümü desteklenmiyor", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Load_InvalidStyleKey_IsRejectedAtLoadTimeNotAtFirstExport()
    {
        var ex = Assert.Throws<FontManifestException>(() => Manifest(new
        {
            bad = new { family = "Bad", files = new Dictionary<string, string> { ["bold"] = "x.ttf" } },
        }));

        Assert.Contains("geçersiz stil anahtarı", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Load_EmptyFileMap_IsRejected()
    {
        Assert.Throws<FontManifestException>(() => Manifest(new
        {
            bad = new { family = "Bad", files = new Dictionary<string, string>() },
        }));
    }

    // ---------- Stil eşleşmesi (saf kural) ----------

    [Theory]
    [InlineData(400, false, "400")]
    [InlineData(700, true, "700i")]
    [InlineData(400, true, "400i")]
    public void PickStyle_PrefersExactMatch(int weight, bool italic, string expected)
    {
        FontStyleKey[] available = [new(400, false), new(400, true), new(700, false), new(700, true)];

        var picked = FontManifest.PickStyle(new FontStyleKey(weight, italic), available);

        Assert.Equal(expected, picked.ToKey());
    }

    [Fact]
    public void PickStyle_FallsBackToNearestWeightWithinTheRequestedSlant()
    {
        FontStyleKey[] available = [new(300, false), new(700, false), new(300, true)];

        // 500 → |500-300|=200, |500-700|=200 → EŞİTLİKTE DÜŞÜK ağırlık kazanır (belirlenimci).
        Assert.Equal("300", FontManifest.PickStyle(new FontStyleKey(500, false), available).ToKey());
        Assert.Equal("700", FontManifest.PickStyle(new FontStyleKey(650, false), available).ToKey());
        // İtalik istendi: yalnız italik havuzdan seçilir (dik 700'e kaçmaz).
        Assert.Equal("300i", FontManifest.PickStyle(new FontStyleKey(700, true), available).ToKey());
    }

    [Fact]
    public void PickStyle_FallsBackToUprightWhenNoItalicFileExists()
    {
        FontStyleKey[] available = [new(400, false), new(700, false)];

        var picked = FontManifest.PickStyle(new FontStyleKey(700, true), available);

        Assert.Equal("700", picked.ToKey());
        Assert.False(picked.Italic);
    }

    [Fact]
    public void Resolve_SyntheticItalic_IsFlaggedNotSilent()
    {
        Touch("f/Regular.ttf");
        var manifest = Manifest(new
        {
            f = new { family = "F", files = new Dictionary<string, string> { ["400"] = "f/Regular.ttf" } },
        });

        var upright = manifest.Resolve("f", 400, italic: false);
        var italic = manifest.Resolve("f", 400, italic: true);

        Assert.False(upright.SyntheticItalic);
        Assert.True(italic.SyntheticItalic);
        Assert.Equal(upright.Path, italic.Path);
    }

    [Fact]
    public void Resolve_SubstitutedWeight_IsFlagged()
    {
        Touch("f/Regular.ttf");
        var manifest = Manifest(new
        {
            f = new { family = "F", files = new Dictionary<string, string> { ["400"] = "f/Regular.ttf" } },
        });

        Assert.True(manifest.Resolve("f", 900, italic: false).SubstitutedWeight);
        Assert.False(manifest.Resolve("f", 400, italic: false).SubstitutedWeight);
    }

    // ---------- Eksik font: SESSİZ FALLBACK YOK ----------

    [Fact]
    public void Resolve_UnknownFontId_ListsTheKnownIds()
    {
        Touch("f/Regular.ttf");
        var manifest = Manifest(new
        {
            f = new { family = "F", files = new Dictionary<string, string> { ["400"] = "f/Regular.ttf" } },
        });

        var ex = Assert.Throws<FontNotFoundException>(() => manifest.Resolve("yok-boyle-font", 400, false));

        Assert.Equal("font-missing", ex.Code);
        Assert.Contains("yok-boyle-font", ex.Message, StringComparison.Ordinal);
        Assert.Contains("f", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Resolve_DeclaredButMissingFile_PointsAtTheExpectedPathAndTheFetchScript()
    {
        var manifest = Manifest(new
        {
            f = new { family = "F", files = new Dictionary<string, string> { ["400"] = "f/Regular.ttf" } },
        });

        var ex = Assert.Throws<FontNotFoundException>(() => manifest.Resolve("f", 400, false));

        Assert.Equal("font-missing", ex.Code);
        Assert.Contains(Path.Combine(dir, "f", "Regular.ttf"), ex.ExpectedPath!, StringComparison.Ordinal);
        Assert.Contains("fetch-fonts", ex.Message, StringComparison.Ordinal);
    }

    // ---------- Sürüm pini (§7) ----------

    [Fact]
    public void Resolve_InlineSha256Mismatch_IsAVersionPinViolation()
    {
        Touch("f/Regular.ttf", [1, 2, 3]);
        var manifest = Manifest(new
        {
            f = new
            {
                family = "F",
                files = new Dictionary<string, string> { ["400"] = "f/Regular.ttf" },
                sha256 = new Dictionary<string, string> { ["400"] = new string('a', 64) },
            },
        });

        var ex = Assert.Throws<FontLoadException>(() => manifest.Resolve("f", 400, false));
        Assert.Equal("font-invalid", ex.Code);
        Assert.Contains("sha256", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Resolve_MatchingSha256_Passes()
    {
        var path = Touch("f/Regular.ttf", [1, 2, 3]);
        var hash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path)));
        var manifest = Manifest(new
        {
            f = new
            {
                family = "F",
                files = new Dictionary<string, string> { ["400"] = "f/Regular.ttf" },
                sha256 = new Dictionary<string, string> { ["400"] = hash.ToUpperInvariant() },
            },
        });

        // Pin eşleşiyor → çözüm başarılı (hex karşılaştırması büyük/küçük harften bağımsızdır).
        Assert.Equal(Path.GetFullPath(path), manifest.Resolve("f", 400, false).Path);
    }

    [Fact]
    public void LockFile_PinsHashesWhenManifestHasNoInlineSha()
    {
        Touch("f/Regular.ttf", [9, 9, 9]);
        File.WriteAllText(Path.Combine(dir, FontManifest.LockFileName), JsonSerializer.Serialize(new
        {
            lockVersion = 1,
            files = new Dictionary<string, string> { ["f/400"] = new string('b', 64) },
        }));

        var manifest = Manifest(new
        {
            f = new { family = "F", files = new Dictionary<string, string> { ["400"] = "f/Regular.ttf" } },
        });

        var ex = Assert.Throws<FontLoadException>(() => manifest.Resolve("f", 400, false));
        Assert.Contains(new string('b', 64), ex.Message, StringComparison.Ordinal);
    }

    // ---------- Depodaki gerçek manifest ----------

    [Fact]
    public void RepositoryManifest_IsValidAndCurated()
    {
        var path = Path.Combine(TestVectorFiles.Resolve("fonts"), TextRasterOptions.ManifestFileName);
        Assert.True(File.Exists(path), $"Küratörlü manifest depoda olmalı: {path}");

        var manifest = FontManifest.Load(path);

        Assert.False(manifest.AllowSystemFallback,
            "Sistem fontu fallback'i AÇILAMAZ: export belirlenimciliğini bozar.");
        Assert.True(manifest.Fonts.Count >= 3, "Küratörlü set en az 3 font içermeli.");

        foreach (var (fontId, entry) in manifest.Fonts)
        {
            Assert.False(string.IsNullOrWhiteSpace(entry.Family), $"{fontId}: family boş");
            Assert.False(string.IsNullOrWhiteSpace(entry.Version), $"{fontId}: version (pin) boş");
            Assert.True(entry.License is "OFL-1.1" or "Apache-2.0",
                $"{fontId}: lisans küratörlü set kuralına uymuyor ({entry.License})");
            Assert.Contains("400", entry.Files.Keys);
            Assert.Contains("700", entry.Files.Keys);

            foreach (var key in entry.Files.Keys)
            {
                Assert.True(entry.Urls.ContainsKey(key),
                    $"{fontId}/{key}: fetch scripti için 'urls' girdisi eksik");
                Assert.StartsWith("https://", entry.Urls[key], StringComparison.Ordinal);
            }

            // SkiaSharp 3.116.1'de eksen sabitleme yok → küratörlü set STATİK olmalı.
            Assert.Null(entry.VariableAxes);

            // TTF indirilmemiş kurulumda metin export'unun düşmemesi için her fontId'nin
            // sistem karşılığı TANIMLI olmalı; ilk aday fontun KENDİ ailesidir (kuruluysa
            // görsel olarak en yakın sonuç) — fonts/README.md "üç mod".
            Assert.NotNull(entry.SystemFallback);
            Assert.NotEmpty(entry.SystemFallback!);
            Assert.Equal(entry.Family, entry.SystemFallback![0]);
            Assert.Equal(
                entry.SystemFallback!,
                FontFallbackPolicy.Candidates(fontId, new FontOptions(), entry));
        }
    }

    [Fact]
    public void FontRootLocator_FindsTheRepositoryFontsDirectory()
    {
        var located = FontRootLocator.Locate();

        Assert.True(File.Exists(Path.Combine(located, TextRasterOptions.ManifestFileName)),
            $"Font kökü bulunamadı: {located}");
    }

    [Fact]
    public void FontRootLocator_PrefersExplicitConfiguration()
    {
        Assert.Equal(Path.GetFullPath(dir), FontRootLocator.Locate(dir));
    }
}
