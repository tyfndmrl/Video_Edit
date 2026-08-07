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
    /// <summary>
    /// jobId = Jobs tablosundaki satırın id'si. ct Hangfire tarafından enjekte edilir.
    /// AutomaticRetry(2): yalnız TRANSIENT hatalar (ağ/S3/IO — pipeline throw eder) retry'lanır;
    /// deterministik ffmpeg/probe hataları pipeline içinde Failed işaretlenip normal döner,
    /// exception fırlatılmaz — Hangfire retry'ı tetiklenmez. İşleme idempotenttir
    /// (çıktı key'lerinin üzerine yazılır — tasarım 02 §3.1).
    /// </summary>
    [Queue("transcode")]
    [AutomaticRetry(Attempts = 2, OnAttemptsExceeded = AttemptsExceededAction.Fail)]
    Task Run(Guid jobId, CancellationToken ct);
}
