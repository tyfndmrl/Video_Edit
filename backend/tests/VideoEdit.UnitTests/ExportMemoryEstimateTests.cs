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
/// BELLEK KABUL KAPISI TAHMİNİNİN ÖLÇÜLÜ KANITI (backlog borcu "2160p bellek kabul kapısı",
/// perf raporu §9-2) — <c>ExportDiskEstimateTests</c>'in bellek eşi. Üç bacak:
/// <list type="number">
///   <item><b>Canlı korpus.</b> 2026-08-24 ölçüm turu: 6 taban + 4 tekrar GERÇEK render
///     (perf20 seed'inin 60 sn bileşim/düz kesim projeleri, 720p/1080p/2160p), ffmpeg tepe
///     RSS'i <c>PeakWorkingSet64</c> ile (çekirdek takipli gerçek tepe — perf turunun 500 ms
///     WorkingSet örneklemesi ALT sınırdı: aynı belge orada 4 908, burada 5 563 MB).
///     Formül her ölçülen noktayı kapsamak ZORUNDADIR; sayılar bu sınıfta sabitlidir.</item>
///   <item><b>Uçtan uca ölçüm.</b> Gerçek MinIO + gerçek ffmpeg ile düz kesim ve bileşim
///     render edilir, TAM O sürecin tepe RSS'i örneklenir (FfmpegRunner.ProcessStarted
///     kancası — ada göre süreç aramak makinedeki canlı worker'ın ffmpeg'ini yakalardı)
///     ve tahminin ölçümü kapsadığı doğrulanır.</item>
///   <item><b>Süpürme aritmetiği.</b> Tahmin girdileri TOPLAM değil EŞZAMANLILIK sayar:
///     ardışık 500 klip 500 çözücü havuzu DEĞİLDİR (ffmpeg girişleri zaman damgası
///     dengelemesiyle okur) — yanlış ret üretmemenin aritmetik yarısı budur.</item>
/// </list>
/// </summary>
public sealed class ExportMemoryFormulaTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private const long CanvasPixels1080 = 1920L * 1080;
    private const long SourcePixels1080 = 1920L * 1080;

    /// <summary>
    /// 2026-08-24 canlı ölçüm turunun TAM tablosu (scratchpad mem25/, ölçüm betiği
    /// ff-peak-mon.ps1 + mem-export.mjs; makine: i9-10850K 20 mantıksal çekirdek, 32 GB).
    /// Belgeler: perf20 'plain' (1 video klip, 1080p kaynak) ve 'comp' (2 video klip +
    /// 1 sn crossfade + metin + şekil overlay + colorAdjust + LUT; girişler = 2 medya +
    /// 2 raster PNG, xfade penceresinde 4 eşzamanlı görsel, 2 eşzamanlı 1080p çözücü).
    /// </summary>
    private static readonly (string Label, long TargetPixels, int Inputs, int PeakVisual,
        long PeakMotionPixels, double MeasuredPeakMiB)[] LiveCorpus =
    [
        ("plain-720p-r0", 1280L * 720, 1, 1, SourcePixels1080, 461.2),
        ("plain-1080p-r0", 1920L * 1080, 1, 1, SourcePixels1080, 910.0),
        ("plain-2160p-r0", 3840L * 2160, 1, 1, SourcePixels1080, 2921.2),
        ("plain-2160p-r1", 3840L * 2160, 1, 1, SourcePixels1080, 2917.1),
        ("comp-720p-r0", 1280L * 720, 4, 4, 2 * SourcePixels1080, 3013.2),
        ("comp-1080p-isinma", 1920L * 1080, 4, 4, 2 * SourcePixels1080, 3009.3),
        ("comp-1080p-r0", 1920L * 1080, 4, 4, 2 * SourcePixels1080, 3305.6),
        ("comp-1080p-r1", 1920L * 1080, 4, 4, 2 * SourcePixels1080, 3129.0),
        ("comp-2160p-r0", 3840L * 2160, 4, 4, 2 * SourcePixels1080, 5562.9),
        ("comp-2160p-r1", 3840L * 2160, 4, 4, 2 * SourcePixels1080, 5062.4),
    ];

    [Fact]
    public void LiveCorpus_EstimateCoversEveryMeasuredRun()
    {
        foreach (var (label, targetPixels, inputs, peakVisual, motionPixels, measuredMiB) in LiveCorpus)
        {
            var measuredBytes = (long)(measuredMiB * 1024 * 1024);
            var estimate = ExportJob.EstimateRequiredMemoryBytes(
                targetPixels, CanvasPixels1080, inputs, peakVisual, motionPixels);

            output.WriteLine(
                $"{label}: ölçülen={measuredMiB:F1} MiB, tahmin={estimate / 1048576.0:F1} MiB "
                + $"(x{(double)estimate / measuredBytes:F2})");

            Assert.True(estimate >= measuredBytes,
                $"{label}: tahmin ölçülen tepenin ALTINDA kaldı "
                + $"(tahmin={estimate}, ölçülen={measuredBytes} bayt)");
        }
    }

    /// <summary>
    /// Ana ölçüm bulgusunun regresyon çivisi: bileşim grafiği tepe RSS'e profilden BAĞIMSIZ
    /// ~2,1-2,5 GB ekledi (comp-720p 3 013 ≈ comp-1080p 3 009-3 306 MB). Karışım terimi bu
    /// yüzden TUVAL pikseliyle çarpılır, hedef pikselle DEĞİL — tersine çevrilirse bu test
    /// comp-720p satırını kapsayamaz (720p hedefte karışım payı 4'te 1'e düşerdi).
    /// </summary>
    [Fact]
    public void MixTerm_ScalesWithCanvas_NotWithTargetProfile()
    {
        var comp720 = ExportJob.EstimateRequiredMemoryBytes(
            1280L * 720, CanvasPixels1080, 4, 4, 2 * SourcePixels1080);
        Assert.True(comp720 >= (long)(3013.2 * 1024 * 1024),
            $"karışım terimi tuval yerine hedefe ölçeklenmiş olmalı: comp-720p kapsanmadı ({comp720})");
    }

    // ───────────────── Tahmin girdileri: süpürme EŞZAMANLILIK sayar ─────────────────

    private static ExportPlan Validate(VideoEdit.Contracts.Timeline.TimelineDoc doc) =>
        ExportCompiler.Validate(doc);

    private static Asset SeedAsset(Guid id, AssetKind kind, int? width = null, int? height = null)
    {
        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(Guid.CreateVersion7(), kind, "m.bin", "application/octet-stream", 100, now);
        asset.Id = id;
        asset.Width = width;
        asset.Height = height;
        return asset;
    }

    [Fact]
    public void EstimateInputs_CrossfadeStillAndAudio_CountsConcurrencyPeaks()
    {
        // V1: 2 video klip + 1 sn crossfade (D/2 = 0,5 sn pay iki yana), V2: görsel [1..5 sn],
        // ses track'i [0..6 sn]. Crossfade penceresinde ([2,5..3,5]) iki video AYNI ANDA
        // çözülür + görsel aktiftir → görsel tepe 3; ses girişi kare havuzu sayılmaz.
        var a = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 3_000_000);
        var b = ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 3_000_000, 4_000_000, 7_000_000);
        ExportTestDocs.Link(a, b, 1_000_000);
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips: [a, b]),
            ExportTestDocs.VideoTrack(clips: [ExportTestDocs.ImageClip(ExportTestDocs.AssetB, 1_000_000, 4_000_000)]),
            ExportTestDocs.AudioTrack(clips: [ExportTestDocs.AudioClip(ExportTestDocs.AssetC, 0, 0, 6_000_000)]),
        ]);

        var sources = new[]
        {
            SeedAsset(ExportTestDocs.AssetA, AssetKind.Video, 1920, 1080),
            SeedAsset(ExportTestDocs.AssetB, AssetKind.Image, 800, 600),
            SeedAsset(ExportTestDocs.AssetC, AssetKind.Audio),
        };

        var (inputs, peakVisual, peakMotionPixels) = ExportJob.MemoryEstimateInputs(
            Validate(doc), ExportProfile.Hd1080p, sources);

        output.WriteLine($"inputs={inputs} peakVisual={peakVisual} peakMotionPx={peakMotionPixels}");
        Assert.Equal(4, inputs);            // 2 medya + 1 görsel + 1 ses
        Assert.Equal(3, peakVisual);        // crossfade penceresi: A + B + görsel
        Assert.Equal(2 * SourcePixels1080, peakMotionPixels); // yalnız Motion; görsel hariç
    }

    [Fact]
    public void EstimateInputs_SequentialClips_DoNotStackDecoders()
    {
        // 500-klip SINIFININ aritmetik kanıtı: geçişsiz ardışık klipler zaman ekseninde
        // ÖRTÜŞMEZ → görsel tepe 1, çözücü tepe TEK kaynak havuzu. Girişler yine klip
        // başınadır (demux sabiti) — ama tahmini domine edemez.
        var clips = Enumerable.Range(0, 8)
            .Select(i => (VideoEdit.Contracts.Timeline.Clip)ExportTestDocs.VideoClip(
                ExportTestDocs.AssetA, i * 2_000_000L, 0, 2_000_000))
            .ToArray();
        var doc = ExportTestDocs.Doc(clips: clips);
        var sources = new[] { SeedAsset(ExportTestDocs.AssetA, AssetKind.Video, 1920, 1080) };

        var (inputs, peakVisual, peakMotionPixels) = ExportJob.MemoryEstimateInputs(
            Validate(doc), ExportProfile.Hd1080p, sources);

        Assert.Equal(8, inputs);
        Assert.Equal(1, peakVisual);
        Assert.Equal(SourcePixels1080, peakMotionPixels);
    }

    /// <summary>
    /// Gerçek okuyucu sağlık ucu: desteklenen platformda pozitif bir sayı döner (Windows'ta
    /// GlobalMemoryStatusEx, Linux'ta min(MemAvailable, cgroup limit−kullanım)). -1 sözleşmesi
    /// "ölçülemedi = kapı atlanır" içindir ve desteklenen platformda normal koşullarda
    /// görülmemelidir.
    /// </summary>
    [Fact]
    public void AvailableMemoryReader_ReportsAPositiveValueOnSupportedPlatforms()
    {
        var bytes = AvailableMemory.TryGetAvailableBytes();
        if (OperatingSystem.IsWindows() || OperatingSystem.IsLinux())
        {
            Assert.InRange(bytes, 1, long.MaxValue);
            output.WriteLine($"kullanılabilir fiziksel bellek: {bytes / 1048576.0:F0} MiB");
        }
        else
        {
            Assert.Equal(-1, bytes);
        }
    }

    [Fact]
    public void EstimateInputs_UnknownSourceDims_FallBackToCoveringAssumption()
    {
        // Boyutsuz eski satır: tuval/hedefin BÜYÜĞÜ varsayılır (küçümseme yönünde hata yok).
        var doc = ExportTestDocs.Doc(
            clips: ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000));
        var sources = new[] { SeedAsset(ExportTestDocs.AssetA, AssetKind.Video) };

        var (_, _, peakMotionPixels) = ExportJob.MemoryEstimateInputs(
            Validate(doc), ExportProfile.Uhd2160p, sources);

        Assert.Equal(3840L * 2160, peakMotionPixels); // hedef 4K > tuval → hedef varsayımı
    }
}

/// <summary>
/// Uçtan uca bacak: gerçek MinIO + gerçek ffmpeg ile render, tepe RSS TAM O süreçten
/// (<see cref="FfmpegRunner.ProcessStarted"/>). Kurulum <c>ExportDiskEstimateTests</c>'in
/// birebir desenidir (1280×720 tuval + 720p profili → ölçek aşaması üretilmez).
/// </summary>
[Collection("ffmpeg-media")]
public sealed class ExportMemoryEstimateTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly R2StorageService _storage;
    private readonly FfmpegOptions _ffmpegOptions = new();
    private readonly string _cacheDir;
    private readonly Guid _userId = Guid.CreateVersion7();
    private readonly List<string> _cleanupPrefixes = [];
    private readonly Xunit.Abstractions.ITestOutputHelper _output;

    private const string MediaBucket = "videoedit-media-memest-e2e";
    private const string ExportsBucket = "videoedit-exports-memest-e2e";

    public ExportMemoryEstimateTests(FfmpegTestMediaFixture media, Xunit.Abstractions.ITestOutputHelper output)
    {
        _ = media; // collection fixture'ı ffmpeg kullanılabilirliğini garanti eder
        _output = output;
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _cacheDir = Directory.CreateTempSubdirectory("videoedit-memest-cache-").FullName;

        _storage = new R2StorageService(Options.Create(new R2Options
        {
            ServiceUrl = "http://localhost:9000",
            AccessKeyId = "videoedit",
            SecretAccessKey = "devpassword123",
            Bucket = MediaBucket,
            ExportsBucket = ExportsBucket,
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
            Directory.Delete(_cacheDir, recursive: true);
        }
        catch
        {
            // best-effort
        }

        _storage.Dispose();
        _db.Dispose();
        _connection.Dispose();
    }

    /// <summary>8 sn, 1280×720 @30fps H.264 + sinüs AAC — crossfade payları için yeterli uzunluk.</summary>
    private string GenerateSource()
    {
        var path = Path.Combine(_cacheDir, "src720p.mp4");
        RunFfmpeg([
            "-y",
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=8",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "48000", "-shortest",
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

    private async Task<Asset> SeedReadyAssetAsync(string sourcePath)
    {
        var probe = await new FfprobeService(_ffmpegOptions).ProbeAsync(sourcePath, CancellationToken.None);
        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(_userId, AssetKind.Video, Path.GetFileName(sourcePath), "video/mp4",
            new FileInfo(sourcePath).Length, now);
        asset.DurationMicros = probe.DurationUs;
        asset.Width = probe.Width;
        asset.Height = probe.Height;
        asset.TransitionTo(AssetStatus.Uploaded, now);
        asset.TransitionTo(AssetStatus.Processing, now);
        asset.TransitionTo(AssetStatus.Ready, now);
        _db.Assets.Add(asset);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(asset.StorageKey, sourcePath, "video/mp4");
        return asset;
    }

    /// <summary>
    /// ffmpeg tepe RSS izleyicisi: <c>PeakWorkingSet64</c> çekirdek tarafından sürekli
    /// izlenir, dolayısıyla süreç ölmeden alınan SON örnek gerçek tepeyi taşır (örnekleme
    /// aralığı sonucu nicemlemez; yalnız son ~50 ms'lik büyüme penceresi belirsiz kalır).
    /// </summary>
    private sealed class PeakRssTracker
    {
        private long _peakBytes;
        private readonly List<Task> _samplers = [];

        public long PeakBytes => Interlocked.Read(ref _peakBytes);

        public void Track(Process process) => _samplers.Add(Task.Run(async () =>
        {
            try
            {
                while (!process.HasExited)
                {
                    process.Refresh();
                    var peak = process.PeakWorkingSet64;
                    long seen;
                    while (peak > (seen = Interlocked.Read(ref _peakBytes)))
                    {
                        Interlocked.CompareExchange(ref _peakBytes, peak, seen);
                    }

                    await Task.Delay(50);
                }
            }
            catch (InvalidOperationException)
            {
                // süreç bitti/kapandı — son örnek geçerli
            }
        }));

        public Task DrainAsync() => Task.WhenAll(_samplers);
    }

    private async Task<(Job Job, long MeasuredPeakBytes)> RunExportMeasuredAsync(
        VideoEdit.Contracts.Timeline.TimelineDoc doc)
    {
        var job = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow,
            projectId: doc.ProjectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "720p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        var tracker = new PeakRssTracker();
        var runner = new ExportJob(
            _db, _storage,
            new FfprobeService(_ffmpegOptions),
            new FfmpegRunner(_ffmpegOptions) { ProcessStarted = tracker.Track },
            new OriginalCache(_storage, new ProcessingOptions { CacheDirectory = _cacheDir }),
            new NoOpJobClient(), NullLogger<ExportJob>.Instance, TimeProvider.System,
            new RunningRenderRegistry());
        await runner.Run(job.Id, CancellationToken.None);
        await tracker.DrainAsync();
        return (job, tracker.PeakBytes);
    }

    private (long Estimate, int Inputs, int PeakVisual, long MotionPixels) EstimateFor(
        VideoEdit.Contracts.Timeline.TimelineDoc doc, IReadOnlyCollection<Asset> sources)
    {
        var plan = ExportCompiler.Validate(doc);
        var (inputs, peakVisual, motionPixels) =
            ExportJob.MemoryEstimateInputs(plan, ExportProfile.Hd720p, sources);
        var estimate = ExportJob.EstimateRequiredMemoryBytes(
            1280L * 720, (long)plan.Width * plan.Height, inputs, peakVisual, motionPixels);
        return (estimate, inputs, peakVisual, motionPixels);
    }

    [MinioAndFfmpegFact]
    public async Task PlainCut_EstimateCoversTheMeasuredFfmpegPeak()
    {
        var asset = await SeedReadyAssetAsync(GenerateSource());
        var doc = ExportTestDocs.Doc(
            projectId: Guid.CreateVersion7(), width: 1280, height: 720,
            clips: ExportTestDocs.VideoClip(asset.Id, 0, 0, 5_000_000));

        var (job, measured) = await RunExportMeasuredAsync(doc);
        Assert.True(job.Status == JobStatus.Succeeded,
            $"export başarısız: {job.Status}: {job.ErrorMessage}");
        Assert.True(measured > 0, "ffmpeg tepe RSS örneklenemedi (ProcessStarted kancası çalışmadı?)");

        var (estimate, inputs, peakVisual, motionPixels) = EstimateFor(doc, [asset]);
        _output.WriteLine(
            $"[düz kesim] ölçülen tepe={measured / 1048576.0:F1} MiB, tahmin={estimate / 1048576.0:F1} MiB "
            + $"(girişler={inputs}, görsel tepe={peakVisual}, hareketli px={motionPixels})");

        Assert.True(estimate >= measured,
            $"tahmin ölçülen tepeyi kapsamadı: tahmin={estimate}, ölçülen={measured}");
    }

    [MinioAndFfmpegFact]
    public async Task Composition_EstimateCoversTheMeasuredFfmpegPeak()
    {
        var asset = await SeedReadyAssetAsync(GenerateSource());

        // Canlı ölçüm turundaki bileşimin küçük eşi: aynı kaynaktan 2 klip + 1 sn crossfade
        // → 2 giriş, xfade penceresinde 2 eşzamanlı çözücü + karışım zinciri.
        var a = ExportTestDocs.VideoClip(asset.Id, 0, 0, 3_500_000);
        var b = ExportTestDocs.VideoClip(asset.Id, 3_500_000, 1_500_000, 5_000_000);
        ExportTestDocs.Link(a, b, 1_000_000);
        var doc = ExportTestDocs.Doc(
            projectId: Guid.CreateVersion7(), width: 1280, height: 720, clips: [a, b]);

        var (job, measured) = await RunExportMeasuredAsync(doc);
        Assert.True(job.Status == JobStatus.Succeeded,
            $"export başarısız: {job.Status}: {job.ErrorMessage}");
        Assert.True(measured > 0, "ffmpeg tepe RSS örneklenemedi (ProcessStarted kancası çalışmadı?)");

        var (estimate, inputs, peakVisual, motionPixels) = EstimateFor(doc, [asset]);
        _output.WriteLine(
            $"[bileşim] ölçülen tepe={measured / 1048576.0:F1} MiB, tahmin={estimate / 1048576.0:F1} MiB "
            + $"(girişler={inputs}, görsel tepe={peakVisual}, hareketli px={motionPixels})");

        Assert.Equal(2, peakVisual); // crossfade gerçekten eşzamanlılık kurdu
        Assert.True(estimate >= measured,
            $"tahmin ölçülen tepeyi kapsamadı: tahmin={estimate}, ölçülen={measured}");
    }

    private sealed class NoOpJobClient : IBackgroundJobClient
    {
        public string Create(Hangfire.Common.Job job, IState state) => Guid.NewGuid().ToString("N");

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }
}
