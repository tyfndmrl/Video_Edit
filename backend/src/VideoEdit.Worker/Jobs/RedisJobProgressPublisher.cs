using StackExchange.Redis;
using VideoEdit.Contracts;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// İlerleme yayıncısı — worker'ın progress DB yazımlarının YANINDA koşan canlı bildirim
/// kanalı. Somutlaması Redis'e publish eder (tasarım 03 §5: "worker StackExchange.Redis ile
/// job-progress kanalına publish eder"); API tarafındaki eşi <c>RedisProgressForwarder</c>
/// mesajı SignalR gruplarına iletir. Null kabul eden çağrı yerleri sayesinde birim testleri
/// yayıncısız (bugünkü davranışla birebir) koşar.
/// </summary>
public interface IJobProgressPublisher
{
    /// <summary>
    /// Mesajı en-iyi-gayret yayınlar: HİÇBİR koşulda fırlatmaz. Redis erişilemezse mesaj
    /// düşer ve kaybı telafi eden şey istemcideki polling yedeğidir (tasarım şartı: Redis
    /// hiçbir zaman zorunlu değildir — bkz. RedisJobProgressPublisher sınıf belgesi).
    /// </summary>
    Task PublishAsync(JobProgressMessage message, CancellationToken ct);
}

/// <summary>
/// Domain <see cref="Job"/> satırından tel mesajı üreten TEK çevirmen. Durum/tür yazımları
/// API'nin DTO yazımlarıyla (ExportEndpoints.StatusString) aynı kelime dağarcığıdır ve bu
/// eşitlik testle sabitlenir — buraya yeni yazım eklerken o testi de güncelle
/// (ProgressHubTests.WorkerWireStatusMatchesTheApiDtoStatusForEveryJobStatus).
/// </summary>
public static class JobProgressMessages
{
    public static JobProgressMessage FromJob(Job job) => new(
        job.Id,
        TypeWire(job.Type),
        job.AssetId,
        job.ProjectId,
        StatusWire(job.Status),
        Math.Clamp(job.ProgressPercent, 0, 100),
        job.ProgressStage,
        job.Status == JobStatus.Failed ? job.ErrorMessage : null,
        // Feed (user:{id}) hedefi — B6. ProcessAsset işinde RequestedBy = yükleyen =
        // asset sahibi (AssetEndpoints complete), export'ta işi başlatan kullanıcı.
        OwnerId: job.RequestedBy);

    /// <summary>API'nin <c>ExportEndpoints.StatusString</c> aynası (test-pinli kopya).</summary>
    public static string StatusWire(JobStatus status) => status switch
    {
        JobStatus.Queued => "queued",
        JobStatus.Running => "running",
        JobStatus.Succeeded => "succeeded",
        JobStatus.Failed => "failed",
        JobStatus.Canceled => "canceled",
        _ => "unknown",
    };

    public static string TypeWire(JobType type) => type switch
    {
        JobType.Export => "export",
        JobType.ProcessAsset => "processAsset",
        _ => "unknown",
    };
}

/// <summary>
/// StackExchange.Redis yayıncısı. DAYANIKLILIK SÖZLEŞMESİ (tasarım şartı — Redis bugüne dek
/// hiç zorunlu değildi, zorunlu HALE GELMEZ):
/// <list type="bullet">
///   <item>Bağlantı TEMBEL ve <c>AbortOnConnectFail=false</c> ile kurulur: Redis kapalıyken
///     worker açılır, ilk publish denemesi en fazla connect timeout'u kadar bekler, sonrakiler
///     hızlı düşer; Redis sonradan gelirse multiplexer kendiliğinden bağlanır.</item>
///   <item><see cref="PublishAsync"/> HİÇBİR istisna akıtmaz — kaybolan mesajın telafisi
///     istemcideki polling yedeğidir; iş akışı (DB yazımları) hiçbir koşulda etkilenmez.</item>
///   <item>Uyarı logu kanal başına dakikada bire kısılır (her %5 tick'inde log fırtınası olmasın).</item>
/// </list>
/// </summary>
public sealed class RedisJobProgressPublisher(
    string? connectionString,
    ILogger<RedisJobProgressPublisher> logger,
    TimeProvider clock) : IJobProgressPublisher, IAsyncDisposable
{
    private static readonly TimeSpan WarningInterval = TimeSpan.FromMinutes(1);

    private readonly SemaphoreSlim _connectLock = new(1, 1);
    private volatile IConnectionMultiplexer? _muxer;
    private DateTimeOffset _lastWarningAt = DateTimeOffset.MinValue;

    /// <summary>Testlerin gerçek Redis'siz mesaj yakalayabilmesi için kanca (null = gerçek publish).</summary>
    internal Func<string, Task>? PublishOverride { get; init; }

    public async Task PublishAsync(JobProgressMessage message, CancellationToken ct)
    {
        var payload = JobProgressChannel.Serialize(message);
        if (PublishOverride is { } hook)
        {
            await hook(payload);
            return;
        }

        if (string.IsNullOrWhiteSpace(connectionString))
        {
            return; // Redis yapılandırılmamış: kanal bilinçli kapalı, polling taşır.
        }

        try
        {
            var muxer = _muxer ?? await ConnectAsync();
            await muxer.GetSubscriber().PublishAsync(
                RedisChannel.Literal(JobProgressChannel.RedisChannelName), payload);
        }
        catch (Exception ex)
        {
            WarnThrottled(ex, message.JobId);
        }
    }

    private async Task<IConnectionMultiplexer> ConnectAsync()
    {
        await _connectLock.WaitAsync();
        try
        {
            if (_muxer is { } existing)
            {
                return existing;
            }

            var options = ConfigurationOptions.Parse(connectionString!);
            options.AbortOnConnectFail = false; // Redis'siz de multiplexer döner; arka planda dener
            var created = await ConnectionMultiplexer.ConnectAsync(options);
            _muxer = created;
            return created;
        }
        finally
        {
            _connectLock.Release();
        }
    }

    private void WarnThrottled(Exception ex, Guid jobId)
    {
        var now = clock.GetUtcNow();
        if (now - _lastWarningAt < WarningInterval)
        {
            return;
        }

        _lastWarningAt = now;
        logger.LogWarning(ex,
            "Job progress Redis publish failed (job {JobId}); live updates are degraded, "
            + "clients fall back to polling. Redis: '{Redis}'.", jobId, connectionString);
    }

    public async ValueTask DisposeAsync()
    {
        if (_muxer is { } muxer)
        {
            await muxer.DisposeAsync();
        }

        _connectLock.Dispose();
    }
}
