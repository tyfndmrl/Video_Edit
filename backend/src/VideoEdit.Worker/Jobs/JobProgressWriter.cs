using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// Job.ProgressPercent/ProgressStage throttle'ı (ProcessAssetJob'dan ORTAK yardımcıya
/// çıkarıldı — ExportJob da aynı deseni kullanır): DB'ye stage değişiminde, ≥5 puan artışta
/// YA DA son yazımdan ≥2 dk geçince yazar (zaman koşulu: reaper'ın LastProgressAt
/// heartbeat'i çok yavaş ilerleyen uzun transcode'da bile taze kalsın). Her yazım
/// LastProgressAt'ı damgalar. Çağrılar TEK thread'den gelir (ffmpeg progress callback'i
/// FfmpegRunner'ın okuma döngüsünden seri await edilir) — DbContext güvenli.
/// </summary>
public sealed class JobProgressWriter(AppDbContext db, Job job, TimeProvider clock)
{
    public static readonly TimeSpan HeartbeatInterval = TimeSpan.FromMinutes(2);

    private int _lastWritten = int.MinValue;
    private string? _lastStage;
    private DateTimeOffset _lastWrittenAt = DateTimeOffset.MinValue;

    public async Task ReportAsync(int percent, string stage, CancellationToken ct)
    {
        percent = Math.Clamp(percent, 0, 100);
        var now = clock.GetUtcNow();
        if (stage == _lastStage
            && percent - _lastWritten < 5
            && now - _lastWrittenAt < HeartbeatInterval)
        {
            return;
        }

        job.ProgressPercent = percent;
        job.ProgressStage = stage;
        job.LastProgressAt = now;
        _lastWritten = percent;
        _lastStage = stage;
        _lastWrittenAt = now;
        await db.SaveChangesAsync(ct);
    }
}
