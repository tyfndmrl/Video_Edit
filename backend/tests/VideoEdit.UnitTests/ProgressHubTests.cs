using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using VideoEdit.Api.Endpoints;
using VideoEdit.Api.Hubs;
using VideoEdit.Contracts;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// SignalR ilerleme kanalının in-process kanıt paketi (tasarım 03 §5; DECISIONS 2026-08-31).
/// Üç iddia sınıfı:
/// <list type="number">
///   <item>HUB KAPISI (pozitif yarım): sahibin aboneliği doğru gruba girer — ret yarısı IDOR
///     matrisinde (<see cref="CrossUserAccessTests"/> Hub_*; uç envanteri defteri oraya bağlı).</item>
///   <item>FORWARDER: Redis payload'ı doğru grup(lar)a, doğru hub metoduyla iletilir; bozuk
///     payload kanalı öldürmeden atlanır.</item>
///   <item>DAYANIKLILIK: Redis yok/erişilemezken forwarder API'yi DÜŞÜRMEZ (BackgroundService
///     istisna akıtsa host kapanırdı — StopHost varsayılanı) ve temiz durdurulur.</item>
/// </list>
/// Tel sözleşmesi testleri (durum/tür yazımları + camelCase alan adları) iki üreticinin
/// (API DTO'su / worker mesajı) ve TS istemcisinin aynı kelime dağarcığını okuduğunu sabitler.
/// </summary>
public sealed class ProgressHubTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly Guid _ownerId = Guid.CreateVersion7();

    public ProgressHubTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    private ClaimsPrincipal Owner =>
        new(new ClaimsIdentity([new Claim("sub", _ownerId.ToString("D"))], "test"));

    // ───────────────────── Hub kapısının pozitif yarımı ─────────────────────

    [Fact]
    public async Task SubscribeJob_OwnJob_JoinsTheJobGroup()
    {
        var job = SeedExportJob();
        var groups = new RecordingGroupManager();
        using var hub = new JobProgressHub(_db)
        {
            Context = new TestHubCallerContext(Owner, "conn-own"),
            Groups = groups,
        };

        await hub.SubscribeJob(job.Id);

        var added = Assert.Single(groups.Added);
        Assert.Equal("conn-own", added.ConnectionId);
        Assert.Equal($"job:{job.Id:D}", added.Group); // grup adı forwarder'ın hedefiyle birebir
        Assert.Equal(JobProgressChannel.JobGroup(job.Id), added.Group);
    }

    [Fact]
    public async Task SubscribeAsset_OwnAsset_JoinsTheAssetGroup()
    {
        var asset = SeedAsset(AssetStatus.Processing);
        var groups = new RecordingGroupManager();
        using var hub = new JobProgressHub(_db)
        {
            Context = new TestHubCallerContext(Owner, "conn-own"),
            Groups = groups,
        };

        await hub.SubscribeAsset(asset.Id);

        var added = Assert.Single(groups.Added);
        Assert.Equal(JobProgressChannel.AssetGroup(asset.Id), added.Group);
    }

    [Fact]
    public async Task Unsubscribe_RemovesOnlyTheCallersOwnConnection()
    {
        // Kapısız unsubscribe'ın zararsızlık gerekçesi: yalnız Context.ConnectionId düşer.
        var groups = new RecordingGroupManager();
        using var hub = new JobProgressHub(_db)
        {
            Context = new TestHubCallerContext(Owner, "conn-own"),
            Groups = groups,
        };
        var jobId = Guid.CreateVersion7();

        await hub.UnsubscribeJob(jobId);

        var removed = Assert.Single(groups.Removed);
        Assert.Equal(("conn-own", JobProgressChannel.JobGroup(jobId)), removed);
        Assert.Empty(groups.Added);
    }

    // ───────────────────── Forwarder: Redis → grup iletimi ─────────────────────

    [Fact]
    public async Task Forwarder_ExportMessage_IsSentToTheJobGroupWithTheHubMethod()
    {
        var hub = new RecordingHubContext();
        var forwarder = CreateForwarder(hub, redis: null);
        var jobId = Guid.CreateVersion7();
        var projectId = Guid.CreateVersion7();
        var message = new JobProgressMessage(
            jobId, "export", null, projectId, "running", 42, "render");

        await forwarder.ForwardAsync(JobProgressChannel.Serialize(message));

        var sent = Assert.Single(hub.Sent);
        Assert.Equal(JobProgressChannel.JobGroup(jobId), sent.Group);
        Assert.Equal(JobProgressChannel.HubMethod, sent.Method);
        var forwarded = Assert.IsType<JobProgressMessage>(Assert.Single(sent.Args));
        Assert.Equal(message, forwarded); // record eşitliği: tüm alanlar kayıpsız geçti
    }

    [Fact]
    public async Task Forwarder_AssetMessage_IsSentToBothJobAndAssetGroups()
    {
        var hub = new RecordingHubContext();
        var forwarder = CreateForwarder(hub, redis: null);
        var jobId = Guid.CreateVersion7();
        var assetId = Guid.CreateVersion7();
        var message = new JobProgressMessage(
            jobId, "processAsset", assetId, null, "running", 70, "filmstrip");

        await forwarder.ForwardAsync(JobProgressChannel.Serialize(message));

        // İstemci ProcessAsset işinin id'sini hiç görmez — asset grubuna İKİNCİ gönderim
        // (JobProgressHub.SubscribeAsset gerekçesi) olmadan bu mesajlar kimseye ulaşamazdı.
        Assert.Equal(2, hub.Sent.Count);
        Assert.Contains(hub.Sent, s => s.Group == JobProgressChannel.JobGroup(jobId));
        Assert.Contains(hub.Sent, s => s.Group == JobProgressChannel.AssetGroup(assetId));
        Assert.All(hub.Sent, s => Assert.Equal(JobProgressChannel.HubMethod, s.Method));
    }

    [Fact]
    public async Task Forwarder_MalformedPayload_IsSkippedWithoutThrowing()
    {
        var hub = new RecordingHubContext();
        var forwarder = CreateForwarder(hub, redis: null);

        await forwarder.ForwardAsync("{bozuk json");
        await forwarder.ForwardAsync("null");

        Assert.Empty(hub.Sent); // kanal yaşar, mesaj atlanır — istisna akıtılsa abonelik ölürdü
    }

    // ───────────────────── Dayanıklılık: Redis'siz API ayakta ─────────────────────

    [Fact]
    public async Task Forwarder_WithoutRedisConfigured_CompletesQuietlyInProduction()
    {
        // Prod + bağlantı dizisi yok → kanal bilinçli kapalı: ExecuteAsync fault'suz biter,
        // host'a dokunulmaz (istemciler polling'de kalır).
        var forwarder = CreateForwarder(new RecordingHubContext(), redis: null);

        await forwarder.StartAsync(CancellationToken.None);
        await WaitForAsync(() => forwarder.ExecuteTask?.IsCompleted == true, TimeSpan.FromSeconds(5));

        Assert.True(forwarder.ExecuteTask!.IsCompletedSuccessfully,
            "Redis yapılandırılmamışken forwarder sessizce (fault'suz) kapanmalıydı.");
        await forwarder.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Forwarder_WithUnreachableRedis_DoesNotFaultAndStopsCleanly()
    {
        // Erişilemeyen uç (port 1) + kısa connect timeout: API AÇILIŞI temsil eden StartAsync
        // fırlatmamalı, arka plan görevi fault'a düşmemeli (BackgroundService'in StopHost
        // varsayılanında fault = TÜM API'nin kapanması), durdurma temiz olmalı.
        var forwarder = CreateForwarder(
            new RecordingHubContext(), redis: "localhost:1,connectTimeout=200");

        await forwarder.StartAsync(CancellationToken.None);
        await Task.Delay(1200);

        Assert.NotNull(forwarder.ExecuteTask);
        Assert.False(forwarder.ExecuteTask!.IsFaulted,
            "Redis erişilemezken forwarder istisna akıttı — API bununla ÇÖKERDİ (StopHost).");
        await forwarder.StopAsync(CancellationToken.None);
        Assert.False(forwarder.ExecuteTask.IsFaulted);
    }

    // ───────────────────── Tel sözleşmesi (iki üretici + TS istemcisi) ─────────────────────

    [Fact]
    public void WorkerWireStatusMatchesTheApiDtoStatusForEveryJobStatus()
    {
        // Katman kuralı (Worker → Api referansı yok) yüzünden durum yazımı iki kopyadır;
        // bu test kopyaları HER enum değeri üzerinde eşitler — kelime dağarcığı ayrışamaz.
        foreach (var status in Enum.GetValues<JobStatus>())
        {
            Assert.Equal(
                ExportEndpoints.StatusString(status),
                JobProgressMessages.StatusWire(status));
        }
    }

    [Fact]
    public void EveryDefinedJobTypeHasAWireNameOtherThanUnknown()
    {
        foreach (var type in Enum.GetValues<JobType>())
        {
            Assert.NotEqual("unknown", JobProgressMessages.TypeWire(type));
        }
    }

    [Fact]
    public void SerializedPayloadUsesCamelCaseFieldsTheTsClientReads()
    {
        // TS istemcisi (entities/progressHub.ts) bu alan adlarını okur; SignalR JSON
        // protokolü da camelCase yazar — Redis payload'ı ile hub telinin aynı biçimde
        // olduğu buradan sabitlenir.
        var message = JobProgressMessages.FromJob(new Job
        {
            Id = Guid.CreateVersion7(),
            Type = JobType.Export,
            Status = JobStatus.Running,
            ProjectId = Guid.CreateVersion7(),
            ProgressPercent = 55,
            ProgressStage = "render",
        });

        using var doc = JsonDocument.Parse(JobProgressChannel.Serialize(message));
        var root = doc.RootElement;
        Assert.Equal(message.JobId, root.GetProperty("jobId").GetGuid());
        Assert.Equal("export", root.GetProperty("jobType").GetString());
        Assert.Equal("running", root.GetProperty("status").GetString());
        Assert.Equal(55, root.GetProperty("progressPercent").GetInt32());
        Assert.Equal("render", root.GetProperty("progressStage").GetString());

        var roundTripped = JobProgressChannel.TryDeserialize(JobProgressChannel.Serialize(message));
        Assert.Equal(message, roundTripped);
    }

    [Fact]
    public async Task PublisherOverride_CarriesTheExactSerializedMessage()
    {
        // Yayıncının tek görünür sözleşmesi: verilen mesajın Serialize çıktısını kanala
        // koymak. Gerçek Redis'siz test kancası publish yüzeyini birebir görür.
        string? captured = null;
        await using var publisher = new RedisJobProgressPublisher(
            "localhost:1", NullLogger<RedisJobProgressPublisher>.Instance, TimeProvider.System)
        {
            PublishOverride = payload =>
            {
                captured = payload;
                return Task.CompletedTask;
            },
        };
        var message = new JobProgressMessage(
            Guid.CreateVersion7(), "export", null, Guid.CreateVersion7(), "succeeded", 100, "done");

        await publisher.PublishAsync(message, CancellationToken.None);

        Assert.Equal(JobProgressChannel.Serialize(message), captured);
    }

    [Fact]
    public async Task Publisher_WithUnreachableRedis_NeverThrows()
    {
        // Worker tarafındaki dayanıklılık yarısı: publish hattı Redis'e ulaşamasa da iş
        // akışına istisna akıtmaz (JobProgressWriter DB yazımından sonra çağırır — fırlatma
        // progress yazımını cancel yoluna düşürürdü).
        await using var publisher = new RedisJobProgressPublisher(
            "localhost:1,connectTimeout=200",
            NullLogger<RedisJobProgressPublisher>.Instance, TimeProvider.System);
        var message = new JobProgressMessage(
            Guid.CreateVersion7(), "export", null, null, "running", 10, "download");

        await publisher.PublishAsync(message, CancellationToken.None); // fırlatmamalı
        await publisher.PublishAsync(message, CancellationToken.None); // bağlantı kurulmuşken de
    }

    // ───────────────────── Yardımcılar ─────────────────────

    private Job SeedExportJob()
    {
        var job = Job.Create(
            JobType.Export, _ownerId, DateTimeOffset.UtcNow,
            projectId: Guid.CreateVersion7(), exportProfile: "1080p");
        job.Status = JobStatus.Running;
        _db.Jobs.Add(job);
        _db.SaveChanges();
        return job;
    }

    private Asset SeedAsset(AssetStatus status)
    {
        var asset = Asset.Create(
            _ownerId, AssetKind.Video, "sahibin.mp4", "video/mp4", 1024, DateTimeOffset.UtcNow);
        asset.Status = status;
        _db.Assets.Add(asset);
        _db.SaveChanges();
        return asset;
    }

    private static RedisProgressForwarder CreateForwarder(
        RecordingHubContext hub, string? redis)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(redis is null
                ? []
                : new Dictionary<string, string?> { ["ConnectionStrings:Redis"] = redis })
            .Build();
        return new RedisProgressForwarder(
            hub, config, new ProductionEnvironment(),
            NullLogger<RedisProgressForwarder>.Instance);
    }

    private static async Task WaitForAsync(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (!condition() && DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(25);
        }
    }

    /// <summary>Prod ortam sahtesi: Development'ın localhost Redis fallback'i devreye girmesin.</summary>
    private sealed class ProductionEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Production;

        public string ApplicationName { get; set; } = "VideoEdit.UnitTests";

        public string ContentRootPath { get; set; } = AppContext.BaseDirectory;

        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
