using System.Collections.Concurrent;
using VideoEdit.Infrastructure.Storage;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// Export orijinalleri için LRU disk cache'i (tasarım 04 §4.2): {root}/{assetId:N}/original.ext.
/// İndirme OriginalDownloader (ProcessAssetJob ile ORTAK yardımcı) üzerinden `.part` + atomik
/// rename ile yapılır — yarım dosya cache'e giremez. Toplam boyut tavanı aşınca en eski
/// (LastWriteTimeUtc damgalı) asset dizinleri silinir; koşan bir export'un pin'lediği
/// asset'ler süpürülmez. Singleton olarak kaydedilir; export eşzamanlılığı 1 olduğundan
/// kilitlenme basit tutulmuştur (best-effort trim).
/// </summary>
public sealed class OriginalCache(IStorageService storage, ProcessingOptions options)
{
    private readonly ConcurrentDictionary<Guid, int> _pinned = new();
    private readonly SemaphoreSlim _trimGate = new(1, 1);

    public string Root =>
        string.IsNullOrWhiteSpace(options.CacheDirectory)
            ? Path.Combine(Path.GetTempPath(), "videoedit-cache")
            : options.CacheDirectory!;

    /// <summary>
    /// Cache'te varsa dosyayı döndürür (LRU damgasını tazeler); yoksa indirir ve tavanı aşan
    /// eski girdileri süpürür. onBytes: (indirilen, toplam) — cache isabetinde (len, len) ile
    /// bir kez çağrılır ki progress bandı tutarlı ilerlesin.
    /// </summary>
    public async Task<string> GetOrDownloadAsync(
        Guid assetId,
        string storageKey,
        Func<long, long, CancellationToken, Task>? onBytes,
        CancellationToken ct)
    {
        var dir = Path.Combine(Root, assetId.ToString("N"));
        var path = Path.Combine(dir, "original" + Path.GetExtension(storageKey));

        if (File.Exists(path))
        {
            TryTouch(path);
            if (onBytes is not null)
            {
                var length = new FileInfo(path).Length;
                await onBytes(length, length, ct);
            }

            return path;
        }

        Directory.CreateDirectory(dir);
        await OriginalDownloader.DownloadToFileAsync(storage, storageKey, path, onBytes, ct);
        await TrimAsync(ct);
        return path;
    }

    /// <summary>Koşan export'un kaynaklarını süpürmeye karşı korur; dispose pin'i bırakır.</summary>
    public IDisposable Pin(IReadOnlyCollection<Guid> assetIds)
    {
        foreach (var id in assetIds)
        {
            _pinned.AddOrUpdate(id, 1, (_, count) => count + 1);
        }

        return new PinScope(this, assetIds);
    }

    /// <summary>LRU süpürmesi — toplam boyut MaxCacheBytes'ı aşarsa en eski asset dizinlerini siler.</summary>
    public Task TrimAsync(CancellationToken ct) => TrimAsync(options.MaxCacheBytes, ct);

    /// <summary>
    /// Hedefli LRU süpürmesi: toplam boyut maxBytes'ın altına inene dek en eski asset dizinleri
    /// silinir (pinli — koşan export'un — asset'ler daima korunur). maxBytes=0 agresif moddur:
    /// disk-yetersiz yolunda ertelemeden önce cache tamamen boşaltılır (ExportJob).
    /// </summary>
    public async Task TrimAsync(long maxBytes, CancellationToken ct)
    {
        await _trimGate.WaitAsync(ct);
        try
        {
            if (!Directory.Exists(Root))
            {
                return;
            }

            var entries = new List<(string Dir, Guid? AssetId, long Bytes, DateTime Stamp)>();
            foreach (var dir in Directory.GetDirectories(Root))
            {
                try
                {
                    var files = Directory.GetFiles(dir, "*", SearchOption.AllDirectories);
                    var bytes = files.Sum(f => new FileInfo(f).Length);
                    var stamp = files.Length > 0
                        ? files.Max(File.GetLastWriteTimeUtc)
                        : Directory.GetLastWriteTimeUtc(dir);
                    Guid? assetId = Guid.TryParse(Path.GetFileName(dir), out var parsed) ? parsed : null;
                    entries.Add((dir, assetId, bytes, stamp));
                }
                catch (Exception)
                {
                    // Yarışan silme/kilitli dosya — bu girdiyi atla (best-effort).
                }
            }

            var total = entries.Sum(e => e.Bytes);
            foreach (var entry in entries.OrderBy(e => e.Stamp))
            {
                if (total <= maxBytes)
                {
                    break;
                }

                if (entry.AssetId is { } id && _pinned.ContainsKey(id))
                {
                    continue; // koşan export'un kaynağı — süpürme
                }

                try
                {
                    Directory.Delete(entry.Dir, recursive: true);
                    total -= entry.Bytes;
                }
                catch (Exception)
                {
                    // Kilitli dosya vb. — sonraki trim dener.
                }
            }
        }
        finally
        {
            _trimGate.Release();
        }
    }

    private static void TryTouch(string path)
    {
        try
        {
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
        }
        catch (Exception)
        {
            // LRU damgası best-effort — dokunulamazsa eski damgayla yaşar.
        }
    }

    private sealed class PinScope(OriginalCache owner, IReadOnlyCollection<Guid> assetIds) : IDisposable
    {
        public void Dispose()
        {
            foreach (var id in assetIds)
            {
                owner._pinned.AddOrUpdate(id, 0, (_, count) => count - 1);
                if (owner._pinned.TryGetValue(id, out var remaining) && remaining <= 0)
                {
                    ((ICollection<KeyValuePair<Guid, int>>)owner._pinned)
                        .Remove(new KeyValuePair<Guid, int>(id, remaining));
                }
            }
        }
    }
}
