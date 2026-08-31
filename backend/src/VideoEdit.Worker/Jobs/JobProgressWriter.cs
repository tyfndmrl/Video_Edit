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
/// <para>
/// SignalR dilimi: her DB yazımının YANINDA aynı satırın tel mesajı yayıncıya da verilir
/// (Redis → API forwarder → hub grubu). Throttle DEĞİŞMEZ — hub da DB ile aynı adımları
/// görür; publish en-iyi-gayrettir ve yazım akışını asla düşüremez (publisher sözleşmesi).
/// Yayıncı null ise (birim testleri) davranış eskisiyle birebirdir.
/// </para>
/// </summary>
public sealed class JobProgressWriter(
    AppDbContext db, Job job, TimeProvider clock, IJobProgressPublisher? publisher = null)
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

        if (publisher is not null)
        {
            // CancellationToken.None bilinçli: yazım DB'ye ULAŞTI — iptal, başarılı yazımın
            // bildirimini yarı yolda kesip OCE'yi çağıranın cancel yoluna akıtmamalı.
            await publisher.PublishAsync(JobProgressMessages.FromJob(job), CancellationToken.None);
        }
    }
}
