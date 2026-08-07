using Hangfire;

namespace VideoEdit.Infrastructure.Jobs;

/// <summary>
/// Asset işleme işinin Api ↔ Worker arasındaki sözleşmesi.
/// Api yalnız bu arayüz üzerinden enqueue eder (IBackgroundJobClient.Enqueue&lt;IProcessAssetJob&gt;);
/// implementasyon VideoEdit.Worker'daki ProcessAssetJob'dır (DI ile çözülür).
/// [Queue] attribute'u BURADA olmalı: Hangfire kuyruk seçimini job.Method (arayüz metodu)
/// üzerinden okur — implementasyondaki attribute görünmez ve retry'lar "default" kuyruğuna
/// düşüp asla koşmazdı (worker yalnız "transcode" dinler).
/// </summary>
public interface IProcessAssetJob
{
    /// <summary>jobId = Jobs tablosundaki satırın id'si. ct Hangfire tarafından enjekte edilir.</summary>
    [Queue("transcode")]
    Task Run(Guid jobId, CancellationToken ct);
}
