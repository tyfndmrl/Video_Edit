using Hangfire.States;
using Hangfire.Storage;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// Hangfire ↔ Jobs tablosu durum senkronu (denetim bulgusu #3): AutomaticRetry hakları
/// tükenip iş NİHAİ FailedState'e düştüğünde (transient hata yolunda pipeline exception
/// FIRLATIR — kendi Jobs satırını Failed işaretleyemez) satır Running'de asılı kalıyordu.
/// Bu global filtre FailedState uygulandığında:
///  - Jobs satırını Failed + ErrorMessage yapar (deterministik yol zaten Failed yazdıysa dokunmaz);
///  - ilgili asset hâlâ Processing ise Fail('processing-error') (kullanıcı retry edebilir).
/// İlk argümanı Guid olmayan işler (ör. reaper) sessizce atlanır.
/// </summary>
public sealed class JobFailureStateFilter(
    IServiceScopeFactory scopeFactory,
    TimeProvider clock,
    ILogger<JobFailureStateFilter> logger,
    IJobProgressPublisher? progressPublisher = null) : IApplyStateFilter
{
    public void OnStateApplied(ApplyStateContext context, IWriteOnlyTransaction transaction)
    {
        if (context.NewState is not FailedState failed)
        {
            return;
        }

        if (!TryGetJobRowId(context.BackgroundJob?.Job?.Args, out var jobRowId))
        {
            return;
        }

        try
        {
            using var scope = scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var error = "hangfire-failed: "
                + (failed.Exception?.Message ?? failed.Reason ?? "background job failed");
            var syncedJob = SyncFailure(db, jobRowId, error, clock.GetUtcNow());
            if (syncedJob is not null && progressPublisher is not null)
            {
                // Transient yolun nihai Failed'ı da canlı kanala düşer (diğer terminal
                // yazımlarla aynı desen); publish en-iyi-gayrettir ve fırlatmaz.
                progressPublisher
                    .PublishAsync(JobProgressMessages.FromJob(syncedJob), CancellationToken.None)
                    .GetAwaiter().GetResult();
            }
        }
        catch (Exception ex)
        {
            // Filtre Hangfire state pipeline'ını ASLA kırmamalı — logla ve geç
            // (satır Running kalırsa reaper'ın stale-job süpürmesi ikinci savunmadır).
            logger.LogError(ex,
                "JobFailureStateFilter: could not sync failed state for job row {JobRowId}.", jobRowId);
        }
    }

    public void OnStateUnapplied(ApplyStateContext context, IWriteOnlyTransaction transaction)
    {
        // no-op
    }

    /// <summary>İlk argüman Jobs satır id'si olan işleri yakalar (IProcessAssetJob.Run(Guid, ct)).</summary>
    public static bool TryGetJobRowId(IReadOnlyList<object?>? args, out Guid jobRowId)
    {
        jobRowId = Guid.Empty;
        if (args is not { Count: > 0 })
        {
            return false;
        }

        switch (args[0])
        {
            case Guid guid:
                jobRowId = guid;
                return true;
            case string s when Guid.TryParse(s, out var parsed):
                jobRowId = parsed;
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// SAF senkron mantığı — unit test doğrudan çağırır (Hangfire pipeline'ı taklit edilmez).
    /// Terminal (Succeeded/Failed/Canceled) satırlara dokunmaz — deterministik hata yolu
    /// Failed + açıklayıcı ErrorMessage'ı zaten yazmıştır. Dönüş: satır BU çağrıyla Failed'a
    /// çekildiyse güncellenmiş Job (çağıran canlı bildirim yayınlar), dokunulmadıysa null.
    /// </summary>
    public static Job? SyncFailure(AppDbContext db, Guid jobRowId, string error, DateTimeOffset now)
    {
        var job = db.Jobs.SingleOrDefault(j => j.Id == jobRowId);
        if (job is null
            || job.Status is JobStatus.Succeeded or JobStatus.Failed or JobStatus.Canceled)
        {
            return null;
        }

        job.Status = JobStatus.Failed;
        job.ErrorMessage = error.Length > 4000 ? error[..4000] : error;
        job.CompletedAt = now;

        if (job.AssetId is { } assetId)
        {
            var asset = db.Assets.SingleOrDefault(a => a.Id == assetId && a.DeletedAt == null);
            if (asset?.Status == AssetStatus.Processing)
            {
                asset.Fail("processing-error", now);
            }
        }

        db.SaveChanges();
        return job;
    }
}
