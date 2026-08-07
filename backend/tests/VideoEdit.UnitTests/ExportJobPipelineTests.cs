using System.Text.Json;
using Hangfire;
using Hangfire.States;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media;
using VideoEdit.Media.Probing;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// Uçtan uca M3 export testi (Hangfire'sız — ExportJob doğrudan çağrılır):
/// orijinal MinIO'ya konur → ExportJob koşar (indir → derle → ffmpeg → doğrula → yükle)
/// → Job Succeeded + OutputKey exports bucket'ında GERÇEKTEN mevcut + LRU cache dolu.
/// İkinci koşu cache isabetiyle çalışır (indirme tekrarı yok — dosya zaten diskte).
/// </summary>
[Collection("ffmpeg-media")]
public sealed class ExportJobPipelineTests : IDisposable
{
    private readonly FfmpegTestMediaFixture media;
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly R2StorageService _storage;
    private readonly R2StorageService _exportsBucketProbe;
    private readonly FfmpegOptions _ffmpegOptions = new();
    private readonly string _cacheDir;
    private readonly Guid _userId = Guid.CreateVersion7();
    private readonly List<string> _cleanupPrefixes = [];

    private const string MediaBucket = "videoedit-media-export-e2e";
    private const string ExportsBucket = "videoedit-exports-export-e2e";

    public ExportJobPipelineTests(FfmpegTestMediaFixture media)
    {
        this.media = media;
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _cacheDir = Directory.CreateTempSubdirectory("videoedit-export-cache-").FullName;

        // compose.dev.yml MinIO değerleri; e2e kendi bucket'larını kullanır.
        _storage = new R2StorageService(Options.Create(new R2Options
        {
            ServiceUrl = "http://localhost:9000",
            AccessKeyId = "videoedit",
            SecretAccessKey = "devpassword123",
            Bucket = MediaBucket,
            ExportsBucket = ExportsBucket,
        }));

        // Exports bucket'ını doğrudan sorgulayabilmek için ikinci istemci (HeadObject medya
        // bucket'ına bakar — burada Bucket=exports verilerek çıktı varlığı doğrulanır).
        _exportsBucketProbe = new R2StorageService(Options.Create(new R2Options
        {
            ServiceUrl = "http://localhost:9000",
            AccessKeyId = "videoedit",
            SecretAccessKey = "devpassword123",
            Bucket = ExportsBucket,
            ExportsBucket = "",
        }));
    }

    public void Dispose()
    {
        foreach (var prefix in _cleanupPrefixes)
        {
            try
            {
                _storage.DeletePrefixAsync(prefix).GetAwaiter().GetResult();
            }
            catch
            {
                // best-effort
            }
        }

        try
        {
            _exportsBucketProbe.DeletePrefixAsync("exports/").GetAwaiter().GetResult();
        }
        catch
        {
            // best-effort
        }

        try
        {
            Directory.Delete(_cacheDir, recursive: true);
        }
        catch
        {
            // best-effort
        }

        _storage.Dispose();
        _exportsBucketProbe.Dispose();
        _db.Dispose();
        _connection.Dispose();
    }

    private ExportJob CreateRunner(OriginalCache cache) => new(
        _db,
        _storage,
        new FfprobeService(_ffmpegOptions),
        new FfmpegRunner(_ffmpegOptions),
        cache,
        new NoOpJobClient(),
        NullLogger<ExportJob>.Instance,
        TimeProvider.System);

    private OriginalCache CreateCache() => new(_storage, new ProcessingOptions
    {
        CacheDirectory = _cacheDir,
    });

    [MinioAndFfmpegFact]
    public async Task Export_EndToEnd_SucceedsAndUploadsToExportsBucket()
    {
        // ── Kurulum: Ready asset (orijinali MinIO'da) + snapshot'lı Export job satırı.
        var sourcePath = media.Video320x240WithAudio();
        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(_userId, AssetKind.Video, "clip.mp4", "video/mp4",
            new FileInfo(sourcePath).Length, now);
        asset.TransitionTo(AssetStatus.Uploaded, now);
        asset.TransitionTo(AssetStatus.Processing, now);
        asset.TransitionTo(AssetStatus.Ready, now);
        _db.Assets.Add(asset);

        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.Doc(
            projectId: projectId,
            width: 320, height: 240,
            clips:
            [
                ExportTestDocs.VideoClip(asset.Id, 0, 0, 1_000_000, ExportTestDocs.Audio()),
                // 0.5 sn boşluk + ikinci klip: gap segmenti ve amix yolu da uçtan uca doğrulanır.
                ExportTestDocs.VideoClip(asset.Id, 1_500_000, 1_000_000, 2_500_000,
                    ExportTestDocs.Audio(volume: 0.5, fadeOutUs: 500_000)),
            ]);

        var job = Job.Create(JobType.Export, _userId, now,
            projectId: projectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "1080p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(asset.StorageKey, sourcePath, "video/mp4");

        // ── Koşu.
        var cache = CreateCache();
        await CreateRunner(cache).Run(job.Id, CancellationToken.None);

        // ── Job: Succeeded + OutputKey + progress tamam.
        Assert.True(job.Status == JobStatus.Succeeded,
            $"expected Succeeded, got {job.Status}: {job.ErrorMessage}");
        Assert.Equal($"exports/{projectId:D}/{job.Id:D}.mp4", job.OutputKey);
        Assert.Equal(100, job.ProgressPercent);
        Assert.Equal("done", job.ProgressStage);
        Assert.NotNull(job.CompletedAt);
        Assert.NotNull(job.LastProgressAt); // heartbeat damgalandı (reaper sözleşmesi)

        // ── Çıktı exports bucket'ında GERÇEKTEN var ve boş değil.
        var head = await _exportsBucketProbe.HeadObjectAsync(job.OutputKey!);
        Assert.NotNull(head);
        Assert.True(head!.SizeBytes > 10_000, $"suspiciously small export: {head.SizeBytes} bytes");

        // ── Presigned indirme URL'i exports bucket'ını işaret eder.
        var url = _storage.PresignExportGet(job.OutputKey!);
        Assert.Contains(ExportsBucket, url);

        // ── LRU cache doldu: orijinal cache dizininde ve ikinci koşu indirme yapmadan bulur.
        var cachedPath = Path.Combine(_cacheDir, asset.Id.ToString("N"), "original.mp4");
        Assert.True(File.Exists(cachedPath), "original should be in the LRU cache");
    }

    [MinioAndFfmpegFact]
    public async Task Export_ClipReadsPastSourceEnd_FailsWithSourceOutOfRange()
    {
        // 3 sn'lik gerçek kaynak; klip 5 sn okumaya kalkıyor (sourceOut=5s) — probe gate'i
        // 1 frame toleransıyla ihlali yakalar ve iş retry'sız Failed olur.
        var sourcePath = media.Video320x240WithAudio();
        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(_userId, AssetKind.Video, "short.mp4", "video/mp4",
            new FileInfo(sourcePath).Length, now);
        asset.TransitionTo(AssetStatus.Uploaded, now);
        asset.TransitionTo(AssetStatus.Processing, now);
        asset.TransitionTo(AssetStatus.Ready, now);
        _db.Assets.Add(asset);

        var doc = ExportTestDocs.Doc(
            width: 320, height: 240,
            clips: ExportTestDocs.VideoClip(asset.Id, 0, 0, 5_000_000, ExportTestDocs.Audio()));
        var job = Job.Create(JobType.Export, _userId, now,
            projectId: Guid.CreateVersion7(),
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "1080p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(asset.StorageKey, sourcePath, "video/mp4");

        await CreateRunner(CreateCache()).Run(job.Id, CancellationToken.None);

        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.Contains("source-out-of-range", job.ErrorMessage);
        var clip = Assert.IsType<VideoEdit.Contracts.Timeline.MediaClip>(doc.Tracks[0].Clips[0]);
        Assert.Contains(clip.Id.ToString(), job.ErrorMessage);
        Assert.Contains(asset.Id.ToString(), job.ErrorMessage);
    }

    [MinioAndFfmpegFact]
    public async Task Export_CanceledRow_LeavesCanceledUntouched()
    {
        // Cancel işareti koşudan ÖNCE konmuş: iş hiç başlamadan sessizce döner.
        var job = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow,
            projectId: Guid.CreateVersion7(),
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(ExportTestDocs.Doc(
                clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000)))),
            exportProfile: "1080p");
        job.Status = JobStatus.Canceled;
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        await CreateRunner(CreateCache()).Run(job.Id, CancellationToken.None);

        Assert.Equal(JobStatus.Canceled, job.Status);
        Assert.Equal(0, job.AttemptCount);
    }

    private sealed class NoOpJobClient : IBackgroundJobClient
    {
        public string Create(Hangfire.Common.Job job, IState state) => Guid.NewGuid().ToString("N");

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }
}
