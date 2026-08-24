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
using VideoEdit.Media.Export;
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

    /// <summary>
    /// Koşan render defteri. Bu sınıfın testleri ffmpeg BAŞLATMAZ, yani defter hep boş kalır;
    /// gerçek kayıt/iptal davranışı <see cref="WorkerReliabilityTests"/>'te koşturulur.
    /// </summary>
    private readonly RunningRenderRegistry Renders = new();

    /// <summary>
    /// Bu test sınıfının LRU cache kökü — HER ZAMAN test-yerel bir temp dizini.
    /// <para>
    /// Ölçülen kaza (docs/backlog.md): burada `new ProcessingOptions()` kullanılıyordu,
    /// `CacheDirectory` boş kalınca `OriginalCache.Root` MAKİNE GENELİNDEKİ
    /// `%TEMP%\videoedit-cache`'e düşüyordu ve disk-darlığı testi `TrimAsync(0)` ile oradaki
    /// GERÇEK export cache girdilerini siliyordu (1,51 GiB'lık canlı girdi ölçüm sırasında
    /// böyle kayboldu). İzolasyonun kendisi
    /// <see cref="Run_DiskFullPath_NeverTouchesTheMachineWideCache"/> ile ölçülür.
    /// </para>
    /// </summary>
    private readonly string _cacheRoot;

    public ExportJobTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _cacheRoot = Directory.CreateTempSubdirectory("videoedit-exportjobtests-cache-").FullName;
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
        try
        {
            Directory.Delete(_cacheRoot, recursive: true);
        }
        catch
        {
            // best-effort temp temizliği
        }
    }

    private ExportJob CreateJobRunner(IBackgroundJobClient? jobClient = null)
    {
        var ffmpegOptions = new FfmpegOptions();
        var storage = new StubStorage();
        return new ExportJob(
            _db,
            storage,
            new FfprobeService(ffmpegOptions),
            new FfmpegRunner(ffmpegOptions),
            new OriginalCache(storage, new ProcessingOptions { CacheDirectory = _cacheRoot }),
            jobClient ?? new NoOpJobClient(),
            NullLogger<ExportJob>.Instance,
            TimeProvider.System,
            Renders);
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
        // Çok katman, metin/şekil/çıkartma ve geçişler, HIZ +
        // renk düzeltme + transform/opaklık/SES SEVİYESİ keyframe'leri ARTIK desteklenir.
        // Kapsam dışı kalan tipli hatalardan biriyle test edilir: SES klibine GÖRSEL (opacity)
        // keyframe'i — ses klibi görüntü üretmez, animasyonun karşılığı yoktur.
        var clip = ExportTestDocs.AudioClip(ExportTestDocs.AssetA, 0, 0, 1_000_000);
        clip.Keyframes = new VideoEdit.Contracts.Timeline.KeyframeTracks
        {
            Opacity = [ExportTestDocs.Kf(0, 1), ExportTestDocs.Kf(500_000, 0)],
        };
        var doc = ExportTestDocs.MultiTrackDoc(
        [
            ExportTestDocs.VideoTrack(clips:
            [
                ExportTestDocs.VideoClip(ExportTestDocs.AssetA, 0, 0, 1_000_000),
            ]),
            ExportTestDocs.AudioTrack(clips: [clip]),
        ]);
        var job = await SeedExportJobAsync(ExportTestDocs.ToJson(doc));

        await CreateJobRunner().Run(job.Id, CancellationToken.None); // fırlatmamalı

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Failed, reloaded.Status);
        Assert.Contains("unsupported-feature:keyframes-audio-clip", reloaded.ErrorMessage);
        Assert.NotNull(reloaded.CompletedAt);
    }

    [Fact]
    public async Task Run_OverlayClipWithoutTheRasterService_FailsDeterministically()
    {
        // Metin/şekil klibi SkiaSharp rasteri ister. Servis DI'a kayıtlı değilse
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

    private static Asset SourceAsset(AssetKind kind, long sizeBytes, long? durationUs)
    {
        var asset = Asset.Create(
            Guid.CreateVersion7(), kind, "src.bin", "application/octet-stream",
            sizeBytes, DateTimeOffset.UtcNow);
        asset.DurationMicros = durationUs;
        return asset;
    }

    [Fact]
    public void EffectiveOutputBitsPerSecond_UsesTheMeasuredSourceBitrate_WhenItExceedsTheProfile()
    {
        // Ölçüldü: sabit 10 Mbps varsayımı 28,85 Mbps'lik gerçek CRF çıktısını
        // KÜÇÜMSÜYORDU. 25 MB / 10 sn = 20 Mbps'lik kaynak artık tahmine girer.
        var highBitrate = SourceAsset(AssetKind.Video, 25_000_000, 10_000_000);
        var bps = ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Hd1080p, [highBitrate]);
        Assert.Equal(20_000_000, bps);

        // Ve rezervasyon o bit hızıyla büyür: 10 sn × 20 Mbps = 25 MB çıktı payı.
        var estimate = ExportJob.EstimateRequiredDiskBytes(25_000_000, 10_000_000, bps);
        Assert.Equal((25_000_000L + 25_000_000L) * 12 / 10, estimate);
    }

    [Fact]
    public void EffectiveOutputBitsPerSecond_KeepsTheProfileFloor_ForLowBitrateSources()
    {
        // NEGATİF KONTROL (şişme yok): 1,25 MB / 10 sn = 1 Mbps'lik kaynakta taban profil
        // varsayımıdır — tahmin ESKİ formülle bire bir aynı kalır.
        var lowBitrate = SourceAsset(AssetKind.Video, 1_250_000, 10_000_000);
        var bps = ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Hd1080p, [lowBitrate]);
        Assert.Equal(ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Hd1080p), bps);
    }

    [Fact]
    public void EffectiveOutputBitsPerSecond_IgnoresAssetsWithoutARealTimeAxis()
    {
        // Görsel varlığın "süresi" bir zaman ekseni değildir: 2 MB'lık PNG'ye 40 ms süre
        // yazılsaydı 400 Mbps'lik saçma bir bit hızı çıkardı. Süresiz satırlar da atlanır.
        var stillWithTinyDuration = SourceAsset(AssetKind.Image, 2_000_000, 40_000);
        var noDuration = SourceAsset(AssetKind.Video, 500_000_000, null);
        var zeroDuration = SourceAsset(AssetKind.Video, 500_000_000, 0);
        var bps = ExportJob.EffectiveOutputBitsPerSecond(
            ExportProfile.Hd1080p, [stillWithTinyDuration, noDuration, zeroDuration]);
        Assert.Equal(ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Hd1080p), bps);
    }

    [Fact]
    public void EffectiveOutputBitsPerSecond_TakesTheMaxAcrossSources()
    {
        // Birden çok kaynak: en yüksek ölçülen bit hızı kazanır (çıktının karmaşıklığını
        // en karmaşık kaynak belirler); sesli kaynaklar da sayılır.
        var video = SourceAsset(AssetKind.Video, 15_000_000, 10_000_000); // 12 Mbps
        var audio = SourceAsset(AssetKind.Audio, 40_000_000, 10_000_000); // 32 Mbps
        var bps = ExportJob.EffectiveOutputBitsPerSecond(ExportProfile.Hd1080p, [video, audio]);
        Assert.Equal(32_000_000, bps);
    }

    [Fact]
    public void EstimateRequiredDiskBytes_AtTimelineCeiling_StaysWithinReservationBudget()
    {
        // TAVANIN GEREKÇESİNİN BİRİNCİ AYAĞI. ExportCompiler.MaxTimelineDurationUs
        // keyfi bir sayı değildir: worker'ın rezervasyonu SÜREYLE doğrusaldır ve tavandaki değeri
        // BURADA KOŞARAK sabitlenir. Sayı değişirse bu test kırmızı olur ve tavanın gerekçesi
        // (docs/poc-bilinen-sinirlar.md) güncellenmeye zorlanır.
        var atCeiling = ExportJob.EstimateRequiredDiskBytes(
            totalSourceBytes: 0,
            ExportCompiler.MaxTimelineDurationUs,
            ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Hd1080p));

        Assert.Equal(21_600_000_000L, atCeiling);

        // PROFİLLER: en yüksek taban 2160p'dir (40 Mbps — 1080p bandının piksel
        // alanı ölçeklemesi). Tavandaki 4K rezervasyonu 86,4 GB'dir; kullanıcı başına 2
        // eşzamanlı exportla en kötü uç 172,8 GB — bu uç bir GARANTİ değil, worker'ın
        // disk-wait/disk-full hattının görev alanıdır (gerçek darlık orada tipli düşer;
        // Run_GenuinelyFullDisk_OnFinalAttempt_StillFailsWithDiskFull). Sayı burada
        // sabitlenir ki taban değişirse tavanın gerekçesi güncellenmeye zorlansın.
        var atCeiling4K = ExportJob.EstimateRequiredDiskBytes(
            totalSourceBytes: 0,
            ExportCompiler.MaxTimelineDurationUs,
            ExportProfiles.EstimatedBitsPerSecond(ExportProfile.Uhd2160p));

        Assert.Equal(86_400_000_000L, atCeiling4K);
    }

    [Fact]
    public void TimelineCeiling_MatchesTheIngestDurationCeiling()
    {
        // TAVANIN GEREKÇESİNİN İKİNCİ AYAĞI — ve aynı zamanda SÜRÜKLENME
        // MUHAFIZI. Depo zaten TEK KAYNAK için 4 saatlik bir tavan taşıyor
        // (ProcessingOptions.MaxDurationUs: aşan kaynak probe sonrası Failed('too-long')).
        // Çizelge tavanının AYNI sayı olması sistemi tutarlı kılar: "yükleyebileceğin en uzun
        // dosya" ile "dışa aktarabileceğin en uzun çizelge" aynı cümledir.
        //
        // İki sayı AYRI yerlerde yaşar ve öyle kalmalıdır: biri worker'ın YAPILANDIRILABİLİR
        // ayarı (operatör değiştirebilir), diğeri derleyicinin sabiti (API sürecinde de koşar,
        // VideoEdit.Media worker'a referans VEREMEZ — katman kuralı). Bu test yalnız
        // VARSAYILANLARI karşılaştırır: biri değişirse kırmızı olur ve diğerinin de
        // değişip değişmeyeceği BİLİNÇLİ bir karar hâline gelir.
        Assert.Equal(ExportCompiler.MaxTimelineDurationUs, new ProcessingOptions().MaxDurationUs);
    }

    /// <summary>
    /// F1'İN İKİNCİ YARISI: belge kusuru ile GERÇEK disk darlığı ayrı şeylerdir ve ayrı kalmalıdır.
    /// <para>
    /// Senkron süre tavanı (<c>timeline-too-long</c>) eklendikten sonra "belge yüzünden
    /// disk-full" hali kalmamıştır; ama tavanın ALTINDAKİ tamamen makul bir belge, worker'ın
    /// diski gerçekten doluysa HÂLÂ <c>disk-full</c> almalıdır — orada kusur KURULUMDADIR.
    /// Bu test o yolu koşarak korur: tavanın çok altında 1 sn'lik bir belge + hep dolu disk +
    /// üçüncü deneme → Failed('disk-full').
    /// </para>
    /// </summary>
    [Fact]
    public async Task Run_GenuinelyFullDisk_OnFinalAttempt_StillFailsWithDiskFull()
    {
        var job = await SeedReadyAssetAndJobAsync();   // 1 sn'lik belge — tavanın çok altında
        job.AttemptCount = ExportJob.MaxDiskFullAttempts - 1; // Run bir artıracak → son deneme
        await _db.SaveChangesAsync();

        var jobs = new RecordingJobClient();
        var runner = CreateJobRunner(jobs);
        runner.FreeSpaceProbe = _ => 1; // trim'den sonra da yetersiz — GERÇEK darlık

        await runner.Run(job.Id, CancellationToken.None);

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Failed, reloaded.Status);
        Assert.StartsWith("disk-full: ", reloaded.ErrorMessage, StringComparison.Ordinal);
        Assert.Equal(0, jobs.ScheduleCount); // son denemede erteleme YOK
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
            jobs, NullLogger<ExportJob>.Instance, TimeProvider.System, Renders)
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
            jobs, NullLogger<ExportJob>.Instance, TimeProvider.System, Renders);
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

    // ---------- Bellek kabul kapısı (disk kapısının bekle/başarısız deseniyle) ----------

    /// <summary>
    /// GEÇİCİ bellek darlığı: kapı işi Failed ETMEZ, 'memory-wait' ile 2 dk sonraya yeniden
    /// kuyruklar (disk-wait'in eşi). Okuyucu enjekte edilir — gerçek darlık simülasyonu
    /// budur: formülün bu belge için istediği tahmin (>1 GB) 512 MB'lik "kullanılabilir"
    /// değeriyle karşılanamaz.
    /// </summary>
    [Fact]
    public async Task Run_InsufficientMemory_RequeuesWithMemoryWaitStage()
    {
        var job = await SeedReadyAssetAndJobAsync();
        var jobs = new RecordingJobClient();
        var runner = CreateJobRunner(jobs);
        runner.AvailableMemoryProbe = () => 512L * 1024 * 1024;

        await runner.Run(job.Id, CancellationToken.None);

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Queued, reloaded.Status);
        Assert.Equal("memory-wait", reloaded.ProgressStage);
        Assert.Equal(1, jobs.ScheduleCount);
    }

    /// <summary>KALICI darlık: son denemede tipli Failed('insufficient-memory'), erteleme YOK.</summary>
    [Fact]
    public async Task Run_InsufficientMemory_OnFinalAttempt_FailsTyped()
    {
        var job = await SeedReadyAssetAndJobAsync();
        job.AttemptCount = ExportJob.MaxInsufficientMemoryAttempts - 1; // Run bir artıracak
        await _db.SaveChangesAsync();

        var jobs = new RecordingJobClient();
        var runner = CreateJobRunner(jobs);
        runner.AvailableMemoryProbe = () => 512L * 1024 * 1024;

        await runner.Run(job.Id, CancellationToken.None);

        var reloaded = Reload(job.Id);
        Assert.Equal(JobStatus.Failed, reloaded.Status);
        Assert.StartsWith("insufficient-memory: ", reloaded.ErrorMessage, StringComparison.Ordinal);
        Assert.Equal(0, jobs.ScheduleCount);
    }

    /// <summary>
    /// Ölçüm YOKLUĞU yanlış ret üretmez: okuyucu -1 dönerse kapı atlanır ve iş indirme
    /// aşamasına GEÇER (disk kapısının -1 sözleşmesiyle aynı; devam kanıtı StubStorage'ın
    /// transient patlaması — Run_TrimFreesEnoughDisk ile aynı teknik).
    /// </summary>
    [Fact]
    public async Task Run_MemoryUnmeasurable_SkipsTheGateAndContinues()
    {
        var job = await SeedReadyAssetAndJobAsync();
        var jobs = new RecordingJobClient();
        var runner = CreateJobRunner(jobs);
        runner.AvailableMemoryProbe = () => -1;

        await Assert.ThrowsAsync<NotSupportedException>(
            () => runner.Run(job.Id, CancellationToken.None));

        Assert.Equal(0, jobs.ScheduleCount);
        Assert.Equal(JobStatus.Running, Reload(job.Id).Status); // erteleme/fail yazılmadı
    }

    /// <summary>
    /// BOL bellek kapıdan geçer: tahminin hemen üstündeki bir değerle bile iş indirmeye
    /// ilerler — kapı gereğinden geniş bir bant istemiyor (yanlış ret sınıfının birim ucu;
    /// canlı ucu ExportMemoryEstimateTests + gerçek 2160p koşusudur).
    /// </summary>
    [Fact]
    public async Task Run_AmpleMemory_PassesTheGate()
    {
        var job = await SeedReadyAssetAndJobAsync();
        var jobs = new RecordingJobClient();
        var runner = CreateJobRunner(jobs);

        // Bu belgenin tahmini (boyutsuz kaynak → tuval varsayımı): birebir formülden.
        var required = ExportJob.EstimateRequiredMemoryBytes(
            targetPixels: 1920L * 1080, canvasPixels: 1920L * 1080,
            graphInputCount: 1, peakConcurrentVisualInputs: 1,
            peakConcurrentMotionSourcePixels: 1920L * 1080);
        runner.AvailableMemoryProbe = () => required; // tam sınırda: available >= required

        await Assert.ThrowsAsync<NotSupportedException>(
            () => runner.Run(job.Id, CancellationToken.None));

        Assert.Equal(0, jobs.ScheduleCount);
        Assert.Equal(JobStatus.Running, Reload(job.Id).Status);
    }

    /// <summary>
    /// 12. TUR BULGUSUNUN KAPANIŞI (docs/backlog.md "[AÇIK — ORTA] Birim testi MAKİNE
    /// GENELİNDEKİ gerçek export cache'ini SİLİYOR"): disk-darlığı yolu agresif
    /// <c>TrimAsync(0)</c> çağırır ve eskiden bu sınıfın runner'ı varsayılan
    /// <c>ProcessingOptions</c> ile kurulduğundan süpürme <c>%TEMP%\videoedit-cache</c>'e —
    /// canlı worker'ın gerçek cache'ine — iniyordu.
    /// <para>
    /// Kanıt iki bacaklıdır: (1) TEHLİKE HÂLÂ GERÇEK (negatif kontrol) — varsayılan
    /// ayarlarla kurulan cache'in kökü bugün de makine dizinidir; kusur "kendiliğinden"
    /// kapanmamıştır, testin izolasyonu bilinçli bir seçimdir. (2) İZOLASYON ÇALIŞIYOR —
    /// makine köküne konan nöbetçi girdi, agresif süpürme İÇEREN disk-full koşusundan
    /// sonra yerli yerindedir (eski kurulumda ölçülen davranış silinmesiydi).
    /// </para>
    /// </summary>
    [Fact]
    public async Task Run_DiskFullPath_NeverTouchesTheMachineWideCache()
    {
        // (1) Negatif kontrol: varsayılan ProcessingOptions HÂLÂ makine köküne düşer.
        var machineRoot = Path.Combine(Path.GetTempPath(), "videoedit-cache");
        Assert.Equal(machineRoot, new OriginalCache(new StubStorage(), new ProcessingOptions()).Root);

        // Bu sınıfın runner'ı ise test-yerel bir kökte yaşar.
        Assert.NotEqual(machineRoot, _cacheRoot);
        Assert.False(_cacheRoot.StartsWith(machineRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));

        // (2) Nöbetçi: makine cache köküne benzersiz adlı, TAZE damgalı küçük bir girdi.
        // (Guid'li ad gerçek girdilerle çakışmaz; taze damga canlı worker'ın olağan LRU
        // süpürmesinin onu "en eski" diye seçmesini de imkânsızlaştırır.)
        Directory.CreateDirectory(machineRoot);
        var sentinelDir = Path.Combine(machineRoot, Guid.CreateVersion7().ToString("N"));
        Directory.CreateDirectory(sentinelDir);
        var sentinelFile = Path.Combine(sentinelDir, "original.bin");
        await File.WriteAllBytesAsync(sentinelFile, new byte[64]);
        File.SetLastWriteTimeUtc(sentinelFile, DateTime.UtcNow);

        try
        {
            // Agresif süpürme İÇEREN yol: hep dolu disk + son deneme → TrimAsync(0) + Failed.
            var job = await SeedReadyAssetAndJobAsync();
            job.AttemptCount = ExportJob.MaxDiskFullAttempts - 1;
            await _db.SaveChangesAsync();
            var runner = CreateJobRunner(new RecordingJobClient());
            runner.FreeSpaceProbe = _ => 1;

            await runner.Run(job.Id, CancellationToken.None);
            Assert.Equal(JobStatus.Failed, Reload(job.Id).Status); // yol gerçekten koşuldu

            // Nöbetçi HAYATTA: süpürme test-yerel kökte kaldı, makine cache'ine inmedi.
            Assert.True(File.Exists(sentinelFile),
                "disk-full yolu makine genelindeki cache'i süpürdü — izolasyon delinmiş");
        }
        finally
        {
            try
            {
                Directory.Delete(sentinelDir, recursive: true);
            }
            catch
            {
                // best-effort nöbetçi temizliği
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
