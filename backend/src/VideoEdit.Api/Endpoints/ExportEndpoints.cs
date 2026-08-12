using System.Security.Claims;
using System.Text.Json;
using Hangfire;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Api.Auth;
using VideoEdit.Contracts;
using VideoEdit.Contracts.Timeline;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Infrastructure.Jobs;
using VideoEdit.Infrastructure.Storage;
using VideoEdit.Media.Export;
using VideoEdit.Media.Text;

namespace VideoEdit.Api.Endpoints;

/// <summary>
/// M3 export API'si (tasarım 04 §4.1):
///  POST /api/projects/{id}/exports  — mevcut Project.Timeline'ı Job.TimelineSnapshot'a
///    GÖMEREK Export job'u kuyruklar (202). Compiler'ın doğrulama aşaması BURADA da koşar:
///    desteklenmeyen doküman kuyruğa hiç girmez (422). Kullanıcı başına eşzamanlı export
///    tavanı 2 (aşımı 429).
///  GET  /api/jobs/{id}              — durum + progress + stage (+ Succeeded export'ta 24h
///    presigned downloadUrl).
///  POST /api/jobs/{id}/cancel       — Queued/Running export'u iptal eder (satır Canceled +
///    Hangfire delete; koşan worker ffmpeg'i öldürür).
///  GET  /api/projects/{id}/exports  — projedeki export job listesi (sayfalı).
/// </summary>
public static class ExportEndpoints
{
    /// <summary>Kullanıcı başına eşzamanlı (Queued|Running) export tavanı — aşımı 429.</summary>
    public const int MaxConcurrentExportsPerUser = 2;

    public static IEndpointRouteBuilder MapExportEndpoints(this IEndpointRouteBuilder app)
    {
        var projects = app.MapGroup("/api/projects").WithTags("Exports").RequireAuthorization();
        // Her başlatma bir render + S3 trafiği tetikler — upload-ops kullanıcı-bazlı limiti yeterli.
        projects.MapPost("/{projectId:guid}/exports", StartExport).RequireRateLimiting("upload-ops");
        projects.MapGet("/{projectId:guid}/exports", ListForProject);

        var jobs = app.MapGroup("/api/jobs").WithTags("Exports").RequireAuthorization();
        jobs.MapGet("/{id:guid}", GetJob);
        jobs.MapPost("/{id:guid}/cancel", CancelJob).RequireRateLimiting("upload-ops");

        return app;
    }

    // ---------- Handlers (internal: birim testleri doğrudan çağırır) ----------

    /// <param name="overlayMeasurer">
    /// Metin bbox'ının ölçüm yolu (yalnız <see cref="ITextRasterService.Measure"/> — dosya
    /// yazılmaz). Ön kapının raster katman tavanını GERÇEK kutuyla doğrulaması için verilir;
    /// kayıtlı değilse (ya da fontlar kurulu değilse) doğrulama font-bağımsız KESİN ALT
    /// SINIRA düşer — kapı zayıflar ama yanlış 422 üretmez (3. tur denetim, blocker 2).
    /// </param>
    internal static async Task<IResult> StartExport(
        Guid projectId, CreateExportRequest request, ClaimsPrincipal principal, AppDbContext db,
        IBackgroundJobClient jobs, TimeProvider clock, FontManifestProvider fonts,
        [FromServices] ITextRasterService? overlayMeasurer, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        var project = await db.Projects.AsNoTracking()
            .SingleOrDefaultAsync(p => p.Id == projectId && p.OwnerId == userId && p.DeletedAt == null, ct);
        if (project is null)
        {
            return Results.NotFound();
        }

        var profileName = string.IsNullOrWhiteSpace(request?.Profile) ? "1080p" : request!.Profile!;
        if (!ExportProfiles.TryParse(profileName, out var profile))
        {
            return Results.ValidationProblem(new Dictionary<string, string[]>
            {
                ["profile"] = [$"Unknown export profile '{profileName}'. Supported: 1080p."],
            });
        }

        // Eşzamanlılık tavanı: kullanıcının aktif (Queued|Running) export sayısı.
        var active = await db.Jobs.CountAsync(
            j => j.RequestedBy == userId
                 && j.Type == JobType.Export
                 && (j.Status == JobStatus.Queued || j.Status == JobStatus.Running), ct);
        if (active >= MaxConcurrentExportsPerUser)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status429TooManyRequests,
                title: $"Too many concurrent exports (max {MaxConcurrentExportsPerUser}). "
                       + "Wait for a running export to finish or cancel one.");
        }

        // ÖN-DOĞRULAMA: compiler'ın doğrulama aşaması — desteklenmeyen doküman kuyruğa girmez.
        try
        {
            var doc = project.Timeline.RootElement.Deserialize<TimelineDoc>(TimelineJson.Options)
                ?? throw new InvalidTimelineException("timeline document is empty.");
            ExportCompiler.Validate(doc, overlayMeasurer);

            // FONT ÖN KONTROLÜ (M4 dalga-2 denetimi, bulgu #1d): manifestte olmayan bir
            // fontId, raster aşamasında 'font-missing' ile düşer — ama o noktaya gelmek
            // dakikalar sürer. Kuyruğa hiç girmesin. Manifest okunamıyorsa kontrol ATLANIR
            // (yanlış 422 vermektense worker'ın deterministik hatasına bırakılır).
            if (fonts.Manifest is { } manifest
                && FontCatalogue.UnknownFontIds(doc, manifest) is { Count: > 0 } unknown)
            {
                return Results.Problem(
                    statusCode: StatusCodes.Status422UnprocessableEntity,
                    title: "Timeline uses a font the server does not have.",
                    detail: $"Bilinmeyen fontId: {string.Join(", ", unknown.Select(f => $"'{f}'"))}. "
                            + $"Kullanılabilir: {string.Join(", ", manifest.Fonts.Keys.Order(StringComparer.Ordinal))} "
                            + "(GET /api/fonts).",
                    extensions: new Dictionary<string, object?>
                    {
                        ["feature"] = "font-missing",
                        ["unknownFontIds"] = unknown,
                    });
            }
        }
        catch (UnsupportedFeatureException ex)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status422UnprocessableEntity,
                title: "Timeline uses a feature the exporter does not support yet.",
                detail: ex.Message,
                extensions: new Dictionary<string, object?> { ["feature"] = ex.Feature });
        }
        catch (InvalidTimelineException ex)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status422UnprocessableEntity,
                title: "Timeline violates the export contract.",
                detail: ex.Message);
        }
        catch (JsonException ex)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status422UnprocessableEntity,
                title: "Timeline document could not be parsed.",
                detail: ex.Message);
        }

        // Snapshot GÖMÜLÜR (referans değil): kullanıcı export sürerken editlemeye devam eder,
        // job o anki versiyonu render eder (tasarım 04 §4.1, tuzak #14).
        var now = clock.GetUtcNow();
        var job = Job.Create(
            JobType.Export, userId, now,
            projectId: project.Id,
            timelineSnapshot: JsonDocument.Parse(project.Timeline.RootElement.GetRawText()),
            exportProfile: ExportProfiles.Name(profile));
        db.Jobs.Add(job);
        await db.SaveChangesAsync(ct);

        // Enqueue DB kaydından SONRA: Hangfire işi Job satırını okuyarak koşar.
        job.HangfireJobId = jobs.Enqueue<IExportJob>(j => j.Run(job.Id, CancellationToken.None));
        await db.SaveChangesAsync(ct);

        return Results.Accepted($"/api/jobs/{job.Id}", new ExportJobCreatedResponse(job.Id));
    }

    internal static async Task<IResult> GetJob(
        Guid id, ClaimsPrincipal principal, AppDbContext db, IStorageService storage,
        CancellationToken ct)
    {
        var userId = principal.GetUserId();
        var job = await db.Jobs.AsNoTracking()
            .SingleOrDefaultAsync(j => j.Id == id && j.RequestedBy == userId, ct);
        return job is null ? Results.NotFound() : Results.Ok(ToDto(job, storage));
    }

    internal static async Task<IResult> CancelJob(
        Guid id, ClaimsPrincipal principal, AppDbContext db, IBackgroundJobClient jobs,
        TimeProvider clock, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        var job = await db.Jobs.AsNoTracking()
            .SingleOrDefaultAsync(j => j.Id == id && j.RequestedBy == userId, ct);
        if (job is null)
        {
            return Results.NotFound();
        }

        if (job.Type != JobType.Export)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "Only export jobs can be canceled.");
        }

        // Durum-korumalı atomik iptal: yalnız Queued/Running satır Canceled'a çekilir —
        // yarışan tamamlanma/ikinci cancel üzerine yazmaz.
        var now = clock.GetUtcNow();
        var claimed = await db.Jobs
            .Where(j => j.Id == id
                        && (j.Status == JobStatus.Queued || j.Status == JobStatus.Running))
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Status, JobStatus.Canceled)
                .SetProperty(j => j.ProgressStage, "canceled")
                .SetProperty(j => j.CompletedAt, now), ct);

        if (claimed == 0)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: $"Job is already terminal ({StatusString(job.Status)}) and cannot be canceled.");
        }

        // Hangfire tarafı: kuyruktaysa hiç koşmaz; koşuyorsa delete işin cancellation
        // token'ını tetikler, worker ayrıca DB bayrağını yoklar → ffmpeg öldürülür.
        if (!string.IsNullOrEmpty(job.HangfireJobId))
        {
            jobs.ChangeState(job.HangfireJobId, new Hangfire.States.DeletedState(), null);
        }

        return Results.Ok(new ExportCancelResponse("canceled"));
    }

    internal static async Task<IResult> ListForProject(
        Guid projectId, ClaimsPrincipal principal, AppDbContext db, IStorageService storage,
        CancellationToken ct, int page = 1, int pageSize = 20)
    {
        var userId = principal.GetUserId();
        var ownsProject = await db.Projects.AsNoTracking()
            .AnyAsync(p => p.Id == projectId && p.OwnerId == userId && p.DeletedAt == null, ct);
        if (!ownsProject)
        {
            return Results.NotFound();
        }

        int skip;
        (page, pageSize, skip) = TimelineRequestValidation.NormalizePaging(page, pageSize);

        var query = db.Jobs.AsNoTracking()
            .Where(j => j.ProjectId == projectId && j.Type == JobType.Export && j.RequestedBy == userId);
        var total = await query.CountAsync(ct);
        var items = await query
            // Id UUIDv7'dir (zaman-sıralı) → "en yeni önce"; DateTimeOffset sıralaması ayrıca
            // Sqlite test provider'ında çevrilemez — Id tek başına iki işi de görür.
            .OrderByDescending(j => j.Id)
            .Skip(skip)
            .Take(pageSize)
            .ToListAsync(ct);

        return Results.Ok(new PagedResult<ExportJobDto>(
            items.Select(j => ToDto(j, storage)).ToList(), page, pageSize, total));
    }

    // ---------- Helpers ----------

    private static ExportJobDto ToDto(Job job, IStorageService storage)
    {
        // downloadUrl yalnız başarılı export'ta üretilir; presign yerel imzalamadır (ucuz).
        var downloadUrl = job is { Type: JobType.Export, Status: JobStatus.Succeeded, OutputKey: not null }
            ? storage.PresignExportGet(job.OutputKey)
            : null;

        return new ExportJobDto(
            job.Id,
            job.ProjectId,
            StatusString(job.Status),
            job.ExportProfile,
            job.ProgressPercent,
            job.ProgressStage,
            job.ErrorMessage,
            downloadUrl,
            job.CreatedAt,
            job.StartedAt,
            job.CompletedAt);
    }

    private static string StatusString(JobStatus status) => status switch
    {
        JobStatus.Queued => "queued",
        JobStatus.Running => "running",
        JobStatus.Succeeded => "succeeded",
        JobStatus.Failed => "failed",
        JobStatus.Canceled => "canceled",
        _ => "unknown",
    };
}
