using System.Security.Claims;
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
        assets.MapPost("/{id:guid}/complete", Complete);
        assets.MapPost("/{id:guid}/abort", Abort);
        assets.MapGet("/{id:guid}/upload/status", UploadStatus);
        assets.MapGet("/{id:guid}", GetById);
        assets.MapDelete("/{id:guid}", SoftDelete);

        return app;
    }

    // ---------- Upload yaşam döngüsü ----------

    private static async Task<IResult> InitUpload(
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

        // Kota: silinmemiş asset'lerin toplamı (Failed hariç) + eşzamanlı Uploading sayısı.
        var stats = await db.Assets.AsNoTracking()
            .Where(a => a.OwnerId == userId && a.DeletedAt == null)
            .GroupBy(_ => 1)
            .Select(g => new
            {
                UsedBytes = g.Where(a => a.Status != AssetStatus.Failed).Sum(a => (long?)a.SizeBytes) ?? 0L,
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

    private static async Task<IResult> Complete(
        Guid id, CompleteUploadRequest request, ClaimsPrincipal principal, AppDbContext db,
        IStorageService storage, IBackgroundJobClient jobs, TimeProvider clock, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        var asset = await FindOwnedAssetAsync(db, id, userId, track: true, ct);
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

        try
        {
            await storage.CompleteMultipartUploadAsync(
                asset.StorageKey, asset.UploadId,
                request.Parts.Select(p => new StorageCompletedPart(p.PartNumber, p.Etag)).ToList(), ct);
        }
        catch (AmazonS3Exception ex) when (ex.ErrorCode == "NoSuchUpload")
        {
            // Yarışan complete/abort ya da lifecycle süpürmesi.
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "Multipart upload no longer exists (already completed, aborted or expired).");
        }

        // Bütünlük: HeadObject boyutu beyan edilen sizeBytes ile birebir eşleşmeli
        // (tasarım 02 §1.6 — Content-Length imzalamak yerine ucuz ve kesin kontrol).
        var head = await storage.HeadObjectAsync(asset.StorageKey, ct);
        if (head is null || head.SizeBytes != asset.SizeBytes)
        {
            asset.Fail("size-mismatch", now);
            asset.UploadId = null;
            await db.SaveChangesAsync(ct);
            // Obje R2'de kalır; GC/temizlik M6 hijyen kapsamında (backlog).
            return Results.Problem(
                statusCode: StatusCodes.Status422UnprocessableEntity,
                title: $"Uploaded object size ({head?.SizeBytes.ToString() ?? "missing"}) does not match "
                       + $"declared sizeBytes ({asset.SizeBytes}). Asset marked as failed.");
        }

        asset.TransitionTo(AssetStatus.Uploaded, now);
        asset.TransitionTo(AssetStatus.Processing, now);
        asset.UploadId = null;

        var job = Job.Create(JobType.ProcessAsset, userId, now, assetId: asset.Id);
        db.Jobs.Add(job);
        await db.SaveChangesAsync(ct);

        // Enqueue DB kaydından SONRA: Hangfire işi Job satırını okuyarak koşar.
        job.HangfireJobId = jobs.Enqueue<IProcessAssetJob>(j => j.Run(job.Id, CancellationToken.None));
        await db.SaveChangesAsync(ct);

        return Results.Ok(new CompleteUploadResponse(StatusString(asset.Status)));
    }

    private static async Task<IResult> Abort(
        Guid id, ClaimsPrincipal principal, AppDbContext db, IStorageService storage,
        TimeProvider clock, CancellationToken ct)
    {
        var asset = await FindOwnedAssetAsync(db, id, principal.GetUserId(), track: true, ct);
        if (asset is null)
        {
            return Results.NotFound();
        }

        if (asset.Status != AssetStatus.Uploading || asset.UploadId is null)
        {
            return UploadNotActiveProblem(asset.Status);
        }

        var now = clock.GetUtcNow();
        await AbortUploadIgnoringMissingAsync(storage, asset, ct);
        asset.Fail("aborted", now);
        asset.UploadId = null;
        asset.DeletedAt = now; // iptal edilen upload kütüphanede görünmez, kotaya sayılmaz
        await db.SaveChangesAsync(ct);

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

        var query = db.ProjectAssets.AsNoTracking()
            .Where(pa => pa.ProjectId == projectId)
            .Join(db.Assets.AsNoTracking(), pa => pa.AssetId, a => a.Id, (pa, a) => new { pa, a })
            .Where(x => x.a.DeletedAt == null);

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

    private static async Task<IResult> MediaUrls(
        Guid projectId, ClaimsPrincipal principal, AppDbContext db, IStorageService storage,
        TimeProvider clock, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        if (!await OwnsProjectAsync(db, projectId, userId, ct))
        {
            return Results.NotFound();
        }

        // Yalnız READY asset'ler — işlenmemiş/başarısız asset'in servis edilecek türevi yoktur.
        var assets = await db.ProjectAssets.AsNoTracking()
            .Where(pa => pa.ProjectId == projectId)
            .Join(db.Assets.AsNoTracking(), pa => pa.AssetId, a => a.Id, (pa, a) => a)
            .Where(a => a.DeletedAt == null && a.Status == AssetStatus.Ready)
            .ToListAsync(ct);

        var expiresAt = clock.GetUtcNow().Add(R2StorageService.GetUrlLifetime);
        var map = assets.ToDictionary(
            a => a.Id.ToString("D"),
            a => AssetMediaUrlBuilder.Build(a, storage.PresignGet));

        return Results.Ok(new MediaUrlsResponse(expiresAt, map));
    }

    private static async Task<IResult> SoftDelete(
        Guid id, ClaimsPrincipal principal, AppDbContext db, IStorageService storage,
        TimeProvider clock, CancellationToken ct)
    {
        var asset = await FindOwnedAssetAsync(db, id, principal.GetUserId(), track: true, ct);
        if (asset is null)
        {
            return Results.NotFound();
        }

        var now = clock.GetUtcNow();

        // Aktif upload'ı olan asset silinirse multipart da iptal edilir (Class A israfı olmasın).
        if (asset.Status == AssetStatus.Uploading && asset.UploadId is not null)
        {
            await AbortUploadIgnoringMissingAsync(storage, asset, ct);
            asset.Fail("aborted", now);
            asset.UploadId = null;
        }

        // M6 (backlog): timeline'larda kullanım kontrolü ("N projede kullanılıyor" uyarısı,
        // dangling assetId UX'i) ve R2 prefix GC (DeletePrefix) hard-delete job'ına gelecek.
        // Şimdilik yalnız soft delete — R2 objeleri yerinde kalır.
        asset.DeletedAt = now;
        await db.SaveChangesAsync(ct);

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
