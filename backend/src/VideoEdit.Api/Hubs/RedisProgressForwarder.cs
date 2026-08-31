using Microsoft.AspNetCore.SignalR;
using StackExchange.Redis;
using VideoEdit.Contracts;

namespace VideoEdit.Api.Hubs;

/// <summary>
/// Redis <c>job-progress</c> kanalını dinleyip mesajları SignalR gruplarına ileten köprü
/// (tasarım 03 §5'in "worker → Redis → hub" hattının API yarısı). Backplane
/// (Microsoft.AspNetCore.SignalR.StackExchangeRedis) BİLEREK kullanılmaz: tek API instance
/// var, hub'lar arası senkron gerekmiyor — yalnız pub/sub aboneliği yeter (çok-instance
/// gerekirse geri alma koşulu DECISIONS satırında).
/// <para>
/// DAYANIKLILIK SÖZLEŞMESİ (Redis hiçbir zaman zorunlu olmadı, ZORUNLU HALE GELMEZ):
/// bağlantı dizisi yoksa servis sessizce (tek log satırıyla) devre dışı kalır; Redis
/// erişilemezse API AÇILIR ve AÇIK KALIR — bu döngü arka planda artan aralıkla yeniden
/// dener, abonelik kurulana kadar hub beslenmez ve istemciler polling yedeğiyle ilerler.
/// <c>ExecuteAsync</c> HİÇBİR istisna akıtmaz: .NET'in varsayılanı
/// (BackgroundServiceExceptionBehavior.StopHost) akıtılan istisnada TÜM API'yi düşürürdü —
/// buradaki catch-all o davranışın bilinçli panzehiridir (ProgressHubTests dayanıklılık
/// testi bunu unreachable endpoint ile sabitler).
/// </para>
/// </summary>
public sealed class RedisProgressForwarder(
    IHubContext<JobProgressHub> hub,
    IConfiguration configuration,
    IHostEnvironment environment,
    ILogger<RedisProgressForwarder> logger) : BackgroundService
{
    private static readonly TimeSpan InitialRetryDelay = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan MaxRetryDelay = TimeSpan.FromMinutes(1);

    private IConnectionMultiplexer? _muxer;

    /// <summary>
    /// Bağlantı dizisi: <c>ConnectionStrings:Redis</c>; Development'ta Postgres fallback'iyle
    /// aynı desende localhost. Prod'da yoksa kanal bilinçli kapalıdır (polling taşır).
    /// </summary>
    internal string? ResolveConnectionString() =>
        configuration.GetConnectionString("Redis")
        ?? (environment.IsDevelopment() ? "localhost:6379" : null);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var connectionString = ResolveConnectionString();
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            logger.LogInformation(
                "Redis progress forwarder disabled: ConnectionStrings:Redis not configured. "
                + "Live progress will not flow; clients keep polling.");
            return;
        }

        var delay = InitialRetryDelay;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var options = ConfigurationOptions.Parse(connectionString);
                options.AbortOnConnectFail = false; // Redis'siz de döner; SE.Redis arkada dener
                _muxer = await ConnectionMultiplexer.ConnectAsync(options);

                // Subscribe bağlantısızken fırlatabilir — retry döngüsü kapsar. Kurulduktan
                // sonra SE.Redis kopan bağlantıda aboneliği KENDİSİ yeniden kurar
                // (ConnectionRestored) — döngüye geri düşmek gerekmez.
                await _muxer.GetSubscriber().SubscribeAsync(
                    RedisChannel.Literal(JobProgressChannel.RedisChannelName),
                    (channel, value) => { _ = ForwardSafeAsync((string?)value); });

                logger.LogInformation(
                    "Redis progress forwarder subscribed to '{Channel}' ({Redis}).",
                    JobProgressChannel.RedisChannelName, connectionString);

                // Abonelik canlı; servis durdurulana kadar bekle.
                await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
                return;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return; // normal kapanış
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex,
                    "Redis progress forwarder could not subscribe ({Redis}); retrying in {Delay}. "
                    + "API stays up; clients keep polling.", connectionString, delay);
                _muxer?.Dispose();
                _muxer = null;
                try
                {
                    await Task.Delay(delay, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }

                delay = delay + delay <= MaxRetryDelay ? delay + delay : MaxRetryDelay;
            }
        }
    }

    /// <summary>
    /// Tek mesajın iletimi — SAF ve testli yüzey (ProgressHubTests sahte IHubContext ile
    /// çağırır). Bozuk payload loglanıp ATLANIR (kanal komşu mesajlar için akmaya devam
    /// eder); her mesaj <c>job:{id}</c> grubuna, assetId taşıyanlar AYRICA <c>asset:{id}</c>
    /// grubuna gider (istemcinin asset aboneliği — JobProgressHub.SubscribeAsset gerekçesi);
    /// OwnerId taşıyanlar sahibin <c>user:{id}</c> feed grubuna DA gider (B6 — pasif sekme
    /// BİLMEDİĞİ satırın doğuşunu ancak buradan duyar; alanı taşımayan eski payload'da feed
    /// bacağı atlanır, id-bazlı gruplar aynen beslenir).
    /// </summary>
    internal async Task ForwardAsync(string payload, CancellationToken ct = default)
    {
        var message = JobProgressChannel.TryDeserialize(payload);
        if (message is null)
        {
            logger.LogWarning(
                "Redis progress forwarder: malformed payload skipped ({Length} chars).",
                payload.Length);
            return;
        }

        await hub.Clients.Group(JobProgressChannel.JobGroup(message.JobId))
            .SendAsync(JobProgressChannel.HubMethod, message, ct);
        if (message.AssetId is { } assetId)
        {
            await hub.Clients.Group(JobProgressChannel.AssetGroup(assetId))
                .SendAsync(JobProgressChannel.HubMethod, message, ct);
        }

        if (message.OwnerId is { } ownerId)
        {
            await hub.Clients.Group(JobProgressChannel.UserGroup(ownerId))
                .SendAsync(JobProgressChannel.HubMethod, message, ct);
        }
    }

    private async Task ForwardSafeAsync(string? payload)
    {
        if (payload is null)
        {
            return;
        }

        try
        {
            await ForwardAsync(payload);
        }
        catch (Exception ex)
        {
            // Redis callback'inden istisna akıtılmaz — tek mesaj kaybı polling'in telafi
            // ettiği sınıftır, kanalın kendisi yaşamaya devam etmeli.
            logger.LogWarning(ex, "Redis progress forwarder: message could not be forwarded.");
        }
    }

    public override void Dispose()
    {
        _muxer?.Dispose();
        base.Dispose();
    }
}
