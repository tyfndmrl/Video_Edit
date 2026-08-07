using VideoEdit.Infrastructure.Storage;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// Orijinal indirme deseni — ProcessAssetJob'dan ORTAK yardımcıya çıkarıldı; ExportJob'un
/// LRU cache'i (OriginalCache) de aynı yolu kullanır. Stream'lenir (RAM'e alınmaz),
/// `.part` dosyasına yazılır ve tamamlanınca atomik rename edilir — yarım dosya asla
/// nihai adla diske girmez (tasarım 04 §4.2).
/// </summary>
public static class OriginalDownloader
{
    /// <param name="onBytes">(indirilen, toplam) — her chunk sonrası seri çağrılır; toplam
    /// bilinmiyorsa ≤ 0 gelebilir.</param>
    public static async Task DownloadToFileAsync(
        IStorageService storage,
        string key,
        string destinationPath,
        Func<long, long, CancellationToken, Task>? onBytes,
        CancellationToken ct)
    {
        var partPath = destinationPath + ".part";
        using var download = await storage.OpenReadAsync(key, ct);
        await using (var file = File.Create(partPath))
        {
            var buffer = new byte[256 * 1024];
            long total = 0;
            int read;
            while ((read = await download.Content.ReadAsync(buffer, ct)) > 0)
            {
                await file.WriteAsync(buffer.AsMemory(0, read), ct);
                total += read;
                if (onBytes is not null)
                {
                    await onBytes(total, download.Length, ct);
                }
            }
        }

        File.Move(partPath, destinationPath, overwrite: true);
    }
}
