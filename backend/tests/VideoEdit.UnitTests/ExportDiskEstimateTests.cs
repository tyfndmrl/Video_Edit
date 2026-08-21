using System.Diagnostics;
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
using VideoEdit.Media.Export;
using VideoEdit.Media.Probing;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// DİSK REZERVASYONU TAHMİNİNİN ÖLÇÜLÜ KANITI (12. tur borcu "[AÇIK — ORTA] Export'un disk
/// rezervasyonu tahmini yüksek bit hızlı kaynakta KISA KALIYOR"):
/// <list type="bullet">
///   <item>YÜKSEK bit hızlı (≥ 20 Mbps, gren/rastgele içerik — kodlayıcı gerçekten yorulur)
///     kaynakta GERÇEK export koşulur ve gerçek disk ayak izi (cache'teki kaynak + üretilen
///     çıktı) ölçülür: ESKİ formül (sabit profil taban varsayımı — dalga 2'den beri 720p
///     profili için 5 Mbps) ölçülen kullanımın ALTINDA kalır (negatif kontrol — borç bu
///     korpusta gerçekten vardı), YENİ formül (max(profil, ölçülmüş kaynak bit hızı))
///     kullanımı KAPSAR. Belgeler 1280x720 tuval + "720p" profili kullanır: dalga 2'nin
///     en-boy kapısı 4:3 tuvali reddeder, 720p kutusu tuvale eşit olduğundan ölçek
///     aşaması da üretilmez (çıktı ayak izi bu testin yazıldığı günkü rejimle aynı kalır).</item>
///   <item>DÜŞÜK bit hızlı kaynakta yeni formül eskisiyle BİRE BİR aynı sayıyı verir
///     (profil tabanı kazanır — tahmin şişmez) ve gerçek kullanımı kapsamaya devam eder.</item>
/// </list>
/// Ölçüm gerçek ffmpeg + gerçek MinIO ile uçtan ucadır; sayılar iddia değil bu koşumun
/// çıktısıdır.
/// </summary>
[Collection("ffmpeg-media")]
public sealed class ExportDiskEstimateTests : IDisposable
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

    private const string MediaBucket = "videoedit-media-diskest-e2e";
    private const string ExportsBucket = "videoedit-exports-diskest-e2e";

    private readonly Xunit.Abstractions.ITestOutputHelper _output;

    public ExportDiskEstimateTests(FfmpegTestMediaFixture media, Xunit.Abstractions.ITestOutputHelper output)
    {
        this.media = media;
        _output = output;
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _cacheDir = Directory.CreateTempSubdirectory("videoedit-diskest-cache-").FullName;

        _storage = new R2StorageService(Options.Create(new R2Options
        {
            ServiceUrl = "http://localhost:9000",
            AccessKeyId = "videoedit",
            SecretAccessKey = "devpassword123",
            Bucket = MediaBucket,
            ExportsBucket = ExportsBucket,
        }));
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

    /// <summary>
    /// 6 sn, 1280×720 @30fps GERÇEK RASTGELE (geq random) luma — kodlayıcının tahmin
    /// edemeyeceği içerik. CRF18 veryfast bu içerikte doğal olarak yüksek bit hızı üretir;
    /// export çıktısı da (aynı profil ayarları) kaynağa yakın bir bit hızına çıkar. Sabit
    /// bitrate ZORLANMAZ: borcun kendisi "CRF çıktısı içerik bağımlı" gerçeğidir ve test
    /// tam o rejimi kurar.
    /// </summary>
    private string GenerateNoisySource()
    {
        var path = Path.Combine(_cacheDir, "noisy720p.mp4");
        RunFfmpeg([
            "-y",
            "-f", "lavfi", "-i", "nullsrc=s=1280x720:r=30:d=6",
            "-vf", "geq=lum='random(1)*255':cb=128:cr=128",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
            path,
        ]);
        return path;
    }

    private void RunFfmpeg(string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _ffmpegOptions.FfmpegPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)!;
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(180_000) && process.ExitCode == 0,
            $"test kaynağı üretilemedi: {stderr}");
    }

    private async Task<(Asset Asset, long SourceBps, long DurationUs)> SeedReadyAssetAsync(string sourcePath)
    {
        // İngest'in yazacağı satırın birebir taklidi: boyut dosyadan, süre ffprobe'dan.
        var probe = await new FfprobeService(_ffmpegOptions).ProbeAsync(sourcePath, CancellationToken.None);
        Assert.NotNull(probe.DurationUs);
        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(_userId, AssetKind.Video, Path.GetFileName(sourcePath), "video/mp4",
            new FileInfo(sourcePath).Length, now);
        asset.DurationMicros = probe.DurationUs;
        asset.TransitionTo(AssetStatus.Uploaded, now);
        asset.TransitionTo(AssetStatus.Processing, now);
        asset.TransitionTo(AssetStatus.Ready, now);
        _db.Assets.Add(asset);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(asset.StorageKey, sourcePath, "video/mp4");

        var sourceBps = (long)(asset.SizeBytes * 8_000_000m / probe.DurationUs!.Value);
        return (asset, sourceBps, probe.DurationUs.Value);
    }

    private async Task<Job> RunExportAsync(Asset asset, int width, int height, long clipDurationUs)
    {
        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.Doc(
            projectId: projectId, width: width, height: height,
            clips: ExportTestDocs.VideoClip(asset.Id, 0, 0, clipDurationUs));
        var job = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow,
            projectId: projectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "720p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        var runner = new ExportJob(
            _db, _storage,
            new FfprobeService(_ffmpegOptions), new FfmpegRunner(_ffmpegOptions),
            new OriginalCache(_storage, new ProcessingOptions { CacheDirectory = _cacheDir }),
            new NoOpJobClient(), NullLogger<ExportJob>.Instance, TimeProvider.System,
            new RunningRenderRegistry());
        await runner.Run(job.Id, CancellationToken.None);
        return job;
    }

    /// <summary>Gerçek disk ayak izi: cache'e inen kaynak + üretilen çıktı (exports bucket'ından ölçülür).</summary>
    private async Task<long> MeasureActualBytesAsync(Asset asset, Job job)
    {
        var cached = Path.Combine(_cacheDir, asset.Id.ToString("N"), "original.mp4");
        Assert.True(File.Exists(cached), "kaynak LRU cache'e inmemiş");
        var head = await _exportsBucketProbe.HeadObjectAsync(job.OutputKey!);
        Assert.NotNull(head);
        return new FileInfo(cached).Length + head!.SizeBytes;
    }

    [MinioAndFfmpegFact]
    public async Task HighBitrateSource_NewEstimateCoversTheMeasuredFootprint_OldOneDidNot()
    {
        var sourcePath = GenerateNoisySource();
        var (asset, sourceBps, _) = await SeedReadyAssetAsync(sourcePath);

        // Rejimin ön şartı: kaynak gerçekten yüksek bit hızlı (görev tanımı ≥ 20 Mbps).
        Assert.True(sourceBps >= 20_000_000,
            $"test kaynağı beklenen rejimde değil: ölçülen {sourceBps} b/s < 20 Mbps");

        const long clipDurationUs = 5_000_000; // 6 sn kaynağın 5 sn'lik penceresi
        var job = await RunExportAsync(asset, 1280, 720, clipDurationUs);
        Assert.True(job.Status == JobStatus.Succeeded,
            $"export başarısız: {job.Status}: {job.ErrorMessage}");

        var actualBytes = await MeasureActualBytesAsync(asset, job);
        var oldEstimate = ExportJob.EstimateRequiredDiskBytes(
            asset.SizeBytes, clipDurationUs,
            ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Hd720p));
        var newEstimate = ExportJob.EstimateRequiredDiskBytes(
            asset.SizeBytes, clipDurationUs,
            ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Hd720p, [asset]));

        _output.WriteLine(
            $"[yüksek bit hızı] kaynak={asset.SizeBytes} B, kaynakBps={sourceBps} b/s, "
            + $"ölçülen ayak izi={actualBytes} B, eskiTahmin={oldEstimate} B, yeniTahmin={newEstimate} B");

        // NEGATİF KONTROL: eski formül BU koşumda ölçülen ayak izinin altında kalıyor —
        // yani kapatılan borç bu korpusta gerçekten vardı (kapı "yeter" der, disk biterdi).
        Assert.True(oldEstimate < actualBytes,
            $"eski formül bu korpusta zaten yeterliymiş (eski={oldEstimate}, ölçülen={actualBytes}) — "
            + "negatif kontrol anlamsızlaştı, korpusu sertleştir");

        // ASIL İDDİA: yeni formül ölçülen ayak izini kapsıyor.
        Assert.True(newEstimate >= actualBytes,
            $"yeni tahmin hâlâ kısa: tahmin={newEstimate}, ölçülen={actualBytes} "
            + $"(kaynak={asset.SizeBytes}, kaynak bit hızı={sourceBps} b/s)");
    }

    [MinioAndFfmpegFact]
    public async Task LowBitrateSource_EstimateDoesNotInflate_AndStillCovers()
    {
        var sourcePath = media.Video320x240WithAudio(); // 3 sn testsrc — mütevazı bit hızı
        var (asset, sourceBps, _) = await SeedReadyAssetAsync(sourcePath);
        Assert.True(sourceBps < 10_000_000,
            $"düşük bit hızı rejimi kurulamadı: ölçülen {sourceBps} b/s");

        const long clipDurationUs = 2_000_000;
        var job = await RunExportAsync(asset, 1280, 720, clipDurationUs);
        Assert.True(job.Status == JobStatus.Succeeded,
            $"export başarısız: {job.Status}: {job.ErrorMessage}");

        var actualBytes = await MeasureActualBytesAsync(asset, job);
        var oldEstimate = ExportJob.EstimateRequiredDiskBytes(
            asset.SizeBytes, clipDurationUs,
            ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Hd720p));
        var newEstimate = ExportJob.EstimateRequiredDiskBytes(
            asset.SizeBytes, clipDurationUs,
            ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Hd720p, [asset]));

        _output.WriteLine(
            $"[düşük bit hızı] kaynak={asset.SizeBytes} B, kaynakBps={sourceBps} b/s, "
            + $"ölçülen ayak izi={actualBytes} B, eskiTahmin={oldEstimate} B, yeniTahmin={newEstimate} B");

        // ŞİŞME YOK: profil tabanı kazanır, yeni tahmin eskisiyle BİRE BİR aynı.
        Assert.Equal(oldEstimate, newEstimate);

        // Ve taban bu rejimde gerçek ayak izini kapsamaya devam eder.
        Assert.True(newEstimate >= actualBytes,
            $"taban tahmin düşük bit hızlı kaynağı bile kapsayamadı: tahmin={newEstimate}, ölçülen={actualBytes}");
    }

    private sealed class NoOpJobClient : IBackgroundJobClient
    {
        public string Create(Hangfire.Common.Job job, IState state) => Guid.NewGuid().ToString("N");

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }
}
