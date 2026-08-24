using System.Diagnostics;
using System.Text.Json;
using Hangfire;
using Hangfire.States;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using VideoEdit.Contracts.Timeline;
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
/// PİS-DOSYA KORPUSU (backlog borcunun kapanışı): gerçek telefonların/araçların ürettiği "tuhaf ama
/// meşru" dosya sınıfları GERÇEK ffmpeg ile üretilir ve HEM işleme hattından (ProcessAssetJob)
/// HEM export hattından (ExportJob) uçtan uca geçirilir. Sözleşme: her dosyanın sonucu
/// TİPLİDİR — ya Ready/Succeeded ya da anlamlı tipli bir hata kodu; kullanıcıya HAM ffmpeg
/// çıkış kodu gösterilmez.
///
/// Korpus: VFR video, display-matrix ile DÖNDÜRÜLMÜŞ video, TEK/garip çözünürlük (319×241),
/// KAPAK RESİMLİ ses dosyası (attached_pic), YANLIŞ UZANTILI dosya (WAV baytları .mp4 adında),
/// HLG/HDR etiketli kaynak, DİKEY (720×1280) video.
/// </summary>
[Collection("ffmpeg-media")]
public sealed class DirtyMediaCorpusTests : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly R2StorageService _storage;
    private readonly R2StorageService _exportsBucketProbe;
    private readonly FfmpegOptions _ffmpegOptions = new();
    private readonly string _workDir;
    private readonly Guid _userId = Guid.CreateVersion7();
    private readonly List<string> _cleanupPrefixes = [];

    private const string MediaBucket = "videoedit-media-dirty-e2e";
    private const string ExportsBucket = "videoedit-exports-dirty-e2e";

    public DirtyMediaCorpusTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
        _workDir = Directory.CreateTempSubdirectory("videoedit-dirty-e2e-").FullName;

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
            Directory.Delete(_workDir, recursive: true);
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

    // ───────────────────────── Korpus üreticileri (gerçek ffmpeg) ─────────────────────────
    // Süreç boyunca bir kez üretilip paylaşılan statik cache: her dosya deterministik lavfi
    // kaynaklarından türetilir; test sınıfı örnek başına yeniden kodlama yapılmaz.

    private static readonly Lock CorpusLock = new();
    private static readonly Dictionary<string, string> CorpusCache = [];
    private static readonly string CorpusDir =
        Directory.CreateTempSubdirectory("videoedit-dirty-corpus-").FullName;

    private static string GetOrCreate(string fileName, Func<string, string[][]> steps)
    {
        lock (CorpusLock)
        {
            if (CorpusCache.TryGetValue(fileName, out var cached))
            {
                return cached;
            }

            var path = Path.Combine(CorpusDir, fileName);
            foreach (var args in steps(path))
            {
                RunFfmpegStatic(args);
            }

            CorpusCache[fileName] = path;
            return path;
        }
    }

    private static void RunFfmpegStatic(string[] args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("ffmpeg başlatılamadı");
        var stderr = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(120_000) || process.ExitCode != 0)
        {
            throw new InvalidOperationException($"korpus dosyası üretilemedi: {stderr}");
        }
    }

    /// <summary>VFR: kareler düzensiz aralıklarla seyreltilir (3'ün ya da 5'in katı kalır) — r ≠ avg.</summary>
    private static string VfrVideo() => GetOrCreate("vfr.mp4", path =>
    [
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=3:size=320x240:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-af", "volume=5",
            "-vf", "select='not(mod(n,3))+not(mod(n,5))'", "-fps_mode", "vfr",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "48000",
            "-shortest",
            path,
        ],
    ]);

    /// <summary>Display-matrix ile 90° döndürülmüş video (stream copy — piksel döndürülmez, telefon deseni).</summary>
    private static string RotatedVideo() => GetOrCreate("rotated.mp4", path =>
    [
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            path + ".base.mp4",
        ],
        [
            "-y",
            "-display_rotation", "90",
            "-i", path + ".base.mp4",
            "-c", "copy",
            path,
        ],
    ]);

    /// <summary>
    /// TEK (çift olmayan) çözünürlük: GERÇEKTEN 319×241 piksel taşıyan bir video.
    /// ÜRETİMİN KENDİSİ ÖLÇÜLEREK SEÇİLDİ: yuv420p hattında hem lavfi kaynağı hem crop
    /// filtresi boyutları çifte HİZALIYOR (testsrc2=319x241 → 318×240; crop=319:241 →
    /// 318×240 — bu makinede ffprobe ile doğrulandı), yani "319×241 mp4" isteyen naif
    /// üretici sessizce 318×240 üretir ve test yanlış şeyi ölçer. RGB'de (format=rgb24)
    /// crop hizalamaz; PNG codec'li .mov ekran kaydedicilerin gerçek çıktı biçimidir.
    /// </summary>
    private static string OddResolutionVideo() => GetOrCreate("odd.mov", path =>
    [
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x242:rate=30",
            "-vf", "format=rgb24,crop=319:241:0:0",
            "-c:v", "png",
            path,
        ],
    ]);

    /// <summary>Kapak resimli (attached_pic) MP3 — müzik uygulamalarının tipik çıktısı.</summary>
    private static string AudioWithCoverArt() => GetOrCreate("cover.mp3", path =>
    [
        [
            "-y",
            "-f", "lavfi", "-i", "color=c=red:size=64x64",
            "-frames:v", "1",
            path + ".cover.png",
        ],
        [
            "-y",
            "-i", path + ".cover.png",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
            "-af", "volume=5",
            "-map", "1:a", "-map", "0:v",
            "-c:a", "libmp3lame", "-c:v", "mjpeg",
            "-disposition:v:0", "attached_pic",
            "-id3v2_version", "3",
            path,
        ],
    ]);

    /// <summary>Yanlış uzantı: WAV baytları .mp4 adında (kind=Video beyanıyla yüklenir).</summary>
    private static string WavBytesNamedMp4() => GetOrCreate("fake.mp4", path =>
    [
        [
            "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-c:a", "pcm_s16le",
            "-f", "wav",
            path,
        ],
    ]);

    /// <summary>
    /// HLG (arib-std-b67) + BT.2020 etiketli kaynak — iPhone HDR sınıfının temsilcisi.
    /// Etiketler <c>setparams</c> FRAME metadata'sıyla verilir: çıkış seçeneği olarak
    /// verilen -color_trc/-color_primaries bu makinede x264 VUI'sine ULAŞMADI (yalnız
    /// colorspace yazıldı; ffprobe ile ölçüldü), setparams üçünü de yazıyor.
    /// </summary>
    private static string HlgTaggedVideo() => GetOrCreate("hlg.mp4", path =>
    [
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=30",
            "-vf", "setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            path,
        ],
    ]);

    /// <summary>Dikey (9:16, 720×1280) video — proxy'nin portre dalını ve export pillarbox'ını zorlar.</summary>
    private static string VerticalVideo() => GetOrCreate("vertical.mp4", path =>
    [
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=2:size=720x1280:rate=30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            path,
        ],
    ]);

    /// <summary>
    /// SÜRESİNİ YALAN BEYAN EDEN başlık: 60 sn'lik GERÇEK akış taşıyan m4a'nın
    /// mvhd/tkhd/mdhd süreleri 2 sn'ye kısaltılır (bozuk kayıt cihazı/editör sınıfı).
    /// ffprobe beyanı okur (2 sn), ffmpeg ise AKIŞIN TAMAMINI çözer (60 sn) — MaxDurationUs
    /// kapısı da beyana baktığı için bu sınıfı YALNIZ çıktı-saati tavanı yakalayabilir.
    /// </summary>
    private static string LyingDurationAudio()
    {
        lock (CorpusLock)
        {
            if (CorpusCache.TryGetValue("lying.m4a", out var cached))
            {
                return cached;
            }

            var path = Path.Combine(CorpusDir, "lying.m4a");
            RunFfmpegStatic(
            [
                "-y",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=60",
                "-c:a", "aac", "-movflags", "+faststart",
                path,
            ]);
            ShortenDeclaredMp4Durations(path, declaredSeconds: 2);
            CorpusCache["lying.m4a"] = path;
            return path;
        }
    }

    /// <summary><inheritdoc cref="LyingDurationAudio" path="/summary/node()[1]"/> — video eşi
    /// (60 sn testsrc2, beyan 2 sn): VIDEO proxy tavanını uçtan uca zorlar.</summary>
    private static string LyingDurationVideo()
    {
        lock (CorpusLock)
        {
            if (CorpusCache.TryGetValue("lying.mp4", out var cached))
            {
                return cached;
            }

            var path = Path.Combine(CorpusDir, "lying.mp4");
            RunFfmpegStatic(
            [
                "-y",
                "-f", "lavfi", "-i", "testsrc2=duration=60:size=320x240:rate=30",
                "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                path,
            ]);
            ShortenDeclaredMp4Durations(path, declaredSeconds: 2);
            CorpusCache["lying.mp4"] = path;
            return path;
        }
    }

    /// <summary>
    /// moov içindeki mvhd/tkhd/mdhd (v0) süre alanlarını <paramref name="declaredSeconds"/>'a
    /// kısaltır; akış tabloları (stts/stsz) DOKUNULMAZ kalır — dosya "kısa beyan, uzun akış"
    /// olur. Tarama +faststart sayesinde yalnız mdat ÖNCESİNDE yapılır (medya baytlarındaki
    /// rastlantısal 4CC eşleşmeleri yapısal olarak dışarıda). Beklenen atom görülmezse
    /// fırlatır — korpus kendi rejimini kurduğunu kanıtlar.
    /// </summary>
    private static void ShortenDeclaredMp4Durations(string path, uint declaredSeconds)
    {
        var data = File.ReadAllBytes(path);
        var limit = FindFourCc(data, "mdat", 0, data.Length);
        if (limit < 0)
        {
            throw new InvalidOperationException("mdat bulunamadı — üretici faststart yazmamış.");
        }

        var movieTimescale = 0u;
        foreach (var (name, timescaleOffset, durationOffset) in (ReadOnlySpan<(string, int, int)>)
                 [
                     // v0 yerleşimleri: 4CC + ver/flags(4) + ctime(4) + mtime(4) …
                     ("mvhd", 16, 20),         // … + timescale(4) + duration(4)
                     ("tkhd", -1, 24),         // … + trackId(4) + reserved(4) + duration(4) — MOVIE timescale
                     ("mdhd", 16, 20),
                 ])
        {
            var found = 0;
            var from = 0;
            while (true)
            {
                var i = FindFourCc(data, name, from, limit);
                if (i < 0)
                {
                    break;
                }

                if (data[i + 4] != 0)
                {
                    throw new InvalidOperationException($"{name} v{data[i + 4]} — yama yalnız v0 bilir.");
                }

                var timescale = timescaleOffset >= 0
                    ? ReadU32(data, i + timescaleOffset)
                    : movieTimescale;
                if (name == "mvhd")
                {
                    movieTimescale = timescale;
                }

                if (timescale == 0)
                {
                    throw new InvalidOperationException($"{name}: timescale okunamadı.");
                }

                WriteU32(data, i + durationOffset, declaredSeconds * timescale);
                found++;
                from = i + 4;
            }

            if (found == 0)
            {
                throw new InvalidOperationException($"{name} bulunamadı — beyan kısaltılamadı.");
            }
        }

        File.WriteAllBytes(path, data);

        static int FindFourCc(byte[] data, string name, int from, int limit)
        {
            for (var i = from; i <= limit - 4; i++)
            {
                if (data[i] == name[0] && data[i + 1] == name[1]
                    && data[i + 2] == name[2] && data[i + 3] == name[3])
                {
                    return i;
                }
            }

            return -1;
        }

        static uint ReadU32(byte[] data, int offset) =>
            (uint)((data[offset] << 24) | (data[offset + 1] << 16)
                   | (data[offset + 2] << 8) | data[offset + 3]);

        static void WriteU32(byte[] data, int offset, uint value)
        {
            data[offset] = (byte)(value >> 24);
            data[offset + 1] = (byte)(value >> 16);
            data[offset + 2] = (byte)(value >> 8);
            data[offset + 3] = (byte)value;
        }
    }

    // ───────────────────────── Hat koşucuları ─────────────────────────

    private ProcessAssetJob CreatePipeline() => new(
        _db,
        _storage,
        new FfprobeService(_ffmpegOptions),
        new FfmpegRunner(_ffmpegOptions),
        new WaveformGenerator(_ffmpegOptions),
        new NoOpJobClient(),
        NullLogger<ProcessAssetJob>.Instance,
        TimeProvider.System,
        new ProcessingOptions());

    private async Task<(Asset Asset, Job Job)> IngestAsync(
        string sourcePath, AssetKind kind, string fileName, string contentType)
    {
        var now = DateTimeOffset.UtcNow;
        var asset = Asset.Create(_userId, kind, fileName, contentType,
            new FileInfo(sourcePath).Length, now);
        asset.TransitionTo(AssetStatus.Uploaded, now);
        _db.Assets.Add(asset);
        var job = Job.Create(JobType.ProcessAsset, _userId, now, assetId: asset.Id);
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        _cleanupPrefixes.Add($"u/{_userId}");
        await _storage.EnsureBucketsExistAsync();
        await _storage.UploadFileAsync(asset.StorageKey, sourcePath, contentType);

        await CreatePipeline().Run(job.Id, CancellationToken.None);
        return (asset, job);
    }

    private async Task<Job> ExportAsync(TimelineDoc doc, Guid projectId)
    {
        var job = Job.Create(JobType.Export, _userId, DateTimeOffset.UtcNow,
            projectId: projectId,
            timelineSnapshot: JsonDocument.Parse(ExportTestDocs.ToJson(doc)),
            exportProfile: "720p");
        _db.Jobs.Add(job);
        await _db.SaveChangesAsync();

        var cacheDir = Path.Combine(_workDir, "cache");
        var runner = new ExportJob(
            _db, _storage,
            new FfprobeService(_ffmpegOptions), new FfmpegRunner(_ffmpegOptions),
            new OriginalCache(_storage, new ProcessingOptions { CacheDirectory = cacheDir }),
            new NoOpJobClient(), NullLogger<ExportJob>.Instance, TimeProvider.System,
            new RunningRenderRegistry());
        await runner.Run(job.Id, CancellationToken.None);
        return job;
    }

    private async Task<Job> ExportVideoClipAsync(Asset asset, long durationUs = 1_000_000)
    {
        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.Doc(
            projectId: projectId, width: 1280, height: 720,
            clips: ExportTestDocs.VideoClip(asset.Id, 0, 0, durationUs));
        return await ExportAsync(doc, projectId);
    }

    private static void AssertReady(Asset asset, Job job)
    {
        Assert.True(asset.Status == AssetStatus.Ready,
            $"işleme Ready beklerken {asset.Status} ({asset.FailureReason}): {job.ErrorMessage}");
        Assert.Equal(JobStatus.Succeeded, job.Status);
    }

    private static void AssertExportSucceeded(Job job)
    {
        Assert.True(job.Status == JobStatus.Succeeded,
            $"export Succeeded beklerken {job.Status}: {job.ErrorMessage}");
        Assert.NotNull(job.OutputKey);
    }

    // ───────────────────────── Korpus testleri ─────────────────────────

    [MinioAndFfmpegFact]
    public async Task Vfr_ProcessesToReady_AndExportsToReady()
    {
        var source = VfrVideo();

        // Ön şart: dosya GERÇEKTEN VFR (r_frame_rate ≠ avg_frame_rate) — değilse korpus
        // kendi rejimini kurmamış demektir, test yanlış şeyi ölçer.
        var probe = await new FfprobeService(_ffmpegOptions).ProbeAsync(source, CancellationToken.None);
        Assert.True(probe.IsVfr, "korpus dosyası VFR çıkmadı — üretici seyreltmeyi kaybetmiş");

        var (asset, job) = await IngestAsync(source, AssetKind.Video, "vfr.mp4", "video/mp4");
        AssertReady(asset, job);
        Assert.True(asset.HasAudio);

        AssertExportSucceeded(await ExportVideoClipAsync(asset));
    }

    [MinioAndFfmpegFact]
    public async Task RotatedDisplayMatrix_ProcessesWithSwappedDimensions_AndExports()
    {
        var (asset, job) = await IngestAsync(RotatedVideo(), AssetKind.Video, "rotated.mp4", "video/mp4");
        AssertReady(asset, job);

        // Rotation UYGULANMIŞ boyutlar (MediaProbe sözleşmesi): 320×240'lık kaynak 90°
        // display matrix ile 240×320 olarak defterlenir — editör ve export aynı geometriyi görür.
        Assert.Equal(240, asset.Width);
        Assert.Equal(320, asset.Height);

        AssertExportSucceeded(await ExportVideoClipAsync(asset));
    }

    [MinioAndFfmpegFact]
    public async Task OddResolution_ProcessesToReady_AndExports()
    {
        var source = OddResolutionVideo();

        // Ön şart: dosya GERÇEKTEN tek boyutlu (üretim hattı sessizce çifte hizalamadı).
        var probe = await new FfprobeService(_ffmpegOptions).ProbeAsync(source, CancellationToken.None);
        Assert.Equal((319, 241), (probe.Width, probe.Height));

        var (asset, job) = await IngestAsync(source, AssetKind.Video, "odd.mov", "video/quicktime");
        AssertReady(asset, job);
        Assert.Equal(319, asset.Width);
        Assert.Equal(241, asset.Height);

        AssertExportSucceeded(await ExportVideoClipAsync(asset));
    }

    [MinioAndFfmpegFact]
    public async Task AudioWithCoverArt_ProcessesAsPureAudio_AndTheExportCarriesSound()
    {
        var source = AudioWithCoverArt();

        // Ön şart: kapak resmi attached_pic olarak gömülü ve MediaProbe onu VİDEO SAYMIYOR
        // (sözleşme: attached_pic kapaklar HasVideo'ya girmez — girseydi kind gate'i bu
        // meşru müzik dosyasını 'kind-mismatch' ile reddederdi).
        var probe = await new FfprobeService(_ffmpegOptions).ProbeAsync(source, CancellationToken.None);
        Assert.True(probe.HasAudio);
        Assert.False(probe.HasVideo, "attached_pic kapak gerçek video stream'i sayıldı");

        var (asset, job) = await IngestAsync(source, AssetKind.Audio, "cover.mp3", "audio/mpeg");
        AssertReady(asset, job);
        Assert.True(asset.HasAudio);
        Assert.Null(asset.Width); // kapak, görüntü metadata'sı üretmez

        var projectId = Guid.CreateVersion7();
        var doc = ExportTestDocs.MultiTrackDoc(
            projectId: projectId, width: 1280, height: 720,
            tracks:
            [
                ExportTestDocs.AudioTrack(clips:
                    [ExportTestDocs.AudioClip(asset.Id, 0, 0, 1_000_000, ExportTestDocs.Audio())]),
            ]);
        AssertExportSucceeded(await ExportAsync(doc, projectId));
    }

    [MinioAndFfmpegFact]
    public async Task WrongExtension_WavBytesNamedMp4_FailsTyped_InBothPipelines()
    {
        // İşleme: video beyanlı ama içinde görüntü akışı olmayan dosya TİPLİ düşer — ham
        // ffmpeg çıkış kodu DEĞİL ('unsupported-media' + açıklayıcı cümle).
        var (asset, job) = await IngestAsync(WavBytesNamedMp4(), AssetKind.Video, "fake.mp4", "video/mp4");
        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("unsupported-media", asset.FailureReason);
        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.StartsWith("unsupported-media", job.ErrorMessage!, StringComparison.Ordinal);
        Assert.DoesNotContain("exited with code", job.ErrorMessage);

        // Export: Ready olmayan varlığı gösteren belge TİPLİ 'asset-not-ready' ile düşer —
        // ffmpeg'e hiç inilmez.
        var exportJob = await ExportVideoClipAsync(asset);
        Assert.Equal(JobStatus.Failed, exportJob.Status);
        Assert.StartsWith("asset-not-ready", exportJob.ErrorMessage!, StringComparison.Ordinal);
        Assert.DoesNotContain("exited with code", exportJob.ErrorMessage);
    }

    [MinioAndFfmpegFact]
    public async Task HlgTaggedSource_ProcessesToReady_AndExportsToBt709()
    {
        var source = HlgTaggedVideo();
        var probe = await new FfprobeService(_ffmpegOptions).ProbeAsync(source, CancellationToken.None);
        Assert.True(probe.IsHdr, "korpus dosyası HDR etiketli çıkmadı (arib-std-b67/bt2020)");

        var (asset, job) = await IngestAsync(source, AssetKind.Video, "hlg.mp4", "video/mp4");
        AssertReady(asset, job);

        // Export başarılı OLMAK ZORUNDA ve çıktının bt709 olduğu ExportJob'ın KENDİ çıkış
        // kapısıyla garantidir (renk tag gate'i çıktıyı ffprobe'la doğrular; HLG kaynaktan
        // bt709 üretilemeseydi iş 'output-invalid' ile düşerdi).
        AssertExportSucceeded(await ExportVideoClipAsync(asset));
    }

    [MinioAndFfmpegFact]
    public async Task LyingDurationAudio_ProxyOverrunsTheCeiling_FailsTyped()
    {
        var source = LyingDurationAudio();

        // Ön şart: dosya GERÇEKTEN yalan söylüyor — beyan 2 sn (yama tutmadıysa korpus kendi
        // rejimini kurmamış demektir; gerçek akışın 60 sn olduğu aşağıdaki overrun'ın kendisiyle
        // ölçülür: tavan 7,2 sn'dir ve ancak akış beyanı aşarsa aşılabilir).
        var probe = await new FfprobeService(_ffmpegOptions).ProbeAsync(source, CancellationToken.None);
        Assert.Equal(2_000_000, probe.DurationUs);

        var (asset, job) = await IngestAsync(source, AssetKind.Audio, "lying.m4a", "audio/mp4");

        // TİPLİ SONUÇ: süreç kendi kendine ölmedi, tavan öldürdü — 'transcode-overrun'
        // ('ffmpeg-timeout' da 'ffmpeg-failed' da DEĞİL; ham çıkış kodu kullanıcıya sızmaz).
        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("transcode-overrun", asset.FailureReason);
        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.StartsWith("transcode-overrun", job.ErrorMessage!, StringComparison.Ordinal);
        Assert.Contains("kept writing past the expected output duration", job.ErrorMessage);
        Assert.DoesNotContain("exited with code", job.ErrorMessage);
    }

    [MinioAndFfmpegFact]
    public async Task LyingDurationVideo_ProxyOverrunsTheCeiling_FailsTyped()
    {
        var source = LyingDurationVideo();
        var probe = await new FfprobeService(_ffmpegOptions).ProbeAsync(source, CancellationToken.None);
        Assert.Equal(2_000_000, probe.DurationUs);

        var (asset, job) = await IngestAsync(source, AssetKind.Video, "lying.mp4", "video/mp4");

        Assert.Equal(AssetStatus.Failed, asset.Status);
        Assert.Equal("transcode-overrun", asset.FailureReason);
        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.StartsWith("transcode-overrun", job.ErrorMessage!, StringComparison.Ordinal);
        Assert.DoesNotContain("exited with code", job.ErrorMessage);
    }

    [MinioAndFfmpegFact]
    public async Task VerticalVideo_ProcessesToReady_AndExports()
    {
        var (asset, job) = await IngestAsync(VerticalVideo(), AssetKind.Video, "vertical.mp4", "video/mp4");
        AssertReady(asset, job);
        Assert.Equal(720, asset.Width);
        Assert.Equal(1280, asset.Height);

        AssertExportSucceeded(await ExportVideoClipAsync(asset));
    }

    private sealed class NoOpJobClient : IBackgroundJobClient
    {
        public string Create(Hangfire.Common.Job job, IState state) => Guid.NewGuid().ToString("N");

        public bool ChangeState(string jobId, IState state, string expectedState) => true;
    }
}
