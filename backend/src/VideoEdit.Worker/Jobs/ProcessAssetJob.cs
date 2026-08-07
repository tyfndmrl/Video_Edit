using Microsoft.EntityFrameworkCore;
using VideoEdit.Domain;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Jobs;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// ProcessAsset işinin İSKELETİ (M1). Şu an yalnız Job/Asset durumlarını Processing/Running'e
/// çeker; asıl pipeline (indir → ffprobe gate → CFR proxy `-g 15 -sc_threshold 0 -bf 0` →
/// filmstrip sprite+manifest → waveform → poster → Ready) pipeline ajanı tarafından doldurulacak.
/// Kuyruk seçimi IProcessAssetJob üzerindeki [Queue("transcode")] attribute'undan gelir.
/// </summary>
public sealed class ProcessAssetJob(
    AppDbContext db,
    ILogger<ProcessAssetJob> logger,
    TimeProvider clock) : IProcessAssetJob
{
    public async Task Run(Guid jobId, CancellationToken ct)
    {
        var job = await db.Jobs.SingleOrDefaultAsync(j => j.Id == jobId, ct);
        if (job is null)
        {
            logger.LogWarning("ProcessAssetJob: job row {JobId} not found; skipping.", jobId);
            return;
        }

        var asset = job.AssetId is { } assetId
            ? await db.Assets.SingleOrDefaultAsync(a => a.Id == assetId && a.DeletedAt == null, ct)
            : null;
        if (asset is null)
        {
            logger.LogWarning("ProcessAssetJob {JobId}: asset {AssetId} not found or deleted; skipping.",
                jobId, job.AssetId);
            return;
        }

        var now = clock.GetUtcNow();
        job.Status = JobStatus.Running;
        job.StartedAt ??= now;
        job.AttemptCount += 1;

        // Complete endpoint'i asset'i zaten Processing'e almıştır; retry (Failed) ve
        // olağandışı Uploaded durumları burada Processing'e çekilir. Processing'e her geçiş
        // ProcessingStartedAt'ı damgalar (reaper'ın "stalled" saati).
        if (asset.Status is AssetStatus.Uploaded or AssetStatus.Failed)
        {
            asset.TransitionTo(AssetStatus.Processing, now);
        }

        await db.SaveChangesAsync(ct);

        // TODO (M1 pipeline ajanı): orijinali R2'den diske indir (SHA-256 hesaplayarak),
        // ffprobe gate (parse edilemeyen → Failed), metadata'yı asset'e yaz
        // (DurationMicros/Width/Height/FpsNum/FpsDen/HasAudio/Probe), tek CFR proxy reçetesi
        // (tasarım 02 §3.3 — normatif), filmstrip sprite+manifest (§3.4), waveform (.NET içi
        // PCM pencereleme — backlog kararı), poster; türev key'lerini doldur;
        // asset.TransitionTo(Ready) + job Succeeded/CompletedAt. Hata yolunda asset.Fail(...)
        // + job Failed/ErrorMessage.
        logger.LogInformation(
            "ProcessAssetJob {JobId}: asset {AssetId} marked processing (skeleton — pipeline TODO).",
            jobId, asset.Id);
    }
}
