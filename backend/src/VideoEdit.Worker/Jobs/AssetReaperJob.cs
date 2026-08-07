using Hangfire;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Domain;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Storage;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// Hijyen reaper'ı (recurring, 15 dk'da bir — Program.cs'te registre edilir):
///  - 30 dk'dan uzun süredir Processing'de takılı asset'ler → Failed(error='stalled');
///    ANCAK ilgili ProcessAsset işinin LastProgressAt heartbeat'i son 10 dk içindeyse iş
///    CANLIDIR (uzun transcode) — süpürülmez (worker her progress yazımında damgalar);
///  - eşikten eski Running/Queued Job satırları → Failed('stalled') (Hangfire tarafı işi
///    çoktan kaybetmiş/bitirememiş demektir; LastProgressAt ?? StartedAt ?? CreatedAt bazlı);
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

    /// <summary>Bu pencere içinde heartbeat'i olan iş canlı sayılır — asset süpürülmez.</summary>
    public static readonly TimeSpan ProgressHeartbeatGrace = TimeSpan.FromMinutes(10);

    /// <summary>
    /// Running/Queued Job satırı bu süredir hiç iz (LastProgressAt/StartedAt/CreatedAt)
    /// üretmediyse ölü kabul edilir. Bilinçli olarak Hangfire InvisibilityTimeout'un (2 sa)
    /// ÜSTÜNDE: gerçek çökmede Hangfire işi ~2 saatte yeniden koşturup heartbeat üretir;
    /// 6 saat sessizlik = Hangfire tarafı da işi bitiremiyor demektir.
    /// </summary>
    public static readonly TimeSpan StalledJobAge = TimeSpan.FromHours(6);

    public static readonly TimeSpan ExpiredUploadAge = TimeSpan.FromDays(7);

    // Worker yalnız "transcode" kuyruğunu dinler — reaper da oradan koşar (ayrı kuyruk
    // MVP'de gereksiz; uzun transcode'lar reaper'ı en fazla dakikalar geciktirir).
    [Queue("transcode")]
    public async Task Run(CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var changed = false;

        // 1) Stalled asset'ler: Processing'e geçeli 30 dk'yı aşanlar — heartbeat'i tazeyse atla.
        //    (Tarih filtreleri İSTEMCİ tarafında: aktif Processing satır sayısı küçüktür ve
        //    Sqlite test provider'ı DateTimeOffset karşılaştırmasını SQL'e çeviremez.)
        var stalledCutoff = now - StalledProcessingAge;
        var progressCutoff = now - ProgressHeartbeatGrace;
        var stalledCandidates = (await db.Assets
                .Where(a => a.Status == AssetStatus.Processing && a.ProcessingStartedAt != null)
                .ToListAsync(ct))
            .Where(a => a.ProcessingStartedAt < stalledCutoff)
            .ToList();
        foreach (var asset in stalledCandidates)
        {
            var heartbeats = await db.Jobs
                .Where(j => j.AssetId == asset.Id
                            && j.Type == JobType.ProcessAsset
                            && (j.Status == JobStatus.Running || j.Status == JobStatus.Queued))
                .Select(j => j.LastProgressAt)
                .ToListAsync(ct);
            if (heartbeats.Any(h => h != null && h >= progressCutoff))
            {
                logger.LogInformation(
                    "Reaper: asset {AssetId} in processing since {Since} but its job has a recent "
                    + "progress heartbeat; skipping.", asset.Id, asset.ProcessingStartedAt);
                continue;
            }

            asset.Fail("stalled", now);
            changed = true;
            logger.LogWarning("Reaper: asset {AssetId} stuck in processing since {Since}; marked failed(stalled).",
                asset.Id, asset.ProcessingStartedAt);
        }

        // 2) Stalled job satırları: eşikten beri hiç iz üretmeyen Running/Queued işler.
        //    (Tarih koalesansı istemci tarafında — Job satır sayısı küçüktür ve filtre
        //    status üzerinden daraltılır; provider'lar arası çeviri derdi olmaz.)
        var jobCutoff = now - StalledJobAge;
        var activeJobs = await db.Jobs
            .Where(j => j.Status == JobStatus.Running || j.Status == JobStatus.Queued)
            .ToListAsync(ct);
        foreach (var job in activeJobs)
        {
            var lastSeen = job.LastProgressAt ?? job.StartedAt ?? job.CreatedAt;
            if (lastSeen >= jobCutoff)
            {
                continue;
            }

            job.Status = JobStatus.Failed;
            job.ErrorMessage = $"stalled: no progress since {lastSeen:O} (reaped at {now:O}).";
            job.CompletedAt = now;
            changed = true;
            logger.LogWarning(
                "Reaper: job {JobId} ({Type}) had no progress since {LastSeen}; marked failed(stalled).",
                job.Id, job.Type, lastSeen);
        }

        // 3) Expired: 7 günden eski yarım upload'lar (R2 lifecycle zaten abort etmiştir;
        //    DB'yi eşitler, upload hâlâ yaşıyorsa açıkça abort ederiz — abort ücretsizdir).
        var expiredCutoff = now - ExpiredUploadAge;
        var expired = (await db.Assets
                .Where(a => a.Status == AssetStatus.Uploading && a.DeletedAt == null)
                .ToListAsync(ct))
            .Where(a => a.CreatedAt < expiredCutoff)
            .ToList();
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
            changed = true;
            logger.LogInformation("Reaper: uploading asset {AssetId} created at {CreatedAt} expired.",
                asset.Id, asset.CreatedAt);
        }

        if (changed)
        {
            await db.SaveChangesAsync(ct);
        }
    }
}
