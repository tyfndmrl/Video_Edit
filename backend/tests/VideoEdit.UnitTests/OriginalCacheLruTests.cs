using Microsoft.Extensions.Options;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// LRU SÜPÜRMESİNİN İLK GERÇEK ÖLÇÜMÜ (12. tur borcu "[AÇIK — DÜŞÜK] LRU cache SÜPÜRMESİ
/// ölçülmedi"): tavan test-yerel küçük bir değere indirilir ve süpürmenin
///  (1) tavan aşılınca EN ESKİ damgalı girdiyi sildiği,
///  (2) yakın zamanda KULLANILAN (cache isabetiyle damgası tazelenen) girdiyi koruduğu,
///  (3) PİNLİ (koşan export'un) girdiyi en eski olsa bile atladığı,
///  (4) tavana inince DURDUĞU (her şeyi silmediği)
/// gerçek MinIO indirmeleriyle ölçülür. Negatif kontrol: pin OLMADAN aynı kurulumda en eski
/// girdi gerçekten silinir — yani (3)'ün yeşili pinin eseridir, tesadüf değil.
/// </summary>
public sealed class OriginalCacheLruTests : IDisposable
{
    private const long EntryBytes = 100_000;
    private const long CacheCap = 250_000; // 2 girdi sığar, 3.sü süpürme tetikler

    private readonly R2StorageService _storage;
    private readonly string _cacheDir;
    private readonly Guid _owner = Guid.CreateVersion7();
    private readonly string _prefix;

    public OriginalCacheLruTests()
    {
        _storage = new R2StorageService(Options.Create(new R2Options
        {
            ServiceUrl = "http://localhost:9000",
            AccessKeyId = "videoedit",
            SecretAccessKey = "devpassword123",
            Bucket = "videoedit-media-lru-e2e",
            ExportsBucket = "",
        }));
        _cacheDir = Directory.CreateTempSubdirectory("videoedit-lru-e2e-").FullName;
        _prefix = $"u/{_owner}";
    }

    public void Dispose()
    {
        try
        {
            _storage.DeletePrefixAsync(_prefix).GetAwaiter().GetResult();
        }
        catch
        {
            // best-effort
        }

        try
        {
            Directory.Delete(_cacheDir, recursive: true);
        }
        catch
        {
            // best-effort
        }

        _storage.Dispose();
    }

    private OriginalCache CreateCache(long maxCacheBytes) => new(_storage, new ProcessingOptions
    {
        CacheDirectory = _cacheDir,
        MaxCacheBytes = maxCacheBytes,
    });

    private async Task<(Guid Id, string Key)> SeedObjectAsync(byte fill)
    {
        var id = Guid.CreateVersion7();
        var key = $"{_prefix}/a/{id}/original/source.bin";
        var local = Path.Combine(_cacheDir, $"seed-{id:N}.bin");
        var payload = new byte[EntryBytes];
        Array.Fill(payload, fill);
        await File.WriteAllBytesAsync(local, payload);
        await _storage.UploadFileAsync(key, local, "application/octet-stream");
        File.Delete(local);
        return (id, key);
    }

    private string EntryFile(Guid id) => Path.Combine(_cacheDir, id.ToString("N"), "original.bin");

    /// <summary>LRU damgasını deterministik kurar (dosya sistemi tick çözünürlüğüne güvenilmez).</summary>
    private void Stamp(Guid id, TimeSpan age) =>
        File.SetLastWriteTimeUtc(EntryFile(id), DateTime.UtcNow - age);

    [MinioFact]
    public async Task Trim_EvictsTheOldestEntry_KeepsTheRecentlyUsedOne_AndStopsAtTheCap()
    {
        await _storage.EnsureBucketsExistAsync();
        var a = await SeedObjectAsync(0xAA);
        var b = await SeedObjectAsync(0xBB);
        var c = await SeedObjectAsync(0xCC);
        var cache = CreateCache(CacheCap);

        // A ve B indirilir — 200 KB ≤ 250 KB, süpürme tetiklenmez.
        await cache.GetOrDownloadAsync(a.Id, a.Key, null, CancellationToken.None);
        await cache.GetOrDownloadAsync(b.Id, b.Key, null, CancellationToken.None);
        Assert.True(File.Exists(EntryFile(a.Id)));
        Assert.True(File.Exists(EntryFile(b.Id)));

        // A az önce KULLANILDI (cache isabeti damgayı tazeler — TryTouch yolunun kendisi),
        // B ise bir saattir el sürülmemiş en eski girdi.
        Stamp(b.Id, TimeSpan.FromHours(1));
        Stamp(a.Id, TimeSpan.FromHours(2));
        await cache.GetOrDownloadAsync(a.Id, a.Key, null, CancellationToken.None); // isabet → damga tazelenir
        Assert.True(File.GetLastWriteTimeUtc(EntryFile(a.Id)) > File.GetLastWriteTimeUtc(EntryFile(b.Id)),
            "cache isabeti LRU damgasını tazelemedi — TryTouch kırık");

        // C'nin indirilmesi tavanı aşırır (300 KB > 250 KB) → EN ESKİ girdi (B) düşer;
        // aktif kullanılan A ve yeni C KALIR — süpürme tavana inince durur (200 KB ≤ 250 KB).
        await cache.GetOrDownloadAsync(c.Id, c.Key, null, CancellationToken.None);
        Assert.False(File.Exists(EntryFile(b.Id)), "en eski girdi (B) süpürülmeliydi");
        Assert.True(File.Exists(EntryFile(a.Id)), "aktif kullanılan girdi (A) süpürülmemeliydi");
        Assert.True(File.Exists(EntryFile(c.Id)), "yeni indirilen girdi (C) süpürülmemeliydi");

        // Süpürülen girdinin bir SONRAKİ isteği indirmeyi baştan öder ve cache'e geri döner.
        var path = await cache.GetOrDownloadAsync(b.Id, b.Key, null, CancellationToken.None);
        Assert.True(File.Exists(path));
        Assert.Equal(EntryBytes, new FileInfo(path).Length);
    }

    [MinioFact]
    public async Task Trim_SkipsThePinnedEntry_EvenWhenItIsTheOldest()
    {
        await _storage.EnsureBucketsExistAsync();
        var a = await SeedObjectAsync(0x1A);
        var c = await SeedObjectAsync(0x1C);
        var d = await SeedObjectAsync(0x1D);
        var cache = CreateCache(CacheCap);

        await cache.GetOrDownloadAsync(a.Id, a.Key, null, CancellationToken.None);
        await cache.GetOrDownloadAsync(c.Id, c.Key, null, CancellationToken.None);
        Stamp(a.Id, TimeSpan.FromHours(2)); // A açık ara en eski
        Stamp(c.Id, TimeSpan.FromHours(1));

        // Koşan export A'yı pinlemiş: tavan aşılınca sıra en eskide (A) olsa da atlanır,
        // bir SONRAKİ en eski pinsiz girdi (C) düşer.
        using (cache.Pin([a.Id]))
        {
            await cache.GetOrDownloadAsync(d.Id, d.Key, null, CancellationToken.None);
        }

        Assert.True(File.Exists(EntryFile(a.Id)), "pinli girdi süpürüldü — koşan export'un kaynağı gitti");
        Assert.False(File.Exists(EntryFile(c.Id)), "pinsiz en eski girdi (C) süpürülmeliydi");
        Assert.True(File.Exists(EntryFile(d.Id)));
    }

    [MinioFact]
    public async Task Trim_WithoutThePin_EvictsThatSameOldestEntry()
    {
        // NEGATİF KONTROL: üstteki testin yeşili PİNİN eseri mi? Aynı kurulum, pin YOK —
        // en eski girdi (A) bu kez gerçekten silinir. (Pin korumasının testi ancak bununla
        // birlikte anlamlıdır; yoksa "A zaten hiç silinmiyor" da yeşil görünürdü.)
        await _storage.EnsureBucketsExistAsync();
        var a = await SeedObjectAsync(0x2A);
        var c = await SeedObjectAsync(0x2C);
        var d = await SeedObjectAsync(0x2D);
        var cache = CreateCache(CacheCap);

        await cache.GetOrDownloadAsync(a.Id, a.Key, null, CancellationToken.None);
        await cache.GetOrDownloadAsync(c.Id, c.Key, null, CancellationToken.None);
        Stamp(a.Id, TimeSpan.FromHours(2));
        Stamp(c.Id, TimeSpan.FromHours(1));

        await cache.GetOrDownloadAsync(d.Id, d.Key, null, CancellationToken.None);

        Assert.False(File.Exists(EntryFile(a.Id)), "pin olmadan en eski girdi (A) süpürülmeliydi");
        Assert.True(File.Exists(EntryFile(c.Id)));
        Assert.True(File.Exists(EntryFile(d.Id)));
    }

    [MinioFact]
    public async Task Trim_UnderTheCap_EvictsNothing()
    {
        // Süpürme TAVAN olayıdır: bol tavanda üç indirme de yerinde kalır (silme "her
        // indirmede olan bir şey" değildir — kontrol grubu).
        await _storage.EnsureBucketsExistAsync();
        var a = await SeedObjectAsync(0x3A);
        var b = await SeedObjectAsync(0x3B);
        var c = await SeedObjectAsync(0x3C);
        var cache = CreateCache(1_000_000);

        await cache.GetOrDownloadAsync(a.Id, a.Key, null, CancellationToken.None);
        await cache.GetOrDownloadAsync(b.Id, b.Key, null, CancellationToken.None);
        await cache.GetOrDownloadAsync(c.Id, c.Key, null, CancellationToken.None);

        Assert.True(File.Exists(EntryFile(a.Id)));
        Assert.True(File.Exists(EntryFile(b.Id)));
        Assert.True(File.Exists(EntryFile(c.Id)));
    }
}
