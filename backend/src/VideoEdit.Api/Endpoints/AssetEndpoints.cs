using System.Security.Claims;
using System.Text.Json;
using Amazon.S3;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using VideoEdit.Api.Assets;
using VideoEdit.Api.Auth;
using VideoEdit.Contracts;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Domain.Services;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Jobs;
using VideoEdit.Infrastructure.Storage;

namespace VideoEdit.Api.Endpoints;

/// <summary>
/// Asset upload + kütüphane API'si (tasarım 02 §1.3, mimar kararı 1.d: kullanıcı-scoped asset).
/// Upload akışı: init (multipart başlat) → parts/presign (istemci R2'ye doğrudan PUT) →
/// complete (HeadObject boyut doğrulaması + ProcessAsset kuyruğu) | abort.
/// </summary>
public static class AssetEndpoints
{
    public static IEndpointRouteBuilder MapAssetEndpoints(this IEndpointRouteBuilder app)
    {
        // Proje-scoped uçlar (proje sahipliği denetlenir).
        var projects = app.MapGroup("/api/projects").WithTags("Assets").RequireAuthorization();
        projects.MapPost("/{projectId:guid}/assets", InitUpload).RequireRateLimiting("upload-init");
        projects.MapGet("/{projectId:guid}/assets", ListForProject);
        projects.MapGet("/{projectId:guid}/media-urls", MediaUrls);

        // Asset-scoped uçlar (asset sahipliği denetlenir).
        var assets = app.MapGroup("/api/assets").WithTags("Assets").RequireAuthorization();
        assets.MapPost("/{id:guid}/parts/presign", PresignParts).RequireRateLimiting("upload-init");
        // Kullanım kontrolü (M6): silmeden ÖNCE "bu medya nerede kullanılıyor?" sorusu.
        // Timeline jsonb taraması olduğu için upload-ops bütçesine bağlanır (60/dk/kullanıcı).
        assets.MapGet("/{id:guid}/usage", Usage).RequireRateLimiting("upload-ops");
        // complete/abort/upload-status da kullanıcı-bazlı sınırlanır: her biri S3 çağrısı
        // tetikler (Class A/B operasyon) — sınırsız çağrı MinIO/R2 maliyeti + DoS yüzeyidir.
        assets.MapPost("/{id:guid}/complete", Complete).RequireRateLimiting("upload-ops");
        assets.MapPost("/{id:guid}/abort", Abort).RequireRateLimiting("upload-ops");
        assets.MapGet("/{id:guid}/upload/status", UploadStatus).RequireRateLimiting("upload-ops");
        assets.MapGet("/{id:guid}", GetById);
        assets.MapDelete("/{id:guid}", SoftDelete);

        // Kota özeti (M6): kitaplık başlığındaki gösterge. InitUpload'ın kota
        // sorgusuyla AYNI tanım (silinmemiş TÜM asset'ler, Failed dahil) —
        // gösterge ile reddin aynı sayıyı konuşması şart.
        app.MapGet("/api/quota", QuotaSummary).WithTags("Assets").RequireAuthorization();

        return app;
    }

    // ---------- Upload yaşam döngüsü ----------

    // Not: handler'lar internal — birim testleri (Sqlite in-memory + sahte storage) doğrudan çağırır.
    internal static async Task<IResult> InitUpload(
        Guid projectId, InitAssetUploadRequest request, ClaimsPrincipal principal, AppDbContext db,
        IStorageService storage, IOptions<QuotasOptions> quotasOptions, TimeProvider clock,
        CancellationToken ct)
    {
        var userId = principal.GetUserId();
        if (!await OwnsProjectAsync(db, projectId, userId, ct))
        {
            return Results.NotFound();
        }

        var quotas = quotasOptions.Value;
        var errors = AssetUploadValidation.ValidateInit(request, quotas.MaxFileSizeBytes, out var kind);
        if (errors.Count > 0)
        {
            return Results.ValidationProblem(errors);
        }

        // Kota: silinmemiş TÜM asset'lerin toplamı (Failed DAHİL) + eşzamanlı Uploading sayısı.
        // Failed hariç tutulursa objesi R2'de duran başarısız asset'ler kotadan kaçar (bypass).
        // Değişmez (invariant): objesi R2'den silinen her yol asset'i soft-delete eder
        // (abort, size-mismatch) — soft-delete kotadan düşer, obje sayılmaz, tutarlı.
        var stats = await db.Assets.AsNoTracking()
            .Where(a => a.OwnerId == userId && a.DeletedAt == null)
            .GroupBy(_ => 1)
            .Select(g => new
            {
                UsedBytes = g.Sum(a => (long?)a.SizeBytes) ?? 0L,
                ActiveUploads = g.Count(a => a.Status == AssetStatus.Uploading),
            })
            .FirstOrDefaultAsync(ct);

        var violation = UploadQuota.Evaluate(
            request.SizeBytes, stats?.UsedBytes ?? 0, stats?.ActiveUploads ?? 0, quotas);
        switch (violation)
        {
            case QuotaViolation.TotalBytesExceeded:
                return Results.Problem(
                    statusCode: StatusCodes.Status403Forbidden,
                    title: $"Storage quota exceeded (max {quotas.MaxTotalBytesPerUser} bytes per user).");
            case QuotaViolation.TooManyConcurrentUploads:
                return Results.Problem(
                    statusCode: StatusCodes.Status429TooManyRequests,
                    title: $"Too many concurrent uploads (max {quotas.MaxConcurrentUploads}). "
                           + "Finish or abort an active upload first.");
        }

        var now = clock.GetUtcNow();
        var contentType = request.ContentType.Trim().ToLowerInvariant();
        var asset = Asset.Create(userId, kind, request.FileName.Trim(), contentType, request.SizeBytes, now);

        // Önce R2'de multipart başlat, sonra DB'ye yaz — DB yazımı başarısız olursa yetim
        // multipart R2 lifecycle'ı (7 gün) + reaper tarafından süpürülür.
        asset.UploadId = await storage.CreateMultipartUploadAsync(asset.StorageKey, contentType, ct);

        db.Assets.Add(asset);
        db.ProjectAssets.Add(new ProjectAsset { ProjectId = projectId, AssetId = asset.Id, AddedAt = now });
        await db.SaveChangesAsync(ct);

        return Results.Created(
            $"/api/assets/{asset.Id}",
            new InitAssetUploadResponse(
                asset.Id, asset.UploadId, UploadRules.PartSizeBytes, UploadRules.PartCount(request.SizeBytes)));
    }

    private static async Task<IResult> PresignParts(
        Guid id, PresignPartsRequest request, ClaimsPrincipal principal, AppDbContext db,
        IStorageService storage, CancellationToken ct)
    {
        var asset = await FindOwnedAssetAsync(db, id, principal.GetUserId(), track: false, ct);
        if (asset is null)
        {
            return Results.NotFound();
        }

        if (asset.Status != AssetStatus.Uploading || asset.UploadId is null)
        {
            return UploadNotActiveProblem(asset.Status);
        }

        var partCount = UploadRules.PartCount(asset.SizeBytes);
        var errors = AssetUploadValidation.ValidatePresign(request.PartNumbers, partCount);
        if (errors.Count > 0)
        {
            return Results.ValidationProblem(errors);
        }

        // Presign yerel imzalamadır (ağ çağrısı yok) — 20 part'lık istek bile ucuzdur.
        var parts = request.PartNumbers
            .Select(n => new PresignedPartDto(n, storage.PresignUploadPart(asset.StorageKey, asset.UploadId, n)))
            .ToList();

        return Results.Ok(parts);
    }

    internal static async Task<IResult> Complete(
        Guid id, CompleteUploadRequest request, ClaimsPrincipal principal, AppDbContext db,
        IStorageService storage, IBackgroundJobClient jobs, TimeProvider clock, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        var asset = await FindOwnedAssetAsync(db, id, userId, track: false, ct);
        if (asset is null)
        {
            return Results.NotFound();
        }

        if (asset.Status != AssetStatus.Uploading || asset.UploadId is null)
        {
            return UploadNotActiveProblem(asset.Status);
        }

        var partCount = UploadRules.PartCount(asset.SizeBytes);
        var errors = AssetUploadValidation.ValidateComplete(request.Parts, partCount);
        if (errors.Count > 0)
        {
            return Results.ValidationProblem(errors);
        }

        var now = clock.GetUtcNow();
        StorageObjectInfo? head = null;

        try
        {
            await storage.CompleteMultipartUploadAsync(
                asset.StorageKey, asset.UploadId,
                request.Parts.Select(p => new StorageCompletedPart(p.PartNumber, p.Etag)).ToList(), ct);
        }
        catch (AmazonS3Exception ex) when (ex.ErrorCode == "NoSuchUpload")
        {
            // İdempotent complete: upload id yoksa daha önceki bir complete başarmış olabilir
            // (yanıt istemciye ulaşmadan koptu → retry). Obje var VE boyut beyanla eşitse
            // başarı yolundan devam; değilse gerçek çakışma/expiry → 409.
            head = await storage.HeadObjectAsync(asset.StorageKey, ct);
            if (head is null || head.SizeBytes != asset.SizeBytes)
            {
                return Results.Problem(
                    statusCode: StatusCodes.Status409Conflict,
                    title: "Multipart upload no longer exists (already completed, aborted or expired).");
            }
        }
        catch (AmazonS3Exception ex) when (ex.ErrorCode is "InvalidPart" or "InvalidPartOrder")
        {
            // İstemcinin gönderdiği part listesi hatalı (yanlış etag/sıra) — istemci hatasıdır,
            // 500'e düşürülmez; upload hâlâ aktif, istemci doğru listeyle retry edebilir.
            return Results.Problem(
                statusCode: StatusCodes.Status422UnprocessableEntity,
                title: $"S3 rejected the completed part list ({ex.ErrorCode}). "
                       + "Verify part numbers and etags, then retry complete.");
        }
        catch (AmazonS3Exception ex) when ((int)ex.StatusCode is >= 400 and < 500)
        {
            // Diğer 4xx S3 hataları (EntityTooSmall vb.) da istemci-kaynaklıdır — generic 500 değil.
            return Results.Problem(
                statusCode: StatusCodes.Status422UnprocessableEntity,
                title: $"Storage rejected the complete request ({ex.ErrorCode ?? "client error"}).");
        }

        // Bütünlük: HeadObject boyutu beyan edilen sizeBytes ile birebir eşleşmeli
        // (tasarım 02 §1.6 — Content-Length imzalamak yerine ucuz ve kesin kontrol).
        head ??= await storage.HeadObjectAsync(asset.StorageKey, ct);
        if (head is null || head.SizeBytes != asset.SizeBytes)
        {
            // Kota bypass + sızıntı önleme: uyuşmayan obje R2'den SİLİNİR ve asset soft-delete
            // edilir — kota sorgusu (InitUpload) silinmemiş tüm asset'leri saydığı için
            // "objesi silinmiş ama kotada duran" veya "kotadan düşmüş ama objesi duran"
            // tutarsızlığı kalmaz. Durum-korumalı UPDATE: yarışan istek kazandıysa üzerine yazmayız.
            if (head is not null)
            {
                await storage.DeleteObjectAsync(asset.StorageKey, ct);
            }

            await db.Assets
                .Where(a => a.Id == id && a.Status == AssetStatus.Uploading && a.DeletedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(a => a.Status, AssetStatus.Failed)
                    .SetProperty(a => a.FailureReason, "size-mismatch")
                    .SetProperty(a => a.UploadId, (string?)null)
                    .SetProperty(a => a.DeletedAt, now), ct);

            return Results.Problem(
                statusCode: StatusCodes.Status422UnprocessableEntity,
                title: $"Uploaded object size ({head?.SizeBytes.ToString() ?? "missing"}) does not match "
                       + $"declared sizeBytes ({asset.SizeBytes}). Asset marked as failed.");
        }

        // Durum-korumalı atomik geçiş (Uploading → Processing): koşulu sağlayan tek istek
        // kazanır; kaybeden ikinci bir job ENQUEUE ETMEZ (çift işleme önlenir).
        // ProcessingStartedAt reaper'ın "stalled" tespiti için burada damgalanır.
        var claimed = await db.Assets
            .Where(a => a.Id == id && a.Status == AssetStatus.Uploading && a.DeletedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(a => a.Status, AssetStatus.Processing)
                .SetProperty(a => a.FailureReason, (string?)null)
                .SetProperty(a => a.UploadId, (string?)null)
                .SetProperty(a => a.ProcessingStartedAt, now), ct);

        if (claimed == 0)
        {
            // Yarışı başka bir istek kazandı (paralel complete/abort/delete).
            var current = await FindOwnedAssetAsync(db, id, userId, track: false, ct);
            if (current is null)
            {
                return Results.NotFound(); // yarışan abort/delete soft-delete etmiş
            }

            return current.Status is AssetStatus.Uploaded or AssetStatus.Processing or AssetStatus.Ready
                ? Results.Ok(new CompleteUploadResponse(StatusString(current.Status))) // idempotent, 2. enqueue yok
                : UploadNotActiveProblem(current.Status);
        }

        var job = Job.Create(JobType.ProcessAsset, userId, now, assetId: asset.Id);
        db.Jobs.Add(job);
        await db.SaveChangesAsync(ct);

        // Enqueue DB kaydından SONRA: Hangfire işi Job satırını okuyarak koşar.
        job.HangfireJobId = jobs.Enqueue<IProcessAssetJob>(j => j.Run(job.Id, CancellationToken.None));
        await db.SaveChangesAsync(ct);

        return Results.Ok(new CompleteUploadResponse(StatusString(AssetStatus.Processing)));
    }

    internal static async Task<IResult> Abort(
        Guid id, ClaimsPrincipal principal, AppDbContext db, IStorageService storage,
        TimeProvider clock, CancellationToken ct)
    {
        var asset = await FindOwnedAssetAsync(db, id, principal.GetUserId(), track: false, ct);
        if (asset is null)
        {
            return Results.NotFound();
        }

        if (asset.Status != AssetStatus.Uploading || asset.UploadId is null)
        {
            return UploadNotActiveProblem(asset.Status);
        }

        var now = clock.GetUtcNow();

        // ÖNCE durum-korumalı claim: Complete yarışı kazandıysa (Status artık Uploading değil)
        // asset'i Failed'a ÇEKMEYİZ ve tamamlanmış objeye dokunmayız — 0 satır → mevcut durumla 409.
        var claimed = await db.Assets
            .Where(a => a.Id == id && a.Status == AssetStatus.Uploading && a.DeletedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(a => a.Status, AssetStatus.Failed)
                .SetProperty(a => a.FailureReason, "aborted")
                .SetProperty(a => a.UploadId, (string?)null)
                .SetProperty(a => a.DeletedAt, now), ct); // soft-delete: görünmez + kotaya sayılmaz

        if (claimed == 0)
        {
            var current = await FindOwnedAssetAsync(db, id, principal.GetUserId(), track: false, ct);
            return current is null
                ? Results.NoContent() // yarışan abort/delete zaten soft-delete etmiş — idempotent
                : UploadNotActiveProblem(current.Status);
        }

        // Claim SONRASI S3 temizliği: multipart iptali + (yarı-tamamlanmış bir complete
        // objeyi yazmış olabilir) tekil obje silme. İkisi de idempotent; hata durumunda
        // kalıntıyı R2 lifecycle (7 gün) süpürür — DB durumu zaten tutarlı (soft-deleted).
        await AbortUploadIgnoringMissingAsync(storage, asset, ct);
        await storage.DeleteObjectAsync(asset.StorageKey, ct);

        return Results.NoContent();
    }

    private static async Task<IResult> UploadStatus(
        Guid id, ClaimsPrincipal principal, AppDbContext db, IStorageService storage, CancellationToken ct)
    {
        var asset = await FindOwnedAssetAsync(db, id, principal.GetUserId(), track: false, ct);
        if (asset is null)
        {
            return Results.NotFound();
        }

        if (asset.Status != AssetStatus.Uploading || asset.UploadId is null)
        {
            return UploadNotActiveProblem(asset.Status);
        }

        // Resume kaynağı R2'nin GERÇEK part durumu (ListParts) — istemci state'ine güvenilmez;
        // yarım kalan part R2'de görünmez ve istemci onu yeniden yükler (tasarım 02 §1.5).
        var parts = await storage.ListPartsAsync(asset.StorageKey, asset.UploadId, ct);

        return Results.Ok(new UploadStatusResponse(
            asset.UploadId,
            UploadRules.PartSizeBytes,
            parts
                .OrderBy(p => p.PartNumber)
                .Select(p => new UploadedPartDto(p.PartNumber, p.SizeBytes, p.ETag))
                .ToList()));
    }

    // ---------- Kütüphane ----------

    private static async Task<IResult> GetById(
        Guid id, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct)
    {
        var asset = await FindOwnedAssetAsync(db, id, principal.GetUserId(), track: false, ct);
        return asset is null ? Results.NotFound() : Results.Ok(ToDto(asset));
    }

    private static async Task<IResult> ListForProject(
        Guid projectId, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct,
        int page = 1, int pageSize = 50)
    {
        var userId = principal.GetUserId();
        if (!await OwnsProjectAsync(db, projectId, userId, ct))
        {
            return Results.NotFound();
        }

        int skip;
        (page, pageSize, skip) = TimelineRequestValidation.NormalizePaging(page, pageSize);

        // Sahiplik filtresi (x.a.OwnerId == userId): media-urls ile aynı savunma derinliği —
        // proje sahipliği OwnsProjectAsync ile doğrulanmış olsa da, cross-user bir ProjectAssets
        // satırı asla listelenemesin (tek değişmez delinse bile).
        var query = db.ProjectAssets.AsNoTracking()
            .Where(pa => pa.ProjectId == projectId)
            .Join(db.Assets.AsNoTracking(), pa => pa.AssetId, a => a.Id, (pa, a) => new { pa, a })
            .Where(x => x.a.OwnerId == userId && x.a.DeletedAt == null);

        var total = await query.CountAsync(ct);
        var assets = await query
            .OrderByDescending(x => x.pa.AddedAt)
            .ThenByDescending(x => x.a.Id)
            .Skip(skip)
            .Take(pageSize)
            .Select(x => x.a)
            .ToListAsync(ct);

        return Results.Ok(new PagedResult<AssetDto>(
            assets.Select(ToDto).ToList(), page, pageSize, total));
    }

    internal static async Task<IResult> MediaUrls(
        Guid projectId, ClaimsPrincipal principal, AppDbContext db, IStorageService storage,
        TimeProvider clock, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        if (!await OwnsProjectAsync(db, projectId, userId, ct))
        {
            return Results.NotFound();
        }

        // Yalnız READY asset'ler — işlenmemiş/başarısız asset'in servis edilecek türevi yoktur.
        // Sahiplik filtresi (a.OwnerId == userId) savunma derinliğidir: proje sahipliği zaten
        // OwnsProjectAsync ile doğrulandı ve ProjectAssets satırları InitUpload'ta hep sahip
        // asset'e bağlanır, ama o tek değişmez delinirse (ör. yanlış bir bakım betiği cross-user
        // satır yazarsa) bu filtre olmadan başka kullanıcının imzalı URL'leri sızardı. Aynı
        // desen defter/kota sorgularında da kullanılır (OwnerId == userId && DeletedAt == null).
        var assets = await db.ProjectAssets.AsNoTracking()
            .Where(pa => pa.ProjectId == projectId)
            .Join(db.Assets.AsNoTracking(), pa => pa.AssetId, a => a.Id, (pa, a) => a)
            .Where(a => a.OwnerId == userId && a.DeletedAt == null && a.Status == AssetStatus.Ready)
            .ToListAsync(ct);

        var expiresAt = clock.GetUtcNow().Add(R2StorageService.GetUrlLifetime);
        var map = new Dictionary<string, AssetMediaUrlsDto>(assets.Count);
        foreach (var asset in assets)
        {
            // BuildAsync filmstrip'li asset başına tek küçük GetObject yapar (manifest.json,
            // <2 KB) — proje asset sayısıyla sınırlı; manifest okunamazsa sprites null döner.
            map[asset.Id.ToString("D")] = await AssetMediaUrlBuilder.BuildAsync(
                asset, storage.PresignGet, (key, token) => ReadObjectOrNullAsync(storage, key, token), ct);
        }

        return Results.Ok(new MediaUrlsResponse(expiresAt, map));
    }

    /// <summary>Küçük objeyi RAM'e okur; yoksa/okunamazsa null (media-urls manifest okuması best-effort).</summary>
    private static async Task<byte[]?> ReadObjectOrNullAsync(
        IStorageService storage, string key, CancellationToken ct)
    {
        try
        {
            using var download = await storage.OpenReadAsync(key, ct);
            if (download.Length is < 0 or > AssetMediaUrlBuilder.MaxManifestBytes)
            {
                return null;
            }

            using var buffer = new MemoryStream((int)download.Length);
            await download.Content.CopyToAsync(buffer, ct);
            return buffer.ToArray();
        }
        catch (AmazonS3Exception)
        {
            // Manifest yok/erişilemedi — sprites alanı düşer, yanıt yine döner (geriye uyumlu).
            return null;
        }
    }

    // ---------- Kullanım kontrolü + kota özeti (M6) ----------

    /// <summary>
    /// GET /api/assets/{id}/usage — asset'in kullanıcının HANGİ projelerinde KAÇ klipte
    /// kullanıldığı. Silme onayı bunun üzerine kurulur: "kullanılıyor mu?" bilgisi asset
    /// listesine (GET /projects/{id}/assets) gömülmez, çünkü orası her 3 sn'de bir yoklanır
    /// ve her yoklamada tüm timeline'ları taramak listeyi pahalı hale getirirdi.
    ///
    /// Tarama BELLEKTE yapılır (Postgres jsonb sorgusu değil): kullanıcı başına proje sayısı
    /// azdır ve aynı kod Sqlite'lı birim testlerinde de koşar. Projeler tek tek akıtılır
    /// (AsAsyncEnumerable) — bütün timeline'lar aynı anda RAM'e alınmaz.
    /// </summary>
    internal static async Task<IResult> Usage(
        Guid id, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        // Sahiplik: başkasının asset'inin hangi projelerde kullanıldığı SIZDIRILMAZ.
        var asset = await FindOwnedAssetAsync(db, id, userId, track: false, ct);
        if (asset is null)
        {
            return Results.NotFound();
        }

        var projects = new List<AssetUsageProjectDto>();
        var query = db.Projects.AsNoTracking()
            .Where(p => p.OwnerId == userId && p.DeletedAt == null)
            .OrderBy(p => p.Name)
            .ThenBy(p => p.Id)
            .Select(p => new { p.Id, p.Name, p.Timeline })
            .AsAsyncEnumerable();

        await foreach (var row in query.WithCancellation(ct))
        {
            var clipCount = CountAssetClips(row.Timeline, id);
            if (clipCount > 0)
            {
                projects.Add(new AssetUsageProjectDto(row.Id, row.Name, clipCount));
            }
        }

        return Results.Ok(new AssetUsageResponse(projects));
    }

    /// <summary>
    /// tracks[].clips[] içinde assetId'si eşleşen klip sayısı.
    ///
    /// Ham JSON gezintisi (TimelineDoc'a deserialize DEĞİL) bilinçlidir: ileri şema
    /// sürümünden gelen ya da bozuk bir doküman yüzünden silme onayı patlamamalı —
    /// tanınmayan alanlar sessizce atlanır, sayım yine doğru olur. Medya klipleri ve
    /// sticker'lar aynı "assetId" alanını taşır, ikisi de sayılır.
    /// </summary>
    internal static int CountAssetClips(JsonDocument? timeline, Guid assetId)
    {
        if (timeline is null || timeline.RootElement.ValueKind != JsonValueKind.Object)
        {
            return 0;
        }

        if (!timeline.RootElement.TryGetProperty("tracks", out var tracks)
            || tracks.ValueKind != JsonValueKind.Array)
        {
            return 0;
        }

        var count = 0;
        foreach (var track in tracks.EnumerateArray())
        {
            if (track.ValueKind != JsonValueKind.Object
                || !track.TryGetProperty("clips", out var clips)
                || clips.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var clip in clips.EnumerateArray())
            {
                if (clip.ValueKind != JsonValueKind.Object
                    || !clip.TryGetProperty("assetId", out var clipAssetId)
                    || clipAssetId.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                if (clipAssetId.TryGetGuid(out var parsed) && parsed == assetId)
                {
                    count++;
                }
            }
        }

        return count;
    }

    /// <summary>
    /// GET /api/quota — kitaplık başlığındaki gösterge (kullanılan/toplam, asset sayısı).
    /// Sayım InitUpload'daki kota sorgusuyla BİREBİR aynı tanımı kullanır: silinmemiş TÜM
    /// asset'ler (Failed dahil). Gösterge ile "kota doldu" reddi farklı sayı konuşursa
    /// kullanıcı için sadece yalan olur.
    /// </summary>
    internal static async Task<IResult> QuotaSummary(
        ClaimsPrincipal principal, AppDbContext db, IOptions<QuotasOptions> quotasOptions,
        CancellationToken ct)
    {
        var userId = principal.GetUserId();
        var stats = await db.Assets.AsNoTracking()
            .Where(a => a.OwnerId == userId && a.DeletedAt == null)
            .GroupBy(_ => 1)
            .Select(g => new
            {
                UsedBytes = g.Sum(a => (long?)a.SizeBytes) ?? 0L,
                AssetCount = g.Count(),
            })
            .FirstOrDefaultAsync(ct);

        var quotas = quotasOptions.Value;
        return Results.Ok(new QuotaSummaryResponse(
            stats?.UsedBytes ?? 0L,
            quotas.MaxTotalBytesPerUser,
            stats?.AssetCount ?? 0,
            quotas.MaxConcurrentUploads));
    }

    internal static async Task<IResult> SoftDelete(
        Guid id, ClaimsPrincipal principal, AppDbContext db, IStorageService storage,
        TimeProvider clock, CancellationToken ct)
    {
        var asset = await FindOwnedAssetAsync(db, id, principal.GetUserId(), track: false, ct);
        if (asset is null)
        {
            return Results.NotFound();
        }

        var now = clock.GetUtcNow();

        // Aktif upload'ı olan asset silinirse multipart da iptal edilir (Class A israfı olmasın).
        // Durum-korumalı: Complete yarışı kazandıysa (0 satır) Failed'a çekmeyiz,
        // aşağıdaki düz soft-delete'e düşeriz (Processing bir asset de silinebilir).
        if (asset.Status == AssetStatus.Uploading && asset.UploadId is not null)
        {
            var claimed = await db.Assets
                .Where(a => a.Id == id && a.Status == AssetStatus.Uploading && a.DeletedAt == null)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(a => a.Status, AssetStatus.Failed)
                    .SetProperty(a => a.FailureReason, "aborted")
                    .SetProperty(a => a.UploadId, (string?)null)
                    .SetProperty(a => a.DeletedAt, now), ct);

            if (claimed == 1)
            {
                await AbortUploadIgnoringMissingAsync(storage, asset, ct);
                return Results.NoContent();
            }
        }

        // Kullanım kontrolü İSTEMCİDE, silmeden ÖNCE yapılır (GET /api/assets/{id}/usage):
        // sunucu silmeyi reddetmez — kullanıcı uyarıyı görüp onayladıysa medya gider,
        // ilgili klipler timeline'da "medya eksik" olarak işaretlenir. R2 prefix GC
        // (DeletePrefix) hard-delete job'ına gelecek; şimdilik yalnız soft delete — R2
        // objeleri yerinde kalır. 0 satır (zaten silinmiş) de 204: silme idempotenttir.
        await db.Assets
            .Where(a => a.Id == id && a.DeletedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(a => a.DeletedAt, now), ct);

        return Results.NoContent();
    }

    // ---------- Helpers ----------

    private static async Task AbortUploadIgnoringMissingAsync(
        IStorageService storage, Asset asset, CancellationToken ct)
    {
        try
        {
            await storage.AbortMultipartUploadAsync(asset.StorageKey, asset.UploadId!, ct);
        }
        catch (AmazonS3Exception ex) when (ex.ErrorCode == "NoSuchUpload")
        {
            // Lifecycle zaten süpürmüş — hedef durum aynı, devam.
        }
    }

    private static IResult UploadNotActiveProblem(AssetStatus status) =>
        Results.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: $"Asset has no active upload (status: {StatusString(status)}).");

    private static async Task<Asset?> FindOwnedAssetAsync(
        AppDbContext db, Guid id, Guid userId, bool track, CancellationToken ct)
    {
        var query = track ? db.Assets.AsQueryable() : db.Assets.AsNoTracking();
        return await query.SingleOrDefaultAsync(
            a => a.Id == id && a.OwnerId == userId && a.DeletedAt == null, ct);
    }

    private static Task<bool> OwnsProjectAsync(AppDbContext db, Guid id, Guid userId, CancellationToken ct) =>
        db.Projects.AsNoTracking()
            .AnyAsync(p => p.Id == id && p.OwnerId == userId && p.DeletedAt == null, ct);

    private static string StatusString(AssetStatus status) => status switch
    {
        AssetStatus.Uploading => "uploading",
        AssetStatus.Uploaded => "uploaded",
        AssetStatus.Processing => "processing",
        AssetStatus.Ready => "ready",
        AssetStatus.Failed => "failed",
        _ => "unknown",
    };

    private static string KindString(AssetKind kind) => kind switch
    {
        AssetKind.Video => "video",
        AssetKind.Audio => "audio",
        AssetKind.Image => "image",
        _ => "unknown",
    };

    private static AssetDto ToDto(Asset a) => new(
        a.Id,
        a.OriginalFileName,
        a.SizeBytes,
        a.ContentType,
        KindString(a.Kind),
        StatusString(a.Status),
        ErrorCode: a.FailureReason,
        DurationMicros: a.DurationMicros,
        Width: a.Width,
        Height: a.Height,
        FpsNum: a.FpsNum,
        FpsDen: a.FpsDen,
        HasAudio: a.Status == AssetStatus.Ready ? a.HasAudio : null,
        CreatedAt: a.CreatedAt);
}

/// <summary>
/// GET /api/assets/{id}/usage yanıtı — asset'in kullanıldığı projeler.
/// Boş liste = hiçbir timeline'da kullanılmıyor (silme uyarısız onaya düşer).
/// </summary>
public sealed record AssetUsageResponse(IReadOnlyList<AssetUsageProjectDto> Projects);

/// <summary>Bir projedeki kullanım: proje kimliği/adı + asset'i gösteren klip sayısı.</summary>
public sealed record AssetUsageProjectDto(Guid Id, string Name, int ClipCount);

/// <summary>
/// GET /api/quota yanıtı — kitaplık kota göstergesinin sözleşmesi.
/// usedBytes/assetCount: silinmemiş TÜM asset'ler (Failed dahil, InitUpload ile aynı tanım).
/// </summary>
public sealed record QuotaSummaryResponse(
    long UsedBytes,
    long MaxBytes,
    int AssetCount,
    int MaxConcurrentUploads);
