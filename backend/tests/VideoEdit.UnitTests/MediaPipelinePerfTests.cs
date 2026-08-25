using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using Hangfire;
using Hangfire.States;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Domain.Services;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media;
using VideoEdit.Media.Probing;
using VideoEdit.Media.Waveform;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// 1-2 GB REJİMİNİN KALICI PERFORMANS MUHAFIZI (backlog borcu "12. turun iki ölçümü de
/// koşuldu ama korunmuyor" + "ölçüm n=1"). §0.1'deki 1,51 GiB'lık uçtan uca ölçüm tek
/// koşumdu ve otomatik pakette karşılığı yoktu: yükleme→işleme→export hattında bir
/// performans gerilemesi sessizce girebilirdi. Bu test o hattı HER koşumda, aynı boru
/// hattından (çok parçalı presigned PUT → ProcessAssetJob → ExportJob) ölçer.
/// <para>
/// KAYNAK KÜÇÜLTÜLMÜŞ AMA REJİM KORUNMUŞTUR: 1,5 GiB'lık kaynak + dakikalarca koşum her
/// CI turuna sığmaz (borç kaydındaki gerekçe). ~320 MB'lik kaynak aynı rejimin bütün
/// niteliklerini taşır — 1080p30 20 Mbps H.264 gren (kareler-arası tahmin işe yaramaz,
/// çözücü de kodlayıcı da gerçekten yorulur, §0.1'in kaynak tarifiyle aynı), 64 MiB'lık
/// parçalarla GERÇEK multipart yükleme (5+ parça → istemcinin 4'lük eşzamanlılık penceresi
/// dolar), gerçek MinIO, gerçek ffmpeg. Küçülen tek şey süredir; iddialar da bu yüzden
/// mutlak saniye değil ORANDIR.
/// </para>
/// <para>
/// EŞİKLER NEREDEN GELİYOR — mutlak süre iddiası donanıma bağlıdır, bu yüzden iddialar
/// gerçek-zaman ORANI üzerinden: "işleme, kaynak süresinin en çok N katı sürebilir".
/// N'ler bu makinede (i9-10850K/32GB, ölçüm 2026-08-25, üç ardışık koşum) ölçülen
/// oranların üstüne CI payı konarak türetildi; her eşiğin yanında üç koşumun ölçümü ve
/// pay gerekçesi yazılıdır. Eşik aşımı = bu sınıf donanımda bile gerçek bir gerileme.
/// </para>
/// <para>
/// NEDEN PARALELLİK-DIŞI KOLEKSİYON (ölçüldü): test tam pakette diğer koleksiyonlarla
/// paralel koşarken KIRMIZI düştü — 20 iş parçacıklı suite, her biri kendi çok-iş-parçacıklı
/// ffmpeg'ini açan golden/pipeline testleriyle çekirdekleri doyuruyor ve ölçülen oran artık
/// ürünün değil komşu testlerin fonksiyonu oluyordu (izole aynı ağaçta yeşil, 46 sn).
/// Ölçüm testinin işi dürüst ölçmektir: <c>DisableParallelization</c> bu sınıfı sessiz bir
/// şeritte tek başına koşturur; bedeli suite süresine eklenen ~1 dakikadır, karşılığı
/// eşiklerin komşu yüke değil ürüne bakmasıdır.
/// </para>
/// </summary>
[Collection("pipeline-perf")]
public sealed class MediaPipelinePerfTests : IDisposable
{
    // ---- Rejim sabitleri (kaynak tarifi §0.1 ile aynı sınıf, süre küçültülmüş) ----
    private const int SourceDurationSeconds = 128;
    private const long SourceDurationUs = SourceDurationSeconds * 1_000_000L;
    private const long ExportDurationUs = 30_000_000; // 30 sn'lik kesim (§0.1'deki 60 sn'lik kesimin küçüğü)

    // ---- Eşikler (ölçümden türetilmiş; gerekçeler her assert'ün yanında) ----

    /// <summary>
    /// İşleme (proxy+filmstrip+waveform+poster) duvar saatinin kaynak süresine oranı.
    /// Bu makinede (i9-10850K) üç ardışık izole koşum: 0,097 / 0,107 / 0,102
    /// (≈ 9,3-10,3× gerçek zamandan hızlı; §0.1'in 1,51 GiB ölçümü de 0,108'di — küçültülmüş
    /// kaynak aynı rejimi ölçüyor). Tavan 0,75 = en kötü ölçümün 7 katı: CI'ın 4 çekirdekli
    /// koşucusu + paralel test yükü payı. Tavanın üstü, bu sınıf donanımda bile "işleme
    /// gerçek zamana yaklaştı" demektir (kullanıcının 'performanslı ve hızlı olmalı'
    /// gereksiniminin nicel karşılığı).
    /// </summary>
    private const double ProcessingToSourceRatioCeiling = 0.75;

    /// <summary>
    /// Export (indirme+derleme+render+doğrulama+yükleme) duvar saatinin ÇIKTI süresine
    /// oranı — soğuk cache'le (kaynağın MinIO'dan indirilmesi dahil). Bu makinede üç koşum:
    /// 0,23 / 0,25 / 0,24 (≈ 4× gerçek zamandan hızlı; §0.1'in 60 sn'lik soğuk kesimi
    /// 0,28'di). Tavan 2,0 = en kötü ölçümün 8 katı (aynı CI payı gerekçesi). Tavanın üstü
    /// "kısa kesim, çıktı süresinin 2 katından yavaş render ediliyor" demektir.
    /// </summary>
    private const double ExportToOutputRatioCeiling = 2.0;

    /// <summary>
    /// Türev toplamının (proxy+filmstrip+waveform+poster) orijinale oranı. §0.1: %7,7;
    /// bu testin üç koşumu: %7,47 / %7,54 / %7,46. Tavan %25 ≈ ölçümün 3,3 katı: içerik
    /// çeşitliliği payı. Tavanın üstü "proxy kaynak çözünürlüğüne/bit hızına kaçtı" sınıfı
    /// bir gerilemedir (540p reçetesi bozulmuş) — bu oran donanımdan bağımsızdır.
    /// </summary>
    private const double DerivedToOriginalRatioCeiling = 0.25;

    /// <summary>
    /// Yükleme duvar saati tavanı: kaynak süresi (= "yükleme gerçek zamandan yavaş
    /// olamaz"). Lokal MinIO'da üç koşum 0,50 / 0,52 / 0,48 sn (615-676 MB/sn); tavan
    /// 128 sn bunun ~250 katı. Bilinçli olarak YALNIZ felaket sınıfını yakalar (seri
    /// PUT'a düşme, parça başına yeniden deneme fırtınası, kilitlenme): gerçek R2'de bu
    /// satır internet hızıdır ve §0.1 bunu performans vaadi saymaz — dar bir eşik burada
    /// yalan söylerdi.
    /// </summary>
    private const double UploadWallCeilingSeconds = SourceDurationSeconds;

    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly R2StorageService _storage;
    private readonly R2StorageService _exportsBucketProbe;
    private readonly FfmpegOptions _ffmpegOptions = new();
    private readonly string _workRoot;
    private readonly Guid _userId = Guid.CreateVersion7();
    private readonly List<string> _cleanupPrefixes = [];
    private readonly Xunit.Abstractions.ITestOutputHelper _output;

    private const string MediaBucket = "videoedit-media-perf-e2e";
    private const string ExportsBucket = "videoedit-exports-perf-e2e";

    public MediaPipelinePerfTests(Xunit.Abstractions.ITestOutputHelper output)
    {
        _output = output;
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _workRoot = Directory.CreateTempSubdirectory("videoedit-perf-").FullName;

        // compose.dev.yml MinIO değerleri; test kendi bucket'larını kullanır (diğer
        // pipeline testleriyle çakışmaz) ve Dispose'ta kendi prefix'lerini siler —
        // ~320 MB'lik kaynak koşum sonrası MinIO'da BIRAKILMAZ.
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
            Directory.Delete(_workRoot, recursive: true);
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
    /// §0.1'deki kaynağın küçültülmüş eşi: 1920×1080 @30, H.264 20 Mbps + AAC; testsrc2
    /// üstüne TOHUMLU zamansal gren (all_seed → içerik reçetesi koşumlar arası sabit;
    /// x264'ün çok-iş-parçacıklı hız kontrolü yüzünden bayt boyutu ±%0,2 oynar — ölçüldü:
    /// üç koşumda 321,7 / 322,2 / 322,4 MB) ve sinüs ton. Gren şarttır: statik desenli
    /// kaynak kodlayıcıyı yormaz ve işleme oranı gerçekçi çıkmaz.
    /// </summary>
    private string GenerateSource()
    {
        var path = Path.Combine(_workRoot, "perf-source-1080p.mp4");
        var psi = new ProcessStartInfo
        {
            FileName = _ffmpegOptions.FfmpegPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
        {
            "-y",
            "-f", "lavfi", "-i", $"testsrc2=duration={SourceDurationSeconds}:size=1920x1080:rate=30",
            "-f", "lavfi", "-i", $"sine=frequency=440:sample_rate=48000:duration={SourceDurationSeconds}",
            "-filter_complex", "[0:v]noise=all_seed=52:alls=18:allf=t+u[v]",
            "-map", "[v]", "-map", "1:a",
            "-c:v", "libx264", "-preset", "veryfast", "-b:v", "20M", "-maxrate", "22M", "-bufsize", "40M",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "196k",
            path,
        })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)!;
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(600_000) && process.ExitCode == 0,
            $"perf kaynağı üretilemedi: {stderr}");
        return path;
    }

    /// <summary>
    /// Ürünün KENDİ yükleme yolu, istemci motorunun (uploadEngine.ts) sunucu tarafı eşi:
    /// multipart başlat → her 64 MiB'lık parça için presigned URL al → parçaları HTTP
    /// PUT'la (en fazla 4 eşzamanlı — istemcinin penceresiyle aynı) → ETag'larla complete.
    /// SDK'nın yüksek seviye yükleyicisi BİLEREK kullanılmıyor: tarayıcının yaptığı şey
    /// presigned PUT'tur ve ölçülen yol o olmalıdır.
    /// </summary>
    private async Task<(TimeSpan Wall, int PartCount)> MultipartUploadAsync(Asset asset, string sourcePath)
    {
        var size = new FileInfo(sourcePath).Length;
        var expectedParts = UploadRules.PartCount(size);
        var sw = Stopwatch.StartNew();

        var uploadId = await _storage.CreateMultipartUploadAsync(asset.StorageKey, "video/mp4");
        using var http = new HttpClient();
        var etags = new string[expectedParts];
        var gate = new SemaphoreSlim(4); // istemci motorunun eşzamanlılık penceresi
        var tasks = new List<Task>();
        for (var partNumber = 1; partNumber <= expectedParts; partNumber++)
        {
            var n = partNumber;
            tasks.Add(Task.Run(async () =>
            {
                await gate.WaitAsync();
                try
                {
                    var offset = (n - 1) * UploadRules.PartSizeBytes;
                    var length = Math.Min(UploadRules.PartSizeBytes, size - offset);
                    var buffer = new byte[length];
                    using (var file = File.OpenRead(sourcePath))
                    {
                        file.Position = offset;
                        await file.ReadExactlyAsync(buffer);
                    }

                    var url = _storage.PresignUploadPart(asset.StorageKey, uploadId, n);
                    using var response = await http.PutAsync(url, new ByteArrayContent(buffer));
                    Assert.True(response.IsSuccessStatusCode, $"parça {n} PUT {(int)response.StatusCode}");
                    etags[n - 1] = response.Headers.ETag!.Tag;
                }
                finally
                {
                    gate.Release();
                }
            }));
        }

        await Task.WhenAll(tasks);
        await _storage.CompleteMultipartUploadAsync(asset.StorageKey, uploadId,
            [.. etags.Select((etag, i) => new StorageCompletedPart(i + 1, etag))]);
        sw.Stop();

        var head = await _storage.HeadObjectAsync(asset.StorageKey);
        Assert.NotNull(head);
        Assert.Equal(size, head!.SizeBytes);
        return (sw.Elapsed, expectedParts);
    }

    [MinioAndFfmpegFact]
    public async Task GbClassRegime_UploadProcessingAndExport_StayWithinMeasuredRatioCeilings()
    {
        await _storage.EnsureBucketsExistAsync();
        _cleanupPrefixes.Add($"u/{_userId}");

        // ── Kaynak (deterministik, ~320 MB) ──
        var genWatch = Stopwatch.StartNew();
        var sourcePath = GenerateSource();
        genWatch.Stop();
        var sourceBytes = new FileInfo(sourcePath).Length;

        // Rejim ön şartları: dosya hedef bantta ve GERÇEKTEN çok parçalı (4'lük eşzamanlılık
        // penceresini dolduracak kadar). Bunlar tutmuyorsa ölçülen şey artık bu rejim değildir.
        Assert.InRange(sourceBytes, 256L * 1024 * 1024, 512L * 1024 * 1024);
        Assert.True(UploadRules.PartCount(sourceBytes) >= 5,
            $"kaynak {sourceBytes} B yalnız {UploadRules.PartCount(sourceBytes)} parça üretiyor — multipart rejimi kurulamadı");

        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(_userId, AssetKind.Video, "perf-source-1080p.mp4", "video/mp4", sourceBytes, now);
        asset.TransitionTo(AssetStatus.Uploaded, now);
        _db.Assets.Add(asset);
        var processJob = Job.Create(JobType.ProcessAsset, _userId, now, assetId: asset.Id);
        _db.Jobs.Add(processJob);
        await _db.SaveChangesAsync();

        // ── 1) Çok parçalı yükleme (presigned PUT'lar, 4 eşzamanlı) ──
        var (uploadWall, partCount) = await MultipartUploadAsync(asset, sourcePath);
        var uploadMbPerSec = sourceBytes / 1_000_000.0 / uploadWall.TotalSeconds;

        // ── 2) İşleme: 540p proxy + filmstrip + waveform + poster ──
        var processWatch = Stopwatch.StartNew();
        await new ProcessAssetJob(
            _db, _storage,
            new FfprobeService(_ffmpegOptions), new FfmpegRunner(_ffmpegOptions),
            new WaveformGenerator(_ffmpegOptions),
            new NoOpJobClient(), NullLogger<ProcessAssetJob>.Instance,
            TimeProvider.System, new ProcessingOptions())
            .Run(processJob.Id, CancellationToken.None);
        processWatch.Stop();

        Assert.True(asset.Status == AssetStatus.Ready,
            $"işleme başarısız: {asset.Status} / {processJob.ErrorMessage}");
        var processingRatio = processWatch.Elapsed.TotalSeconds / SourceDurationSeconds;

        // Türev toplamı: MinIO'daki gerçek objelerden (DB kolonuna değil depoya dayanır).
        long derivedBytes = 0;
        foreach (var key in new[] { asset.ProxyKey, asset.FilmstripKey, asset.WaveformKey, asset.ThumbnailKey })
        {
            Assert.NotNull(key);
            var head = await _storage.HeadObjectAsync(key!);
            Assert.NotNull(head);
            derivedBytes += head!.SizeBytes;
        }

        var derivedRatio = (double)derivedBytes / sourceBytes;

        // ── 3) Export: 30 sn'lik kesim, 1080p profili, SOĞUK cache (indirme dahil) ──
        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.Doc(
            projectId: projectId, width: 1920, height: 1080,
            clips: ExportTestDocs.VideoClip(asset.Id, 0, 0, ExportDurationUs, ExportTestDocs.Audio()));
        var exportJob = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow,
            projectId: projectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "1080p");
        _db.Jobs.Add(exportJob);
        await _db.SaveChangesAsync();

        var cacheDir = Path.Combine(_workRoot, "cache");
        var exportWatch = Stopwatch.StartNew();
        await new ExportJob(
            _db, _storage,
            new FfprobeService(_ffmpegOptions), new FfmpegRunner(_ffmpegOptions),
            new OriginalCache(_storage, new ProcessingOptions { CacheDirectory = cacheDir }),
            new NoOpJobClient(), NullLogger<ExportJob>.Instance, TimeProvider.System,
            new RunningRenderRegistry())
            .Run(exportJob.Id, CancellationToken.None);
        exportWatch.Stop();

        Assert.True(exportJob.Status == JobStatus.Succeeded,
            $"export başarısız: {exportJob.Status}: {exportJob.ErrorMessage}");
        var outputHead = await _exportsBucketProbe.HeadObjectAsync(exportJob.OutputKey!);
        Assert.NotNull(outputHead);
        var exportRatio = exportWatch.Elapsed.TotalSeconds / (ExportDurationUs / 1_000_000.0);

        // ── Sayılar (her koşumda görünür — iddia değil, BU koşumun ölçümü) ──
        _output.WriteLine($"kaynak: {sourceBytes} B ({sourceBytes / 1_000_000.0:F1} MB), "
            + $"{SourceDurationSeconds} sn 1080p30 gren; üretim {genWatch.Elapsed.TotalSeconds:F1} sn");
        _output.WriteLine($"yükleme: {uploadWall.TotalSeconds:F2} sn, {partCount} parça × 64 MiB, "
            + $"{uploadMbPerSec:F0} MB/sn (LOKAL MinIO — vaat değil)");
        _output.WriteLine($"işleme: {processWatch.Elapsed.TotalSeconds:F1} sn → oran {processingRatio:F3} "
            + $"(gerçek zamandan {1 / processingRatio:F1}× hızlı; tavan {ProcessingToSourceRatioCeiling})");
        _output.WriteLine($"türevler: {derivedBytes} B = orijinalin %{derivedRatio * 100:F2}'i "
            + $"(tavan %{DerivedToOriginalRatioCeiling * 100:F0})");
        _output.WriteLine($"export (30 sn, soğuk): {exportWatch.Elapsed.TotalSeconds:F1} sn → oran {exportRatio:F2} "
            + $"(çıktı {outputHead!.SizeBytes} B; tavan {ExportToOutputRatioCeiling})");

        // ── Oransal iddialar (eşik gerekçeleri sınıfın başındaki sabitlerde) ──
        Assert.True(uploadWall.TotalSeconds <= UploadWallCeilingSeconds,
            $"yükleme {uploadWall.TotalSeconds:F1} sn — kaynak süresinden ({UploadWallCeilingSeconds} sn) yavaş: "
            + "lokal MinIO'da felaket sınıfı bir gerileme (seri PUT / yeniden deneme fırtınası)");
        Assert.True(processingRatio <= ProcessingToSourceRatioCeiling,
            $"işleme oranı {processingRatio:F3} > tavan {ProcessingToSourceRatioCeiling} — "
            + $"{SourceDurationSeconds} sn kaynak {processWatch.Elapsed.TotalSeconds:F1} sn'de işlendi");
        Assert.True(derivedRatio <= DerivedToOriginalRatioCeiling,
            $"türev oranı %{derivedRatio * 100:F1} > tavan %{DerivedToOriginalRatioCeiling * 100:F0} — "
            + "proxy reçetesi büyümüş olabilir (540p/bit hızı kontrol et)");
        Assert.True(exportRatio <= ExportToOutputRatioCeiling,
            $"export oranı {exportRatio:F2} > tavan {ExportToOutputRatioCeiling} — "
            + $"30 sn'lik kesim {exportWatch.Elapsed.TotalSeconds:F1} sn sürdü");

        // ── §0.1'in "iş bittikten sonra worker dizini 0" iddiasının kalıcı muhafızı ──
        var workerRoot = Path.Combine(Path.GetTempPath(), "videoedit-worker");
        if (Directory.Exists(workerRoot))
        {
            Assert.Empty(Directory.GetDirectories(workerRoot, $"{processJob.Id:N}-*"));
            Assert.Empty(Directory.GetDirectories(workerRoot, $"{exportJob.Id:N}-*"));
        }
    }

    private sealed class NoOpJobClient : IBackgroundJobClient
    {
        public string Create(Hangfire.Common.Job job, IState state) => Guid.NewGuid().ToString("N");

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }
}

/// <summary>
/// Perf ölçümünün sessiz şeridi — gerekçe <see cref="MediaPipelinePerfTests"/> xmldoc'unda
/// (paralel suite yükü altında oran, ürünün değil komşu testlerin fonksiyonu oluyordu).
/// </summary>
[CollectionDefinition("pipeline-perf", DisableParallelization = true)]
public sealed class PipelinePerfCollection;
