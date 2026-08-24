using System.Security.Claims;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using VideoEdit.Api.Auth;
using VideoEdit.Contracts;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Domain.Services;
using VideoEdit.Infrastructure;

namespace VideoEdit.Api.Endpoints;

public static class ProjectEndpoints
{
    public static IEndpointRouteBuilder MapProjectEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/projects").WithTags("Projects").RequireAuthorization();

        group.MapGet("/", List);
        group.MapPost("/", Create);
        group.MapGet("/{id:guid}", GetById);
        group.MapPatch("/{id:guid}", Rename);
        group.MapDelete("/{id:guid}", SoftDelete);

        group.MapPut("/{id:guid}/timeline", SaveTimeline)
            .WithMetadata(new MaxRequestBodySizeMetadata(TimelineRequestValidation.MaxTimelineBodyBytes));

        group.MapGet("/{id:guid}/revisions", ListRevisions);
        group.MapGet("/{id:guid}/revisions/{rev:long}", GetRevision);
        group.MapPost("/{id:guid}/revisions", CreateCheckpoint);
        group.MapPost("/{id:guid}/restore", Restore);

        return app;
    }

    // ---------- CRUD ----------

    // Not: handler'lar internal — birim testleri (Sqlite in-memory, AssetEndpoints deseni)
    // ve CrossUserAccessTests'in IDOR regresyon paketi doğrudan çağırır.
    internal static async Task<IResult> List(
        ClaimsPrincipal principal, AppDbContext db, CancellationToken ct,
        int page = 1, int pageSize = 20)
    {
        var userId = principal.GetUserId();
        int skip;
        (page, pageSize, skip) = TimelineRequestValidation.NormalizePaging(page, pageSize);

        var query = db.Projects.AsNoTracking()
            .Where(p => p.OwnerId == userId && p.DeletedAt == null);

        var total = await query.CountAsync(ct);
        var items = await query
            .OrderByDescending(p => p.UpdatedAt)
            .Skip(skip)
            .Take(pageSize)
            .Select(p => new ProjectSummaryDto(
                p.Id, p.Name, p.RevisionNumber,
                p.FrameRateNum, p.FrameRateDen, p.Width, p.Height, p.AudioSampleRate,
                p.CreatedAt, p.UpdatedAt))
            .ToListAsync(ct);

        return Results.Ok(new PagedResult<ProjectSummaryDto>(items, page, pageSize, total));
    }

    private static async Task<IResult> Create(
        CreateProjectRequest request, ClaimsPrincipal principal, AppDbContext db,
        TimeProvider clock, CancellationToken ct)
    {
        var name = request.Name?.Trim() ?? "";
        var fpsNum = request.FpsNum ?? 30;
        var fpsDen = request.FpsDen ?? 1;
        var width = request.Width ?? 1920;
        var height = request.Height ?? 1080;
        var audioSampleRate = request.AudioSampleRate ?? 48000;

        var errors = new Dictionary<string, string[]>();
        if (name.Length is 0 or > 200)
        {
            errors["name"] = ["Name is required (max 200 characters)."];
        }

        if (fpsNum <= 0 || fpsDen <= 0)
        {
            errors["fps"] = ["fpsNum and fpsDen must be positive."];
        }

        if (width is < 16 or > 8192 || height is < 16 or > 8192)
        {
            errors["resolution"] = ["width and height must be between 16 and 8192."];
        }

        if (!TimelineRequestValidation.IsAllowedAudioSampleRate(audioSampleRate))
        {
            errors["audioSampleRate"] = ["audioSampleRate must be 44100 or 48000."];
        }

        if (errors.Count > 0)
        {
            return Results.ValidationProblem(errors);
        }

        var now = clock.GetUtcNow();
        var projectId = Guid.CreateVersion7();

        // Boş timeline dokümanı — tek kaynak: EmptyTimeline builder'ı (şema-geçerli;
        // empty-doc.fixture.json ile alan-alan eşleşir).
        var timeline = EmptyTimeline.Create(projectId, width, height, fpsNum, fpsDen, audioSampleRate);

        var project = new Project
        {
            Id = projectId,
            OwnerId = principal.GetUserId(),
            Name = name,
            Timeline = timeline,
            RevisionNumber = 0,
            FrameRateNum = fpsNum,
            FrameRateDen = fpsDen,
            Width = width,
            Height = height,
            AudioSampleRate = audioSampleRate,
            CreatedAt = now,
            UpdatedAt = now,
        };

        db.Projects.Add(project);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/api/projects/{project.Id}", ToDetailDto(project));
    }

    internal static async Task<IResult> GetById(
        Guid id, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct)
    {
        var project = await FindOwnedAsync(db, id, principal.GetUserId(), track: false, ct);
        return project is null ? Results.NotFound() : Results.Ok(ToDetailDto(project));
    }

    internal static async Task<IResult> Rename(
        Guid id, UpdateProjectRequest request, ClaimsPrincipal principal, AppDbContext db,
        TimeProvider clock, CancellationToken ct)
    {
        var name = request.Name?.Trim() ?? "";
        if (name.Length is 0 or > 200)
        {
            return Results.ValidationProblem(new Dictionary<string, string[]>
            {
                ["name"] = ["Name is required (max 200 characters)."],
            });
        }

        var userId = principal.GetUserId();
        var now = clock.GetUtcNow();

        // ExecuteUpdate: RevisionNumber concurrency token'ına takılmaz — eşzamanlı autosave
        // ile yarışta 500 (DbUpdateConcurrencyException) yerine tek atomik UPDATE.
        var affected = await db.Projects
            .Where(p => p.Id == id && p.OwnerId == userId && p.DeletedAt == null)
            .ExecuteUpdateAsync(s => s
                .SetProperty(p => p.Name, name)
                .SetProperty(p => p.UpdatedAt, now), ct);

        if (affected == 0)
        {
            return Results.NotFound();
        }

        var project = await db.Projects.AsNoTracking().SingleAsync(p => p.Id == id, ct);
        return Results.Ok(new ProjectSummaryDto(
            project.Id, project.Name, project.RevisionNumber,
            project.FrameRateNum, project.FrameRateDen, project.Width, project.Height,
            project.AudioSampleRate, project.CreatedAt, project.UpdatedAt));
    }

    internal static async Task<IResult> SoftDelete(
        Guid id, ClaimsPrincipal principal, AppDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        var now = clock.GetUtcNow();

        // ExecuteUpdate: concurrency token'dan bağımsız atomik soft-delete (autosave yarışına dayanıklı).
        var affected = await db.Projects
            .Where(p => p.Id == id && p.OwnerId == userId && p.DeletedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(p => p.DeletedAt, now), ct);

        return affected == 0 ? Results.NotFound() : Results.NoContent();
    }

    // ---------- Autosave ----------

    internal static async Task<IResult> SaveTimeline(
        Guid id, SaveTimelineRequest request, ClaimsPrincipal principal, AppDbContext db,
        ISnapshotPolicy snapshotPolicy, TimeProvider clock, CancellationToken ct)
    {
        var userId = principal.GetUserId();

        if (request.BaseRevision < 0 || request.Timeline.ValueKind != JsonValueKind.Object)
        {
            return Results.ValidationProblem(new Dictionary<string, string[]>
            {
                ["timeline"] = ["Body must be { baseRevision >= 0, timeline: <object> }."],
            });
        }

        // Yüzeysel doğrulama: schemaVersion/projectId/tracks + boyut sınırları (tam şema client'ta).
        var validationErrors = TimelineRequestValidation.ValidateTimelinePayload(request.Timeline, id);
        if (validationErrors.Count > 0)
        {
            return Results.ValidationProblem(validationErrors);
        }

        var now = clock.GetUtcNow();
        var newRevision = request.BaseRevision + 1;
        var timeline = JsonDocument.Parse(request.Timeline.GetRawText());

        // Tek UPDATE ... WHERE revision_number = @base — optimistic concurrency.
        var affected = await db.Projects
            .Where(p => p.Id == id
                        && p.OwnerId == userId
                        && p.DeletedAt == null
                        && p.RevisionNumber == request.BaseRevision)
            .ExecuteUpdateAsync(s => s
                .SetProperty(p => p.Timeline, timeline)
                .SetProperty(p => p.RevisionNumber, newRevision)
                .SetProperty(p => p.UpdatedAt, now), ct);

        if (affected == 0)
        {
            // Proje yok/başkasının → 404; revision uyuşmadı → 409 + güncel doküman.
            var current = await db.Projects.AsNoTracking()
                .Where(p => p.Id == id && p.OwnerId == userId && p.DeletedAt == null)
                .Select(p => new { p.RevisionNumber, p.Timeline })
                .SingleOrDefaultAsync(ct);

            return current is null
                ? Results.NotFound()
                : Results.Conflict(new TimelineConflictResponse(
                    current.RevisionNumber, current.Timeline.RootElement.Clone()));
        }

        // Snapshot kuralı — SADECE sunucuda (ISnapshotPolicy).
        var lastSnapshot = await db.ProjectRevisions.AsNoTracking()
            .Where(r => r.ProjectId == id)
            .OrderByDescending(r => r.RevisionNumber)
            .Select(r => new { r.RevisionNumber, r.CreatedAt })
            .FirstOrDefaultAsync(ct);

        var shouldSnapshot = snapshotPolicy.ShouldSnapshot(new SnapshotDecisionContext(
            RevisionKind.Auto,
            newRevision,
            lastSnapshot?.RevisionNumber,
            lastSnapshot?.CreatedAt,
            now));

        if (shouldSnapshot)
        {
            db.ProjectRevisions.Add(ProjectRevision.Create(
                id, newRevision, JsonDocument.Parse(request.Timeline.GetRawText()),
                RevisionKind.Auto, userId, now));
            await db.SaveChangesAsync(ct);
        }

        return Results.Ok(new SaveTimelineResponse(newRevision));
    }

    // ---------- Revisions ----------

    internal static async Task<IResult> ListRevisions(
        Guid id, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct,
        int page = 1, int pageSize = 50)
    {
        var userId = principal.GetUserId();
        if (!await OwnsProjectAsync(db, id, userId, ct))
        {
            return Results.NotFound();
        }

        int skip;
        (page, pageSize, skip) = TimelineRequestValidation.NormalizePaging(page, pageSize);

        var query = db.ProjectRevisions.AsNoTracking().Where(r => r.ProjectId == id);
        var total = await query.CountAsync(ct);
        var items = await query
            .OrderByDescending(r => r.RevisionNumber)
            .Skip(skip)
            .Take(pageSize)
            .Select(r => new RevisionMetaDto(
                r.Id, r.RevisionNumber, r.Kind.ToString(), r.Label, r.CreatedBy, r.CreatedAt))
            .ToListAsync(ct);

        return Results.Ok(new PagedResult<RevisionMetaDto>(items, page, pageSize, total));
    }

    internal static async Task<IResult> GetRevision(
        Guid id, long rev, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        if (!await OwnsProjectAsync(db, id, userId, ct))
        {
            return Results.NotFound();
        }

        var revision = await db.ProjectRevisions.AsNoTracking()
            .SingleOrDefaultAsync(r => r.ProjectId == id && r.RevisionNumber == rev, ct);

        return revision is null
            ? Results.NotFound()
            : Results.Ok(new RevisionDetailDto(
                revision.Id, revision.RevisionNumber, revision.Kind.ToString(), revision.Label,
                revision.CreatedBy, revision.CreatedAt, revision.Timeline.RootElement.Clone()));
    }

    internal static async Task<IResult> CreateCheckpoint(
        Guid id, CreateCheckpointRequest request, ClaimsPrincipal principal, AppDbContext db,
        TimeProvider clock, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        var project = await FindOwnedAsync(db, id, userId, track: false, ct);
        if (project is null)
        {
            return Results.NotFound();
        }

        var label = request.Label?.Trim();
        if (label is { Length: > 200 })
        {
            return Results.ValidationProblem(new Dictionary<string, string[]>
            {
                ["label"] = ["Label must be at most 200 characters."],
            });
        }

        var now = clock.GetUtcNow();

        // Aynı revision'da zaten snapshot varsa Checkpoint'e terfi ettirilir (unique index koruması).
        var existing = await db.ProjectRevisions
            .SingleOrDefaultAsync(r => r.ProjectId == id && r.RevisionNumber == project.RevisionNumber, ct);
        if (existing is not null)
        {
            existing.Kind = RevisionKind.Checkpoint;
            existing.Label = label ?? existing.Label;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new RevisionMetaDto(
                existing.Id, existing.RevisionNumber, existing.Kind.ToString(),
                existing.Label, existing.CreatedBy, existing.CreatedAt));
        }

        var revision = ProjectRevision.Create(
            id, project.RevisionNumber, JsonDocument.Parse(project.Timeline.RootElement.GetRawText()),
            RevisionKind.Checkpoint, userId, now, label);
        db.ProjectRevisions.Add(revision);
        await db.SaveChangesAsync(ct);

        return Results.Created(
            $"/api/projects/{id}/revisions/{revision.RevisionNumber}",
            new RevisionMetaDto(
                revision.Id, revision.RevisionNumber, revision.Kind.ToString(),
                revision.Label, revision.CreatedBy, revision.CreatedAt));
    }

    internal static async Task<IResult> Restore(
        Guid id, RestoreRequest request, ClaimsPrincipal principal, AppDbContext db,
        TimeProvider clock, CancellationToken ct)
    {
        var userId = principal.GetUserId();
        var project = await FindOwnedAsync(db, id, userId, track: true, ct);
        if (project is null)
        {
            return Results.NotFound();
        }

        var target = await db.ProjectRevisions.AsNoTracking()
            .SingleOrDefaultAsync(r => r.ProjectId == id && r.RevisionNumber == request.RevisionNumber, ct);
        if (target is null)
        {
            return Results.NotFound();
        }

        var now = clock.GetUtcNow();

        // 1) Önce mevcut durumun PreRestore snapshot'ı (aynı revision'da snapshot yoksa).
        var existsAtCurrent = await db.ProjectRevisions
            .AnyAsync(r => r.ProjectId == id && r.RevisionNumber == project.RevisionNumber, ct);
        if (!existsAtCurrent)
        {
            db.ProjectRevisions.Add(ProjectRevision.Create(
                id, project.RevisionNumber, JsonDocument.Parse(project.Timeline.RootElement.GetRawText()),
                RevisionKind.PreRestore, userId, now));
        }

        // 2) Current'ı değiştir, RevisionNumber++ (EF concurrency token yarışları yakalar).
        project.Timeline = JsonDocument.Parse(target.Timeline.RootElement.GetRawText());
        project.RevisionNumber += 1;
        project.UpdatedAt = now;

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "Project was modified concurrently; reload and retry.");
        }

        // Yanıt yeni durum — client dokümanı yeniden yükler ve undo history'yi temizler.
        return Results.Ok(new RestoreResponse(project.RevisionNumber, project.Timeline.RootElement.Clone()));
    }

    // ---------- Helpers ----------

    private static async Task<Project?> FindOwnedAsync(
        AppDbContext db, Guid id, Guid userId, bool track, CancellationToken ct)
    {
        var query = track ? db.Projects.AsQueryable() : db.Projects.AsNoTracking();
        return await query.SingleOrDefaultAsync(
            p => p.Id == id && p.OwnerId == userId && p.DeletedAt == null, ct);
    }

    private static Task<bool> OwnsProjectAsync(AppDbContext db, Guid id, Guid userId, CancellationToken ct) =>
        db.Projects.AsNoTracking()
            .AnyAsync(p => p.Id == id && p.OwnerId == userId && p.DeletedAt == null, ct);

    private static ProjectDetailDto ToDetailDto(Project project) => new(
        project.Id, project.Name, project.RevisionNumber,
        project.FrameRateNum, project.FrameRateDen, project.Width, project.Height,
        project.AudioSampleRate, project.Timeline.RootElement.Clone(),
        project.CreatedAt, project.UpdatedAt);
}
