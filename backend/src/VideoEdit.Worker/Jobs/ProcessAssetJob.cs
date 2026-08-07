using System.Globalization;
using System.Net;
using System.Text.Json;
using Amazon.S3;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Jobs;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media;
using VideoEdit.Media.Probing;
using VideoEdit.Media.Recipes;
using VideoEdit.Media.Waveform;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// M1-B asset işleme hattı: disk kontrolü → orijinali indir (stream) → ffprobe gate →
/// metadata → Kind'e göre türevler (Video: CFR proxy + filmstrip + waveform + poster;
/// Audio: AAC proxy + waveform; Image: poster) → türevleri yükle → Ready.
///
/// Hata sınıflandırması:
///  - ağ/S3/IO → exception FIRLATILIR (Hangfire AutomaticRetry(2); işleme idempotent —
///    çıktı key'lerinin üzerine yazılır);
///  - deterministik ffmpeg/probe hatası → asset Failed + job Failed işaretlenir ve NORMAL
///    dönülür (Hangfire retry tetiklenmez — aynı girdi aynı hatayı üretir);
///  - disk yetersiz → Failed DEĞİL: iş ertelenip yeniden kuyruğa atılır, 3. denemede Failed.
///
/// Progress: indirme %0-15, probe %15-20, proxy %20-70 (ffmpeg -progress'ten orantılı),
/// filmstrip %70-85, waveform %85-92, upload+poster %92-100. DB'ye yalnız ≥5 puan
/// değişimde (ya da stage değişince) yazılır.
/// </summary>
public sealed class ProcessAssetJob(
    AppDbContext db,
    IStorageService storage,
    FfprobeService ffprobe,
    FfmpegRunner ffmpeg,
    WaveformGenerator waveformGenerator,
    IBackgroundJobClient backgroundJobs,
    ILogger<ProcessAssetJob> logger,
    TimeProvider clock,
    ProcessingOptions processing) : IProcessAssetJob
{
    /// <summary>Süre bilinmiyorken kaba disk payı: orijinal + proxy + türevler ≈ 3× dosya boyutu.</summary>
    public const int RequiredDiskMultiplier = 3;

    /// <summary>Süre-farkındalı tahminde proxy bit hızı varsayımı (~3 Mbps; 540p H.264 CRF23 üstü sınır).</summary>
    public const long AssumedProxyBitsPerSecond = 3_000_000;

    /// <summary>Disk yetersizse en fazla bu kadar denemede Failed('disk-full').</summary>
    public const int MaxDiskFullAttempts = 3;

    public static readonly TimeSpan DiskFullRetryDelay = TimeSpan.FromMinutes(2);

    public async Task Run(Guid jobId, CancellationToken ct)
    {
        var job = await db.Jobs.SingleOrDefaultAsync(j => j.Id == jobId, ct);
        if (job is null)
        {
            logger.LogWarning("ProcessAssetJob: job row {JobId} not found; skipping.", jobId);
            return;
        }

        var asset = job.AssetId is { } assetId
            ? await db.Assets.SingleOrDefaultAsync(a => a.Id == assetId && a.DeletedAt == null, ct)
            : null;
        if (asset is null)
        {
            logger.LogWarning("ProcessAssetJob {JobId}: asset {AssetId} not found or deleted; skipping.",
                jobId, job.AssetId);
            return;
        }

        // Çift koşu idempotency kısa devresi: Hangfire InvisibilityTimeout sonrası aynı işin
        // ikinci teslimi (iş aslında bitmişti) türevleri boşuna yeniden üretmesin.
        if (job.Status == JobStatus.Succeeded && asset.Status == AssetStatus.Ready)
        {
            logger.LogInformation(
                "ProcessAssetJob {JobId}: already succeeded and asset {AssetId} is Ready; "
                + "duplicate delivery short-circuited.", jobId, asset.Id);
            return;
        }

        var now = clock.GetUtcNow();
        job.Status = JobStatus.Running;
        job.StartedAt ??= now;
        job.LastProgressAt = now; // heartbeat: reaper "canlı iş" kanıtı
        job.AttemptCount += 1;

        // Complete endpoint'i asset'i zaten Processing'e almıştır; retry (Failed) ve
        // olağandışı Uploaded durumları burada Processing'e çekilir. Processing'e her geçiş
        // ProcessingStartedAt'ı damgalar (reaper'ın "stalled" saati). Zaten Processing'de
        // olan asset'te (Hangfire yeniden teslimi / disk-wait retry'ı) saat YENİDEN damgalanır
        // ki reaper'ın 30 dk penceresi bu koşuyla baştan başlasın.
        if (asset.Status is AssetStatus.Uploaded or AssetStatus.Failed)
        {
            asset.TransitionTo(AssetStatus.Processing, now);
        }
        else if (asset.Status == AssetStatus.Processing)
        {
            asset.ProcessingStartedAt = now;
        }

        await db.SaveChangesAsync(ct);

        // Temp dizini jobId+Guid: aynı işin (yarışan) iki koşusu asla aynı dizini paylaşmaz.
        var tempDir = Path.Combine(
            Path.GetTempPath(), "videoedit-worker", $"{job.Id:N}-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(tempDir);

            // ── 1) Disk kontrolü (süre biliniyorsa süre-farkındalı tahmin); yetersizse ERTELE.
            if (!await EnsureDiskSpaceAsync(job, asset, tempDir, asset.DurationMicros, ct))
            {
                return;
            }

            var progress = new JobProgressWriter(db, job, clock);

            // ── 2) Orijinali indir (stream) — %0-15.
            var originalPath = Path.Combine(tempDir, "original" + Path.GetExtension(asset.StorageKey));
            try
            {
                await DownloadOriginalAsync(asset.StorageKey, originalPath, progress, ct);
            }
            catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.NotFound)
            {
                // Orijinal storage'da yok — retry çözmez (deterministik durum bozukluğu).
                await FailDeterministicAsync(job, asset, "original-missing",
                    $"original object '{asset.StorageKey}' not found in storage.");
                return;
            }
            catch (AmazonS3Exception ex) when (IsDeterministicS3Error(ex))
            {
                // 403/400 (EntityTooLarge dahil) deterministiktir — aynı istek aynı yanıtı
                // üretir; Hangfire retry'ı YAKILMAZ.
                await FailDeterministicAsync(job, asset, "storage-denied",
                    $"storage rejected the download ({(int)ex.StatusCode} {ex.ErrorCode}): {ex.Message}");
                return;
            }

            // ── 3) ffprobe gate — %15-20. Parse edilemeyen → Failed('unsupported-media'), RETRY YOK.
            await progress.ReportAsync(15, "probe", ct);
            MediaProbe probe;
            try
            {
                probe = await ffprobe.ProbeAsync(originalPath, ct);
            }
            catch (UnsupportedMediaException ex)
            {
                await FailDeterministicAsync(job, asset, "unsupported-media", ex.Message, ex.StderrTail);
                return;
            }

            if (!GateByKind(asset.Kind, probe, out var gateReason, out var gateError))
            {
                await FailDeterministicAsync(job, asset, gateReason, gateError);
                return;
            }

            // Süre gate'i: limit üstü kaynak transcode'a HİÇ girmez (saatlerce ffmpeg yakılmaz).
            if (probe.DurationUs is { } probedUs && probedUs > processing.MaxDurationUs)
            {
                await FailDeterministicAsync(job, asset, "too-long",
                    $"media duration {probedUs} us exceeds the configured maximum "
                    + $"{processing.MaxDurationUs} us.");
                return;
            }

            // ── 4) Asset metadata (rotation uygulanmış boyutlar, rational fps, ham probe jsonb).
            asset.DurationMicros = probe.DurationUs;
            asset.HasAudio = probe.HasAudio;
            if (probe.HasVideo)
            {
                asset.Width = probe.Width;
                asset.Height = probe.Height;
                asset.FpsNum = probe.FpsNum > 0 ? probe.FpsNum : null;
                asset.FpsDen = probe.FpsDen > 0 ? probe.FpsDen : null;
            }

            asset.Probe = JsonDocument.Parse(probe.RawJson);
            await progress.ReportAsync(20, "probe", ct);

            // Süre artık kesin — disk rezervasyonunu süre-farkındalı tahminle yeniden doğrula
            // (uzun/düşük-bitrate kaynakta 3× kaba tahmin proxy'yi KÜÇÜMSEYEBİLİYORDU).
            if (!await EnsureDiskSpaceAsync(job, asset, tempDir, probe.DurationUs, ct))
            {
                return;
            }

            // ── 5) Kind'e göre türevler + upload. Deterministik ffmpeg hatası içeriden
            //      FfmpegFailedException olarak gelir.
            try
            {
                switch (asset.Kind)
                {
                    case AssetKind.Video:
                        await ProcessVideoAsync(asset, probe, originalPath, tempDir, progress, ct);
                        break;
                    case AssetKind.Audio:
                        await ProcessAudioAsync(asset, probe, originalPath, tempDir, progress, ct);
                        break;
                    case AssetKind.Image:
                        await ProcessImageAsync(asset, probe, originalPath, tempDir, progress, ct);
                        break;
                    default:
                        await FailDeterministicAsync(job, asset, "unsupported-media",
                            $"unknown asset kind {asset.Kind}.");
                        return;
                }
            }
            catch (FfmpegFailedException ex)
            {
                await FailDeterministicAsync(job, asset, ex.TimedOut ? "ffmpeg-timeout" : "ffmpeg-failed",
                    ex.Message, ex.StderrTail);
                return;
            }
            catch (AmazonS3Exception ex) when (IsDeterministicS3Error(ex))
            {
                // Türev upload'ında 403/400 (EntityTooLarge dahil) — retry çözmez.
                await FailDeterministicAsync(job, asset, "storage-denied",
                    $"storage rejected a derivative upload ({(int)ex.StatusCode} {ex.ErrorCode}): {ex.Message}");
                return;
            }

            // ── 6) Ready + Succeeded.
            var doneAt = clock.GetUtcNow();

            // Son savunma (reaper yarışı): uzun bir koşu sırasında reaper asset'i DB'de
            // Failed('stalled') yapmış olabilir — tracked entity bunu görmez. Domain kuralı
            // Failed → Processing → Ready iki-adım kurtarmaya izin verir; DB'deki 'stalled'
            // kalıntısının silinmesi için FailureReason yazımı açıkça zorlanır.
            var dbStatus = await db.Assets.AsNoTracking()
                .Where(a => a.Id == asset.Id)
                .Select(a => a.Status)
                .SingleAsync(ct);
            if (dbStatus == AssetStatus.Failed && asset.Status == AssetStatus.Processing)
            {
                logger.LogWarning(
                    "ProcessAssetJob {JobId}: asset {AssetId} was swept Failed('stalled') by the reaper "
                    + "while this run was still alive; recovering via Failed -> Processing -> Ready.",
                    jobId, asset.Id);
                db.Entry(asset).Property(a => a.Status).OriginalValue = AssetStatus.Failed;
                asset.Status = AssetStatus.Failed;
                asset.TransitionTo(AssetStatus.Processing, doneAt); // FailureReason=null
                db.Entry(asset).Property(a => a.FailureReason).IsModified = true;
            }

            asset.TransitionTo(AssetStatus.Ready, doneAt);
            job.Status = JobStatus.Succeeded;
            job.ProgressPercent = 100;
            job.ProgressStage = "done";
            job.CompletedAt = doneAt;
            await db.SaveChangesAsync(ct);

            logger.LogInformation(
                "ProcessAssetJob {JobId}: asset {AssetId} ready (kind={Kind}, duration={DurationUs}us).",
                jobId, asset.Id, asset.Kind, asset.DurationMicros);
        }
        catch (OperationCanceledException)
        {
            throw; // Hangfire shutdown/cancel — iş yeniden kuyruklanır.
        }
        catch (Exception ex)
        {
            // Ağ/S3/IO ve diğer transient hatalar: Hangfire AutomaticRetry(2) devralır.
            logger.LogError(ex,
                "ProcessAssetJob {JobId}: transient failure (attempt {Attempt}); rethrowing for Hangfire retry.",
                jobId, job.AttemptCount);
            throw;
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    // ───────────────────────── Kind pipeline'ları ─────────────────────────

    private async Task ProcessVideoAsync(
        Asset asset, MediaProbe probe, string originalPath, string tempDir,
        JobProgressWriter progress, CancellationToken ct)
    {
        var keys = new DerivedKeys(asset.OwnerId, asset.Id);
        var durationUs = probe.DurationUs!.Value; // gate garantiler

        // Proxy — %20-70, ffmpeg -progress'ten orantılı.
        var proxyPath = Path.Combine(tempDir, "540p.mp4");
        await RunFfmpegStepAsync(
            "proxy",
            ProxyRecipe.BuildVideoArgs(probe, originalPath, proxyPath),
            durationUs,
            (fraction, c) => progress.ReportAsync(20 + (int)(fraction * 50), "proxy", c),
            ct);
        await progress.ReportAsync(70, "filmstrip", ct);

        // Filmstrip — %70-85.
        var spritePattern = Path.Combine(tempDir, "sprite_%d.jpg");
        await RunFfmpegStepAsync(
            "filmstrip",
            FilmstripRecipe.BuildArgs(probe, durationUs, originalPath, spritePattern),
            durationUs,
            (fraction, c) => progress.ReportAsync(70 + (int)(fraction * 15), "filmstrip", c),
            ct);

        var spriteFiles = Directory.GetFiles(tempDir, "sprite_*.jpg")
            .OrderBy(SpriteIndex)
            .ToList();
        if (spriteFiles.Count == 0)
        {
            throw new FfmpegFailedException("filmstrip produced no sprite files.", exitCode: 0, stderrTail: "");
        }

        var manifest = FilmstripRecipe.BuildManifest(
            probe, durationUs, spriteFiles.Select(Path.GetFileName).Cast<string>().ToList());
        var manifestPath = Path.Combine(tempDir, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, FilmstripRecipe.SerializeManifest(manifest), ct);
        await progress.ReportAsync(85, probe.HasAudio ? "waveform" : "upload", ct);

        // Waveform — %85-92 (yalnız sesli kaynakta).
        string? waveformPath = null;
        if (probe.HasAudio)
        {
            waveformPath = Path.Combine(tempDir, "peaks.json");
            await waveformGenerator.GenerateAsync(originalPath, waveformPath, ct);
            await progress.ReportAsync(92, "upload", ct);
        }

        // Poster + upload — %92-100.
        var posterPath = Path.Combine(tempDir, "poster.jpg");
        await RunFfmpegStepAsync(
            "poster", PosterRecipe.BuildVideoArgs(probe, originalPath, posterPath), null, null, ct);

        await storage.UploadFileAsync(keys.Proxy, proxyPath, "video/mp4", ct);
        foreach (var sprite in spriteFiles)
        {
            await storage.UploadFileAsync(
                keys.FilmstripSprite(Path.GetFileName(sprite)), sprite, "image/jpeg", ct);
        }

        await storage.UploadFileAsync(keys.FilmstripManifest, manifestPath, "application/json", ct);
        if (waveformPath is not null)
        {
            await storage.UploadFileAsync(keys.Waveform, waveformPath, "application/json", ct);
        }

        await storage.UploadFileAsync(keys.Poster, posterPath, "image/jpeg", ct);

        asset.ProxyKey = keys.Proxy;
        asset.FilmstripKey = keys.FilmstripManifest;
        asset.WaveformKey = waveformPath is not null ? keys.Waveform : null;
        asset.ThumbnailKey = keys.Poster;
    }

    private async Task ProcessAudioAsync(
        Asset asset, MediaProbe probe, string originalPath, string tempDir,
        JobProgressWriter progress, CancellationToken ct)
    {
        var keys = new DerivedKeys(asset.OwnerId, asset.Id);

        // AAC proxy — %20-70.
        var proxyPath = Path.Combine(tempDir, "audio.m4a");
        await RunFfmpegStepAsync(
            "proxy",
            ProxyRecipe.BuildAudioArgs(originalPath, proxyPath),
            probe.DurationUs,
            (fraction, c) => progress.ReportAsync(20 + (int)(fraction * 50), "proxy", c),
            ct);
        await progress.ReportAsync(70, "waveform", ct);

        // Waveform — %70-92.
        var waveformPath = Path.Combine(tempDir, "peaks.json");
        await waveformGenerator.GenerateAsync(originalPath, waveformPath, ct);
        await progress.ReportAsync(92, "upload", ct);

        await storage.UploadFileAsync(keys.AudioProxy, proxyPath, "audio/mp4", ct);
        await storage.UploadFileAsync(keys.Waveform, waveformPath, "application/json", ct);

        asset.ProxyKey = keys.AudioProxy;
        asset.WaveformKey = keys.Waveform;
    }

    private async Task ProcessImageAsync(
        Asset asset, MediaProbe probe, string originalPath, string tempDir,
        JobProgressWriter progress, CancellationToken ct)
    {
        var keys = new DerivedKeys(asset.OwnerId, asset.Id);

        // Poster/thumb — %20-80. Image için proxy ÜRETİLMEZ.
        var posterPath = Path.Combine(tempDir, "poster.jpg");
        await RunFfmpegStepAsync(
            "poster", PosterRecipe.BuildImageArgs(probe, originalPath, posterPath), null, null, ct);
        await progress.ReportAsync(80, "upload", ct);

        await storage.UploadFileAsync(keys.Poster, posterPath, "image/jpeg", ct);
        asset.ThumbnailKey = keys.Poster;
    }

    // ───────────────────────── Yardımcılar ─────────────────────────

    private async Task DownloadOriginalAsync(
        string key, string destinationPath, JobProgressWriter progress, CancellationToken ct)
    {
        await progress.ReportAsync(0, "download", ct);
        // İndirme deseni ORTAK yardımcıda (OriginalDownloader) — ExportJob'un LRU cache'i de
        // aynı yolu kullanır (.part + atomik rename).
        await OriginalDownloader.DownloadToFileAsync(storage, key, destinationPath,
            async (total, length, c) =>
            {
                if (length > 0)
                {
                    var percent = (int)(15 * Math.Min(total, length) / length);
                    await progress.ReportAsync(percent, "download", c);
                }
            }, ct);
    }

    /// <summary>Sıfır-dışı exit / watchdog kill → FfmpegFailedException (deterministik).</summary>
    private async Task RunFfmpegStepAsync(
        string step,
        IReadOnlyList<string> args,
        long? totalDurationUs,
        Func<double, CancellationToken, Task>? onProgress,
        CancellationToken ct)
    {
        var result = await ffmpeg.RunAsync(args, totalDurationUs, onProgress, ct: ct);
        if (!result.Success)
        {
            throw new FfmpegFailedException(
                result.TimedOut
                    ? $"{step}: ffmpeg made no progress within the watchdog timeout."
                    : $"{step}: ffmpeg exited with code {result.ExitCode}.",
                result.ExitCode, result.StderrTail, result.TimedOut);
        }
    }

    /// <summary>
    /// Image beyanlı asset'in "aslında video" sayıldığı süre eşiği: gerçek still image'lerin
    /// probe süresi yoktur ya da tek-kare (~0.04 sn) düzeyindedir.
    /// </summary>
    public const long ImageMaxDurationUs = 1_000_000;

    /// <summary>
    /// Kind ↔ probe tutarlılık gate'i (public: birim testleri process'siz doğrular).
    /// reason: 'unsupported-media' (eksik stream) ya da 'kind-mismatch' (image beyanlı ama
    /// gerçek video/ses taşıyan dosya — proxy'siz Ready olup player'da kırılmasın).
    /// </summary>
    public static bool GateByKind(AssetKind kind, MediaProbe probe, out string reason, out string error)
    {
        reason = "unsupported-media";
        error = "";
        switch (kind)
        {
            case AssetKind.Video when !probe.HasVideo:
                error = "asset kind is Video but the file has no video stream.";
                return false;
            case AssetKind.Video when probe.DurationUs is null or 0:
                error = "video file reports no duration.";
                return false;
            case AssetKind.Audio when !probe.HasAudio:
                error = "asset kind is Audio but the file has no audio stream.";
                return false;
            case AssetKind.Image when !probe.HasVideo:
                error = "asset kind is Image but the file has no decodable image stream.";
                return false;
            case AssetKind.Image when probe.HasAudio || probe.DurationUs > ImageMaxDurationUs:
                reason = "kind-mismatch";
                error = "asset kind is Image but the file is a real video/audio container "
                    + $"(duration {probe.DurationUs?.ToString(CultureInfo.InvariantCulture) ?? "unknown"} us, "
                    + $"hasAudio={probe.HasAudio}).";
                return false;
            default:
                return true;
        }
    }

    /// <summary>
    /// S3 4xx sınıflandırması: 403 ve 400 (EntityTooLarge dahil) DETERMİNİSTİKTİR — aynı
    /// istek aynı yanıtı üretir, Hangfire retry'ı yakılmaz. İstisnalar: RequestTimeout
    /// (HTTP 400 döner ama transient'tır) ve token bayatlaması (yenilenebilir).
    /// 404 çağıran tarafta ayrıca ele alınır (original-missing).
    /// </summary>
    public static bool IsDeterministicS3Error(AmazonS3Exception ex) =>
        ex.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.BadRequest
        && ex.ErrorCode is not ("RequestTimeout" or "ExpiredToken" or "TokenRefreshRequired");

    /// <summary>
    /// Gerekli boş alan tahmini. Süre biliniyorsa: orijinal (indirme) + süre×~3 Mbps proxy
    /// + %20 pay (filmstrip/waveform/poster küçükleri). Bilinmiyorsa kaba 3× dosya boyutu
    /// (probe sonrası süreyle yeniden doğrulanır — uzun düşük-bitrate kaynakta 3× az kalabilir).
    /// </summary>
    public static long EstimateRequiredDiskBytes(long sizeBytes, long? durationUs)
    {
        if (durationUs is not > 0)
        {
            return sizeBytes * RequiredDiskMultiplier;
        }

        var proxyBytes = (long)(durationUs.Value / 1_000_000m * AssumedProxyBitsPerSecond / 8);
        return sizeBytes + (proxyBytes * 12 / 10);
    }

    /// <summary>
    /// Disk rezervasyonu: yeterse true. Yetersizse işi 2 dk sonraya yeniden kuyruklar
    /// (3. denemede Failed('disk-full')) ve false döner — çağıran hemen dönmelidir.
    /// </summary>
    private async Task<bool> EnsureDiskSpaceAsync(
        Job job, Asset asset, string tempDir, long? durationUs, CancellationToken ct)
    {
        var freeBytes = TryGetAvailableFreeSpace(tempDir);
        var requiredBytes = EstimateRequiredDiskBytes(asset.SizeBytes, durationUs);
        if (freeBytes < 0 || freeBytes >= requiredBytes)
        {
            return true;
        }

        if (job.AttemptCount >= MaxDiskFullAttempts)
        {
            await FailDeterministicAsync(job, asset, "disk-full",
                $"insufficient disk space after {job.AttemptCount} attempts "
                + $"(need {requiredBytes} bytes, free {freeBytes}).");
            return false;
        }

        job.Status = JobStatus.Queued;
        job.ProgressStage = "disk-wait";
        await db.SaveChangesAsync(ct);
        backgroundJobs.Schedule<IProcessAssetJob>(
            j => j.Run(job.Id, CancellationToken.None), DiskFullRetryDelay);
        logger.LogWarning(
            "ProcessAssetJob {JobId}: insufficient disk (need {Required}, free {Free}); "
            + "re-queued attempt {Attempt}/{Max} in {Delay}.",
            job.Id, requiredBytes, freeBytes, job.AttemptCount, MaxDiskFullAttempts, DiskFullRetryDelay);
        return false;
    }

    /// <summary>
    /// Deterministik hata: asset Failed(reason) + job Failed; EXCEPTION FIRLATILMAZ —
    /// Hangfire retry'ı bilerek tetiklenmez (aynı girdi aynı hatayı üretir).
    /// </summary>
    private async Task FailDeterministicAsync(
        Job job, Asset asset, string reason, string detail, string? stderrTail = null)
    {
        var now = clock.GetUtcNow();
        if (asset.Status == AssetStatus.Processing)
        {
            asset.Fail(reason, now);
        }

        var message = string.IsNullOrWhiteSpace(stderrTail) ? $"{reason}: {detail}"
            : $"{reason}: {detail}\n--- ffmpeg stderr tail ---\n{stderrTail}";
        job.Status = JobStatus.Failed;
        job.ErrorMessage = message.Length > 4000 ? message[..4000] : message;
        job.CompletedAt = now;
        await db.SaveChangesAsync(CancellationToken.None);

        logger.LogWarning(
            "ProcessAssetJob {JobId}: asset {AssetId} failed deterministically ({Reason}): {Detail}",
            job.Id, asset.Id, reason, detail);
    }

    private static long TryGetAvailableFreeSpace(string path)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(path));
            return string.IsNullOrEmpty(root) ? -1 : new DriveInfo(root).AvailableFreeSpace;
        }
        catch (Exception)
        {
            return -1; // ölçülemiyorsa kontrolü atla — işleme disk hatasında zaten patlar
        }
    }

    private static int SpriteIndex(string path)
    {
        var name = Path.GetFileNameWithoutExtension(path); // sprite_12
        var underscore = name.LastIndexOf('_');
        return underscore >= 0
               && int.TryParse(name[(underscore + 1)..], NumberStyles.Integer,
                   CultureInfo.InvariantCulture, out var index)
            ? index
            : int.MaxValue;
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception)
        {
            // Temp temizliği best-effort — kilitli dosya varsa sonraki koşular/OS temizler.
        }
    }

    /// <summary>Türev key düzeni (tasarım 02 §2): u/{owner}/a/{asset}/...</summary>
    private readonly struct DerivedKeys(Guid ownerId, Guid assetId)
    {
        private readonly string _base = $"u/{ownerId}/a/{assetId}";

        public string Proxy => $"{_base}/proxy/540p.mp4";
        public string AudioProxy => $"{_base}/proxy/audio.m4a";
        public string FilmstripManifest => $"{_base}/filmstrip/manifest.json";
        public string Waveform => $"{_base}/waveform/peaks.json";
        public string Poster => $"{_base}/thumb/poster.jpg";
        public string FilmstripSprite(string fileName) => $"{_base}/filmstrip/{fileName}";
    }

}
