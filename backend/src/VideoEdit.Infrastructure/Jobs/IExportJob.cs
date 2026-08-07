using Hangfire;

namespace VideoEdit.Infrastructure.Jobs;

/// <summary>
/// Export işinin Api ↔ Worker sözleşmesi (IProcessAssetJob deseni). [Queue] BURADA olmalı:
/// Hangfire kuyruk seçimini arayüz metodundan okur; worker 'export' kuyruğunu WorkerCount=1
/// olan ayrı bir server ile dinler (ffmpeg zaten tüm çekirdekleri kullanır — tasarım 04 §4.3).
/// </summary>
public interface IExportJob
{
    /// <summary>
    /// jobId = Jobs tablosundaki Export satırının id'si. Hata sınıflandırması ProcessAssetJob
    /// ile aynıdır: deterministik derleme/ffmpeg hataları içeride Failed işaretlenip normal
    /// dönülür (retry YOK); yalnız transient (ağ/S3/IO) hatalar exception olarak fırlar ve
    /// AutomaticRetry(2) devralır. Cancel: API Job.Status=Canceled yazar + Hangfire işini
    /// siler; koşan iş bunu görüp ffmpeg'i öldürür.
    /// </summary>
    [Queue("export")]
    [AutomaticRetry(Attempts = 2, OnAttemptsExceeded = AttemptsExceededAction.Fail)]
    Task Run(Guid jobId, CancellationToken ct);
}
