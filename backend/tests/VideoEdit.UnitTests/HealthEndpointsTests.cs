using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using VideoEdit.Api.Endpoints;
using VideoEdit.Media.Text;

namespace VideoEdit.UnitTests;

/// <summary>
/// <c>GET /health</c> font kökü raporu — yarım-iş #13. Senkron 503 metin kapısı "API ile
/// worker AYNI font kökünü görür" varsayımına dayanır (docs/poc-bilinen-sinirlar.md §3.3);
/// bu testler varsayımı doğrulanabilir kılan raporun üç yarısını sabitler: (1) kurulu kökte
/// sayılar + parmak izi dürüst döner, (2) kök YOKKEN uç 200 kalır ama <c>found:false</c> +
/// sebep raporlar (sağlık kapısı değil, dürüst rapor), (3) parmak izi türetimi
/// <c>manifest.lock.json</c> pinleriyle tutarlıdır ve sözlük sırasından bağımsızdır —
/// worker açılış logu AYNI türetimi yazdığı için iki tarafın karşılaştırılabilirliği
/// bu sözleşmeye bağlıdır.
/// </summary>
public sealed class HealthEndpointsTests : IDisposable
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

    // ---------- GET /health: kurulu kök ----------

    [Fact]
    public void Health_WithAnInstalledRoot_ReportsCountsAndFingerprint()
    {
        // 2 fontId, 3 tanımlı dosya; yalnız 2'si diskte — rapor "3 tanımlı / 2 mevcut" demeli
        // (eski davranış: manifest yüklendi = sağlıklı görünüyordu, TTF'ler hiç sayılmıyordu).
        File.WriteAllText(Path.Combine(Directory.CreateDirectory(dir).FullName, FontManifest.LockFileName),
            JsonSerializer.Serialize(new
            {
                lockVersion = 1,
                files = new Dictionary<string, string>
                {
                    ["alpha/400"] = new string('a', 64),
                    ["alpha/700i"] = new string('b', 64),
                    ["beta/400"] = new string('c', 64),
                },
            }));
        var manifest = OverlayTestDocs.WriteManifest(dir, new
        {
            manifestVersion = 1,
            fonts = new
            {
                alpha = new
                {
                    family = "Alpha Sans",
                    files = new Dictionary<string, string>
                    {
                        ["400"] = "alpha/Alpha-Regular.ttf",
                        ["700i"] = "alpha/Alpha-BoldItalic.ttf",
                    },
                },
                beta = new
                {
                    family = "Beta Serif",
                    files = new Dictionary<string, string> { ["400"] = "beta/Beta.ttf" },
                },
            },
        });
        Touch("alpha/Alpha-Regular.ttf");
        Touch("beta/Beta.ttf");

        var result = HealthEndpoints.GetHealth(FontManifestProvider.Preloaded(manifest));

        var ok = Assert.IsType<Ok<HealthResponse>>(result);
        Assert.Equal("ok", ok.Value!.Status);
        var fonts = ok.Value.Fonts;
        Assert.True(fonts.Found);
        Assert.Equal(manifest.RootDirectory, fonts.Root);
        Assert.Equal(2, fonts.FontIds);
        Assert.Equal(3, fonts.FilesDeclared);
        Assert.Equal(2, fonts.FilesPresent);
        Assert.Null(fonts.Error);
        // Parmak izi lock pinlerinden türer; 64 küçük harf hex.
        Assert.Equal(FontRootHealth.FingerprintOf(manifest), fonts.Fingerprint);
        Assert.Matches("^[0-9a-f]{64}$", fonts.Fingerprint!);
    }

    [Fact]
    public void Health_FilesPresent_IsCountedLive_NotFrozenAtLoad()
    {
        // Manifest bir kez okunur ama TTF'ler API açıkken indirilebilir: rapor diskteki
        // ANLIK durumu saymalı — işletmeci kurulumu düzeltince /health restart'sız yeşerir.
        var manifest = OverlayTestDocs.WriteManifest(dir, new
        {
            manifestVersion = 1,
            fonts = new
            {
                alpha = new
                {
                    family = "Alpha Sans",
                    files = new Dictionary<string, string> { ["400"] = "alpha/Alpha-Regular.ttf" },
                },
            },
        });
        var provider = FontManifestProvider.Preloaded(manifest);

        var before = Assert.IsType<Ok<HealthResponse>>(HealthEndpoints.GetHealth(provider)).Value!;
        Assert.Equal(0, before.Fonts.FilesPresent);

        Touch("alpha/Alpha-Regular.ttf");
        var after = Assert.IsType<Ok<HealthResponse>>(HealthEndpoints.GetHealth(provider)).Value!;
        Assert.Equal(1, after.Fonts.FilesPresent);
        // Parmak izi ise manifestle donuktur: dosya inmesi pin setini değiştirmez.
        Assert.Equal(before.Fonts.Fingerprint, after.Fonts.Fingerprint);
    }

    // ---------- GET /health: kök yok ----------

    [Fact]
    public void Health_WithoutManifest_Stays200ButReportsHonestly()
    {
        // Font eksikliği API'yi UNHEALTHY yapmaz (metin klibi olmayan projeler fontsuz da
        // çalışır) — ama rapor yalan söylemez: found:false + bakılan yol + sebep.
        var expectedPath = Path.Combine(dir, TextRasterOptions.ManifestFileName);
        var provider = FontManifestProvider.Preloaded(
            null, $"Font manifesti bulunamadı: {expectedPath}.");

        var result = HealthEndpoints.GetHealth(provider);

        var ok = Assert.IsType<Ok<HealthResponse>>(result);
        Assert.Equal("ok", ok.Value!.Status);
        var fonts = ok.Value.Fonts;
        Assert.False(fonts.Found);
        Assert.Equal(0, fonts.FontIds);
        Assert.Equal(0, fonts.FilesDeclared);
        Assert.Equal(0, fonts.FilesPresent);
        Assert.Null(fonts.Fingerprint);
        Assert.Contains("bulunamadı", fonts.Error, StringComparison.Ordinal);
    }

    // ---------- Parmak izi sözleşmesi ----------

    [Fact]
    public void Fingerprint_MatchesTheRepoManifestLock()
    {
        // Depodaki GERÇEK manifest + lock: (a) lock'un pin kümesi manifestin tanımlı stil
        // kümesiyle birebir aynı, (b) parmak izi belgelenen türetimin BAĞIMSIZ yeniden
        // hesabıyla aynı. Bu türetim worker logu ile /health'in ortak dili olduğundan
        // sessizce değişemez — değişecekse iki taraf + bu test birlikte değişir.
        var provider = new FontManifestProvider();
        Assert.NotNull(provider.Manifest);
        var manifest = provider.Manifest!;

        var lockPath = Path.Combine(manifest.RootDirectory, FontManifest.LockFileName);
        Assert.True(File.Exists(lockPath), $"Depoda lock dosyası bekleniyordu: {lockPath}");
        var lockPins = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(lockPath))
            .GetProperty("files").EnumerateObject()
            .ToDictionary(p => p.Name, p => p.Value.GetString()!, StringComparer.Ordinal);

        var declared = manifest.Fonts
            .SelectMany(f => f.Value.Files.Keys.Select(k => (Key: $"{f.Key}/{k}", f.Value.Sha256, Style: k)))
            .ToList();
        Assert.Equal(
            declared.Select(d => d.Key).Order(StringComparer.Ordinal),
            lockPins.Keys.Order(StringComparer.Ordinal));

        // Bağımsız yeniden hesap (sözleşme: manifest içi sha256 önce, yoksa lock; boşsa boş).
        var lines = declared
            .Select(d => d.Sha256.TryGetValue(d.Style, out var inline) && !string.IsNullOrWhiteSpace(inline)
                ? $"{d.Key}={inline.Trim().ToLowerInvariant()}"
                : $"{d.Key}={lockPins[d.Key].Trim().ToLowerInvariant()}")
            .Order(StringComparer.Ordinal);
        var expected = Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', lines))));

        Assert.Equal(expected, FontRootHealth.FingerprintOf(manifest));
    }

    [Fact]
    public void Fingerprint_IsOrderIndependent_ButPinAndSetSensitive()
    {
        var forward = InMemoryManifest(("alpha", "400", "p1"), ("alpha", "700i", "p2"), ("beta", "400", "p3"));
        var reversed = InMemoryManifest(("beta", "400", "p3"), ("alpha", "700i", "p2"), ("alpha", "400", "p1"));
        // Sözlük ekleme sırası türetimi DEĞİŞTİRMEZ — iki süreç aynı içeriği farklı sırayla
        // okusa da parmak izleri karşılaştırılabilir kalır.
        Assert.Equal(FontRootHealth.FingerprintOf(forward), FontRootHealth.FingerprintOf(reversed));

        // Tek pin değişirse (lock/dosya sürümü ayrıştı) parmak izi değişir...
        var pinChanged = InMemoryManifest(("alpha", "400", "BAŞKA"), ("alpha", "700i", "p2"), ("beta", "400", "p3"));
        Assert.NotEqual(FontRootHealth.FingerprintOf(forward), FontRootHealth.FingerprintOf(pinChanged));

        // ...stil kümesi değişirse de değişir (pin'i hiç olmayan taraf da yakalanır).
        var styleMissing = InMemoryManifest(("alpha", "400", "p1"), ("beta", "400", "p3"));
        Assert.NotEqual(FontRootHealth.FingerprintOf(forward), FontRootHealth.FingerprintOf(styleMissing));

        // Pin'siz manifest (lock yok + inline yok) pinli olandan farklı görünür: "lock'u
        // olmayan" kurulum sağlıklı kurulumla aynı parmak izini TAKLİT EDEMEZ.
        var unpinned = InMemoryManifest(("alpha", "400", null), ("alpha", "700i", null), ("beta", "400", null));
        Assert.NotEqual(FontRootHealth.FingerprintOf(forward), FontRootHealth.FingerprintOf(unpinned));
    }

    // ---------- Yardımcılar ----------

    private void Touch(string relative)
    {
        var path = Path.Combine(dir, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, [0x00, 0x01, 0x02]);
    }

    private static FontManifest InMemoryManifest(params (string Id, string Style, string? Pin)[] styles)
    {
        var fonts = new Dictionary<string, FontEntry>(StringComparer.Ordinal);
        foreach (var (id, style, pin) in styles)
        {
            if (!fonts.TryGetValue(id, out var entry))
            {
                fonts[id] = entry = new FontEntry { Family = id };
            }

            entry.Files[style] = $"{id}/{style}.ttf";
            if (pin is not null)
            {
                entry.Sha256[style] = pin;
            }
        }

        return new FontManifest { ManifestVersion = 1, Fonts = fonts, RootDirectory = Path.GetTempPath() };
    }
}
