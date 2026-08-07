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
using VideoEdit.Media.Waveform;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// Uçtan uca M1-B pipeline testi (Hangfire'sız — ProcessAssetJob doğrudan çağrılır):
/// dosya MinIO'ya konur → pipeline koşar → Asset Ready + tüm türev key'leri MinIO'da mevcut.
/// Sqlite in-memory DbContext (AppDbContext JsonDocument'i test provider'ında string'e çevirir).
/// </summary>
[Collection("ffmpeg-media")]
public sealed class ProcessAssetPipelineTests : IDisposable
{
    private readonly FfmpegTestMediaFixture media;
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly R2StorageService _storage;
    private readonly FfmpegOptions _ffmpegOptions = new();
    private readonly List<string> _cleanupPrefixes = [];

    public ProcessAssetPipelineTests(FfmpegTestMediaFixture media)
    {
        this.media = media;
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();

        // compose.dev.yml MinIO değerleri; e2e kendi bucket'ını kullanır (smoke ile çakışmaz).
        _storage = new R2StorageService(Options.Create(new R2Options
        {
            ServiceUrl = "http://localhost:9000",
            AccessKeyId = "videoedit",
            SecretAccessKey = "devpassword123",
            Bucket = "videoedit-media-pipeline-e2e",
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
                // best-effort test temizliği
            }
        }

        _storage.Dispose();
        _db.Dispose();
        _connection.Dispose();
    }

    private ProcessAssetJob CreatePipeline(ProcessingOptions? processing = null) => new(
        _db,
        _storage,
        new FfprobeService(_ffmpegOptions),
        new FfmpegRunner(_ffmpegOptions),
        new WaveformGenerator(_ffmpegOptions),
        new NoOpBackgroundJobClient(),
        NullLogger<ProcessAssetJob>.Instance,
        TimeProvider.System,
        processing ?? new ProcessingOptions());

    private async Task<(Asset Asset, Job Job)> SeedAssetAsync(
        AssetKind kind, string sourcePath, string fileName, string contentType)
    {
        var now = DateTimeOffset.UtcNow;
        var owner = Guid.NewGuid();
        var asset = Asset.Create(owner, kind, fileName, contentType,
            new FileInfo(sourcePath).Length, now);
        asset.TransitionTo(AssetStatus.Uploaded, now);
        _db.Assets.Add(asset);

        var job = Job.Create(JobType.ProcessAsset, owner, now, assetId: asset.Id);
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{owner}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(asset.StorageKey, sourcePath, contentType);
        return (asset, job);
    }

    [MinioAndFfmpegFact]
    public async Task VideoAsset_EndToEnd_ReadyWithAllDerivativesInStorage()
    {
        var source = media.Video320x240WithAudio();
        var (asset, job) = await SeedAssetAsync(AssetKind.Video, source, "clip.mp4", "video/mp4");

        await CreatePipeline().Run(job.Id, CancellationToken.None);

        // Asset: Ready + metadata + türev key'leri.
        Assert.Equal(AssetStatus.Ready, asset.Status);
        Assert.NotNull(asset.ReadyAt);
        Assert.NotNull(asset.DurationMicros);
        Assert.InRange(asset.DurationMicros!.Value, 2_900_000, 3_300_000);
        Assert.Equal(320, asset.Width);
        Assert.Equal(240, asset.Height);
        Assert.Equal(30, asset.FpsNum);
        Assert.Equal(1, asset.FpsDen);
        Assert.True(asset.HasAudio);
        Assert.NotNull(asset.Probe);

        var basePrefix = $"u/{asset.OwnerId}/a/{asset.Id}";
        Assert.Equal($"{basePrefix}/proxy/540p.mp4", asset.ProxyKey);
        Assert.Equal($"{basePrefix}/filmstrip/manifest.json", asset.FilmstripKey);
        Assert.Equal($"{basePrefix}/waveform/peaks.json", asset.WaveformKey);
        Assert.Equal($"{basePrefix}/thumb/poster.jpg", asset.ThumbnailKey);

        // Job: Succeeded + %100.
        Assert.Equal(JobStatus.Succeeded, job.Status);
        Assert.Equal(100, job.ProgressPercent);
        Assert.NotNull(job.CompletedAt);

        // Storage: bütün türevler MinIO'da gerçekten var.
        Assert.NotNull(await _storage.HeadObjectAsync(asset.ProxyKey!));
        Assert.NotNull(await _storage.HeadObjectAsync(asset.FilmstripKey!));
        Assert.NotNull(await _storage.HeadObjectAsync($"{basePrefix}/filmstrip/sprite_1.jpg"));
        Assert.NotNull(await _storage.HeadObjectAsync(asset.WaveformKey!));
        Assert.NotNull(await _storage.HeadObjectAsync(asset.ThumbnailKey!));
    }

    [MinioAndFfmpegFact]
    public async Task AudioAsset_EndToEnd_AacProxyAndWaveform()
    {
        var source = media.AudioWav();
        var (asset, job) = await SeedAssetAsync(AssetKind.Audio, source, "tone.wav", "audio/wav");

        await CreatePipeline().Run(job.Id, CancellationToken.None);

        Assert.Equal(AssetStatus.Ready, asset.Status);
        Assert.True(asset.HasAudio);
        Assert.Null(asset.Width); // audio-only: video metadata yok
        Assert.Null(asset.ThumbnailKey);
        Assert.Null(asset.FilmstripKey);

        var basePrefix = $"u/{asset.OwnerId}/a/{asset.Id}";
        Assert.Equal($"{basePrefix}/proxy/audio.m4a", asset.ProxyKey);
        Assert.Equal($"{basePrefix}/waveform/peaks.json", asset.WaveformKey);
        Assert.NotNull(await _storage.HeadObjectAsync(asset.ProxyKey!));
        Assert.NotNull(await _storage.HeadObjectAsync(asset.WaveformKey!));
        Assert.Equal(JobStatus.Succeeded, job.Status);
    }

    [MinioAndFfmpegFact]
    public async Task GarbageFile_FailsDeterministically_NoThrow_NoRetry()
    {
        var garbagePath = Path.Combine(media.Dir, "garbage-e2e.bin");
        var garbage = new byte[64 * 1024];
        Random.Shared.NextBytes(garbage);
        await File.WriteAllBytesAsync(garbagePath, garbage);

        var (asset, job) = await SeedAssetAsync(AssetKind.Video, garbagePath, "broken.mp4", "video/mp4");

        // Deterministik hata EXCEPTION FIRLATMAZ (Hangfire retry tetiklenmesin) — normal döner.
        await CreatePipeline().Run(job.Id, CancellationToken.None);

        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("unsupported-media", asset.FailureReason);
        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.StartsWith("unsupported-media", job.ErrorMessage!, StringComparison.Ordinal);
        Assert.NotNull(job.CompletedAt);
        Assert.Null(asset.ProxyKey);
    }

    [MinioAndFfmpegFact]
    public async Task MissingOriginal_FailsDeterministically()
    {
        // Orijinal MinIO'ya HİÇ konmaz → original-missing (retry çözmez).
        var now = DateTimeOffset.UtcNow;
        var owner = Guid.NewGuid();
        var asset = Asset.Create(owner, AssetKind.Video, "ghost.mp4", "video/mp4", 1024, now);
        asset.TransitionTo(AssetStatus.Uploaded, now);
        _db.Assets.Add(asset);
        var job = Job.Create(JobType.ProcessAsset, owner, now, assetId: asset.Id);
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();
        await _storage.EnsureBucketsExistAsync();

        await CreatePipeline().Run(job.Id, CancellationToken.None);

        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("original-missing", asset.FailureReason);
        Assert.Equal(JobStatus.Failed, job.Status);
    }

    [MinioAndFfmpegFact]
    public async Task TooLongSource_FailsDeterministically_BeforeTranscode()
    {
        var source = media.Video320x240WithAudio(); // 3 sn
        var (asset, job) = await SeedAssetAsync(AssetKind.Video, source, "long.mp4", "video/mp4");

        // Limit 1 sn: 3 sn'lik kaynak süre gate'ine takılmalı (transcode hiç başlamaz).
        await CreatePipeline(new ProcessingOptions { MaxDurationUs = 1_000_000 })
            .Run(job.Id, CancellationToken.None);

        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("too-long", asset.FailureReason);
        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.StartsWith("too-long", job.ErrorMessage!, StringComparison.Ordinal);
        Assert.Null(asset.ProxyKey); // türev üretimine hiç girilmedi
    }

    [MinioAndFfmpegFact]
    public async Task VideoDeclaredAsImage_FailsWithKindMismatch()
    {
        // Gerçek video dosyası Image beyanıyla yüklenmiş: gate 'kind-mismatch' üretmeli
        // (poster'la Ready olup player'da kırılmasın).
        var source = media.Video320x240WithAudio();
        var (asset, job) = await SeedAssetAsync(AssetKind.Image, source, "sneaky.png", "image/png");

        await CreatePipeline().Run(job.Id, CancellationToken.None);

        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("kind-mismatch", asset.FailureReason);
        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.Null(asset.ThumbnailKey);
    }

    [MinioAndFfmpegFact]
    public async Task DuplicateDelivery_AfterSuccess_ShortCircuits()
    {
        // Hangfire InvisibilityTimeout senaryosu: iş bitti (Ready+Succeeded) ama aynı iş
        // ikinci kez teslim edildi — pipeline kısa devre yapmalı, hiçbir şeyi değiştirmemeli.
        var source = media.AudioWav();
        var (asset, job) = await SeedAssetAsync(AssetKind.Audio, source, "tone.wav", "audio/wav");

        await CreatePipeline().Run(job.Id, CancellationToken.None);
        Assert.Equal(AssetStatus.Ready, asset.Status);
        var firstReadyAt = asset.ReadyAt;
        var firstCompletedAt = job.CompletedAt;
        var firstAttempts = job.AttemptCount;

        await CreatePipeline().Run(job.Id, CancellationToken.None);

        Assert.Equal(AssetStatus.Ready, asset.Status);
        Assert.Equal(JobStatus.Succeeded, job.Status);
        Assert.Equal(firstReadyAt, asset.ReadyAt);           // yeniden işlenmedi
        Assert.Equal(firstCompletedAt, job.CompletedAt);
        Assert.Equal(firstAttempts, job.AttemptCount);       // deneme sayacı bile artmadı
    }

    /// <summary>Hangfire'sız test: Schedule/Enqueue çağrıları no-op.</summary>
    private sealed class NoOpBackgroundJobClient : IBackgroundJobClient
    {
        public string Create(Hangfire.Common.Job job, IState state) => Guid.NewGuid().ToString("N");

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }
}
