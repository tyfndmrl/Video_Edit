using System.Net;
using System.Text.Json;
using Amazon.S3;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Jobs;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media;
using VideoEdit.Media.Export;
using VideoEdit.Media.Probing;
using VideoEdit.Media.Text;

namespace VideoEdit.Worker.Jobs;

/// <summary>
/// M3 export hattı ('export' kuyruğu, eşzamanlılık 1): Job.TimelineSnapshot → FilterGraph
/// Compiler → orijinaller LRU cache'e (OriginalDownloader ile — ProcessAssetJob ile ortak
/// desen) → disk rezervasyonu → graph.txt (job artefaktı, loglanır) → ffmpeg (FfmpegRunner)
/// → çıktı ffprobe doğrulaması → ExportsBucket'a yükle → Succeeded + OutputKey.
///
/// Hata sınıflandırması ProcessAssetJob ile AYNIDIR:
///  - deterministik (derleme/ffmpeg/probe/S3-4xx) → job Failed, retry YOK (normal dönüş);
///  - transient (ağ/S3-5xx/IO) → exception fırlar, AutomaticRetry(2) + JobFailureStateFilter;
///  - disk yetersiz → 2 dk sonraya yeniden kuyruk, 3. denemede Failed('disk-full').
///
/// Cancel: API Job.Status=Canceled yazar + Hangfire işini siler. Koşan iş bunu (a) Hangfire
/// cancellation token'ından, (b) progress sırasındaki DB yoklamasından görür; ffmpeg süreç
/// ağacı öldürülür ve iş sessizce döner (satır Canceled kalır).
///
/// Progress bantları: indirme %0-15, derleme %15, render %15-90 (ffmpeg out_time_us'ten),
/// doğrulama+upload %90-100.
///
/// Overlay hazırlığı (tasarım 04 §4.2 adım 3): metin/şekil klipleri için PNG'ler derlemeden
/// ÖNCE job temp dizinine üretilir (asset DEĞİL, iş artefaktı — her export'ta deterministik
/// olarak yeniden üretilir ve iş bitince temp ile birlikte silinir).
/// </summary>
public sealed class ExportJob(
    AppDbContext db,
    IStorageService storage,
    FfprobeService ffprobe,
    FfmpegRunner ffmpeg,
    OriginalCache cache,
    IBackgroundJobClient backgroundJobs,
    ILogger<ExportJob> logger,
    TimeProvider clock,
    RunningRenderRegistry renders,
    ITextRasterService? textRaster = null) : IExportJob
{
    /// <summary>Disk yetersizse en fazla bu kadar denemede Failed('disk-full').</summary>
    public const int MaxDiskFullAttempts = 3;

    public static readonly TimeSpan DiskFullRetryDelay = TimeSpan.FromMinutes(2);

    /// <summary>Çıktı süresi doğrulama toleransı (görev sözleşmesi: beklenen ±1 sn).</summary>
    public const long OutputDurationToleranceUs = 1_000_000;

    /// <summary>Render sırasında DB'den cancel bayrağı yoklama aralığı.</summary>
    public static readonly TimeSpan CancelPollInterval = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Testler için boş alan ölçümü kancası (yol → bayt; -1 = ölçülemedi). Prod'da null —
    /// DriveInfo kullanılır. Disk-yetersiz yolunun (trim + erteleme) birim testi bunsuz kurulamaz.
    /// </summary>
    internal Func<string, long>? FreeSpaceProbe { get; set; }

    public async Task Run(Guid jobId, CancellationToken ct)
    {
        var job = await db.Jobs.SingleOrDefaultAsync(
            j => j.Id == jobId && j.Type == JobType.Export, ct);
        if (job is null)
        {
            logger.LogWarning("ExportJob: export job row {JobId} not found; skipping.", jobId);
            return;
        }

        // Çift teslim / geç teslim kısa devreleri.
        if (job.Status == JobStatus.Succeeded)
        {
            logger.LogInformation("ExportJob {JobId}: already succeeded; duplicate delivery short-circuited.", jobId);
            return;
        }

        if (job.Status == JobStatus.Canceled)
        {
            logger.LogInformation("ExportJob {JobId}: canceled before it started; skipping.", jobId);
            return;
        }

        var now = clock.GetUtcNow();
        job.Status = JobStatus.Running;
        job.StartedAt ??= now;
        job.LastProgressAt = now; // heartbeat: reaper "canlı iş" kanıtı
        job.AttemptCount += 1;
        await db.SaveChangesAsync(ct);

        if (job.ProjectId is null || job.TimelineSnapshot is null)
        {
            await FailAsync(job, "invalid-timeline", "export job has no project id or timeline snapshot.");
            return;
        }

        if (!ExportProfiles.TryParse(job.ExportProfile ?? "1080p", out var profile))
        {
            await FailAsync(job, "invalid-profile", $"unknown export profile '{job.ExportProfile}'.");
            return;
        }

        // ── 1) Snapshot → DTO → doğrulama (deterministik hatalar retry'sız Failed).
        TimelineDoc doc;
        try
        {
            doc = job.TimelineSnapshot.RootElement.Deserialize<TimelineDoc>(TimelineJson.Options)
                ?? throw new JsonException("timeline snapshot deserialized to null.");
        }
        catch (JsonException ex)
        {
            await FailAsync(job, "invalid-timeline", $"timeline snapshot could not be parsed: {ex.Message}");
            return;
        }

        ExportPlan plan;
        try
        {
            plan = ExportCompiler.Validate(doc);
        }
        catch (UnsupportedFeatureException ex)
        {
            await FailAsync(job, $"unsupported-feature:{ex.Feature}", ex.Message);
            return;
        }
        catch (InvalidTimelineException ex)
        {
            await FailAsync(job, "invalid-timeline", ex.Message);
            return;
        }

        // ── 2) Asset satırları: hepsi mevcut, sahibi iş sahibi ve Ready olmalı.
        // MEDYA defteri (plan.AssetIds) ile LUT defteri (plan.LutAssetIds) AYRIDIR: ikisi de
        // indirilir ve AYNI sources sözlüğüne girer, ama .cube bir medya dosyası değildir →
        // ffprobe'a SOKULMAZ ve kaynak-aralığı kapısına GİRMEZ (ExportPlan.LutAssetIds yorumu).
        // Satır/sahiplik/Ready doğrulaması ikisi için de aynıdır.
        var mediaIds = plan.AssetIds.ToList();
        var lutIds = plan.LutAssetIds.Where(id => !mediaIds.Contains(id)).ToList();
        var wantedIds = mediaIds.Concat(lutIds).ToList();
        var assets = await db.Assets.AsNoTracking()
            .Where(a => wantedIds.Contains(a.Id) && a.DeletedAt == null)
            .ToListAsync(ct);
        var visible = assets.Where(a => a.OwnerId == job.RequestedBy).ToList();
        var missing = wantedIds.Except(visible.Select(a => a.Id)).ToList();
        if (missing.Count > 0)
        {
            await FailAsync(job, "asset-missing",
                $"timeline references missing/deleted asset(s): {string.Join(", ", missing)}.");
            return;
        }

        var notReady = visible.Where(a => a.Status != AssetStatus.Ready).ToList();
        if (notReady.Count > 0)
        {
            await FailAsync(job, "asset-not-ready",
                "timeline references asset(s) that are not ready: "
                + string.Join(", ", notReady.Select(a => $"{a.Id} ({a.Status})")) + ".");
            return;
        }

        var lutAssetIds = lutIds.ToHashSet();

        // Temp dizini jobId+Guid: yarışan iki koşu asla aynı dizini paylaşmaz (ProcessAssetJob deseni).
        var tempDir = Path.Combine(
            Path.GetTempPath(), "videoedit-worker", $"{job.Id:N}-{Guid.NewGuid():N}");
        using var pin = cache.Pin(wantedIds);
        try
        {
            Directory.CreateDirectory(tempDir);

            // ── 3) Disk rezervasyonu: Σkaynak + süre×max(profil, ölçülmüş kaynak bitrate)
            // tahmini + %20 pay (ölçüldü: sabit 10 Mbps varsayımı grenli kaynakta kısa kalıyordu).
            var totalSourceBytes = visible.Sum(a => a.SizeBytes);
            if (!await EnsureDiskSpaceAsync(
                    job, tempDir, totalSourceBytes, plan.TotalDurationUs, profile, visible, ct))
            {
                return;
            }

            var progress = new JobProgressWriter(db, job, clock);
            using var cancelCts = CancellationTokenSource.CreateLinkedTokenSource(ct);

            // Reaper'ın ULAŞABİLECEĞİ iptal kancası. Kayıt indirmeden ÖNCE açılır (render'ın
            // hemen öncesinden değil): asılma yalnız ffmpeg'de olmaz, uzun bir indirme de
            // iş satırını 'stalled' eşiğine taşıyabilir ve o hâlde de süreci bırakmamalıyız.
            using var renderRegistration = renders.Register(job.Id, cancelCts);

            // ── 4) Orijinalleri LRU cache'e indir + indirilen dosyayı probe et — %0-15.
            await progress.ReportAsync(0, "download", ct);
            var sources = new Dictionary<Guid, ExportAssetSource>(visible.Count);
            long doneBytes = 0;
            foreach (var asset in visible)
            {
                if (await CancelRequestedAsync(job.Id))
                {
                    await MarkCanceledAsync(job.Id);
                    return;
                }

                var baseBytes = doneBytes;
                string path;
                try
                {
                    path = await cache.GetOrDownloadAsync(asset.Id, asset.StorageKey,
                        async (got, _, c) =>
                        {
                            var pct = totalSourceBytes > 0
                                ? (int)(15 * Math.Min(baseBytes + got, totalSourceBytes) / totalSourceBytes)
                                : 15;
                            await progress.ReportAsync(pct, "download", c);
                        }, cancelCts.Token);
                }
                catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.NotFound)
                {
                    await FailAsync(job, "original-missing",
                        $"original object '{asset.StorageKey}' not found in storage.");
                    return;
                }
                catch (AmazonS3Exception ex) when (ProcessAssetJob.IsDeterministicS3Error(ex))
                {
                    await FailAsync(job, "storage-denied",
                        $"storage rejected the download ({(int)ex.StatusCode} {ex.ErrorCode}): {ex.Message}");
                    return;
                }

                doneBytes += asset.SizeBytes;

                // LUT (.cube): metin tabanlı bir tablo dosyası. Probe edilmez (ffprobe'da
                // "no video stream" ile TÜM export'u düşürürdü), kaynak-aralığı kapısına da
                // girmez — yalnız YOL olarak sources'a konur, compiler lut3d=file= ile kullanır.
                if (lutAssetIds.Contains(asset.Id))
                {
                    sources[asset.Id] = new ExportAssetSource(path, false, null, null);
                    continue;
                }

                MediaProbe probe;
                try
                {
                    probe = await ffprobe.ProbeAsync(path, cancelCts.Token);
                }
                catch (UnsupportedMediaException ex)
                {
                    await FailAsync(job, "unsupported-media",
                        $"source of asset {asset.Id} could not be probed: {ex.Message}", ex.StderrTail);
                    return;
                }

                // AKIŞ KAPISI, KLİP TÜRÜNE GÖRE. Eskiden burada koşulsuz bir "video stream'i
                // olmalı" şartı vardı ve MÜZİK EKLEMEK EXPORT'U İMKÂNSIZ KILIYORDU: kitaplığa
                // yüklenen bir .m4a, ses track'ine konup dışa aktarıldığında iş
                // 'unsupported-media: ... has no video stream' ile ölüyordu (ölçülen denetim bulgusu).
                // Doğru soru dosyanın ne İÇERDİĞİ değil, o dosyayı okuyan KLİBİN ne İSTEDİĞİdir;
                // defter (plan.AssetUses) tam olarak bunu taşır ve senkron kapı
                // ('asset-clip-type') AYNI defteri DB olgularıyla sorar.
                if (ExportCompiler.FindStreamMismatch(
                        plan, asset.Id, probe.HasVideo, probe.HasAudio, probe.DurationUs)
                    is { } mismatch)
                {
                    // Mesaj kullanıcıya gider (Job.ErrorMessage → dışa aktarma paneli), o yüzden
                    // derleyicinin 422 metinleriyle aynı dildedir.
                    await FailAsync(job, "unsupported-media",
                        $"'{mismatch.Use.ClipId}' {mismatch.Use.ClipKindTr} klibinin gösterdiği "
                        + $"dosya ({asset.Id}) bu klip için uygun değil: {mismatch.Missing}.");
                    return;
                }

                // Gate: klip sourceOut kaynak süresini aşamaz (+1 çıktı frame'i toleransı).
                // Aşan klip ffmpeg'de sessiz kısa segment / donmuş kare üretir — deterministik
                // hata olarak erkenden yakalanır (retry anlamsız).
                if (FindSourceOutOfRange(plan.Clips, asset.Id, probe.DurationUs,
                        plan.FpsNum, plan.FpsDen) is { } outOfRange)
                {
                    await FailAsync(job, "source-out-of-range",
                        $"clip '{outOfRange.Id}' reads source range up to {outOfRange.SourceOutUs} us "
                        + $"but asset {asset.Id} is only {probe.DurationUs} us long "
                        + "(tolerance: one output frame).");
                    return;
                }

                // Boyutlar TABAN (dejenerelik) kapısı içindir (ExportCompiler.EnsureLayerFloor) —
                // filtergraph'a girmezler, geometri kaynaktan bağımsız kalır. probe.Width/Height
                // ROTATION UYGULANMIŞ değerlerdir, yani ffmpeg'in decode'da göreceği iw/ih ile
                // eşleşir (MediaProbe sözleşmesi); DB'deki kolonlar da aynı yerden yazılır.
                sources[asset.Id] = new ExportAssetSource(
                    path, probe.HasAudio, probe.ColorTransfer, probe.ColorPrimaries,
                    probe.Width, probe.Height);
            }

            // ── 5a) Overlay hazırlığı: metin/şekil PNG'leri (tasarım 04 §4.2 adım 3). — %15
            // Gizli track'lerin klipleri ATLANIR (ExportCompiler'ın atıl-klip kuralıyla aynı):
            // görünmeyen bir metnin eksik fontu TÜM export'u düşürmemeli.
            await progress.ReportAsync(15, "overlays", ct);
            OverlayRasterSet overlays;
            try
            {
                overlays = textRaster is null
                    ? OverlayRasterSet.Empty
                    : await OverlayRasterPlanner.RenderAllAsync(doc, textRaster, tempDir, cancelCts.Token);
            }
            catch (OverlayRasterException ex)
            {
                // Deterministik kurulum/içerik hatası (eksik font, geçersiz renk, aşırı büyük
                // raster): retry aynı sonucu verir → doğrudan Failed.
                await FailAsync(job, ex.Code, ex.Message);
                return;
            }

            if (overlays.Count > 0)
            {
                logger.LogInformation(
                    "ExportJob {JobId}: {Count} overlay rasteri üretildi ({Bytes} bayt) → {Directory}",
                    job.Id, overlays.Count, overlays.TotalBytes, overlays.Directory);

                if (overlays.ClipsWithMissingGlyphs.Count > 0)
                {
                    // İş DÜŞMEZ: eksik glif .notdef kutusu olarak çizilir (emoji tipik durum),
                    // ama sessiz kalmaz — küratörlü sette emoji fontu yoktur (fonts/README.md).
                    logger.LogWarning(
                        "ExportJob {JobId}: {Count} metin klibinde fontta olmayan karakter var "
                        + "(.notdef kutusu çizildi): {ClipIds}",
                        job.Id, overlays.ClipsWithMissingGlyphs.Count,
                        string.Join(", ", overlays.ClipsWithMissingGlyphs));
                }
            }

            // Raster hattı yoksa (servis DI'a kayıtlı değil) ama doküman metin/şekil klibi
            // İÇERİYORSA, Compile "no raster provided" ile ArgumentException atardı ve iş
            // transient sayılıp 3 kez retry edilirdi. Deterministik kurulum hatası olarak
            // burada kapatılır.
            if (textRaster is null && plan.RasterClips.Count > 0)
            {
                await FailAsync(job, "overlay-raster-unavailable",
                    "Timeline metin/şekil klibi içeriyor ama overlay raster hattı (ITextRasterService) "
                    + "bu worker'da kayıtlı değil. Font kurulumunu tamamlayıp worker'ı yeniden başlatın.");
                return;
            }

            // ── 5b) Derleme + graph.txt (job artefaktı — tam script loglanır). — %15
            // Overlay defteri compiler'a raster KAYNAK defteri olarak geçer: yol + rasterin
            // PROJE PİKSELİNDEKİ doğal boyutu (bbox). Ölçek kutusu bunun transform.scale
            // katıdır — yerleşim kuralı OverlayRasterPlacement'ta normatiftir
            // (fit = 1/rasterScale, rendering-semantics §7 @2x); compiler tarafındaki
            // karşılığı ExportRasterSource + LayerGeometry'nin fit parametresidir.
            var rasterSources = overlays.Rasters.ToDictionary(
                kv => kv.Key,
                kv => new ExportRasterSource(
                    kv.Value.Path, kv.Value.BboxWidthPx, kv.Value.BboxHeightPx,
                    // PNG'nin GERÇEK piksel boyutu (bbox × rasterScale) — bbox ile aynı şey
                    // DEĞİLDİR; dejenerelik kapısı ffmpeg'in göreceği boyutu ister.
                    kv.Value.Width, kv.Value.Height));

            await progress.ReportAsync(15, "compile", ct);
            CompiledExport compiled;
            try
            {
                compiled = ExportCompiler.Compile(doc, sources, profile, rasterSources);
            }
            catch (ExportCompileException ex)
            {
                var reason = ex is UnsupportedFeatureException unsupported
                    ? $"unsupported-feature:{unsupported.Feature}"
                    : "invalid-timeline";
                await FailAsync(job, reason, ex.Message);
                return;
            }

            var scriptPath = Path.Combine(tempDir, "graph.txt");
            await File.WriteAllTextAsync(scriptPath, compiled.FilterGraphScript, ct);
            logger.LogInformation(
                "ExportJob {JobId}: compiled filter graph ({InputCount} inputs, expected {DurationUs} us):\n{Script}",
                job.Id, compiled.Inputs.Count, compiled.ExpectedDurationUs, compiled.FilterGraphScript);

            // ── 6) Render — %15-90 (ffmpeg -progress out_time_us'ten orantılı) + cancel yoklaması.
            var outputPath = Path.Combine(tempDir, "out.mp4");
            var lastCancelCheckAt = clock.GetUtcNow();
            var result = await ffmpeg.RunAsync(
                compiled.ToFfmpegArgs(scriptPath, outputPath),
                compiled.ExpectedDurationUs,
                async (fraction, c) =>
                {
                    await progress.ReportAsync(15 + (int)(fraction * 75), "render", c);
                    if (clock.GetUtcNow() - lastCancelCheckAt >= CancelPollInterval)
                    {
                        lastCancelCheckAt = clock.GetUtcNow();
                        if (await CancelRequestedAsync(job.Id))
                        {
                            await cancelCts.CancelAsync(); // registration ffmpeg süreç ağacını öldürür
                        }
                    }
                },
                // İKİNCİ TAVAN (ilerleme tabanlı). Sessizlik bekçisi KAÇAK grafiği göremez:
                // kaçak süreç durmadan -progress bastığı için "sessiz" olmaz ve 120 sn hiç
                // dolmaz. Kuyruk WorkerCount = 1 olduğu için böyle TEK bir belge HERKESİN
                // export'unu süresiz kilitler; tavan o kilidi saniyeler içinde açar.
                outputTimeCeilingUs: FfmpegRunner.OutputTimeCeilingUs(compiled.ExpectedDurationUs),
                ct: cancelCts.Token);

            if (!result.Success)
            {
                // Deterministik ffmpeg hatası (bozuk kaynak/graph): retry aynı hatayı üretir.
                //
                // ÜÇ HAL ÜÇ AYRI CÜMLE KURAR. 'render-overrun' bir "çıkış kodu -1" DEĞİLDİR:
                // süreç kendi kendine ölmedi, BİZ öldürdük çünkü çıktı saati beklenen süreyi
                // aştı — yani grafik sonsuza kadar üretiyordu. Tek bir 'ffmpeg-failed' cümlesi
                // bu teşhisi kullanıcıdan da destek kaydından da saklardı.
                var (code, message) = result switch
                {
                    { Overran: true } => ("render-overrun",
                        "render: ffmpeg kept writing past the expected output duration "
                        + $"({compiled.ExpectedDurationUs} us; ceiling "
                        + $"{FfmpegRunner.OutputTimeCeilingUs(compiled.ExpectedDurationUs)} us) "
                        + "and was stopped."),
                    { TimedOut: true } => ("ffmpeg-timeout",
                        "render: ffmpeg made no progress within the watchdog timeout."),
                    _ => ("ffmpeg-failed", $"render: ffmpeg exited with code {result.ExitCode}."),
                };
                await FailAsync(job, code, message, result.StderrTail);
                return;
            }

            // ── 7) Çıktı doğrulaması: süre ≈ beklenen ±1 sn, video+audio stream mevcut. — %90
            await progress.ReportAsync(90, "probe", ct);
            MediaProbe outProbe;
            try
            {
                outProbe = await ffprobe.ProbeAsync(outputPath, cancelCts.Token);
            }
            catch (UnsupportedMediaException ex)
            {
                await FailAsync(job, "output-invalid",
                    $"rendered output could not be probed: {ex.Message}", ex.StderrTail);
                return;
            }

            if (!outProbe.HasVideo || !outProbe.HasAudio)
            {
                await FailAsync(job, "output-invalid",
                    $"rendered output is missing streams (video={outProbe.HasVideo}, audio={outProbe.HasAudio}).");
                return;
            }

            if (outProbe.DurationUs is not { } outDurationUs
                || Math.Abs(outDurationUs - compiled.ExpectedDurationUs) > OutputDurationToleranceUs)
            {
                await FailAsync(job, "output-invalid",
                    $"rendered duration {outProbe.DurationUs?.ToString() ?? "unknown"} us deviates from "
                    + $"expected {compiled.ExpectedDurationUs} us by more than {OutputDurationToleranceUs} us.");
                return;
            }

            // Renk tag gate'i (rendering-semantics §6.1): çıktı DAİMA açıkça BT.709 işaretli
            // olmalı. ffmpeg 7+ CLI tag'lerini filtergraph frame metadata'sıyla ezebildiği için
            // (setparams düzeltmesinin regresyon sigortası) çıktı ffprobe'dan doğrulanır.
            if (outProbe.ColorSpace != "bt709"
                || outProbe.ColorPrimaries != "bt709"
                || outProbe.ColorTransfer != "bt709")
            {
                await FailAsync(job, "output-invalid",
                    "rendered output color tags are not bt709 "
                    + $"(space={outProbe.ColorSpace ?? "none"}, primaries={outProbe.ColorPrimaries ?? "none"}, "
                    + $"transfer={outProbe.ColorTransfer ?? "none"}).");
                return;
            }

            // ── 8) ExportsBucket'a yükle — %90-100 (idempotent: aynı key üzerine yazılır).
            await progress.ReportAsync(92, "upload", ct);
            var outputKey = $"exports/{job.ProjectId:D}/{job.Id:D}.mp4";
            try
            {
                await storage.UploadExportAsync(outputKey, outputPath, "video/mp4", cancelCts.Token);
            }
            catch (AmazonS3Exception ex) when (ProcessAssetJob.IsDeterministicS3Error(ex))
            {
                await FailAsync(job, "storage-denied",
                    $"storage rejected the export upload ({(int)ex.StatusCode} {ex.ErrorCode}): {ex.Message}");
                return;
            }

            // ── 9) Succeeded + OutputKey.
            var doneAt = clock.GetUtcNow();
            job.Status = JobStatus.Succeeded;
            job.OutputKey = outputKey;
            job.ProgressPercent = 100;
            job.ProgressStage = "done";
            job.CompletedAt = doneAt;
            job.LastProgressAt = doneAt;
            await db.SaveChangesAsync(CancellationToken.None);

            logger.LogInformation(
                "ExportJob {JobId}: export completed ({DurationUs} us, key={OutputKey}).",
                job.Id, compiled.ExpectedDurationUs, outputKey);
        }
        catch (OperationCanceledException)
        {
            // Kullanıcı iptali (API satırı Canceled yaptı) ise sessizce biter; Hangfire
            // shutdown iptali ise yeniden fırlatılır (iş yeniden kuyruklanır).
            if (await CancelRequestedAsync(job.Id))
            {
                await MarkCanceledAsync(job.Id);
                return;
            }

            throw;
        }
        catch (Exception ex)
        {
            // Ağ/S3/IO ve diğer transient hatalar: Hangfire AutomaticRetry(2) devralır;
            // nihai FailedState'te JobFailureStateFilter satırı Failed'a senkronlar.
            logger.LogError(ex,
                "ExportJob {JobId}: transient failure (attempt {Attempt}); rethrowing for Hangfire retry.",
                jobId, job.AttemptCount);
            throw;
        }
        finally
        {
            TryDeleteDirectory(tempDir);
        }
    }

    // ───────────────────────── Yardımcılar ─────────────────────────

    /// <summary>
    /// Gerekli boş alan tahmini (tasarım 04 §4.2): Σkaynak (cache'e inecek) + süre×çıktı
    /// bitrate tahmini, üstüne %20 pay. Public: birim testleri formülü sabitler.
    /// </summary>
    public static long EstimateRequiredDiskBytes(long totalSourceBytes, long durationUs, long bitsPerSecond)
    {
        var outputBytes = (long)(durationUs / 1_000_000m * bitsPerSecond / 8);
        return (totalSourceBytes + outputBytes) * 12 / 10;
    }

    /// <summary>
    /// Çıktı bit hızı tahmini: profil varsayımı ile kaynakların ÖLÇÜLMÜŞ bit hızının büyüğü.
    /// <para>
    /// Ölçüm: CRF çıktısı içerik bağımlıdır ve grenli bir 1080p kaynakta profilin
    /// 10 Mbps varsayımının ~3 katını üretir (28,85 Mbps ölçüldü) — sabit varsayım gerçek
    /// tepe kullanımı %35 KÜÇÜMSÜYORDU ve dar diskte rezervasyon "yeter" deyip render
    /// ortasında disk bitirebilirdi. Kaynağın bit hızı zaten defterdedir (ffprobe süresi
    /// DB'ye yazılır: SizeBytes × 8e6 / DurationMicros); CRF çıktısının karmaşıklığı kaynağın
    /// karmaşıklığıyla sınırlı olduğundan max(profil, kaynak) güvenli üst banttır. Düşük bit
    /// hızlı kaynakta profil tabanı kazanır — tahmin ESKİSİYLE AYNI kalır (şişme yok).
    /// </para>
    /// <para>
    /// Yalnız Video/Audio türü ve süresi bilinen satırlar sayılır: görsel/LUT varlığının
    /// "süresi" bir zaman ekseni değildir ve boyut/süre oranı anlamsız (aşırı) bit hızları
    /// üretirdi.
    /// </para>
    /// </summary>
    public static long EffectiveOutputBitsPerSecond(ExportProfile profile, IEnumerable<Asset> sources)
    {
        var bps = ExportProfiles.EstimatedBitsPerSecond(profile);
        foreach (var asset in sources)
        {
            if (asset.Kind is not (AssetKind.Video or AssetKind.Audio)
                || asset.DurationMicros is not > 0)
            {
                continue;
            }

            var sourceBps = (long)(asset.SizeBytes * 8_000_000m / asset.DurationMicros.Value);
            bps = Math.Max(bps, sourceBps);
        }

        return bps;
    }

    private async Task<bool> EnsureDiskSpaceAsync(
        Job job, string tempDir, long totalSourceBytes, long durationUs,
        ExportProfile profile, IReadOnlyCollection<Asset> sources, CancellationToken ct)
    {
        var freeBytes = MeasureFreeSpace(tempDir);
        var requiredBytes = EstimateRequiredDiskBytes(
            totalSourceBytes, durationUs, EffectiveOutputBitsPerSecond(profile, sources));
        if (freeBytes < 0 || freeBytes >= requiredBytes)
        {
            return true;
        }

        // Ertelemeden/Failed'dan ÖNCE: LRU cache agresif süpürülür (hedef 0 — pinli, yani bu
        // işin kaynakları korunur) ve alan yeniden ölçülür. Cache'in kapladığı disk yüzünden
        // 2 dk beklemek ya da Failed olmak anlamsızdır — cache yeniden indirilebilir.
        await cache.TrimAsync(0, ct);
        freeBytes = MeasureFreeSpace(tempDir);
        if (freeBytes < 0 || freeBytes >= requiredBytes)
        {
            logger.LogInformation(
                "ExportJob {JobId}: disk was tight; aggressive cache trim freed enough space "
                + "(need {Required}, free {Free}).", job.Id, requiredBytes, freeBytes);
            return true;
        }

        if (job.AttemptCount >= MaxDiskFullAttempts)
        {
            await FailAsync(job, "disk-full",
                $"insufficient disk space after {job.AttemptCount} attempts "
                + $"(need {requiredBytes} bytes, free {freeBytes}).");
            return false;
        }

        job.Status = JobStatus.Queued;
        job.ProgressStage = "disk-wait";
        await db.SaveChangesAsync(ct);
        backgroundJobs.Schedule<IExportJob>(
            j => j.Run(job.Id, CancellationToken.None), DiskFullRetryDelay);
        logger.LogWarning(
            "ExportJob {JobId}: insufficient disk (need {Required}, free {Free}); "
            + "re-queued attempt {Attempt}/{Max} in {Delay}.",
            job.Id, requiredBytes, freeBytes, job.AttemptCount, MaxDiskFullAttempts, DiskFullRetryDelay);
        return false;
    }

    /// <summary>
    /// Deterministik hata: job Failed + açıklayıcı mesaj; EXCEPTION FIRLATILMAZ — Hangfire
    /// retry'ı bilerek tetiklenmez. DB'de bu arada Canceled olduysa üzerine YAZILMAZ.
    /// </summary>
    private async Task FailAsync(Job job, string reason, string detail, string? stderrTail = null)
    {
        if (await CancelRequestedAsync(job.Id))
        {
            await MarkCanceledAsync(job.Id);
            return;
        }

        var now = clock.GetUtcNow();
        var message = string.IsNullOrWhiteSpace(stderrTail)
            ? $"{reason}: {detail}"
            : $"{reason}: {detail}\n--- ffmpeg stderr tail ---\n{stderrTail}";
        job.Status = JobStatus.Failed;
        job.ErrorMessage = message.Length > 4000 ? message[..4000] : message;
        job.CompletedAt = now;
        await db.SaveChangesAsync(CancellationToken.None);

        logger.LogWarning(
            "ExportJob {JobId}: failed deterministically ({Reason}): {Detail}", job.Id, reason, detail);
    }

    /// <summary>API'nin yazdığı cancel bayrağını taze okur (tracked entity'e güvenilmez).</summary>
    private async Task<bool> CancelRequestedAsync(Guid jobId) =>
        await db.Jobs.AsNoTracking()
            .Where(j => j.Id == jobId)
            .Select(j => (JobStatus?)j.Status)
            .SingleOrDefaultAsync(CancellationToken.None) == JobStatus.Canceled;

    /// <summary>
    /// İptal edilen işin satırına dokunuş: CompletedAt (yoksa) + stage. Status'e dokunulmaz —
    /// Canceled API tarafından yazılmıştır. ExecuteUpdate: tracked entity'nin bayat Status'u
    /// DB'deki Canceled'ı ezmesin.
    /// </summary>
    private async Task MarkCanceledAsync(Guid jobId)
    {
        var now = clock.GetUtcNow();
        await db.Jobs
            .Where(j => j.Id == jobId && j.Status == JobStatus.Canceled)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.CompletedAt, j => j.CompletedAt ?? now)
                .SetProperty(j => j.ProgressStage, "canceled"), CancellationToken.None);
        logger.LogInformation("ExportJob {JobId}: canceled; ffmpeg killed and temp cleaned.", jobId);
    }

    /// <summary>
    /// probeDurationUs bilinen bir asset için sourceOutUs'u kaynak süresi + 1 çıktı frame'i
    /// toleransını aşan İLK klibi döndürür (yoksa null).
    /// <para>
    /// KURALIN KENDİSİ ARTIK BURADA DEĞİL: <see cref="ExportCompiler.FindSourceOutOfRange"/>
    /// tek tanımdır ve API'nin senkron kapısı da onu çağırır (orada süre DB'den, burada
    /// ffprobe'dan gelir — iki sayı yapısı gereği aynıdır). Bu sarmalayıcı worker'ın çağrı
    /// yerini ve birim testlerinin yüzeyini korur.
    /// </para>
    /// </summary>
    internal static MediaClip? FindSourceOutOfRange(
        IReadOnlyList<MediaClip> clips, Guid assetId, long? probeDurationUs, int fpsNum, int fpsDen) =>
        ExportCompiler.FindSourceOutOfRange(clips, assetId, probeDurationUs, fpsNum, fpsDen);

    private long MeasureFreeSpace(string path) =>
        FreeSpaceProbe?.Invoke(path) ?? TryGetAvailableFreeSpace(path);

    private static long TryGetAvailableFreeSpace(string path)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(path));
            return string.IsNullOrEmpty(root) ? -1 : new DriveInfo(root).AvailableFreeSpace;
        }
        catch (Exception)
        {
            return -1; // ölçülemiyorsa kontrolü atla — render disk hatasında zaten patlar
        }
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
            // Temp temizliği best-effort.
        }
    }
}
