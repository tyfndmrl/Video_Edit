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

        // Manifest'in jsonb kopyası ready ANINDA yazılmış ve storage'daki manifest.json ile
        // AYNI içerik olmalı (media-urls sprites[] çözümünü çağrı anında bu kolondan yapar;
        // iki kopya ayrışırsa istemci var olmayan sprite URL'i alabilirdi).
        Assert.NotNull(asset.FilmstripManifest);
        var storedManifest = await ReadObjectTextAsync(asset.FilmstripKey!);
        Assert.Equal(
            JsonDocument.Parse(storedManifest).RootElement.GetRawText(),
            asset.FilmstripManifest!.RootElement.GetRawText());
        Assert.True(asset.FilmstripManifest.RootElement.TryGetProperty("sprites", out var sprites));
        Assert.True(sprites.GetArrayLength() >= 1);

        // KOTA DEFTERİ: DerivedBytes, YÜKLENEN türev objelerinin toplamına
        // bire bir eşit — iddia DB kolonuna değil, MinIO'daki gerçek bayt sayısına dayanır.
        Assert.Equal(await SumDerivativeObjectBytesAsync(asset), asset.DerivedBytes);
        Assert.True(asset.DerivedBytes > 0);
    }

    /// <summary>Küçük storage objesini metin olarak okur (manifest.json karşılaştırması).</summary>
    private async Task<string> ReadObjectTextAsync(string key)
    {
        using var download = await _storage.OpenReadAsync(key);
        using var reader = new StreamReader(download.Content);
        return await reader.ReadToEndAsync();
    }

    /// <summary>Asset'in depodaki TÜM türev objelerinin (proxy/filmstrip+sprite'lar/waveform/poster) toplam boyutu.</summary>
    private async Task<long> SumDerivativeObjectBytesAsync(Asset asset)
    {
        long total = 0;
        foreach (var key in new[] { asset.ProxyKey, asset.FilmstripKey, asset.WaveformKey, asset.ThumbnailKey })
        {
            if (key is null)
            {
                continue;
            }

            var head = await _storage.HeadObjectAsync(key);
            Assert.NotNull(head);
            total += head!.SizeBytes;
        }

        for (var i = 1; i <= 64; i++) // filmstrip sprite'ları: sprite_1..N (ardışık)
        {
            var head = await _storage.HeadObjectAsync(
                $"u/{asset.OwnerId}/a/{asset.Id}/filmstrip/sprite_{i}.jpg");
            if (head is null)
            {
                break;
            }

            total += head.SizeBytes;
        }

        return total;
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
        Assert.Null(asset.FilmstripManifest); // filmstrip'siz varlıkta jsonb kopya da yok

        var basePrefix = $"u/{asset.OwnerId}/a/{asset.Id}";
        Assert.Equal($"{basePrefix}/proxy/audio.m4a", asset.ProxyKey);
        Assert.Equal($"{basePrefix}/waveform/peaks.json", asset.WaveformKey);
        Assert.NotNull(await _storage.HeadObjectAsync(asset.ProxyKey!));
        Assert.NotNull(await _storage.HeadObjectAsync(asset.WaveformKey!));
        Assert.Equal(JobStatus.Succeeded, job.Status);

        // Kota defteri: ses varlığında türevler proxy + waveform'dur; toplam depodaki
        // objelerin gerçek boyutlarına eşit.
        Assert.Equal(await SumDerivativeObjectBytesAsync(asset), asset.DerivedBytes);
        Assert.True(asset.DerivedBytes > 0);
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
    public async Task LutAsset_EndToEnd_ReadyWithoutProbeOrDerivatives()
    {
        // .cube MEDYA DEĞİLDİR: ffprobe kapısına girmemeli (girse "no video stream" ile
        // ölürdü), türev üretilmemeli; metin doğrulaması geçince DOĞRUDAN Ready.
        var cubePath = Path.Combine(media.Dir, "pipeline-swap-rb.cube");
        var text = new System.Text.StringBuilder();
        text.AppendLine("TITLE \"swap-rb\"");
        text.AppendLine("LUT_3D_SIZE 2");
        text.AppendLine("DOMAIN_MIN 0.0 0.0 0.0");
        text.AppendLine("DOMAIN_MAX 1.0 1.0 1.0");
        for (var b = 0; b < 2; b++)
        for (var g = 0; g < 2; g++)
        for (var r = 0; r < 2; r++)
        {
            text.AppendLine($"{b}.0 {g}.0 {r}.0");
        }

        await File.WriteAllTextAsync(cubePath, text.ToString());

        var (asset, job) = await SeedAssetAsync(
            AssetKind.Lut, cubePath, "swap-rb.cube", "application/x-cube-lut");

        await CreatePipeline().Run(job.Id, CancellationToken.None);

        Assert.Equal(AssetStatus.Ready, asset.Status);
        Assert.NotNull(asset.ReadyAt);
        Assert.Equal(JobStatus.Succeeded, job.Status);
        Assert.Equal(100, job.ProgressPercent);

        // Türev YOK, medya metadata'sı YOK — LUT bir renk tablosudur.
        Assert.Null(asset.ProxyKey);
        Assert.Null(asset.FilmstripKey);
        Assert.Null(asset.FilmstripManifest);
        Assert.Null(asset.WaveformKey);
        Assert.Null(asset.ThumbnailKey);
        Assert.Null(asset.DurationMicros);
        Assert.Null(asset.Width);
        Assert.False(asset.HasAudio);
        Assert.Null(asset.Probe); // ffprobe HİÇ koşmadı
    }

    [MinioAndFfmpegFact]
    public async Task InvalidLutAsset_FailsDeterministically_WithTypedReason()
    {
        // LUT_3D_SIZE 2 der ama 7 satır taşır — doğrulayıcı satır sayısını yakalamalı.
        var cubePath = Path.Combine(media.Dir, "pipeline-broken.cube");
        await File.WriteAllTextAsync(cubePath,
            "LUT_3D_SIZE 2\n" + string.Concat(Enumerable.Repeat("0 0 0\n", 7)));

        var (asset, job) = await SeedAssetAsync(
            AssetKind.Lut, cubePath, "broken.cube", "application/x-cube-lut");

        await CreatePipeline().Run(job.Id, CancellationToken.None);

        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("invalid-lut", asset.FailureReason);
        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.StartsWith("invalid-lut", job.ErrorMessage!, StringComparison.Ordinal);
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
