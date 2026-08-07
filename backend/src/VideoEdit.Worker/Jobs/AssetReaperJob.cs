using Hangfire;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Domain;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Storage;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// Hijyen reaper'ı (recurring, 15 dk'da bir — Program.cs'te registre edilir):
///  - 30 dk'dan uzun süredir Processing'de takılı asset'ler → Failed(error='stalled')
///    (worker çökmesi/kilitlenmesi; kullanıcı retry edebilir — Failed → Processing geçişi açık);
///  - 7 günden eski Uploading asset'ler → Failed(error='expired') + AbortMultipartUpload
///    (R2 lifecycle'ının 7 günlük otomatik abort'u ile DB tutarlılığı — tasarım 02 §1.8).
/// </summary>
public sealed class AssetReaperJob(
    AppDbContext db,
    IStorageService storage,
    ILogger<AssetReaperJob> logger,
    TimeProvider clock)
{
    public static readonly TimeSpan StalledProcessingAge = TimeSpan.FromMinutes(30);
    public static readonly TimeSpan ExpiredUploadAge = TimeSpan.FromDays(7);

    // Worker yalnız "transcode" kuyruğunu dinler — reaper da oradan koşar (ayrı kuyruk
    // MVP'de gereksiz; uzun transcode'lar reaper'ı en fazla dakikalar geciktirir).
    [Queue("transcode")]
    public async Task Run(CancellationToken ct)
    {
        var now = clock.GetUtcNow();

        // 1) Stalled: Processing'e geçeli 30 dk'yı aşanlar.
        var stalledCutoff = now - StalledProcessingAge;
        var stalled = await db.Assets
            .Where(a => a.Status == AssetStatus.Processing
                        && a.ProcessingStartedAt != null
                        && a.ProcessingStartedAt < stalledCutoff)
            .ToListAsync(ct);
        foreach (var asset in stalled)
        {
            asset.Fail("stalled", now);
            logger.LogWarning("Reaper: asset {AssetId} stuck in processing since {Since}; marked failed(stalled).",
                asset.Id, asset.ProcessingStartedAt);
        }

        // 2) Expired: 7 günden eski yarım upload'lar (R2 lifecycle zaten abort etmiştir;
        //    DB'yi eşitler, upload hâlâ yaşıyorsa açıkça abort ederiz — abort ücretsizdir).
        var expiredCutoff = now - ExpiredUploadAge;
        var expired = await db.Assets
            .Where(a => a.Status == AssetStatus.Uploading
                        && a.DeletedAt == null
                        && a.CreatedAt < expiredCutoff)
            .ToListAsync(ct);
        foreach (var asset in expired)
        {
            if (asset.UploadId is not null)
            {
                try
                {
                    await storage.AbortMultipartUploadAsync(asset.StorageKey, asset.UploadId, ct);
                }
                catch (Exception ex)
                {
                    // NoSuchUpload (lifecycle süpürmüş) dahil — DB tarafını yine de eşitle.
                    logger.LogInformation(ex,
                        "Reaper: abort for asset {AssetId} failed (probably already gone).", asset.Id);
                }
            }

            asset.Fail("expired", now);
            asset.UploadId = null;
            logger.LogInformation("Reaper: uploading asset {AssetId} created at {CreatedAt} expired.",
                asset.Id, asset.CreatedAt);
        }

        if (stalled.Count > 0 || expired.Count > 0)
        {
            await db.SaveChangesAsync(ct);
        }
    }
}
