using System.Text.Json;
using System.Text.Json.Serialization;

namespace VideoEdit.Contracts;

/// <summary>
/// İlerleme kanalının TEK tanım noktası (tasarım 03 §5 "Progress kanalı"): worker Redis'e
/// buradaki kanal adıyla ve buradaki payload biçimiyle publish eder; API'nin forwarder'ı
/// aynı sabitlerle dinleyip SignalR grubuna aynı hub metodu adıyla yayınlar; istemci de aynı
/// grup adlandırmasıyla abone olur. Kanal adı / grup deseni / hub yolu / metot adı burada
/// değişirse iki taraf birden değişir — kopya sabit yoktur.
/// </summary>
public static class JobProgressChannel
{
    /// <summary>Worker → API pub/sub kanalı (StackExchange.Redis PUBLISH/SUBSCRIBE).</summary>
    public const string RedisChannelName = "job-progress";

    /// <summary>SignalR hub yolu. JWT'nin query-string'den kabul edildiği TEK yol budur.</summary>
    public const string HubPath = "/hubs/progress";

    /// <summary>İstemcinin dinlediği hub metodu adı (connection.on(...) hedefi).</summary>
    public const string HubMethod = "progress";

    /// <summary>İş bazlı grup: export akışı iş id'siyle abone olur.</summary>
    public static string JobGroup(Guid jobId) => $"job:{jobId:D}";

    /// <summary>
    /// Asset bazlı grup: asset işleme (ProcessAsset) işinin id'si istemciye hiç dönmez
    /// (upload complete cevabı yalnız durum taşır) — istemci elindeki TEK kimlikle,
    /// asset id'siyle abone olur; forwarder assetId taşıyan mesajı bu gruba DA yollar.
    /// </summary>
    public static string AssetGroup(Guid assetId) => $"asset:{assetId:D}";

    /// <summary>
    /// Kullanıcı-akışı (feed) grubu — "listende yeni satır doğdu" yayını (backlog B6:
    /// çapraz-sekme kitaplık senkronu). id-bazlı gruplar sekmenin ZATEN bildiği satırları
    /// taşır; başka istemcinin yüklediği asseti pasif sekme ancak SAHİBİNİN akışından
    /// duyabilir. Forwarder her mesajı sahibin bu grubuna DA yollar; abonelik parametresiz
    /// <c>SubscribeUserFeed</c> ile kurulur (kimlik çağıranın JWT'sinden — başka kullanıcının
    /// feed'i hub yüzeyinde ADRESLENEMEZ bile).
    /// </summary>
    public static string UserGroup(Guid userId) => $"user:{userId:D}";

    /// <summary>
    /// Redis payload'ının serileştirme sözleşmesi: camelCase + null'lar atlanmaz.
    /// İstemciye SignalR JSON protokolü de camelCase yazar — alan adları tek biçimdir.
    /// </summary>
    public static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

    public static string Serialize(JobProgressMessage message) =>
        JsonSerializer.Serialize(message, SerializerOptions);

    /// <summary>Bozuk payload'da null döner (forwarder loglayıp mesajı atlar — istisna akıtmaz).</summary>
    public static JobProgressMessage? TryDeserialize(string payload)
    {
        try
        {
            return JsonSerializer.Deserialize<JobProgressMessage>(payload, SerializerOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// Worker'ın her progress DB yazımının YANINDA yayınladığı mesaj (DB yazımı ve yoklama
/// davranışı değişmez — bu kanal yalnız EK bildirimdir; kalıcı doğruluk kaynağı Jobs satırıdır).
/// <para>
/// <c>status</c> teldeki yazımıyla taşınır ('queued'|'running'|'succeeded'|'failed'|'canceled')
/// ve <c>ExportJobDto.Status</c> ile AYNI kelime dağarcığıdır; iki üretici (API'nin
/// <c>StatusString</c>'i ve worker'ın <c>JobStatusWire</c>'ı) testle eşitlenir
/// (<c>ProgressHubTests.WorkerWireStatusMatchesTheApiDtoStatusForEveryJobStatus</c>).
/// Terminal mesaj (succeeded/failed/canceled) istemci için "otoriter DTO'yu bir kez çek"
/// sinyalidir — downloadUrl gibi imzalı alanlar bilerek BURADA taşınmaz (presign API'nin işi).
/// </para>
/// </summary>
/// <param name="JobId">Jobs satırının id'si — <see cref="JobProgressChannel.JobGroup"/> hedefi.</param>
/// <param name="JobType">'export' | 'processAsset' (bilinmeyen tür istemcide yok sayılır).</param>
/// <param name="AssetId">ProcessAsset işinde işlenen asset; export'ta null.</param>
/// <param name="ProjectId">Export işinde proje; ProcessAsset'te null (Jobs satırı taşımaz).</param>
/// <param name="Status">İşin tel-yazımlı durumu (yukarıdaki kelime dağarcığı).</param>
/// <param name="ProgressPercent">0-100.</param>
/// <param name="ProgressStage">Worker aşama anahtarı ('download'|'render'|... — DTO ile aynı).</param>
/// <param name="Error">Failed işte gerekçe; aksi halde null.</param>
/// <param name="OwnerId">
/// İşin sahibi (Jobs.RequestedBy) — forwarder'ın <see cref="JobProgressChannel.UserGroup"/>
/// feed hedefi (B6). Nullable ve varsayılanı null: alanı taşımayan (eski ikili) payload'da
/// forwarder feed gönderimini ATLAR, id-bazlı gruplar aynen beslenir. Feed grubu sahiplik
/// kapılıdır (parametresiz abonelik), dolayısıyla alan yalnız sahibinin kendisine ulaşır —
/// kimlik sızıntısı değildir.
/// </param>
public sealed record JobProgressMessage(
    Guid JobId,
    string JobType,
    Guid? AssetId,
    Guid? ProjectId,
    string Status,
    int ProgressPercent,
    string? ProgressStage,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error = null,
    Guid? OwnerId = null);
