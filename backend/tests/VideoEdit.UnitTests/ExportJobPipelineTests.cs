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
        TimeProvider.System,
        new RunningRenderRegistry());

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
        // Tuval 1280x720 + profil "720p" (dalga 2): profil artık hedef kutu taşır ve tuval
        // oranıyla eşleşmek zorundadır ('export-profile-aspect'); 720p kutusu tuvale eşit
        // olduğu için ölçek aşaması üretilmez — render maliyeti küçük kalır. Bilerek
        // BAŞARISIZ biten testlerin belgeleri 320x240 kaldı: onların tipli hataları
        // Validate/worker kapılarında, en-boy kapısından ÖNCE fırlar (öncelik ölçülüdür).
        var doc = ExportTestDocs.Doc(
            projectId: projectId,
            width: 1280, height: 720,
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
            exportProfile: "720p");
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
    public async Task Export_WithLutEffect_DownloadsTheCubeFile_AndActuallyChangesPixels()
    {
        // M5 DEFEKTİ (uçtan uca): ExportCompiler LUT dosyalarını AYRI bir defterde
        // (plan.LutAssetIds) bildiriyordu ama worker o defteri HİÇ OKUMUYORDU → .cube asla
        // indirilmiyor, Compile "unsupported-feature:lut-asset" ile düşüyordu. Yani LUT efekti
        // editörde kurulabiliyor, önizlemede çalışıyor, export'ta HER SEFERİNDE hata veriyordu.
        // Bu test yolun tamamını koşar ve RENDER EDİLMİŞ PİKSELİ ölçer — "job Succeeded" tek
        // başına yeterli kanıt değildir (LUT sessizce atlansa da iş yeşil dönerdi).
        var sourcePath = media.VideoSolid320x240NoAudio(); // düz 0x804020
        var cubePath = SwapRedBlueCube();
        var now = DateTimeOffset.UtcNow;

        var video = Asset.Create(_userId, AssetKind.Video, "solid.mp4", "video/mp4",
            new FileInfo(sourcePath).Length, now);
        MarkReady(video, now);
        // Gerçek yükleme hattının yazdığı türle (AssetKind.Lut + application/x-cube-lut) —
        // .cube'ün 'Image' beyanıyla girebildiği eski rejim artık üretimde yok.
        var lut = Asset.Create(_userId, AssetKind.Lut, "swap-rb.cube", "application/x-cube-lut",
            new FileInfo(cubePath).Length, now);
        MarkReady(lut, now);
        _db.Assets.AddRange(video, lut);

        var clip = ExportTestDocs.VideoClip(video.Id, 0, 0, 1_000_000);
        clip.Effects = [ExportTestDocs.Lut(lut.Id)];
        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.Doc(projectId: projectId, width: 1280, height: 720, clips: clip);

        var job = Job.Create(JobType.Export, _userId, now,
            projectId: projectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "720p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(video.StorageKey, sourcePath, "video/mp4");
        await _storage.UploadFileAsync(lut.StorageKey, cubePath, "application/octet-stream");

        await CreateRunner(CreateCache()).Run(job.Id, CancellationToken.None);

        Assert.True(job.Status == JobStatus.Succeeded,
            $"expected Succeeded, got {job.Status}: {job.ErrorMessage}");

        // .cube GERÇEKTEN indirildi mi (LRU cache'te uzantısıyla duruyor mu)?
        Assert.True(File.Exists(Path.Combine(_cacheDir, lut.Id.ToString("N"), "original.cube")),
            "LUT dosyası indirilmedi — worker plan.LutAssetIds defterini okumuyor");

        // PİKSEL KANITI: kaynak 0x804020, LUT R↔B takas ediyor → çıktı ≈ 0x204080.
        var localOutput = Path.Combine(_cacheDir, "lut-export.mp4");
        using (var download = await _exportsBucketProbe.OpenReadAsync(job.OutputKey!))
        await using (var file = File.Create(localOutput))
        {
            await download.Content.CopyToAsync(file);
        }

        var pixel = CentrePixel(localOutput, 15);
        byte[] expected = [0x20, 0x40, 0x80];
        var maxDiff = Math.Max(Math.Abs(pixel[0] - expected[0]),
            Math.Max(Math.Abs(pixel[1] - expected[1]), Math.Abs(pixel[2] - expected[2])));
        Assert.True(maxDiff <= 8,
            $"LUT uygulanmamış: beklenen (32,64,128) civarı, ölçülen "
            + $"({pixel[0]},{pixel[1]},{pixel[2]})");
    }

    private static void MarkReady(Asset asset, DateTimeOffset now)
    {
        asset.TransitionTo(AssetStatus.Uploaded, now);
        asset.TransitionTo(AssetStatus.Processing, now);
        asset.TransitionTo(AssetStatus.Ready, now);
    }

    /// <summary>R ve B kanallarını takas eden 2³ .cube (rendering-semantics §4.2 formatı).</summary>
    private string SwapRedBlueCube()
    {
        var path = Path.Combine(_cacheDir, "swap-rb.cube");
        if (File.Exists(path))
        {
            return path;
        }

        var text = new System.Text.StringBuilder();
        text.AppendLine("TITLE \"swap-rb\"");
        text.AppendLine("LUT_3D_SIZE 2");
        text.AppendLine("DOMAIN_MIN 0.0 0.0 0.0");
        text.AppendLine("DOMAIN_MAX 1.0 1.0 1.0");
        for (var b = 0; b < 2; b++)
        {
            for (var g = 0; g < 2; g++)
            {
                for (var r = 0; r < 2; r++)
                {
                    text.AppendLine(System.Globalization.CultureInfo.InvariantCulture,
                        $"{b.ToString(System.Globalization.CultureInfo.InvariantCulture)}.0 "
                        + $"{g.ToString(System.Globalization.CultureInfo.InvariantCulture)}.0 "
                        + $"{r.ToString(System.Globalization.CultureInfo.InvariantCulture)}.0");
                }
            }
        }

        File.WriteAllText(path, text.ToString());
        return path;
    }

    /// <summary>Çıktının <paramref name="frameIndex"/>. karesinin orta pikseli (RGB).</summary>
    private byte[] CentrePixel(string videoPath, int frameIndex)
    {
        var rawPath = Path.Combine(_cacheDir, "frame.rgb");
        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = _ffmpegOptions.FfmpegPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in (string[])[
            "-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", videoPath,
            "-vf", $"select=eq(n\\,{frameIndex.ToString(System.Globalization.CultureInfo.InvariantCulture)}),scale=320:240",
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath])
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = System.Diagnostics.Process.Start(psi)!;
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(60_000) && process.ExitCode == 0,
            $"kare çıkarımı başarısız: {stderr}");

        var rgb = File.ReadAllBytes(rawPath);
        Assert.Equal(320 * 240 * 3, rgb.Length);
        var offset = ((120 * 320) + 160) * 3;
        return [rgb[offset], rgb[offset + 1], rgb[offset + 2]];
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
    public async Task Export_MusicOnAnAudioTrack_Succeeds_AndTheOutputReallyCarriesThatSound()
    {
        // M6 DENETİMİ, N1 (KRİTİK): kullanıcı kitaplığa bir .m4a yükleyip ses track'ine
        // koyduğunda export İMKÂNSIZDI. Worker'ın indirme döngüsü klip TÜRÜNE bakmadan HER
        // varlıkta video stream'i şart koşuyordu; iş 'unsupported-media: ... has no video
        // stream' ile ölüyordu. Bu testin varlık sebebi tam olarak O DÖNGÜDÜR: birim testleri
        // ExportAssetSource'u doğrudan veriyor ve döngüye hiç girmiyorlardı.
        //
        // KANIT ÇITASI: "job Succeeded" YETMEZ, "çıktıda ses stream'i var" da yetmez —
        // dijital sessizlik de bir stream'dir. Çıktının GERÇEK SEVİYESİ ölçülür.
        var musicPath = media.AudioM4a();
        var now = DateTimeOffset.UtcNow;
        var music = Asset.Create(_userId, AssetKind.Audio, "music.m4a", "audio/mp4",
            new FileInfo(musicPath).Length, now);
        MarkReady(music, now);
        _db.Assets.Add(music);

        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.MultiTrackDoc(
            projectId: projectId, width: 1280, height: 720,
            tracks:
            [
                ExportTestDocs.AudioTrack(clips:
                    [ExportTestDocs.AudioClip(music.Id, 0, 0, 2_000_000, ExportTestDocs.Audio())]),
            ]);

        var job = Job.Create(JobType.Export, _userId, now,
            projectId: projectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "720p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(music.StorageKey, musicPath, "audio/mp4");

        await CreateRunner(CreateCache()).Run(job.Id, CancellationToken.None);

        Assert.True(job.Status == JobStatus.Succeeded,
            $"expected Succeeded, got {job.Status}: {job.ErrorMessage}");

        var localOutput = await DownloadExportAsync(job, "music-export.mp4");
        Assert.True(MeanVolumeDb(localOutput) > -50,
            "çıktı sessiz: ses klibi mikse girmemiş (yalnız stream sayısına bakan bir kontrol "
            + "bunu göremezdi)");
    }

    [MinioAndFfmpegFact]
    public async Task Export_MusicMixedWithVideo_Succeeds_AndKeepsBothSources()
    {
        // Aynı belgede SES + VİDEO: ses klibi ses varlığını, video klibi video varlığını
        // gösterir. Worker artık her varlığa AYNI soruyu sormaz — defterden (plan.AssetUses)
        // hangi varlıkta neyin arandığını okur.
        var musicPath = media.AudioM4a();
        var videoPath = media.VideoSolid320x240NoAudio(); // SESSİZ video: ses yalnız müzikten gelir
        var now = DateTimeOffset.UtcNow;
        var music = Asset.Create(_userId, AssetKind.Audio, "music.m4a", "audio/mp4",
            new FileInfo(musicPath).Length, now);
        MarkReady(music, now);
        var video = Asset.Create(_userId, AssetKind.Video, "solid.mp4", "video/mp4",
            new FileInfo(videoPath).Length, now);
        MarkReady(video, now);
        _db.Assets.AddRange(music, video);

        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.MultiTrackDoc(
            projectId: projectId, width: 1280, height: 720,
            tracks:
            [
                ExportTestDocs.VideoTrack(clips:
                    [ExportTestDocs.VideoClip(video.Id, 0, 0, 1_000_000)]),
                ExportTestDocs.AudioTrack(clips:
                    [ExportTestDocs.AudioClip(music.Id, 0, 0, 1_000_000, ExportTestDocs.Audio())]),
            ]);

        var job = Job.Create(JobType.Export, _userId, now,
            projectId: projectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "720p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(music.StorageKey, musicPath, "audio/mp4");
        await _storage.UploadFileAsync(video.StorageKey, videoPath, "video/mp4");

        await CreateRunner(CreateCache()).Run(job.Id, CancellationToken.None);

        Assert.True(job.Status == JobStatus.Succeeded,
            $"expected Succeeded, got {job.Status}: {job.ErrorMessage}");

        var localOutput = await DownloadExportAsync(job, "mixed-export.mp4");
        Assert.True(MeanVolumeDb(localOutput) > -50, "karışık belgede müzik duyulmuyor");

        // Görüntü de gerçekten VİDEO varlığından geliyor (0x804020 düz renk).
        var pixel = CentrePixel(localOutput, 15);
        Assert.True(
            Math.Abs(pixel[0] - 0x80) <= 8 && Math.Abs(pixel[1] - 0x40) <= 8
            && Math.Abs(pixel[2] - 0x20) <= 8,
            $"görüntü kaynaktan gelmemiş: ({pixel[0]},{pixel[1]},{pixel[2]})");
    }

    [MinioAndFfmpegFact]
    public async Task Export_AudioClipOnASilentVideo_FailsWithATypedError_NotAnFfmpegExitCode()
    {
        // Worker yarısının EMNİYET KEMERİ: senkron kapı DB'ye bakar, bu kapı DOSYAYA. Sessiz
        // bir videoyu ses klibi olarak kullanan belge tipli 'unsupported-media' ile düşer —
        // eskiden bu yol ya hiç sorulmuyor ya da anlamsız bir ffmpeg çıkış koduna dönüşüyordu.
        var videoPath = media.Video1280x720NoAudio();
        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(_userId, AssetKind.Video, "silent.mp4", "video/mp4",
            new FileInfo(videoPath).Length, now);
        MarkReady(asset, now);
        _db.Assets.Add(asset);

        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.MultiTrackDoc(
            projectId: projectId, width: 320, height: 240,
            tracks:
            [
                ExportTestDocs.AudioTrack(clips:
                    [ExportTestDocs.AudioClip(asset.Id, 0, 0, 1_000_000, ExportTestDocs.Audio())]),
            ]);

        var job = Job.Create(JobType.Export, _userId, now,
            projectId: projectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "1080p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(asset.StorageKey, videoPath, "video/mp4");

        await CreateRunner(CreateCache()).Run(job.Id, CancellationToken.None);

        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.Contains("unsupported-media", job.ErrorMessage);
        Assert.Contains("ses akışı", job.ErrorMessage);
        var clip = Assert.IsType<VideoEdit.Contracts.Timeline.MediaClip>(doc.Tracks[0].Clips[0]);
        Assert.Contains(clip.Id.ToString(), job.ErrorMessage);
    }

    [MinioAndFfmpegFact]
    public async Task Export_StickerClipPointingAtAVideoFile_FailsWithATypedError()
    {
        // M6 DENETİMİ, N3: çıkartma klibi bir VİDEO varlığını gösterdiğinde iş
        // 'ffmpeg-failed: ... exited with code -1414549496' ile ölüyordu — kullanıcıya
        // ANLAMSIZ bir çıkış kodu. Kural artık defterden okunur: çıkartma DURAĞAN giriş ister.
        var videoPath = media.VideoSolid320x240NoAudio();
        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(_userId, AssetKind.Image, "actually-a-video.mp4", "image/png",
            new FileInfo(videoPath).Length, now);
        MarkReady(asset, now); // DB "görsel" diyor, DOSYA video: kapı dosyaya bakar
        _db.Assets.Add(asset);

        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.MultiTrackDoc(
            projectId: projectId, width: 320, height: 240,
            tracks:
            [
                ExportTestDocs.OverlayTrack(clips:
                    [ExportTestDocs.StickerClip(asset.Id, 0, 1_000_000)]),
            ]);

        var job = Job.Create(JobType.Export, _userId, now,
            projectId: projectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "1080p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(asset.StorageKey, videoPath, "image/png");

        await CreateRunner(CreateCache()).Run(job.Id, CancellationToken.None);

        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.Contains("unsupported-media", job.ErrorMessage);
        Assert.Contains("durağan görsel", job.ErrorMessage);
        Assert.DoesNotContain("ffmpeg", job.ErrorMessage);
    }

    /// <summary>Çıktıyı exports bucket'ından yerel dosyaya indirir (piksel/ses ölçümü için).</summary>
    private async Task<string> DownloadExportAsync(Job job, string localName)
    {
        var localOutput = Path.Combine(_cacheDir, localName);
        using (var download = await _exportsBucketProbe.OpenReadAsync(job.OutputKey!))
        await using (var file = File.Create(localOutput))
        {
            await download.Content.CopyToAsync(file);
        }

        return localOutput;
    }

    /// <summary>
    /// Dosyanın ORTALAMA ses seviyesi (dBFS) — ffmpeg <c>volumedetect</c>. Ses stream'i yoksa
    /// test AÇIKÇA düşer (ölçüm yapılamadı ≠ ses var).
    /// </summary>
    private double MeanVolumeDb(string mediaPath)
    {
        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = _ffmpegOptions.FfmpegPath,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in (string[])[
            "-nostdin", "-hide_banner", "-i", mediaPath,
            "-af", "volumedetect", "-vn", "-f", "null", "-"])
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = System.Diagnostics.Process.Start(psi)!;
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(60_000), "volumedetect zaman aşımına uğradı");

        var match = System.Text.RegularExpressions.Regex.Match(
            stderr, @"mean_volume:\s*(-?\d+(\.\d+)?) dB");
        Assert.True(match.Success, $"çıktıda ölçülebilir ses stream'i yok:\n{stderr}");
        return double.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
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
