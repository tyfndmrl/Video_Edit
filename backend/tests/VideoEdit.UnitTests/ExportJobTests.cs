using System.Text.Json;
using Hangfire;
using Hangfire.States;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media;
using VideoEdit.Media.Probing;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// ExportJob'ın process'siz doğrulanabilen davranışları (Sqlite in-memory + stub storage):
/// deterministik hata yolları (retry'sız Failed), cancel kısa devresi, disk tahmini formülü
/// ve JobFailureStateFilter'ın export satırlarına da uygulandığı (ilk argüman Guid deseni).
/// </summary>
public sealed class ExportJobTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly Guid _userId = Guid.CreateVersion7();

    public ExportJobTests()
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

    private ExportJob CreateJobRunner()
    {
        var ffmpegOptions = new FfmpegOptions();
        var storage = new StubStorage();
        return new ExportJob(
            _db,
            storage,
            new FfprobeService(ffmpegOptions),
            new FfmpegRunner(ffmpegOptions),
            new OriginalCache(storage, new ProcessingOptions()),
            new NoOpJobClient(),
            NullLogger<ExportJob>.Instance,
            TimeProvider.System);
    }

    private async Task<Job> SeedExportJobAsync(string timelineJson, JobStatus status = JobStatus.Queued)
    {
        var job = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow,
            projectId: Guid.CreateVersion7(),
            timelineSnapshot: JsonDocument.Parse(timelineJson),
            exportProfile: "1080p");
        job.Status = status;
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();
        return job;
    }

    private Job Reload(Guid jobId)
    {
        using var ctx = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        return ctx.Jobs.AsNoTracking().Single(j => j.Id == jobId);
    }

    // ---------- Deterministik hata yolları (retry YOK — exception fırlamaz) ----------

    [Fact]
    public async Task Run_UnsupportedFeatureSnapshot_FailsWithoutRetry()
    {
        // Çok katman (M4 dalga 1), metin/şekil/çıkartma ve geçişler (M4 dalga 2) ARTIK
        // desteklenir; kapsam dışı kalan HIZ değişimiyle test edilir (M5).
        var clip = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Speed = new VideoEdit.Contracts.Timeline.MediaClipSpeed { Rate = 2 };
        clip.TimelineDurationUs = 500_000;
        var job = await SeedExportJobAsync(ExportTestDocs.ToJson(ExportTestDocs.Doc(clips: clip)));

        await CreateJobRunner().Run(job.Id, CancellationToken.None); // fırlatmamalı

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Failed, reloaded.Status);
        Assert.Contains("unsupported-feature:speed", reloaded.ErrorMessage);
        Assert.NotNull(reloaded.CompletedAt);
    }

    [Fact]
    public async Task Run_OverlayClipWithoutTheRasterService_FailsDeterministically()
    {
        // M4 dalga 2: metin/şekil klibi SkiaSharp rasteri ister. Servis DI'a kayıtlı değilse
        // ExportCompiler.Compile "no raster provided" ile ArgumentException atardı ve iş
        // TRANSIENT sayılıp 3 kez retry edilirdi (aynı sonuç, boşuna). Kurulum hatası
        // deterministik olarak kapatılır.
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.OverlayTrack(clips: [ExportTestDocs.TextClip(0, 1_000_000)]),
        ]);
        var job = await SeedExportJobAsync(ExportTestDocs.ToJson(doc));

        await CreateJobRunner().Run(job.Id, CancellationToken.None); // fırlatmamalı

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Failed, reloaded.Status);
        Assert.Contains("overlay-raster-unavailable", reloaded.ErrorMessage);
    }

    [Fact]
    public async Task Run_UnparsableSnapshot_FailsDeterministically()
    {
        var job = await SeedExportJobAsync("""{"schemaVersion":"garbage"}""");

        await CreateJobRunner().Run(job.Id, CancellationToken.None);

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Failed, reloaded.Status);
        Assert.Contains("invalid-timeline", reloaded.ErrorMessage);
    }

    [Fact]
    public async Task Run_MissingAsset_FailsDeterministically()
    {
        // Geçerli doküman ama referans verilen asset DB'de yok.
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        var job = await SeedExportJobAsync(ExportTestDocs.ToJson(doc));

        await CreateJobRunner().Run(job.Id, CancellationToken.None);

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Failed, reloaded.Status);
        Assert.Contains("asset-missing", reloaded.ErrorMessage);
    }

    [Fact]
    public async Task Run_AssetNotReady_FailsDeterministically()
    {
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        var asset = Asset.Create(_userId, AssetKind.Video, "a.mp4", "video/mp4", 100, DateTimeOffset.UtcNow);
        asset.Id = ExportTestDocs.AssetA; // doc'un referansladığı id
        asset.StorageKey = $"u/{_userId}/a/{asset.Id}/original/source.mp4";
        _db.Assets.Add(asset); // Status: Uploading (Ready değil)
        await _db.SaveChangesAsync();
        var job = await SeedExportJobAsync(ExportTestDocs.ToJson(doc));

        await CreateJobRunner().Run(job.Id, CancellationToken.None);

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Failed, reloaded.Status);
        Assert.Contains("asset-not-ready", reloaded.ErrorMessage);
    }

    [Fact]
    public async Task Run_CanceledBeforeStart_ShortCircuits()
    {
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        var job = await SeedExportJobAsync(ExportTestDocs.ToJson(doc), JobStatus.Canceled);

        await CreateJobRunner().Run(job.Id, CancellationToken.None);

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Canceled, reloaded.Status); // dokunulmadı
        Assert.Equal(0, reloaded.AttemptCount);
    }

    [Fact]
    public async Task Run_MissingJobRow_IsNoOp()
    {
        await CreateJobRunner().Run(Guid.CreateVersion7(), CancellationToken.None);
        Assert.Empty(_db.Jobs.ToList());
    }

    // ---------- Kaynak aralığı gate'i (source-out-of-range) ----------

    [Fact]
    public void FindSourceOutOfRange_ToleratesOneOutputFrame()
    {
        var clips = new[]
        {
            ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 3_000_000),
        };

        // 3 sn klip, 3 sn kaynak: tam sınır — ihlal yok.
        Assert.Null(ExportJob.FindSourceOutOfRange(clips, ExportTestDocs.AssetA, 3_000_000, 30, 1));
        // Kaynak 1 frame kısa (33333 µs tolerans): hâlâ ihlal yok.
        Assert.Null(ExportJob.FindSourceOutOfRange(clips, ExportTestDocs.AssetA, 2_970_000, 30, 1));
        // Kaynak 2 frame kısa: ihlal — klip döner.
        var bad = ExportJob.FindSourceOutOfRange(clips, ExportTestDocs.AssetA, 2_930_000, 30, 1);
        Assert.NotNull(bad);
        Assert.Equal(clips[0].Id, bad!.Id);
        // Başka asset'in klipleri bu asset'in süresiyle sorgulanmaz.
        Assert.Null(ExportJob.FindSourceOutOfRange(clips, ExportTestDocs.AssetB, 1, 30, 1));
        // Süre ölçülemediyse gate atlanır.
        Assert.Null(ExportJob.FindSourceOutOfRange(clips, ExportTestDocs.AssetA, null, 30, 1));
    }

    // ---------- Disk tahmini + disk-yetersiz yolu ----------

    [Fact]
    public void EstimateRequiredDiskBytes_AddsOutputEstimateAndTwentyPercent()
    {
        // 100 MB kaynak + 60 sn × 10 Mbps → 75 MB çıktı; toplam × 1.2.
        var estimate = ExportJob.EstimateRequiredDiskBytes(100_000_000, 60_000_000, 10_000_000);
        Assert.Equal((100_000_000L + 75_000_000L) * 12 / 10, estimate);
    }

    private async Task<Job> SeedReadyAssetAndJobAsync()
    {
        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(_userId, AssetKind.Video, "a.mp4", "video/mp4", 100, now);
        asset.Id = ExportTestDocs.AssetA;
        asset.StorageKey = $"u/{_userId}/a/{asset.Id}/original/source.mp4";
        asset.TransitionTo(AssetStatus.Uploaded, now);
        asset.TransitionTo(AssetStatus.Processing, now);
        asset.TransitionTo(AssetStatus.Ready, now);
        _db.Assets.Add(asset);
        await _db.SaveChangesAsync();

        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        return await SeedExportJobAsync(ExportTestDocs.ToJson(doc));
    }

    [Fact]
    public async Task Run_InsufficientDisk_TrimsCacheAggressively_ThenRequeues()
    {
        // Kurulum: LRU cache'te pin'lenmemiş (başka asset'e ait) bir girdi var; disk hep "dolu".
        var cacheRoot = Directory.CreateTempSubdirectory("videoedit-diskfull-").FullName;
        var junkDir = Path.Combine(cacheRoot, Guid.CreateVersion7().ToString("N"));
        Directory.CreateDirectory(junkDir);
        await File.WriteAllBytesAsync(Path.Combine(junkDir, "original.mp4"), new byte[128]);
        var pinnedDir = Path.Combine(cacheRoot, ExportTestDocs.AssetA.ToString("N"));
        Directory.CreateDirectory(pinnedDir);
        await File.WriteAllBytesAsync(Path.Combine(pinnedDir, "original.mp4"), new byte[128]);

        var job = await SeedReadyAssetAndJobAsync();
        var jobs = new RecordingJobClient();
        var storage = new StubStorage();
        var ffmpegOptions = new FfmpegOptions();
        var runner = new ExportJob(
            _db, storage,
            new FfprobeService(ffmpegOptions), new FfmpegRunner(ffmpegOptions),
            new OriginalCache(storage, new ProcessingOptions { CacheDirectory = cacheRoot }),
            jobs, NullLogger<ExportJob>.Instance, TimeProvider.System)
        {
            FreeSpaceProbe = _ => 1, // trim'den sonra da yetersiz
        };

        try
        {
            await runner.Run(job.Id, CancellationToken.None);

            // Ertelemeden ÖNCE agresif trim: pin'lenmemiş girdi silindi, bu işin kaynağı korundu.
            Assert.False(Directory.Exists(junkDir), "unpinned cache entry should be trimmed");
            Assert.True(Directory.Exists(pinnedDir), "pinned (this job's) cache entry must survive");

            var reloaded = Reload(job.Id);
            Assert.Equal(JobStatus.Queued, reloaded.Status);
            Assert.Equal("disk-wait", reloaded.ProgressStage);
            Assert.Equal(1, jobs.ScheduleCount); // 2 dk sonraya yeniden kuyruklandı
        }
        finally
        {
            try
            {
                Directory.Delete(cacheRoot, recursive: true);
            }
            catch
            {
                // best-effort
            }
        }
    }

    [Fact]
    public async Task Run_TrimFreesEnoughDisk_ContinuesInsteadOfRequeuing()
    {
        var cacheRoot = Directory.CreateTempSubdirectory("videoedit-disktrim-").FullName;
        var junkDir = Path.Combine(cacheRoot, Guid.CreateVersion7().ToString("N"));
        Directory.CreateDirectory(junkDir);
        await File.WriteAllBytesAsync(Path.Combine(junkDir, "original.mp4"), new byte[128]);

        var job = await SeedReadyAssetAndJobAsync();
        var jobs = new RecordingJobClient();
        var storage = new StubStorage();
        var ffmpegOptions = new FfmpegOptions();
        var runner = new ExportJob(
            _db, storage,
            new FfprobeService(ffmpegOptions), new FfmpegRunner(ffmpegOptions),
            new OriginalCache(storage, new ProcessingOptions { CacheDirectory = cacheRoot }),
            jobs, NullLogger<ExportJob>.Instance, TimeProvider.System);
        // Trim junk'ı silene KADAR disk "dolu": trim sonrası ikinci ölçüm bol alan görür.
        runner.FreeSpaceProbe = _ => Directory.Exists(junkDir) ? 1 : long.MaxValue;

        try
        {
            // Devam ettiğinin kanıtı: indirme aşamasına geçilir ve StubStorage patlar
            // (transient sınıfı — Run yeniden fırlatır). Erteleme YOK, Failed YOK.
            await Assert.ThrowsAsync<NotSupportedException>(
                () => runner.Run(job.Id, CancellationToken.None));

            Assert.False(Directory.Exists(junkDir));
            Assert.Equal(0, jobs.ScheduleCount);
            var reloaded = Reload(job.Id);
            Assert.Equal(JobStatus.Running, reloaded.Status); // erteleme/fail yazılmadı
        }
        finally
        {
            try
            {
                Directory.Delete(cacheRoot, recursive: true);
            }
            catch
            {
                // best-effort
            }
        }
    }

    // ---------- JobFailureStateFilter export satırına da uygulanır ----------

    [Fact]
    public async Task JobFailureStateFilter_SyncsExportJobRow_WithoutAsset()
    {
        var doc = ExportTestDocs.Doc(clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        var job = await SeedExportJobAsync(ExportTestDocs.ToJson(doc), JobStatus.Running);

        // Filtre ExportJob.Run(Guid, ct) argümanından satır id'sini çözebilmeli.
        Assert.True(JobFailureStateFilter.TryGetJobRowId([job.Id], out var resolved));
        Assert.Equal(job.Id, resolved);

        JobFailureStateFilter.SyncFailure(_db, job.Id, "hangfire-failed: boom", DateTimeOffset.UtcNow);

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Failed, reloaded.Status);
        Assert.Equal("hangfire-failed: boom", reloaded.ErrorMessage);
        Assert.NotNull(reloaded.CompletedAt);
    }

    // ---------- Sahteler ----------

    private sealed class NoOpJobClient : IBackgroundJobClient
    {
        public string Create(Hangfire.Common.Job job, IState state) => Guid.NewGuid().ToString("N");

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }

    /// <summary>Schedule (ScheduledState ile Create) çağrılarını sayan Hangfire istemcisi.</summary>
    private sealed class RecordingJobClient : IBackgroundJobClient
    {
        public int CreateCount { get; private set; }
        public int ScheduleCount { get; private set; }

        public string Create(Hangfire.Common.Job job, IState state)
        {
            CreateCount++;
            if (state is ScheduledState)
            {
                ScheduleCount++;
            }

            return Guid.NewGuid().ToString("N");
        }

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }

    /// <summary>Bu testlerde storage'a hiç inilmez — inilirse patlasın.</summary>
    private sealed class StubStorage : IStorageService
    {
        public Task<string> CreateMultipartUploadAsync(string key, string contentType, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public string PresignUploadPart(string key, string uploadId, int partNumber) =>
            throw new NotSupportedException();

        public Task CompleteMultipartUploadAsync(
            string key, string uploadId, IReadOnlyList<StorageCompletedPart> parts, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task AbortMultipartUploadAsync(string key, string uploadId, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task<IReadOnlyList<StorageUploadedPart>> ListPartsAsync(
            string key, string uploadId, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task<StorageObjectInfo?> HeadObjectAsync(string key, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public string PresignGet(string key) => throw new NotSupportedException();

        public Task DeletePrefixAsync(string prefix, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task DeleteObjectAsync(string key, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task<StorageDownload> OpenReadAsync(string key, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task UploadFileAsync(string key, string filePath, string contentType, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public Task UploadExportAsync(string key, string filePath, string contentType, CancellationToken ct = default) =>
            throw new NotSupportedException();

        public string PresignExportGet(string key) => throw new NotSupportedException();

        public Task EnsureBucketsExistAsync(CancellationToken ct = default) => Task.CompletedTask;
    }
}
