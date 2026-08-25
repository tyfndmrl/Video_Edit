using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media.Probing;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// M1 denetim düzeltmelerinin birim testleri (Hangfire/MinIO/ffmpeg'siz):
///  - reaper heartbeat davranışı (canlı işi süpürmez; ölü Job satırlarını Failed('stalled') yapar);
///  - JobFailureStateFilter durum senkronu (nihai FailedState → Jobs Failed + asset Fail);
///  - süre-farkındalı disk tahmini;
///  - kind gate ('kind-mismatch' dahil).
/// Storage bilerek BOZUK endpoint'li gerçek R2StorageService'tir — bu senaryolarda hiçbir
/// storage çağrısı beklenmez; yanlışlıkla çağrılırsa test ağ hatasıyla kırılır (istenen budur).
/// </summary>
public sealed class WorkerReliabilityTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 08, 07, 12, 0, 0, TimeSpan.Zero);

    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly R2StorageService _storage;

    public WorkerReliabilityTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _storage = new R2StorageService(Options.Create(new R2Options
        {
            ServiceUrl = "http://localhost:9", // kasten ölü port — çağrı beklenmez
            AccessKeyId = "unused",
            SecretAccessKey = "unused",
            Bucket = "unused",
        }));
    }

    public void Dispose()
    {
        _storage.Dispose();
        _db.Dispose();
        _connection.Dispose();
    }

    private readonly RunningRenderRegistry _renders = new();

    private AssetReaperJob CreateReaper() => new(
        _db, _storage, NullLogger<AssetReaperJob>.Instance, new FixedTimeProvider(Now), _renders);

    private async Task<(Asset Asset, Job Job)> SeedProcessingAssetAsync(
        TimeSpan processingAge, TimeSpan? lastProgressAge)
    {
        var owner = Guid.NewGuid();
        var asset = Asset.Create(owner, AssetKind.Video, "a.mp4", "video/mp4", 1024, Now - processingAge);
        asset.TransitionTo(AssetStatus.Uploaded, Now - processingAge);
        asset.TransitionTo(AssetStatus.Processing, Now - processingAge);
        _db.Assets.Add(asset);

        var job = Job.Create(JobType.ProcessAsset, owner, Now - processingAge, assetId: asset.Id);
        job.Status = JobStatus.Running;
        job.StartedAt = Now - processingAge;
        job.LastProgressAt = lastProgressAge is { } age ? Now - age : null;
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();
        return (asset, job);
    }

    // ───────────────────── Reaper: heartbeat ─────────────────────

    [Fact]
    public async Task Reaper_ProcessingAssetWithRecentHeartbeat_IsNotSwept()
    {
        // 1 saattir Processing ama işin heartbeat'i 5 dk önce — uzun transcode CANLI, süpürülmez.
        var (asset, job) = await SeedProcessingAssetAsync(
            processingAge: TimeSpan.FromHours(1), lastProgressAge: TimeSpan.FromMinutes(5));

        await CreateReaper().Run(CancellationToken.None);

        Assert.Equal(AssetStatus.Processing, asset.Status);
        Assert.Null(asset.FailureReason);
        Assert.Equal(JobStatus.Running, job.Status);
    }

    [Fact]
    public async Task Reaper_ProcessingAssetWithStaleHeartbeat_IsSweptStalled()
    {
        // 1 saattir Processing, son heartbeat 20 dk önce (>10 dk grace) — ölü, Failed('stalled').
        var (asset, _) = await SeedProcessingAssetAsync(
            processingAge: TimeSpan.FromHours(1), lastProgressAge: TimeSpan.FromMinutes(20));

        await CreateReaper().Run(CancellationToken.None);

        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("stalled", asset.FailureReason);
    }

    [Fact]
    public async Task Reaper_ProcessingAssetWithoutAnyHeartbeat_IsSweptStalled()
    {
        var (asset, _) = await SeedProcessingAssetAsync(
            processingAge: TimeSpan.FromMinutes(45), lastProgressAge: null);

        await CreateReaper().Run(CancellationToken.None);

        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("stalled", asset.FailureReason);
    }

    [Fact]
    public async Task Reaper_FreshProcessingAsset_IsUntouched()
    {
        var (asset, _) = await SeedProcessingAssetAsync(
            processingAge: TimeSpan.FromMinutes(5), lastProgressAge: null);

        await CreateReaper().Run(CancellationToken.None);

        Assert.Equal(AssetStatus.Processing, asset.Status);
    }

    // ───────────────────── Reaper: stalled Job satırları ─────────────────────

    [Fact]
    public async Task Reaper_RunningJobSilentBeyondThreshold_IsFailedStalled()
    {
        var job = Job.Create(JobType.ProcessAsset, Guid.NewGuid(), Now - TimeSpan.FromHours(8));
        job.Status = JobStatus.Running;
        job.StartedAt = Now - TimeSpan.FromHours(7); // > 6 saatlik eşik
        _db.Jobs.Add(job);

        var freshQueued = Job.Create(JobType.ProcessAsset, Guid.NewGuid(), Now - TimeSpan.FromMinutes(10));
        _db.Jobs.Add(freshQueued);
        await _db.SaveChangesAsync();

        await CreateReaper().Run(CancellationToken.None);

        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.Contains("stalled", job.ErrorMessage!, StringComparison.Ordinal);
        Assert.NotNull(job.CompletedAt);
        Assert.Equal(JobStatus.Queued, freshQueued.Status); // taze Queued'a dokunulmaz
    }

    [Fact]
    public async Task Reaper_StalledJob_AlsoAbortsItsRunningRender()
    {
        // SATIRI DÜZELTMEK YETMEZ. Reaper işi 'stalled' yazarken ffmpeg süreci hâlâ koşuyor
        // olabilirdi; export kuyruğu tek kanal olduğu için o süreç HERKESİN export'unu
        // tutmaya devam ederdi — satır "başarısız" derken makine meşgul kalırdı.
        var job = Job.Create(JobType.Export, Guid.NewGuid(), Now - TimeSpan.FromHours(8));
        job.Status = JobStatus.Running;
        job.StartedAt = Now - TimeSpan.FromHours(7); // > 6 saatlik eşik
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        // Koşan render'ın iptal kancası — ExportJob'ın kaydettiğinin aynısı.
        using var cancellation = new CancellationTokenSource();
        using var registration = _renders.Register(job.Id, cancellation);

        await CreateReaper().Run(CancellationToken.None);

        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.True(cancellation.IsCancellationRequested,
            "reaper 'stalled' yazarken koşan render'ı da iptal etmeliydi "
            + "(FfmpegRunner'ın iptal kaydı süreç ağacını öldürür)");
    }

    [Fact]
    public async Task Reaper_StalledJob_CommitsTheDbVerdictBeforeKillingTheRender()
    {
        // DB SATIRI SÜREÇLER-ARASI İPTAL KANALIDIR: başka worker'daki render satırı yoklayarak
        // ölür (ExportJob render yoklaması), bu süreçteki render ise Abort ile. İkisinin de tek
        // hakemi DB'deki satırdır — bu yüzden reaper ÖNCE yazmalı (commit), SONRA öldürmelidir.
        // Ters sırada, öldürülen işin OperationCanceledException yolu satırı Running okur,
        // Hangfire retry'ına gider ve 'stalled' satır yeniden Running'e çevrilip DİRİLİRDİ.
        var job = Job.Create(JobType.Export, Guid.NewGuid(), Now - TimeSpan.FromHours(8));
        job.Status = JobStatus.Running;
        job.StartedAt = Now - TimeSpan.FromHours(7); // > 6 saatlik eşik
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        // Öldürme ANINDA (token callback'i Abort içinde senkron koşar) satırın DB'de ne
        // dediğini AYRI bir context'ten okuyoruz — ExportJob'ın iptal yolunun yapacağı okuma.
        JobStatus? statusAtKillTime = null;
        using var cancellation = new CancellationTokenSource();
        using var killObserver = cancellation.Token.Register(() =>
        {
            using var probe = new AppDbContext(
                new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
            statusAtKillTime = probe.Jobs.AsNoTracking()
                .Where(j => j.Id == job.Id)
                .Select(j => (JobStatus?)j.Status)
                .SingleOrDefault();
        });
        using var registration = _renders.Register(job.Id, cancellation);

        await CreateReaper().Run(CancellationToken.None);

        Assert.True(cancellation.IsCancellationRequested, "koşan render iptal edilmeliydi");
        Assert.Equal(JobStatus.Failed, statusAtKillTime);
    }

    [Fact]
    public async Task Reaper_LiveJob_DoesNotAbortItsRender()
    {
        // YANLIŞ ÖLDÜRME ÜRETME: eşiğin altındaki (canlı) bir işin render'ına DOKUNULMAZ.
        // Bu iddia olmadan "reaper süreci öldürür" cümlesi tehlikeli bir yarım gerçekti.
        var job = Job.Create(JobType.Export, Guid.NewGuid(), Now - TimeSpan.FromMinutes(20));
        job.Status = JobStatus.Running;
        job.StartedAt = Now - TimeSpan.FromMinutes(20);
        job.LastProgressAt = Now - TimeSpan.FromMinutes(1);
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        using var cancellation = new CancellationTokenSource();
        using var registration = _renders.Register(job.Id, cancellation);

        await CreateReaper().Run(CancellationToken.None);

        Assert.Equal(JobStatus.Running, job.Status);
        Assert.False(cancellation.IsCancellationRequested);
    }

    [Fact]
    public void RenderRegistry_DropsTheEntryWhenTheRegistrationIsDisposed()
    {
        // KAYIT DÜŞMELİ: bitmiş bir işin kancası defterde kalsaydı reaper onu iptal etmeye
        // çalışır ve (CancellationTokenSource dispose edilmişse) ObjectDisposedException'a
        // düşerdi — Abort o hâli yutuyor, ama defterin sızması yine de bir kusurdur.
        var registry = new RunningRenderRegistry();
        var jobId = Guid.CreateVersion7();
        using var cancellation = new CancellationTokenSource();

        var registration = registry.Register(jobId, cancellation);
        Assert.Equal(1, registry.Count);
        Assert.True(registry.Abort(jobId));

        registration.Dispose();
        Assert.Equal(0, registry.Count);
        Assert.False(registry.Abort(jobId)); // artık kayıt yok → "öldürdüm" DEMEZ
    }

    [Fact]
    public async Task Reaper_RunningJobWithRecentProgress_IsKept()
    {
        // StartedAt çok eski ama LastProgressAt taze — iş yaşıyor (LastProgressAt öncelikli).
        var job = Job.Create(JobType.ProcessAsset, Guid.NewGuid(), Now - TimeSpan.FromDays(1));
        job.Status = JobStatus.Running;
        job.StartedAt = Now - TimeSpan.FromDays(1);
        job.LastProgressAt = Now - TimeSpan.FromMinutes(3);
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        await CreateReaper().Run(CancellationToken.None);

        Assert.Equal(JobStatus.Running, job.Status);
    }

    // ───────────────────── JobFailureStateFilter ─────────────────────

    [Fact]
    public void SyncFailure_RunningJobAndProcessingAsset_BothMarkedFailed()
    {
        var owner = Guid.NewGuid();
        var asset = Asset.Create(owner, AssetKind.Video, "a.mp4", "video/mp4", 10, Now);
        asset.TransitionTo(AssetStatus.Uploaded, Now);
        asset.TransitionTo(AssetStatus.Processing, Now);
        _db.Assets.Add(asset);
        var job = Job.Create(JobType.ProcessAsset, owner, Now, assetId: asset.Id);
        job.Status = JobStatus.Running;
        _db.Jobs.Add(job);
        _db.SaveChanges();

        JobFailureStateFilter.SyncFailure(_db, job.Id, "hangfire-failed: boom", Now);

        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.Equal("hangfire-failed: boom", job.ErrorMessage);
        Assert.Equal(Now, job.CompletedAt);
        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("processing-error", asset.FailureReason);
    }

    [Fact]
    public void SyncFailure_TerminalJob_IsUntouched()
    {
        // Deterministik yol satırı zaten Failed + açıklayıcı mesajla yazmıştır — filtre ezmez.
        var job = Job.Create(JobType.ProcessAsset, Guid.NewGuid(), Now);
        job.Status = JobStatus.Failed;
        job.ErrorMessage = "unsupported-media: original diagnosis";
        _db.Jobs.Add(job);
        _db.SaveChanges();

        JobFailureStateFilter.SyncFailure(_db, job.Id, "hangfire-failed: later noise", Now);

        Assert.Equal("unsupported-media: original diagnosis", job.ErrorMessage);
    }

    [Fact]
    public void SyncFailure_UnknownJob_NoThrow()
    {
        JobFailureStateFilter.SyncFailure(_db, Guid.NewGuid(), "x", Now); // sessizce no-op
    }

    [Fact]
    public void TryGetJobRowId_GuidAndStringForms_Parsed_OthersRejected()
    {
        var id = Guid.NewGuid();
        Assert.True(JobFailureStateFilter.TryGetJobRowId([id, CancellationToken.None], out var fromGuid));
        Assert.Equal(id, fromGuid);
        Assert.True(JobFailureStateFilter.TryGetJobRowId([id.ToString("D")], out var fromString));
        Assert.Equal(id, fromString);
        Assert.False(JobFailureStateFilter.TryGetJobRowId([CancellationToken.None], out _)); // reaper imzası
        Assert.False(JobFailureStateFilter.TryGetJobRowId([], out _));
        Assert.False(JobFailureStateFilter.TryGetJobRowId(null, out _));
    }

    // ───────────────────── Disk tahmini ─────────────────────

    [Fact]
    public void EstimateRequiredDiskBytes_UnknownDuration_FallsBackToMultiplier()
    {
        Assert.Equal(3_000, ProcessAssetJob.EstimateRequiredDiskBytes(1_000, null));
        Assert.Equal(3_000, ProcessAssetJob.EstimateRequiredDiskBytes(1_000, 0));
    }

    [Fact]
    public void EstimateRequiredDiskBytes_DurationAware_OriginalPlusProxyPlusMargin()
    {
        // 100 sn @ ~3 Mbps → proxy 37_500_000 B; +%20 → 45_000_000; + orijinal 10_000_000.
        Assert.Equal(55_000_000, ProcessAssetJob.EstimateRequiredDiskBytes(10_000_000, 100_000_000));
    }

    [Fact]
    public void EstimateRequiredDiskBytes_LongLowBitrateSource_ExceedsOldMultiplierEstimate()
    {
        // Denetim gerekçesi: 4 saatlik 1 GB HEVC'de eski 3× tahmin (3 GB) proxy'yi KÜÇÜMSER —
        // süre-farkındalı tahmin (1 GB + 4sa×3Mbps×1.2 ≈ 7.5 GB) daha büyük olmalı.
        const long gb = 1_000_000_000;
        const long fourHoursUs = 4L * 3600 * 1_000_000;
        var estimate = ProcessAssetJob.EstimateRequiredDiskBytes(gb, fourHoursUs);
        Assert.True(estimate > 3 * gb, $"expected duration-aware estimate > 3 GB, got {estimate}");
    }

    // ───────────────────── Kind gate ─────────────────────

    private static MediaProbe Probe(
        bool hasVideo, bool hasAudio, long? durationUs) => new()
    {
        RawJson = "{}",
        HasVideo = hasVideo,
        HasAudio = hasAudio,
        DurationUs = durationUs,
        Width = hasVideo ? 640 : 0,
        Height = hasVideo ? 480 : 0,
    };

    [Fact]
    public void GateByKind_ImageWithVideoDurationOrAudio_IsKindMismatch()
    {
        // Gerçek video Image beyanıyla: süre > 1 sn → kind-mismatch.
        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Image, Probe(hasVideo: true, hasAudio: false, durationUs: 5_000_000),
            out var reason, out _));
        Assert.Equal("kind-mismatch", reason);

        // Sesli container Image beyanıyla: süre kısa bile olsa ses → kind-mismatch.
        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Image, Probe(hasVideo: true, hasAudio: true, durationUs: 500_000),
            out reason, out _));
        Assert.Equal("kind-mismatch", reason);
    }

    [Fact]
    public void GateByKind_RealStillImage_Passes()
    {
        // PNG/JPEG: süre yok ya da tek-kare düzeyinde (~0.04 sn) — geçer.
        Assert.True(ProcessAssetJob.GateByKind(
            AssetKind.Image, Probe(hasVideo: true, hasAudio: false, durationUs: null), out _, out _));
        Assert.True(ProcessAssetJob.GateByKind(
            AssetKind.Image, Probe(hasVideo: true, hasAudio: false, durationUs: 40_000), out _, out _));
    }

    [Fact]
    public void GateByKind_MissingStreams_AreUnsupportedMedia()
    {
        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Video, Probe(hasVideo: false, hasAudio: true, durationUs: 1_000_000),
            out var reason, out _));
        Assert.Equal("unsupported-media", reason);

        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Audio, Probe(hasVideo: true, hasAudio: false, durationUs: 1_000_000),
            out reason, out _));
        Assert.Equal("unsupported-media", reason);

        Assert.False(ProcessAssetJob.GateByKind(
            AssetKind.Image, Probe(hasVideo: false, hasAudio: false, durationUs: null),
            out reason, out _));
        Assert.Equal("unsupported-media", reason);
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
